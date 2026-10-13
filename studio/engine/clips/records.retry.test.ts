import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { FfmpegError } from "../../node/runFfmpeg";
import { ClipSummary, type ClipFace } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { VideoDownloadResult } from "../openrouter/types";
import { CLIP_DOWNLOAD_CAP_BYTES } from "./download";
import type { ClipRecordsDeps } from "./records";
import { readClipRecord } from "./store";
import { useClipFixtures } from "./testing/clipFixtures";
import { AVATAR, CLIP, MINUTE, NOW, createRecordsRig, failedRecord, readyRecord, type RecordsRig } from "./testing/recordsRig";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a2 (plan s5b1 §5.2, §5.10, I5.53, I5.54): `clips.retryDownload`. A paid clip whose file did not reach the library (`download-failed`, `invalid-file`, `disk-full`) is fetched
// again for free until `retryDownloadUntil`, by a registered `clip` job that runs V4b's download and validation and then rewrites the record (the only rewrites: failed -> ready, failed ->
// `download-expired`). It writes no ledger line. The downloads here are real ones (the real `downloadClip` and its probe), over a fake OpenRouter that copies a small real MP4.

const clip = useClipFixtures();
const UNTIL = new Date(NOW + 30 * MINUTE).toISOString();
const PROVIDER_JOB = "gen-abc123";
let rig: RecordsRig;

afterEach(async () => {
  await rig.cleanup();
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const refusal = (code: string, more: object = {}) => ({ error: { code, ...more } });

interface Download {
  id: string;
  toPath: string;
  capBytes: number;
}

interface Script {
  /** What a download answers; may write the file as the real client does. Default: `source` copied. */
  answer?: (toPath: string, signal: AbortSignal) => Promise<VideoDownloadResult>;
  source?: string;
  deps?: Partial<ClipRecordsDeps>;
}

async function open(script: Script = {}): Promise<{ downloads: Download[]; faceInputs: Parameters<ClipRecordsDeps["faceOf"]>[0][] }> {
  const downloads: Download[] = [];
  const faceInputs: Parameters<ClipRecordsDeps["faceOf"]>[0][] = [];
  const source = script.source ?? (await clip({ width: 720, height: 1280, seconds: 5 }));
  rig = await createRecordsRig({
    deps: {
      openRouter: () => ({
        downloadVideo: async (id, toPath, capBytes, signal) => {
          downloads.push({ id, toPath, capBytes });
          if (script.answer !== undefined) return script.answer(toPath, signal);
          await copyFile(source, toPath);
          return { kind: "saved", bytes: (await readFile(source)).byteLength };
        },
      }),
      media: { makePoster: async (options) => writeFile(options.outPath, "poster") },
      faceOf: async (input) => {
        faceInputs.push(input);
        return { verdict: "match", p75: 0.8, frames: 10 };
      },
      ...script.deps,
    },
  });
  await rig.ledgerWith([]);
  return { downloads, faceInputs };
}

const retry = (clipId = CLIP) => rig.records.retryDownload({ avatarId: AVATAR, clipId });
async function recordOf(clipId = CLIP) {
  const read = await readClipRecord(rig.clipsDir, clipId);
  if (read.kind !== "record") throw new Error(`no record: ${read.kind}`);
  return read.record;
}

describe("clips.retryDownload: inside the window", () => {
  test("fetches the file again and turns the record ready, with the new file's size and hash", async () => {
    const source = await clip({ width: 720, height: 1280, seconds: 5 });
    const { downloads } = await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    const { jobId } = await retry();
    const job = await rig.settled(jobId);
    expect(job?.status).toBe("done");
    const record = await recordOf();
    if (record.outcome.status !== "ready") throw new Error("expected ready");
    expect(record.outcome).toMatchObject({ status: "ready", file: `${CLIP}.mp4`, posterFile: `${CLIP}.poster.jpg`, width: 720, height: 1280, sha256: sha256(await readFile(source)), bytes: (await readFile(source)).byteLength });
    expect(sha256(await readFile(rig.file(`${CLIP}.mp4`)))).toBe(record.outcome.sha256);
    expect(downloads.map((d) => [d.id, d.capBytes])).toEqual([[PROVIDER_JOB, CLIP_DOWNLOAD_CAP_BYTES]]);
  });

  for (const reason of ["invalid-file", "disk-full"] as const) {
    test(`retries a ${reason} record the same way`, async () => {
      await open();
      await rig.put(failedRecord(reason, UNTIL));
      await rig.settled((await retry()).jobId);
      expect((await recordOf()).outcome.status).toBe("ready");
    });
  }

  test("retries at the last millisecond of the window, and refuses one millisecond after", async () => {
    await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    rig.state.now = Date.parse(UNTIL);
    await rig.settled((await retry()).jobId);
    expect((await recordOf()).outcome.status).toBe("ready");
    await rig.put(failedRecord("download-failed", UNTIL, { id: "clip-0000002" }));
    rig.state.now = Date.parse(UNTIL) + 1;
    await expect(retry("clip-0000002")).rejects.toMatchObject(refusal("VALIDATION", { clipReason: "download-expired" }));
  });

  test("keeps everything of the record but its outcome, the seen flag included", async () => {
    await open();
    const before = failedRecord("download-failed", UNTIL, { seen: true });
    await rig.put(before);
    await rig.settled((await retry()).jobId);
    const after = await recordOf();
    expect({ ...after, outcome: null }).toEqual({ ...before, outcome: null });
  });

  test("builds the new record from the record on disk when it finishes, so a clip marked seen meanwhile stays seen", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = await clip({ width: 720, height: 1280, seconds: 5 });
    await open({
      answer: async (toPath) => {
        await gate;
        await copyFile(source, toPath);
        return { kind: "saved", bytes: 1 };
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    const { jobId } = await retry();
    await rig.records.markSeen({ avatarId: AVATAR, clipId: CLIP });
    release();
    await rig.settled(jobId);
    const record = await recordOf();
    expect([record.seen, record.outcome.status]).toEqual([true, "ready"]);
  });

  test("passes the face check the stored file and the record, and keeps its verdict", async () => {
    const { faceInputs } = await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    expect(faceInputs.length).toBe(1);
    expect(faceInputs[0]).toMatchObject({ clipPath: rig.file(`${CLIP}.mp4`), scratchDir: rig.clipsDir, record: { id: CLIP } });
    const outcome = (await recordOf()).outcome;
    expect(outcome.status === "ready" ? outcome.face : null).toEqual({ verdict: "match", p75: 0.8, frames: 10 } satisfies ClipFace);
  });

  test("keeps the clip, unchecked, when the face check breaks", async () => {
    await open({ deps: { faceOf: async () => Promise.reject(new Error("worker gone")) } });
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    const outcome = (await recordOf()).outcome;
    expect(outcome.status === "ready" ? outcome.face : null).toEqual({ verdict: "skipped", frames: 0, why: "worker" });
  });

  test("keeps the clip ready, without a poster, when the poster cannot be drawn", async () => {
    await open({ deps: { media: { makePoster: async () => Promise.reject(new Error("ffmpeg busy")) } } });
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    expect((await recordOf()).outcome.status).toBe("ready");
    expect(await rig.names()).not.toContain(`${CLIP}.poster.jpg`);
    expect(rig.logs.length).toBe(1);
  });

  test("removes the file and keeps the record when ffmpeg proves it cannot decode it", async () => {
    await open({ deps: { media: { makePoster: async () => Promise.reject(new FfmpegError("ffmpeg failed", 1, "Invalid data found when processing input")) } } });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    const job = await rig.settled((await retry()).jobId);
    expect(job?.status).toBe("failed");
    expect(await recordOf()).toEqual(before);
    expect(await rig.names()).toEqual([`${CLIP}.json`]);
  });

  test("answers summaries the contract accepts once the clip is ready", async () => {
    await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    expect(ClipSummary.safeParse((await rig.records.get({ avatarId: AVATAR, clipId: CLIP })).clip).success).toBe(true);
  });
});

describe("clips.retryDownload: the job", () => {
  test("is a registered clip job in the downloading phase that blocks the clip, and announces done with the clip's identity", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = await clip({ width: 720, height: 1280, seconds: 5 });
    await open({
      answer: async (toPath) => {
        await gate;
        await copyFile(source, toPath);
        return { kind: "saved", bytes: 1 };
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    const { jobId } = await retry();
    expect(rig.jobs.stateOf(jobId)).toMatchObject({ kind: "clip", avatarId: AVATAR, clipId: CLIP, status: "running", phase: "downloading" });
    expect(rig.jobs.hasLiveJobFor(AVATAR)).toBe(true);
    expect(rig.state.busy.has(CLIP)).toBe(true);
    release();
    await rig.settled(jobId);
    expect(rig.state.busy.has(CLIP)).toBe(false);
    expect(rig.events.map((e) => e.type)).toEqual(["job.progress", "job.progress", "job.progress", "job.done"]);
    expect(rig.events.at(-1)).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "clip", avatarId: AVATAR, clipId: CLIP } } });
  });

  test("walks downloading, checking and saving, with done never past total", async () => {
    await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    const progress = rig.events.flatMap((e) => (e.type === "job.progress" ? [e.payload] : []));
    expect(progress.map((p) => (p.kind === "clip" ? p.phase : null))).toEqual(["downloading", "checking", "saving"]);
    for (const p of progress) expect(p.done).toBeLessThanOrEqual(p.total);
  });

  test("writes no ledger line", async () => {
    await open();
    await rig.ledgerWith([]);
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    expect(rig.state.ledger?.lines).toEqual([]);
  });

  test("a delete while it runs is refused, and a second retry is refused", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await open({
      answer: async () => {
        await gate;
        return { kind: "failed", cause: "network", httpStatus: null, detail: "x" };
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    const { jobId } = await retry();
    await expect(rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject(refusal("IN_FLIGHT", { clipReason: "job-running" }));
    await expect(retry()).rejects.toMatchObject(refusal("IN_FLIGHT", { clipReason: "job-running" }));
    release();
    await rig.settled(jobId);
  });

  test("two retries made together start one job", async () => {
    await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    const results = await Promise.allSettled([retry(), retry()]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const done = results.find((r) => r.status === "fulfilled");
    if (done?.status === "fulfilled") await rig.settled(done.value.jobId);
  });

  test("stops and leaves the record alone when the engine shuts down mid-download", async () => {
    const stop = new AbortController();
    await open({
      answer: (_toPath, signal) =>
        new Promise((resolve) => {
          const aborted = (): void => resolve({ kind: "failed", cause: "aborted", httpStatus: null, detail: "aborted" });
          if (signal.aborted) aborted();
          else signal.addEventListener("abort", aborted, { once: true });
        }),
      deps: { host: { busy: () => false, begin: () => () => undefined, stop: stop.signal } },
    });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    const { jobId } = await retry();
    stop.abort();
    expect((await rig.settled(jobId))?.status).toBe("cancelled");
    expect(await recordOf()).toEqual(before);
    expect(rig.events.at(-1)?.type).toBe("job.cancelled");
  });
});

describe("clips.retryDownload: when the file is gone", () => {
  for (const httpStatus of [404, 410] as const) {
    test(`turns the record download-expired, without the window, when /content answers ${httpStatus}`, async () => {
      await open({ answer: async () => ({ kind: "gone", httpStatus }) });
      await rig.put(failedRecord("download-failed", UNTIL));
      const job = await rig.settled((await retry()).jobId);
      expect(job?.status).toBe("done");
      expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
    });
  }

  test("turns a failure into download-expired when the window ended while it ran", async () => {
    await open({
      answer: async () => {
        rig.state.now = Date.parse(UNTIL) + 1;
        return { kind: "failed", cause: "network", httpStatus: null, detail: "x" };
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    await rig.settled((await retry()).jobId);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });

  test("refuses with VALIDATION download-expired after the window, turns the record download-expired and asks the provider nothing", async () => {
    const { downloads } = await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    rig.state.now = Date.parse(UNTIL) + MINUTE;
    await expect(retry()).rejects.toMatchObject(refusal("VALIDATION", { clipReason: "download-expired" }));
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
    expect(downloads).toEqual([]);
    expect(rig.state.busy.size).toBe(0);
  });

  test("refuses a record that is already download-expired, and leaves it as it is", async () => {
    const { downloads } = await open();
    const before = failedRecord("download-expired", undefined);
    await rig.put(before);
    await expect(retry()).rejects.toMatchObject(refusal("VALIDATION", { clipReason: "download-expired" }));
    expect(await recordOf()).toEqual(before);
    expect(downloads).toEqual([]);
  });

  test("retries a retryable failure that has no window: I5.53 expires it only when the window passed or /content says gone", async () => {
    const { downloads } = await open();
    await rig.put(failedRecord("download-failed", undefined));
    await rig.settled((await retry()).jobId);
    expect(downloads.length).toBe(1);
    expect((await recordOf()).outcome.status).toBe("ready");
  });

  test("expires a retryable failure with no window when /content answers 404", async () => {
    await open({ answer: async () => ({ kind: "gone", httpStatus: 404 }) });
    await rig.put(failedRecord("download-failed", undefined));
    await rig.settled((await retry()).jobId);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });

  test("keeps a retryable failure with no window as it was when the retry fails again", async () => {
    await open({ answer: async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "x" }) });
    const before = failedRecord("download-failed", undefined);
    await rig.put(before);
    expect((await rig.settled((await retry()).jobId))?.status).toBe("failed");
    expect(await recordOf()).toEqual(before);
  });
});

describe("clips.retryDownload: races with a delete and a stop", () => {
  test("starts no job when the avatar's delete was prepared while the key was being read", async () => {
    await open({
      deps: {
        usableKey: () => {
          rig.state.pendingDelete.add(AVATAR);
          return "sk-test";
        },
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    await expect(retry()).rejects.toMatchObject(refusal("NOT_FOUND"));
    expect(rig.state.busy.size).toBe(0);
    expect(rig.jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });

  test("starts no job when the avatar left the library while the key was being read", async () => {
    await open({
      deps: {
        usableKey: () => {
          rig.state.avatars.delete(AVATAR);
          return "sk-test";
        },
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    await expect(retry()).rejects.toMatchObject(refusal("NOT_FOUND"));
    expect(rig.jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });

  test("does not end ready when the engine stops while the poster is drawn", async () => {
    const stop = new AbortController();
    await open({
      deps: {
        host: { busy: () => false, begin: () => () => undefined, stop: stop.signal },
        media: {
          makePoster: async (options) => {
            await writeFile(options.outPath, "poster");
            stop.abort();
          },
        },
      },
    });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    expect((await rig.settled((await retry()).jobId))?.status).toBe("cancelled");
    expect(await recordOf()).toEqual(before);
  });

  test("does not end ready when the engine stops while the face is read", async () => {
    const stop = new AbortController();
    await open({
      deps: {
        host: { busy: () => false, begin: () => () => undefined, stop: stop.signal },
        faceOf: async () => {
          stop.abort();
          return { verdict: "match", p75: 0.8, frames: 10 };
        },
      },
    });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    expect((await rig.settled((await retry()).jobId))?.status).toBe("cancelled");
    expect(await recordOf()).toEqual(before);
  });

  test("does not end ready when the poster fails because the engine stopped", async () => {
    const stop = new AbortController();
    await open({
      deps: {
        host: { busy: () => false, begin: () => () => undefined, stop: stop.signal },
        media: {
          makePoster: async () => {
            stop.abort();
            throw new Error("killed");
          },
        },
      },
    });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    expect((await rig.settled((await retry()).jobId))?.status).toBe("cancelled");
    expect(await recordOf()).toEqual(before);
  });
});

describe("clips.retryDownload: when the retry fails again", () => {
  test("leaves the record exactly as it was and ends the job failed (network)", async () => {
    await open({ answer: async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "reset" }) });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    const { jobId } = await retry();
    const job = await rig.settled(jobId);
    expect(job).toMatchObject({ status: "failed", error: { code: "NETWORK" } });
    expect(await recordOf()).toEqual(before);
    expect(rig.state.busy.size).toBe(0);
    expect(rig.events.at(-1)?.type).toBe("job.failed");
  });

  test("leaves the record as it was when the file is not a valid clip, and keeps no file", async () => {
    await open({
      answer: async (toPath) => {
        await writeFile(toPath, "this is not an mp4");
        return { kind: "saved", bytes: 18 };
      },
    });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    const job = await rig.settled((await retry()).jobId);
    expect(job).toMatchObject({ status: "failed", error: { code: "VALIDATION" } });
    expect(await recordOf()).toEqual(before);
    expect(await rig.names()).toEqual([`${CLIP}.json`]);
  });

  test("holds a clip of ten seconds to its ten seconds (the request's length is what the file is judged by)", async () => {
    await open();
    const before = failedRecord("download-failed", UNTIL, { request: { model: "kling", quality: "std", seconds: 10, fallback: "auto" } });
    await rig.put(before);
    const job = await rig.settled((await retry()).jobId);
    expect(job?.status).toBe("failed");
    expect(await recordOf()).toEqual(before);
  });

  test("reports a disk that is full as a failure that is not a network one", async () => {
    await open({ answer: async () => ({ kind: "failed", cause: "disk", httpStatus: null, detail: "ENOSPC" }) });
    const before = failedRecord("download-failed", UNTIL);
    await rig.put(before);
    const job = await rig.settled((await retry()).jobId);
    expect(job).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(await recordOf()).toEqual(before);
  });
});

describe("clips.retryDownload: the mp4 a download-failed record may have left", () => {
  test("replaces it with the fresh download when the retry succeeds", async () => {
    await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    await writeFile(rig.file(`${CLIP}.mp4`), "STALE BYTES FROM THE FIRST TRY");
    await rig.settled((await retry()).jobId);
    const outcome = (await recordOf()).outcome;
    if (outcome.status !== "ready") throw new Error("expected ready");
    const stored = await readFile(rig.file(`${CLIP}.mp4`));
    expect(stored.toString().startsWith("STALE")).toBe(false);
    expect(sha256(stored)).toBe(outcome.sha256);
    expect(await rig.names()).toEqual([`${CLIP}.json`, `${CLIP}.mp4`, `${CLIP}.poster.jpg`]);
  });

  test("leaves it alone when the retry fails, for the delete (which removes it) to take", async () => {
    await open({ answer: async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "x" }) });
    await rig.put(failedRecord("download-failed", UNTIL));
    await writeFile(rig.file(`${CLIP}.mp4`), "leftover");
    await rig.settled((await retry()).jobId);
    expect(await readFile(rig.file(`${CLIP}.mp4`), "utf8")).toBe("leftover");
    await rig.records.delete({ avatarId: AVATAR, clipId: CLIP });
    expect(await rig.names()).toEqual([]);
  });

  test("does not mistake a valid-looking leftover for the provider's file: it still downloads", async () => {
    const { downloads } = await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    await copyFile(await clip({ width: 720, height: 1280, seconds: 5 }), rig.file(`${CLIP}.mp4`));
    await rig.settled((await retry()).jobId);
    expect(downloads.length).toBe(1);
  });
});

describe("clips.retryDownload: refusals, all free and before any job", () => {
  test("refuses with NOT_FOUND for a clip with no record, an avatar that is not there, and no library", async () => {
    await open();
    await expect(retry()).rejects.toMatchObject(refusal("NOT_FOUND"));
    await expect(rig.records.retryDownload({ avatarId: "avatar-zzzz-0009", clipId: CLIP })).rejects.toMatchObject(refusal("NOT_FOUND"));
    rig.state.open = false;
    await expect(retry()).rejects.toMatchObject(refusal("LIBRARY_UNAVAILABLE"));
    expect(rig.state.busy.size).toBe(0);
  });

  test("refuses with VALIDATION for a ready clip, and for a failure that is not a download", async () => {
    await open();
    await rig.put(readyRecord());
    await expect(retry()).rejects.toMatchObject(refusal("VALIDATION"));
    for (const [index, reason] of (["refused-free", "refused-paid", "lost", "late", "provider-error"] as const).entries()) {
      const id = `clip-00000${index + 10}`;
      await rig.put(failedRecord(reason, undefined, { id }));
      await expect(retry(id)).rejects.toMatchObject(refusal("VALIDATION"));
    }
    expect(rig.state.busy.size).toBe(0);
  });

  test("refuses with VALIDATION when the record names no finished attempt to fetch", async () => {
    await open();
    const noJob = failedRecord("download-failed", UNTIL);
    await rig.put({ ...noJob, provider: { model: "kling-std", attempts: [{ attemptId: `${CLIP}:video#1`, outcome: "completed", costSource: "none" }] } });
    await expect(retry()).rejects.toMatchObject(refusal("VALIDATION"));
    expect(rig.state.busy.size).toBe(0);
  });

  test("refuses with the key's own refusal, before any job exists", async () => {
    await open({
      deps: {
        usableKey: () => {
          throw new Error("no key");
        },
      },
    });
    await rig.put(failedRecord("download-failed", UNTIL));
    await expect(retry()).rejects.toThrow("no key");
    expect(rig.state.busy.size).toBe(0);
    expect(rig.jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });

  test("refuses with IN_FLIGHT job-running while another job works on the clip", async () => {
    const { downloads } = await open();
    await rig.put(failedRecord("download-failed", UNTIL));
    rig.state.busy.add(CLIP);
    await expect(retry()).rejects.toMatchObject(refusal("IN_FLIGHT", { clipReason: "job-running" }));
    expect(downloads).toEqual([]);
  });
});
