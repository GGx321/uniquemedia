import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ResponseMessage, type ClipSummary } from "../shared/engine";
import { clipAttemptId } from "./clips/journal";
import { journalOf, readClipRecord, writeClipRecord } from "./clips/store";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "./clips/timings";
import { clipMp4, clipNetwork, clipsDir, command, create, jobEnd, jobIdOf, seedClipAvatar, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { NOW, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1 (S5.V4a1 follow-up, plan s5b1 §5.2): the clip records' commands through the engine's dispatch: `clips.list`, `clips.get`, `clips.markSeen`, `clips.delete` and
// `clips.retryDownload` reach the records the clip service holds, and their answers are the contract's. A delete of a clip a recovery works on is refused `job-running`.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clips-records-");
const libraryDir = () => join(dir(), "library");
const MIN = 60_000;
/** The short set with a long give-up time, so a slow machine never turns a recovery into `late`. */
const TIMINGS: ClipTimings = { ...SHORT_CLIP_TIMINGS, lateGiveUpMs: 10 * MIN, holdSubmittedMs: 10 * MIN };

async function answer(engine: ClipEngine, type: string, payload: object): Promise<ResponseMessage> {
  const response = await engine.engine.handle(command(type, payload));
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  return response;
}

function resultOf<T>(response: ResponseMessage, type: string): T {
  if (!response.ok || response.type !== type) throw new Error(`expected ${type}, got ${JSON.stringify(response)}`);
  return response.result as T;
}

function errorOf(response: ResponseMessage): unknown {
  if (response.ok) throw new Error(`expected a refusal, got ${JSON.stringify(response)}`);
  return response.error;
}

/** An engine with one clip made through it, from create to its record. */
async function madeClip(): Promise<{ engine: ClipEngine; avatarId: string; clipId: string }> {
  const { avatarId, photoId } = await seedClipAvatar(libraryDir());
  const engine = await startClipEngine(dir());
  const clipId = jobIdOf(await create(engine, { avatarId, photoId }));
  await jobEnd(engine, clipId);
  return { engine, avatarId, clipId };
}

describe("the clip records' commands through the engine", () => {
  test("clips.list answers the avatar's clip with the cost the ledger holds", async () => {
    const { engine, avatarId, clipId } = await madeClip();
    const { clips } = resultOf<{ clips: ClipSummary[] }>(await answer(engine, "clips.list", { avatarId }), "clips.list");
    expect(clips.map((c) => [c.clipId, c.status, c.cost])).toEqual([[clipId, "ready", { micros: 420_000, kind: "billed" }]]);
  });

  test("clips.get answers the one clip", async () => {
    const { engine, avatarId, clipId } = await madeClip();
    const { clip } = resultOf<{ clip: ClipSummary }>(await answer(engine, "clips.get", { avatarId, clipId }), "clips.get");
    expect(clip).toMatchObject({ clipId, avatarId, status: "ready", seen: false, exports: [] });
  });

  test("clips.get refuses NOT_FOUND for a clip the avatar does not have", async () => {
    const { engine, avatarId } = await madeClip();
    expect(errorOf(await answer(engine, "clips.get", { avatarId, clipId: "clip-00000999" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  test("clips.list refuses NOT_FOUND for an avatar that is not in the library", async () => {
    await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir());
    expect(errorOf(await answer(engine, "clips.list", { avatarId: "avatar-0000-none" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  test("clips.markSeen marks the clip seen, as the next read shows", async () => {
    const { engine, avatarId, clipId } = await madeClip();
    expect(resultOf<{ clipId: string }>(await answer(engine, "clips.markSeen", { avatarId, clipId }), "clips.markSeen")).toEqual({ clipId });
    expect(resultOf<{ clip: ClipSummary }>(await answer(engine, "clips.get", { avatarId, clipId }), "clips.get").clip.seen).toBe(true);
  });

  test("clips.delete removes the clip's record and files", async () => {
    const { engine, avatarId, clipId } = await madeClip();
    expect(resultOf<{ clipId: string }>(await answer(engine, "clips.delete", { avatarId, clipId }), "clips.delete")).toEqual({ clipId });
    expect(resultOf<{ clips: ClipSummary[] }>(await answer(engine, "clips.list", { avatarId }), "clips.list").clips).toEqual([]);
    expect((await readdir(clipsDir(libraryDir(), avatarId))).filter((name) => name.startsWith(clipId))).toEqual([]);
  });

  test("clips.retryDownload fetches a failed download again as a clip job, and the record turns ready", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const clipId = "clip-00000077";
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(folder, { recursive: true });
    await writeClipRecord(folder, {
      schemaVersion: 1,
      id: clipId,
      avatarId,
      sourcePhotoId: photoId,
      createdAt: new Date(NOW).toISOString(),
      seen: false,
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      provider: { model: "kling-std", attempts: [{ attemptId: clipAttemptId(clipId, 1), providerJobId: "job-kling-1", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
      recovered: false,
      exports: [],
      outcome: { status: "failed", reason: "download-failed", retryDownloadUntil: new Date(NOW + 30 * MIN).toISOString() },
    });
    const engine = await startClipEngine(dir());
    const { jobId } = resultOf<{ jobId: string }>(await answer(engine, "clips.retryDownload", { avatarId, clipId }), "clips.retryDownload");
    expect(await jobEnd(engine, jobId)).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "clip", avatarId, clipId } } });
    const read = await readClipRecord(folder, clipId);
    expect(read.kind === "record" ? read.record.outcome.status : read.kind).toBe("ready");
  });
});

describe("a delete of a clip that a recovery works on", () => {
  test("is refused IN_FLIGHT job-running, and goes through once the recovery has ended", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const clipId = "clip-00000043";
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(folder, { recursive: true });
    const journal = journalOf(folder, clipId);
    await journal.requested({
      clipId,
      photoId,
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      acceptedWorstMicros: 850_000,
      at: new Date(NOW).toISOString(),
    });
    await journal.submitted({ attemptId: clipAttemptId(clipId, 1), model: "kling", providerJobId: "job-kling-1", at: new Date(NOW).toISOString() });
    await writeLedger(dir(), [{ type: "reserve", attemptId: clipAttemptId(clipId, 1), jobId: clipId, scope: { avatarJobId: clipId }, model: "kwaivgi/kling-video-o1", worstMicros: 504_000, at: new Date(NOW).toISOString() }]);
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), timings: TIMINGS });
    await until(() => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.clipId === clipId), "the recovery job");

    expect(errorOf(await answer(engine, "clips.delete", { avatarId, clipId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    expect(existsSync(join(folder, `${clipId}.journal.jsonl`))).toBe(true);

    engine.net.release("kling");
    await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "the recovery's end");
    expect(resultOf<{ clipId: string }>(await answer(engine, "clips.delete", { avatarId, clipId }), "clips.delete")).toEqual({ clipId });
    expect((await readdir(folder)).filter((name) => name.startsWith(clipId))).toEqual([]);
    await engine.engine.shutdown();
  });
});

describe("a delete and a library open on the same clip: one lock, the records'", () => {
  test("a library opened while a delete waits in its removal starts no recovery job for that clip and brings nothing back", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    const clipId = "clip-00000088";
    let reached = false;
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    const engine = await startClipEngine(dir(), {
      deps: {
        clipRecords: {
          // The delete is held in the middle: its journal is gone, its record not yet.
          remove: async (path) => {
            if (path.endsWith(`${clipId}.json`)) {
              reached = true;
              await stalled;
            }
            await rm(path, { force: true });
          },
        },
      },
    });

    // A ready clip whose poster was never drawn (a poster that timed out keeps the clip): a library open draws it again. A temp file shows when the open's sweep has run.
    const folder = clipsDir(libraryDir(), avatarId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${clipId}.mp4`), await clipMp4());
    await writeClipRecord(folder, {
      schemaVersion: 1,
      id: clipId,
      avatarId,
      sourcePhotoId: photoId,
      createdAt: new Date(NOW).toISOString(),
      seen: false,
      motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      provider: { model: "kling-std", attempts: [{ attemptId: clipAttemptId(clipId, 1), providerJobId: "job-kling-1", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
      recovered: false,
      exports: [],
      outcome: { status: "ready", file: `${clipId}.mp4`, posterFile: `${clipId}.poster.jpg`, width: 720, height: 1280, durationMs: 5_000, fps: 24, bytes: 1, sha256: "a".repeat(64), face: { verdict: "skipped", frames: 0, why: "worker" } },
    });
    const sweptTemp = join(folder, ".0a1b2c3d4e5f.in.tmp");
    await writeFile(sweptTemp, "x");

    const deleting = answer(engine, "clips.delete", { avatarId, clipId });
    await until(() => reached, "the delete's removal of the record");

    // Away to another library and back: the clip's library becomes the live one again, and its recovery runs while the delete waits.
    const reply = async (call: object): Promise<EngineReply> => {
      await engine.engine.receive(call);
      return EngineReply.parse(engine.posted.at(-1));
    };
    for (const [n, path] of [[1, other], [3, libraryDir()]] as const) {
      expect((await reply({ kind: "control", type: "library.open", callId: `call-0000000${n}`, path })).error).toBeUndefined();
      expect((await reply({ kind: "control", type: "library.confirm", callId: `call-0000000${n + 1}`, path })).error).toBeUndefined();
    }
    await until(() => !existsSync(sweptTemp), "the open's sweep");
    await new Promise((resolve) => setTimeout(resolve, 100));

    release();
    expect(resultOf<{ clipId: string }>(await deleting, "clips.delete")).toEqual({ clipId });
    // Through the same lock, after whatever the recovery queued on it.
    expect(errorOf(await answer(engine, "clips.markSeen", { avatarId, clipId }))).toMatchObject({ code: "NOT_FOUND" });
    const ofClip = engine.events().filter((e) => (e.type === "job.progress" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.kind === "clip" && e.payload.clipId === clipId);
    const done = engine.events().filter((e) => e.type === "job.done" && e.payload.result.kind === "clip" && e.payload.result.clipId === clipId);
    expect([...ofClip, ...done]).toEqual([]);
    expect((await readdir(folder)).filter((name) => name.startsWith(clipId))).toEqual([]);
    await engine.engine.shutdown();
  });
});
