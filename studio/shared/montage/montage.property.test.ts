import { describe, expect, test } from "bun:test";
import { MAX_TOTAL_MS, MIN_TOTAL_MS, MontageSpec, type Clip } from "../engine/montage";
import { clipCellRects, FRAME_H, FRAME_W, cellMotionGeometry, cellReveal, clipMotionPlan, clipRanges, estimateBytes, layerRange, motionWindow, msToFrames, progressSegments, stickerBox, totalFrames } from "./index";
import { mulberry32, randInt } from "./random.testkit";
import { randomSpec } from "./specGen.testkit";

// Property-style tests over many random valid specs (seeded, so deterministic):
// the whole geometry pipeline the graph builder and the preview will call,
// checked end to end.

const RUNS = 250;

/** A stable per-cell source size, independent of clip order (a hash of the clip id and the cell). */
function sourceFor(clipId: string, cellIndex: number): { w: number; h: number } {
  let h = 2166136261;
  for (const ch of `${clipId}/${cellIndex}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rand = mulberry32(h);
  return { w: randInt(rand, 200, 6000), h: randInt(rand, 200, 8000) };
}

function cellFocuses(clip: Clip) {
  if (clip.kind === "photo") return [clip.cell.focus];
  if (clip.kind === "collage") return clip.cells.map((c) => c.focus);
  return [clip.focus];
}

/** Everything the pipeline derives for one clip, without its position on the timeline. */
function clipPipeline(seed: number, clip: Clip) {
  const rects = clipCellRects(clip);
  const plan = clipMotionPlan(seed, clip);
  const frames = msToFrames(clip.durationMs);
  const cells = rects.map((rect, k) => ({
    rect,
    geometry: cellMotionGeometry(rect, sourceFor(clip.clipId, k), cellFocuses(clip)[k] ?? null),
    reveal: clip.kind === "collage" ? cellReveal(k, rects.length, clip.durationMs, clip.stagger) : null,
  }));
  return { plan, frames, cells };
}

describe("random specs: the generator", () => {
  test("only produces specs the contract accepts, of 4.0 to 15.0 s", () => {
    const rand = mulberry32(1001);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(rand);
      expect(MontageSpec.safeParse(spec).success).toBe(true);
      const totalMs = spec.clips.reduce((s, c) => s + c.durationMs, 0);
      expect(totalMs).toBeGreaterThanOrEqual(MIN_TOTAL_MS);
      expect(totalMs).toBeLessThanOrEqual(MAX_TOTAL_MS);
    }
  });
});

describe("random specs: timeline", () => {
  test("clip frames sum to the total, and the total is exactly total ms x 3 / 100", () => {
    const rand = mulberry32(1002);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(rand);
      const totalMs = spec.clips.reduce((s, c) => s + c.durationMs, 0);
      const ranges = clipRanges(spec.clips);
      expect(ranges.reduce((s, r) => s + r.frames, 0)).toBe((totalMs * 3) / 100);
      expect(totalFrames(spec.clips)).toBe((totalMs * 3) / 100);
      expect(ranges[ranges.length - 1]?.endFrame).toBe((totalMs * 3) / 100);
    }
  });

  test("every layer's frame range lies inside the montage", () => {
    const rand = mulberry32(1003);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(rand);
      const total = totalFrames(spec.clips);
      for (const layer of spec.layers) {
        const r = layerRange(layer);
        expect(r.startFrame).toBeGreaterThanOrEqual(0);
        expect(r.endFrame).toBeLessThanOrEqual(total);
        expect(r.frames).toBeGreaterThanOrEqual(9);
      }
    }
  });

  test("the size estimate is positive and bounded for every spec", () => {
    const rand = mulberry32(1004);
    for (let i = 0; i < RUNS; i++) {
      const bytes = estimateBytes(randomSpec(rand).clips);
      expect(bytes).toBeGreaterThan(1_000_000);
      expect(bytes).toBeLessThan(7_000_000);
    }
  });
});

describe("random specs: cells, crops and motion", () => {
  test("every cell lies inside the frame, every crop inside its source, every window inside its canvas, on every frame", () => {
    const rand = mulberry32(1005);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(rand);
      for (const clip of spec.clips) {
        const { plan, frames, cells } = clipPipeline(spec.seed, clip);
        cells.forEach(({ rect, geometry }, k) => {
          const source = sourceFor(clip.clipId, k);
          expect(rect.x + rect.w).toBeLessThanOrEqual(FRAME_W);
          expect(rect.y + rect.h).toBeLessThanOrEqual(FRAME_H);
          expect(geometry.crop.x).toBeGreaterThanOrEqual(0);
          expect(geometry.crop.y).toBeGreaterThanOrEqual(0);
          expect(geometry.crop.x + geometry.crop.w).toBeLessThanOrEqual(source.w);
          expect(geometry.crop.y + geometry.crop.h).toBeLessThanOrEqual(source.h);
          for (let f = 0; f < frames; f++) {
            const w = motionWindow(plan, geometry.canvas, geometry.anchor, f, frames);
            expect(w.x).toBeGreaterThanOrEqual(0);
            expect(w.y).toBeGreaterThanOrEqual(0);
            expect(w.x + w.w).toBeLessThanOrEqual(geometry.canvas.w);
            expect(w.y + w.h).toBeLessThanOrEqual(geometry.canvas.h);
          }
        });
      }
    }
  });

  test("a staggered collage's cells appear in order and are all fully in before the clip ends", () => {
    const rand = mulberry32(1006);
    let checked = 0;
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(rand);
      for (const clip of spec.clips) {
        if (clip.kind !== "collage" || !clip.stagger) continue;
        const { frames, cells } = clipPipeline(spec.seed, clip);
        let previous = -1;
        for (const { reveal } of cells) {
          expect(reveal).not.toBeNull();
          if (reveal === null) continue;
          expect(reveal.startFrame).toBeGreaterThan(previous);
          expect(reveal.startFrame + reveal.frames).toBeLessThan(frames);
          previous = reveal.startFrame;
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("the same spec and seed give exactly the same pipeline output", () => {
    const rand = mulberry32(1007);
    for (let i = 0; i < 50; i++) {
      const spec = randomSpec(rand);
      const first = spec.clips.map((c) => clipPipeline(spec.seed, c));
      const second = spec.clips.map((c) => clipPipeline(spec.seed, c));
      expect(second).toEqual(first);
    }
  });

  test("reordering the clips changes no clip's motion, geometry or reveal, only where it sits on the timeline", () => {
    const rand = mulberry32(1008);
    for (let i = 0; i < 100; i++) {
      const spec = randomSpec(rand);
      const before = new Map(spec.clips.map((c) => [c.clipId, clipPipeline(spec.seed, c)]));
      const reversed = [...spec.clips].reverse();
      for (const clip of reversed) {
        const expected = before.get(clip.clipId);
        if (expected === undefined) throw new Error("test setup: missing pipeline");
        expect(clipPipeline(spec.seed, clip)).toEqual(expected);
      }
      // The timeline itself follows the new order but keeps the same total.
      expect(totalFrames(reversed)).toBe(totalFrames(spec.clips));
    }
  });

  test("a different seed changes some clips' direction but never a clip's kind, geometry or timing", () => {
    const rand = mulberry32(1009);
    let directionsChanged = 0;
    for (let i = 0; i < 100; i++) {
      const spec = randomSpec(rand);
      for (const clip of spec.clips) {
        const a = clipPipeline(spec.seed, clip);
        const b = clipPipeline((spec.seed + 1) % 4_294_967_296, clip);
        expect(b.plan.kind).toBe(a.plan.kind);
        expect(b.frames).toBe(a.frames);
        expect(b.cells).toEqual(a.cells);
        if (JSON.stringify(a.plan) !== JSON.stringify(b.plan)) directionsChanged++;
      }
    }
    expect(directionsChanged).toBeGreaterThan(20);
  });
});

describe("random specs: layers and the preview", () => {
  test("every sticker's box lies inside the frame with even offsets, and the preview segments follow the clips", () => {
    const rand = mulberry32(1010);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(rand);
      for (const layer of spec.layers) {
        if (layer.kind !== "sticker") continue;
        const box = stickerBox(layer);
        expect(box.x % 2).toBe(0);
        expect(box.y % 2).toBe(0);
        expect(box.x + box.w).toBeLessThanOrEqual(FRAME_W);
        expect(box.y + box.h).toBeLessThanOrEqual(FRAME_H);
      }
      const segments = progressSegments(spec.clips);
      expect(segments.map((s) => s.clipId)).toEqual(spec.clips.map((c) => c.clipId));
      expect(segments[segments.length - 1]?.endFrame).toBe(totalFrames(spec.clips));
    }
  });
});

describe("boundaries", () => {
  const collage4 = (durationMs: number): Clip => ({
    kind: "collage",
    clipId: "clip-boundary-collage",
    durationMs,
    transitionIn: "cut",
    layout: "collage4",
    cells: Array.from({ length: 4 }, (_, i) => ({ photo: { source: "scene" as const, photoId: `photo-boundary-${i}` }, focus: null })),
    motion: "kenburns",
    stagger: true,
  });

  test("a 4.0 s montage is 120 frames and a 15.0 s one is 450", () => {
    expect(totalFrames([{ durationMs: 4_000 }])).toBe(120);
    expect(totalFrames([{ durationMs: 15_000 }])).toBe(450);
  });

  test("a 500 ms 4-cell staggered collage: 15 frames, cells at 0, 3, 6, 9, all in by frame 12, windows valid on all 15 frames", () => {
    const clip = collage4(500);
    const { plan, frames, cells } = clipPipeline(1, clip);
    expect(frames).toBe(15);
    expect(cells.map((c) => c.reveal?.startFrame)).toEqual([0, 3, 6, 9]);
    expect(cells.every((c) => (c.reveal?.startFrame ?? 0) + (c.reveal?.frames ?? 0) <= 12)).toBe(true);
    for (const { geometry } of cells) {
      for (let f = 0; f < frames; f++) {
        const w = motionWindow(plan, geometry.canvas, geometry.anchor, f, frames);
        expect(w.x + w.w).toBeLessThanOrEqual(geometry.canvas.w);
      }
    }
  });

  test("a 100 ms 4-cell staggered collage, the shortest clip: 3 frames, every cell visible from frame 0, windows valid on all 3 frames for every seed", () => {
    const clip = collage4(100);
    for (let seed = 0; seed < 64; seed++) {
      const { plan, frames, cells } = clipPipeline(seed, clip);
      expect(frames).toBe(3);
      expect(cells.map((c) => c.reveal)).toEqual(Array.from({ length: 4 }, () => ({ startFrame: 0, frames: 0 })));
      for (const { geometry } of cells) {
        for (let f = 0; f < frames; f++) {
          const w = motionWindow(plan, geometry.canvas, geometry.anchor, f, frames);
          expect(w.x).toBeGreaterThanOrEqual(0);
          expect(w.y).toBeGreaterThanOrEqual(0);
          expect(w.w).toBeGreaterThanOrEqual(1);
          expect(w.h).toBeGreaterThanOrEqual(1);
          expect(w.x + w.w).toBeLessThanOrEqual(geometry.canvas.w);
          expect(w.y + w.h).toBeLessThanOrEqual(geometry.canvas.h);
        }
      }
    }
  });

  test("a 3-frame motion still runs from its first zoom to its last: frame 0 at the start, frame 2 at the end, one frame between", () => {
    for (let seed = 0; seed < 64; seed++) {
      const { plan, cells } = clipPipeline(seed, collage4(100));
      const geometry = cells[0]?.geometry;
      if (geometry === undefined || plan.kind !== "kenburns") continue;
      const [first, middle, last] = [0, 1, 2].map((f) => motionWindow(plan, geometry.canvas, geometry.anchor, f, 3).w);
      // In: the window shrinks; out: it grows; the middle frame is between the two ends.
      const [lo, hi] = plan.direction === "in" ? [last ?? 0, first ?? 0] : [first ?? 0, last ?? 0];
      expect(lo).toBeLessThan(hi);
      expect(middle).toBeGreaterThanOrEqual(lo);
      expect(middle).toBeLessThanOrEqual(hi);
    }
  });

  test("twenty 500 ms clips would be 10 s = 300 frames, every clip 15 frames", () => {
    const clips = Array.from({ length: 20 }, (_, i) => ({ clipId: `clip-twenty-${i}`, durationMs: 500 }));
    expect(clipRanges(clips).every((r) => r.frames === 15)).toBe(true);
    expect(totalFrames(clips)).toBe(300);
  });

  test("twenty 100 ms clips are 2 s = 60 frames, every clip 3 frames", () => {
    const clips = Array.from({ length: 20 }, (_, i) => ({ clipId: `clip-twenty-${i}`, durationMs: 100 }));
    expect(clipRanges(clips).every((r) => r.frames === 3)).toBe(true);
    expect(totalFrames(clips)).toBe(60);
  });
});
