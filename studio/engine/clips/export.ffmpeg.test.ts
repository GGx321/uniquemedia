import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobState } from "../../shared/engine";
import { runFfmpegArgv } from "../../node/runFfmpeg";
import { perfOnlyTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openFileSource } from "../media/video/fileSource";
import { probeVideo, type VideoInfo } from "../media/video/videoProbe";
import { clipExportArgv, type ExportFpsMode } from "./exportProfile";
import { verifyClipExport } from "./exportVerify";
import { runFfmpegForFixture, useClipFixtures } from "./testing/clipFixtures";
import { createExportRig, NOW, useExportFixtures, type ExportRig } from "./testing/exportRig";
import { clipFilePath } from "./store";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.13, §8 V4c «the encode»): real encodes by the bundled ffmpeg through the export job. A Kling std clip (720 x 1280), a Kling pro clip (1080 x 1920)
// and a Grok clip with an AAC track each become H.264 High 1080 x 1920 at a constant rate, the index before the media data, BT.709 tagged, with no sound; each EXPORT_FPS mode is run:
// `1080p30-interp` and `1080p30-dup` play at 30 fps, `1080p24` at 24. The library's file is the same bytes afterwards.

setDefaultTimeout(120_000);

const fixtures = useExportFixtures();
const CLIP = "clip-0000001";

let rig: ExportRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

async function exportOf(source: string, mode: ExportFpsMode): Promise<{ r: ExportRig; state: JobState; file: string }> {
  rig = await createExportRig({ fps: mode });
  await rig.putClip(CLIP, source);
  const jobId = await rig.started(CLIP);
  const state = await rig.settled(jobId);
  if (state.status !== "done" || state.kind !== "clip" || state.result?.kind !== "clip" || state.result.exported === undefined) throw new Error(`the export did not finish: ${JSON.stringify(state)}`);
  return { r: rig, state, file: join(rig.exportRoot, state.result.exported.relPath) };
}

async function infoOf(path: string): Promise<VideoInfo> {
  const opened = await openFileSource(path);
  try {
    const probe = await probeVideo(opened.source);
    if (!probe.ok) throw new Error(`the export did not probe: ${probe.reason}`);
    return probe.info;
  } finally {
    await opened.close();
  }
}

/** The top-level box types in order (an independent reading). */
async function topLevel(path: string): Promise<string[]> {
  const bytes = new Uint8Array(await readFile(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at);
    types.push(Buffer.from(bytes.subarray(at + 4, at + 8)).toString("latin1"));
    if (size < 8) break;
    at += size;
  }
  return types;
}

function expectDelivered(info: VideoInfo, fps: number): void {
  expect(info.video.codec).toBe("h264");
  expect([info.video.width, info.video.height]).toEqual([1080, 1920]);
  expect(info.video.sourceFps).toBeCloseTo(fps, 1);
  expect(info.video.variableFrameRate).toBe(false);
  expect(info.audioTracks).toBe(0);
  expect(info.video.colour).toMatchObject({ tagged: true, primaries: 1, transfer: 1, matrix: 1, fullRange: false });
}

describe("each EXPORT_FPS mode on a Kling std clip (720 x 1280, 24 fps)", () => {
  test.each([
    ["interpolate", "1080p30-interp", 30],
    ["duplicate", "1080p30-dup", 30],
    ["native24", "1080p24", 24],
  ] as const)("%s exports H.264 High 1080 x 1920 at a constant %s, faststart, BT.709, no sound", async (mode, profile, fps) => {
    const { r, file } = await exportOf(await fixtures.kling(), mode);

    expectDelivered(await infoOf(file), fps);
    expect((await topLevel(file)).filter((type) => type === "moov" || type === "mdat")).toEqual(["moov", "mdat"]);
    expect((await r.record(CLIP)).exports.map((line) => line.profile)).toEqual([profile]);
    expect((await verifyClipExport(file, { createdAt: new Date(NOW) })).ok).toBe(true);
  });
});

describe("the other sources", () => {
  test("a Kling pro clip (1080 x 1920) exports to the same profile", async () => {
    const { file } = await exportOf(await fixtures.pro(), "duplicate");
    expectDelivered(await infoOf(file), 30);
  });

  test("a Grok clip with an AAC track exports with no sound track", async () => {
    const source = await fixtures.grok();
    expect((await infoOf(source)).audioTracks).toBe(1);

    const { file } = await exportOf(source, "duplicate");

    expectDelivered(await infoOf(file), 30);
  });

  test("the library's file is byte for byte what it was", async () => {
    const source = await fixtures.grok();
    rig = await createExportRig({ fps: "duplicate" });
    await rig.putClip(CLIP, source);
    const before = await rig.sha(clipFilePath(rig.clipsDir, CLIP));

    await rig.settled(await rig.started(CLIP));

    expect(await rig.sha(clipFilePath(rig.clipsDir, CLIP))).toBe(before);
  });

  test("the encoded frames ffmpeg reports drive the job's progress up to its total", async () => {
    const { r, state } = await exportOf(await fixtures.kling(), "duplicate");
    const done = r.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload.done] : []));

    expect(done.at(-1)).toBeGreaterThan(0);
    expect([...done].sort((a, b) => a - b)).toEqual(done);
    // A 1 s clip at 30 fps.
    expect(state).toMatchObject({ status: "done", done: 30, total: 30 });
  });
});

describe("a source whose video track carries a DASH role", () => {
  /** The kling fixture remuxed with the video track marked `comment`: the muxer writes `udta/kind` for it. */
  async function roleSource(): Promise<string> {
    const source = await fixtures.kling();
    const out = `${source}.role.mp4`;
    await runFfmpegForFixture(["-i", source, "-map", "0:v", "-c", "copy", "-disposition:v:0", "default+comment", out]);
    return out;
  }

  test("the source really carries a kind box (the premise)", async () => {
    expect(Buffer.from(await readFile(await roleSource())).includes("urn:mpeg:dash:role:2011")).toBe(true);
  });

  test.each([
    ["interpolate", 30],
    ["duplicate", 30],
    ["native24", 24],
  ] as const)("%s exports it, passes the verifier and writes no kind box", async (mode, fps) => {
    const { file } = await exportOf(await roleSource(), mode);

    expectDelivered(await infoOf(file), fps);
    expect(Buffer.from(await readFile(file)).includes("urn:mpeg:dash:role:2011")).toBe(false);
    expect((await verifyClipExport(file, { createdAt: new Date(NOW) })).ok).toBe(true);
  });
});

// The «as built» numbers (plan s5b1 §5.13): what minterpolate costs against plain duplication on a 5 s 720p clip on this machine. A measurement, so it runs in the perf tier only.
const longer = useClipFixtures();
perfOnlyTest("the export's encode time: interpolate against duplicate, 5 s of 720p", async () => {
  const source = await longer({ width: 720, height: 1280, seconds: 5 });
  const times: Record<string, number> = {};
  for (const mode of ["interpolate", "duplicate"] as const) {
    const output = `${source}.${mode}.mp4`;
    const started = performance.now();
    await runFfmpegArgv({ argv: clipExportArgv({ input: source, output, mode, colour: { matrix: 1, fullRange: false, dynamicRange: "sdr" }, exportedAt: new Date(NOW) }), output, timeoutMs: 600_000 });
    times[mode] = Math.round(performance.now() - started);
  }
  console.log(`clip export, 5 s 720p: interpolate ${times.interpolate} ms, duplicate ${times.duplicate} ms`);
  expect(times.interpolate).toBeGreaterThan(0);
}, 600_000);
