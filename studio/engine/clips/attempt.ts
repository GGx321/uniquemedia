import { z } from "zod";
import {
  BOLD_CLIPS,
  GROK_FALLBACK,
  clipAllowsAutoGrok,
  clipReserveMicros,
  type BoldClipsMode,
  type ClipAttemptModel,
  type ClipFailReason,
  type ClipMotion,
  type ClipPrices,
  type ClipRequest,
  type ClipSeconds,
} from "../../shared/engine/clips";
import type { Budget, ReserveHandle, ReserveRefusal } from "../money/budget";
import { MoneyError } from "../money/errors";
import { VIDEO_TIERS, type VideoResolution, type VideoTier } from "../money/prices";
import { costToMicros } from "../money/settleRule";
import { isContentFailure } from "../openrouter/video";
import type { FailureKind, GenerationResult, OpenRouterClient, VideoPollResult, VideoRequest } from "../openrouter/types";
import { holdUntilForReserve, holdUntilForSubmitted, holdUntilForTerminal, type ClipHolds } from "./holds";
import { clipAttemptId, type ClipJournal } from "./journal";
import type { ClipAttemptOutcome, ClipCostSource } from "./schemas";
import { PROOF_READ_TRIES, type ClipTimings } from "./timings";

// Stage 5, 5b.1, S5.V3b (plan s5b1 §5.7, §5.8, I5.44-I5.48): the clip's MONEY STATE MACHINE. Pure over injected deps (the budget, the journal, the HTTP client, the holds, a clock and a sleep), so a test plays
// a whole clip, the two-minute proof included, in no real time. It owns one rule above all: the POST of an attempt leaves AT MOST ONCE. A timeout, a network error, a 5xx or a throw after the 2xx means the
// job MAY exist and MAY bill, so the reserve stays open at worst (`abandon`) and the reconcile hold keeps the engine from trusting `/credits` until it is safe; nothing is resent.
//
// Per attempt, in this order (I5.45): `requested` is fsynced once per clip, before the first reserve → the request body is built → RESERVE (right before the POST, from the clip's own price book) → a hold on the
// reserve → the net-usage BASELINE (a `/credits` read, before the POST) → POST → `submitted` fsynced before the first poll → poll every 20 s → settle, or abandon at 20 min (phase `late`).
//
// THE SETTLE TABLE (§5.7, mode × outcome → settle source → next). One test per cell lives in attempt.table.test.ts, in this row order:
//   1  completed with usage.cost                  → usage.cost                                        → download
//   2  completed without usage                    → /generation total_cost; none readable → WORST      → download
//   3  4xx moderation at the submit               → 0 (no job exists)                                  → a content refusal settled 0 (below)
//   4  401 / 402 / 429 / another 4xx at the submit → 0                                                  → key-invalid / no-credits / rate-limited / bad-request
//   5  5xx, timeout, network at the submit        → abandon (open at worst, held 20 min)               → submit-uncertain
//   6  a throw between the 2xx and `submitted`    → abandon (the same; held 20 min from the reserve)   → submit-uncertain
//   7  poll-time content refusal, 404/0 twice     → auto: 0 unless the net-usage check counted and rose; offer: 0 ONLY when the check counted and ran clean, else WORST
//                                                                                                       → Grok (auto) · the offer (offer) · refused-free (fallback none, «Смелая», a Grok clip)
//   8  … the net-usage check rose                 → WORST                                              → refused-unknown
//   9  … any /generation read > 0                 → that total_cost                                    → refused-paid
//   10 … unreadable after 3 reads                 → WORST                                              → refused-unknown
//   11 poll-time non-content failure              → the same proof as 7-10                             → provider-error, never Grok, never the offer
//   12 no terminal status 20 min after the submit → abandon, phase `late`                              → a late completed: download, NO ledger line; else failed `late`
// «The proof» is I5.47's: `/generation` is read ≥ 15 s and again ≥ 2 min after the terminal poll (probe P-V: a 404 RIGHT AFTER `completed` is still a billed job, so one early 404 proves nothing), and a
// net-usage check compares a `/credits` baseline read BEFORE the POST with a read made together with the second `/generation` read; it COUNTS only if the ledger holds no line of anything else between the two.
// Kling's reserve stays open at worst for the whole window, and Grok is reserved only after Kling settled 0, so a late bill can never push the clip over its accepted worst.

// ---------- the contract of the run ----------

export interface ClipPhaseEvent {
  phase: "submitting" | "rendering" | "proving" | "late";
  model: ClipAttemptModel;
  /** `rendering` and `late`: when the POST was accepted. */
  submittedAt?: string;
  /** `proving`: the end of the proof window (the second read), for the tile's «до 2 мин». */
  proveUntil?: string;
  /** `proving`: the failure is a content refusal (the tile says «Kling отказал»), not another failure. */
  content?: boolean;
}

export interface ClipRunDeps {
  /** The engine's budget. `release` is never used: a reserve is settled or abandoned, because once the request body is built the POST may leave. */
  readonly budget: Pick<Budget, "tryReserve" | "settle" | "abandon" | "release" | "ledger">;
  readonly client: Pick<OpenRouterClient, "submitVideo" | "pollVideo" | "fetchGeneration" | "fetchCredits">;
  readonly journal: Pick<ClipJournal, "requested" | "submitted" | "ended">;
  readonly holds: Pick<ClipHolds, "hold" | "release">;
  readonly timings: ClipTimings;
  /** Epoch ms. */
  readonly now: () => number;
  /** Resolves after `ms`, or earlier when `signal` aborts (it does not reject): callers read `signal.aborted` afterwards. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onPhase?: (event: ClipPhaseEvent) => void;
}

/** What `buildRequest` is told about the attempt it builds a body for. */
export interface AttemptPlan {
  n: 1 | 2;
  attemptId: string;
  model: ClipAttemptModel;
  tier: VideoTier;
  modelId: string;
  resolution: VideoResolution;
  seconds: ClipSeconds;
  reserveMicros: number;
}

export interface ClipRunInput {
  clipId: string;
  photoId: string;
  request: ClipRequest;
  motion: ClipMotion;
  /** What the owner accepted on the sheet (`clipWorstMicros`): journaled, and the bound every reserve of the clip lives inside. */
  acceptedWorstMicros: number;
  /** A frame of «Смелая» (I5.57). */
  bold: boolean;
  /** The clip's own price book, read once at `clips.create` (I5.46). Copied at the start: nothing that changes later reaches a reserve. */
  prices: ClipPrices;
  /** The engine's mode (`GROK_FALLBACK`). */
  mode?: "auto" | "offer";
  /** `BOLD_CLIPS`. */
  boldClips?: BoldClipsMode;
  /** Builds the POST body of one attempt (first frame, prompt, model, resolution). Called before the attempt's reserve, so a body that cannot be built reserves nothing. */
  buildRequest(plan: AttemptPlan): VideoRequest | Promise<VideoRequest>;
}

/** How a failed clip was billed, for its tile: nothing, a number the provider gave, or the worst case. */
export type CostKind = "free" | "billed" | "worst";
/** Why a refusal's cost is unknown (settled at worst). */
/** `id-mismatch`: the poll's generation_id is not the job id (or is missing), so /generation cannot be trusted to be this job's record (I5.47). */
export type UnknownWhy = "net-increase" | "unreadable" | "net-uncounted" | "id-mismatch";

/** One attempt as the clip's record keeps it. */
export interface AttemptSummary {
  attemptId: string;
  model: ClipAttemptModel;
  providerJobId?: string;
  outcome: ClipAttemptOutcome;
  providerCostMicros?: number;
  costSource: ClipCostSource;
}

/** An attempt that outlived its 20 min: abandoned, still polled for its file (`awaitLateClip`). */
export interface LateAttempt {
  attemptId: string;
  model: ClipAttemptModel;
  providerJobId: string;
  submittedAtMs: number;
  giveUpAtMs: number;
}

export type ClipRunResult =
  | {
      kind: "completed";
      attempts: AttemptSummary[];
      attemptId: string;
      model: ClipAttemptModel;
      providerJobId: string;
      /** The provider's own number for the clip, or null when none could be read (the ledger then holds the worst case). */
      providerCostMicros: number | null;
      costSource: ClipCostSource;
      /** Grok made it, behind a Kling that was refused for free. */
      fallbackUsed: boolean;
      /** The bill was above the reserve: the existing halt, already recorded in the ledger. The clip is still delivered. */
      aboveWorst: MoneyError | null;
    }
  | {
      kind: "failed";
      reason: ClipFailReason;
      attempts: AttemptSummary[];
      /** The model of the attempt that ended the clip. */
      model: ClipAttemptModel;
      cost: CostKind;
      unknownWhy?: UnknownWhy;
      /** Mode `offer`: the failed tile offers «Снять на Grok» (a content refusal proven free, on a photo that allows a fallback). */
      grokOffer: boolean;
      detail?: string;
      aboveWorst: MoneyError | null;
    }
  | { kind: "late"; attempts: AttemptSummary[]; late: LateAttempt }
  /**
   * The reserve was refused (month, cap, RECONCILE_REQUIRED, HALTED) before anything was sent: free. `afterFreeRefusal`: this was Grok's reserve behind a Kling that was refused and settled 0, and the refusal is
   * NOT the month or the cap (those end the clip `grok-no-room`): the caller says why Grok could not run.
   */
  | { kind: "not-reserved"; refusal: ReserveRefusal; afterFreeRefusal: boolean; attempts: AttemptSummary[] }
  /** The signal fired before the POST left: nothing was sent, the reserve (if any) was released, nothing is open. */
  | { kind: "cancelled"; attempts: AttemptSummary[] }
  /** The signal fired (the engine is shutting down): the reserve stays open at worst, nothing is settled by a guess. */
  | { kind: "interrupted"; attempts: AttemptSummary[] };

export type LateResult = { kind: "completed"; providerCostMicros: number | null } | { kind: "failed"; reason: "late" } | { kind: "interrupted" };

// ---------- the fallback rules ----------

/**
 * Whether the failed tile of a content refusal proven free offers «Снять на Grok» (mode `offer`, I5.47): the sheet did not forbid a second model, the clip is a Kling clip, and the frame is not one of
 * «Смелая» kept to Kling. Never in mode `auto` (it runs Grok by itself instead: `clipAllowsAutoGrok`).
 */
export function clipAllowsGrokOffer(parts: { model: ClipAttemptModel; mode: "auto" | "offer"; fallback: "auto" | "none"; bold: boolean; boldClips: BoldClipsMode }): boolean {
  if (parts.model === "grok" || parts.mode !== "offer" || parts.fallback !== "auto") return false;
  return !(parts.bold && parts.boldClips !== "with-fallback");
}

// ---------- the run ----------

interface Ctx {
  readonly deps: ClipRunDeps;
  readonly input: ClipRunInput;
  readonly signal: AbortSignal;
  readonly mode: "auto" | "offer";
  readonly boldClips: BoldClipsMode;
  readonly prices: ClipPrices;
  readonly attempts: AttemptSummary[];
}

type AttemptEnd =
  | { kind: "completed"; attemptId: string; providerJobId: string; providerCostMicros: number | null; costSource: ClipCostSource; aboveWorst: MoneyError | null }
  /** A content refusal, settled 0: the only end a fallback can follow. */
  | { kind: "refused-free" }
  | { kind: "failed"; reason: ClipFailReason; cost: CostKind; unknownWhy?: UnknownWhy; detail?: string; aboveWorst: MoneyError | null }
  | { kind: "late"; late: LateAttempt }
  | { kind: "not-reserved"; refusal: ReserveRefusal }
  | { kind: "cancelled" }
  | { kind: "interrupted" };

/** Thrown inside an attempt when the signal fires while it waits; the attempt turns it into `interrupted`. */
class Stopped extends Error {}

/**
 * Runs one clip: Kling (or the chosen model), then Grok behind it where the rules allow. Returns what happened; throws only on a defect (a refused attempt id, a failed ledger or journal write, a request body that
 * cannot be built), never after a request has left without the reserve having been left open.
 */
export async function runClip(deps: ClipRunDeps, input: ClipRunInput, signal: AbortSignal): Promise<ClipRunResult> {
  const mode = input.mode ?? GROK_FALLBACK;
  const boldClips = input.boldClips ?? BOLD_CLIPS;
  // The sheet and `clips.create` refuse both before anything is written; a caller that gets here anyway sends nothing.
  if (input.bold && boldClips === "off") throw new RangeError("a frame of «Смелая» is not suitable while BOLD_CLIPS is `off`: nothing may be sent");
  if (input.request.model === "grok" && mode !== "offer") throw new RangeError("a Grok clip exists only in mode `offer`");

  // Stopped before anything is written: no journal, no reserve, nothing for a restart to find.
  if (signal.aborted) return { kind: "cancelled", attempts: [] };

  const prices: ClipPrices = Object.freeze({ std: { ...input.prices.std }, pro: { ...input.prices.pro }, grok: { ...input.prices.grok } });
  const attempts: AttemptSummary[] = [];
  const ctx: Ctx = { deps, input, signal, mode, boldClips, prices, attempts };

  await deps.journal.requested({
    clipId: input.clipId,
    photoId: input.photoId,
    request: input.request,
    motion: input.motion,
    acceptedWorstMicros: input.acceptedWorstMicros,
    at: new Date(deps.now()).toISOString(),
  });

  const firstModel = input.request.model;
  const first = await runAttempt(ctx, 1, firstModel);
  if (first.kind !== "refused-free") return resultOf(ctx, first, firstModel, false);

  const next = afterFreeRefusal(ctx, firstModel);
  if (next !== "grok") {
    return { kind: "failed", reason: "refused-free", attempts, model: firstModel, cost: "free", grokOffer: next === "offer", aboveWorst: null };
  }
  const second = await runAttempt(ctx, 2, "grok");
  // Grok's reserve refused. The month or the cap (a photo run took the room while Kling was being proven): the clip ends free as `grok-no-room`. Any other refusal (RECONCILE_REQUIRED, HALTED) is not
  // about room, and is handed back as it is. Either way nothing was sent.
  if (second.kind === "not-reserved") {
    const aboutRoom = second.refusal.reason === "BUDGET_EXCEEDED" || second.refusal.reason === "RUN_CAP_EXCEEDED";
    if (aboutRoom) return { kind: "failed", reason: "grok-no-room", attempts, model: "grok", cost: "free", grokOffer: false, aboveWorst: null };
    return { kind: "not-reserved", refusal: second.refusal, afterFreeRefusal: true, attempts };
  }
  if (second.kind === "refused-free") return { kind: "failed", reason: "refused-both", attempts, model: "grok", cost: "free", grokOffer: false, aboveWorst: null };
  return resultOf(ctx, second, "grok", true);
}

function resultOf(ctx: Ctx, end: Exclude<AttemptEnd, { kind: "refused-free" }>, model: ClipAttemptModel, fallbackUsed: boolean): ClipRunResult {
  const attempts = ctx.attempts;
  switch (end.kind) {
    case "completed":
      return { kind: "completed", attempts, attemptId: end.attemptId, model, providerJobId: end.providerJobId, providerCostMicros: end.providerCostMicros, costSource: end.costSource, fallbackUsed, aboveWorst: end.aboveWorst };
    case "failed":
      return {
        kind: "failed",
        reason: end.reason,
        attempts,
        model,
        cost: end.cost,
        ...(end.unknownWhy === undefined ? {} : { unknownWhy: end.unknownWhy }),
        grokOffer: false,
        ...(end.detail === undefined ? {} : { detail: end.detail }),
        aboveWorst: end.aboveWorst,
      };
    case "late":
      return { kind: "late", attempts, late: end.late };
    case "not-reserved":
      return { kind: "not-reserved", refusal: end.refusal, afterFreeRefusal: false, attempts };
    case "cancelled":
      return { kind: "cancelled", attempts };
    case "interrupted":
      return { kind: "interrupted", attempts };
  }
}

/** What follows a content refusal that was proven free (I5.47): Grok by itself, the offer of Grok as a new click, or nothing. */
function afterFreeRefusal(ctx: Ctx, model: ClipAttemptModel): "grok" | "offer" | "none" {
  const parts = { model, mode: ctx.mode, fallback: ctx.input.request.fallback, bold: ctx.input.bold, boldClips: ctx.boldClips };
  if (clipAllowsAutoGrok(parts)) return "grok";
  return clipAllowsGrokOffer(parts) ? "offer" : "none";
}

async function runAttempt(ctx: Ctx, n: 1 | 2, model: ClipAttemptModel): Promise<AttemptEnd> {
  const { deps, input } = ctx;
  const tier: VideoTier = model === "grok" ? "grok" : input.request.quality;
  const { model: modelId, resolution } = VIDEO_TIERS[tier];
  const seconds = input.request.seconds;
  const reserveMicros = clipReserveMicros(ctx.prices[tier], seconds);
  const attemptId = clipAttemptId(input.clipId, n);

  if (ctx.signal.aborted) return { kind: "cancelled" };
  const body = await input.buildRequest({ n, attemptId, model, tier, modelId, resolution, seconds, reserveMicros });
  const reserved = await deps.budget.tryReserve({ attemptId, jobId: input.clipId, scope: { avatarJobId: input.clipId }, model: modelId, worstMicros: reserveMicros });
  if (!reserved.ok) return { kind: "not-reserved", refusal: reserved };
  return new Attempt(ctx, model, attemptId, reserved.handle).run(body);
}

// ---------- one attempt ----------

const TERMINAL = new Set<string>(["completed", "failed", "cancelled", "expired"]);
type StatusPoll = Extract<VideoPollResult, { kind: "status" }>;
type Proof = { kind: "free"; contentByFinish: boolean } | { kind: "paid"; micros: number } | { kind: "unknown"; why: UnknownWhy };
type GenerationRead = { kind: "found"; micros: number; finishReason: string | null } | { kind: "not-found" } | { kind: "unreadable" };

/** An increase of the account's usage over the baseline, beyond this, is a charge: zero, because a refused job's charge was refunded within 25 s in probe P0. */
const NET_USAGE_TOLERANCE_MICROS = 0;

const CreditsBody = z.object({ data: z.object({ total_usage: z.number().finite().nonnegative() }) });

const iso = (ms: number): string => new Date(ms).toISOString();

function reasonOfKind(kind: FailureKind): ClipFailReason {
  if (kind === "AUTH_INVALID") return "key-invalid";
  if (kind === "INSUFFICIENT_CREDITS") return "no-credits";
  if (kind === "RATE_LIMITED") return "rate-limited";
  return "bad-request";
}

class Attempt {
  private providerJobId: string | undefined;
  private submittedAtMs = 0;
  /** The ledger's length before the baseline read: any line after it that is not this attempt's makes the net-usage check not count. */
  private mark = 0;
  private baseline: number | null = null;
  private abandoned = false;
  /** The POST is about to leave (or has): from here a stop leaves the reserve open at worst. Before it, a stop releases the reserve. */
  private sent = false;
  private reserveAtMs = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly model: ClipAttemptModel,
    private readonly attemptId: string,
    private readonly handle: ReserveHandle,
  ) {}

  private get deps(): ClipRunDeps {
    return this.ctx.deps;
  }

  async run(body: VideoRequest): Promise<AttemptEnd> {
    try {
      return await this.execute(body);
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      if (!this.sent) {
        // Stopped before the POST: nothing reached the provider, so nothing may stay open at worst.
        await this.deps.budget.release(this.handle, "stopped before the POST");
        this.deps.holds.release(this.attemptId);
        return { kind: "cancelled" };
      }
      if (!this.abandoned && this.deps.budget.ledger.closeOf(this.attemptId) === undefined) await this.abandon();
      return { kind: "interrupted" };
    }
  }

  private async execute(body: VideoRequest): Promise<AttemptEnd> {
    const { deps, ctx } = this;
    const t = deps.timings;
    const reserveLine = deps.budget.ledger.reserveOf(this.attemptId);
    // From the reserve on, the POST may leave: a throw or a crash before `submitted` is held 20 min from the reserve line's `at` (I5.48).
    this.reserveAtMs = reserveLine === undefined ? deps.now() : Date.parse(reserveLine.at);
    deps.holds.hold(this.attemptId, holdUntilForReserve(this.reserveAtMs, t));
    deps.onPhase?.({ phase: "submitting", model: this.model });

    // The net-usage baseline: read BEFORE the POST, so a charge that shows up before the terminal status (probe P-V: ≈ 38 s after the POST) is part of the comparison, not of the baseline.
    this.mark = deps.budget.ledger.lines.length;
    // Read PROOF_READ_TRIES times: one /credits blip before the POST must not cost the clip its Grok (a clip without a baseline can never prove a refusal free).
    this.baseline = await this.readUsage(PROOF_READ_TRIES);
    if (ctx.signal.aborted) throw new Stopped();

    this.sent = true;
    let submit: Awaited<ReturnType<ClipRunDeps["client"]["submitVideo"]>>;
    try {
      submit = await deps.client.submitVideo(body, ctx.signal);
    } catch (error) {
      // The client never throws; if it does, the request may have left: it is uncertain, not refused.
      submit = { kind: "uncertain", cause: "network", httpStatus: null, detail: `POST /videos threw: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (submit.kind === "refused") {
      // A definite 4xx: no job exists and nothing is billed.
      const halt = await this.settle(0, false);
      deps.holds.release(this.attemptId);
      const content = submit.moderation;
      await deps.journal.ended({ attemptId: this.attemptId, status: content ? "refused" : "failed", costSource: "none", at: iso(deps.now()) });
      this.record(content ? "refused" : "failed", "none");
      if (content) return { kind: "refused-free" };
      return { kind: "failed", reason: reasonOfKind(submit.errorKind), cost: "free", detail: submit.detail, aboveWorst: halt };
    }

    if (submit.kind === "uncertain") {
      // The hold keeps its base, the reserve line's `at` + 20 min (the same one a restart reads from the ledger).
      await this.abandon();
      this.record("uncertain", "none");
      return { kind: "failed", reason: "submit-uncertain", cost: "worst", detail: submit.detail, aboveWorst: null };
    }

    this.providerJobId = submit.id;
    this.submittedAtMs = deps.now();
    try {
      await deps.journal.submitted({ attemptId: this.attemptId, model: this.model, providerJobId: submit.id, at: iso(this.submittedAtMs) });
    } catch (error) {
      // I5.45: a throw between the 2xx and this fsync behaves as an uncertain submit. The reserve stays open; the hold stays at the reserve line's `at` + 20 min; nothing is polled or resent.
      await this.abandon();
      this.record("uncertain", "none");
      return { kind: "failed", reason: "submit-uncertain", cost: "worst", detail: `the journal write failed: ${error instanceof Error ? error.message : String(error)}`, aboveWorst: null };
    }
    deps.holds.hold(this.attemptId, holdUntilForSubmitted(this.submittedAtMs, t));
    deps.onPhase?.({ phase: "rendering", model: this.model, submittedAt: iso(this.submittedAtMs) });

    const polled = await this.pollToTerminal();
    if (polled.kind === "late") {
      // I5.48: no terminal status 20 min after the submit. The reserve stays open at worst until the reconcile; a late `completed` writes no ledger line.
      await this.abandon();
      deps.onPhase?.({ phase: "late", model: this.model, submittedAt: iso(this.submittedAtMs) });
      this.record("late", "none");
      return {
        kind: "late",
        late: { attemptId: this.attemptId, model: this.model, providerJobId: submit.id, submittedAtMs: this.submittedAtMs, giveUpAtMs: this.submittedAtMs + t.lateGiveUpMs },
      };
    }
    deps.holds.hold(this.attemptId, holdUntilForTerminal(polled.atMs, t));
    return polled.poll.status === "completed" ? this.settleCompleted(polled.poll, polled.atMs) : this.settleFailure(polled.poll, polled.atMs);
  }

  // ----- polling -----

  private async pollToTerminal(): Promise<{ kind: "terminal"; poll: StatusPoll; atMs: number } | { kind: "late" }> {
    const { deps } = this;
    const deadline = this.submittedAtMs + deps.timings.lifetimeMs;
    for (;;) {
      await this.sleepFor(Math.min(deps.timings.pollMs, Math.max(0, deadline - deps.now())));
      const poll = await this.pollOnce();
      if (poll !== null && TERMINAL.has(poll.status)) return { kind: "terminal", poll, atMs: deps.now() };
      if (deps.now() >= deadline) return { kind: "late" };
    }
  }

  private async pollOnce(): Promise<StatusPoll | null> {
    try {
      const poll = await this.deps.client.pollVideo(this.providerJobId ?? "", this.ctx.signal);
      return poll.kind === "status" ? poll : null;
    } catch {
      // A free GET that failed is an unreadable poll: the next one tries again.
      return null;
    }
  }

  // ----- a completed job -----

  private async settleCompleted(poll: StatusPoll, terminalAtMs: number): Promise<AttemptEnd> {
    let costMicros: number;
    let estimated = false;
    let providerCost: number | null;
    let source: ClipCostSource;
    if (poll.usageCostMicros !== null) {
      costMicros = poll.usageCostMicros;
      providerCost = poll.usageCostMicros;
      source = "usage";
    } else {
      // No usage on the poll: /generation answers, from 15 s after the status (a 404 right after `completed` is a billed job whose record has not appeared yet, never zero).
      // Only a record of THIS job may be read: a poll that names another generation id gets no /generation read at all.
      const read: GenerationRead = this.idIsVerified(poll) ? await this.readGeneration(terminalAtMs + this.deps.timings.proofFirstReadMs, true) : { kind: "unreadable" };
      if (read.kind === "found") {
        costMicros = read.micros;
        providerCost = read.micros;
        source = "generation";
      } else {
        costMicros = this.handle.worstMicros;
        estimated = true;
        providerCost = null;
        source = "worst";
      }
    }
    const halt = await this.settle(costMicros, estimated);
    await this.deps.journal.ended({
      attemptId: this.attemptId,
      status: "completed",
      ...(providerCost === null ? {} : { providerCostMicros: providerCost }),
      costSource: source,
      at: iso(this.deps.now()),
    });
    this.record("completed", source, providerCost ?? undefined);
    return { kind: "completed", attemptId: this.attemptId, providerJobId: this.providerJobId ?? "", providerCostMicros: providerCost, costSource: source, aboveWorst: halt };
  }

  // ----- a job that ended in failure -----

  private async settleFailure(poll: StatusPoll, terminalAtMs: number): Promise<AttemptEnd> {
    const { deps } = this;
    let content = poll.status === "failed" && poll.contentFailure;
    deps.onPhase?.({ phase: "proving", model: this.model, content, proveUntil: iso(terminalAtMs + deps.timings.proofSecondReadMs) });
    const proof: Proof = this.idIsVerified(poll) ? await this.prove(terminalAtMs) : { kind: "unknown", why: "id-mismatch" };
    // A moderation finish on /generation makes a FAILED job a content refusal; a cancelled or expired job, or a provider error, is never one (I5.47: no automatic Grok behind it).
    if (proof.kind === "free" && proof.contentByFinish && poll.status === "failed") content = true;

    let costKind: CostKind;
    let costSource: ClipCostSource;
    let providerCost: number | undefined;
    let halt: MoneyError | null;
    let unknownWhy: UnknownWhy | undefined;
    if (proof.kind === "free") {
      halt = await this.settle(0, false);
      costKind = "free";
      costSource = "proof";
    } else if (proof.kind === "paid") {
      halt = await this.settle(proof.micros, false);
      costKind = "billed";
      costSource = "generation";
      providerCost = proof.micros;
    } else {
      halt = await this.settle(this.handle.worstMicros, true);
      costKind = "worst";
      costSource = "worst";
      unknownWhy = proof.why;
    }
    const outcome: ClipAttemptOutcome = content ? "refused" : poll.status === "cancelled" ? "cancelled" : poll.status === "expired" ? "expired" : "failed";
    await deps.journal.ended({
      attemptId: this.attemptId,
      status: outcome,
      ...(providerCost === undefined ? {} : { providerCostMicros: providerCost }),
      costSource,
      at: iso(deps.now()),
    });
    this.record(outcome, costSource, providerCost);

    if (content && costKind === "free") return { kind: "refused-free" };
    const reason: ClipFailReason = content ? (costKind === "billed" ? "refused-paid" : "refused-unknown") : "provider-error";
    return { kind: "failed", reason, cost: costKind, ...(unknownWhy === undefined ? {} : { unknownWhy }), aboveWorst: halt };
  }

  /**
   * The proof of a refusal (I5.47). `/generation` at ≥ 15 s and at ≥ 2 min after the terminal poll, both zero evidence (a 404 or a total_cost of 0); then the net-usage check. A read above zero is the bill; a read that
   * stays unreadable is unknown; the check that rose is unknown; the check that cannot count is skipped in mode `auto` and unknown in mode `offer`.
   */
  private async prove(terminalAtMs: number): Promise<Proof> {
    const t = this.deps.timings;
    const first = await this.readGeneration(terminalAtMs + t.proofFirstReadMs, false);
    if (first.kind === "found" && first.micros > 0) return { kind: "paid", micros: first.micros };
    if (first.kind === "unreadable") return { kind: "unknown", why: "unreadable" };

    const second = await this.readGeneration(terminalAtMs + t.proofSecondReadMs, false);
    if (second.kind === "found" && second.micros > 0) return { kind: "paid", micros: second.micros };
    if (second.kind === "unreadable") return { kind: "unknown", why: "unreadable" };

    const after = await this.readUsage(PROOF_READ_TRIES);
    const baseline = this.baseline;
    const counts = baseline !== null && after !== null && this.ledgerIsQuiet();
    if (counts && after - baseline > NET_USAGE_TOLERANCE_MICROS) return { kind: "unknown", why: "net-increase" };
    // A check that cannot count (the baseline or the second read is unreadable, or the ledger moved in between) does NOT prove the refusal free, in either mode: an invisible Kling charge would
    // otherwise be followed by an automatic Grok and the clip would cost more than the owner accepted. Kling settles at worst; the tile offers a manual retry.
    if (!counts) return { kind: "unknown", why: "net-uncounted" };
    const contentByFinish = [first, second].some((read) => read.kind === "found" && isContentFailure(null, read.finishReason));
    return { kind: "free", contentByFinish };
  }

  /** The poll names this very job as its generation (I5.47). A missing or different id fails closed: the /generation record could belong to another job. */
  private idIsVerified(poll: StatusPoll): boolean {
    return poll.generationId !== null && poll.generationId === this.providerJobId;
  }

  /** The net-usage check counts only if nothing else touched the ledger between its two reads (this attempt's own lines excepted). */
  private ledgerIsQuiet(): boolean {
    return this.deps.budget.ledger.lines.slice(this.mark).every((line) => "attemptId" in line && line.attemptId === this.attemptId);
  }

  // ----- free reads -----

  /**
   * One `/generation` slot: waits until `atMs`, then reads up to PROOF_READ_TRIES times. A 404 is final for a refusal (zero evidence, no retry); for a completed job it is a record that has not appeared yet,
   * so it is read again. Unreadable is read again, then given up.
   */
  private async readGeneration(atMs: number, retryNotFound: boolean): Promise<GenerationRead> {
    await this.sleepUntil(atMs);
    for (let tries = 1; ; tries++) {
      const read = await this.generationOnce();
      if (read.kind === "found") return { kind: "found", micros: read.totalCostMicros, finishReason: read.finishReason };
      if (read.kind === "not-found" && !retryNotFound) return { kind: "not-found" };
      if (tries >= PROOF_READ_TRIES) return read.kind === "not-found" ? { kind: "not-found" } : { kind: "unreadable" };
      await this.sleepFor(this.deps.timings.proofRetryMs);
    }
  }

  private async generationOnce(): Promise<GenerationResult> {
    try {
      return await this.deps.client.fetchGeneration(this.providerJobId ?? "", this.ctx.signal);
    } catch {
      return { kind: "unreadable", cause: "network", httpStatus: null, detail: "GET /generation threw" };
    }
  }

  /** `/credits` `total_usage` in micro-dollars, or null when it cannot be read after `tries` reads. */
  private async readUsage(tries: number): Promise<number | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        const parsed = CreditsBody.safeParse(await this.deps.client.fetchCredits());
        if (parsed.success) return costToMicros(parsed.data.data.total_usage);
      } catch {
        // unreadable: tried again below, or given up
      }
      if (attempt >= tries) return null;
      await this.sleepFor(this.deps.timings.proofRetryMs);
    }
  }

  // ----- money and bookkeeping -----

  private settle(costMicros: number, estimated: boolean): Promise<MoneyError | null> {
    return settleOnce(this.deps.budget, this.handle, { costMicros, estimated });
  }

  private async abandon(): Promise<void> {
    this.abandoned = true;
    await this.deps.budget.abandon(this.handle);
  }

  private record(outcome: ClipAttemptOutcome, costSource: ClipCostSource, providerCostMicros?: number): void {
    this.ctx.attempts.push({
      attemptId: this.attemptId,
      model: this.model,
      ...(this.providerJobId === undefined ? {} : { providerJobId: this.providerJobId }),
      outcome,
      ...(providerCostMicros === undefined ? {} : { providerCostMicros }),
      costSource,
    });
  }

  private async sleepFor(ms: number): Promise<void> {
    await this.deps.sleep(ms, this.ctx.signal);
    if (this.ctx.signal.aborted) throw new Stopped();
  }

  private async sleepUntil(atMs: number): Promise<void> {
    const wait = atMs - this.deps.now();
    if (wait > 0) await this.sleepFor(wait);
    else if (this.ctx.signal.aborted) throw new Stopped();
  }
}

// ---------- settle, once ----------

/**
 * Settles an attempt exactly once, keyed by its attempt id: if the ledger already closed it, nothing is written (a retried call never moves money twice). A bill above the reserve is recorded by the budget and
 * then thrown as the fatal SETTLE_ABOVE_WORST; it is handed back here instead, so the clip that was paid for is still delivered while the halt stands in the ledger.
 */
export async function settleOnce(budget: Pick<Budget, "settle" | "ledger">, handle: ReserveHandle, bill: { costMicros: number; estimated: boolean }): Promise<MoneyError | null> {
  if (budget.ledger.closeOf(handle.attemptId) !== undefined) return null;
  try {
    await budget.settle(handle, bill);
    return null;
  } catch (error) {
    if (error instanceof MoneyError && error.code === "SETTLE_ABOVE_WORST") return error;
    throw error;
  }
}

// ---------- a late clip ----------

/**
 * A `late` attempt after its 20 min: polled for its file every 60 s until 60 min after the submit. It writes NO ledger line (its reserve is open at worst until the owner's reconcile). A `completed` is the file to
 * download; any other end, or none by the 60 min mark, is failed `late`. The journal says how it ended, and the hold becomes terminal + 2 min.
 */
export async function awaitLateClip(deps: ClipRunDeps, late: LateAttempt, signal: AbortSignal): Promise<LateResult> {
  const t = deps.timings;
  const giveUp = async (): Promise<LateResult> => {
    await deps.journal.ended({ attemptId: late.attemptId, status: "late", costSource: "none", at: iso(deps.now()) });
    return { kind: "failed", reason: "late" };
  };
  for (;;) {
    const remaining = late.giveUpAtMs - deps.now();
    if (remaining <= 0) return giveUp();
    await deps.sleep(Math.min(t.latePollMs, remaining), signal);
    if (signal.aborted) return { kind: "interrupted" };
    let poll: StatusPoll | null = null;
    try {
      const read = await deps.client.pollVideo(late.providerJobId, signal);
      poll = read.kind === "status" ? read : null;
    } catch {
      // unreadable: the next poll tries again
    }
    if (poll !== null && TERMINAL.has(poll.status)) {
      const atMs = deps.now();
      deps.holds.hold(late.attemptId, holdUntilForTerminal(atMs, t));
      if (poll.status === "completed") {
        await deps.journal.ended({ attemptId: late.attemptId, status: "completed", ...(poll.usageCostMicros === null ? {} : { providerCostMicros: poll.usageCostMicros }), costSource: "none", at: iso(atMs) });
        return { kind: "completed", providerCostMicros: poll.usageCostMicros };
      }
      const status: ClipAttemptOutcome = poll.contentFailure ? "refused" : poll.status === "cancelled" ? "cancelled" : poll.status === "expired" ? "expired" : "failed";
      await deps.journal.ended({ attemptId: late.attemptId, status, costSource: "none", at: iso(atMs) });
      return { kind: "failed", reason: "late" };
    }
    if (deps.now() >= late.giveUpAtMs) return giveUp();
  }
}
