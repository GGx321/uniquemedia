import { describe, expect, test } from "bun:test";
import { cellMotionGeometry, motionWindow, type Anchor, type Size } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import { MOVING_CASES, planWhere } from "./plans.testkit";
import { zoompanFilter, type MovingMotionPlan } from "./zoompan";
import { zoompanWindow, zoompanWindowUnsnapped } from "./zoompanModel.testkit";
useNativeGlobals();

// The zoompan expressions must give the window `motionWindow` gives, so the
// preview and the render agree. This file pins that with NO ffmpeg: it
// evaluates the expressions in JS, on ffmpeg's own model of `zoompan`. (The
// same claim is measured on real pixels in render.ffmpeg.test.ts.)
//
// The model of ffmpeg's zoompan, from its source and from measuring it:
//   zoom = clip(z, 1, 10);  w = trunc(iw / zoom);  h = trunc(ih / zoom);
//   x, y are integers (the expressions here are whole numbers) and are then
//   snapped down to EVEN for 4:2:0 (which the pixel test sees, and this test
//   does not model: the expressions are compared before the snap).

function field(filter: string, key: string): string {
  const m = new RegExp(`${key}='([^']*)'`).exec(filter);
  if (!m?.[1]) throw new Error(`no ${key} in ${filter}`);
  return m[1];
}

const ffmpegWindow = zoompanWindowUnsnapped;

const CANVASES: readonly Size[] = [
  { w: 2880, h: 5120 }, // a photo cell at the cap
  { w: 2136, h: 3796 }, // 534x949 cover-crop, 4x
  { w: 4320, h: 3816 }, // a collage2 cell upscaled, wide
  { w: 2136, h: 3208 }, // a collage3 bottom cell
  { w: 2000, h: 2000 },
  { w: 2, h: 2 },
];
const ANCHORS: readonly Anchor[] = [
  { uPermille: 0, vPermille: 0 },
  { uPermille: 500, vPermille: 380 },
  { uPermille: 1000, vPermille: 1000 },
  { uPermille: 137, vPermille: 863 },
];
const FRAME_COUNTS = [1, 2, 15, 30, 91, 120, 450];

const CLIP_ID = "clip-under-test";
const PLANS = MOVING_CASES.map((c) => ({ name: c.name, plan: planWhere(CLIP_ID, c.motion, c.pick).plan }));
const planOf = (name: string): MovingMotionPlan => {
  const found = PLANS.find((p) => p.name === name);
  if (!found) throw new Error(name);
  return found.plan;
};

describe("zoompanFilter structure", () => {
  const plan = planOf("kenburns in");
  const filter = zoompanFilter(plan, { w: 2880, h: 5120 }, { uPermille: 300, vPermille: 600 }, 120, { w: 1080, h: 1920 });

  test("is a single zoompan filter with the clip's length, the cell size and 30 fps", () => {
    expect(filter.startsWith("zoompan=")).toBe(true);
    expect(filter).toContain(":d=120:");
    expect(filter).toContain(":s=1080x1920:");
    expect(filter.endsWith(":fps=30")).toBe(true);
  });

  test("builds the zoom expression from the plan's per-mille numbers and the clip's last frame", () => {
    // 1000 -> 1100 over 119 steps: (1000*119 + 100*on) / (1000*119)
    expect(field(filter, "z")).toBe("(119000+100*on)/119000");
  });

  test("writes a falling zoom as a subtraction", () => {
    const out = planOf("kenburns out");
    const f = zoompanFilter(out, { w: 2880, h: 5120 }, { uPermille: 300, vPermille: 600 }, 120, { w: 1080, h: 1920 });
    expect(field(f, "z")).toBe("(130900-100*on)/119000");
  });

  test("keeps a pan's zoom constant", () => {
    const pan = planOf("pan left");
    const f = zoompanFilter(pan, { w: 2880, h: 5120 }, { uPermille: 300, vPermille: 600 }, 120, { w: 1080, h: 1920 });
    expect(field(f, "z")).toBe("136850/119000");
  });

  test("passes the strict graph charset", () => {
    expect(() => assertSafeFilterGraph(filter)).not.toThrow();
  });

  test("a one-frame clip divides by a last frame of 1, never by zero", () => {
    const f = zoompanFilter(plan, { w: 2880, h: 5120 }, { uPermille: 0, vPermille: 0 }, 1, { w: 1080, h: 1920 });
    expect(field(f, "z")).toBe("(1000+100*on)/1000");
    expect(f).toContain(":d=1:");
  });
});

describe("zoompan expressions against motionWindow", () => {
  for (const { name, plan } of PLANS) {
    test(`${name}: the position is exactly motionWindow's on every frame`, () => {
      for (const canvas of CANVASES) {
        for (const anchor of ANCHORS) {
          for (const frames of FRAME_COUNTS) {
            const filter = zoompanFilter(plan, canvas, anchor, frames, { w: 1080, h: 1920 });
            for (let on = 0; on < frames; on += Math.max(1, Math.floor(frames / 23))) {
              const want = motionWindow(plan, canvas, anchor, on, frames);
              const got = ffmpegWindow(filter, canvas, on);
              expect({ canvas, anchor, frames, on, x: got.x, y: got.y }).toEqual({ canvas, anchor, frames, on, x: want.x, y: want.y });
            }
            // the last frame too, whatever the stride was
            const want = motionWindow(plan, canvas, anchor, frames - 1, frames);
            const got = ffmpegWindow(filter, canvas, frames - 1);
            expect({ x: got.x, y: got.y }).toEqual({ x: want.x, y: want.y });
          }
        }
      }
    });

    test(`${name}: the size is within one canvas pixel of motionWindow's on every frame`, () => {
      let worst = 0;
      for (const canvas of CANVASES) {
        for (const frames of FRAME_COUNTS) {
          const filter = zoompanFilter(plan, canvas, ANCHORS[1] ?? { uPermille: 500, vPermille: 500 }, frames, { w: 1080, h: 1920 });
          for (let on = 0; on < frames; on++) {
            const want = motionWindow(plan, canvas, ANCHORS[1] ?? { uPermille: 500, vPermille: 500 }, on, frames);
            const got = ffmpegWindow(filter, canvas, on);
            worst = Math.max(worst, Math.abs(got.w - want.w), Math.abs(got.h - want.h));
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(1);
    });

    test(`${name}: the window ffmpeg really shows, position snapped down to even, is within one canvas pixel of motionWindow`, () => {
      let worst = 0;
      for (const canvas of CANVASES) {
        for (const anchor of ANCHORS) {
          for (const frames of FRAME_COUNTS) {
            const filter = zoompanFilter(plan, canvas, anchor, frames, { w: 1080, h: 1920 });
            for (let on = 0; on < frames; on += Math.max(1, Math.floor(frames / 11))) {
              const want = motionWindow(plan, canvas, anchor, on, frames);
              const got = zoompanWindow(filter, canvas, on);
              worst = Math.max(worst, Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.w - want.w), Math.abs(got.h - want.h));
            }
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(1);
    });

    test(`${name}: the window never leaves the canvas`, () => {
      for (const canvas of CANVASES) {
        for (const anchor of ANCHORS) {
          const frames = 91;
          const filter = zoompanFilter(plan, canvas, anchor, frames, { w: 1080, h: 1920 });
          for (let on = 0; on < frames; on++) {
            const got = ffmpegWindow(filter, canvas, on);
            expect(got.x).toBeGreaterThanOrEqual(0);
            expect(got.y).toBeGreaterThanOrEqual(0);
            expect(got.x + got.w).toBeLessThanOrEqual(canvas.w);
            expect(got.y + got.h).toBeLessThanOrEqual(canvas.h);
          }
        }
      }
    });
  }

  test("a real cell's geometry (a collage2 cell with a focus) matches too", () => {
    const g = cellMotionGeometry({ w: 1080, h: 954 }, { w: 720, h: 1280 }, { x: 0.3, y: 0.6 });
    const plan = planOf("kenburns in");
    const filter = zoompanFilter(plan, g.canvas, g.anchor, 120, { w: 1080, h: 954 });
    for (let on = 0; on < 120; on++) {
      const want = motionWindow(plan, g.canvas, g.anchor, on, 120);
      const got = ffmpegWindow(filter, g.canvas, on);
      expect({ x: got.x, y: got.y }).toEqual({ x: want.x, y: want.y });
    }
  });
});
