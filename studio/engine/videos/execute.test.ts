import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { JobState } from "../../shared/engine";
import { JobRegistry } from "../jobs";
import { openLibrary, type Library } from "../library";
import { RenderQueue, type SubmitResult } from "../renderQueue/queue";
import { RasterError } from "../text/rasterTypes";
import type { PreviewGate } from "../text/preview";
import { StickerAssetError, type StickerAssets } from "./stickerAssets";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import { NODE_COMMIT_FS } from "./commitFs";
import { partNameOf } from "./record";
import { acceptingVerify, errnoError, exportFiles, fakeVideoBytes, faultyFs, FINAL, jpegWithArtist, libraryVideoFiles, listTree, specOf, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1: the `execute` for RenderQueue: the runner, then the commit, each
// job with its own prepared folder and temp path. ffmpeg is a fake here (the
// real one is in execute.ffmpeg.test.ts); everything else is real, queue included.

const world = useWorld();
const BYTES = fakeVideoBytes(4096, 11);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A fake ffmpeg: every call writes its output file, as a successful one would. */
const writingRun = async (opts: RunFfmpegArgvOptions): Promise<void> => {
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(opts.output, BYTES);
};

const planOf = (w: World, over: Partial<RenderPlan> = {}): RenderPlan => ({
  jobId: "job-00000001",
  videoId: "video-00000001",
  avatarId: w.avatar.id,
  safeName: "Mia",
  exportRoot: { root: w.exportRoot, rootId: w.rootId },
  spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 1000),
  resolvePhoto: () => ({ path: "/photos/p.jpg", width: 720, height: 1280 }),
  overlays: [],
  audio: { kind: "silent" },
  montageId: null,
  videoKind: "photo",
  music: null,
  ...over,
});

interface Rig {
  readonly w: World;
  readonly tracker: CommitTracker;
  readonly logs: string[];
  readonly queue: RenderQueue;
  readonly states: () => JobState[];
  submit(plan?: RenderPlan): SubmitResult;
}

function rig(over: Partial<VideoRenderDeps> = {}, library: VideoRenderDeps["library"] | undefined = undefined): Rig {
  const w = world();
  const tracker = new CommitTracker();
  const logs: string[] = [];
  const deps: VideoRenderDeps = {
    library: library ?? w.library,
    tracker,
    renderTmpDir: w.renderTmp,
    caseProbe: { isCaseInsensitive: async () => false },
    now: () => new Date(2026, 8, 29, 10, 0, 0),
    verify: acceptingVerify,
    runDeps: { run: writingRun },
    log: (line) => logs.push(line),
    ...over,
  };
  const execute = createRenderExecute(deps);
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  return {
    w,
    tracker,
    logs,
    queue,
    states: () => queue.states(),
    submit: (plan = planOf(w)) =>
      queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: plan.montageId }, totalFrames: totalFramesOf(plan.spec.clips), photoIds: [w.photos[0]?.id ?? ""], execute: execute(plan) }),
  };
}

const used = (library: Library, w: World): string[] => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn ?? [];

describe("a render job through the queue: runner, then commit", () => {
  test("ends done with the video's RenderResult, the file under its claimed name, the record committed and the photos used", async () => {
    const r = rig();
    r.submit();
    await r.queue.idle();
    const [state] = r.states();
    expect(state).toMatchObject({ status: "done", result: { kind: "render", videoId: "video-00000001", avatarId: r.w.avatar.id, bytes: BYTES.length, durationMs: 1000, videoKind: "photo", relPath: FINAL } });
    expect(readFileSync(join(r.w.exportRoot, FINAL))).toEqual(Buffer.from(BYTES));
    expect(await libraryVideoFiles(r.w)).toEqual(["video-00000001.json"]);
    expect(used(r.w.library, r.w)).toEqual(["video-00000001"]);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });

  test("the photos are never neither reserved nor used: at the moment the job ends they are already used", async () => {
    const w = world();
    const seen: Array<{ reserved: boolean; used: string[] }> = [];
    const tracker = new CommitTracker();
    // A library wired to the queue's own reserved set, as the engine opens it.
    const held: { of: (avatarId: string) => ReadonlySet<string> } = { of: () => new Set<string>() };
    const { library } = await openLibrary(w.libraryRoot, { reservedPhotos: (avatarId) => held.of(avatarId) });
    const deps: VideoRenderDeps = { library, tracker, renderTmpDir: w.renderTmp, caseProbe: { isCaseInsensitive: async () => false }, now: () => new Date(2026, 8, 29), verify: acceptingVerify, runDeps: { run: writingRun } };
    const queue = new RenderQueue({
      jobs: new JobRegistry(),
      size: () => 1,
      beforeRelease: () => {
        const state = library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "");
        seen.push({ reserved: state?.reserved ?? false, used: state?.usedIn ?? [] });
      },
    });
    held.of = (avatarId) => queue.reservedPhotos(avatarId);
    const plan = planOf(w);
    queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: null }, totalFrames: 30, photoIds: [w.photos[0]?.id ?? ""], execute: createRenderExecute(deps)(plan) });
    await queue.idle();
    expect(seen).toEqual([{ reserved: true, used: ["video-00000001"] }]);
  });

  test("writes the runner's temp beside the final file under .studio-part-<jobId>.mp4, and registers it as live while the job runs", async () => {
    const w = world();
    const during: boolean[] = [];
    const r = rig({
      runDeps: {
        run: async (opts) => {
          if (opts.output.endsWith(partNameOf("job-00000001"))) during.push(r.tracker.hasTemp(join(w.exportRoot, "Mia", partNameOf("job-00000001"))));
          await writingRun(opts);
        },
      },
    });
    r.submit();
    await r.queue.idle();
    expect(during).toEqual([true]);
  });

  test("registers the claimed placeholder as live, and forgets both paths when the job is over", async () => {
    const r = rig({
      hooks: {
        reached: (step) => {
          if (step === "name-claimed") {
            expect(r.tracker.hasPlaceholder(join(r.w.exportRoot, FINAL))).toBe(true);
            expect(r.tracker.placeholderPaths().size).toBe(1);
            expect(r.tracker.tempPaths().size).toBe(1);
          }
        },
      },
    });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]?.status).toBe("done");
    expect(r.tracker.tempPaths().size).toBe(0);
    expect(r.tracker.placeholderPaths().size).toBe(0);
  });

  test("forgets its paths when the job fails, too", async () => {
    const r = rig({ verify: async () => ({ result: { ok: false, reasons: [{ code: "FRAME_COUNT_MISMATCH", message: "m" }] }, sha256: null, bytes: 1 }) });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "RENDER_VERIFY_FAILED" } });
    expect(r.tracker.tempPaths().size).toBe(0);
    expect(r.tracker.placeholderPaths().size).toBe(0);
  });

  test("reports frames through the context's progress, capped below the total until the job ends", async () => {
    const r = rig({
      runDeps: {
        run: async (opts) => {
          opts.onFrames?.(9);
          await writingRun(opts);
        },
      },
    });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "done", done: 30, total: 30 });
  });

  test("the frame count the verifier must find is the timeline's own, from the same function the queue submits", async () => {
    const seen: number[] = [];
    const r = rig({
      verify: async (path, expected) => {
        seen.push(expected.frames);
        return acceptingVerify(path);
      },
    });
    const plan = planOf(r.w, { spec: specOf(r.w.avatar.id, [r.w.photos[0]?.id ?? "", r.w.photos[1]?.id ?? ""], 1500) });
    r.submit(plan);
    await r.queue.idle();
    expect(seen).toEqual([90]);
    expect(totalFramesOf(plan.spec.clips)).toBe(90);
  });
});

describe("cancel", () => {
  test("a cancel while ffmpeg runs ends the job cancelled, with nothing left in the export folder or the library, and the photos free", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const r = rig({
      runDeps: {
        run: (opts) =>
          new Promise<void>((_resolve, reject) => {
            started();
            opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
          }),
      },
    });
    r.submit();
    await running;
    r.queue.cancel("job-00000001");
    await r.queue.idle();
    expect(r.states()[0]?.status).toBe("cancelled");
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(used(r.w.library, r.w)).toEqual([]);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });

  test("a cancel that arrives after the name is claimed does not undo the commit: DONE WINS, with the record and the photos used", async () => {
    const r = rig({
      hooks: {
        reached: (step) => {
          if (step === "name-claimed") r.queue.cancel("job-00000001");
        },
      },
    });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "done", result: { relPath: FINAL } });
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(used(r.w.library, r.w)).toEqual(["video-00000001"]);
  });

  test("a cancel that arrives while the file is being verified (before the claim) ends the job cancelled and cleans up", async () => {
    const r = rig({
      verify: async (path) => {
        r.queue.cancel("job-00000001");
        return acceptingVerify(path);
      },
    });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]?.status).toBe("cancelled");
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(used(r.w.library, r.w)).toEqual([]);
  });
});

describe("failures reach the queue as the contract's errors", () => {
  test("an export folder that is gone at job time fails EXPORT_UNAVAILABLE missing, before ffmpeg runs", async () => {
    let ran = false;
    const r = rig({
      runDeps: {
        run: async (opts) => {
          ran = true;
          await writingRun(opts);
        },
      },
    });
    r.submit(planOf(r.w, { exportRoot: { root: join(r.w.dir, "gone"), rootId: r.w.rootId } }));
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(ran).toBe(false);
  });

  test("a full export disk when the name is claimed fails EXPORT_UNAVAILABLE not-enough-space and leaves the folder clean", async () => {
    const r = rig({
      fs: {
        ...NODE_COMMIT_FS,
        createExclusive: () => Promise.reject(errnoError("ENOSPC")),
      },
    });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" } });
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a verifier refusal fails RENDER_VERIFY_FAILED, keeps no file and no record, and releases the photos unused", async () => {
    const r = rig({ verify: async () => ({ result: { ok: false, reasons: [{ code: "UUID_BOX", message: "m", path: "moov" }] }, sha256: null, bytes: 1 }) });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "RENDER_VERIFY_FAILED", detail: "the output failed verification (UUID_BOX)" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(used(r.w.library, r.w)).toEqual([]);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });

  test("an unreadable source photo fails the job before ffmpeg runs, and says nothing about paths", async () => {
    const w = world();
    let ran = false;
    const library: VideoRenderDeps["library"] = {
      root: w.library.root,
      readPhotoVerified: () => Promise.reject(new Error(`cannot open ${w.dir}/secret`)),
      addVideoRecordToIndex: (a, b) => w.library.addVideoRecordToIndex(a, b),
      reloadVideoRecords: (a) => w.library.reloadVideoRecords(a),
      flagVideoIndexStale: (a, b) => w.library.flagVideoIndexStale(a, b),
    };
    const r = rig(
      {
        runDeps: {
          run: async (opts) => {
            ran = true;
            await writingRun(opts);
          },
        },
      },
      library,
    );
    r.submit();
    await r.queue.idle();
    const state = r.states()[0];
    expect(state).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(JSON.stringify(state)).not.toContain(w.dir);
    expect(ran).toBe(false);
  });
});

describe("the source photos' own text is handed to the verifier", () => {
  test("an Artist in a source photo's EXIF becomes a forbidden string; the engine's own text never does", async () => {
    const w = world();
    const photo = jpegWithArtist("Jane Q. Photographer");
    const library: VideoRenderDeps["library"] = {
      root: w.library.root,
      readPhotoVerified: async () => photo,
      addVideoRecordToIndex: (a, b) => w.library.addVideoRecordToIndex(a, b),
      reloadVideoRecords: (a) => w.library.reloadVideoRecords(a),
      flagVideoIndexStale: (a, b) => w.library.flagVideoIndexStale(a, b),
    };
    const seen: Array<readonly string[] | undefined> = [];
    const r = rig(
      {
        verify: async (path, expected) => {
          seen.push(expected.forbiddenStrings);
          return acceptingVerify(path);
        },
      },
      library,
    );
    r.submit();
    await r.queue.idle();
    expect(seen).toEqual([["Jane Q. Photographer"]]);
  });
});

describe("the used index throwing after the record is committed", () => {
  test("the job still ends DONE, the index is rebuilt from the record on disk, and the photos are used", async () => {
    const w = world();
    const library: VideoRenderDeps["library"] = {
      root: w.library.root,
      readPhotoVerified: (id) => w.library.readPhotoVerified(id),
      addVideoRecordToIndex: () => {
        throw new Error("index exploded");
      },
      reloadVideoRecords: (a) => w.library.reloadVideoRecords(a),
      flagVideoIndexStale: (a, b) => w.library.flagVideoIndexStale(a, b),
    };
    const r = rig({}, library);
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]?.status).toBe("done");
    expect(used(w.library, w)).toEqual(["video-00000001"]);
    expect(r.logs.join("\n")).toContain("could not take the committed record");
    expect(await libraryVideoFiles(w)).toEqual(["video-00000001.json"]);
  });
});

describe("the export folder's own entry is made durable", () => {
  test("the root is flushed after the avatar's folder is prepared and before anything is written into it", async () => {
    const fs = faultyFs();
    const r = rig({ fs });
    r.submit();
    await r.queue.idle();
    const calls = fs.calls;
    const flushed = calls.indexOf(`fsyncDir ${r.w.exportRoot}`);
    expect(flushed).toBeGreaterThanOrEqual(0);
    expect(flushed).toBeLessThan(calls.findIndex((c) => c.startsWith("fsyncFile")));
    expect(flushed).toBeLessThan(calls.findIndex((c) => c.startsWith("createExclusive")));
  });

  test("a root that cannot be flushed does not fail the job: it is logged with its code", async () => {
    const fs = faultyFs();
    fs.failOnce("fsyncDir", errnoError("EIO"), (args) => args[0] === world().exportRoot);
    const r = rig({ fs });
    r.submit();
    await r.queue.idle();
    expect(r.states()[0]?.status).toBe("done");
    expect(r.logs.join("\n")).toContain("EIO");
  });
});

describe("the tracker follows the job", () => {
  test("the job's id is live while it runs and forgotten when it ends", async () => {
    const seen: boolean[] = [];
    const r = rig({
      hooks: {
        reached: (step) => {
          if (step === "name-claimed") seen.push(r.tracker.hasJob("job-00000001"));
        },
      },
    });
    r.submit();
    await r.queue.idle();
    expect(seen).toEqual([true]);
    expect(r.tracker.hasJob("job-00000001")).toBe(false);
  });
});

describe("the spec's layers (3b.6)", () => {
  const textLayer = { layerId: "layer-t1", kind: "text" as const, startMs: 0, endMs: 1000, value: "hello", font: "manrope" as const, style: "plaque" as const, color: "#ffffff", x: 0.5, y: 0.2, scale: 1 };
  const stickerLayer = { layerId: "layer-s1", kind: "sticker" as const, startMs: 0, endMs: 1000, sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, x: 0.7, y: 0.4, size: 0.2 };
  const withLayers = (w: World, layers: RenderPlan["spec"]["layers"]): RenderPlan => planOf(w, { spec: { ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 1000), layers } });

  /** A text gate that answers a fixed picture and records what it was asked. */
  function gateOf(over: Partial<{ caption: PreviewGate["caption"] }> = {}): { gate: PreviewGate; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      gate: {
        caption:
          over.caption ??
          (async (request) => {
            asked.push(request.value);
            return { png: Uint8Array.from([137, 80, 78, 71]), width: 700, height: 120, layout: { fontSize: 56, lines: [request.value], width: 700, height: 120 }, workerMs: 1 };
          }),
      },
    };
  }
  const stickers: StickerAssets = { read: async () => ({ bytes: Uint8Array.from([1, 2, 3]), loopFrames: 24, width: 320, height: 320 }) };

  /** Every ffmpeg call's output, and what the job folder held when it ran. */
  function recordingRun(dirs: string[][]): NonNullable<VideoRenderDeps["runDeps"]>["run"] {
    return async (opts) => {
      const jobDir = dirname(opts.output).endsWith("render-tmp") || !opts.output.includes("job-00000001") ? "" : dirname(opts.output);
      dirs.push([opts.output, ...(jobDir !== "" && existsSync(jobDir) ? (await readdir(jobDir)).sort() : [])]);
      await writingRun(opts);
    };
  }

  test("draws the text, stages the files into the job's folder before any ffmpeg, runs the layer call, and ends done", async () => {
    const { gate, asked } = gateOf();
    const dirs: string[][] = [];
    const r = rig({ layers: { gate, stickers }, runDeps: { run: recordingRun(dirs) } });
    r.submit(withLayers(r.w, [textLayer, stickerLayer]));
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "done" });
    expect(asked).toEqual(["hello"]);
    const outputs = dirs.map((d) => d[0] ?? "");
    expect(outputs.map((o) => o.split(/[\\/]/).at(-1))).toEqual(["clip-00.mkv", "layers-00.mkv", ".studio-part-job-00000001.mp4"]);
    // The very first call already finds both files staged.
    expect(dirs[0]?.slice(1)).toEqual(expect.arrayContaining(["sticker-01.apng", "text-00.png"]));
  });

  test("without layers it never touches the gate, stages nothing and runs no layer call", async () => {
    const { gate, asked } = gateOf();
    const dirs: string[][] = [];
    const r = rig({ layers: { gate, stickers }, runDeps: { run: recordingRun(dirs) } });
    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "done" });
    expect(asked).toEqual([]);
    expect(dirs.map((d) => (d[0] ?? "").split(/[\\/]/).at(-1))).toEqual(["clip-00.mkv", ".studio-part-job-00000001.mp4"]);
  });

  test("a spec with layers and an engine without the layer machinery fails INTERNAL before any ffmpeg and any export file", async () => {
    let ran = false;
    const r = rig({ runDeps: { run: async (opts) => ((ran = true), writingRun(opts)) } });
    r.submit(withLayers(r.w, [textLayer]));
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(ran).toBe(false);
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a caption that breaks a rule fails the job TEXT_INVALID with the rule, before any ffmpeg and any export file", async () => {
    let ran = false;
    const { gate } = gateOf({ caption: () => Promise.reject(new RasterError("CAPTION_INVALID", "a character outside the charset", { captionIssue: "charset" })) });
    const r = rig({ layers: { gate, stickers }, runDeps: { run: async (opts) => ((ran = true), writingRun(opts)) } });
    r.submit(withLayers(r.w, [textLayer]));
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "TEXT_INVALID", captionIssue: "charset" } });
    expect(ran).toBe(false);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });

  test("a sticker the verified set cannot vouch for fails the job RENDER_FAILED, naming no path", async () => {
    const { gate } = gateOf();
    const bad: StickerAssets = { read: () => Promise.reject(new StickerAssetError("tampered", "sticker heart-pulse is not the file the catalogue lists")) };
    const r = rig({ layers: { gate, stickers: bad } });
    r.submit(withLayers(r.w, [stickerLayer]));
    await r.queue.idle();

    const state = r.states()[0];
    expect(state).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(JSON.stringify(state)).not.toContain(r.w.dir);
  });

  test("a cancel while the text is being drawn ends the job cancelled and cleans up", async () => {
    let asked: () => void = () => undefined;
    const drawing = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { gate } = gateOf({
      caption: (_request, options) =>
        new Promise((_resolve, reject) => {
          asked();
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        }),
    });
    const r = rig({ layers: { gate, stickers } });
    r.submit(withLayers(r.w, [textLayer]));
    await drawing;
    r.queue.cancel("job-00000001");
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("cancelled");
    expect(await exportFiles(r.w)).toEqual([]);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });
});

describe("construction", () => {
  test("refuses to run without a render temp folder: there is no os.tmpdir fallback", () => {
    const w = world();
    expect(() => createRenderExecute({ library: w.library, tracker: new CommitTracker(), renderTmpDir: "", caseProbe: { isCaseInsensitive: async () => false }, now: () => new Date() })).toThrow(TypeError);
  });

  test("a job id or a safe name that is not safe is refused before any disk is touched", async () => {
    const r = rig();
    const execute = createRenderExecute({ library: r.w.library, tracker: r.tracker, renderTmpDir: r.w.renderTmp, caseProbe: { isCaseInsensitive: async () => false }, now: () => new Date() });
    await expect(execute(planOf(r.w, { safeName: "../evil" }))({ signal: new AbortController().signal, progress: () => null, saving: () => undefined })).rejects.toThrow();
    expect(await listTree(r.w.exportRoot)).toEqual([".studio-export.json"]);
    expect(existsSync(join(r.w.dir, "evil"))).toBe(false);
    expect((await readdir(r.w.renderTmp)).length).toBe(0);
  });
});
