import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { encodeApng } from "../../scripts/stickers/apngWriter";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { verifyRenderedMp4 } from "../verify";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { extractFrames, probeVideo, runBinary, runFfmpegOk, videoFrames } from "./ffmpeg.testkit";
import { buildLayerPass } from "./layerPass";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import {
  expectedBt709Limited,
  lumaPerFrame as readLuma,
  makeSolid,
  makeStickerPng,
  makeWorkDir,
  meanAround,
  mixRgb,
  removeDir,
  runLayersAndPass2,
  runPass1,
  runPass2,
  splitYuv420,
  stickerColour,
  tamperGraph,
  withDirectStill,
  writeBytes,
  type RGB,
} from "./render.testkit";
import type { LayerPassJob, OverlayInput } from "./types";
useNativeGlobals();

// REAL ffmpeg, the layer pass and pass 2 over it (plan 3b.6): a text-like RGBA PNG and two animated stickers are
// composited onto a transparent lossless file, which pass 2 overlays as ONE stream.
//
// What is proved, on decoded pixels and never on the filter string:
// - each layer is on screen exactly in its window [start, end) and nowhere else;
// - a sticker shows source frame `(f - start) mod loop` at timeline frame f, on the 30 fps grid, for a loop that does
//   not divide its window (7 frames in a 48-frame window starting at 33);
// - the colour stays BT.709 through BOTH steps (the layer file, then the final encode): an opaque colour within 1 code,
//   an alpha-128 blend within 2, against the BT.709 value computed from the RGBA; the naive chain is 14.6 codes off, and a
//   graph with the explicit conversion cut out FAILS the same check (the negative control);
// - the two-step composite agrees with pass 2's direct overlay (the transparent-main un-premultiply question);
// - the lengths are exact (90 frames, layers file and output) and the output passes the verifier.

const TOTAL = 90; // two 1.5 s clips
const BG_Y = 126; // flat 0x808080 through the photo chain
const GREY_RGB: RGB = [128, 128, 128];

// A 7-frame counter: frame i is solid grey 20 + 32 i. Its luma classes sit at least 10 codes apart, and clear of the background's.
const LOOP = 7;
const counterGrey = (i: number): number => 20 + 32 * i;
const counterLuma = (i: number): number => 16 + (219 / 255) * counterGrey(i);

const TEXT_BOX = { x: 100, y: 300, w: 400, h: 300 }; // the 400x300 RGBA test PNG, as a text raster would be: not scaled
const WINDOWED = { x: 600, y: 300, w: 128, h: 128 }; // counter, frames [33, 81)
const SPANNING = { x: 600, y: 800, w: 128, h: 128 }; // counter, frames [0, 90)
const TAIL = { x: 100, y: 1000, w: 200, h: 200 }; // white, frames [60, 90)
const SHORT_LOOP = { x: 800, y: 1300, w: 128, h: 128 }; // the same 7-frame file with a STORED period of 5, frames [0, 90)
const SHORT_PERIOD = 5;
const TEXT_WINDOW = [30, 60] as const;
const WINDOWED_WINDOW = [33, 81] as const;

const clip: Clip = { clipId: "flat", durationMs: 1500, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "flat" }, focus: null }, motion: "static" };
const clips: Clip[] = [clip, { ...clip, clipId: "flat-2" }];

let dir: string;
let layerJobs: readonly LayerPassJob[];
let layerFile: string;
let finalMp4: string;
let directMp4: string;
let layerFrames: number;
let finalFrames: number;
let textOverlay: OverlayInput;
const lumaCache = new Map<string, number[]>();

async function renderThrough(layers: readonly OverlayInput[], output: string, tamper?: (job: LayerPassJob) => readonly string[]): Promise<readonly LayerPassJob[]> {
  const plan = buildLayerPass({ layers, totalFrames: TOTAL, clipDir: dir });
  for (const job of plan.jobs) await runFfmpegOk(tamper === undefined ? job.argv : tamper(job));
  await runPass2(buildPass2({ clips, clipDir: dir, output, overlays: plan.final === null ? [] : [plan.final], audio: { kind: "silent" } }));
  return plan.jobs;
}

/** `lumaPerFrame` of `path`, read once per region. */
async function lumaPerFrame(path: string, box: { x: number; y: number; w: number; h: number }): Promise<number[]> {
  const key = `${path}:${box.x},${box.y},${box.w},${box.h}`;
  const hit = lumaCache.get(key);
  if (hit !== undefined) return hit;
  const luma = await readLuma(path, box);
  lumaCache.set(key, luma);
  return luma;
}

const nearest = (value: number, classes: readonly number[]): number => classes.reduce((best, c, i) => (Math.abs(c - value) < Math.abs((classes[best] ?? 0) - value) ? i : best), 0);

beforeAll(async () => {
  dir = makeWorkDir("layers");
  const flat = join(dir, "flat.jpg");
  await makeSolid(flat, "0x808080", 720, 1280, "jpeg");
  const textPng = await makeStickerPng(dir, "text-00-src");
  copyFileSync(textPng, join(dir, "text-00.png"));
  await makeSolid(join(dir, "white.png"), "white", 200, 200, "png-rgba");
  const frames = Array.from({ length: LOOP }, (_, i) => {
    const px = new Uint8Array(64 * 64 * 4);
    for (let p = 0; p < 64 * 64; p++) px.set([counterGrey(i), counterGrey(i), counterGrey(i), 255], p * 4);
    return px;
  });
  writeBytes(join(dir, "counter.apng"), encodeApng({ width: 64, height: 64, frames }));

  await runPass1(buildPass1({ seed: 1, clips, resolvePhoto: () => ({ path: flat, width: 720, height: 1280 }), clipDir: dir }));

  textOverlay = { path: join(dir, "text-00.png"), format: "png", box: TEXT_BOX, resize: false, startFrame: TEXT_WINDOW[0], endFrame: TEXT_WINDOW[1] };
  const layers: OverlayInput[] = [
    textOverlay,
    { path: join(dir, "counter.apng"), format: "apng", box: WINDOWED, resize: true, startFrame: WINDOWED_WINDOW[0], endFrame: WINDOWED_WINDOW[1], loopFrames: LOOP, sourceSize: { w: 64, h: 64 } },
    { path: join(dir, "counter.apng"), format: "apng", box: SPANNING, resize: true, startFrame: 0, endFrame: TOTAL, loopFrames: LOOP, sourceSize: { w: 64, h: 64 } },
    { path: join(dir, "white.png"), format: "png", box: TAIL, resize: false, startFrame: 60, endFrame: TOTAL },
    { path: join(dir, "counter.apng"), format: "apng", box: SHORT_LOOP, resize: true, startFrame: 0, endFrame: TOTAL, loopFrames: SHORT_PERIOD, sourceSize: { w: 64, h: 64 } },
  ];
  finalMp4 = join(dir, "final.mp4");
  layerJobs = await renderThrough(layers, finalMp4);
  layerFile = layerJobs.at(-1)?.output ?? "";
  layerFrames = await videoFrames(layerFile);
  finalFrames = await videoFrames(finalMp4);

  // The same text PNG through pass 2's direct overlay, with no layer pass: what the two-step composite is compared with.
  directMp4 = join(dir, "direct.mp4");
  await runPass2(withDirectStill(buildPass2({ clips, clipDir: dir, output: directMp4, overlays: [], audio: { kind: "silent" } }), textOverlay));
}, 240_000);

afterAll(() => removeDir(dir));

describe("layers on real ffmpeg: the files", () => {
  test("the layer pass wrote one call's file for five layers", () => {
    expect(layerJobs).toHaveLength(1);
  });

  test("the layer file holds exactly the timeline's 90 frames", () => {
    expect(layerFrames).toBe(TOTAL);
  });

  test("the layer file is lossless FFV1 with an alpha plane", async () => {
    const stream = (await probeVideo(layerFile)).streams[0];
    expect(stream?.codec_name).toBe("ffv1");
    expect(stream?.pix_fmt).toBe("yuva420p");
  });

  test("the output holds exactly 90 frames, with five layers over it", () => {
    expect(finalFrames).toBe(TOTAL);
  });

  test("the output passes the verifier: the box allow-list, the length and the metadata rule", async () => {
    expect(await verifyRenderedMp4(finalMp4, { frames: TOTAL })).toEqual({ ok: true });
  });
});

describe("layers on real ffmpeg: a text PNG shows only in its window [30, 60)", () => {
  // The PNG's first colour cell (220, 40, 40), opaque, at the box's top-left.
  const cell = { x: TEXT_BOX.x, y: TEXT_BOX.y, w: 100, h: 100 };
  const red = (frame: number): "overlay" | "background" => ((frame >= 30 && frame < 60) ? "overlay" : "background");

  test("every one of the 90 frames shows the overlay inside the window and the background outside it", async () => {
    const luma = await lumaPerFrame(finalMp4, { ...cell, x: cell.x - 0, y: cell.y });
    const overlayY = expectedBt709Limited(stickerColour(0))[0];
    const wrong = luma.flatMap((v, f) => {
      const want = red(f) === "overlay" ? overlayY : BG_Y;
      return Math.abs(v - want) <= 3 ? [] : [`frame ${f}: ${v.toFixed(1)}, wanted ${want.toFixed(1)}`];
    });
    expect(wrong).toEqual([]);
    expect(luma).toHaveLength(TOTAL);
  });
});

describe("layers on real ffmpeg: a tail layer runs to the last frame", () => {
  test("shows only on [60, 90), including the last frame", async () => {
    const luma = await lumaPerFrame(finalMp4, TAIL);
    const wrong = luma.flatMap((v, f) => (Math.abs(v - (f >= 60 ? 235 : BG_Y)) <= 3 ? [] : [`frame ${f}: ${v.toFixed(1)}`]));
    expect(wrong).toEqual([]);
  });
});

describe("layers on real ffmpeg: a sticker follows (t - start) mod loop on the 30 fps grid", () => {
  const classes = [...Array.from({ length: LOOP }, (_, i) => counterLuma(i)), BG_Y];
  const BACKGROUND = LOOP;

  test("the windowed counter [33, 81) shows source frame (f - 33) mod 7 on every frame of its window and the background elsewhere", async () => {
    const luma = await lumaPerFrame(finalMp4, WINDOWED);
    const shown = luma.map((v) => nearest(v, classes));
    const want = luma.map((_, f) => (f >= WINDOWED_WINDOW[0] && f < WINDOWED_WINDOW[1] ? (f - WINDOWED_WINDOW[0]) % LOOP : BACKGROUND));
    expect(shown).toEqual(want);
  });

  test("the loop restarts inside the window: the 7-frame loop has run 6 times and 6 frames of a 7th when the window ends", async () => {
    const luma = await lumaPerFrame(finalMp4, WINDOWED);
    const idx = (f: number): number => nearest(luma[f] ?? 0, classes);
    expect(idx(33)).toBe(0);
    expect(idx(39)).toBe(6);
    expect(idx(40)).toBe(0);
    expect(idx(80)).toBe((80 - 33) % LOOP);
  });

  test("a counter spanning the whole timeline shows f mod 7 from frame 0 to the last frame", async () => {
    const luma = await lumaPerFrame(finalMp4, SPANNING);
    const shown = luma.map((v) => nearest(v, classes));
    expect(shown).toEqual(luma.map((_, f) => f % LOOP));
  });

  test("the STORED period wins over the file's own length: a 7-frame file stored with a period of 5 loops 0 1 2 3 4 and never shows frames 5 and 6", async () => {
    const luma = await lumaPerFrame(finalMp4, SHORT_LOOP);
    const shown = luma.map((v) => nearest(v, classes));
    expect(shown).toEqual(luma.map((_, f) => f % SHORT_PERIOD));
  });

  test("two layers of the same file keep their own phase", async () => {
    const a = (await lumaPerFrame(finalMp4, WINDOWED)).map((v) => nearest(v, classes));
    const b = (await lumaPerFrame(finalMp4, SPANNING)).map((v) => nearest(v, classes));
    expect(a[45]).toBe((45 - 33) % LOOP);
    expect(b[45]).toBe(45 % LOOP);
    expect(a[45]).not.toBe(b[45]);
  });
});

describe("layers on real ffmpeg: the colour stays BT.709 through both steps (invariant 36)", () => {
  const FRAME = 45; // inside the text layer's window
  const planes = new Map<string, { y: Uint8Array; u: Uint8Array; v: Uint8Array }>();
  const agreement: number[] = [];

  async function planesOf(path: string): Promise<{ y: Uint8Array; u: Uint8Array; v: Uint8Array }> {
    const hit = planes.get(path);
    if (hit !== undefined) return hit;
    const [frame] = await extractFrames(path, [FRAME], "yuv420p", { w: 1080, h: 1920 });
    const p = splitYuv420(frame ?? new Uint8Array(), 1080, 1920);
    planes.set(path, p);
    return p;
  }

  /** The decoded (Y, Cb, Cr) at the centre of PNG cell (column, row), as means over 40 x 40 luma pixels. */
  async function sample(path: string, column: number, row: number): Promise<[number, number, number]> {
    const { y, u, v } = await planesOf(path);
    const cx = TEXT_BOX.x + column * 100 + 50;
    const cy = TEXT_BOX.y + row * 100 + 50;
    return [meanAround(y, 1080, cx, cy, 20), meanAround(u, 540, cx / 2, cy / 2, 10), meanAround(v, 540, cx / 2, cy / 2, 10)];
  }

  const worst = (got: readonly number[], want: readonly number[]): number => Math.max(...got.map((g, i) => Math.abs(g - (want[i] ?? 0))));

  const opaqueWorst: number[] = [];
  const alphaWorst: number[] = [];

  test.each([0, 1, 2, 3])("an opaque colour (column %d) is within 1 code value of BT.709 limited range", async (column) => {
    const w = worst(await sample(finalMp4, column, 0), expectedBt709Limited(stickerColour(column)));
    opaqueWorst.push(w);
    expect(w).toBeLessThanOrEqual(1);
  });

  test.each([0, 1, 2, 3])("an alpha-128 colour (column %d) blends with the background within 2 code values", async (column) => {
    const blended = mixRgb(stickerColour(column), GREY_RGB, 128 / 255);
    const w = worst(await sample(finalMp4, column, 1), expectedBt709Limited(blended));
    alphaWorst.push(w);
    expect(w).toBeLessThanOrEqual(2);
  });

  test("the two-step composite matches pass 2's direct overlay of the same PNG within 1.5 code values on the opaque and the alpha-128 rows", async () => {
    for (const column of [0, 1, 2, 3]) {
      for (const row of [0, 1]) {
        const layered = await sample(finalMp4, column, row);
        const direct = await sample(directMp4, column, row);
        agreement.push(worst(layered, direct));
        expect(worst(layered, direct)).toBeLessThanOrEqual(1.5);
      }
    }
  });

  test("an alpha ramp through the layer file is monotone: more alpha, more of the overlay's colour over the grey", async () => {
    const { y } = await planesOf(finalMp4);
    // Row 2 of the PNG: colour (x / 100) with alpha ramping 0 to 255 across 400 px. Read the cell of column 0 at three x positions.
    const at = (x: number): number => meanAround(y, 1080, TEXT_BOX.x + x, TEXT_BOX.y + 250, 6);
    const [a, b, c] = [at(20), at(60), at(90)];
    // colour 0 is (220, 40, 40), darker than the grey background: luma falls as alpha rises
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  test("NEGATIVE CONTROL: a layer graph with the explicit BT.709 conversion cut out is caught by the same check (the BT.601 trap)", async () => {
    const trapMp4 = join(dir, "trap.mp4");
    await renderThrough([textOverlay], trapMp4, (job) => tamperGraph(job.argv, "scale=in_range=full:out_range=tv:out_color_matrix=bt709,", ""));
    const deviations = await Promise.all([0, 1, 2, 3].map(async (column) => worst(await sample(trapMp4, column, 0), expectedBt709Limited(stickerColour(column)))));
    console.log(`layers, colour through the layer pass (the two-step composite differs from pass 2's direct overlay by at most ${Math.max(...agreement).toFixed(2)}): opaque worst ${Math.max(...opaqueWorst).toFixed(2)} codes, alpha-128 worst ${Math.max(...alphaWorst).toFixed(2)}; without the explicit conversion (the BT.601 trap) ${Math.max(...deviations).toFixed(2)}`);
    // macOS 6.0 and Windows 6.1.1 (the builds Studio ships) convert an untagged RGBA layer with BT.601 and drift 14.6 codes. The Linux
    // ffmpeg of the CI canary does not drift that far (2 codes in this graph, 0.4 in the colour suite's), so there is no trap to catch there.
    if (process.platform === "linux") {
      console.log("layers: this Linux ffmpeg's auto scaler does not drift as the shipped builds' do; the layer trap control does not apply");
      return;
    }
    expect(Math.max(...deviations)).toBeGreaterThan(5);
  });
});

describe("layers on real ffmpeg: a COLOURED animation keeps BT.709 through both steps", () => {
  // The golden string alone would let the colour chain slip out of the ANIMATED branch unnoticed: the pixels of a four-colour APNG are what pin it.
  const COLOURS: readonly (readonly [number, number, number])[] = [[220, 40, 40], [40, 180, 60], [40, 80, 220], [250, 180, 30]];
  const BOX = { x: 100, y: 1400, w: 128, h: 128 };
  let animMp4: string;
  let trapMp4: string;

  const layer = (path: string): OverlayInput => ({ path, format: "apng", box: BOX, resize: true, startFrame: 0, endFrame: TOTAL, loopFrames: COLOURS.length, sourceSize: { w: 64, h: 64 } });

  async function deviations(path: string): Promise<number[]> {
    const frames = await extractFrames(path, [0, 1, 2, 3], "yuv420p", { w: 1080, h: 1920 });
    return frames.map((f, i) => {
      const { y, u, v } = splitYuv420(f, 1080, 1920);
      const cx = BOX.x + BOX.w / 2;
      const cy = BOX.y + BOX.h / 2;
      const want = expectedBt709Limited(COLOURS[i] ?? [0, 0, 0]);
      return Math.max(Math.abs(meanAround(y, 1080, cx, cy, 20) - want[0]), Math.abs(meanAround(u, 540, cx / 2, cy / 2, 10) - want[1]), Math.abs(meanAround(v, 540, cx / 2, cy / 2, 10) - want[2]));
    });
  }

  beforeAll(async () => {
    const frames = COLOURS.map(([r, g, b]) => {
      const px = new Uint8Array(64 * 64 * 4);
      for (let p = 0; p < 64 * 64; p++) px.set([r, g, b, 255], p * 4);
      return px;
    });
    writeBytes(join(dir, "colour.apng"), encodeApng({ width: 64, height: 64, frames }));
    animMp4 = join(dir, "anim.mp4");
    await runLayersAndPass2({ clips, clipDir: dir, output: animMp4, layers: [layer(join(dir, "colour.apng"))] });
    trapMp4 = join(dir, "anim-trap.mp4");
    await runLayersAndPass2({ clips, clipDir: dir, output: trapMp4, layers: [layer(join(dir, "colour.apng"))], tamper: (argv) => tamperGraph(argv, "scale=in_range=full:out_range=tv:out_color_matrix=bt709,", "") });
  }, 120_000);

  test("each of the four colours of the loop is within 1.5 code values of BT.709 limited range", async () => {
    expect(Math.max(...(await deviations(animMp4)))).toBeLessThanOrEqual(1.5);
  });

  test("NEGATIVE CONTROL: with the explicit conversion cut out of the animated branch the same check fails (the BT.601 trap)", async () => {
    if (process.platform === "linux") return; // that ffmpeg's auto scaler does not drift as the shipped builds' do (see the control above)
    expect(Math.max(...(await deviations(trapMp4)))).toBeGreaterThan(5);
  });
});

describe("layers on real ffmpeg: -xerror stops a layer call on a corrupt sticker", () => {
  // ffmpeg exits 0 on a broken frame and silently shortens the loop: without `-xerror` a corrupt copy would render with a different loop.
  let argv: readonly string[];

  beforeAll(async () => {
    const good = new Uint8Array(await Bun.file(join(import.meta.dir, "../../assets/stickers/heart-pulse.apng")).arrayBuffer());
    const bad = good.slice();
    // The zlib data of three later frames (their fdAT chunks, found by walking the chunk list, so the damage is in the compressed bytes on every
    // build and never in a header): 40 bytes each, the CRC no longer matches and the deflate stream is broken.
    const view = new DataView(bad.buffer);
    let seen = 0;
    for (let pos = 8; pos + 12 <= bad.length; ) {
      const length = view.getUint32(pos);
      const type = String.fromCharCode(...bad.subarray(pos + 4, pos + 8));
      if (type === "fdAT" && ++seen % 3 === 0) for (let i = 8; i < Math.min(48, length); i++) bad[pos + 8 + i] = (bad[pos + 8 + i] ?? 0) ^ 0xa5;
      pos += 12 + length;
    }
    expect(seen).toBeGreaterThanOrEqual(3);
    const corrupt = join(dir, "corrupt.apng");
    writeBytes(corrupt, bad);
    const layer: OverlayInput = { path: corrupt, format: "apng", box: { x: 100, y: 200, w: 320, h: 320 }, resize: true, startFrame: 0, endFrame: TOTAL, loopFrames: 24, sourceSize: { w: 320, h: 320 } };
    const [job] = buildLayerPass({ layers: [layer], totalFrames: TOTAL, clipDir: dir }).jobs;
    if (job === undefined) throw new Error("expected one layer call");
    argv = job.argv;
  });

  test("the layer call fails", async () => {
    // Windows 6.1.1's decoder accepts the same damage with exit 0, even under -xerror (measured in CI). The flag is defence in depth: the sticker is
    // checked against the catalogue's sha256 before it is staged, so a damaged copy only arises if something changes the job's own folder.
    if (process.platform === "win32") {
      console.log("layers: this Windows ffmpeg decodes a damaged APNG without an error, so -xerror does not stop it there; the sha256 check before staging is the guard");
      return;
    }
    const r = await runBinary(ffmpegPath(), argv);
    expect(r.code).not.toBe(0);
  });

  test("the same call without -xerror exits 0: the flag is what catches it, so dropping it would be seen", async () => {
    const r = await runBinary(ffmpegPath(), argv.filter((a) => a !== "-xerror"));
    expect(r.code).toBe(0);
  });
});
