import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLIP_FILE_DAMAGED_DETAIL, EXPORT_CHANGING_DETAIL, type JobState } from "../../shared/engine";
import { FfmpegError, FfmpegTimeoutError, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { FREE_MARGIN_BYTES } from "../freeBytes";
import { expectedExportBytes } from "./exportProfile";
import { copyingEncode, createExportRig, useExportFixtures, type ExportRig, type ExportRigOptions } from "./testing/exportRig";
import { failedRecord } from "./testing/recordsRig";
import { clipFilePath } from "./store";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.2, §5.13): «Сохранить в папку» is a job. Its refusals are free and come before any byte; it is a registered `clip` job in `exporting` whose
// done/total counts the encoded frames; exports run one at a time (FIFO); every failure is free, removes what the job made and leaves the library's file untouched. A quit, a cancel or
// the library going away ends it `cancelled`. Before the encode ffmpeg itself is asked how many video streams the file has (the second layer behind the walker).

setDefaultTimeout(60_000);

const fixtures = useExportFixtures();
const CLIP = "clip-0000001";

let rig: ExportRig | null = null;
afterEach(async () => {
  rig?.stop();
  await rig?.cleanup();
  rig = null;
});

async function world(options: ExportRigOptions = {}): Promise<ExportRig> {
  rig = await createExportRig({ ...options, deps: { encode: copyingEncode(fixtures.cleanExport), ...options.deps } });
  await rig.putClip(CLIP, await fixtures.kling());
  return rig;
}

const errorOf = (state: JobState): unknown => (state.status === "failed" ? state.error : `the job ended ${state.status}`);
const refusalOf = (answer: { jobId: string } | { error: unknown }): unknown => ("error" in answer ? answer.error : `started ${answer.jobId}`);

/** An encode that waits for `release` (a test's moment while the encode runs), reporting the frames it was told to, then copies the clean export. */
function heldEncode() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const seen: RunFfmpegArgvOptions[] = [];
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const encode = copyingEncode(fixtures.cleanExport, {
    during: async (options) => {
      seen.push(options);
      entered();
      await Promise.race([gate, new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }))]);
    },
  });
  return { encode, release: () => open(), started, seen };
}

describe("the refusals (free, before any byte)", () => {
  test("a clip that is not in the avatar's clips is NOT_FOUND", async () => {
    const r = await world();
    expect(refusalOf(await r.start("clip-0000404"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await r.folderNames()).toEqual([]);
  });

  test("an avatar being deleted is NOT_FOUND", async () => {
    const r = await world();
    r.state.pendingDelete.add(r.avatarId);
    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "NOT_FOUND" });
  });

  test("no open library is LIBRARY_UNAVAILABLE", async () => {
    const r = await world();
    r.state.open = false;
    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "LIBRARY_UNAVAILABLE" });
  });

  test("a clip that failed is VALIDATION not-ready", async () => {
    const r = await world();
    await r.putClip("clip-0000002", await fixtures.kling(), { outcome: failedRecord("refused-free", undefined).outcome });
    expect(refusalOf(await r.start("clip-0000002"))).toMatchObject({ code: "VALIDATION", clipReason: "not-ready" });
  });

  test("a clip another job works on is IN_FLIGHT job-running", async () => {
    const r = await world();
    r.state.busy.add(CLIP);
    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
  });

  test("a second export of a clip whose export is still running is job-running", async () => {
    const held = heldEncode();
    const r = await world({ deps: { encode: held.encode } });
    const first = await r.started(CLIP);
    await held.started;

    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    held.release();
    expect((await r.settled(first)).status).toBe("done");
  });

  test("an unusable export folder is the render's EXPORT_UNAVAILABLE with its reason, and no job starts", async () => {
    const r = await world();
    r.state.exportCheck = async () => ({ ok: false, reason: "missing" });

    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    expect(r.jobs.states()).toEqual([]);
    expect(r.state.work).toBe(0);
  });

  test("the folder is asked for room for the clip at the 12 Mbit/s cap plus the margin", async () => {
    const r = await world();
    const asked: Array<number | undefined> = [];
    r.state.exportCheck = async (requiredBytes) => (asked.push(requiredBytes), { ok: false, reason: "not-enough-space" });

    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" });
    const { outcome } = await r.record(CLIP);
    expect(asked).toEqual([expectedExportBytes(outcome.status === "ready" ? outcome.durationMs : Number.NaN) + FREE_MARGIN_BYTES]);
  });

  test("a volume that says it has too little free is the render's not-enough-space, and nothing is written", async () => {
    const r = await world();
    r.state.freeBytes = 1;

    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" });
    expect(await r.folderNames()).toEqual([]);
    expect(r.jobs.states()).toEqual([]);
  });
});

describe("the job", () => {
  test("is a registered clip job of the avatar, in `exporting`, counting the frames at the profile's rate, and holds the library while it runs", async () => {
    const held = heldEncode();
    const r = await world({ deps: { encode: held.encode } });
    const jobId = await r.started(CLIP);
    await held.started;

    // A 1 s clip at the duplicate profile's 30 fps.
    expect(r.jobs.stateOf(jobId)).toMatchObject({ kind: "clip", avatarId: r.avatarId, clipId: CLIP, status: "running", phase: "exporting", total: 30 });
    expect([r.state.work, r.state.busy.has(CLIP), r.exports.owns(jobId)]).toEqual([1, true, true]);
    held.release();
    await r.settled(jobId);
    expect([r.state.work, r.state.busy.has(CLIP), r.exports.owns(jobId)]).toEqual([0, false, false]);
  });

  test("its done/total rises with the encoded frames and ends at the total", async () => {
    const r = await world({
      deps: {
        encode: async (encode) => {
          for (const frames of [8, 17, 25]) encode.onFrames?.(frames);
          await copyingEncode(fixtures.cleanExport, { frames: 29 })(encode);
        },
      },
    });
    const jobId = await r.started(CLIP);
    const end = await r.settled(jobId);

    const progress = r.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId ? [[e.payload.phase, e.payload.done, e.payload.total]] : []));
    expect(progress).toEqual([
      ["exporting", 0, 30],
      ["exporting", 8, 30],
      ["exporting", 17, 30],
      ["exporting", 25, 30],
      ["exporting", 29, 30],
    ]);
    expect(end).toMatchObject({ status: "done", done: 30, total: 30 });
  });

  test("its end is announced as job.done carrying the place of the copy", async () => {
    const r = await world();
    const jobId = await r.started(CLIP);
    const end = await r.settled(jobId);

    const announced = r.events.filter((e) => e.type === "job.done").map((e) => e.payload);
    expect(end.status).toBe("done");
    expect(announced).toEqual([{ jobId, result: { kind: "clip", avatarId: r.avatarId, clipId: CLIP, exported: { relPath: expect.stringMatching(/^Nini\/\d{4}-\d{2}-\d{2}_clip_001\.mp4$/) } } }]);
  });

  test("two exports run one after the other: the second is queued at 0 % and encodes only once the first has ended", async () => {
    const order: string[] = [];
    let r: ExportRig | null = null;
    const first = heldEncode();
    let calls = 0;
    r = await world({
      deps: {
        encode: async (encode) => {
          calls++;
          order.push(`encode ${calls}`);
          if (calls === 1) await first.encode(encode);
          else await copyingEncode(fixtures.cleanExport)(encode);
        },
      },
    });
    await r.putClip("clip-0000002", await fixtures.kling());
    const a = await r.started(CLIP);
    await first.started;
    const b = await r.started("clip-0000002");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(r.jobs.stateOf(b)).toMatchObject({ status: "running", phase: "exporting", done: 0 });
    expect(order).toEqual(["encode 1"]);
    first.release();
    await r.settled(a);
    order.push("first ended");
    await r.settled(b);
    expect(order).toEqual(["encode 1", "first ended", "encode 2"]);
  });

  test("the encode is bounded at 10 minutes and runs under the job's signal", async () => {
    const held = heldEncode();
    const r = await world({ deps: { encode: held.encode } });
    const jobId = await r.started(CLIP);
    await held.started;

    expect(held.seen[0]?.timeoutMs).toBe(600_000);
    expect(held.seen[0]?.signal?.aborted).toBe(false);
    held.release();
    await r.settled(jobId);
  });
});

describe("the failures (free; the library's file untouched; what the job made is gone)", () => {
  async function failsWith(encode: NonNullable<ExportRigOptions["deps"]>["encode"], extra: NonNullable<ExportRigOptions["deps"]> = {}): Promise<{ r: ExportRig; state: JobState; before: string }> {
    const r = await world({ deps: { ...(encode === undefined ? {} : { encode }), ...extra } });
    const before = await r.sha(clipFilePath(r.clipsDir, CLIP));
    const state = await r.settled(await r.started(CLIP));
    return { r, state, before };
  }

  async function untouched(r: ExportRig, before: string): Promise<void> {
    expect(await r.sha(clipFilePath(r.clipsDir, CLIP))).toBe(before);
    expect(await r.folderNames()).toEqual([]);
    expect((await r.record(CLIP)).exports).toEqual([]);
  }

  test("an ffmpeg error is INTERNAL", async () => {
    const { r, state, before } = await failsWith(async () => Promise.reject(new FfmpegError("ffmpeg exited 1", 1, "Invalid data found when processing input")));
    expect(errorOf(state)).toMatchObject({ code: "INTERNAL" });
    // The library's file is whole: the window says so (43c), never that it is damaged.
    expect(errorOf(state)).not.toMatchObject({ detail: CLIP_FILE_DAMAGED_DETAIL });
    await untouched(r, before);
  });

  test("an encode past its bound is INTERNAL", async () => {
    const { r, state, before } = await failsWith(async () => Promise.reject(new FfmpegTimeoutError(600_000, "")));
    expect(errorOf(state)).toMatchObject({ code: "INTERNAL" });
    await untouched(r, before);
  });

  test("a file the I5.58 check refuses is INTERNAL and no name is claimed, though the check read it whole (a real sha256 and size)", async () => {
    // As the real verifier answers a refusal: the verdict is no, the hash and the size are the file's own (so only the verdict can stop the commit).
    const refusing = async (path: string) => {
      const bytes = await readFile(path);
      return { ok: false, reasons: [{ code: "TAG_PRESENT" as const, message: "a tag" }], sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    };
    const { r, state, before } = await failsWith(undefined, { verify: refusing });
    expect(errorOf(state)).toMatchObject({ code: "INTERNAL" });
    await untouched(r, before);
  });

  test("the real verifier on an encode that carries a tag (a title naming the provider) stops the export: INTERNAL, nothing in the folder or the record", async () => {
    const { r, state, before } = await failsWith(copyingEncode(fixtures.taggedExport));
    expect(errorOf(state)).toMatchObject({ code: "INTERNAL" });
    expect(r.logs.some((line) => line.includes("TAG_PRESENT"))).toBe(true);
    await untouched(r, before);
  });

  test("a file that is not the profile's video (the library's own 720p file, unencoded) is INTERNAL", async () => {
    const { r, state, before } = await failsWith(copyingEncode(fixtures.kling));
    expect(errorOf(state)).toMatchObject({ code: "INTERNAL" });
    await untouched(r, before);
  });

  test("a full disk during the encode is the render's not-enough-space", async () => {
    const { r, state, before } = await failsWith(async () => Promise.reject(new FfmpegError("ffmpeg exited 1", 1, "av_interleaved_write_frame(): No space left on device")));
    expect(errorOf(state)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" });
    await untouched(r, before);
  });

  test("the folder is looked at again when a queued export's turn comes: gone by then is EXPORT_UNAVAILABLE missing, and nothing of it is written", async () => {
    const first = heldEncode();
    let calls = 0;
    const r = await world({ deps: { encode: async (encode) => (++calls === 1 ? first.encode(encode) : copyingEncode(fixtures.cleanExport)(encode)) } });
    await r.putClip("clip-0000002", await fixtures.kling());
    const a = await r.started(CLIP);
    await first.started;
    const b = await r.started("clip-0000002");

    r.state.exportCheck = async () => ({ ok: false, reason: "missing" });
    first.release();
    await r.settled(a);

    expect(errorOf(await r.settled(b))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    expect(calls).toBe(1);
    expect((await r.record("clip-0000002")).exports).toEqual([]);
  });

  test("the record's line that cannot be written after the rename rolls the file back: INTERNAL, nothing left in the folder", async () => {
    let r: ExportRig | null = null;
    r = await world({ deps: { rewrite: async () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })) } });
    const before = await r.sha(clipFilePath(r.clipsDir, CLIP));
    const state = await r.settled(await r.started(CLIP));

    expect(errorOf(state)).toMatchObject({ code: "INTERNAL" });
    await untouched(r, before);
  });
});

describe("a stop", () => {
  test("a quit during the encode ends the job cancelled: ffmpeg is told to stop, the temp is gone", async () => {
    const held = heldEncode();
    const r = await world({ deps: { encode: held.encode } });
    const jobId = await r.started(CLIP);
    await held.started;

    r.stop();
    const state = await r.settled(jobId);

    expect(state.status).toBe("cancelled");
    expect(held.seen[0]?.signal?.aborted).toBe(true);
    expect(await r.folderNames()).toEqual([]);
    expect(r.events.filter((e) => e.type === "job.cancelled").map((e) => e.payload)).toEqual([{ kind: "clip", jobId, avatarId: r.avatarId, clipId: CLIP }]);
  });

  test("the library going away during the encode ends it cancelled, the temp gone", async () => {
    const held = heldEncode();
    const r = await world({ deps: { encode: held.encode } });
    const jobId = await r.started(CLIP);
    await held.started;

    r.exports.libraryGone();

    expect((await r.settled(jobId)).status).toBe("cancelled");
    expect(await r.folderNames()).toEqual([]);
  });

  test("a cancel of the job during the encode ends it cancelled, the temp gone", async () => {
    const held = heldEncode();
    const r = await world({ deps: { encode: held.encode } });
    const jobId = await r.started(CLIP);
    await held.started;

    r.exports.cancel(jobId);

    expect((await r.settled(jobId)).status).toBe("cancelled");
    expect(await r.folderNames()).toEqual([]);
  });

  test("a stop once the name is claimed is too late: the export finishes (done wins)", async () => {
    let r: ExportRig | null = null;
    r = await world({ deps: { hooks: { reached: (step) => void (step === "name-claimed" ? r?.stop() : undefined) } } });
    const state = await r.settled(await r.started(CLIP));

    expect(state.status).toBe("done");
    expect((await r.record(CLIP)).exports).toHaveLength(1);
  });
});

describe("a queued export that is stopped", () => {
  /** A first export held in its encode, and the next ones queued behind it (one clip each). */
  async function queue(count: number) {
    const first = heldEncode();
    const encoded: string[] = [];
    const r = await world({
      deps: {
        encode: async (encode) => {
          encoded.push(encode.output);
          return encoded.length === 1 ? first.encode(encode) : copyingEncode(fixtures.cleanExport)(encode);
        },
      },
    });
    const ids = [CLIP];
    for (let n = 2; n <= count; n++) {
      const clipId = `clip-000000${n}`;
      await r.putClip(clipId, await fixtures.kling());
      ids.push(clipId);
    }
    const head = await r.started(CLIP);
    await first.started;
    const queued: string[] = [];
    for (const clipId of ids.slice(1)) queued.push(await r.started(clipId));
    return { r, first, head, queued, encoded, ids };
  }

  test("a cancel ends it at once, while the export ahead still runs: its clip is free again, and only the running one holds the library", async () => {
    const { r, first, head, queued, ids } = await queue(2);
    const [second] = queued;
    if (second === undefined) throw new Error("no queued export");

    r.exports.cancel(second);

    expect((await r.settled(second)).status).toBe("cancelled");
    expect(r.jobs.stateOf(head)?.status).toBe("running");
    expect([r.state.busy.has(ids[1] ?? ""), r.state.work, r.exports.active()]).toEqual([false, 1, 1]);
    first.release();
    expect((await r.settled(head)).status).toBe("done");
  });

  test("the queue keeps its order: the export behind a cancelled one still waits for the one running ahead", async () => {
    const { r, first, head, queued, encoded } = await queue(3);
    const [second, third] = queued;
    if (second === undefined || third === undefined) throw new Error("no queued exports");

    r.exports.cancel(second);
    await r.settled(second);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(encoded).toHaveLength(1);
    expect(r.jobs.stateOf(third)).toMatchObject({ status: "running", done: 0 });
    first.release();
    await r.settled(head);
    expect((await r.settled(third)).status).toBe("done");
    expect(encoded).toHaveLength(2);
  });
});

describe("the export folder being switched (an export commits into the folder the settings name, as a render does)", () => {
  test("a pick of another folder waiting for its settings refuses clips.export IN_FLIGHT, and no job starts", async () => {
    const r = await world();
    r.state.switchPending = true;

    expect(refusalOf(await r.start(CLIP))).toMatchObject({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
    expect(r.jobs.states()).toEqual([]);
  });

  test("the folder changed under a running export: refused IN_FLIGHT before the claim, nothing left in the old folder or the record", async () => {
    let r: ExportRig | null = null;
    r = await world({ deps: { hooks: { reached: (step) => void (step === "verified" && r !== null ? (r.state.currentExportPath = join(r.dir, "other")) : undefined) } } });
    const state = await r.settled(await r.started(CLIP));

    expect(errorOf(state)).toMatchObject({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
    expect(await r.folderNames()).toEqual([]);
    expect((await r.record(CLIP)).exports).toEqual([]);
  });

  test("a pick that started while an export was queued stops it at its turn, before any byte", async () => {
    const first = heldEncode();
    let calls = 0;
    const r = await world({ deps: { encode: async (encode) => (++calls === 1 ? first.encode(encode) : copyingEncode(fixtures.cleanExport)(encode)) } });
    await r.putClip("clip-0000002", await fixtures.kling());
    const a = await r.started(CLIP);
    await first.started;
    const b = await r.started("clip-0000002");

    r.state.switchPending = true;
    first.release();
    await r.settled(a);

    expect(errorOf(await r.settled(b))).toMatchObject({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
    expect(calls).toBe(1);
  });

  test("active() counts the running export and the queued one (export.choose waits for both), and nothing once they ended", async () => {
    const first = heldEncode();
    let calls = 0;
    const r = await world({ deps: { encode: async (encode) => (++calls === 1 ? first.encode(encode) : copyingEncode(fixtures.cleanExport)(encode)) } });
    await r.putClip("clip-0000002", await fixtures.kling());
    const a = await r.started(CLIP);
    await first.started;
    const b = await r.started("clip-0000002");

    expect(r.exports.active()).toBe(2);
    first.release();
    await r.settled(a);
    await r.settled(b);
    expect(r.exports.active()).toBe(0);
  });
});

describe("the library's file (I5.54: every export is made from the provider's bytes)", () => {
  test("a file that is not the bytes its record names is refused INTERNAL, before ffmpeg is asked anything", async () => {
    let asked = false;
    const r = await world({ deps: { videoStreams: async () => ((asked = true), "ok") } });
    await copyFile(await fixtures.pro(), clipFilePath(r.clipsDir, CLIP));

    const state = await r.settled(await r.started(CLIP));

    // S5.V8 follow-up: the detail says the file in Studio is damaged, so the window never tells the owner it is intact (43c).
    expect(errorOf(state)).toMatchObject({ code: "INTERNAL", detail: CLIP_FILE_DAMAGED_DETAIL });
    expect(asked).toBe(false);
    expect(await r.folderNames()).toEqual([]);
  });

  test("a file that cannot be read at all is the same damaged file to the window", async () => {
    const r = await world();
    await rm(clipFilePath(r.clipsDir, CLIP));

    const state = await r.settled(await r.started(CLIP));

    expect(errorOf(state)).toMatchObject({ code: "INTERNAL", detail: CLIP_FILE_DAMAGED_DETAIL });
    expect(await r.folderNames()).toEqual([]);
  });
});

describe("the second layer: ffmpeg is asked how many video streams the file has, before the encode", () => {
  test("it is asked about the library's file with the codec and the size the walker judged", async () => {
    const asked: unknown[] = [];
    const r = await world({ deps: { videoStreams: async (options) => (asked.push({ path: options.path, expected: options.expected }), "ok") } });
    expect((await r.settled(await r.started(CLIP))).status).toBe("done");
    expect(asked).toEqual([{ path: clipFilePath(r.clipsDir, CLIP), expected: { codec: "h264", width: 720, height: 1280 } }]);
  });

  test("a file ffmpeg sees several video streams in is refused INTERNAL, and nothing is encoded or written", async () => {
    let encoded = false;
    const r = await world({ deps: { videoStreams: async () => "several", encode: async () => void (encoded = true) } });
    const state = await r.settled(await r.started(CLIP));

    expect(errorOf(state)).toMatchObject({ code: "INTERNAL", detail: CLIP_FILE_DAMAGED_DETAIL });
    expect(encoded).toBe(false);
    expect(await r.folderNames()).toEqual([]);
  });

  test("a file the walker already refuses (two video tracks) never reaches ffmpeg", async () => {
    let asked = false;
    const r = await world({ deps: { videoStreams: async () => ((asked = true), "ok") } });
    // The record names these very bytes: only the walker can refuse them.
    await r.putClip(CLIP, await fixtures.twoVideos());
    const state = await r.settled(await r.started(CLIP));

    expect(errorOf(state)).toMatchObject({ code: "INTERNAL", detail: CLIP_FILE_DAMAGED_DETAIL });
    expect(asked).toBe(false);
    expect((await readdir(r.exportRoot)).filter((n) => n.startsWith(".studio-part"))).toEqual([]);
    expect(await r.folderNames()).toEqual([]);
  });
});
