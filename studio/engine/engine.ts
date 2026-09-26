import { mkdir } from "node:fs/promises";
import {
  AvatarDescriptor,
  AvatarTraits,
  errorResponseFor,
  EventLog,
  parseEngineCommand,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type AvatarSummary,
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
  type UnreadableAvatar,
  type UnsequencedEvent,
  UNREADABLE_REASON_DETAIL,
} from "../shared/engine";
import { downscaleToJpeg } from "../node/downscale";
import { AGE_CHECK_MAX_SIDE } from "./avatars/ageCheck";
import { candidateJobEnd, runCandidateJob, type SlotOutcome } from "./avatars/candidateJob";
import { runDescriptorJob } from "./avatars/descriptorJob";
import { avatarJobEstimate, avatarPriceModels, CANDIDATES_PER_BATCH, descriptorJobCap, type AvatarModels } from "./avatars/plan";
import { promptSubject, PromptSubjectError } from "./avatars/prompts";
import { avatarSummaryFrom, combineUnreadable, draftFrom, isRewritable, libraryView, manifestTraits, unreadableFromQuarantine } from "./avatars/records";
import { JobRegistry, type CandidatesJobEnd } from "./jobs";
import { folderIdentity, NODE_FOLDER_FS, type FolderFs } from "./folderIdentity";
import { EngineReply, HostCall, HostControl, isControlMessage, type EngineInit, type EngineSettings } from "./control";
import { LibraryError, openLibrary, type AvatarManifest, type Library } from "./library";
import { STUDIO_E2E } from "./buildFlags";
import { Budget, scopeKey, type BudgetStatus } from "./money/budget";
import { MoneyError } from "./money/errors";
import { Ledger, type Scope } from "./money/ledger";
import { PriceCache } from "./money/priceCache";
import type { PriceBook } from "./money/prices";
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

/** A candidate job while it runs: what it was started with, and how many slots are done. */
interface RunningCandidates {
  jobId: string;
  scope: Scope;
  avatarId: string;
  descriptor: AvatarDescriptor;
  /** The key the job was started with: a 401 marks this key rejected, not one stored since. */
  key: string;
  budget: Budget;
  /** The library the draft is in; a library switch is refused while the job runs. */
  library: Library;
  priceBook: PriceBook;
  imageModel: string;
  concurrency: number;
  signal: AbortSignal;
  done: number;
}

/** A library, the identity of its folder, and the whole avatar folders quarantined (bounded) when it was opened. */
interface OpenedLibrary {
  library: Library;
  identity: string;
  unreadable: UnreadableAvatar[];
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
  /** Bumped by one every time `#live`'s folder identity actually changes (invariant: every open window resyncs after a switch). */
  #librarySwitchGeneration = 0;
  /**
   * Folders main had the engine open that no confirm has switched to yet, by
   * the exact path string `library.open` staged them under (never a
   * resolved identity: `library.confirm` looks one up by that same string,
   * with no survey of its own — see `#answer`'s `library.confirm` case).
   */
  #staged = new Map<string, OpenedLibrary>();
  /**
   * The `libraryPath` of the most recent `#applySettings` call, whether or
   * not it has committed yet. Not `#settings.libraryPath`, which only moves
   * once a switch actually lands: this field alone detects a later
   * `settings.update` racing in during an earlier one's awaits, so the
   * earlier one's stale result is discarded instead of half-applied.
   */
  #pendingLibraryPath: string;
  /**
   * Non-zero while `#applySettings` surveys a folder it is not yet sure is
   * a genuine switch (between its own busy check and the switch actually
   * landing): `#liveLibrary()` refuses IN_FLIGHT then, so a paid command,
   * pick or archive starting during the survey cannot write through the
   * library instance that is about to be replaced. Not part of `#busy()`
   * itself: `#applySettings` also reads `#busy()` to detect new work that
   * started during that same survey, and folding this counter into it would
   * make that recheck see its own switch as "busy" and refuse itself.
   */
  #switching = 0;
  /** Opens in progress, by folder identity: two surveys of one folder would race their quarantine moves. */
  readonly #opening = new Map<string, Promise<{ library: Library; unreadable: UnreadableAvatar[] }>>();
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
  /** The avatar jobs of this engine's life, as `Snapshot.jobs` lists them. */
  readonly #jobs = new JobRegistry();
  /**
   * Avatars a running job or command is changing: a candidate job holds its
   * draft until it ends, pick and archive while they write. Anything else
   * that would change one of them is refused with IN_FLIGHT.
   */
  readonly #busyAvatars = new Set<string>();

  private constructor(init: EngineInit, money: Money, caps: Map<string, number>, deps: EngineDeps) {
    this.#deps = deps;
    this.#folderFs = deps.folderFs ?? NODE_FOLDER_FS;
    this.#events = new EventLog(EVENT_LOG_CAPACITY, deps.bootId);
    this.#settings = init.settings;
    this.#pendingLibraryPath = init.settings.libraryPath;
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
        // would survey (and quarantine) it under the writes of the one in
        // use. Staged under this spelling too, not just answered ok: a
        // later confirm of this exact string (main's normal open-then-
        // confirm sequence) must find something to adopt, not VALIDATION
        // forever — adopting #live as-is, no re-survey, is always correct
        // here, since it is already the live instance.
        if (identity !== null && identity === this.#live?.identity) {
          if (this.#live !== null) this.#staged.set(call.path, this.#live);
          return { kind: "control", type: "reply", callId: call.callId };
        }
        if (this.#busy()) return { kind: "control", type: "reply", callId: call.callId, error: this.#inFlightRefusal() };
        try {
          const opened = await this.#open(call.path, identity);
          // Staged under the exact string main sent, not the resolved
          // identity: `library.confirm` looks it up the same way, with no
          // survey of its own (the TOCTOU this closes; see its case below).
          this.#staged.set(call.path, opened);
          return { kind: "control", type: "reply", callId: call.callId };
        } catch (error) {
          const code = error instanceof LibraryError ? "VALIDATION" : "INTERNAL";
          return { kind: "control", type: "reply", callId: call.callId, error: { code, detail: messageOf(error, "the library could not be opened") } };
        }
      }
      case "library.confirm": {
        // Already the live (and saved) folder: a harmless no-op, by the
        // exact path string, with no staging lookup and no survey.
        if (call.path === this.#settings.libraryPath && this.#live !== null) {
          return { kind: "control", type: "reply", callId: call.callId };
        }
        // Requires a folder `library.open` staged under this exact path
        // string. Never surveyed fresh here: doing that after the busy check
        // below would reopen the TOCTOU window this call exists to close (a
        // paid command starting during the survey would write into the old
        // library while this call answers ok). Main must send library.open
        // again for a folder nothing is staged for (a dropped confirm, a
        // restart): see control.ts's doc comment on this call.
        const staged = this.#staged.get(call.path);
        if (staged === undefined) {
          const detail = "the folder is not staged; open it again";
          return { kind: "control", type: "reply", callId: call.callId, error: { code: "VALIDATION", detail } };
        }
        if (this.#busy()) {
          // Dropped rather than left lingering: main always opens a folder
          // again before confirming it, so a retry re-stages it fresh
          // instead of ever adopting this now-stale entry later.
          this.#staged.delete(call.path);
          return { kind: "control", type: "reply", callId: call.callId, error: this.#inFlightRefusal() };
        }
        // No await between the check above and here: the switch is atomic
        // with the busy check just made, so nothing can start writing into
        // the old library between "not busy" and "switched".
        const beforeIdentity = this.#live?.identity ?? null;
        if (staged.identity !== beforeIdentity) this.#librarySwitchGeneration++;
        this.#live = staged;
        this.#settings = { ...this.#settings, libraryPath: call.path };
        this.#pendingLibraryPath = call.path;
        // Every other folder still staged (candidates main gave up on) is
        // stale the moment the live folder changes underneath it.
        this.#staged = new Map();
        this.#emitSettings();
        return { kind: "control", type: "reply", callId: call.callId };
      }
    }
  }

  /** True while a job or paid command writes into the live library, or a pick/archive is running: a library switch must be refused. */
  #busy(): boolean {
    return this.#paidCommands > 0 || this.#busyAvatars.size > 0 || (this.#money.ok && this.#money.budget.inFlightCount() > 0);
  }

  #inFlightRefusal(): EngineError {
    return { code: "IN_FLIGHT", detail: "paid requests, or a pick or archive, are in flight; change the library folder when they end" };
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
      case "settings.update": {
        const refusal = await this.#applySettings(control.settings);
        // settings.update has no reply main waits on: the engine's actual
        // libraryPath is already visible through the settings.changed
        // #applySettings emits unconditionally, so main can reconcile
        // settings.json to it (see main's onEvent); this is only so the
        // refusal itself is not silent.
        if (refusal !== null) console.warn(`studio engine: a settings.update's library switch was refused (${refusal.code}): ${refusal.detail ?? ""}`);
        return;
      }
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
        const result = { avatars: view.avatars, unreadableAvatars: view.unreadable, unreadableTotal: view.unreadableTotal };
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimate": {
        // The traits do not change the price: the descriptor prompt is bounded by its ceiling.
        const models = this.#avatarModels();
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models)), models, "new-avatar");
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimateCandidates": {
        // Same order as generateCandidates: NOT_FOUND for an unknown or non-draft
        // id, DESCRIPTOR_INVALID (never INTERNAL) for a stored descriptor that
        // fails today's rules, before the price fetch below spends anything on it.
        const { avatarId } = command.payload;
        const manifest = this.library?.getAvatar(avatarId);
        if (manifest === undefined || manifest.status !== "draft") {
          throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${avatarId} in the open library` });
        }
        this.#assertDescriptorReadable(manifest);
        if (this.#draft(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `the draft ${avatarId} does not fit the contract` });
        const models = this.#avatarModels();
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models)), models, "next-batch");
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimateRewriteDescriptor": {
        // Free, so no #switching gating: LIBRARY_UNAVAILABLE without a
        // library (matching avatars.rewriteDescriptor's own #liveLibrary()),
        // NOT_FOUND for an unknown id, VALIDATION when there is nothing to
        // fix or the record is not rewritable at all.
        const library = this.library;
        if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
        const manifest = this.#manifestOrNotFound(library, command.payload.avatarId);
        this.#assertRewritable(command.payload.avatarId, manifest);
        const models = this.#avatarModels();
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models, "rewrite-descriptor")), models, "rewrite-descriptor");
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
      case "avatars.generateCandidates": {
        const { avatarId } = command.payload;
        this.#claimAvatar(avatarId, "a batch of candidates is already being made for this draft; wait for it to finish");
        this.#paidCommands++;
        let started = false;
        try {
          const result = await this.#generateCandidates(command.payload);
          started = true;
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
        } finally {
          // A started job holds both until it ends.
          if (!started) {
            this.#paidCommands--;
            this.#busyAvatars.delete(avatarId);
          }
        }
      }
      case "avatars.cancel": {
        const { jobId } = command.payload;
        if (!this.#jobs.cancel(jobId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no job ${jobId} in this engine` });
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { jobId } };
      }
      case "avatars.pick":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#pick(command.payload) };
      case "avatars.archive":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#archive(command.payload) };
      case "avatars.rewriteDescriptor": {
        const { avatarId } = command.payload;
        this.#claimAvatar(avatarId, "a job or command is already changing this avatar; wait for it to finish");
        this.#paidCommands++;
        try {
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#rewriteDescriptor(command.payload) };
        } finally {
          this.#paidCommands--;
          this.#busyAvatars.delete(avatarId);
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
      unreadableAvatars: view.unreadable,
      unreadableTotal: view.unreadableTotal,
      // Avatar jobs of this engine's life; run jobs come with T6.
      jobs: this.#jobs.states(),
      librarySwitchGeneration: this.#librarySwitchGeneration,
      notices: [...this.#notices],
    };
  }

  /**
   * Saved avatars and drafts of the live library, plus every avatar record it
   * could not list normally: a whole manifest quarantined at open (this
   * library's own, fixed for its life) and every record `libraryView` had to
   * skip (drafts and saved avatars alike, re-checked on every call — a
   * descriptor that fails today's rules only after a rule tightened is caught
   * here, not only at open). Bounded at MAX_UNREADABLE_AVATARS, a rewritable
   * (descriptor-invalid) entry first (records.ts's `combineUnreadable`, L2):
   * a library with many quarantined or otherwise unreadable folders must
   * never push a fixable one off the list.
   */
  #libraryView(): { avatars: AvatarSummary[]; drafts: Draft[]; unreadable: UnreadableAvatar[]; unreadableTotal: number } {
    if (this.#live === null) return { avatars: [], drafts: [], unreadable: [], unreadableTotal: 0 };
    const view = libraryView(this.#live.library);
    const fresh = view.skipped.filter((s) => !this.#reportedSkips.has(s.avatarId));
    if (fresh.length > 0) {
      for (const s of fresh) this.#reportedSkips.add(s.avatarId);
      console.warn(`studio engine: avatar records that do not fit the contract are not listed: ${fresh.map((s) => s.avatarId).join(", ")}`);
    }
    const fromSkipped: UnreadableAvatar[] = view.skipped.map((s) => ({ avatarId: s.avatarId, reason: s.reason, detail: UNREADABLE_REASON_DETAIL[s.reason] }));
    // The true count, before the bound: the list a window shows can be cut, this count never is (L1).
    const unreadableTotal = fromSkipped.length + this.#live.unreadable.length;
    const unreadable = combineUnreadable(fromSkipped, this.#live.unreadable);
    return { avatars: view.avatars, drafts: view.drafts, unreadable, unreadableTotal };
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

  /** The stored manifest for `avatarId` in `library` (any status), whether or not it fits the contract; NOT_FOUND when there is none. */
  #manifestOrNotFound(library: Library | null, avatarId: string): AvatarManifest {
    const manifest = library?.getAvatar(avatarId);
    if (manifest === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    return manifest;
  }

  /**
   * DESCRIPTOR_INVALID (never INTERNAL) when `manifest`'s stored descriptor
   * fails today's rules: shared by every command that touches an existing
   * record's descriptor (the estimate and candidate commands, pick, archive)
   * so a tightened rule always answers the same way, never a generic
   * NOT_FOUND that hides the real, recoverable cause.
   */
  #assertDescriptorReadable(manifest: AvatarManifest): void {
    try {
      promptSubject({ age: manifest.age, text: manifest.descriptor });
    } catch (error) {
      if (!(error instanceof PromptSubjectError)) throw error;
      throw new EngineFailure({ code: "DESCRIPTOR_INVALID", detail: messageOf(error, "the stored descriptor fails today's rules") });
    }
  }

  /**
   * VALIDATION, before any spend, when there is nothing `avatars.rewriteDescriptor`
   * could do for `manifest`: its descriptor already fits today's rules
   * (nothing to fix), or it is not rewritable at all (records.ts's
   * `isRewritable`: untyped traits, a vibe that no longer parses, a name
   * over 60 chars, ...) — rewriting the descriptor alone would not recover
   * such a record, so estimating or paying for it would be a dead end.
   */
  #assertRewritable(avatarId: string, manifest: AvatarManifest): void {
    if (AvatarDescriptor.safeParse({ age: manifest.age, text: manifest.descriptor }).success) {
      throw new EngineFailure({ code: "VALIDATION", detail: `avatar ${avatarId}'s descriptor already fits today's rules; nothing to rewrite` });
    }
    if (!isRewritable(manifest)) {
      throw new EngineFailure({ code: "VALIDATION", detail: `avatar ${avatarId} cannot be rewritten: its record does not fit the contract beyond the descriptor` });
    }
  }

  /**
   * The paid recovery for `avatarId`'s stored descriptor: the same descriptor
   * job as createDraft, from its stored typed traits alone (manifest schema
   * version 2 only), under exactly createDraft's guard order — a usable key,
   * a ledger that allows paid calls, an open library, the id, whether there is
   * anything to fix, the accepted worst case and room in the month — then the
   * library's atomic manifest write. Its master photo, candidates and name
   * are never touched: only `descriptor` is patched.
   */
  async #rewriteDescriptor(payload: CommandPayload<"avatars.rewriteDescriptor">): Promise<{ avatarId: string }> {
    const key = this.#usableKey("rewrite an avatar's descriptor");
    const budget = this.#paidBudget();
    const library = this.#liveLibrary();
    const { avatarId } = payload;
    const manifest = this.#manifestOrNotFound(library, avatarId);
    this.#assertRewritable(avatarId, manifest);
    // isRewritable (inside #assertRewritable) already proved this parses; re-parsed here only to get its typed data.
    const traits = AvatarTraits.safeParse({ ...manifest.traits, age: manifest.age });
    if (!traits.success) throw new Error(`unreachable: isRewritable said avatar ${avatarId}'s traits parse`);
    const models = this.#avatarModels();
    const priced = await this.#prices.get(avatarPriceModels(models, "rewrite-descriptor"));
    const job = avatarJobEstimate(priced, models, "rewrite-descriptor");
    Engine.#checkAccepted(job.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, job.worstMicros);

    const jobId = this.#deps.newId();
    const scope: Scope = { avatarJobId: jobId };
    // The scope only ever sends descriptor attempts: its cap is theirs, just like createDraft's.
    this.#caps.set(scopeKey(scope), descriptorJobCap(priced, models));
    const client = this.#openRouter(key);
    const linesBefore = budget.ledger.lines.length;
    let result: Awaited<ReturnType<typeof runDescriptorJob>>;
    try {
      result = await runDescriptorJob(
        { chat: (params) => client.chat(params), budget, priceBook: priced.book },
        { jobId, scope, traits: traits.data, textModel: models.textModel },
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
    const updated = await library.updateAvatar(avatarId, { descriptor: descriptor.text }).catch(async (error: unknown) => {
      // The descriptor is paid for: keep it where the owner can find it, and say where.
      const kept = `${jobId}:rewrite`;
      const where = await saveRawBody(this.#rawDir, kept, JSON.stringify({ avatarId, descriptor })).then(
        () => `the paid descriptor is kept in raw/${rawFileName(kept)} next to the ledger`,
        (saveError: unknown) => `the paid descriptor could not be kept either (${messageOf(saveError, "unknown error")})`,
      );
      // Where it is kept comes first, so the 500-char cut of `detail` cannot drop it.
      throw new EngineFailure({ code: "INTERNAL", detail: detailOf(`${where}: the descriptor could not be written (${messageOf(error, "unknown error")})`) });
    });
    // The write already committed: isRewritable proved the record would fit
    // with a valid descriptor, and the one just written is valid (the
    // descriptor job never returns anything else), so this cannot fail in
    // normal operation. Defensively, though, a paid write that already
    // committed must never turn into INTERNAL over its own announcement.
    if (updated.status === "draft") this.#emitDraft(library, avatarId);
    else this.#announceAvatarOrLog(library, avatarId);
    return { avatarId };
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
    const library = this.#liveLibrary();
    const models = this.#avatarModels();
    const priced = await this.#prices.get(avatarPriceModels(models));
    const job = avatarJobEstimate(priced, models, "new-avatar");
    Engine.#checkAccepted(job.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, job.worstMicros);

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

  /**
   * Another batch of candidate portraits for a draft (the first one too:
   * createDraft buys only the descriptor). Checked before anything is spent,
   * in createDraft's order: a usable key, a ledger that allows paid calls, an
   * open library, a draft whose stored descriptor today's rules still accept
   * (DESCRIPTOR_INVALID otherwise), the worst case the user accepted and room
   * in the month, both for the batch. Then the job is registered under its own
   * scope, capped at the batch's worst case, and runs on after the answer.
   */
  async #generateCandidates(payload: CommandPayload<"avatars.generateCandidates">): Promise<{ jobId: string }> {
    const key = this.#usableKey("generate candidate portraits");
    const budget = this.#paidBudget();
    const library = this.#liveLibrary();
    const { avatarId } = payload;
    const manifest = library.getAvatar(avatarId);
    if (manifest === undefined || manifest.status !== "draft") throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${avatarId} in the open library` });
    this.#assertDescriptorReadable(manifest);
    const descriptor: AvatarDescriptor = { age: manifest.age, text: manifest.descriptor };
    if (this.#draft(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `the draft ${avatarId} does not fit the contract` });
    const models = this.#avatarModels();
    const priced = await this.#prices.get(avatarPriceModels(models));
    const batch = avatarJobEstimate(priced, models, "next-batch");
    Engine.#checkAccepted(batch.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, batch.worstMicros);

    const jobId = this.#deps.newId();
    const scope: Scope = { avatarJobId: jobId };
    const signal = this.#jobs.startCandidates(jobId, avatarId, CANDIDATES_PER_BATCH);
    // The scope sends exactly the batch's calls: its cap is their worst case, and it goes when the job ends.
    this.#caps.set(scopeKey(scope), batch.worstMicros);
    void this.#runCandidates({
      jobId,
      scope,
      avatarId,
      descriptor,
      key,
      budget,
      library,
      priceBook: priced.book,
      imageModel: models.imageModel,
      concurrency: this.#settings.concurrency.network,
      signal,
      done: 0,
    });
    return { jobId };
  }

  /**
   * Runs a registered candidate job to its end and announces it: money.changed,
   * then job.done, job.failed or job.cancelled. Its cap, its draft and the
   * library switch are released first, so a pick sent on job.done is taken.
   * Never rejects.
   */
  async #runCandidates(job: RunningCandidates): Promise<void> {
    let end: CandidatesJobEnd;
    try {
      const client = this.#openRouter(job.key);
      const outcomes = await runCandidateJob(
        {
          generateImage: (params) => client.generateImage(params),
          chat: (params) => client.chat(params),
          budget: job.budget,
          priceBook: job.priceBook,
          downscale: (bytes, signal) => downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal }),
          store: (bytes, meta) => job.library.addPhoto(job.avatarId, bytes, meta),
          errorOf: engineErrorFrom,
          onSlot: (outcome) => this.#candidateSlotDone(job, outcome),
        },
        { jobId: job.jobId, scope: job.scope, imageModel: job.imageModel, descriptor: job.descriptor, concurrency: job.concurrency, signal: job.signal },
      );
      end = candidateJobEnd(outcomes, job.signal.aborted);
    } catch (error) {
      end = { status: "failed", error: engineErrorFrom(error) };
    }
    this.#caps.delete(scopeKey(job.scope));
    this.#paidCommands--;
    this.#busyAvatars.delete(job.avatarId);
    try {
      this.#emitMoney();
      const state = this.#jobs.finish(job.jobId, end);
      const v = PROTOCOL_VERSION;
      if (state?.status === "done" && state.result !== undefined) {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: state.result } });
      } else if (end.status === "failed") {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.failed", payload: { jobId: job.jobId, error: end.error } });
      } else if (end.status === "cancelled") {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.cancelled", payload: { jobId: job.jobId } });
      }
    } catch (error) {
      console.error(`studio engine: the end of job ${job.jobId} could not be announced (${errorKind(error)})`);
    }
  }

  /** A slot that finished: a stored candidate changes the draft; every one moves the progress on. */
  #candidateSlotDone(job: RunningCandidates, outcome: SlotOutcome): void {
    try {
      if (outcome.kind === "failed" && outcome.error.code === "AUTH_INVALID") this.markKeyRejected(job.key);
      if (outcome.kind === "passed") this.#emitDraft(job.library, job.avatarId);
      const progress = this.#jobs.progress(job.jobId, ++job.done);
      if (progress !== null) this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.progress", payload: progress });
    } catch (error) {
      // The slot's money and photo are already recorded; only its announcement failed.
      console.error(`studio engine: a slot of job ${job.jobId} could not be announced (${errorKind(error)})`);
    }
  }

  #emitDraft(library: Library, avatarId: string): void {
    const manifest = library.getAvatar(avatarId);
    const stored = manifest === undefined ? null : draftFrom(manifest, library.photosByAvatar(avatarId));
    if (stored === null) return;
    const draft: Draft = { ...stored, estimate: this.#nextBatchAtKnownPrices() };
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "draft.changed", payload: { draft } });
  }

  /**
   * The user's pick: the draft becomes an active avatar with the candidate as
   * her master and the given name. The other candidates are other people from
   * the same descriptor, so they are deleted before the new manifest commits:
   * they must never become photos or references of her (invariant 9). A
   * manifest that cannot be written is found before any of them is gone; a
   * crash in between leaves a draft with fewer candidates, which can be
   * picked again. Only a candidate that passed the age check can be picked;
   * refused while a job runs for the draft.
   */
  async #pick(payload: CommandPayload<"avatars.pick">): Promise<{ avatar: AvatarSummary }> {
    const library = this.#liveLibrary();
    const { avatarId, photoId } = payload;
    this.#claimAvatar(avatarId, "a batch of candidates is being made for this draft; pick when it ends");
    try {
      const manifest = library.getAvatar(avatarId);
      if (manifest === undefined || manifest.status !== "draft") throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${avatarId} in the open library` });
      this.#assertDescriptorReadable(manifest);
      if (this.#draft(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `the draft ${avatarId} does not fit the contract` });
      const photo = library.getPhoto(photoId);
      if (photo === undefined || photo.avatarId !== avatarId || photo.qa.age?.adult !== true) {
        throw new EngineFailure({ code: "NOT_FOUND", detail: `draft ${avatarId} has no age-checked candidate ${photoId}` });
      }
      // The new manifest is written (not yet committed) before the other candidates go; see Library.promoteDraft.
      await library.promoteDraft(avatarId, { masterPhotoId: photo.id, name: payload.name.trim() });
      return { avatar: this.#announceAvatar(library, avatarId) };
    } finally {
      this.#busyAvatars.delete(avatarId);
    }
  }

  /** A saved avatar archived; one already archived is answered as it is. Refused while a job runs for it. */
  async #archive(payload: CommandPayload<"avatars.archive">): Promise<{ avatar: AvatarSummary }> {
    const library = this.#liveLibrary();
    const { avatarId } = payload;
    this.#claimAvatar(avatarId, "a job is changing this avatar; archive it when the job ends");
    try {
      const manifest = library.getAvatar(avatarId);
      if (manifest === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no saved avatar ${avatarId} in the open library` });
      if (manifest.status !== "draft") this.#assertDescriptorReadable(manifest);
      const current = avatarSummaryFrom(manifest, library.photoCount(avatarId));
      if (current === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no saved avatar ${avatarId} in the open library` });
      if (current.status === "archived") return { avatar: current };
      await library.updateAvatar(avatarId, { status: "archived" });
      return { avatar: this.#announceAvatar(library, avatarId) };
    } finally {
      this.#busyAvatars.delete(avatarId);
    }
  }

  /** The saved avatar as the grid lists it, announced with avatar.changed. */
  #announceAvatar(library: Library, avatarId: string): AvatarSummary {
    const manifest = library.getAvatar(avatarId);
    const avatar = manifest === undefined ? null : avatarSummaryFrom(manifest, library.photoCount(avatarId));
    if (avatar === null) throw new Error(`the saved avatar ${avatarId} does not fit the contract`);
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "avatar.changed", payload: { avatar } });
    return avatar;
  }

  /**
   * `#announceAvatar`, but never throws: a write that already committed must
   * not turn into INTERNAL over its own announcement. A failure here is
   * logged (never by the record's content) and the caller answers ok
   * regardless — the write stands; only the live announce was missed, and
   * the next snapshot or avatars.list still shows the true state.
   */
  #announceAvatarOrLog(library: Library, avatarId: string): void {
    try {
      this.#announceAvatar(library, avatarId);
    } catch (error) {
      console.error(`studio engine: avatar ${avatarId} was written but could not be announced (${errorKind(error)})`);
    }
  }

  /** Marks an avatar as being changed; IN_FLIGHT when a job or command already is. */
  #claimAvatar(avatarId: string, detail: string): void {
    if (this.#busyAvatars.has(avatarId)) throw new EngineFailure({ code: "IN_FLIGHT", detail });
    this.#busyAvatars.add(avatarId);
  }

  /**
   * The live library, for a command that stores into it. Every write path
   * (createDraft, generateCandidates, pick, archive) reaches the library
   * only through here, so gating this one place is enough to refuse all of
   * them with IN_FLIGHT while a folder survey (`#switching`) could still
   * replace the instance they would write into.
   */
  #liveLibrary(): Library {
    if (this.#switching > 0) {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: "a library switch is being surveyed; write commands wait for it to finish" });
    }
    const library = this.library;
    if (library === null) {
      throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    }
    return library;
  }

  /** PRICE_CHANGED when the worst case now is above the one the user accepted. */
  static #checkAccepted(worstMicros: number, acceptedWorstMicros: number): void {
    if (worstMicros > acceptedWorstMicros) {
      throw new EngineFailure({ code: "PRICE_CHANGED", detail: `the worst case is now ${worstMicros} µ$, above the accepted ${acceptedWorstMicros} µ$` });
    }
  }

  /** BUDGET_EXCEEDED when the month has no room for the job's worst case on top of what is spent, reserved and held by running jobs. */
  static #checkMonthlyRoom(budget: Budget, worstMicros: number): void {
    const month = budget.status();
    const committed = month.spentThisMonthMicros + month.openReserveMicros + month.heldMicros;
    if (committed + worstMicros > month.monthlyBudgetMicros) {
      const detail = `committed ${committed} µ$ + this job's worst case ${worstMicros} µ$ > the monthly budget ${month.monthlyBudgetMicros} µ$`;
      throw new EngineFailure({ code: "BUDGET_EXCEEDED", detail });
    }
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
   * budget goes to the Budget — every field but `libraryPath`, applied
   * immediately (before any await), so they still land even when the switch
   * below is refused or superseded. The library follows the saved folder:
   * when it is not the live library's folder (or there is none), the engine
   * takes the one staged by `library.open` (by the exact path string) or,
   * failing that, opens it now — so a folder picked again after it was
   * missing at start is taken too, and a volume remounted under the same
   * path (a new folder identity) is surveyed fresh. Staged folders that no
   * update confirmed are dropped: main gave up on them.
   *
   * `libraryPath` itself is committed together with `#live`, only at the very
   * end, once every await below is done: until then `#settings.libraryPath`
   * (so `settings.get` and the snapshot) keeps naming the folder `#live`
   * actually is, never a folder its avatar and draft lists do not match yet.
   *
   * A genuine switch surveys the folder before committing (`#openOrNull`, or
   * a staged instance reused as-is): while that survey runs, `#switching` is
   * set, so `#liveLibrary()` refuses new paid work, pick and archive with
   * IN_FLIGHT — the very thing that used to be able to write through the
   * library instance this call is about to replace. The switch is still
   * refused with IN_FLIGHT when the engine was already busy before the
   * survey, or became busy during it in a way `#switching` cannot see (a
   * reserve made straight against the Budget, bypassing `#liveLibrary()`):
   * `libraryPath` then simply never advances, which is its own rollback, and
   * a freshly opened library is dropped rather than adopted. A later call to
   * this method that started after this one (two `settings.update`s racing;
   * `#pendingLibraryPath` set at the top of each tracks whichever started
   * last) also wins outright: this call's result — a switch or a
   * same-folder no-op — is discarded rather than half-applied on top of the
   * later call's. `library.confirm` never calls this method at all (it is
   * fully synchronous, staged-only), so it cannot be superseded this way.
   *
   * Returns an error when the switch (or the no-op commit) was not applied,
   * for any reason above, or null when everything applied, including any
   * switch.
   */
  async #applySettings(next: EngineSettings): Promise<EngineError | null> {
    const previous = this.#settings;
    this.#pendingLibraryPath = next.libraryPath;
    this.#settings = { ...next, libraryPath: previous.libraryPath };
    const staged = this.#staged;
    this.#staged = new Map();
    if (this.#money.ok && next.monthlyBudgetMicros !== previous.monthlyBudgetMicros) {
      await this.#money.budget.setMonthlyBudget(next.monthlyBudgetMicros);
    }
    const identity = await folderIdentity(next.libraryPath, this.#folderFs);
    // Nothing asked to move away from the folder already live (this update
    // names the same path as before): a folder that cannot be identified
    // right now is then a transient hiccup (a volume briefly unreadable), not
    // a request to drop the library. Keep it, rather than flipping to
    // LIBRARY_UNAVAILABLE and losing it over a momentary stat() failure.
    const keepLive = identity === null && this.#live !== null && next.libraryPath === previous.libraryPath;
    const sameLibrary = keepLive || (identity !== null && identity === this.#live?.identity);
    let refusal: EngineError | null = null;
    let live = this.#live;
    let switched = false;
    if (!sameLibrary) {
      if (this.#busy()) {
        refusal = this.#inFlightRefusal();
      } else {
        // #switching blocks new paid work, pick and archive (#liveLibrary())
        // for the whole survey below, not only the busy check just made:
        // #busy() alone cannot see work that starts during the await.
        this.#switching++;
        try {
          const kept = identity === null ? undefined : staged.get(next.libraryPath);
          const opened =
            kept !== undefined && identity !== null
              ? { library: kept.library, identity, unreadable: kept.unreadable }
              : await this.#openOrNull(next.libraryPath);
          // Re-checked: a reserve made straight against the Budget (e.g. a
          // job attempt already past its own #liveLibrary() call when the
          // survey started) is not stopped by #switching; #busy() still
          // catches it. The freshly opened library is dropped, not adopted.
          if (this.#busy()) {
            refusal = this.#inFlightRefusal();
          } else {
            live = opened;
            switched = true;
          }
        } finally {
          this.#switching--;
        }
      }
    }
    // A later call named another folder while this one awaited: that call's
    // result stands, whole; this one's is dropped, not layered on top of it.
    if (refusal === null && this.#pendingLibraryPath !== next.libraryPath) {
      refusal = { code: "INTERNAL", detail: "a later settings update named another library folder before this one could switch" };
    } else if (refusal === null) {
      if (switched) {
        // Every open window must resync on a genuine switch, folder-to-folder
        // or into/out of LIBRARY_UNAVAILABLE; a race that changes nothing
        // (kept the same folder after all) must not bump it.
        const beforeIdentity = this.#live?.identity ?? null;
        if ((live?.identity ?? null) !== beforeIdentity) this.#librarySwitchGeneration++;
        this.#live = live;
      }
      this.#settings = { ...this.#settings, libraryPath: next.libraryPath };
    }
    this.#emitSettings();
    return refusal;
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
    if (pending !== undefined) {
      const opened = await pending;
      return { library: opened.library, identity, unreadable: opened.unreadable };
    }
    const opening = openLibrary(path).then((opened) => ({ library: opened.library, unreadable: unreadableFromQuarantine(opened.report.quarantined) }));
    this.#opening.set(identity, opening);
    try {
      const opened = await opening;
      return { library: opened.library, identity, unreadable: opened.unreadable };
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
    // A paid job between its requests has none in flight, but its next reserve would land in the window being reconciled.
    if (this.#paidCommands > 0) {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: `${this.#paidCommands} paid job(s) of this engine are running; reconcile when they end` });
    }
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
      saveRaw: (attemptId, text, keepBytes) => saveRawBody(this.#rawDir, attemptId, text, { keepBytes }),
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
    this.#emit({
      v: PROTOCOL_VERSION,
      id: this.#deps.newId(),
      kind: "event",
      type: "settings.changed",
      payload: { settings: this.#currentSettings(), librarySwitchGeneration: this.#librarySwitchGeneration },
    });
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
