import { describe, expect, test } from "bun:test";
import { collageRects } from "./collage";
import { CANVAS_MAX_H, CANVAS_MAX_W } from "./constants";
import { cellMotionGeometry, clipMotionPlan, focusAnchor, motionCanvas, motionPlan, motionWindow, type Anchor, type MotionPlan, type PanDirection } from "./motion";
import { coverCrop } from "./crop";
import { mulberry32, pick, randId, randInt } from "./random.testkit";
import type { Size } from "./types";

const CANVAS: Size = { w: 2880, h: 5120 };
const CENTRE: Anchor = { uPermille: 500, vPermille: 500 };
const PAN_DIRECTIONS: PanDirection[] = ["left", "right", "up", "down"];

describe("motionPlan", () => {
  test("static has no zoom and no direction", () => {
    expect(motionPlan(1, "clip-static-1", "static")).toEqual({ kind: "static", zoomFromPermille: 1000, zoomToPermille: 1000 });
  });

  test("Ken Burns runs 1.00 to 1.10 (in) or 1.10 to 1.00 (out)", () => {
    const rand = mulberry32(3);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const plan = motionPlan(randInt(rand, 0, 4_294_967_295), randId(rand), "kenburns");
      expect(plan.kind).toBe("kenburns");
      if (plan.kind !== "kenburns") throw new Error("unreachable");
      expect([plan.zoomFromPermille, plan.zoomToPermille]).toEqual(plan.direction === "in" ? [1000, 1100] : [1100, 1000]);
      seen.add(plan.direction);
    }
    expect([...seen].sort()).toEqual(["in", "out"]);
  });

  test("a pan is at a fixed 1.15 zoom in one of four directions", () => {
    const rand = mulberry32(4);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const plan = motionPlan(randInt(rand, 0, 4_294_967_295), randId(rand), "pan");
      expect(plan.kind).toBe("pan");
      if (plan.kind !== "pan") throw new Error("unreachable");
      expect([plan.zoomFromPermille, plan.zoomToPermille]).toEqual([1150, 1150]);
      expect(PAN_DIRECTIONS).toContain(plan.direction);
      seen.add(plan.direction);
    }
    expect([...seen].sort()).toEqual([...PAN_DIRECTIONS].sort());
  });

  test("the same seed and clip id always give the same plan", () => {
    const rand = mulberry32(5);
    for (let i = 0; i < 300; i++) {
      const seed = randInt(rand, 0, 4_294_967_295);
      const id = randId(rand);
      for (const motion of ["kenburns", "pan", "static"] as const) expect(motionPlan(seed, id, motion)).toEqual(motionPlan(seed, id, motion));
    }
  });

  test("the seed changes the direction of some clips (it is a source of variety)", () => {
    const rand = mulberry32(6);
    let differing = 0;
    for (let i = 0; i < 200; i++) {
      const id = randId(rand);
      const a = motionPlan(11, id, "pan");
      const b = motionPlan(12, id, "pan");
      if (JSON.stringify(a) !== JSON.stringify(b)) differing++;
    }
    expect(differing).toBeGreaterThan(50);
  });

  test("the clip id changes the direction under one seed, so clips in a montage do not all move alike", () => {
    const rand = mulberry32(7);
    const directions = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const plan = motionPlan(42, randId(rand), "pan");
      if (plan.kind === "pan") directions.add(plan.direction);
    }
    expect(directions.size).toBe(4);
  });

  test("directions are spread evenly enough: each pan direction gets 15% to 35% of 2000 clips, and each Ken Burns way 40% to 60%", () => {
    const rand = mulberry32(8);
    const pan = new Map<string, number>();
    const kb = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const id = randId(rand);
      const p = motionPlan(99, id, "pan");
      const k = motionPlan(99, id, "kenburns");
      if (p.kind === "pan") pan.set(p.direction, (pan.get(p.direction) ?? 0) + 1);
      if (k.kind === "kenburns") kb.set(k.direction, (kb.get(k.direction) ?? 0) + 1);
    }
    expect(pan.size).toBe(4);
    expect(kb.size).toBe(2);
    for (const count of pan.values()) {
      expect(count / 2000).toBeGreaterThan(0.15);
      expect(count / 2000).toBeLessThan(0.35);
    }
    for (const count of kb.values()) {
      expect(count / 2000).toBeGreaterThan(0.4);
      expect(count / 2000).toBeLessThan(0.6);
    }
  });

  test("accepts the seed boundaries 0 and 4294967295", () => {
    for (const seed of [0, 4_294_967_295]) {
      expect(motionPlan(seed, "clip-boundary", "pan").kind).toBe("pan");
      expect(motionPlan(seed, "clip-boundary", "kenburns").kind).toBe("kenburns");
    }
  });

  test.each([-1, 1.5, 4_294_967_296, Number.NaN])("refuses the seed %p", (seed) => {
    expect(() => motionPlan(seed, "clip-bad-seed", "pan")).toThrow(RangeError);
  });
});

describe("clipMotionPlan", () => {
  test("an own video clip is always static", () => {
    expect(clipMotionPlan(5, { kind: "video", clipId: "clip-video-1" }).kind).toBe("static");
  });

  test("a photo or collage clip follows its motion field", () => {
    expect(clipMotionPlan(5, { kind: "photo", clipId: "clip-photo-1", motion: "kenburns" })).toEqual(motionPlan(5, "clip-photo-1", "kenburns"));
    expect(clipMotionPlan(5, { kind: "collage", clipId: "clip-coll-1", motion: "pan" })).toEqual(motionPlan(5, "clip-coll-1", "pan"));
  });

  test("reordering the clips does not change an unmoved clip's plan, nor any clip's (direction comes from the id, not the index)", () => {
    const seed = 123_456;
    const clips = Array.from({ length: 12 }, (_, i) => ({ kind: "photo" as const, clipId: `clip-order-${i}`, motion: (i % 2 === 0 ? "pan" : "kenburns") as "pan" | "kenburns" }));
    const before = new Map(clips.map((c) => [c.clipId, clipMotionPlan(seed, c)]));
    const rand = mulberry32(21);
    for (let round = 0; round < 50; round++) {
      const shuffled = [...clips];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randInt(rand, 0, i);
        const a = shuffled[i];
        const b = shuffled[j];
        if (a && b) [shuffled[i], shuffled[j]] = [b, a];
      }
      for (const c of shuffled) {
        const expected = before.get(c.clipId);
        if (expected === undefined) throw new Error("test setup: missing plan");
        expect(clipMotionPlan(seed, c)).toEqual(expected);
      }
    }
  });

  test("golden values (recorded from the first implementation): the derivation is pinned, so a re-render of a stored spec moves the same way", () => {
    const golden: [number, string, string][] = [
      [0, "clip-aaaa-0001", "out/right"],
      [1, "clip-aaaa-0001", "out/left"],
      [4_294_967_295, "clip-bbbb-0002", "in/right"],
      [123_456_789, "0123456789abcdef", "out/left"],
    ];
    const actual = golden.map(([seed, id]) => {
      const k = motionPlan(seed, id, "kenburns");
      const p = motionPlan(seed, id, "pan");
      return `${k.kind === "kenburns" ? k.direction : "?"}/${p.kind === "pan" ? p.direction : "?"}`;
    });
    expect(actual).toEqual(golden.map(([, , expected]) => expected));
  });
});

describe("motionCanvas (zp4: 4x the crop, capped at 2880x5120)", () => {
  test("a full-frame 720x1280 photo gets exactly the 2880x5120 cap", () => {
    expect(motionCanvas({ w: 720, h: 1280 })).toEqual({ w: 2880, h: 5120 });
  });

  test("a small crop is scaled exactly 4x", () => {
    expect(motionCanvas({ w: 500, h: 500 })).toEqual({ w: 2000, h: 2000 });
    expect(motionCanvas({ w: 501, h: 333 })).toEqual({ w: 2004, h: 1332 });
  });

  test("a large own photo is scaled down to the cap, never 4x its own size (4000x6000)", () => {
    expect(motionCanvas({ w: 4000, h: 6000 })).toEqual({ w: 2880, h: 4320 });
  });

  test("a tall very large photo is capped by height (2000x9000)", () => {
    expect(motionCanvas({ w: 2000, h: 9000 })).toEqual({ w: 1136, h: 5120 });
  });

  test("a collage cell's crop (716x1280) stays within the cap", () => {
    expect(motionCanvas({ w: 716, h: 1280 })).toEqual({ w: 2864, h: 5120 });
  });

  test("is even-sided, within the cap, and keeps the crop's aspect within a pixel, over random crops", () => {
    const rand = mulberry32(31);
    for (let i = 0; i < 5000; i++) {
      const crop = { w: randInt(rand, 1, 12_000), h: randInt(rand, 1, 12_000) };
      const c = motionCanvas(crop);
      expect(c.w % 2).toBe(0);
      expect(c.h % 2).toBe(0);
      expect(c.w).toBeGreaterThanOrEqual(2);
      expect(c.h).toBeGreaterThanOrEqual(2);
      expect(c.w).toBeLessThanOrEqual(CANVAS_MAX_W);
      expect(c.h).toBeLessThanOrEqual(CANVAS_MAX_H);
      if (crop.w * 4 <= CANVAS_MAX_W && crop.h * 4 <= CANVAS_MAX_H) expect(c).toEqual({ w: crop.w * 4, h: crop.h * 4 });
      else expect(c.w === CANVAS_MAX_W || c.h === CANVAS_MAX_H).toBe(true);
      // Aspect preserved up to the rounding of one canvas pixel on each side.
      if (crop.w >= 40 && crop.h >= 40) expect(Math.abs(c.w * crop.h - c.h * crop.w)).toBeLessThanOrEqual(2 * Math.max(crop.w, crop.h));
    }
  });

  test("refuses an empty or fractional crop", () => {
    expect(() => motionCanvas({ w: 0, h: 10 })).toThrow(RangeError);
    expect(() => motionCanvas({ w: 10.5, h: 10 })).toThrow(RangeError);
  });
});

describe("focusAnchor and cellMotionGeometry", () => {
  test("a full-frame photo with the fallback focus anchors at (500, 380) per mille of the crop", () => {
    const g = cellMotionGeometry({ w: 1080, h: 1920 }, { w: 720, h: 1280 }, null);
    expect(g.crop).toEqual({ x: 0, y: 0, w: 720, h: 1280 });
    expect(g.canvas).toEqual({ w: 2880, h: 5120 });
    expect(g.anchor).toEqual({ uPermille: 500, vPermille: 380 });
  });

  test("a focus at an edge anchors at 0 or 1000", () => {
    const source = { w: 1600, h: 1000 };
    const crop = coverCrop(source, { w: 1080, h: 1920 }, { x: 0, y: 1 });
    expect(focusAnchor(source, crop, { x: 0, y: 1 })).toEqual({ uPermille: 0, vPermille: 1000 });
  });

  test("the anchor is within 0..1000 for random sources, cells and focus points, and the geometry agrees with its parts", () => {
    const rand = mulberry32(41);
    const cells = collageRects("collage3").map((r) => ({ w: r.w, h: r.h }));
    for (let i = 0; i < 3000; i++) {
      const source = { w: randInt(rand, 20, 6000), h: randInt(rand, 20, 8000) };
      const cell = pick(rand, cells);
      const focus = { x: rand(), y: rand() };
      const g = cellMotionGeometry(cell, source, focus);
      expect(g.anchor.uPermille).toBeGreaterThanOrEqual(0);
      expect(g.anchor.uPermille).toBeLessThanOrEqual(1000);
      expect(g.anchor.vPermille).toBeGreaterThanOrEqual(0);
      expect(g.anchor.vPermille).toBeLessThanOrEqual(1000);
      expect(Number.isInteger(g.anchor.uPermille) && Number.isInteger(g.anchor.vPermille)).toBe(true);
      expect(g.crop).toEqual(coverCrop(source, cell, focus));
      expect(g.canvas).toEqual(motionCanvas({ w: g.crop.w, h: g.crop.h }));
    }
  });
});

describe("motionWindow: exact behaviour", () => {
  const kb = (direction: "in" | "out"): MotionPlan => ({ kind: "kenburns", direction, zoomFromPermille: direction === "in" ? 1000 : 1100, zoomToPermille: direction === "in" ? 1100 : 1000 });
  const pan = (direction: PanDirection): MotionPlan => ({ kind: "pan", direction, zoomFromPermille: 1150, zoomToPermille: 1150 });
  const still: MotionPlan = { kind: "static", zoomFromPermille: 1000, zoomToPermille: 1000 };

  test("static shows the whole canvas on every frame", () => {
    for (const f of [0, 60, 119]) expect(motionWindow(still, CANVAS, CENTRE, f, 120)).toEqual({ x: 0, y: 0, w: 2880, h: 5120 });
  });

  test("Ken Burns in starts on the whole canvas and ends at 1/1.10 of it, centred on a centred anchor", () => {
    expect(motionWindow(kb("in"), CANVAS, CENTRE, 0, 120)).toEqual({ x: 0, y: 0, w: 2880, h: 5120 });
    // 2880 / 1.1 = 2618.18 -> 2618; 5120 / 1.1 = 4654.5 -> 4655 (half up); x = round(500 * (2880 - 2618) / 1000) = 131, y = round(500 * 465 / 1000) = 233.
    expect(motionWindow(kb("in"), CANVAS, CENTRE, 119, 120)).toEqual({ x: 131, y: 233, w: 2618, h: 4655 });
  });

  test("Ken Burns out is Ken Burns in played backwards, exactly", () => {
    for (let f = 0; f < 120; f++) expect(motionWindow(kb("out"), CANVAS, CENTRE, f, 120)).toEqual(motionWindow(kb("in"), CANVAS, CENTRE, 119 - f, 120));
  });

  test("Ken Burns zooms toward the focus: a top-left anchor keeps the window on the top-left corner, a bottom-right one on the bottom-right", () => {
    const corner = { uPermille: 0, vPermille: 0 };
    const far = { uPermille: 1000, vPermille: 1000 };
    for (let f = 0; f < 120; f++) {
      const a = motionWindow(kb("in"), CANVAS, corner, f, 120);
      expect([a.x, a.y]).toEqual([0, 0]);
      const b = motionWindow(kb("in"), CANVAS, far, f, 120);
      expect([b.x + b.w, b.y + b.h]).toEqual([2880, 5120]);
    }
  });

  test("a pan keeps a 1.15 zoom window (2504x4452) and moves it across the whole free travel", () => {
    // 2880 / 1.15 = 2504.35 -> 2504; 5120 / 1.15 = 4452.2 -> 4452.
    const first = motionWindow(pan("right"), CANVAS, CENTRE, 0, 90);
    const last = motionWindow(pan("right"), CANVAS, CENTRE, 89, 90);
    expect([first.w, first.h, last.w, last.h]).toEqual([2504, 4452, 2504, 4452]);
    expect(first.x).toBe(0);
    expect(last.x).toBe(2880 - 2504);
  });

  test.each([
    ["right", "x", 0, 376],
    ["left", "x", 376, 0],
    ["down", "y", 0, 668],
    ["up", "y", 668, 0],
  ] as const)("pan %s moves the window along %s from %i to %i", (direction, axis, from, to) => {
    const first = motionWindow(pan(direction), CANVAS, CENTRE, 0, 90);
    const last = motionWindow(pan(direction), CANVAS, CENTRE, 89, 90);
    expect(first[axis]).toBe(from);
    expect(last[axis]).toBe(to);
  });

  test("during a horizontal pan the vertical position stays on the focus anchor, and vice versa", () => {
    const anchor = { uPermille: 250, vPermille: 800 };
    for (let f = 0; f < 90; f++) {
      expect(motionWindow(pan("right"), CANVAS, anchor, f, 90).y).toBe(Math.round((800 * (5120 - 4452)) / 1000));
      expect(motionWindow(pan("down"), CANVAS, anchor, f, 90).x).toBe(Math.round((250 * (2880 - 2504)) / 1000));
    }
  });

  test("a pan moves monotonically and by at most ceil(travel / (frames - 1)) pixels a frame (no jumps)", () => {
    for (const frames of [15, 90, 450]) {
      const travel = 2880 - 2504;
      const maxStep = Math.ceil(travel / (frames - 1));
      let previous = motionWindow(pan("right"), CANVAS, CENTRE, 0, frames).x;
      for (let f = 1; f < frames; f++) {
        const x = motionWindow(pan("right"), CANVAS, CENTRE, f, frames).x;
        expect(x).toBeGreaterThanOrEqual(previous);
        expect(x - previous).toBeLessThanOrEqual(maxStep);
        previous = x;
      }
    }
  });

  test("a one-frame clip has a valid window: Ken Burns in is the whole canvas, out is the 1.10 window, a pan starts at its start", () => {
    expect(motionWindow(kb("in"), CANVAS, CENTRE, 0, 1)).toEqual({ x: 0, y: 0, w: 2880, h: 5120 });
    expect(motionWindow(kb("out"), CANVAS, CENTRE, 0, 1).w).toBe(2618);
    expect(motionWindow(pan("right"), CANVAS, CENTRE, 0, 1).x).toBe(0);
  });

  test.each([
    [-1, 120],
    [120, 120],
    [0.5, 120],
    [0, 0],
    [0, 1.5],
  ])("refuses frame %p of %p frames", (frame, frames) => {
    expect(() => motionWindow(still, CANVAS, CENTRE, frame, frames)).toThrow(RangeError);
  });

  test("refuses an anchor outside 0..1000 and an empty canvas", () => {
    expect(() => motionWindow(still, CANVAS, { uPermille: 1001, vPermille: 0 }, 0, 10)).toThrow(RangeError);
    expect(() => motionWindow(still, { w: 0, h: 10 }, CENTRE, 0, 10)).toThrow(RangeError);
  });
});

describe("motionWindow: properties over random plans, canvases and anchors", () => {
  const kinds = ["static", "kenburns", "pan"] as const;

  test("the window is whole pixels and inside the upscaled canvas on EVERY frame (clip lengths 15 to 450 frames)", () => {
    const rand = mulberry32(51);
    for (let run = 0; run < 400; run++) {
      const crop = { w: randInt(rand, 1, 8000), h: randInt(rand, 1, 12_000) };
      const canvas = motionCanvas(crop);
      const anchor = { uPermille: pick(rand, [0, 1000, randInt(rand, 0, 1000)]), vPermille: pick(rand, [0, 1000, randInt(rand, 0, 1000)]) };
      const frames = pick(rand, [15, 450, randInt(rand, 15, 450)]);
      const plan = motionPlan(randInt(rand, 0, 4_294_967_295), randId(rand), pick(rand, kinds));
      for (let f = 0; f < frames; f++) {
        const w = motionWindow(plan, canvas, anchor, f, frames);
        for (const v of [w.x, w.y, w.w, w.h]) expect(Number.isInteger(v)).toBe(true);
        expect(w.w).toBeGreaterThanOrEqual(1);
        expect(w.h).toBeGreaterThanOrEqual(1);
        expect(w.x).toBeGreaterThanOrEqual(0);
        expect(w.y).toBeGreaterThanOrEqual(0);
        expect(w.x + w.w).toBeLessThanOrEqual(canvas.w);
        expect(w.y + w.h).toBeLessThanOrEqual(canvas.h);
      }
    }
  });

  test("the window keeps the canvas aspect within a pixel on each side", () => {
    const rand = mulberry32(52);
    for (let run = 0; run < 200; run++) {
      const canvas = motionCanvas({ w: randInt(rand, 100, 4000), h: randInt(rand, 100, 6000) });
      const plan = motionPlan(randInt(rand, 0, 4_294_967_295), randId(rand), pick(rand, kinds));
      const frames = randInt(rand, 15, 450);
      for (let f = 0; f < frames; f += 7) {
        const w = motionWindow(plan, canvas, CENTRE, f, frames);
        expect(Math.abs(w.w * canvas.h - w.h * canvas.w)).toBeLessThanOrEqual(canvas.w + canvas.h);
      }
    }
  });

  test("Ken Burns zoom changes monotonically: the window only shrinks for in, only grows for out", () => {
    const rand = mulberry32(53);
    for (let run = 0; run < 100; run++) {
      const canvas = motionCanvas({ w: randInt(rand, 100, 4000), h: randInt(rand, 100, 6000) });
      const frames = randInt(rand, 15, 450);
      for (const direction of ["in", "out"] as const) {
        const plan: MotionPlan = { kind: "kenburns", direction, zoomFromPermille: direction === "in" ? 1000 : 1100, zoomToPermille: direction === "in" ? 1100 : 1000 };
        let previous = motionWindow(plan, canvas, CENTRE, 0, frames).w;
        for (let f = 1; f < frames; f++) {
          const w = motionWindow(plan, canvas, CENTRE, f, frames).w;
          if (direction === "in") expect(w).toBeLessThanOrEqual(previous);
          else expect(w).toBeGreaterThanOrEqual(previous);
          previous = w;
        }
      }
    }
  });

  test("the same inputs always give the same window", () => {
    const plan = motionPlan(9, "clip-determinism", "kenburns");
    expect(motionWindow(plan, CANVAS, { uPermille: 333, vPermille: 444 }, 17, 90)).toEqual(motionWindow(plan, CANVAS, { uPermille: 333, vPermille: 444 }, 17, 90));
  });
});
