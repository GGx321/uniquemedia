import type { ClipOptions, ClipSummary, EngineError, ErrorCode, EventMessage, MoneyStatus, PhotoSummary, ReconcileResult } from "../../shared/engine";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA, scenePhoto } from "./mockEngine.testkit";
import { ManualScheduler } from "./scheduler";

// Test support for the mock's clip tests (Stage 5, 5b.1, S5.V7): a mock on a manual clock behind the same validating client the renderer uses, with the photos a clip's rules tell apart.
// Every figure the tests below expect is the ENGINE's (engine.clips.*.test.ts), so a drift of the mock from the engine reads as a failing number here.

/** Mia's photos by what a clip makes of them (a photo with no plan is judged by its own face marks: engine/clips/frameFacts.ts, `planlessFacts`). */
export const CLIP_PHOTOS = {
  /** An ordinary frame with a likeness and no mark: judged, three code motions. */
  plain: scenePhoto(1),
  /** No face score: not known to show her face, so no motion. */
  unknown: scenePhoto(2),
  /** A frame of «Смелая» (nightwear), judged. */
  bold: scenePhoto(3, { category: "nightwear" }),
  /** The age check did not call it adult. */
  aged: scenePhoto(5, { qa: { faceCos: 0.7, age: { adult: false, confidence: 0.9 } } }),
  /** The face gate marked it (a face-hidden frame): never judged. */
  hidden: scenePhoto(7, { qa: { faceCos: 0.48, faceMarked: true } }),
  /** A second frame of «Смелая»: a beach. */
  beach: scenePhoto(9, { category: "beach" }),
} as const satisfies Record<string, PhotoSummary>;

export const ALL_CLIP_PHOTOS: PhotoSummary[] = Object.values(CLIP_PHOTOS);

export const AVATAR = MIA.avatarId;

export function makeClipMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [{ ...MIA, photoCount: ALL_CLIP_PHOTOS.length, eligibleUnusedCount: ALL_CLIP_PHOTOS.length }], photos: ALL_CLIP_PHOTOS, ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

export type ClipMock = ReturnType<typeof makeClipMock>;

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

export interface CreateOptions {
  avatarId?: string;
  photoId?: string;
  motionId?: string;
  model?: "kling" | "grok";
  quality?: "std" | "pro";
  seconds?: 5 | 10;
  fallback?: "auto" | "none";
  acceptedWorstMicros?: number;
}

export function createPayload(over: CreateOptions = {}) {
  return {
    avatarId: AVATAR,
    photoId: CLIP_PHOTOS.plain.photoId,
    motionId: "g-blink",
    model: "kling" as const,
    quality: "std" as const,
    seconds: 5 as const,
    fallback: "auto" as const,
    acceptedWorstMicros: 850_000,
    ...over,
  };
}

export function create(m: ClipMock, over: CreateOptions = {}) {
  return m.client.request("clips.create", createPayload(over));
}

/**
 * Runs the mock's clock one task at a time until the job has ended, and no further: the holds and every timer that belongs to a LATER moment are left pending, as they are in the engine
 * (a clip that ended is still held for the reconcile). `m.scheduler.runAll()` is the other thing: it lets every timer go, the holds' included.
 */
export function runUntilEnd(m: ClipMock, jobId: string): void {
  for (let i = 0; i < 2_000 && endOf(m.events, jobId) === undefined; i++) if (!m.scheduler.next()) break;
}

/** Creates a clip and plays it to the end of its job; returns the job's id. */
export async function runClip(m: ClipMock, over: CreateOptions = {}): Promise<string> {
  const { jobId } = await unwrap(create(m, over));
  runUntilEnd(m, jobId);
  return jobId;
}

export async function listClips(m: ClipMock, avatarId = AVATAR): Promise<ClipSummary[]> {
  return (await unwrap(m.client.request("clips.list", { avatarId }))).clips;
}

export async function onlyClip(m: ClipMock): Promise<ClipSummary> {
  const clips = await listClips(m);
  const [clip] = clips;
  if (clips.length !== 1 || clip === undefined) throw new Error(`expected one clip, got ${clips.length}`);
  return clip;
}

export async function optionsOf(m: ClipMock, photoId = CLIP_PHOTOS.plain.photoId): Promise<ClipOptions> {
  return unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId }));
}

export async function suitable(m: ClipMock, photoId = CLIP_PHOTOS.plain.photoId): Promise<Extract<ClipOptions, { suitable: true }>> {
  const answer = await optionsOf(m, photoId);
  if (!answer.suitable) throw new Error(`expected a suitable photo, got ${answer.reason}`);
  return answer;
}

export async function money(m: ClipMock): Promise<Extract<MoneyStatus, { ledger: "open" }>> {
  const status = await unwrap(m.client.request("money.status", {}));
  if (status.ledger !== "open") throw new Error("the ledger is not open");
  return status;
}

export async function reconcile(m: ClipMock): Promise<{ ok: true; result: ReconcileResult } | { ok: false; code: ErrorCode }> {
  const reply = await m.client.request("money.reconcile", {});
  return reply.ok ? { ok: true, result: reply.result } : { ok: false, code: reply.error.code };
}

/** The `job.progress` events of one clip job, in order. */
export function progressOf(events: readonly EventMessage[], jobId: string) {
  return events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId ? [e.payload] : []));
}

export function phasesOf(events: readonly EventMessage[], jobId: string): string[] {
  return progressOf(events, jobId).map((p) => p.phase);
}

/** The job's terminal event (done, failed or cancelled), or undefined while it runs. */
export function endOf(events: readonly EventMessage[], jobId: string): EventMessage | undefined {
  return events.find((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.jobId === jobId);
}

export function moneyEvents(events: readonly EventMessage[]): MoneyStatus[] {
  return events.flatMap((e) => (e.type === "money.changed" ? [e.payload.status] : []));
}
