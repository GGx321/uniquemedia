import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip, Layer } from "../../shared/engine/montage";
import { textBox } from "../../shared/montage";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { extractFrames, runFfmpegOk, videoFrames } from "../render/ffmpeg.testkit";
import { buildLayerPass } from "../render";
import { expectedBt709Limited, lumaPerFrame, makeSolid, makeWorkDir, meanAround, removeDir, splitYuv420, writeBytes } from "../render/render.testkit";
import { runFfmpegArgv } from "../../node/runFfmpeg";
import { runRenderJob } from "../renderQueue/runner";
import { createCaptionRenderer } from "../text/caption/renderer";
import { decodePng, type Rgba } from "../text/caption/png.testkit";
import { openEmojiFont } from "../text/emoji/emojiFont";
import { loadPinnedEmojiFont } from "../text/emoji/emojiFont.testkit";
import { createTextRasteriser, RASTER_WASM } from "../text/rasteriser";
import { resolveLayers } from "./layers";
import { createStickerAssets } from "./stickerAssets";
useNativeGlobals();

// REAL everything but the worker thread: the engine's real caption renderer (resvg-wasm, the bundled fonts and emoji) draws the
// text, the real built-in stickers are read through the verified set, and `resolveLayers` + `runRenderJob` stage them, run the
// layer pass and pass 2 on the bundled ffmpeg. What is asserted is what a viewer sees in the finished video (plan 3b.6):
// - a REAL caption raster is placed where `textBox` says, its opaque plaque keeps its colour in BT.709 (invariant 36), and it
//   shows in its window only;
// - a REAL built-in sticker loops at its stored period of 24 frames, and a second copy that starts 12 frames later shows the
//   same pictures 12 frames later: the frame shown is `(t - start) mod loop`.

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);
const STICKER_DIR = join(import.meta.dir, "..", "..", "assets", "stickers");

const clip: Clip = { clipId: "flat", durationMs: 1500, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "flat" }, focus: null }, motion: "static" };
const clips: Clip[] = [clip, { ...clip, clipId: "flat-2" }]; // 90 frames
const PLAQUE = "#ffd166";
const PLAQUE_RGB = [255, 209, 102] as const;
const LOOP = 24;

const caption: Extract<Layer, { kind: "text" }> = { layerId: "layer-0001", kind: "text", startMs: 1_000, endMs: 2_000, value: "sunday reset", font: "manrope", style: "plaque", color: PLAQUE, x: 0.5, y: 0.2, scale: 1 }; // frames [30, 60)
const flashA: Extract<Layer, { kind: "sticker" }> = { layerId: "layer-0002", kind: "sticker", startMs: 0, endMs: 3_000, sticker: { source: "builtin", stickerId: "lightning-flash" }, x: 0.25, y: 0.7, size: 0.25 }; // frames [0, 90)
const flashB: Extract<Layer, { kind: "sticker" }> = { ...flashA, layerId: "layer-0003", startMs: 400, x: 0.75 }; // frames [12, 90): 12 frames later

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const NO_BOX: Box = { x: 0, y: 0, w: 0, h: 0 };

let dir: string;
let output: string;
let framesOut: number;
let png: Rgba;
let box: Box;
let sigA: Uint8Array[];
let sigB: Uint8Array[];
let stagedFiles: string[] = [];
let layerFramesReported = 0;

const SIG = 16;
/** Every frame of `path` inside `region`, shrunk to 16 x 16 gray: a picture's signature, which tells two phases of an animation apart where a mean luma cannot. */
async function signatures(path: string, region: Box): Promise<Uint8Array[]> {
  const r = await runFfmpegOk(["-hide_banner", "-nostdin", "-i", path, "-vf", `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=${SIG}:${SIG}:flags=area,format=gray`, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
  const out: Uint8Array[] = [];
  for (let o = 0; o + SIG * SIG <= r.stdout.length; o += SIG * SIG) out.push(r.stdout.subarray(o, o + SIG * SIG));
  return out;
}

/** The mean absolute difference per pixel of the signatures of frames `a` and `b`, in code values. */
function distance(sigs: readonly Uint8Array[], a: number, b: number, other: readonly Uint8Array[] = sigs): number {
  const [x, y] = [sigs[a], other[b]];
  if (x === undefined || y === undefined) throw new Error(`no frame ${a} or ${b}`);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] ?? 0) - (y[i] ?? 0));
  return sum / x.length;
}

beforeAll(async () => {
  dir = makeWorkDir("layers-real");
  const rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  const renderer = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
  const flat = join(dir, "flat.jpg");
  await makeSolid(flat, "0x808080", 720, 1280, "jpeg");

  const tmpRoot = join(dir, "render-tmp");
  const jobDir = join(tmpRoot, "job-00000001");
  output = join(dir, ".studio-part-job-00000001.mp4");
  const resolved = await resolveLayers(
    [caption, flashA, flashB],
    jobDir,
    { gate: { caption: async (request) => ({ ...(await renderer.render(request)), workerMs: 0 }) }, stickers: createStickerAssets(STICKER_DIR) },
    new AbortController().signal,
  );
  box = resolved.overlays[0]?.box ?? NO_BOX;
  const stickerA = resolved.overlays[1]?.box ?? NO_BOX;
  const stickerB = resolved.overlays[2]?.box ?? NO_BOX;
  // The caption's own raster, to read the plaque's pixels from.
  png = decodePng((await renderer.render(caption)).png);

  await runRenderJob({
    jobId: "job-00000001",
    tmpRoot,
    seed: 1,
    clips,
    resolvePhoto: () => ({ path: flat, width: 720, height: 1280 }),
    overlays: resolved.overlays,
    stageLayers: async (to) => {
      await resolved.stage(to);
      stagedFiles = resolved.overlays.map((o) => o.path);
    },
    audio: { kind: "silent" },
    output,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  }, {
    // The real ffmpeg, watched: what it reports for the layer call is what the runner's frame check reads.
    run: (opts) =>
      runFfmpegArgv({
        ...opts,
        onFrames: (frames) => {
          if (opts.output.includes("layers-")) layerFramesReported = Math.max(layerFramesReported, frames);
          opts.onFrames?.(frames);
        },
      }),
  });
  framesOut = await videoFrames(output);
  sigA = await signatures(output, stickerA);
  sigB = await signatures(output, stickerB);
}, 240_000);

afterAll(() => removeDir(dir));

describe("real captions and real stickers through the runner on real ffmpeg", () => {
  test("the job runs to a finished file of exactly the timeline's 90 frames, from three staged files", () => {
    expect(framesOut).toBe(90);
    expect(stagedFiles).toHaveLength(3);
  });

  test("the real ffmpeg reports every frame of the layer file, so the runner's check that it has the timeline's frames is not vacuous", () => {
    expect(layerFramesReported).toBe(90);
  });

  test("the caption raster is placed by textBox: its box is centred where the layer says, inside the frame", () => {
    expect(box).toEqual(textBox(caption, { w: png.width, h: png.height }));
    expect(box.x + box.w / 2).toBeCloseTo(540, -1);
    expect(box.y + box.h / 2).toBeCloseTo(384, -1);
  });

  /**
   * The centre of an 11 x 11 block of the raster that is all one opaque plaque colour (left of the text, inside the rounded corners):
   * a pixel with neighbours of its own colour on every side, so a sample of a few pixels around it reads the plaque only.
   */
  function plaqueBlock(): { x: number; y: number } {
    const half = 5;
    for (let y = half; y < png.height - half; y++) {
      for (let x = half; x < png.width - half; x++) {
        let uniform = true;
        for (let dy = -half; dy <= half && uniform; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            const at = ((y + dy) * png.width + x + dx) * 4;
            if (png.data[at] !== PLAQUE_RGB[0] || png.data[at + 1] !== PLAQUE_RGB[1] || png.data[at + 2] !== PLAQUE_RGB[2] || png.data[at + 3] !== 255) {
              uniform = false;
              break;
            }
          }
        }
        if (uniform) return { x, y };
      }
    }
    throw new Error("the raster has no uniform plaque block");
  }

  test("the plaque's opaque colour is BT.709 limited range within 1.5 code values, at the pixel the box puts it", async () => {
    const p = plaqueBlock();
    const [frame] = await extractFrames(output, [45], "yuv420p", { w: 1080, h: 1920 });
    const planes = splitYuv420(frame ?? new Uint8Array(), 1080, 1920);
    const x = box.x + p.x;
    const y = box.y + p.y;
    const got = [meanAround(planes.y, 1080, x, y, 3), meanAround(planes.u, 540, x / 2, y / 2, 1.5), meanAround(planes.v, 540, x / 2, y / 2, 1.5)];
    const want = expectedBt709Limited([...PLAQUE_RGB]);
    for (const [i, g] of got.entries()) expect(Math.abs(g - (want[i] ?? 0))).toBeLessThanOrEqual(1.5);
  });

  test("the caption shows on [30, 60) and on no other frame", async () => {
    const p = plaqueBlock();
    const region = { x: Math.floor((box.x + p.x - 4) / 2) * 2, y: Math.floor((box.y + p.y - 4) / 2) * 2, w: 8, h: 8 };
    const luma = await lumaPerFrame(output, region, 0);
    const plaqueY = expectedBt709Limited([...PLAQUE_RGB])[0] ?? 0;
    const shown = luma.map((v) => Math.abs(v - plaqueY) <= 3);
    expect(shown).toEqual(luma.map((_, f) => f >= 30 && f < 60));
  });

  test("a built-in sticker is animated: some picture of its loop differs from the first", () => {
    expect(Math.max(...Array.from({ length: LOOP }, (_, f) => distance(sigA, 0, f)))).toBeGreaterThan(3);
  });

  test("a built-in sticker loops at its stored period: frame f and frame f + 24 are the same picture, for the whole window", () => {
    for (let f = 0; f + LOOP < sigA.length; f++) expect(distance(sigA, f, f + LOOP)).toBeLessThan(1);
  });

  test("the loop is not shorter than its period: at least one frame pair 12 apart is a different picture", () => {
    expect(Math.max(...Array.from({ length: sigA.length - 12 }, (_, f) => distance(sigA, f, f + 12)))).toBeGreaterThan(3);
  });

  test("a copy that starts 12 frames later shows the same pictures 12 frames later: the frame shown is (t - start) mod loop", () => {
    for (let f = 12; f < sigB.length; f++) expect(distance(sigB, f, f - 12, sigA)).toBeLessThan(1);
  });

  test("and that copy is out of phase with the first one, so the test above is not satisfied by two identical pictures", () => {
    const apart = Array.from({ length: sigB.length - 12 }, (_, k) => distance(sigB, k + 12, k + 12, sigA));
    expect(Math.max(...apart)).toBeGreaterThan(3);
  });

  test("the later copy is not there before its start: those frames are the flat background", () => {
    for (let f = 1; f < 12; f++) expect(distance(sigB, 0, f)).toBeLessThan(0.5);
  });
});

describe("every built-in sticker goes through the layer pass under -xerror", () => {
  // ffmpeg exits 0 on a broken frame and silently shortens a loop, so the layer call stops on the first one (`-xerror`). A set that
  // trips it would fail every render that uses it: all ten are run, each looped over a 90-frame timeline.
  test.each(STICKER_MANIFEST.map((s) => [s.id] as const))("%s decodes without a single error and fills 90 frames", async (id) => {
    const asset = await createStickerAssets(STICKER_DIR).read(id);
    const path = join(dir, `${id}.apng`);
    writeBytes(path, asset.bytes);
    const layer = { path, format: "apng" as const, box: { x: 100, y: 200, w: 320, h: 320 }, resize: true, startFrame: 0, endFrame: 90, loopFrames: asset.loopFrames, sourceSize: { w: asset.width, h: asset.height } };
    const [job] = buildLayerPass({ layers: [layer], totalFrames: 90, clipDir: dir }).jobs;
    if (job === undefined) throw new Error("expected one layer call");

    await runFfmpegOk(job.argv);

    expect(await videoFrames(job.output)).toBe(90);
  });
});
