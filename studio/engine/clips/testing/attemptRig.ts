import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOLD_CLIPS, clipWorstMicros, type BoldClipsMode, type ClipModelChoice, type ClipPrices, type ClipQuality, type ClipSeconds } from "../../../shared/engine/clips";
import { Budget, type ReserveHandle } from "../../money/budget";
import { Ledger, type LedgerLine, type Scope } from "../../money/ledger";
import { VIDEO_TIERS } from "../../money/prices";
import type { GenerationResult, OpenRouterClient, VideoPollResult, VideoRequest, VideoSubmitResult } from "../../openrouter/types";
import { awaitLateClip, runClip, type ClipPhaseEvent, type ClipRunDeps, type ClipRunInput, type ClipRunResult, type LateAttempt } from "../attempt";
import { createClipHolds, type HoldTimers } from "../holds";
import { clipAttemptId } from "../journal";
import type { ClipJournalLine } from "../schemas";
import { REAL_CLIP_TIMINGS, type ClipTimings } from "../timings";

// Test-only (S5.V3b): a world for the clip money state machine. Time is a number the test owns: `sleep` moves it, and scheduled actions run when it passes them. The OpenRouter client is a
// script (what a POST answers, when a job turns terminal, what /generation and /credits say at each moment), the ledger and the budget are the real ones, and every call is logged with its time
// so a test can say «no /generation read before +15 s», «one POST», «the reserve of Grok came after the settle of Kling».

export const CLIP_ID = "clip-00001";
export const KLING = clipAttemptId(CLIP_ID, 1);
export const GROK = clipAttemptId(CLIP_ID, 2);
export const T0 = Date.parse("2026-10-13T12:00:00.000Z");
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

/** The 2026-10-10 listing: Kling std 84 000 µ$/s, pro 112 000, Grok 140 000 + 10 000 for the image. Reserves: std 5 s 504 000, Grok 5 s 850 000. */
export const PRICES: ClipPrices = {
  std: { perSecondMicros: 84_000, perInputImageMicros: 0 },
  pro: { perSecondMicros: 112_000, perInputImageMicros: 0 },
  grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 },
};

export type TerminalScript =
  | { status: "completed"; usageCostMicros: number | null }
  | { status: "failed" | "cancelled" | "expired"; error: string | null; contentFailure: boolean };

export interface JobScript {
  /** What `POST /videos` answers. Default: accepted. `"throw"` makes the client throw (it never should; the state machine must still not resend). */
  submit?: VideoSubmitResult | "throw";
  /** Ms after the POST at which the job turns terminal, or `"never"`. Default 60 s. */
  terminalAfterMs?: number | "never";
  /** Default: a completed job with `usage.cost` 420 000. */
  terminal?: TerminalScript;
  /** What `/generation` says, by ms since the job's real terminal moment. Default: the API's 404. */
  generation?: (sinceTerminalMs: number, t: number) => GenerationResult;
  /** Polls answer `unreadable` until this many ms after the POST. */
  pollUnreadableUntilMs?: number;
  /** The `generation_id` the poll reports. Default: the job's own id (I5.47); `null` is a body without one. */
  generationId?: string | null;
}

export const REFUSED_BY_RISK_CONTROL: TerminalScript = { status: "failed", error: "task failed with status: FAIL, message: Failure to pass the risk control system", contentFailure: true };
export const PROVIDER_FAILED: TerminalScript = { status: "failed", error: "internal error", contentFailure: false };

export const gen404 = (): GenerationResult => ({ kind: "not-found" });
export const genFound = (micros: number): GenerationResult => ({ kind: "found", totalCostMicros: micros, finishReason: null });
export const genUnreadable = (): GenerationResult => ({ kind: "unreadable", cause: "timeout", httpStatus: null, detail: "no answer" });
/** Probe P-V: a 404 right after `completed`, the record from +15 s. */
export const genFromAfter = (afterMs: number, micros: number) => (since: number): GenerationResult => (since < afterMs ? gen404() : genFound(micros));

export interface RigOptions {
  mode?: "auto" | "offer";
  boldClips?: BoldClipsMode;
  kling?: JobScript;
  grok?: JobScript;
  /** `/credits` `total_usage` in µ$ by time and the times the POSTs left. Default: a constant. */
  usage?: (t: number, posts: Readonly<Record<"kling" | "grok", number | undefined>>) => number | "throw";
  timings?: ClipTimings;
  monthlyBudgetMicros?: number;
  /** Lines already in the ledger file (an earlier process, a photo run). */
  ledgerLines?: LedgerLine[];
}

export type Call =
  | { type: "post"; model: "kling" | "grok"; t: number }
  | { type: "poll"; model: "kling" | "grok"; t: number }
  | { type: "generation"; model: "kling" | "grok"; t: number; sinceTerminal: number; klingClosed: boolean }
  | { type: "credits"; t: number };

export interface Rig {
  readonly deps: ClipRunDeps;
  readonly budget: Budget;
  readonly ledger: Ledger;
  readonly ledgerPath: string;
  readonly holds: ReturnType<typeof createClipHolds>;
  readonly signal: AbortSignal;
  /** Every call to the fake API, with its time. */
  readonly calls: Call[];
  /** Calls, journal lines, ledger writes and phases in the order they happened. */
  readonly trace: string[];
  readonly journalLines: ClipJournalLine[];
  readonly phases: ClipPhaseEvent[];
  /** Holds' changes. */
  readonly holdChanges: () => number;
  /** Add `"submitted"` to make the journal throw on that write (I5.45: a throw between the 2xx and the fsync). */
  readonly failJournalOn: Set<"submitted">;
  t: number;
  /** Runs `fn` when time passes `atMs` (absolute), inside `sleep`. */
  at(atMs: number, fn: () => void | Promise<void>): void;
  abort(): void;
  input(overrides?: Partial<ClipRunInput>): ClipRunInput;
  run(overrides?: Partial<ClipRunInput>): Promise<ClipRunResult>;
  late(late: LateAttempt) : ReturnType<typeof awaitLateClip>;
  posts(model?: "kling" | "grok"): Call[];
  generationReads(model?: "kling" | "grok"): Extract<Call, { type: "generation" }>[];
  settles(attemptId?: string): Extract<LedgerLine, { type: "settle" }>[];
  reserves(): Extract<LedgerLine, { type: "reserve" }>[];
  /** Another scope's work (a photo run) in the ledger: reserve then settle. */
  photoRun(runId: string, costMicros: number): Promise<void>;
  /** The clip's own reserves and settles, `[type, attemptId, micros]`. */
  clipLedger(): [string, string, number][];
  dispose(): Promise<void>;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

class FakeHoldTimers implements HoldTimers {
  private nextId = 1;
  readonly pending = new Map<number, { due: number; fn: () => void }>();
  constructor(private readonly clock: () => number) {}

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { due: this.clock() + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.pending.delete(handle);
  }

  fireDue(t: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.due <= t) {
        this.pending.delete(id);
        timer.fn();
      }
    }
  }
}

const modelOf = (modelId: string): "kling" | "grok" => (modelId === VIDEO_TIERS.grok.model ? "grok" : "kling");
const keyOf = (id: string): "kling" | "grok" => (id === "job-grok" ? "grok" : "kling");

export async function createRig(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "studio-attempt-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  if (options.ledgerLines !== undefined) await Bun.write(ledgerPath, options.ledgerLines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const timings = options.timings ?? REAL_CLIP_TIMINGS;

  const state = { t: T0, clipCap: 0, aborted: new AbortController() };
  const scheduled: { at: number; fn: () => void | Promise<void> }[] = [];
  const calls: Call[] = [];
  const trace: string[] = [];
  const journalLines: ClipJournalLine[] = [];
  const phases: ClipPhaseEvent[] = [];
  const postAt: Record<"kling" | "grok", number | undefined> = { kling: undefined, grok: undefined };
  const scripts: Record<"kling" | "grok", JobScript> = { kling: options.kling ?? {}, grok: options.grok ?? {} };
  let holdChanges = 0;

  const ledger = await Ledger.open(ledgerPath);
  const real = new Budget(ledger, {
    runCapMicros: (scope: Scope) => ("avatarJobId" in scope ? state.clipCap : 50_000_000),
    monthlyBudgetMicros: options.monthlyBudgetMicros ?? 50_000_000,
    clock: () => state.t,
    monotonic: () => state.t,
  });
  // The same budget, logged: the order of a reserve, a settle and an abandon against the API's calls is what the tests assert.
  const budget = {
    ledger,
    async tryReserve(req: Parameters<Budget["tryReserve"]>[0]) {
      const result = await real.tryReserve(req);
      trace.push(`ledger:reserve:${req.attemptId}:${result.ok ? "ok" : result.reason}`);
      return result;
    },
    async settle(handle: ReserveHandle, bill: { costMicros: number; estimated: boolean }) {
      trace.push(`ledger:settle:${handle.attemptId}:${bill.costMicros}:${bill.estimated ? "estimated" : "exact"}`);
      return real.settle(handle, bill);
    },
    async release(handle: ReserveHandle, reason: string) {
      trace.push(`ledger:release:${handle.attemptId}`);
      return real.release(handle, reason);
    },
    async abandon(handle: ReserveHandle) {
      trace.push(`ledger:abandon:${handle.attemptId}`);
      return real.abandon(handle);
    },
  } as unknown as Budget;

  const holdTimers = new FakeHoldTimers(() => state.t);
  const holds = createClipHolds({ now: () => state.t, timers: holdTimers, onChange: () => void holdChanges++ });

  const terminalAtOf = (key: "kling" | "grok"): number | null => {
    const post = postAt[key];
    const after = scripts[key].terminalAfterMs ?? 60 * SECOND;
    return post === undefined || after === "never" ? null : post + after;
  };

  const client: Pick<OpenRouterClient, "submitVideo" | "pollVideo" | "fetchGeneration" | "fetchCredits"> = {
    async submitVideo(request: VideoRequest) {
      const key = modelOf(request.model);
      postAt[key] = state.t;
      calls.push({ type: "post", model: key, t: state.t });
      trace.push(`post:${key}`);
      const script = scripts[key].submit;
      if (script === "throw") throw new Error("the client threw");
      return script ?? ({ kind: "accepted", id: `job-${key}` } satisfies VideoSubmitResult);
    },
    async pollVideo(id: string): Promise<VideoPollResult> {
      const key = keyOf(id);
      calls.push({ type: "poll", model: key, t: state.t });
      trace.push(`poll:${key}`);
      const post = postAt[key];
      const script = scripts[key];
      if (post !== undefined && script.pollUnreadableUntilMs !== undefined && state.t - post < script.pollUnreadableUntilMs) {
        return { kind: "unreadable", cause: "timeout", httpStatus: null, detail: "no answer" };
      }
      const generationId = script.generationId === undefined ? id : script.generationId;
      const terminalAt = terminalAtOf(key);
      if (terminalAt === null || state.t < terminalAt) {
        return { kind: "status", status: "in_progress", rawStatus: "in_progress", usageCostMicros: null, error: null, contentFailure: false, generationId };
      }
      const terminal = script.terminal ?? { status: "completed", usageCostMicros: 420_000 };
      if (terminal.status === "completed") {
        return { kind: "status", status: "completed", rawStatus: "completed", usageCostMicros: terminal.usageCostMicros, error: null, contentFailure: false, generationId };
      }
      return { kind: "status", status: terminal.status, rawStatus: terminal.status, usageCostMicros: null, error: terminal.error, contentFailure: terminal.contentFailure, generationId };
    },
    async fetchGeneration(id: string): Promise<GenerationResult> {
      const key = keyOf(id);
      const terminalAt = terminalAtOf(key) ?? state.t;
      const since = state.t - terminalAt;
      calls.push({ type: "generation", model: key, t: state.t, sinceTerminal: since, klingClosed: ledger.closeOf(KLING) !== undefined });
      trace.push(`generation:${key}@+${since}`);
      return (scripts[key].generation ?? gen404)(since, state.t);
    },
    async fetchCredits() {
      calls.push({ type: "credits", t: state.t });
      trace.push("credits");
      const usage = options.usage?.(state.t, postAt) ?? 5_000_000;
      if (usage === "throw") throw new Error("credits unreachable");
      return { data: { total_credits: 100, total_usage: usage / 1_000_000 } };
    },
  };

  const failJournalOn = new Set<"submitted">();
  const journal: ClipRunDeps["journal"] = {
    async requested(data) {
      trace.push("journal:requested");
      journalLines.push({ type: "requested", ...data });
    },
    async submitted(data) {
      trace.push(`journal:submitted:${data.attemptId}`);
      if (failJournalOn.has("submitted")) throw new Error("disk full");
      journalLines.push({ type: "submitted", ...data });
    },
    async ended(data) {
      trace.push(`journal:ended:${data.attemptId}:${data.status}`);
      journalLines.push({ type: "ended", ...data });
    },
  };
  async function advance(ms: number): Promise<void> {
    const target = state.t + Math.max(0, ms);
    for (;;) {
      const next = scheduled.filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      scheduled.splice(scheduled.indexOf(next), 1);
      state.t = Math.max(state.t, next.at);
      await next.fn();
    }
    state.t = target;
    holdTimers.fireDue(state.t);
  }

  const deps: ClipRunDeps = {
    budget,
    client,
    journal,
    holds,
    timings,
    now: () => state.t,
    sleep: (ms) => advance(ms),
    onPhase: (event) => {
      phases.push(event);
      trace.push(`phase:${event.phase}:${event.model}`);
    },
  };

  const request = (model: ClipModelChoice, quality: ClipQuality, seconds: ClipSeconds): ClipRunInput["request"] => ({ model, quality, seconds, fallback: "auto" });

  function input(overrides: Partial<ClipRunInput> = {}): ClipRunInput {
    const base: ClipRunInput = {
      clipId: CLIP_ID,
      photoId: "photo-00001",
      request: request("kling", "std", 5),
      motion: { source: "code", label: "Улыбка", text: "she smiles slowly" },
      acceptedWorstMicros: 0,
      bold: false,
      prices: PRICES,
      mode: options.mode ?? "auto",
      boldClips: options.boldClips ?? BOLD_CLIPS,
      buildRequest: (plan) => ({
        model: plan.modelId,
        prompt: "a prompt",
        duration: plan.seconds,
        resolution: plan.resolution,
        aspect_ratio: "9:16",
        generate_audio: false,
        frame_images: [],
      }),
    };
    const merged = { ...base, ...overrides };
    // The accepted worst is the one the sheet showed, from the shared formula; a test may override it.
    const accepted =
      overrides.acceptedWorstMicros ??
      clipWorstMicros({
        model: merged.request.model,
        quality: merged.request.quality,
        seconds: merged.request.seconds,
        mode: merged.mode ?? "auto",
        fallback: merged.request.fallback,
        bold: merged.bold,
        boldClips: merged.boldClips ?? BOLD_CLIPS,
        prices: merged.prices,
      });
    state.clipCap = accepted;
    return { ...merged, acceptedWorstMicros: accepted };
  }

  const ledgerLinesOf = (): readonly LedgerLine[] => ledger.lines;

  return {
    deps,
    budget: real,
    ledger,
    ledgerPath,
    holds,
    get signal() {
      return state.aborted.signal;
    },
    calls,
    trace,
    journalLines,
    phases,
    holdChanges: () => holdChanges,
    get t() {
      return state.t;
    },
    set t(value: number) {
      state.t = value;
    },
    at: (atMs, fn) => void scheduled.push({ at: atMs, fn }),
    abort: () => state.aborted.abort(),
    input,
    run: (overrides) => runClip(deps, input(overrides), state.aborted.signal),
    late: (late) => awaitLateClip(deps, late, state.aborted.signal),
    posts: (model) => calls.filter((c) => c.type === "post" && (model === undefined || c.model === model)),
    generationReads: (model) => calls.filter((c): c is Extract<Call, { type: "generation" }> => c.type === "generation" && (model === undefined || c.model === model)),
    settles: (attemptId) => ledgerLinesOf().filter((l): l is Extract<LedgerLine, { type: "settle" }> => l.type === "settle" && (attemptId === undefined || l.attemptId === attemptId)),
    reserves: () => ledgerLinesOf().filter((l): l is Extract<LedgerLine, { type: "reserve" }> => l.type === "reserve"),
    async photoRun(runId, costMicros) {
      const attemptId = `${runId}:img#1`;
      const reserved = await real.tryReserve({ attemptId, jobId: runId, scope: { runId }, model: "x-ai/grok-imagine-image", worstMicros: costMicros });
      if (!reserved.ok) throw new Error(`the photo run's reserve was refused: ${reserved.reason}`);
      await real.settle(reserved.handle, { costMicros, estimated: false });
    },
    clipLedger: () =>
      ledgerLinesOf().flatMap((l): [string, string, number][] => {
        if (l.type === "reserve" && l.attemptId.startsWith(CLIP_ID)) return [["reserve", l.attemptId, l.worstMicros]];
        if (l.type === "settle" && l.attemptId.startsWith(CLIP_ID)) return [[l.estimated ? "settle-estimated" : "settle", l.attemptId, l.costMicros]];
        return [];
      }),
    async dispose() {
      holds.clear();
      await rm(dir, { recursive: true, force: true });
    },
    failJournalOn,
  };
}

/** The ledger lines of a clip as `[kind, attemptId, micros]`, for readable assertions. */
export function rows(rig: Rig): [string, string, number][] {
  return rig.clipLedger();
}
