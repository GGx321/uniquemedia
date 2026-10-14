import type { ClipSummary, EngineError, EventMessage, MediaSummary, MontageDraft } from "../../shared/engine";
import { CLIP_PHOTOS, create, makeClipMock, runUntilEnd, type ClipMock, unwrap } from "./mockEngine.clips.testkit";
import { MIA, SOFIA } from "./mockEngine.testkit";

// Test support for the mock's montage copies of clips (Stage 5, 5b.2, S5.WA3): a mock on a manual clock with two active avatars and the clip photos of the first, and the helpers that make a ready
// clip, import its copy, build a spec that holds copies, and play a render to its end. Every expectation in the tests is the ENGINE's (engine.importClip.test.ts, engine.clipFrames.test.ts).

export { CLIP_PHOTOS, MIA, SOFIA };
export const AVATAR = MIA.avatarId;

export function makeCopyMock(options: Parameters<typeof makeClipMock>[0] = {}): ClipMock {
  const photos = Object.values(CLIP_PHOTOS);
  return makeClipMock({
    avatars: [
      { ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length },
      { ...SOFIA, photoCount: 0, eligibleUnusedCount: 0 },
    ],
    ...options,
  });
}

/** Makes a clip of `photoId` (the plain frame by default) and plays it to its end; the clip's id (a clip's id is its create job's). */
export async function readyClip(m: ClipMock, over: { photoId?: string; fallback?: "auto" | "none"; acceptedWorstMicros?: number } = {}): Promise<string> {
  const { jobId } = await unwrap(create(m, over));
  runUntilEnd(m, jobId);
  return jobId;
}

export async function importReply(m: ClipMock, clipId: string, avatarId: string = AVATAR) {
  return m.client.request("media.importClip", { avatarId, clipId });
}

/** The id of the import job `media.importClip` started; throws for any other answer. */
export async function startImport(m: ClipMock, clipId: string, avatarId: string = AVATAR): Promise<string> {
  const reply = await unwrap(importReply(m, clipId, avatarId));
  if (!("jobId" in reply)) throw new Error("expected an import job, got a live copy");
  return reply.jobId;
}

/** Imports the clip's copy and plays the job to its end: the copy's media id. */
export async function importCopy(m: ClipMock, clipId: string, avatarId: string = AVATAR): Promise<string> {
  const reply = await unwrap(importReply(m, clipId, avatarId));
  if ("mediaId" in reply) return reply.mediaId;
  runUntilEnd(m, reply.jobId);
  const done = m.events.find((e) => e.type === "job.done" && e.payload.jobId === reply.jobId);
  if (done === undefined || done.type !== "job.done" || done.payload.result.kind !== "import") throw new Error("the import did not end done");
  return done.payload.result.mediaId;
}

/** A ready clip's copy in one step. */
export async function copyOfNewClip(m: ClipMock, over: Parameters<typeof readyClip>[1] = {}): Promise<{ clipId: string; mediaId: string }> {
  const clipId = await readyClip(m, over);
  return { clipId, mediaId: await importCopy(m, clipId) };
}

export async function mediaOf(m: ClipMock): Promise<MediaSummary[]> {
  return (await unwrap(m.client.request("media.list", { kind: "video" }))).media;
}

export async function clipsOf(m: ClipMock, avatarId: string = AVATAR): Promise<ClipSummary[]> {
  return (await unwrap(m.client.request("clips.list", { avatarId }))).clips;
}

/** `ClipSummary.use` of a clip: only a ready clip has one. */
export async function useOf(m: ClipMock, clipId: string, avatarId: string = AVATAR) {
  const clip = await clipOf(m, clipId, avatarId);
  return clip.status === "ready" ? clip.use : undefined;
}

export async function clipOf(m: ClipMock, clipId: string, avatarId: string = AVATAR): Promise<ClipSummary> {
  return (await unwrap(m.client.request("clips.get", { avatarId, clipId }))).clip;
}

// ---------- specs ----------

export const photoClip = (n: number, photoId: string, durationMs = 2_000) => ({
  clipId: `clip-000000${n}`,
  kind: "photo" as const,
  cell: { photo: { source: "scene" as const, photoId }, focus: null },
  motion: "static" as const,
  durationMs,
  transitionIn: "cut" as const,
});

export const videoClip = (n: number, mediaId: string, durationMs = 2_000) => ({ clipId: `clip-000000${n}`, kind: "video" as const, mediaId, trimStartMs: 0, focus: null, durationMs, transitionIn: "cut" as const });

export function specOf(clips: MontageDraft["clips"], avatarId: string = AVATAR): MontageDraft {
  return { schemaVersion: 1, avatarId, layers: [], music: null, seed: 7, clips };
}

export async function renderSpec(m: ClipMock, spec: MontageDraft) {
  return m.client.request("videos.render", { spec });
}

/** Plays every pending timer: the renders end (the holds of the clips' money go too, which these tests do not look at). */
export function settle(m: ClipMock): void {
  m.scheduler.runAll();
}

export async function errorOf(reply: Promise<{ ok: boolean; error?: EngineError }>): Promise<EngineError> {
  const r = await reply;
  if (r.ok || r.error === undefined) throw new Error("expected a refusal");
  return r.error;
}

export function eventsOfType<T extends EventMessage["type"]>(events: readonly EventMessage[], type: T): Extract<EventMessage, { type: T }>[] {
  return events.filter((e): e is Extract<EventMessage, { type: T }> => e.type === type);
}

/** The photo as `photos.list` shows it. */
export async function photoOf(m: ClipMock, photoId: string, avatarId: string = AVATAR) {
  const photos = (await unwrap(m.client.request("photos.list", { avatarId }))).photos;
  const found = photos.find((p) => p.photoId === photoId);
  if (found === undefined) throw new Error(`no photo ${photoId}`);
  return found;
}
