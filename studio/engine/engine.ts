import {
  errorResponseFor,
  EventLog,
  parseEngineCommand,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type EngineCommandMessage,
  type EngineError,
  type EngineNotice,
  type EventMessage,
  type LedgerUnavailable,
  type MoneyHalt,
  type MoneyStatus,
  type ReconcileReason,
  type ReconcileResult,
  type ReconcileWarning,
  type ResponseMessage,
  type Settings,
  type Snapshot,
  type UnsequencedEvent,
} from "../shared/engine";
import { libraryView, type LibraryView } from "./avatars/records";
import { folderIdentity, NODE_FOLDER_FS, type FolderFs } from "./folderIdentity";
import { EngineReply, HostCall, HostControl, isControlMessage, type EngineInit, type EngineSettings } from "./control";
import { LibraryError, openLibrary, type Library } from "./library";
import { STUDIO_E2E } from "./buildFlags";
import { Budget, type BudgetStatus } from "./money/budget";
import { MoneyError } from "./money/errors";
import { Ledger } from "./money/ledger";
import { OPENROUTER_API_BASE } from "./money/prices";
import type { ReconcileResult as LedgerReconcileResult, ReconcileWarning as LedgerReconcileWarning } from "./money/reconcile";
import { createOpenRouterClient, fromOpenRouterError, OpenRouterError, type OpenRouterClient, type OpenRouterFetch } from "./openrouter";

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
  /** The fetch every OpenRouter request goes through: the runtime's own in the utilityProcess, a fake in tests. */
  fetch: OpenRouterFetch;
  /** Where library folders' identities are read; the real filesystem unless a test plays another volume. */
  folderFs?: FolderFs;
}

function detailOf(message: string): string {
  return message.length <= MAX_DETAIL ? message : `${message.slice(0, MAX_DETAIL - 1)}…`;
}

function messageOf(error: unknown, fallback: string): string {
  return detailOf(error instanceof Error ? error.message : fallback);
}

/**
 * The OpenRouter API base the client (T3) must use: the real one, unless this
 * is an E2E build and main asked for a mock (invariant 13). `e2e` is the
 * build flag; it is a parameter so both branches can be tested.
 */
export function resolveOpenRouterBaseUrl(requested: string | undefined, e2e: boolean): string {
  return e2e && requested !== undefined ? requested : OPENROUTER_API_BASE;
}

/**
 * Hands one message from main to the engine once it has started. A message
 * the engine fails on is logged by the error's kind only (its text may carry
 * a key or a path) and never left as an unhandled rejection. A message for an
 * engine that did not start is dropped: `exitIfStartFails` reports that once
 * and ends the process. Never rejects.
 */
export function deliver(ready: Promise<Pick<Engine, "receive">>, message: unknown, log: (line: string) => void = console.error): Promise<void> {
  return ready.then(
    (engine) =>
      engine.receive(message).catch((error: unknown) => {
        log(`studio engine: a message from main could not be handled (${errorKind(error)})`);
      }),
    () => undefined,
  );
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * For the utilityProcess entry: an engine that failed to start logs the
 * error's kind only (its text may carry a key or a path) and ends the process
 * with 1, so main restarts it and tells the windows, instead of leaving a
 * process that never answers.
 */
export function exitIfStartFails(ready: Promise<unknown>, exit: (code: number) => void, log: (line: string) => void = console.error): void {
  ready.catch((error: unknown) => {
    log(`studio engine: the engine could not start (${errorKind(error)})`);
    exit(1);
  });
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
  return { code: "INTERNAL", detail: messageOf(error, "unexpected engine error") };
}

/** Why the ledger could not be opened: broken content, or a file that could not be read. */
function ledgerUnavailable(error: unknown): LedgerUnavailable {
  if (error instanceof MoneyError && error.code === "LEDGER_CORRUPT") return { cause: "LEDGER_CORRUPT", detail: detailOf(error.message) };
  return { cause: "LEDGER_UNREADABLE", detail: messageOf(error, "the ledger could not be read") };
}

/** T2's reconcile vocabulary in the contract's; `satisfies` makes a new T2 value without a mapping a compile error. */
const WARNING_OF = { CLOCK_SKEW: "clock-skew" } as const satisfies Record<LedgerReconcileWarning, ReconcileWarning>;
const DELTA_UNAVAILABLE_OF = { NO_BASELINE: "no-baseline", NEGATIVE_DELTA: "negative-delta" } as const satisfies Record<
  NonNullable<Extract<LedgerReconcileResult, { ok: true }>["deltaUnavailable"]>,
  NonNullable<Extract<ReconcileResult, { status: "done" }>["deltaUnavailable"]>
>;

/** T2's answer in the contract's shape: `done`, or `too-early` with the wait. */
function reconcileResultOf(result: Exclude<LedgerReconcileResult, { reason: "IN_FLIGHT" }>): ReconcileResult {
  if (!result.ok) return { status: "too-early", retryAfterMs: result.retryAfterMs, warnings: result.warnings.map((w) => WARNING_OF[w]) };
  return {
    status: "done",
    creditsDeltaMicros: result.creditsDeltaMicros,
    deltaUnavailable: result.deltaUnavailable === null ? null : DELTA_UNAVAILABLE_OF[result.deltaUnavailable],
    ledgerDeltaMicros: result.ledgerTotalMicros,
    mismatch: result.mismatch,
    closedReserves: result.closedAttempts.length,
    aboveWorstAttempts: result.aboveWorstAttempts,
    tornLineMoved: result.tornMoved,
    warnings: result.warnings.map((w) => WARNING_OF[w]),
  };
}

type Money = { ok: true; budget: Budget } | { ok: false; unavailable: LedgerUnavailable };

/** A library and the identity of its folder. */
interface OpenedLibrary {
  library: Library;
  identity: string;
}

/**
 * The engine's state and command dispatcher. Every message from main is
 * parsed here: control messages (the API key, settings) against
 * `HostControl`, everything else with T0 `parseEngineCommand`, so a main-only
 * key command can never be executed by the engine. Commands without a
 * handler yet answer INTERNAL with a "not implemented" detail.
 */
export class Engine {
  readonly #deps: EngineDeps;
  readonly #folderFs: FolderFs;
  readonly #events: EventLog;
  readonly #encryptionAvailable: boolean;
  readonly #openRouterBaseUrl: string;
  #settings: EngineSettings;
  readonly #money: Money;
  #apiKey: string | null = null;
  /** The library of the saved settings; null when it could not be opened. */
  #live: OpenedLibrary | null = null;
  /** Folders main had the engine open that no settings update has confirmed yet, by folder identity. */
  #staged = new Map<string, Library>();
  /** Opens in progress, by folder identity: two surveys of one folder would race their quarantine moves. */
  readonly #opening = new Map<string, Promise<Library>>();
  /** Set by a 401 with the current key; a new key clears it. */
  #keyRejected = false;
  /** Main's notices, oldest first; pending for this engine's life. */
  readonly #notices: EngineNotice[] = [];
  /** Avatar records already reported as not fitting the contract, so each is logged once. */
  readonly #reportedSkips = new Set<string>();

  private constructor(init: EngineInit, money: Money, deps: EngineDeps) {
    this.#deps = deps;
    this.#folderFs = deps.folderFs ?? NODE_FOLDER_FS;
    this.#events = new EventLog(EVENT_LOG_CAPACITY, deps.bootId);
    this.#settings = init.settings;
    this.#encryptionAvailable = init.encryptionAvailable;
    this.#openRouterBaseUrl = resolveOpenRouterBaseUrl(init.openRouterBaseUrl, STUDIO_E2E);
    this.#money = money;
  }

  /**
   * Opens the ledger (`userData/ledger.jsonl`, passed in by main) under a
   * Budget and the library the settings name, then emits main's notices. A
   * ledger that cannot be read does not stop the engine: the money status
   * says why and money commands answer with the ledger's error. A library
   * that cannot be opened leaves the engine without one.
   */
  static async start(init: EngineInit, deps: EngineDeps): Promise<Engine> {
    let money: Money;
    try {
      const ledger = await Ledger.open(init.ledgerPath);
      // The engine's one Budget over the ledger, for its whole life: a new
      // monthly budget is set on it, never by building another (that would
      // forget which open reserves are this process's own and put a second
      // mutex on the ledger). No paid job exists yet (T6a part 2 and T6
      // register each job's cap), so a scope without a cap can reserve nothing.
      const budget = new Budget(ledger, {
        runCapMicros: 0,
        monthlyBudgetMicros: init.settings.monthlyBudgetMicros,
        clock: deps.clock,
        monotonic: deps.monotonic,
      });
      money = { ok: true, budget };
    } catch (error) {
      money = { ok: false, unavailable: ledgerUnavailable(error) };
    }
    const engine = new Engine(init, money, deps);
    engine.#live = await engine.#openOrNull(init.settings.libraryPath);
    for (const notice of init.notices) engine.#addNotice(notice);
    return engine;
  }

  /**
   * For the OpenRouter client and the jobs on a 401 with `rejectedKey`, the
   * key that request carried: the key is marked rejected in the settings and
   * the snapshot, and `settings.changed` is emitted once; a new key clears it.
   * A 401 for a key the user has replaced meanwhile (a request can take
   * minutes) changes nothing. The caller stops the run and never retries.
   */
  markKeyRejected(rejectedKey: string): void {
    if (this.#apiKey === null || this.#apiKey !== rejectedKey || this.#keyRejected) return;
    this.#keyRejected = true;
    this.#emitSettings();
  }

  /** The OpenRouter API base for the client: always the real one outside an E2E build. */
  get openRouterBaseUrl(): string {
    return this.#openRouterBaseUrl;
  }

  get bootId(): string {
    return this.#events.bootId;
  }

  /** The key OpenRouter calls will use; never sent anywhere but OpenRouter. */
  get apiKey(): string | null {
    return this.#apiKey;
  }

  /** The library of the saved settings, if it is open. */
  get library(): Library | null {
    return this.#live?.library ?? null;
  }

  /** The one Budget over the ledger, for the paid jobs; null when the ledger could not be read. */
  get budget(): Budget | null {
    return this.#money.ok ? this.#money.budget : null;
  }

  /** Handles one message from main: a control message is applied, a call or a command is answered through `post`. */
  async receive(message: unknown): Promise<void> {
    if (isControlMessage(message)) {
      const call = HostCall.safeParse(message);
      if (call.success) this.#deps.post(await this.#answer(call.data));
      else await this.applyControl(message);
      return;
    }
    this.#deps.post(await this.handle(message));
  }

  async #answer(call: HostCall): Promise<EngineReply> {
    switch (call.type) {
      case "library.open": {
        const identity = await folderIdentity(call.path, this.#folderFs);
        // The live library's folder, however it is spelled: opening it again
        // would survey (and quarantine) it under the writes of the one in use.
        if (identity !== null && identity === this.#live?.identity) return { kind: "control", type: "reply", callId: call.callId };
        // Paid requests in flight write where the live library is; part 2 adds running jobs.
        if (this.#money.ok && this.#money.budget.inFlightCount() > 0) {
          const detail = "paid requests are in flight; change the library folder when they end";
          return { kind: "control", type: "reply", callId: call.callId, error: { code: "IN_FLIGHT", detail } };
        }
        try {
          const opened = await this.#open(call.path, identity);
          this.#staged.set(opened.identity, opened.library);
          return { kind: "control", type: "reply", callId: call.callId };
        } catch (error) {
          const code = error instanceof LibraryError ? "VALIDATION" : "INTERNAL";
          return { kind: "control", type: "reply", callId: call.callId, error: { code, detail: messageOf(error, "the library could not be opened") } };
        }
      }
    }
  }

  /**
   * Applies a control message from main; resolves once it is fully applied
   * (a settings update may switch the library). Key changes apply before the
   * first await. Invalid control messages are dropped without echoing their
   * content.
   */
  async applyControl(message: unknown): Promise<void> {
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
        this.#emitSettings();
        return;
      case "apiKey.clear":
        this.#apiKey = null;
        this.#keyRejected = false;
        this.#emitSettings();
        return;
      case "settings.update":
        await this.#applySettings(control.settings);
        return;
    }
  }

  /** Parses and answers one command. Never throws. */
  async handle(raw: unknown): Promise<ResponseMessage> {
    const parsed = parseEngineCommand(raw);
    if (!parsed.ok) return errorResponseFor(raw, { code: "VALIDATION", detail: parsed.reason });
    try {
      return await this.#dispatch(parsed.command);
    } catch (error) {
      return errorResponseFor(parsed.command, engineErrorFrom(error));
    }
  }

  async #dispatch(command: EngineCommandMessage): Promise<ResponseMessage> {
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
      case "money.reconcile":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#reconcile() };
      case "avatars.list": {
        const view = this.#libraryView();
        const result = { avatars: view.avatars, unreadableAvatars: view.skipped.length };
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      default:
        return errorResponseFor(command, { code: "INTERNAL", detail: `${command.type} is not implemented yet` });
    }
  }

  #snapshot(): Snapshot {
    const view = this.#libraryView();
    return {
      bootId: this.#events.bootId,
      lastSeq: this.#events.lastSeq,
      settings: this.#currentSettings(),
      money: this.#moneyStatus(),
      avatars: view.avatars,
      drafts: view.drafts,
      unreadableAvatars: view.skipped.length,
      // Filled by the avatar and run jobs (T6a part 2, T6).
      jobs: [],
      notices: [...this.#notices],
    };
  }

  #libraryView(): LibraryView {
    if (this.#live === null) return { avatars: [], drafts: [], skipped: [] };
    const view = libraryView(this.#live.library);
    const fresh = view.skipped.filter((id) => !this.#reportedSkips.has(id));
    if (fresh.length > 0) {
      for (const id of fresh) this.#reportedSkips.add(id);
      console.warn(`studio engine: avatar records that do not fit the contract are not listed: ${fresh.join(", ")}`);
    }
    return view;
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

  /**
   * Main persisted new settings: they are made current and a new monthly
   * budget goes to the Budget. The library follows the saved folder: when it
   * is not the live library's folder (or there is none), the engine takes the
   * one staged by `library.open` or, failing that, opens it now — so a folder
   * picked again after it was missing at start is taken too. Staged folders
   * that no update confirmed are dropped: main gave up on them.
   */
  async #applySettings(next: EngineSettings): Promise<void> {
    const previous = this.#settings;
    this.#settings = next;
    const staged = this.#staged;
    this.#staged = new Map();
    if (this.#money.ok && next.monthlyBudgetMicros !== previous.monthlyBudgetMicros) {
      await this.#money.budget.setMonthlyBudget(next.monthlyBudgetMicros);
    }
    const identity = await folderIdentity(next.libraryPath, this.#folderFs);
    if (identity === null || identity !== this.#live?.identity) {
      const kept = identity === null ? undefined : staged.get(identity);
      const live = kept !== undefined && identity !== null ? { library: kept, identity } : await this.#openOrNull(next.libraryPath);
      // A later update may have named another folder while this one opened.
      if (this.#settings.libraryPath === next.libraryPath) this.#live = live;
    }
    this.#emitSettings();
  }

  /**
   * Opens the library at `path`, sharing an open of the same folder already
   * in progress. The folder is identified before it is touched: one that
   * cannot be identified is refused, never surveyed and then thrown away.
   * Never creates the folder.
   */
  async #open(path: string, knownIdentity: string | null): Promise<OpenedLibrary> {
    const identity = knownIdentity ?? (await folderIdentity(path, this.#folderFs));
    if (identity === null) throw new Error(`${path} is not a folder the engine can read`);
    const pending = this.#opening.get(identity);
    if (pending !== undefined) return { library: await pending, identity };
    const opening = openLibrary(path).then((opened) => opened.library);
    this.#opening.set(identity, opening);
    try {
      return { library: await opening, identity };
    } finally {
      if (this.#opening.get(identity) === opening) this.#opening.delete(identity);
    }
  }

  /** `#open`, or null (and a log line) when the folder cannot hold a library now. */
  async #openOrNull(path: string): Promise<OpenedLibrary | null> {
    try {
      return await this.#open(path, null);
    } catch (error) {
      console.warn(`studio engine: the library could not be opened (${messageOf(error, "unknown error")})`);
      return null;
    }
  }

  #currentSettings(): Settings {
    return { apiKey: this.#apiKeyStatus(), ...this.#settings };
  }

  #moneyStatus(): MoneyStatus {
    const month = new Date(this.#deps.clock()).toISOString().slice(0, 7);
    const money = this.#money;
    if (!money.ok) {
      return {
        ledger: "unavailable",
        month,
        monthlyBudgetMicros: this.#settings.monthlyBudgetMicros,
        reconcileNeeded: false,
        reconcileReasons: [],
        halt: money.unavailable,
      };
    }
    const { budget } = money;
    const status = budget.status();
    const reasons: ReconcileReason[] = [];
    // Open reserves other than this process's in-flight ones were left by a
    // crash, an abort or a timeout: they wait for a user reconcile.
    if (status.openAttempts - budget.inFlightCount() > 0) reasons.push("open-reserves");
    if (status.torn) reasons.push("torn-ledger-line");
    return {
      ledger: "open",
      month,
      spentMicros: status.spentThisMonthMicros,
      monthlyBudgetMicros: status.monthlyBudgetMicros,
      unsettledMicros: status.openReserveMicros,
      unsettledCount: status.openAttempts,
      reconcileNeeded: reasons.length > 0,
      reconcileReasons: reasons,
      halt: Engine.#haltOf(budget, status),
    };
  }

  static #haltOf(budget: Budget, status: BudgetStatus): MoneyHalt | null {
    switch (status.haltCause) {
      case null:
        return null;
      case "SETTLE_ABOVE_WORST":
        return {
          cause: "SETTLE_ABOVE_WORST",
          detail: "billed above the reserved worst case, so the price table is wrong; a reconcile acknowledges it",
          attemptIds: budget.aboveWorstAttempts(),
        };
      case "LEDGER_WRITE_FAILED":
        return { cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed, so nothing more is written; restart the app" };
    }
  }

  /**
   * The user's reconcile (T2) against `/credits` (T3). Needs a key OpenRouter
   * has not rejected; a 401 marks it rejected. Emits `money.changed` whenever
   * the ledger may have changed.
   */
  async #reconcile(): Promise<ReconcileResult> {
    const money = this.#money;
    // The cause is its own error code: LEDGER_CORRUPT or LEDGER_UNREADABLE.
    if (!money.ok) throw new EngineFailure({ code: money.unavailable.cause, detail: money.unavailable.detail });
    const key = this.#apiKey;
    if (key === null) throw new EngineFailure({ code: "AUTH_INVALID", detail: "no OpenRouter API key is stored; add one in Settings to reconcile" });
    if (this.#keyRejected) throw new EngineFailure({ code: "AUTH_INVALID", detail: "OpenRouter rejected the stored API key (401); store a new key to reconcile" });
    let result: LedgerReconcileResult;
    try {
      const client = this.#openRouter(key);
      result = await money.budget.reconcile({ fetchCredits: () => client.fetchCredits() });
    } catch (error) {
      // /credits failed before anything was written.
      if (error instanceof OpenRouterError) {
        if (error.code === "AUTH_INVALID") this.markKeyRejected(key);
        throw new EngineFailure(fromOpenRouterError(error));
      }
      // Anything else may have happened between ledger writes: announce what the ledger says now.
      this.#emitMoney();
      if (money.budget.ledger.failed) throw new EngineFailure({ code: "LEDGER_WRITE_FAILED", detail: messageOf(error, "a ledger write failed") });
      throw error;
    }
    // IN_FLIGHT is the contract's error, not a result: this engine's own paid requests are still out.
    if (!result.ok && result.reason === "IN_FLIGHT") {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: `${result.inFlight} paid request(s) of this engine are still in flight; reconcile when they end` });
    }
    const answer = reconcileResultOf(result);
    if (answer.status === "done") this.#emitMoney();
    return answer;
  }

  /** A client for the current key and base URL; the key goes to OpenRouter only. */
  #openRouter(key: string): OpenRouterClient {
    return createOpenRouterClient({
      apiKey: key,
      baseUrl: this.#openRouterBaseUrl,
      allowBaseUrlOverride: STUDIO_E2E,
      fetch: this.#deps.fetch,
      // Only a paid 2xx that cannot be used is saved; the engine sends no paid
      // request before the avatar jobs (T6a part 2), which decide where it goes.
      saveRaw: async () => {
        throw new Error("no paid request is sent before the avatar jobs, so there is no raw body to save");
      },
      clock: this.#deps.clock,
      monotonic: this.#deps.monotonic,
    });
  }

  #addNotice(notice: EngineNotice): void {
    if (this.#notices.some((n) => n.noticeId === notice.noticeId)) return;
    this.#notices.push(notice);
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "engine.notice", payload: { notice } });
  }

  #emitSettings(): void {
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "settings.changed", payload: { settings: this.#currentSettings() } });
  }

  #emitMoney(): void {
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "money.changed", payload: { status: this.#moneyStatus() } });
  }

  /** Stamps an event with the next seq and this engine's bootId and sends it to main. */
  #emit(event: UnsequencedEvent): void {
    const seq = this.#events.append(event);
    const stamped = this.#events.since(seq - 1, this.#events.bootId);
    if (!stamped.gap) for (const e of stamped.events) this.#deps.post(e);
  }
}
