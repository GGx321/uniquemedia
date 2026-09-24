import { mkdir } from "node:fs/promises";
import {
  errorResponseFor,
  EventLog,
  parseEngineCommand,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type CommandPayload,
  type Draft,
  type EngineCommandMessage,
  type EngineError,
  type EngineNotice,
  type Estimate,
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
import { runDescriptorJob } from "./avatars/descriptorJob";
import { avatarJobEstimate, avatarPriceModels, descriptorJobCap, type AvatarModels } from "./avatars/plan";
import { draftFrom, libraryView, manifestTraits, type LibraryView } from "./avatars/records";
import { folderIdentity, NODE_FOLDER_FS, type FolderFs } from "./folderIdentity";
import { EngineReply, HostCall, HostControl, isControlMessage, type EngineInit, type EngineSettings } from "./control";
import { LibraryError, openLibrary, type Library } from "./library";
import { STUDIO_E2E } from "./buildFlags";
import { Budget, scopeKey, type BudgetStatus } from "./money/budget";
import { MoneyError } from "./money/errors";
import { Ledger, type Scope } from "./money/ledger";
import { PriceCache } from "./money/priceCache";
import { loadPriceBook, OPENROUTER_API_BASE } from "./money/prices";
import type { ReconcileResult as LedgerReconcileResult, ReconcileWarning as LedgerReconcileWarning } from "./money/reconcile";
import { createOpenRouterClient, fromOpenRouterError, OpenRouterError, type OpenRouterClient, type OpenRouterFetch } from "./openrouter";
import { priceFetchFrom } from "./openrouter/priceFetch";
import { rawFileName, saveRawBody } from "./rawStore";

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

/** The manifest needs a name; a draft gets the user's name only when a candidate is picked. */
const DRAFT_NAME = "Draft";

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
  /** Each running paid job's cap by scope (`scopeKey`), shared with the Budget; a scope without one can reserve nothing. */
  readonly #caps: Map<string, number>;
  /** Prices for the engine's life, fetched (free, no key) through the injected fetch. */
  readonly #prices: PriceCache;
  readonly #rawDir: string;
  /** Paid commands running now (createDraft): the library they write to must not change under them. */
  #paidCommands = 0;
  /** One createDraft at a time: a second click (the wizard left and opened again) must not buy a second descriptor. */
  #creatingDraft = false;

  private constructor(init: EngineInit, money: Money, caps: Map<string, number>, deps: EngineDeps) {
    this.#deps = deps;
    this.#folderFs = deps.folderFs ?? NODE_FOLDER_FS;
    this.#events = new EventLog(EVENT_LOG_CAPACITY, deps.bootId);
    this.#settings = init.settings;
    this.#encryptionAvailable = init.encryptionAvailable;
    this.#openRouterBaseUrl = resolveOpenRouterBaseUrl(init.openRouterBaseUrl, STUDIO_E2E);
    this.#money = money;
    this.#caps = caps;
    this.#rawDir = init.rawDir;
    const priceFetch = priceFetchFrom(deps.fetch);
    this.#prices = new PriceCache({
      load: (models) => loadPriceBook({ fetch: priceFetch, baseUrl: this.#openRouterBaseUrl, ...models }),
      clock: deps.clock,
      monotonic: deps.monotonic,
    });
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
    const caps = new Map<string, number>();
    try {
      const ledger = await Ledger.open(init.ledgerPath);
      // The engine's one Budget over the ledger, for its whole life: a new
      // monthly budget is set on it, never by building another (that would
      // forget which open reserves are this process's own and put a second
      // mutex on the ledger). Each paid job registers its cap (its own worst
      // case) before its first reserve; a scope without a cap can reserve nothing.
      const budget = new Budget(ledger, {
        runCapMicros: (scope) => caps.get(scopeKey(scope)) ?? 0,
        monthlyBudgetMicros: init.settings.monthlyBudgetMicros,
        clock: deps.clock,
        monotonic: deps.monotonic,
      });
      money = { ok: true, budget };
    } catch (error) {
      money = { ok: false, unavailable: ledgerUnavailable(error) };
    }
    const engine = new Engine(init, money, caps, deps);
    // First run: the default folder does not exist yet. Only the default is
    // created; a folder the user chose may be a volume that is not mounted.
    if (init.settings.libraryPath === init.defaultLibraryPath) {
      await mkdir(init.defaultLibraryPath, { recursive: true }).catch((error: unknown) => {
        console.warn(`studio engine: the default library folder could not be created (${messageOf(error, "unknown error")})`);
      });
    }
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
        // Paid requests in flight, and paid commands between their steps, write where the live library is.
        if (this.#paidCommands > 0 || (this.#money.ok && this.#money.budget.inFlightCount() > 0)) {
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
      case "avatars.estimate": {
        // The traits do not change the price: the descriptor prompt is bounded by its ceiling.
        const models = this.#avatarModels();
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models)), models, "new-avatar");
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimateCandidates": {
        if (this.#draft(command.payload.avatarId) === null) {
          throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${command.payload.avatarId} in the open library` });
        }
        const models = this.#avatarModels();
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models)), models, "next-batch");
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.createDraft": {
        if (this.#creatingDraft) {
          throw new EngineFailure({ code: "IN_FLIGHT", detail: "a new avatar's descriptor is already being written; wait for it to finish" });
        }
        this.#creatingDraft = true;
        this.#paidCommands++;
        try {
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#createDraft(command.payload) };
        } finally {
          this.#paidCommands--;
          this.#creatingDraft = false;
        }
      }
      default:
        return errorResponseFor(command, { code: "INTERNAL", detail: `${command.type} is not implemented yet` });
    }
  }

  #snapshot(): Snapshot {
    const view = this.#libraryView();
    const nextBatch = this.#nextBatchAtKnownPrices();
    return {
      bootId: this.#events.bootId,
      lastSeq: this.#events.lastSeq,
      settings: this.#currentSettings(),
      money: this.#moneyStatus(),
      avatars: view.avatars,
      drafts: view.drafts.map((draft) => ({ ...draft, estimate: nextBatch })),
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

  // ---------- avatars ----------

  #avatarModels(): AvatarModels {
    return { imageModel: this.#settings.imageModel, textModel: this.#settings.textModel };
  }

  /** A draft of the open library as the contract lists it; null for anything else. */
  #draft(avatarId: string): Draft | null {
    const library = this.library;
    const manifest = library?.getAvatar(avatarId);
    if (library === null || manifest === undefined) return null;
    return draftFrom(manifest, library.photosByAvatar(avatarId));
  }

  /**
   * A draft's next batch at the prices the engine already has (the contract's
   * `Draft.estimate`); null before any estimate loaded them. Never fetches:
   * a snapshot must not wait on the network.
   */
  #nextBatchAtKnownPrices(): Estimate | null {
    const models = this.#avatarModels();
    const priced = this.#prices.peek(avatarPriceModels(models));
    return priced === null ? null : avatarJobEstimate(priced, models, "next-batch");
  }

  /**
   * A new avatar's draft: the paid descriptor call, then the draft in the
   * library. Checked before anything is spent, in the order the UI expects
   * (the renderer's mock engine): a usable key, a ledger that allows paid
   * calls, an open library, the worst case the user accepted (PRICE_CHANGED)
   * and room in the month, both for the whole new-avatar job. The command's
   * own scope is capped at what it sends (every descriptor attempt at its
   * ceiling); the Budget checks every attempt against it and the global budget.
   */
  async #createDraft(payload: CommandPayload<"avatars.createDraft">): Promise<{ draft: Draft }> {
    const key = this.#usableKey("create an avatar");
    const budget = this.#paidBudget();
    const library = this.library;
    if (library === null) {
      throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    }
    const models = this.#avatarModels();
    const priced = await this.#prices.get(avatarPriceModels(models));
    const job = avatarJobEstimate(priced, models, "new-avatar");
    if (job.worstMicros > payload.acceptedWorstMicros) {
      throw new EngineFailure({ code: "PRICE_CHANGED", detail: `the worst case is now ${job.worstMicros} µ$, above the accepted ${payload.acceptedWorstMicros} µ$` });
    }
    const month = budget.status();
    const committed = month.spentThisMonthMicros + month.openReserveMicros;
    if (committed + job.worstMicros > month.monthlyBudgetMicros) {
      const detail = `committed ${committed} µ$ + this job's worst case ${job.worstMicros} µ$ > the monthly budget ${month.monthlyBudgetMicros} µ$`;
      throw new EngineFailure({ code: "BUDGET_EXCEEDED", detail });
    }

    const jobId = this.#deps.newId();
    const scope: Scope = { avatarJobId: jobId };
    // The scope only ever sends descriptor attempts: its cap is theirs, and it goes when the command ends.
    this.#caps.set(scopeKey(scope), descriptorJobCap(priced, models));
    const client = this.#openRouter(key);
    const linesBefore = budget.ledger.lines.length;
    let result: Awaited<ReturnType<typeof runDescriptorJob>>;
    try {
      result = await runDescriptorJob(
        { chat: (params) => client.chat(params), budget, priceBook: priced.book },
        { jobId, scope, traits: payload.traits, textModel: models.textModel },
      );
    } finally {
      this.#caps.delete(scopeKey(scope));
      if (budget.ledger.lines.length !== linesBefore || budget.ledger.failed) this.#emitMoney();
    }
    if (!result.ok) {
      if (result.error.code === "AUTH_INVALID") this.markKeyRejected(key);
      throw new EngineFailure(result.error);
    }

    const { descriptor } = result;
    const manifest = await library
      .createAvatar({ name: DRAFT_NAME, age: payload.traits.age, traits: manifestTraits(payload.traits), descriptor: descriptor.text })
      .catch(async (error: unknown) => {
        // The descriptor is paid for: keep it where the owner can find it, and say where.
        const kept = `${jobId}:descriptor`;
        const where = await saveRawBody(this.#rawDir, kept, JSON.stringify({ traits: payload.traits, descriptor })).then(
          () => `the paid descriptor is kept in raw/${rawFileName(kept)} next to the ledger`,
          (saveError: unknown) => `the paid descriptor could not be kept either (${messageOf(saveError, "unknown error")})`,
        );
        // Where it is kept comes first, so the 500-char cut of `detail` cannot drop it.
        throw new EngineFailure({ code: "INTERNAL", detail: detailOf(`${where}: the draft could not be written (${messageOf(error, "unknown error")})`) });
      });
    const stored = draftFrom(manifest, []);
    if (stored === null) throw new Error(`the new draft ${manifest.id} does not fit the contract`);
    const draft: Draft = { ...stored, estimate: avatarJobEstimate(priced, models, "next-batch") };
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "draft.changed", payload: { draft } });
    return { draft };
  }

  /** The key for a paid or keyed call: stored, and not rejected by OpenRouter. */
  #usableKey(purpose: string): string {
    const key = this.#apiKey;
    if (key === null) throw new EngineFailure({ code: "AUTH_INVALID", detail: `no OpenRouter API key is stored; add one in Settings to ${purpose}` });
    if (this.#keyRejected) throw new EngineFailure({ code: "AUTH_INVALID", detail: `OpenRouter rejected the stored API key (401); store a new key to ${purpose}` });
    return key;
  }

  /** The Budget, when the ledger allows paid calls now: readable, not halted, nothing to reconcile. */
  #paidBudget(): Budget {
    const money = this.#money;
    if (!money.ok) throw new EngineFailure({ code: money.unavailable.cause, detail: money.unavailable.detail });
    const status = money.budget.status();
    const halt = Engine.#haltOf(money.budget, status);
    if (halt !== null) throw new EngineFailure({ code: halt.cause, detail: halt.detail });
    if (status.state === "reconcile-required") {
      throw new EngineFailure({ code: "RECONCILE_REQUIRED", detail: `${status.openAttempts} open attempt(s)${status.torn ? ", torn ledger line" : ""}; reconcile before any paid call` });
    }
    return money.budget;
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
    const key = this.#usableKey("reconcile");
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
      // Only a paid 2xx that cannot be used is saved, already redacted: in
      // userData next to the ledger, so the evidence outlives a library move.
      saveRaw: (attemptId, text) => saveRawBody(this.#rawDir, attemptId, text),
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
