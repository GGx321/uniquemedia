import {
  errorResponseFor,
  EventLog,
  parseEngineCommand,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type EngineCommandMessage,
  type EngineError,
  type EventMessage,
  type MoneyStatus,
  type ReconcileReason,
  type ResponseMessage,
  type Settings,
  type Snapshot,
  type UnsequencedEvent,
} from "../shared/engine";
import { EngineReply, HostCall, HostControl, isControlMessage, type EngineInit, type EngineSettings } from "./control";
import { LibraryError, openLibrary, type Library } from "./library";
import { STUDIO_E2E } from "./buildFlags";
import { Budget } from "./money/budget";
import { MoneyError } from "./money/errors";
import { Ledger } from "./money/ledger";
import { OPENROUTER_API_BASE } from "./money/prices";

/** Events kept for `engine.events` catch-up; an older `afterSeq` gets `gap` and refetches the snapshot. */
export const EVENT_LOG_CAPACITY = 1000;

/** `detail` travels as T0 `SafeText`, which allows at most 500 chars. */
const MAX_DETAIL = 500;

export interface EngineDeps {
  /** A fresh random id per engine start; events and snapshots carry it. */
  bootId: string;
  /** Wall clock, epoch ms. */
  clock: () => number;
  /** Monotonic ms, for the Budget's reconcile wait. */
  monotonic: () => number;
  newId: () => string;
  /** Every response, every sequenced event and every reply to main leaves through here (the MessagePort). */
  post: (message: ResponseMessage | EventMessage | EngineReply) => void;
}

function detailOf(message: string): string {
  return message.length <= MAX_DETAIL ? message : `${message.slice(0, MAX_DETAIL - 1)}…`;
}

/**
 * The OpenRouter API base the client (T3) must use: the real one, unless this
 * is an E2E build and main asked for a mock (invariant 13). `e2e` is the
 * build flag; it is a parameter so both branches can be tested.
 */
export function resolveOpenRouterBaseUrl(requested: string | undefined, e2e: boolean): string {
  return e2e && requested !== undefined ? requested : OPENROUTER_API_BASE;
}

/** Carries a ready-made EngineError out of a handler, so `handle` answers with it unchanged. */
class EngineFailure extends Error {
  readonly error: EngineError;

  constructor(error: EngineError) {
    super(error.detail ?? error.code);
    this.error = error;
  }
}

/** Maps a thrown error to the T0 error set; money codes keep their own code. */
export function engineErrorFrom(error: unknown): EngineError {
  if (error instanceof EngineFailure) return error.error;
  if (error instanceof MoneyError) {
    const detail = detailOf(error.message);
    switch (error.code) {
      case "LEDGER_CORRUPT":
      case "LEDGER_WRITE_FAILED":
      case "SETTLE_ABOVE_WORST":
      case "PRICE_UNAVAILABLE":
        return { code: error.code, detail };
      case "LEDGER_TORN":
        return { code: "RECONCILE_REQUIRED", detail };
      default:
        return { code: "INTERNAL", detail };
    }
  }
  return { code: "INTERNAL", detail: detailOf(error instanceof Error ? error.message : "unexpected engine error") };
}

type OpenMoney = { ok: true; ledger: Ledger; budget: Budget };
type Money = OpenMoney | { ok: false; error: EngineError };

/**
 * The engine's state and command dispatcher. Every message from main is
 * parsed here: control messages (the API key) against `HostControl`,
 * everything else with T0 `parseEngineCommand`, so a main-only key command
 * can never be executed by the engine. Commands without a handler yet answer
 * INTERNAL with a "not implemented" detail.
 */
export class Engine {
  readonly #deps: EngineDeps;
  readonly #events: EventLog;
  readonly #encryptionAvailable: boolean;
  readonly #openRouterBaseUrl: string;
  #settings: EngineSettings;
  #money: Money;
  /** A monthly budget that waits for the requests in flight to end. */
  #pendingBudgetMicros: number | null = null;
  #apiKey: string | null = null;
  /** The library the user picked last (T6a also opens the one from settings at start). */
  #library: Library | null = null;
  /** Set by a 401 with the current key; a new key clears it. */
  #keyRejected = false;

  private constructor(init: EngineInit, money: Money, deps: EngineDeps) {
    this.#deps = deps;
    this.#events = new EventLog(EVENT_LOG_CAPACITY, deps.bootId);
    this.#settings = init.settings;
    this.#encryptionAvailable = init.encryptionAvailable;
    this.#openRouterBaseUrl = resolveOpenRouterBaseUrl(init.openRouterBaseUrl, STUDIO_E2E);
    this.#money = money;
  }

  static #newBudget(ledger: Ledger, monthlyBudgetMicros: number, deps: EngineDeps): Budget {
    return new Budget(ledger, {
      // No paid job exists yet (T6a/T6 register each job's cap); a scope
      // without a cap can reserve nothing.
      runCapMicros: 0,
      monthlyBudgetMicros,
      clock: deps.clock,
      monotonic: deps.monotonic,
    });
  }

  /**
   * Opens the ledger (`userData/ledger.jsonl`, passed in by main) under a
   * Budget. A ledger that cannot be read does not stop the engine: money
   * commands answer with the ledger's error, and an `engine.error` is emitted.
   */
  static async start(init: EngineInit, deps: EngineDeps): Promise<Engine> {
    let money: Money;
    try {
      const ledger = await Ledger.open(init.ledgerPath);
      money = { ok: true, ledger, budget: Engine.#newBudget(ledger, init.settings.monthlyBudgetMicros, deps) };
    } catch (error) {
      money = { ok: false, error: engineErrorFrom(error) };
    }
    const engine = new Engine(init, money, deps);
    if (!money.ok) engine.#emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "engine.error", payload: { error: money.error } });
    return engine;
  }

  /**
   * For the OpenRouter client and the jobs (T3/T6a) on a 401: the key is
   * marked rejected in settings and the snapshot, and `engine.error
   * AUTH_INVALID` is emitted once; a new key clears it. The caller stops the
   * run and never retries. (A dedicated key-status event is a T0 addition
   * left to T6a.)
   */
  markKeyRejected(): void {
    if (this.#apiKey === null || this.#keyRejected) return;
    this.#keyRejected = true;
    this.#emit({
      v: PROTOCOL_VERSION,
      id: this.#deps.newId(),
      kind: "event",
      type: "engine.error",
      payload: { error: { code: "AUTH_INVALID", detail: "OpenRouter rejected the API key (401); store a new key to continue" } },
    });
  }

  /** The OpenRouter API base for the client: always the real one outside an E2E build. */
  get openRouterBaseUrl(): string {
    return this.#openRouterBaseUrl;
  }

  get bootId(): string {
    return this.#events.bootId;
  }

  /** The key OpenRouter calls will use (T3/T6a); never sent anywhere but OpenRouter. */
  get apiKey(): string | null {
    return this.#apiKey;
  }

  /** The open library, if any. */
  get library(): Library | null {
    return this.#library;
  }

  /** Handles one message from main: a control message is applied, a call or a command is answered through `post`. */
  async receive(message: unknown): Promise<void> {
    if (isControlMessage(message)) {
      const call = HostCall.safeParse(message);
      if (call.success) this.#deps.post(await this.#answer(call.data));
      else this.applyControl(message);
      return;
    }
    this.#deps.post(await this.handle(message));
  }

  async #answer(call: HostCall): Promise<EngineReply> {
    switch (call.type) {
      case "library.open":
        try {
          const { library } = await openLibrary(call.path);
          this.#library = library;
          return { kind: "control", type: "reply", callId: call.callId };
        } catch (error) {
          const detail = detailOf(error instanceof Error ? error.message : "the library could not be opened");
          const code = error instanceof LibraryError ? "VALIDATION" : "INTERNAL";
          return { kind: "control", type: "reply", callId: call.callId, error: { code, detail } };
        }
    }
  }

  /** Applies a key change from main. Invalid control messages are dropped without echoing their content. */
  applyControl(message: unknown): void {
    const parsed = HostControl.safeParse(message);
    if (!parsed.success) {
      console.error("studio engine: ignored an invalid control message");
      return;
    }
    const control = parsed.data;
    switch (control.type) {
      case "apiKey.set":
        this.#apiKey = control.key;
        this.#keyRejected = false;
        return;
      case "apiKey.clear":
        this.#apiKey = null;
        this.#keyRejected = false;
        return;
      case "settings.update":
        this.#applySettings(control.settings);
        return;
      case "notice":
        this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "engine.error", payload: { error: control.error } });
        return;
    }
  }

  /** Parses and answers one command. Never throws. */
  async handle(raw: unknown): Promise<ResponseMessage> {
    const parsed = parseEngineCommand(raw);
    if (!parsed.ok) return errorResponseFor(raw, { code: "VALIDATION", detail: parsed.reason });
    try {
      return this.#dispatch(parsed.command);
    } catch (error) {
      return errorResponseFor(parsed.command, engineErrorFrom(error));
    }
  }

  #dispatch(command: EngineCommandMessage): ResponseMessage {
    const v = PROTOCOL_VERSION;
    switch (command.type) {
      case "engine.snapshot":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#snapshot() };
      case "engine.events": {
        const result = this.#events.since(command.payload.afterSeq, command.payload.bootId);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "settings.get":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#currentSettings() };
      case "money.status":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#moneyStatus() };
      default:
        return errorResponseFor(command, { code: "INTERNAL", detail: `${command.type} is not implemented yet` });
    }
  }

  #snapshot(): Snapshot {
    return {
      bootId: this.#events.bootId,
      lastSeq: this.#events.lastSeq,
      settings: this.#currentSettings(),
      money: this.#moneyStatus(),
      // Filled by the avatar and run tasks (T6a, T6); the library is not opened yet.
      avatars: [],
      drafts: [],
      jobs: [],
    };
  }

  #apiKeyStatus(): ApiKeyStatus {
    const key = this.#apiKey;
    return {
      stored: key !== null,
      last4: key === null ? null : key.slice(-4),
      encryptionAvailable: this.#encryptionAvailable,
      rejected: key !== null && this.#keyRejected,
    };
  }

  /** Main persisted new settings; a new monthly budget goes to the Budget as soon as it can. */
  #applySettings(next: EngineSettings): void {
    if (next.monthlyBudgetMicros !== this.#settings.monthlyBudgetMicros) this.#pendingBudgetMicros = next.monthlyBudgetMicros;
    this.#settings = next;
  }

  /**
   * The Budget, rebuilt over the same ledger when a new monthly budget is
   * waiting and no paid request is in flight (the Budget tracks those itself,
   * so it cannot be swapped under them). Every Budget use goes through here.
   */
  #currentBudget(money: OpenMoney): Budget {
    if (this.#pendingBudgetMicros === null || money.budget.inFlightCount() > 0) return money.budget;
    const budget = Engine.#newBudget(money.ledger, this.#pendingBudgetMicros, this.#deps);
    this.#money = { ...money, budget };
    this.#pendingBudgetMicros = null;
    return budget;
  }

  #currentSettings(): Settings {
    return { apiKey: this.#apiKeyStatus(), ...this.#settings };
  }

  /** Throws the ledger's error when it could not be opened. */
  #moneyStatus(): MoneyStatus {
    const money = this.#money;
    if (!money.ok) throw new EngineFailure(money.error);
    const budget = this.#currentBudget(money);
    const status = budget.status();
    const reasons: ReconcileReason[] = [];
    // Open reserves other than this process's in-flight ones were left by a
    // crash, an abort or a timeout: they wait for a user reconcile.
    if (status.openAttempts - budget.inFlightCount() > 0) reasons.push("open-reserves");
    if (status.torn) reasons.push("torn-ledger-line");
    return {
      month: new Date(this.#deps.clock()).toISOString().slice(0, 7),
      spentMicros: status.spentThisMonthMicros,
      monthlyBudgetMicros: status.monthlyBudgetMicros,
      unsettledMicros: status.openReserveMicros,
      unsettledCount: status.openAttempts,
      reconcileNeeded: reasons.length > 0,
      reconcileReasons: reasons,
    };
  }

  /** Stamps an event with the next seq and this engine's bootId and sends it to main. */
  #emit(event: UnsequencedEvent): void {
    const seq = this.#events.append(event);
    const stamped = this.#events.since(seq - 1, this.#events.bootId);
    if (!stamped.gap) for (const e of stamped.events) this.#deps.post(e);
  }
}

