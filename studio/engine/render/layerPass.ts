import { MAX_LAYERS } from "../../shared/engine/montage";
import { FPS, FRAME_H, FRAME_W } from "../../shared/montage";
import { assertAbsolutePath, assertSafeFilterGraph } from "./filterString";
import { layerFileName } from "./names";
import { ANIMATED_LOOP_MAX_FRAMES, overlayEofAction, overlayInputArgs, spansTimeline, validateOverlay } from "./pass2";
import { FILTER_THREAD_ARGS, LAYER_VIDEO_ARGS, METADATA_ARGS, OVERLAY_COLOUR_CHAIN } from "./profile";
import { RenderGraphError, type LayerPassInput, type LayerPassJob, type LayerPassPlan, type OverlayInput } from "./types";

// The layer pass (plan 3b.6): every text PNG and sticker is composited, in z-order, onto ONE transparent
// 1080x1920 yuva420p FFV1 file before pass 2, and pass 2 then overlays exactly one stream.
//
// Why a pass of its own. Pass 2's peak memory is a CONSTANT PER OVERLAY INPUT, not the loop cache: every overlay
// is one more filter holding full frames. Measured on this machine, pass 2 over a 15 s timeline: no layer 604 MiB,
// ten default stickers 822 MiB and ten at 648 px 1105 MiB, against the 768 MiB budget the render pool is sized by
// (`peakRSS`). Here the same layers cost memory in a call of their own, and pass 2 stays at its no-layer figure
// whatever the layer count.
//
// The calls are chained when the layers do not fit one: call 0 composites its layers onto a transparent base,
// call n composites its layers onto `layers-(n-1).mkv`. A call holds a run of CONSECUTIVE layers, so the z-order
// survives. `planLayerBatches` splits by a cost model whose constants were measured (see below), and refuses a
// layer that fits no call rather than rendering it and hoping.
//
// Colour (invariant 36). Each layer goes through `OVERLAY_COLOUR_CHAIN` explicitly (never the auto scaler's BT.601),
// is composited with `overlay=format=yuv420` onto a transparent yuva420p main (so the colour that is stored is the
// layer's own straight colour, which pass 2 then blends), and the file is lossless, so the layers go through one
// lossy step only: pass 2's final encode.
//
// Time. A windowed layer is cut to its own frames and overlaid with `eof_action=pass`, one that spans the timeline
// is not cut and ends the output with the base (`endall`), exactly as in pass 2 (3a.5); `enable` is never used.
// A sticker loops at the period STORED with it (`OverlayInput.loopFrames`), through a cache of exactly that many
// frames: never at the file's own timing, and the cache is filled with the converted, small, source-size frames
// (the loop comes BEFORE the scale to the box).

const MIB = 1024 * 1024;

// The cost model. Measured on macOS arm64 with ffmpeg-static 6.0 (`studio/scripts/layers/measureLayerRss.ts`), 450 frames:
// a call with one still 344 MiB and with ten 457 MiB (12.5 MiB per still), with one animation 364 MiB and with ten
// 645 MiB at 219 px / 675 MiB at 648 px (about 31 to 34 MiB per animation); the loop cache is frames x w x h x 2.5 bytes
// on top (yuva420p). Reading the earlier call's file as the main input costs one more decoded stream.
/** What an ffmpeg call with the lossless encoder and a transparent base costs before any layer. */
export const LAYER_CALL_BASE_BYTES = 340 * MIB;
/** What reading the earlier call's file as the main input adds. */
export const LAYER_CHAINED_INPUT_BYTES = 40 * MIB;
export const LAYER_STILL_BYTES = 14 * MIB;
export const LAYER_ANIMATED_BYTES = 34 * MIB;
/**
 * What the model lets one call reach. Under the 768 MiB `peakRSS` the render pool is sized by, with the headroom the plan
 * keeps for other content and the Windows build (about 17%).
 */
export const LAYER_CALL_BUDGET_BYTES = 640 * MIB;

function bad(message: string): never {
  throw new RenderGraphError("BAD_OVERLAY", message);
}

const isAnimation = (o: OverlayInput): boolean => o.format === "apng" || o.format === "gif";

/** What an animation needs to be priced and looped: its stored period and its own size. Throws `BAD_OVERLAY` for a layer without them. */
function animationFacts(o: OverlayInput, at: string): { loopFrames: number; w: number; h: number } {
  const loopFrames = o.loopFrames;
  if (loopFrames === undefined || !Number.isSafeInteger(loopFrames) || loopFrames < 1 || loopFrames > ANIMATED_LOOP_MAX_FRAMES) {
    bad(`${at} is an animation and needs its stored loop period, a whole number of 30 fps frames from 1 to ${ANIMATED_LOOP_MAX_FRAMES}`);
  }
  const size = o.sourceSize;
  if (size === undefined || !Number.isSafeInteger(size.w) || !Number.isSafeInteger(size.h) || size.w < 1 || size.h < 1) {
    bad(`${at} is an animation and needs its own pixel size, to price its loop cache`);
  }
  return { loopFrames, w: size.w, h: size.h };
}

/** The modelled peak RSS one layer adds to its call, in bytes. */
export function layerCost(o: OverlayInput): number {
  if (!isAnimation(o)) return LAYER_STILL_BYTES;
  const { loopFrames, w, h } = animationFacts(o, "an animation");
  return LAYER_ANIMATED_BYTES + loopFrames * w * h * 2.5;
}

/**
 * Splits layers (given by their costs, in z-order) into calls: runs of consecutive layers, each within the room its call has.
 * The first call has the budget less the base; a later call also reads the earlier call's file. Returns the indexes of each
 * call. A layer that does not fit an EMPTY call of its position is refused: layers cannot be reordered to make it fit.
 */
export function planLayerBatches(costs: readonly number[]): number[][] {
  const batches: number[][] = [];
  const room = (batchIndex: number): number => LAYER_CALL_BUDGET_BYTES - LAYER_CALL_BASE_BYTES - (batchIndex === 0 ? 0 : LAYER_CHAINED_INPUT_BYTES);
  let current: number[] = [];
  let used = 0;
  costs.forEach((cost, k) => {
    if (current.length > 0 && used + cost > room(batches.length)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    if (cost > room(batches.length)) {
      bad(`layer ${k} would need about ${Math.ceil(cost / MIB)} MiB, more than one render call may use (${Math.floor(room(batches.length) / MIB)} MiB)`);
    }
    current.push(k);
    used += cost;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The chain that turns layer input `inputIndex` into `[s<j>]`: converted to BT.709 limited range with alpha, looped (an
 * animation), resized to its box, cut to its window and shifted to its start frame.
 *
 * A still is resized (if it is) and converted ONCE, and its one frame repeated. An animation is resampled to 30 fps, converted
 * once, looped forever from a cache of `loopFrames` of its own frames at the SOURCE size, and only then scaled to its box.
 */
function layerPrepare(o: OverlayInput, inputIndex: number, j: number, total: number): string {
  const cut = spansTimeline(o, total) ? "" : `trim=end_frame=${o.endFrame - o.startFrame},`;
  const shift = `settb=1/${FPS},setpts=N+${o.startFrame}`;
  const resize = o.resize ? `scale=${o.box.w}:${o.box.h}:flags=lanczos` : "";
  if (isAnimation(o)) {
    const { loopFrames } = animationFacts(o, "an animation");
    // The loop's cache of `loopFrames` frames IS the period: a file with more frames is cut to it by `loop` itself (measured, and
    // pinned by the real-ffmpeg test of a 7-frame file stored with a period of 5), one with fewer repeats what it has.
    return `[${inputIndex}:v]fps=${FPS},${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=${loopFrames},${resize === "" ? "" : `${resize},`}${cut}${shift}[s${j}]`;
  }
  const lead = resize === "" ? "" : `format=rgba,${resize},`;
  return `[${inputIndex}:v]${lead}${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=1,${cut}${shift}[s${j}]`;
}

/** The whole frame over the whole timeline: what pass 2 overlays, and what a later call reads as its main input. */
function layersFile(path: string, total: number): OverlayInput {
  return { path, format: "layers", box: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, resize: false, startFrame: 0, endFrame: total };
}

function buildJob(index: number, batch: readonly OverlayInput[], costs: readonly number[], input: LayerPassInput): LayerPassJob {
  const total = input.totalFrames;
  const fileName = layerFileName(index);
  const output = `${input.clipDir}/${fileName}`;
  const chained = index > 0;
  const filters: string[] = [];
  filters.push(
    chained
      ? `[0:v]settb=1/${FPS},setpts=N[b0]`
      : `color=c=0x00000000:s=${FRAME_W}x${FRAME_H}:r=${FPS},format=yuva420p,trim=end_frame=${total},settb=1/${FPS},setpts=N[b0]`,
  );
  batch.forEach((o, j) => {
    const out = j === batch.length - 1 ? "v" : `b${j + 1}`;
    filters.push(layerPrepare(o, j + (chained ? 1 : 0), j, total));
    filters.push(`[b${j}][s${j}]overlay=x=${o.box.x}:y=${o.box.y}:eof_action=${overlayEofAction(o, total)}:format=yuv420[${out}]`);
  });
  const graph = filters.join(";");
  assertSafeFilterGraph(graph);
  const earlier = chained ? overlayInputArgs(layersFile(`${input.clipDir}/${layerFileName(index - 1)}`, total)) : [];
  const argv = [
    "-hide_banner", "-nostdin", "-y", "-xerror",
    ...FILTER_THREAD_ARGS,
    ...earlier,
    ...batch.flatMap((o) => overlayInputArgs(o)),
    "-filter_complex", graph,
    "-map", "[v]",
    ...LAYER_VIDEO_ARGS,
    ...METADATA_ARGS,
    output,
  ];
  return { index, fileName, output, frames: total, layerCount: batch.length, modelledBytes: LAYER_CALL_BASE_BYTES + (chained ? LAYER_CHAINED_INPUT_BYTES : 0) + costs.reduce((n, c) => n + c, 0), argv };
}

/**
 * Plans the layer pass: no layers, no call and nothing for pass 2 to overlay (its graph is then exactly what it was); else
 * the chained calls and the file pass 2 overlays. Refuses what it cannot render faithfully, and never clamps: a layer past the
 * montage's end, an empty window, a box off the frame, an animation without its stored period, more than `MAX_LAYERS`.
 */
export function buildLayerPass(input: LayerPassInput): LayerPassPlan {
  if (input.layers.length === 0) return { jobs: [], final: null };
  assertAbsolutePath(input.clipDir, "the job folder");
  const total = input.totalFrames;
  if (!Number.isSafeInteger(total) || total < 1) throw new RenderGraphError("BAD_DURATION", `the timeline must have a whole number of frames, at least one, got ${total}`);
  if (input.layers.length > MAX_LAYERS) bad(`a montage has at most ${MAX_LAYERS} layers, got ${input.layers.length}`);
  input.layers.forEach((o, i) => {
    validateOverlay(o, i, total);
    if (o.format === "layers") bad(`overlay ${i} is the layer pass's own output, not a layer`);
    if (isAnimation(o)) animationFacts(o, `overlay ${i}`);
  });

  const costs = input.layers.map(layerCost);
  const batches = planLayerBatches(costs);
  const jobs = batches.map((batch, index) =>
    buildJob(
      index,
      batch.flatMap((k) => input.layers.slice(k, k + 1)),
      batch.map((k) => costs[k] ?? 0),
      input,
    ),
  );
  const last = jobs.at(-1);
  return { jobs, final: last === undefined ? null : layersFile(last.output, total) };
}
