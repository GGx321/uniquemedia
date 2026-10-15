import type { EngineError, EventMessage, JobState, MoneyStatus, PhotoSummary } from "../../shared/engine";
import type { MockClipScript } from "./mockClips";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA, scenePhoto } from "./mockEngine.testkit";
import { ManualScheduler } from "./scheduler";

// Test support for the mock's batch tests (Stage 5, 5b.2, S5.WB3): a mock on a manual clock with a gallery of ordinary frames (each judged, three code motions), the batch commands as the window sends
// them, and the reads the batch tests share. Every figure the tests expect is the ENGINE's (engine.clipBatch.*.test.ts, clips/batch.test.ts), so a drift of the mock from the engine reads as a failing number.

export const AVATAR = MIA.avatarId;

/** `n` ordinary frames: each has a likeness (a face score), so each is judged and offers the three code motions. */
export function plainFrames(n: number): PhotoSummary[] {
  return Array.from({ length: n }, (_, i) => scenePhoto(i + 1, { qa: { faceCos: 0.86 } }));
}

/** A frame of «Смелая» (nightwear), judged. */
export const BOLD_FRAME: PhotoSummary = scenePhoto(21, { category: "nightwear", qa: { faceCos: 0.86 } });
/** A frame the age check did not call adult. */
export const AGED_FRAME: PhotoSummary = scenePhoto(22, { qa: { faceCos: 0.7, age: { adult: false, confidence: 0.9 } } });

export type BatchMock = ReturnType<typeof makeBatchMock>;

export function makeBatchMock(frames = 4, options: ConstructorParameters<typeof MockEngine>[0] = {}, extra: PhotoSummary[] = []) {
  const scheduler = new ManualScheduler();
  const photos = [...plainFrames(frames), ...extra];
  const engine = new MockEngine({ scheduler, avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos, clips: { timings: "short" }, ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  /** The mock's clock (epoch ms) as each event was announced, parallel to `events`. */
  const at: number[] = [];
  client.subscribe((e) => {
    events.push(e);
    at.push(engine.peekClips().nowMs);
  });
  return { scheduler, engine, client, events, at, photoIds: photos.map((p) => p.photoId) };
}

type Reply<T> = { ok: true; result: T } | { ok: false; error: EngineError };

export async function unwrap<T>(reply: Promise<Reply<T>>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.detail ?? ""}`);
  return r.result;
}

export async function refusal(reply: Promise<{ ok: boolean; error?: EngineError }>): Promise<EngineError> {
  const r = await reply;
  if (r.ok || r.error === undefined) throw new Error("expected a refusal");
  return r.error;
}

export interface BatchOptions {
  avatarId?: string;
  motionId?: string;
  motionIds?: Readonly<Record<number, string>>;
  quality?: "std" | "pro";
  seconds?: 5 | 10;
  fallback?: "auto" | "none";
  /** Default: 850 000 µ$ per item, the worst case of a std 5 s clip with Grok behind it. */
  acceptedWorstMicros?: number;
}

export function batchPayload(photoIds: readonly string[], over: BatchOptions = {}) {
  return {
    avatarId: over.avatarId ?? AVATAR,
    items: photoIds.map((photoId, i) => ({ photoId, motionId: over.motionIds?.[i] ?? over.motionId ?? "g-blink" })),
    quality: over.quality ?? ("std" as const),
    seconds: over.seconds ?? (5 as const),
    fallback: over.fallback ?? ("auto" as const),
    acceptedWorstMicros: over.acceptedWorstMicros ?? photoIds.length * 850_000,
  };
}

export function createBatch(m: BatchMock, photoIds: readonly string[], over: BatchOptions = {}) {
  return m.client.request("clips.createBatch", batchPayload(photoIds, over));
}

export async function startBatch(m: BatchMock, photoIds: readonly string[], over: BatchOptions = {}): Promise<{ batchId: string; jobIds: string[] }> {
  return unwrap(createBatch(m, photoIds, over));
}

export function batchOptions(m: BatchMock, photoIds: readonly string[], avatarId = AVATAR) {
  return m.client.request("clips.batchOptions", { avatarId, photoIds: [...photoIds] });
}

export function cancelBatch(m: BatchMock, batchId: string, avatarId = AVATAR) {
  return m.client.request("clips.cancelBatch", { avatarId, batchId });
}

/** Runs the manual clock one task at a time until `done`, and no further: later timers (holds) stay pending, as they are in the engine. */
export function stepUntil(m: BatchMock, done: () => boolean, what = "the condition"): void {
  for (let i = 0; i < 6_000 && !done(); i++) if (!m.scheduler.next()) break;
  if (!done()) throw new Error(`never reached ${what}`);
}

export function clipProgress(events: readonly EventMessage[], jobId: string) {
  return events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId ? [e.payload] : []));
}

export function phasesOf(events: readonly EventMessage[], jobId: string): string[] {
  return clipProgress(events, jobId).map((p) => p.phase);
}

export function endOf(events: readonly EventMessage[], jobId: string): EventMessage | undefined {
  return events.find((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.jobId === jobId);
}

/** The reason a cancelled member's end event gives, or undefined for any other end. */
export function detailOf(end: EventMessage | undefined): string | undefined {
  return end?.type === "job.cancelled" && end.payload.kind === "clip" ? end.payload.detail : undefined;
}

export const typeOf = (end: EventMessage | undefined): string | undefined => end?.type;

/** Plays the clock until every job has ended (the holds stay pending: the clock stops at the last end). */
export function runUntilEnds(m: BatchMock, jobIds: readonly string[]): void {
  stepUntil(m, () => jobIds.every((id) => endOf(m.events, id) !== undefined), "the end of every job");
}

export function endsOf(m: BatchMock, jobIds: readonly string[]): (EventMessage | undefined)[] {
  return jobIds.map((id) => endOf(m.events, id));
}

export async function jobState(m: BatchMock, jobId: string): Promise<Extract<JobState, { kind: "clip" }> | undefined> {
  const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
  return snapshot.jobs.flatMap((j) => (j.kind === "clip" && j.jobId === jobId ? [j] : []))[0];
}

export async function money(m: BatchMock): Promise<Extract<MoneyStatus, { ledger: "open" }>> {
  const status = await unwrap(m.client.request("money.status", {}));
  if (status.ledger !== "open") throw new Error("the ledger is not open");
  return status;
}

/** The script of every member, in the order their first POSTs leave. */
export function script(m: BatchMock, scripts: readonly MockClipScript[]): void {
  m.engine.scriptNextBatch(scripts);
}

/** The attempts the mock's ledger holds, in order: [attemptId, state, worst, cost]. */
export function ledger(m: BatchMock): [string, string, number, number][] {
  return m.engine.peekClips().attempts.map((a) => [a.attemptId, a.state, a.worstMicros, a.costMicros]);
}

/** The most reserves of clips open at one moment, from the order the lines were written (reserve at its own `reserveAtMs`, closed at its settle): in the mock a settle never precedes its reserve. */
export function mostOpenReserves(events: readonly EventMessage[]): number {
  let open = 0;
  let most = 0;
  for (const e of events) {
    if (e.type !== "money.changed" || e.payload.status.ledger !== "open") continue;
    open = e.payload.status.unsettledCount;
    most = Math.max(most, open);
  }
  return most;
}
