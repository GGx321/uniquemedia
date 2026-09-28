import { createHash } from "node:crypto";
import type { AvatarDescriptor, EngineError } from "../../shared/engine";
import { NoFaceInReferenceError } from "../face";
import type { Library, NewPhotoMeta, PhotoQa } from "../library";
import { imageSize, isAnimatedImage, sniffImageMediaType, type LibraryReference } from "../library/media";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { truncate } from "../openrouter/transport";
import type { ImageOk, ImageResult, OpenRouterClient, OpenRouterFetch } from "../openrouter/types";
import { assembleRun } from "../scenes";
import { classifyFailure } from "./failures";
import { foldRun, nextAttemptId, paidAttempts, RunEventSchema, type AttemptOutcome, type LedgerView, type RunEvent, type RunState, type SlotEnd, type SlotState } from "./journal";
import { contractCategory, RUN_ASPECT_RATIO, RUN_ATTEMPTS_PER_SLOT, runRoute, type RunPlan } from "./plan";
import type { CpuPool, NetworkPool, Release } from "./pools";
import { GateFailure, QA_GATE_TIMEOUT_MS, type QaGate, type QaInput, type QaPrepareInput, type QaVerdict } from "./qa";
import { runWriterPhase } from "./writerPhase";

// T6: one job of a photo run — a fresh start or a resume, the same code.
// It continues from the run's persisted state (journal.ts's fold of the
// plan, the journal, the ledger and the committed photos) and never
// re-plans (invariant 6):
//
// 1. The master portrait is loaded as the face reference, before anything
//    is spent: a run without a usable master fails for free.
// 2. The prompts: the scene writer for every chunk the journal does not
//    have yet (writerPhase.ts), then the assembler over the journal's
//    sentences — re-run on every job, so a prompt read back from disk is
//    never trusted as it is (review L3) — journaled before the first image
//    request leaves (invariant 6).
// 3. Every slot without an end, in plan order through the network pool:
//    its next pre-allocated attempt id (never one the ledger or the journal
//    has seen: invariant 5), on the primary model, or on the one-attempt
//    fallback after a moderation refusal; a paid image that passes the media
//    checks goes through the QA gates, then into the library (invariant 11).
//    At most the plan's ids per slot, 3 (invariant 7).
//
// When a run stops (review H1, runs/failures.ts): a timeout takes the slot's
// next id; an attempt that got no answer (a final 429, a 5xx after the
// transport retries, the network) and every fatal error stop the whole run
// from sending — its slots stay open for a resume, which is what the money
// model asks (a new id only after a 2xx, an abort or a timeout); the run's
// cap or the month running out stops only the slot that asked.
//
// Stopping sending is not stopping work (review M1): an image already paid
// for when the run stops is still checked by free gates and stored; it is
// dropped only after a cancel, after a gate itself broke, or when a gate
// would be a paid request.
//
// Money is the client's own job (reserve on disk before the request, settle
// by the settle rule), under the run's scope; the Budget checks every reserve
// against the run's cap and the month atomically (invariant 3), so the cap
// holds with any number of requests in flight. A cancel aborts the requests
// in flight — their reserves stay open at their worst case until reconciled.

/** What the job needs of the library: the run's journal, the master as a reference (and, for a gate's own prepare(), the master's original bytes — M1/N1), and the photos. */
export type RunLibrary = Pick<Library, "appendJournal" | "readJournal" | "addPhoto" | "loadReference" | "loadMasterOriginal" | "photosByAvatar" | "appendHistory">;

/** How long preparing the master as a reference (an ffmpeg downscale) may take before the run fails for free. */
export const REFERENCE_TIMEOUT_MS = 30_000;

/**
 * How long a free gate may take on an image that arrived after the user's
 * cancel (review round 3, b): the cancel does not abort it — the image is
 * paid for, and keeping it spares a resume from paying again — but the job
 * must still end promptly, so this short bound replaces the cancel.
 */
export const CANCELLED_GATE_TIMEOUT_MS = 5_000;

export interface RunJobDeps {
  /** The OpenRouter client's image call (T3): reserve on disk, send, settle. */
  generateImage: OpenRouterClient["generateImage"];
  /** The OpenRouter client's chat call, for the scene writer. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** Every reserve is its attempt's worst case at these prices. */
  priceBook: PriceBook;
  library: RunLibrary;
  /** Paid requests in flight, shared by every run of the engine; a paid gate runs in it too. */
  pool: NetworkPool;
  /** Local work: the free QA gates. */
  cpu: CpuPool;
  /** Run in order on every paid image that passed its media checks; none are wired in T6. */
  gates: readonly QaGate[];
  /** Wall clock, for the journal's and the history's `at`. */
  now: () => Date;
  /** A thrown error (a ledger or library write, a bug) in the T0 error model. */
  errorOf: (error: unknown) => EngineError;
  /** Each slot that ends: how many have ended of how many, and its photo if it has one. */
  onSlot?: (progress: { done: number; total: number; photoId: string | null }) => void;
  /** Diagnostics that must not stop the run. */
  warn?: (line: string) => void;
  /** REFERENCE_TIMEOUT_MS unless a test says otherwise. */
  referenceTimeoutMs?: number;
  /** CANCELLED_GATE_TIMEOUT_MS unless a test says otherwise. */
  cancelledGateTimeoutMs?: number;
}

export interface RunJob {
  /** The persisted plan (runs/<runId>/plan.json), read back unchanged on a resume. */
  plan: RunPlan;
  /** This job's id: a resume is a new job of the same run. */
  jobId: string;
  /** The avatar's descriptor: the prompts' only path from the avatar (scenes/assembler.ts). */
  descriptor: AvatarDescriptor;
  /** The user's cancel. */
  signal: AbortSignal;
}

/**
 * - done: every slot ended (a photo, or none it will ever get); `failedSlots` have no photo.
 * - failed: the job stopped (a fatal error, an attempt that got no answer, the cap or the
 *   month); slots it left open are continued by a resume.
 * - cancelled: the user stopped it with slots left.
 * Photos stored before a failure or a cancel stay in the library.
 */
export type RunJobEnd = { status: "done"; photoIds: string[]; failedSlots: number } | { status: "failed"; error: EngineError } | { status: "cancelled" };

/** The engine's fetch, reporting every response's status to the network pool so a 429 backs every run off at once. */
export function reportingTo(pool: NetworkPool, fetch: OpenRouterFetch): OpenRouterFetch {
  return async (url, init) => {
    const response = await fetch(url, init);
    pool.onResponse(response.status);
    return response;
  };
}

interface Context {
  deps: RunJobDeps;
  job: RunJob;
  plan: RunPlan;
  scope: Scope;
  primary: ReturnType<typeof runRoute>[0];
  fallback: ReturnType<typeof runRoute>[0] | null;
  /** The first reason no attempt may start any more: a fatal error, or an attempt that got no answer. */
  halt: EngineError | null;
  /** A QA gate could not run: images that arrive now cannot be judged, so they are dropped. */
  gatesBroken: boolean;
  /** The first Budget refusal of a slot's reserve (the run's cap, the month): that slot stopped, others went on. */
  limited: EngineError | null;
  done: number;
  total: number;
  /**
   * Re-review N10: the sha256 of whatever bytes THIS job's own
   * `prepareGates()` handed every gate's `prepare()` as `masterOriginal`
   * (the avatar's original file, or the N1 fallback reference) — threaded
   * into every `QaInput` so a gate's own `check()` can verify it is reading
   * the SAME cached preparation this job made, not a stale or differently
   * keyed one a concurrent job (or a leftover from an earlier one, in this
   * same long-lived engine process) left behind. Set once, by
   * `prepareGates()`, before any slot runs; null only if `prepareGates()`
   * itself never ran (unreachable in production — `work()` always calls it
   * before any slot).
   */
  masterSha256: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * M1: not every throw is an `Error` — emscripten's own `ExitStatus` (thrown
 * by the WASM codecs on a fatal decode failure, decode/realBackend.ts) has
 * `{name, message, status}` own properties but `instanceof Error` is false
 * and `String()` on it gives the useless `"[object Object]"`. Duck-types a
 * `.message` string first (covers ExitStatus and anything shaped like it),
 * falls back to `JSON.stringify` (still useful for a plain object), and
 * only reaches bare `String()` for a genuinely un-stringifiable throw (a
 * primitive, `undefined`, a cyclic object `JSON.stringify` itself rejects).
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function at(ctx: Context): string {
  return ctx.deps.now().toISOString();
}

/** Whether a new request may still be sent: no cancel, no halt. */
function sending(ctx: Context): boolean {
  return !ctx.job.signal.aborted && ctx.halt === null;
}

/** Stops every slot from starting an attempt. Called synchronously right after a result, before anything awaits. */
function stopSending(ctx: Context, error: EngineError): void {
  ctx.halt ??= error;
}

function journal(ctx: Context, event: RunEvent): Promise<void> {
  return ctx.deps.library.appendJournal(ctx.plan.runId, event, RunEventSchema);
}

function attemptEvent(ctx: Context, slot: SlotState, attemptId: string, model: string, outcome: AttemptOutcome, extra: { photoId?: string; error?: EngineError } = {}): Promise<void> {
  return journal(ctx, { type: "attempt", slotIndex: slot.slot.slotIndex, attemptId, model, outcome, ...extra, at: at(ctx) });
}

/** A slot's final end: journaled first, then counted and announced. */
async function endSlot(ctx: Context, slot: SlotState, end: SlotEnd): Promise<void> {
  const record = end.status === "done" ? { status: "done" as const, photoId: end.photoId } : { status: "failed" as const, error: end.error };
  await journal(ctx, { type: "slot", slotIndex: slot.slot.slotIndex, ...record, at: at(ctx) });
  slot.end = end;
  ctx.done++;
  ctx.deps.onSlot?.({ done: ctx.done, total: ctx.total, photoId: end.status === "done" ? end.photoId : null });
}

/** The master as the face reference, bounded; an error end when the run cannot have one. */
async function loadMaster(ctx: Context): Promise<{ ok: true; master: LibraryReference } | { ok: false; end: RunJobEnd }> {
  const { deps, job, plan } = ctx;
  const ms = deps.referenceTimeoutMs ?? REFERENCE_TIMEOUT_MS;
  // timeoutSignal(), not AbortSignal.timeout(): a bound that guards money must not depend on an unref'd timer (timeoutSignal.ts).
  const timeout = timeoutSignal(ms);
  const signal = AbortSignal.any([job.signal, timeout.signal]);
  try {
    const master = await untilAborted(deps.library.loadReference(plan.avatarId, signal), signal);
    if (master === null) return { ok: false, end: { status: "failed", error: { code: "NOT_FOUND", detail: `avatar ${plan.avatarId} has no usable master photo to use as the face reference` } } };
    return { ok: true, master };
  } catch (error) {
    if (job.signal.aborted) return { ok: false, end: { status: "cancelled" } };
    const why = timeout.signal.aborted ? `it took longer than ${ms} ms` : messageOf(error);
    return { ok: false, end: { status: "failed", error: { code: "INTERNAL", detail: truncate(`the master photo could not be prepared as the face reference: ${why}`) } } };
  } finally {
    timeout.clear();
  }
}

/**
 * Money review H1: every gate's optional `prepare()`, once per job (start or
 * resume, the same code — `work()`'s own header), right after `loadMaster()`
 * and before the writer phase or any image is generated — bounded the same
 * way `loadMaster()` is. A gate that cannot run for this avatar at all
 * (today: the face gate, with no usable face on the master) throws there;
 * the job ends `MASTER_FACE_UNUSABLE` before a single request is sent,
 * instead of discovering the problem lazily on the first paid image's own
 * `check()` (the old, reversed design faceGate.ts's own header used to
 * misattribute to the owner).
 *
 * M1/N1: gates are handed the avatar's ORIGINAL master file
 * (`Library.loadMasterOriginal()`), never `loadMaster()`'s own downscaled
 * OpenRouter reference — a second, independent read and sha256 check, not a
 * reuse of `loadMaster()`'s result, so a gate's own identity math is never
 * fed bytes chosen for a completely different purpose (fitting OpenRouter's
 * own reference size).
 */
/**
 * Re-review, N1 (HIGH): the decoder only handles JPEG/PNG
 * (decode/wasmDecode.ts's own allow-list — never WebP, by design). An
 * imported master may be WebP (`importStaging.ts`'s own 16 MP cap accepts
 * it), so using `loadMasterOriginal()`'s raw bytes unconditionally made
 * every WebP-imported avatar's runs fail MASTER_FACE_UNUSABLE forever — the
 * master is perfectly fine, only unreadable by this ONE decoder. Use the
 * original file when it is JPEG/PNG (M1/N1's own fix stays: never the
 * OpenRouter-bound downscale for a JPEG/PNG original); otherwise fall back
 * to `reference` — `loadMaster()`'s own <=1024px reference, already loaded
 * for this exact avatar's OpenRouter calls, always JPEG
 * (`downscaleToJpeg`'s own output format, `QaInput.master`'s own doc
 * comment) — so the identity check still runs, just at a smaller size, on
 * every format the app can import.
 */
function masterOriginalFor(original: Uint8Array, reference: LibraryReference): Uint8Array {
  const mediaType = sniffImageMediaType(original);
  return mediaType === "image/jpeg" || mediaType === "image/png" ? original : reference;
}

/**
 * Runs every gate's `prepare()` once, against `masterOriginal`. Sets
 * `ctx.masterSha256` first (N10 — before any gate's own prepare() runs, so a
 * concurrent/stale check() in this engine process reads the right sha).
 * Factored out of `prepareGates()` so M1's retry below can call it twice
 * with two different byte sources under the same signal/timeout budget.
 */
async function runPrepare(ctx: Context, masterOriginal: Uint8Array, signal: AbortSignal): Promise<void> {
  ctx.masterSha256 = createHash("sha256").update(masterOriginal).digest("hex");
  const input: QaPrepareInput = { avatarId: ctx.plan.avatarId, masterOriginal, signal };
  await untilAborted(
    Promise.all(ctx.deps.gates.map((gate) => gate.prepare?.(input))),
    signal,
  );
}

/**
 * Re-review, N3: `MASTER_FACE_UNUSABLE` means specifically "no usable face
 * in the master" (`NoFaceInReferenceError`, face/gate.ts) — its own Russian
 * text tells the owner to do something about the master, which is wrong
 * advice for anything else. A systemic failure (a decode/library/ORT
 * problem, or this function's own timeout) routes through the same
 * `INTERNAL` shape `runGates`'s own systemic-failure path already uses for
 * a broken gate mid-run (runJob.ts's own `GateBroken` handling) — the run
 * ends failed, resumable, with no implication that the master itself needs
 * fixing.
 */
async function prepareGates(ctx: Context, reference: LibraryReference): Promise<{ ok: true } | { ok: false; end: RunJobEnd }> {
  const { deps, job, plan } = ctx;
  const ms = deps.referenceTimeoutMs ?? REFERENCE_TIMEOUT_MS;
  const timeout = timeoutSignal(ms);
  const signal = AbortSignal.any([job.signal, timeout.signal]);
  try {
    const original = await untilAborted(deps.library.loadMasterOriginal(plan.avatarId), signal);
    if (original === null) {
      return { ok: false, end: { status: "failed", error: { code: "NOT_FOUND", detail: `avatar ${plan.avatarId} has no usable master photo` } } };
    }
    const masterOriginal = masterOriginalFor(original, reference);
    try {
      await runPrepare(ctx, masterOriginal, signal);
    } catch (error) {
      // M1: masterOriginalFor() only sniffs the FORMAT (JPEG/PNG vs. not) —
      // a JPEG/PNG original can still fail to DECODE (e.g. a CMYK color
      // space; ffmpeg/import tolerate it, the WASM decoder does not,
      // decode/realBackend.ts). A genuine "no face" is not retried (the
      // reference is the same photo, just smaller — it would not have a
      // different face); nor is anything already run against the reference
      // (nothing left to fall back to). Any other failure gets exactly one
      // retry against loadMaster()'s own <=1024px reference, already
      // downscaled to a format (JPEG) the decoder is known to read — under
      // the SAME signal/timeout, so the retry never doubles the deadline
      // budget. 2b whole-slice review blocker: never once `signal` has
      // already aborted (the run's own cancel, or this function's own
      // timeout) — a gate's own prepare() starts a real embedding
      // computation the caller's signal does not actually stop (T7b's
      // H2/N11: the shared computation runs on its own internal
      // AbortController), so retrying here after a stop would start real,
      // wasted work that outlives the job instead of just rethrowing.
      if (masterOriginal === reference || error instanceof NoFaceInReferenceError || signal.aborted) throw error;
      await runPrepare(ctx, reference, signal);
    }
    return { ok: true };
  } catch (error) {
    if (job.signal.aborted) return { ok: false, end: { status: "cancelled" } };
    if (error instanceof NoFaceInReferenceError) {
      return { ok: false, end: { status: "failed", error: { code: "MASTER_FACE_UNUSABLE", detail: truncate(error.message) } } };
    }
    const why = timeout.signal.aborted ? `it took longer than ${ms} ms` : messageOf(error);
    return { ok: false, end: { status: "failed", error: { code: "INTERNAL", detail: truncate(`a QA gate could not be prepared: ${why}`) } } };
  } finally {
    timeout.clear();
  }
}

function samePrompts(journaled: ReadonlyMap<number, string> | null, assembled: ReadonlyMap<number, string>): boolean {
  if (journaled === null || journaled.size !== assembled.size) return false;
  for (const [slotIndex, prompt] of assembled) if (journaled.get(slotIndex) !== prompt) return false;
  return true;
}

/**
 * Every slot's prompt, assembled now from the journal's writer sentences
 * (the writer asked first for any chunk the journal lacks) and today's
 * descriptor — never taken from the journal's own prompts, which are a
 * record, not an input (review L3): assembling re-checks every sentence
 * against today's youth- and revealing-word rules. Journaled before the
 * first image request whenever they differ from the last prompts journaled.
 */
async function promptsOf(ctx: Context, state: RunState, master: LibraryReference): Promise<{ ok: true; prompts: ReadonlyMap<number, string> } | { ok: false; end: RunJobEnd }> {
  const { deps, job, plan } = ctx;
  const ledger: LedgerView = { reserveOf: (id) => deps.budget.ledger.reserveOf(id), closeOf: (id) => deps.budget.ledger.closeOf(id) };
  const written = await runWriterPhase(
    {
      chat: deps.chat,
      budget: deps.budget,
      priceBook: deps.priceBook,
      acquire: (signal) => deps.pool.acquire(signal),
      onChunk: (chunk, sentences) => journal(ctx, { type: "writer", chunk, sentences: [...sentences].map(([slotIndex, sentence]) => ({ slotIndex, sentence })), at: at(ctx) }),
    },
    {
      jobId: job.jobId,
      scope: ctx.scope,
      textModel: plan.models.text,
      signal: job.signal,
      slots: plan.scenes.slots,
      chunks: plan.writerChunks,
      sentences: state.sentences,
      writerDone: state.writerDone,
      ledger,
    },
  );
  if (!written.ok) {
    if (written.stop === "cancelled") return { ok: false, end: { status: "cancelled" } };
    if (written.stop === "exhausted") {
      // No job will ever write that chunk: every open slot ends, so the run is not offered for a resume that cannot help.
      for (const slot of state.slots) if (slot.end === null) await endSlot(ctx, slot, { status: "failed", error: written.error });
    }
    return { ok: false, end: { status: "failed", error: written.error } };
  }
  let assembled: Map<number, string>;
  try {
    assembled = new Map(assembleRun(job.descriptor, plan.scenes, written.sentences, master).map((a) => [a.slotIndex, a.prompt]));
  } catch (error) {
    return { ok: false, end: { status: "failed", error: { code: "INTERNAL", detail: truncate(`the scene prompts could not be assembled: ${messageOf(error)}`) } } };
  }
  if (!samePrompts(state.prompts, assembled)) {
    await journal(ctx, { type: "prompts", prompts: [...assembled].map(([slotIndex, prompt]) => ({ slotIndex, prompt })), at: at(ctx) });
  }
  return { ok: true, prompts: assembled };
}

type GateResult = { verdict: "pass"; qa: PhotoQa } | { verdict: "retry" | "reject"; gate: string; reason: string } | { verdict: "dropped" };

/** A gate that could not run at all (it threw, or outlived its timeout): systemic, every later image would meet it too. */
class GateBroken extends Error {}

/** A gate cut short by the user's cancel, or one that failed on an image that arrived after it: the image is dropped, nothing is broken. */
class GateDropped extends Error {}

/**
 * One free gate's check, bounded by the run's cancel and its own timeout
 * (review L5), inside the CPU pool. On an image that arrived after the
 * cancel (`afterCancel`), the cancel does not abort it: a short bound of its
 * own does (CANCELLED_GATE_TIMEOUT_MS).
 *
 * T7a whole-slice re-review (finding M1): only the job's own cancel
 * (`job.signal.aborted`) reads a thrown error as `GateDropped` here — not
 * `!sending(ctx)`, which also goes false the moment some OTHER slot's fatal
 * image failure stops the run. A free gate keeps running on images already
 * in flight after such a stop (T6 M1's own rule: they are still paid for,
 * and still go through free gates); if the gate ITSELF throws in that
 * window, that is a genuine gate failure, not "nothing to see here because
 * we already stopped" — it must become `GateBroken` (systemic: it sets
 * `gatesBroken`, so a later image is dropped without wasting a second on a
 * gate already known broken) with its own error preserved, exactly as it
 * would if the run were still sending normally. `checkPaid` keeps
 * `!sending(ctx)` instead (see its own comment): a paid gate must never
 * send after ANY stop, cancel or not.
 */
async function checkFree(ctx: Context, gate: QaGate, input: Omit<QaInput, "signal">, afterCancel: boolean): Promise<QaVerdict> {
  const { deps, job } = ctx;
  const ms = afterCancel ? Math.min(gate.timeoutMs ?? QA_GATE_TIMEOUT_MS, deps.cancelledGateTimeoutMs ?? CANCELLED_GATE_TIMEOUT_MS) : (gate.timeoutMs ?? QA_GATE_TIMEOUT_MS);
  const timeout = timeoutSignal(ms);
  const signal = afterCancel ? timeout.signal : AbortSignal.any([job.signal, timeout.signal]);
  try {
    return await untilAborted(
      deps.cpu.run(() => gate.check({ ...input, signal }), signal),
      signal,
    );
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    if (job.signal.aborted) throw new GateDropped();
    throw new GateBroken(`the QA gate "${gate.name}" could not run: ${timeout.signal.aborted ? `it took longer than ${ms} ms` : messageOf(error)}`);
  } finally {
    timeout.clear();
  }
}

/** Stops the run the moment the ledger is found halted (T7a review, finding 7: an above-worst bill from a paid gate's own attempt is kept — the image is paid for and its verdict stands — but no more paid requests may follow). The ledger may also be halted by another job entirely (a different run's or avatar job's own attempt) — this gate did not necessarily cause it, so the wording stays neutral (T7a re-review, finding L6). */
function haltIfLedgerHalted(ctx: Context): void {
  const status = ctx.deps.budget.status();
  if (status.haltCause !== null) {
    stopSending(ctx, { code: status.haltCause, detail: `the ledger is halted (${status.haltCause}); no more paid requests can be sent` });
  }
}

/**
 * One paid gate's check, inside a network slot (review L6). Never called
 * `afterCancel`: `keepImage` already drops the whole image before any gate
 * runs when one of them is paid and the image arrived after a cancel.
 *
 * T7a whole-slice review (finding 1): the FIFO wait for a slot is bounded
 * only by the job's cancel — the gate's own `timeoutMs` starts only once a
 * slot is actually granted, so a busy pool's queue never eats into a paid
 * gate's own budget for its own work. The wait also asks for priority over
 * brand new image attempts (`pools.ts`'s own priority lane): this is work
 * already paid for, so it should not be starved behind a stream of new
 * generations, and doing so shrinks the window in which a stop would
 * otherwise drop that paid image (finding 3, `keepImage`'s own comment).
 *
 * Finding 3: right after the slot is granted, `sending(ctx)` is re-checked —
 * the run may have stopped sending for some other reason while this gate was
 * queued — before the gate's own request is ever allowed to leave.
 *
 * T7a re-review (finding L1): `haltIfLedgerHalted` is checked HERE, inside
 * this function's own `try` block, synchronously right after the gate's
 * verdict comes back and before this same block's `finally` releases the
 * network slot below — not from `runGates` after `checkOne` has already
 * returned, which left a window where the slot was already free and a
 * DIFFERENT gate (e.g. another slot's own paid gate, queued for the same
 * slot) could acquire it and reach its own reserve attempt before the halt
 * was visible. T6's own rule: decide synchronously right after the result,
 * before anything else awaits.
 */
async function checkPaid(ctx: Context, gate: QaGate, input: Omit<QaInput, "signal">): Promise<QaVerdict> {
  const { deps, job } = ctx;
  let release: Release;
  try {
    release = await deps.pool.acquire(job.signal, { priority: true });
  } catch {
    throw new GateDropped(); // cancelled while queued: never reserved, never sent
  }
  if (!sending(ctx)) {
    release();
    throw new GateDropped();
  }
  const ms = gate.timeoutMs ?? QA_GATE_TIMEOUT_MS;
  const timeout = timeoutSignal(ms);
  const signal = AbortSignal.any([job.signal, timeout.signal]);
  // Freed on the abort too: a gate that ignores its abort must not hold a network slot (review round 3, L-c).
  signal.addEventListener("abort", release, { once: true });
  // An abort between the grant and this line fired no listener: free the slot now (release is idempotent).
  if (signal.aborted) release();
  try {
    const verdict = await untilAborted(gate.check({ ...input, signal }), signal);
    haltIfLedgerHalted(ctx);
    return verdict;
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    if (!sending(ctx)) throw new GateDropped();
    throw new GateBroken(`the QA gate "${gate.name}" could not run: ${timeout.signal.aborted ? `it took longer than ${ms} ms` : messageOf(error)}`);
  } finally {
    signal.removeEventListener("abort", release);
    release();
    timeout.clear();
  }
}

function checkOne(ctx: Context, gate: QaGate, input: Omit<QaInput, "signal">, afterCancel: boolean): Promise<QaVerdict> {
  return gate.paid ? checkPaid(ctx, gate, input) : checkFree(ctx, gate, input, afterCancel);
}

/**
 * Releases every gate's provisional claim, if any, for one attempt (T7a's
 * pdq gate: a `pass` is not a commitment until the photo is actually
 * stored). `keepImage` calls this in a `finally` around every attempt's
 * gates and store, whatever the outcome — including a successful store,
 * after which the library's own index already carries the hash, so the
 * claim would only ever be redundant if kept, never needed again (T7a
 * review, finding 4): an unstored claim must never outlive its own attempt,
 * or a resume in the same long-lived engine process could read it as a
 * duplicate of a photo that was never actually written.
 *
 * T7a re-review (finding L8): called on every gate in `deps.gates`, not
 * only the ones `runGates` is known to have reached a `pass` verdict for.
 * Tracking "only the gates that passed" relied on `runGates`'s own loop
 * actually finishing its `passed.push(gate)` step for a gate whose `check()`
 * had already claimed internally — a gate whose check raced an abort or a
 * timeout could claim and then never reach that line, leaking the claim.
 * `releaseClaim` is defined to be a harmless no-op for an attempt a gate
 * never actually claimed (`PdqClaims.release`'s own contract), so releasing
 * every gate unconditionally costs nothing and needs no such guarantee.
 */
function releaseClaims(gates: readonly QaGate[], avatarId: string, attemptId: string): void {
  for (const gate of gates) gate.releaseClaim?.(avatarId, attemptId);
}

/**
 * The QA gates in order; the first that does not pass decides. A paid gate
 * is never run once the run stopped sending. `afterCancel`: the image
 * arrived after the user's cancel, and the caller already made sure every
 * gate is free. `keepImage` releases every gate's own claim for this
 * attempt from its own `finally`, unconditionally (finding L8) — this
 * function does not need to track which gates passed for that.
 */
async function runGates(ctx: Context, slot: SlotState, attemptId: string, image: ImageOk, size: { width: number; height: number }, afterCancel: boolean, master: LibraryReference): Promise<GateResult> {
  const { deps, job, plan } = ctx;
  const input: Omit<QaInput, "signal"> = {
    runId: plan.runId,
    jobId: job.jobId,
    avatarId: plan.avatarId,
    attemptId,
    scope: ctx.scope,
    budget: deps.budget,
    priceBook: deps.priceBook,
    slot: slot.slot,
    image: { bytes: image.bytes, mediaType: image.mediaType, ...size },
    // T7a architecture (whole-slice review): every paid gate gets the RUN's
    // own resources, not something wired in once before any run (or any
    // key) exists. `chat` is the same client `runSlot`'s own image attempts
    // use (bound to the run's key, reporting to the run's network pool);
    // `beforeSend` mirrors `AttemptParams.beforeSend` (review L1) so a paid
    // gate's own request never leaves after the run stops sending, even if
    // that happens between this gate's own acquire and its send;
    // `photosByAvatar` reads the run's own library fresh on every call.
    chat: deps.chat,
    beforeSend: () => sending(ctx),
    photosByAvatar: (id) => deps.library.photosByAvatar(id),
    // T7b: the same master reference `runSlot`'s own image attempt already
    // loaded (loadMaster) — never a second library read — and the decode
    // path only the face gate uses.
    master,
    // N10: see Context.masterSha256's own comment.
    masterSha256: ctx.masterSha256,
  };
  let qa: PhotoQa = {};
  for (const gate of deps.gates) {
    if (gate.paid && !sending(ctx)) return { verdict: "dropped" };
    // A paid gate's own halt (T7a re-review, finding L1) is checked inside checkPaid itself,
    // before its network slot is released — not here, which would already be too late.
    const verdict = await checkOne(ctx, gate, input, afterCancel);
    if (verdict.verdict !== "pass") return { verdict: verdict.verdict, gate: gate.name, reason: verdict.reason };
    qa = { ...qa, ...verdict.qa };
  }
  return { verdict: "pass", qa };
}

function photoMeta(ctx: Context, slot: SlotState, attemptId: string, model: string, prompt: string, image: ImageOk, size: { width: number; height: number }, qa: PhotoQa): NewPhotoMeta {
  return {
    mediaType: image.mediaType,
    width: size.width,
    height: size.height,
    // T8b: the run's own requested resolution, stored directly — only this
    // run knows what it asked for (library/photoRecords.ts's resolutionOf
    // is only a read-time fallback for photos stored before this field existed).
    resolution: ctx.plan.request.resolution,
    source: {
      kind: "generated",
      model,
      provider: "openrouter",
      jobId: ctx.job.jobId,
      attemptId,
      promptSha: sha256(prompt),
      prompt,
      slot: slot.slot.attemptIdBase,
      category: contractCategory(slot.slot.category),
      costMicros: image.costMicros,
    },
    qa,
  };
}

/**
 * A paid image through its media checks, the gates and into the library.
 * `next`: done (stored), retry (the slot's next attempt), end (the slot ends
 * without a photo), stop (nothing more for this slot in this job).
 */
async function keepImage(ctx: Context, slot: SlotState, attemptId: string, model: string, prompt: string, image: ImageOk, master: LibraryReference): Promise<{ next: "done" | "retry" | "end" | "stop"; error?: EngineError }> {
  const { deps, job, plan } = ctx;
  const size = imageSize(image.bytes);
  if (size === null || isAnimatedImage(image.bytes)) {
    const error: EngineError = { code: "INTERNAL", detail: `the ${image.mediaType} image ${size === null ? "has no readable size" : "is animated; only a still image can be stored as a photo"}` };
    await attemptEvent(ctx, slot, attemptId, model, "unusable", { error });
    return { next: "retry", error };
  }
  // An image that arrived after the user's cancel is paid for: kept if its gates are all free (review round 3, b) —
  // a paid gate would be a new request after the cancel, and none may be skipped (invariant 8). A broken gate
  // cannot judge any image. Otherwise it is dropped.
  const afterCancel = job.signal.aborted;
  if (ctx.gatesBroken || (afterCancel && deps.gates.some((gate) => gate.paid))) {
    await attemptEvent(ctx, slot, attemptId, model, "dropped");
    return { next: "stop" };
  }
  // T7a review (finding 4, re-review finding L8): every gate in deps.gates has its own claim for
  // this attempt released in the `finally` below, unconditionally, whatever the outcome — so an
  // unstored (or even a stored) claim never outlives its own attempt, and a gate that never ran (an
  // earlier one ended the attempt first) or whose own check raced an abort is still covered.
  try {
    let gates: GateResult;
    try {
      gates = await runGates(ctx, slot, attemptId, image, size, afterCancel, master);
    } catch (error) {
      if (error instanceof GateFailure) {
        // T7a review (finding 8): a limit (the run's cap, the month) stops only this slot, mirroring
        // ctx.limited for an image's own reserve refusal — other slots may still have room. Anything
        // else (finding 2/6: transient or fatal, classified like an image's own failure) stops the
        // whole run, its exact T0 code preserved (AUTH_INVALID still marks the key rejected).
        const limit = error.error.code === "BUDGET_EXCEEDED" || error.error.code === "RUN_CAP_EXCEEDED";
        if (limit) ctx.limited ??= error.error;
        else stopSending(ctx, error.error);
        await attemptEvent(ctx, slot, attemptId, model, "failed", { error: error.error });
        return { next: "stop" };
      }
      if (afterCancel || !(error instanceof GateBroken)) {
        // A cancel cut a gate short, or a free gate failed on an image that arrived after it: the image is dropped (review L9).
        await attemptEvent(ctx, slot, attemptId, model, "dropped");
        return { next: "stop" };
      }
      // Systemic: every later image would meet the same gate. Stop sending before anything else awaits.
      const failure: EngineError = { code: "INTERNAL", detail: truncate(error.message) };
      ctx.gatesBroken = true;
      stopSending(ctx, failure);
      await attemptEvent(ctx, slot, attemptId, model, "failed", { error: failure });
      return { next: "stop" };
    }
    if (gates.verdict === "dropped") {
      await attemptEvent(ctx, slot, attemptId, model, "dropped");
      return { next: "stop" };
    }
    if (gates.verdict !== "pass") {
      const error: EngineError = { code: "QA_REJECTED", detail: truncate(`the QA gate "${gates.gate}" ${gates.verdict === "retry" ? "asked for another attempt" : "rejected the photo"}: ${gates.reason}`) };
      await attemptEvent(ctx, slot, attemptId, model, gates.verdict === "retry" ? "qa-retry" : "qa-reject", { error });
      return gates.verdict === "retry" ? { next: "retry", error } : { next: "end", error };
    }
    const photo = await deps.library.addPhoto(plan.avatarId, image.bytes, photoMeta(ctx, slot, attemptId, model, prompt, image, size, gates.qa));
    await attemptEvent(ctx, slot, attemptId, model, "passed", { photoId: photo.id });
    await endSlot(ctx, slot, { status: "done", photoId: photo.id });
    // The planner's hint for the next run (recentPairs); a failure here must not undo a stored photo.
    await deps.library.appendHistory(plan.avatarId, { location: slot.slot.location, outfit: slot.slot.outfit, at: at(ctx) }).catch((error: unknown) => {
      deps.warn?.(`studio engine: run ${plan.runId} could not record slot ${slot.slot.slotIndex}'s scene in the avatar's history (${messageOf(error)})`);
    });
    return { next: "done" };
  } finally {
    releaseClaims(deps.gates, plan.avatarId, attemptId);
  }
}

/** Why a slot whose one fallback attempt is used up ends, as truthfully as its record allows (review L2). */
function fallbackEndError(slot: SlotState, lastError: EngineError | null): EngineError {
  if (lastError !== null) return lastError;
  const refused = "the primary model refused this scene, and the fallback's one attempt";
  switch (slot.fallbackEnd) {
    case "aborted":
      return { code: "MODERATION_REFUSED", detail: `${refused} was cancelled before it answered` };
    case "dropped":
      return { code: "MODERATION_REFUSED", detail: `${refused} answered after its run had stopped, and its image was not kept` };
    case "unknown":
    case null:
      return { code: "MODERATION_REFUSED", detail: `${refused} was interrupted before its outcome was recorded` };
    case "failed":
      return slot.fallbackError ?? { code: "MODERATION_REFUSED", detail: `${refused} failed` };
    default:
      return slot.fallbackError ?? { code: "MODERATION_REFUSED", detail: `${refused} gave no usable photo` };
  }
}

/**
 * One slot's attempts until it ends, the run stops sending, or the Budget
 * refuses its next reserve. Every decision that stops other slots is made
 * synchronously right after a result comes back, before anything awaits,
 * and every request asks `sending` once more right before it leaves (the
 * client's `beforeSend`, review L1): no request is sent after a cancel or a
 * halt, even one whose reserve was already on its way to disk — that one is
 * released unsent.
 */
async function runSlot(ctx: Context, slot: SlotState, prompt: string, master: LibraryReference): Promise<void> {
  const { deps, job } = ctx;
  const ledger: LedgerView = { reserveOf: (id) => deps.budget.ledger.reserveOf(id), closeOf: (id) => deps.budget.ledger.closeOf(id) };
  let lastError: EngineError | null = null;
  for (;;) {
    if (!sending(ctx)) return;
    if (slot.fallbackUsed) return endSlot(ctx, slot, { status: "failed", error: fallbackEndError(slot, lastError) });
    // Invariant 7: at most three PAID attempts; free failures used spare ids (review round 3).
    if (paidAttempts(slot, ledger) >= RUN_ATTEMPTS_PER_SLOT) {
      return endSlot(ctx, slot, { status: "failed", error: lastError ?? { code: "INTERNAL", detail: `slot ${slot.slot.slotIndex} used its ${RUN_ATTEMPTS_PER_SLOT} paid attempts` } });
    }
    const attemptId = nextAttemptId(slot);
    if (attemptId === null) {
      return endSlot(ctx, slot, { status: "failed", error: lastError ?? { code: "INTERNAL", detail: `every attempt of slot ${slot.slot.slotIndex} was already used` } });
    }
    const onFallback = slot.useFallbackNext && ctx.fallback !== null;
    const choice = onFallback && ctx.fallback !== null ? ctx.fallback : ctx.primary;

    let release: Release;
    try {
      release = await deps.pool.acquire(job.signal);
    } catch {
      return; // cancelled while queued: never reserved, never sent
    }
    if (!sending(ctx)) {
      release();
      return;
    }
    slot.consumed.add(attemptId);
    slot.useFallbackNext = false;
    if (onFallback) slot.fallbackUsed = true;
    let result: ImageResult;
    try {
      result = await deps.generateImage({
        attemptId,
        jobId: job.jobId,
        scope: ctx.scope,
        model: choice.model,
        budget: deps.budget,
        priceBook: deps.priceBook,
        signal: job.signal,
        beforeSend: () => sending(ctx),
        prompt,
        resolution: choice.resolution,
        aspectRatio: RUN_ASPECT_RATIO,
        quality: choice.quality,
        references: [master],
      });
    } finally {
      release();
    }

    switch (result.status) {
      case "blocked": {
        // Nothing was reserved or sent: the id stays free for a later job.
        slot.consumed.delete(attemptId);
        if (onFallback) {
          slot.fallbackUsed = false;
          slot.useFallbackNext = true;
        }
        const failure = classifyFailure(result);
        if (failure.kind === "limit") ctx.limited ??= failure.error;
        else stopSending(ctx, failure.error);
        return;
      }
      case "aborted":
        // A cancel, or the run stopped just before this request would have left.
        await attemptEvent(ctx, slot, attemptId, choice.model, "aborted");
        return;
      case "refused": {
        const error: EngineError = { code: "MODERATION_REFUSED", detail: truncate(result.message) };
        lastError = error;
        const canFallBack = !onFallback && ctx.fallback !== null && !slot.fallbackUsed;
        slot.useFallbackNext = canFallBack;
        await attemptEvent(ctx, slot, attemptId, choice.model, "refused", { error });
        if (!canFallBack) return endSlot(ctx, slot, { status: "failed", error });
        continue;
      }
      case "error": {
        const failure = classifyFailure(result);
        if (failure.kind !== "next-attempt") stopSending(ctx, failure.error);
        lastError = failure.error;
        await attemptEvent(ctx, slot, attemptId, choice.model, "failed", { error: failure.error });
        if (failure.kind !== "next-attempt") return;
        continue;
      }
      case "ok": {
        // Billed above its worst case: the price table is wrong, nothing more is sent — but the image is paid for and kept (review M1).
        if (result.aboveWorst) stopSending(ctx, { code: "SETTLE_ABOVE_WORST", detail: `attempt ${attemptId} was billed ${result.costMicros} µ$, above its reserved worst case; the price table is wrong` });
        const kept = await keepImage(ctx, slot, attemptId, choice.model, prompt, result, master);
        if (kept.next === "done" || kept.next === "stop") return;
        lastError = kept.error ?? lastError;
        if (kept.next === "end") return endSlot(ctx, slot, { status: "failed", error: kept.error ?? { code: "QA_REJECTED" } });
        continue;
      }
    }
  }
}

function endOf(ctx: Context, slots: readonly SlotState[]): RunJobEnd {
  const open = slots.some((s) => s.end === null);
  if (ctx.job.signal.aborted && open) return { status: "cancelled" };
  if (ctx.halt !== null) return { status: "failed", error: ctx.halt };
  if (open) return { status: "failed", error: ctx.limited ?? { code: "INTERNAL", detail: `run ${ctx.plan.runId} stopped with slots left` } };
  const photoIds = slots.flatMap((s) => (s.end?.status === "done" ? [s.end.photoId] : []));
  return { status: "done", photoIds, failedSlots: slots.length - photoIds.length };
}

async function work(ctx: Context): Promise<RunJobEnd> {
  const { deps, job, plan } = ctx;
  await journal(ctx, { type: "job", jobId: job.jobId, status: "started", at: at(ctx) });
  const state = foldRun(plan, {
    events: (await deps.library.readJournal(plan.runId, RunEventSchema)).events,
    reserveOf: (attemptId) => deps.budget.ledger.reserveOf(attemptId),
    closeOf: (attemptId) => deps.budget.ledger.closeOf(attemptId),
    photos: deps.library.photosByAvatar(plan.avatarId),
  });
  ctx.total = state.slots.length;
  ctx.done = state.slots.filter((s) => s.end !== null).length;
  if (job.signal.aborted) return { status: "cancelled" };

  const reference = await loadMaster(ctx);
  if (!reference.ok) return reference.end;
  const prepared = await prepareGates(ctx, reference.master);
  if (!prepared.ok) return prepared.end;
  const prompts = await promptsOf(ctx, state, reference.master);
  if (!prompts.ok) return prompts.end;

  const open = state.slots.filter((s) => s.end === null);
  await Promise.all(
    open.map(async (slot) => {
      const prompt = prompts.prompts.get(slot.slot.slotIndex);
      try {
        if (prompt === undefined) throw new Error(`run ${plan.runId} has no prompt for slot ${slot.slot.slotIndex}`);
        await runSlot(ctx, slot, prompt, reference.master);
      } catch (error) {
        // A ledger or library write that failed, or a bug: stop sending.
        stopSending(ctx, deps.errorOf(error));
      }
    }),
  );
  return endOf(ctx, state.slots);
}

/** Runs one job of the run to its end. Never throws: whatever fails ends it as failed. */
export async function runPhotoRun(deps: RunJobDeps, job: RunJob): Promise<RunJobEnd> {
  const route = runRoute(job.plan.models.image, job.plan.request.resolution);
  const ctx: Context = {
    deps,
    job,
    plan: job.plan,
    scope: { runId: job.plan.runId },
    primary: route[0],
    fallback: route[1] ?? null,
    halt: null,
    gatesBroken: false,
    limited: null,
    done: 0,
    total: job.plan.scenes.slots.length,
    masterSha256: null,
  };
  let end: RunJobEnd;
  try {
    end = await work(ctx);
  } catch (error) {
    end = { status: "failed", error: deps.errorOf(error) };
  }
  const record = end.status === "failed" ? { status: "failed" as const, error: end.error } : { status: end.status };
  await journal(ctx, { type: "job", jobId: job.jobId, ...record, at: at(ctx) }).catch((error: unknown) => {
    deps.warn?.(`studio engine: the end of run ${job.plan.runId}'s job ${job.jobId} could not be journaled (${messageOf(error)})`);
  });
  return end;
}
