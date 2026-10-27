import { ResponseMessage, type EventMessage, type JobState } from "../../../shared/engine";
import { manifestTraits } from "../../avatars/records";
import { openLibrary } from "../../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/helpers";
import { SAMPLE_SOURCE } from "../../library/testing/sampleData";
import { GOOD, TRAITS } from "../../testing/engineHarness";
import { command, photoJpeg, type ClipEngine, type SeedOptions } from "./engineClipKit";

// Test-only (S5.WB2): a library with several gallery photos on one avatar, the batch commands as the window sends them, and the reads the batch tests share: the member jobs, the events of a
// batch, and the one money invariant a batch must keep on every path (never two members between their reserve and their settle).

let seeded = 0;

/** An active avatar with a master photo and one gallery photo per entry of `photos` (a planless frame each, as `seedClipAvatar` makes one). */
export async function seedBatchAvatar(libraryDir: string, photos: readonly SeedOptions[]): Promise<{ avatarId: string; photoIds: string[]; masterId: string }> {
  const { library } = await openLibrary(libraryDir, { now: steppingClock(), newId: sequentialIds(`batch${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Nini", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photoIds: string[] = [];
  for (const [index, options] of photos.entries()) {
    const bytes = options.photo ?? (await photoJpeg(options.width, options.height));
    const photo = await library.addPhoto(avatar.id, bytes, {
      mediaType: "image/jpeg",
      width: options.width ?? 720,
      height: options.height ?? 1280,
      source: { ...SAMPLE_SOURCE, category: options.category ?? "home", attemptId: `run-00000099:slot-${index + 1}#1`, slot: `slot-${index + 1}`, ...(options.route === undefined ? {} : { route: options.route }) },
      qa: options.qa ?? { faceCos: 0.7 },
    });
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds, masterId: master.id };
}

/** `n` plain «home» frames. */
export const plainPhotos = (n: number): SeedOptions[] => Array.from({ length: n }, () => ({}));

export interface BatchPayload {
  avatarId: string;
  photoIds: readonly string[];
  /** One motion id for every item (default `g-blink`, a bank motion every «home» frame offers); an entry of `motionIds` overrides it for its item. */
  motionId?: string;
  motionIds?: Readonly<Record<number, string>>;
  quality?: "std" | "pro";
  seconds?: 5 | 10;
  fallback?: "auto" | "none";
  /** Default: 850 000 µ$ per item, the worst case of a std 5 s clip with Grok behind it. */
  acceptedWorstMicros?: number;
}

export function createBatchCommand(payload: BatchPayload): unknown {
  return command("clips.createBatch", {
    avatarId: payload.avatarId,
    items: payload.photoIds.map((photoId, i) => ({ photoId, motionId: payload.motionIds?.[i] ?? payload.motionId ?? "g-blink" })),
    quality: payload.quality ?? "std",
    seconds: payload.seconds ?? 5,
    fallback: payload.fallback ?? "auto",
    acceptedWorstMicros: payload.acceptedWorstMicros ?? payload.photoIds.length * 850_000,
  });
}

export async function createBatch(started: ClipEngine, payload: BatchPayload): Promise<ResponseMessage> {
  return started.engine.handle(createBatchCommand(payload));
}

export async function batchOptions(started: ClipEngine, avatarId: string, photoIds: readonly string[]): Promise<ResponseMessage> {
  return started.engine.handle(command("clips.batchOptions", { avatarId, photoIds }));
}

export async function cancelBatch(started: ClipEngine, avatarId: string, batchId: string): Promise<ResponseMessage> {
  return started.engine.handle(command("clips.cancelBatch", { avatarId, batchId }));
}

export function batchOf(response: ResponseMessage): { batchId: string; jobIds: string[] } {
  if (!response.ok || response.type !== "clips.createBatch") throw new Error(`expected a clips.createBatch answer, got ${JSON.stringify(response)}`);
  return response.result;
}

/** Every job state of the engine now (the snapshot's `jobs`). */
export async function jobsOf(started: ClipEngine): Promise<JobState[]> {
  const answer = await started.engine.handle(command("engine.snapshot"));
  if (!answer.ok || answer.type !== "engine.snapshot") throw new Error(`no snapshot: ${JSON.stringify(answer)}`);
  return answer.result.jobs;
}

export async function clipJob(started: ClipEngine, jobId: string): Promise<Extract<JobState, { kind: "clip" }> | undefined> {
  const job = (await jobsOf(started)).find((state) => state.jobId === jobId);
  return job?.kind === "clip" ? job : undefined;
}

/** The terminal event of each of these jobs, once every one has ended. */
export function endsOf(started: ClipEngine, jobIds: readonly string[]): EventMessage[] {
  const terminal = new Set(["job.done", "job.failed", "job.cancelled"]);
  return jobIds.flatMap((jobId) => started.events().filter((e) => terminal.has(e.type) && "jobId" in e.payload && e.payload.jobId === jobId));
}

/**
 * The most clip reserves ever open at once in this ledger, in line order: a batch is ONE money unit at a time (I5.61), so it must never be above 1. A reserve opens at its line, and a settle or a
 * release closes it. (An open reserve of an earlier process counts too.)
 */
export function mostOpenClipReserves(lines: readonly Record<string, unknown>[]): number {
  const open = new Set<string>();
  let most = 0;
  for (const line of lines) {
    const attemptId = String(line.attemptId);
    if (line.type === "reserve") open.add(attemptId);
    else if (line.type === "settle" || line.type === "release") open.delete(attemptId);
    most = Math.max(most, open.size);
  }
  return most;
}
