import { rm } from "node:fs/promises";
import {
  clipAllowsAutoGrok,
  CLIP_RETRYABLE_FAILURES,
  type BoldClipsMode,
  type ClipAttemptModel,
  type ClipFace,
  type ClipFailReason,
  type ClipModelUsed,
  type ClipMotionChoice,
  type ClipPrices,
  type ClipRequest,
  type EngineError,
} from "../../shared/engine";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import type { ClipPhaseUpdate } from "../jobs";
import type { ReserveRefusal } from "../money/budget";
import { jpegDataUrl } from "../openrouter/image";
import type { OpenRouterClient } from "../openrouter/types";
import { awaitLateClip, runClip, type AttemptPlan, type AttemptSummary, type ClipPhaseEvent, type ClipRunDeps, type ClipRunInput, type ClipRunResult, type LateAttempt, type LateResult } from "./attempt";
import { downloadClip, type ClipDownload, type DownloadClipOptions } from "./download";
import { checkClipFace, type CheckClipFaceOptions } from "./faceCheck";
import { firstFrameSize, makeFirstFrame, type FirstFrame, type MakeFirstFrameOptions } from "./firstFrame";
import type { FrameFacts } from "./frameFacts";
import { makePoster, type MakePosterOptions } from "./frames";
import { clipPromptOf, clipRequestBody } from "./prompt";
import { clipFaceOf, drawPoster, readyOutcomeOf } from "./ready";
import type { ClipRecord } from "./schemas";
import { ensureClipsDir, journalOf, removeJournal, writeClipRecord } from "./store";
import type { ValidClip } from "./validate";

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.1, §5.3, §5.10, §5.11, I5.50, I5.53): the create chain of ONE clip, after `clips.create` has said yes.
//
//   preparing   the first frame (free: the photo scaled to the clip's size, a JPEG; Grok's own 720p frame too when a pro clip may fall back to it), and the master's face embedding of a
//               judged photo, so a master switch during the clip does not move its verdict. A photo the first frame cannot use is refused here, before any money, with nothing written.
//   the money   V3b's state machine (`runClip`): requested → reserve → POST → submitted → poll → settle, Grok behind a free Kling where the rules allow. Its phases (submitting, rendering,
//               proving, late) are the job's. When it returns, every reserve of the clip is settled or abandoned: the money is CLOSED (the slot, the paid count and the cap go), exactly once.
//   the file    downloading (V4b's download and validation; a failure is paid and recorded, retryable until the submit + 60 min), checking (the poster under a fresh temp name, renamed once
//               durable, then the face check, which only marks), saving (the record: the commit, I5.53). The journal goes once the record stands.
//
// A `late` attempt is polled for its file (free, no ledger line) and goes the same way. The job never resends a POST and never writes the ledger itself.

/** The media steps, V4b's by default; a test plays them. */
export interface ClipJobMedia {
  readonly makeFirstFrame: (options: MakeFirstFrameOptions) => Promise<FirstFrame>;
  readonly downloadClip: (options: DownloadClipOptions) => Promise<ClipDownload>;
  readonly makePoster: (options: MakePosterOptions) => Promise<void>;
  readonly checkClipFace: (options: CheckClipFaceOptions) => Promise<ClipFace>;
}

const REAL_MEDIA: ClipJobMedia = { makeFirstFrame, downloadClip, makePoster, checkClipFace };

export interface ClipJobDeps {
  /** The money state machine's deps; the job adds the clip's journal and its own phases. */
  readonly attempt: Omit<ClipRunDeps, "journal" | "onPhase">;
  /** The finished file's download (free). */
  readonly download: Pick<OpenRouterClient, "downloadVideo">;
  readonly media?: Partial<ClipJobMedia>;
  /** V3b's `runClip` and `awaitLateClip`; test seams. */
  readonly run?: (deps: ClipRunDeps, input: ClipRunInput, signal: AbortSignal) => Promise<ClipRunResult>;
  readonly awaitLate?: (deps: ClipRunDeps, late: LateAttempt, signal: AbortSignal) => Promise<LateResult>;
  /** The face worker's check; null when the engine has none (the clip is then kept unchecked, `why: "worker"`). */
  readonly faceGate: Pick<WorkerFaceGate, "check"> | null;
  /** The master's SFace embedding, for a judged photo; null when it cannot be taken (the clip is then kept unchecked). Never rejects for that. */
  readonly masterEmbedding: (signal: AbortSignal) => Promise<Float32Array | null>;
  readonly onPhase: (update: ClipPhaseUpdate) => void;
  /** Every reserve of the clip settled or abandoned, or none was made: called exactly once, whatever the outcome. */
  readonly onMoneyClosed: () => void;
  /** Grok's reserve behind a free Kling was refused for a reason that is not room (RECONCILE_REQUIRED, a halt): the owner must see the money's state. */
  readonly onMoneyNotice: (refusal: ReserveRefusal) => void;
  readonly log: (line: string) => void;
}

export interface ClipJobInput {
  readonly clipId: string;
  readonly avatarId: string;
  readonly photoId: string;
  /** The photo's bytes, read and checked by `clips.create`. */
  readonly photo: Uint8Array;
  readonly facts: FrameFacts;
  readonly motion: ClipMotionChoice;
  /** What runs: the owner's choice with the fallback the photo allows (`none` for a frame of «Смелая» under `kling-only`, and for a Grok clip). */
  readonly request: ClipRequest;
  readonly acceptedWorstMicros: number;
  /** The clip's own price book, read once at `clips.create` (I5.46). */
  readonly prices: ClipPrices;
  readonly mode: "auto" | "offer";
  readonly boldClips: BoldClipsMode;
  /** `<library>/avatars/<avatarId>/clips`. */
  readonly clipsDir: string;
  readonly createdAt: string;
}

export type ClipJobOutcome =
  /** The record committed: a ready clip, or a failure the record says. */
  | { kind: "recorded"; record: ClipRecord }
  /** Nothing was recorded and nothing is open: a refusal before any money (the photo, the budget). */
  | { kind: "refused"; error: EngineError }
  /** A cancel before the POST: nothing sent, nothing open, nothing recorded. */
  | { kind: "cancelled" }
  /** A stop (the engine shuts down) once a POST may have left: no record; the journal stays for the restart. */
  | { kind: "interrupted" };

/** Thrown inside the chain when the signal fires while it waits. */
class Stopped extends Error {}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The model that made the file, or that tried last, as the record names it. */
function modelUsed(model: ClipAttemptModel, request: ClipRequest): ClipModelUsed {
  return model === "grok" ? "grok" : request.quality === "pro" ? "kling-pro" : "kling-std";
}

function recordAttempt(attempt: AttemptSummary): ClipRecord["provider"]["attempts"][number] {
  return {
    attemptId: attempt.attemptId,
    ...(attempt.providerJobId === undefined ? {} : { providerJobId: attempt.providerJobId }),
    outcome: attempt.outcome,
    ...(attempt.providerCostMicros === undefined ? {} : { providerCostMicros: attempt.providerCostMicros }),
    costSource: attempt.costSource,
  };
}

/** A budget refusal of the clip's first reserve, as the job's error: the codes map one to one. */
function refusalError(refusal: ReserveRefusal): EngineError {
  switch (refusal.reason) {
    case "BUDGET_EXCEEDED":
    case "RUN_CAP_EXCEEDED":
      return { code: refusal.reason, detail: `committed ${refusal.committedMicros} µ$ + the clip's ${refusal.worstMicros} µ$ > the limit ${refusal.limitMicros} µ$; nothing was sent` };
    case "RECONCILE_REQUIRED":
      return { code: "RECONCILE_REQUIRED", detail: `${refusal.openAttempts} open attempt(s)${refusal.torn ? ", a torn ledger line" : ""}; reconcile before a clip; nothing was sent` };
    case "HALTED":
      return { code: refusal.cause, detail: "the ledger is halted; nothing was sent" };
  }
}

/** Runs one clip from its first frame to its record. Never rejects for the clip's own outcomes; a disk that cannot take the record, or a defect, rejects (the journal then stays). */
export async function runClipJob(deps: ClipJobDeps, input: ClipJobInput, signal: AbortSignal): Promise<ClipJobOutcome> {
  let moneyClosed = false;
  const closeMoney = (): void => {
    if (moneyClosed) return;
    moneyClosed = true;
    deps.onMoneyClosed();
  };
  try {
    return await new ClipChain(deps, input, signal, closeMoney).run();
  } finally {
    closeMoney();
  }
}

class ClipChain {
  private readonly media: ClipJobMedia;
  private readonly journal;
  /** When each model's POST was accepted, from the attempt's `rendering` phase: a failed download is retryable until that + 60 min. */
  private readonly submittedAt = new Map<ClipAttemptModel, string>();
  /** The step reached (video, download, check, save), for every phase update. */
  private done = 0;

  constructor(
    private readonly deps: ClipJobDeps,
    private readonly input: ClipJobInput,
    private readonly signal: AbortSignal,
    private readonly closeMoney: () => void,
  ) {
    this.media = { ...REAL_MEDIA, ...deps.media };
    this.journal = journalOf(input.clipsDir, input.clipId);
  }

  async run(): Promise<ClipJobOutcome> {
    const { input, deps } = this;
    this.phase({ phase: "preparing" });
    await ensureClipsDir(input.clipsDir);

    // ----- preparing: free, before any money -----
    let frames: { first: Uint8Array; grok: Uint8Array };
    let embedding: Float32Array | null = null;
    try {
      const prepared = await this.prepareFrames();
      if ("refused" in prepared) return { kind: "refused", error: { code: "VALIDATION", clipReason: prepared.refused, detail: `the photo cannot be the clip's first frame (${prepared.refused})` } };
      frames = prepared;
      if (input.facts.faceRole === "judged" && deps.faceGate !== null) embedding = await deps.masterEmbedding(this.signal);
    } catch (error) {
      if (this.signal.aborted) return { kind: "cancelled" };
      throw error;
    }
    if (this.signal.aborted) return { kind: "cancelled" };

    // ----- the money -----
    const runDeps = this.runDeps();
    const result = await (deps.run ?? runClip)(runDeps, this.runInput(frames), this.signal);
    this.closeMoney();

    switch (result.kind) {
      case "completed":
        return this.deliver(result.model, result.providerJobId, result.attempts, embedding);
      case "failed":
        return this.recordFailure(result.reason, result.model, result.attempts);
      case "late": {
        const late = await (deps.awaitLate ?? awaitLateClip)(runDeps, result.late, this.signal);
        if (late.kind === "interrupted") return { kind: "interrupted" };
        // The journal said how the late attempt ended; the record says the same (no ledger line was written for it: its reserve waits for the reconcile).
        const attempts = result.attempts.map((attempt) =>
          attempt.attemptId !== result.late.attemptId
            ? attempt
            : late.kind === "completed"
              ? { ...attempt, outcome: "completed" as const, costSource: "none" as const, ...(late.providerCostMicros === null ? {} : { providerCostMicros: late.providerCostMicros }) }
              : attempt,
        );
        if (late.kind === "failed") return this.recordFailure("late", result.late.model, attempts);
        this.submittedAt.set(result.late.model, iso(result.late.submittedAtMs));
        return this.deliver(result.late.model, result.late.providerJobId, attempts, embedding);
      }
      case "not-reserved":
        if (result.afterFreeRefusal) {
          // Kling was refused and settled 0; Grok could not even be reserved, for a reason that is not room. The clip ends free, and the owner sees why nothing more can run.
          deps.onMoneyNotice(result.refusal);
          return this.recordFailure("refused-free", input.request.model, result.attempts);
        }
        await removeJournal(input.clipsDir, input.clipId);
        return { kind: "refused", error: refusalError(result.refusal) };
      case "cancelled":
        await removeJournal(input.clipsDir, input.clipId);
        return { kind: "cancelled" };
      case "interrupted":
        return { kind: "interrupted" };
    }
  }

  // ----- preparing -----

  /** The first frame of the model that runs first, and Grok's own when it may follow and wants another size. A refusal of the photo is a result; an abort rejects. */
  private async prepareFrames(): Promise<{ first: Uint8Array; grok: Uint8Array } | { refused: "photo-unreadable" | "not-vertical" }> {
    const { input } = this;
    const { model, quality } = input.request;
    const first = await this.media.makeFirstFrame({ photo: input.photo, model, quality, scratchDir: input.clipsDir, signal: this.signal });
    if (!first.ok) return { refused: first.reason };
    const grokMayFollow = clipAllowsAutoGrok({ model, mode: input.mode, fallback: input.request.fallback, bold: input.facts.bold, boldClips: input.boldClips });
    const ownSize = firstFrameSize(model, quality);
    const grokSize = firstFrameSize("grok", quality);
    if (!grokMayFollow || (ownSize.width === grokSize.width && ownSize.height === grokSize.height)) return { first: first.jpeg, grok: first.jpeg };
    const grok = await this.media.makeFirstFrame({ photo: input.photo, model: "grok", quality, scratchDir: input.clipsDir, signal: this.signal });
    if (!grok.ok) return { refused: grok.reason };
    return { first: first.jpeg, grok: grok.jpeg };
  }

  // ----- the money -----

  private runDeps(): ClipRunDeps {
    return {
      ...this.deps.attempt,
      journal: this.journal,
      onPhase: (event) => this.attemptPhase(event),
    };
  }

  private runInput(frames: { first: Uint8Array; grok: Uint8Array }): ClipRunInput {
    const { input } = this;
    return {
      clipId: input.clipId,
      photoId: input.photoId,
      request: input.request,
      motion: { source: input.motion.source, label: input.motion.label, text: input.motion.text },
      acceptedWorstMicros: input.acceptedWorstMicros,
      bold: input.facts.bold,
      prices: input.prices,
      mode: input.mode,
      boldClips: input.boldClips,
      buildRequest: (plan) => this.body(plan, frames),
    };
  }

  /** One attempt's POST body: the prompt in the attempt's dialect, its first frame, the priced model. A prompt that cannot be built is a defect (`clips.create` checked the motion in both). */
  private body(plan: AttemptPlan, frames: { first: Uint8Array; grok: Uint8Array }) {
    const { input } = this;
    const prompt = clipPromptOf(input.facts, input.motion.text, plan.model);
    if (!prompt.ok) throw new Error(`the clip's prompt cannot be built: ${prompt.problems.join("; ")}`);
    const frame = plan.model === "grok" ? frames.grok : frames.first;
    return clipRequestBody({ prompt: prompt.prompt, model: plan.model, quality: input.request.quality, seconds: input.request.seconds, firstFrame: jpegDataUrl(frame, "the clip's first frame") });
  }

  private attemptPhase(event: ClipPhaseEvent): void {
    if (event.phase === "rendering" && event.submittedAt !== undefined) this.submittedAt.set(event.model, event.submittedAt);
    this.phase({
      phase: event.phase,
      model: event.model,
      ...(event.submittedAt === undefined ? {} : { submittedAt: event.submittedAt }),
      ...(event.proveUntil === undefined ? {} : { proveUntil: event.proveUntil }),
    });
  }

  // ----- the file -----

  private async deliver(model: ClipAttemptModel, providerJobId: string, attempts: readonly AttemptSummary[], embedding: Float32Array | null): Promise<ClipJobOutcome> {
    const { input, deps } = this;
    try {
      this.done = 1;
      this.phase({ phase: "downloading", model });
      let download: ClipDownload;
      try {
        download = await this.media.downloadClip({ client: deps.download, providerJobId, clipId: input.clipId, clipsDir: input.clipsDir, requestedSeconds: input.request.seconds, signal: this.signal });
      } catch (error) {
        if (this.signal.aborted) throw new Stopped();
        deps.log(`[clip] ${input.clipId}: the download could not be stored (${error instanceof Error ? error.name : typeof error})`);
        return this.recordFailure("download-failed", model, attempts);
      }
      // The paid file is on disk now: the journal says so BEFORE a stop is looked at (S5.V6), so a stop in this window leaves `downloaded` beside the mp4 and a restart finishes it from disk.
      if (download.kind === "saved") await this.journal.downloaded({ sha256: download.sha256, bytes: download.clip.bytes, at: iso(deps.attempt.now()) });
      if (this.signal.aborted) throw new Stopped();
      if (download.kind === "failed") {
        deps.log(`[clip] ${input.clipId}: the download failed (${download.reason})`);
        return this.recordFailure(download.reason, model, attempts);
      }

      this.done = 2;
      this.phase({ phase: "checking", model });
      const poster = await this.poster(download);
      if (poster === "undecodable") {
        // ffmpeg PROVED it cannot decode the frame: the file is not one a window can play. Removed; `retryDownload` fetches it again while it can.
        await rm(download.path, { force: true });
        return this.recordFailure("invalid-file", model, attempts);
      }
      const face = await this.face(download, embedding);

      this.done = 3;
      this.phase({ phase: "saving", model });
      return await this.commit(this.record(model, attempts, readyOutcomeOf(input.clipId, download, face)));
    } catch (error) {
      if (error instanceof Stopped || this.signal.aborted) return { kind: "interrupted" };
      throw error;
    }
  }

  /**
   * The poster (`drawPoster`). The provider's file is paid for, validated and already stored, so a poster that cannot be drawn costs it its place only when ffmpeg PROVES it cannot decode it
   * (`undecodable`). Anything else (a timeout under a render's load, a kill we did not send, ffmpeg that cannot be started, a full disk, an error on the poster's own output or its flush) is
   * `missing`: the clip is ready without its poster, and the record still names `<clipId>.poster.jpg`, so a window shows a placeholder until the poster is drawn again (S5.V6 / S5.V8).
   */
  private async poster(download: Extract<ClipDownload, { kind: "saved" }>): Promise<"drawn" | "missing" | "undecodable"> {
    const { input, deps } = this;
    const drawn = await drawPoster({ makePoster: (options) => this.media.makePoster(options), clipPath: download.path, colour: download.clip.colour, clipsDir: input.clipsDir, clipId: input.clipId, signal: this.signal, log: deps.log });
    if (drawn.drawn) return "drawn";
    if (this.signal.aborted) throw new Stopped();
    const kind = drawn.undecodable ? "undecodable" : "missing";
    const then = kind === "missing" ? "the clip is kept without one" : "ffmpeg cannot decode the file; it is not kept";
    deps.log(`[clip] ${input.clipId}: the poster could not be drawn (${drawn.error instanceof Error ? drawn.error.name : typeof drawn.error}); ${then}`);
    return kind;
  }

  /** The face check (`clipFaceOf`), with the master's embedding taken when the job started (a master switch during the clip does not move its verdict). */
  private face(download: Extract<ClipDownload, { kind: "saved" }>, embedding: Float32Array | null): Promise<ClipFace> {
    const { input, deps } = this;
    return clipFaceOf({
      role: input.facts.faceRole,
      gate: deps.faceGate,
      masterEmbedding: async () => embedding,
      check: (options) => this.media.checkClipFace(options),
      clipPath: download.path,
      colour: download.clip.colour,
      durationMs: download.clip.durationMs,
      scratchDir: input.clipsDir,
      signal: this.signal,
      log: deps.log,
    });
  }

  // ----- the record -----

  private async recordFailure(reason: ClipFailReason, model: ClipAttemptModel, attempts: readonly AttemptSummary[]): Promise<ClipJobOutcome> {
    const { input } = this;
    const submitted = this.submittedAt.get(model);
    const retryable = CLIP_RETRYABLE_FAILURES.includes(reason) && submitted !== undefined;
    const until = retryable ? iso(Date.parse(submitted) + this.deps.attempt.timings.lateGiveUpMs) : undefined;
    return this.commit(this.record(model, attempts, { status: "failed", reason, ...(until === undefined ? {} : { retryDownloadUntil: until }) }));
  }

  private record(model: ClipAttemptModel, attempts: readonly AttemptSummary[], outcome: ClipRecord["outcome"]): ClipRecord {
    const { input } = this;
    return {
      schemaVersion: 1,
      id: input.clipId,
      avatarId: input.avatarId,
      sourcePhotoId: input.photoId,
      createdAt: input.createdAt,
      seen: false,
      motion: { source: input.motion.source, label: input.motion.label, text: input.motion.text },
      request: input.request,
      provider: { model: modelUsed(model, input.request), attempts: attempts.map(recordAttempt) },
      recovered: false,
      exports: [],
      outcome,
    };
  }

  /**
   * The record is the commit (I5.53); the journal goes once it stands. A journal that cannot be removed then (the disk refused the removal or the folder's flush) changes nothing of
   * the clip: it is recorded, and a stale journal next to a record is the restart's to remove (S5.V6). It is logged, never an error of the job.
   */
  private async commit(record: ClipRecord): Promise<ClipJobOutcome> {
    await writeClipRecord(this.input.clipsDir, record);
    try {
      await removeJournal(this.input.clipsDir, this.input.clipId);
    } catch (error) {
      this.deps.log(`[clip] ${this.input.clipId}: the record stands, but its journal could not be removed (${error instanceof Error ? error.name : typeof error}); the next start removes the stale journal`);
    }
    return { kind: "recorded", record };
  }

  private phase(update: Omit<ClipPhaseUpdate, "done">): void {
    this.deps.onPhase({ ...update, done: this.done });
  }
}
