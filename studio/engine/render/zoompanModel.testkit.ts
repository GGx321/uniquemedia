import type { Size } from "../../shared/montage";
import { evaluateExpression } from "./exprEval.testkit";

// An explicit model of ffmpeg's `zoompan` window, from its source and from
// measuring it (6.0; the Windows 6.1.1 build is checked by the same tests in
// CI):
//
//   zoom = clip(z, 1, 10);   w = trunc(iw / zoom);   h = trunc(ih / zoom);
//   x, y = the expressions' whole numbers, then snapped DOWN to even for 4:2:0.
//
// `zoompan.test.ts` pins this model against `motionWindow` (no ffmpeg), and
// `render.parity.ffmpeg.test.ts` pins real frames against this model.

export interface ModelWindow {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function field(filter: string, key: string): string {
  const m = new RegExp(`${key}='([^']*)'`).exec(filter);
  if (!m?.[1]) throw new Error(`no ${key} in ${filter}`);
  return m[1];
}

const snapEven = (n: number): number => n - (n % 2);

/** The window `filter` (a `zoompan=...` string) shows on a canvas at output frame `on`, before the even snap of x and y. */
export function zoompanWindowUnsnapped(filter: string, canvas: Size, on: number): ModelWindow {
  const vars = { on, iw: canvas.w, ih: canvas.h };
  const zoom = Math.min(10, Math.max(1, evaluateExpression(field(filter, "z"), vars)));
  return {
    w: Math.trunc(canvas.w * (1 / zoom)),
    h: Math.trunc(canvas.h * (1 / zoom)),
    x: Math.trunc(evaluateExpression(field(filter, "x"), vars)),
    y: Math.trunc(evaluateExpression(field(filter, "y"), vars)),
  };
}

/** The same window as ffmpeg really shows it: x and y snapped down to even. */
export function zoompanWindow(filter: string, canvas: Size, on: number): ModelWindow {
  const w = zoompanWindowUnsnapped(filter, canvas, on);
  return { ...w, x: snapEven(w.x), y: snapEven(w.y) };
}
