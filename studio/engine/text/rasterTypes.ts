import { createHash } from "node:crypto";
import type { TextFontKey } from "./fonts";

/**
 * What the engine side and the worker side of the text rasteriser share, with no resvg in it: the engine
 * imports this (and the worker gate, worker/textGate.ts), only the worker thread imports `@resvg/resvg-wasm`.
 */

/** The wasm `@resvg/resvg-wasm` 2.6.2 ships, pinned: only this version was tested (SP2). */
export const RASTER_WASM = {
  version: "2.6.2",
  file: "index_bg.wasm",
  sha256: "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70",
  bytes: 2_478_606,
} as const;

/**
 * The wall for one text call, from the moment it is on the worker (textGate.ts terminates the worker past it).
 * The template's worst legitimate case is a «Без фона» shadow caption at the largest size: 225-283 ms on the
 * development machine. The node test `textGate.real.node-test.ts` times that worst case on every runner (macOS and
 * Windows CI) and fails if the wall is under 5x its median or under 3x the slowest of 7 renders, so this number is
 * checked, not guessed.
 * It is far below main's own 30 s command deadline.
 */
export const TEXT_RENDER_DEADLINE_MS = 3_000;

export const RASTER_ERROR_CODES = [
  "WASM_UNAVAILABLE",
  "FONT_UNAVAILABLE",
  "NOT_INITIALISED",
  "SVG_TOO_LARGE",
  "RASTER_TOO_LARGE",
  "OUTPUT_TOO_LARGE",
  "RENDER_TIMEOUT",
  "RENDER_FAILED",
  /** A wasm trap left the resvg instance unusable: the worker holding it must be replaced. */
  "BROKEN",
  /** The worker died, broke the protocol or would not start (engine side only). */
  "WORKER_FAILED",
] as const;
export type RasterErrorCode = (typeof RASTER_ERROR_CODES)[number];

const MESSAGE_PREFIX = "text rasteriser: ";

export class RasterError extends Error {
  readonly code: RasterErrorCode;

  constructor(code: RasterErrorCode, message: string, options?: ErrorOptions) {
    // A message that crossed the worker wire already carries the prefix.
    super(message.startsWith(MESSAGE_PREFIX) ? message : `${MESSAGE_PREFIX}${message}`, options);
    this.name = "RasterError";
    this.code = code;
  }
}

/** Throws WASM_UNAVAILABLE unless `bytes` is exactly the pinned resvg-wasm file. `label` names where it was read from. */
export function checkRasterWasmBytes(bytes: Uint8Array, label: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== RASTER_WASM.bytes || actual !== RASTER_WASM.sha256) {
    throw new RasterError("WASM_UNAVAILABLE", `${label} is not the pinned resvg-wasm ${RASTER_WASM.version} (${bytes.byteLength} bytes, sha256 ${actual})`);
  }
}

export interface RasterLimits {
  /** The SVG source, in UTF-8 bytes. */
  maxSvgBytes: number;
  /** Canvas width x height, each rounded up. */
  maxPixels: number;
  /** The encoded PNG, in bytes. */
  maxOutputBytes: number;
  /** Parse, shape and paint together; a slower call is discarded. */
  timeoutMs: number;
}

/**
 * The caption template's own ceiling (3b.4b), not a frame's, because a filter costs at least 39 ms at 1080x360
 * and a full-frame shadow 1.3 s (round-1 review probes); the bound has to come from what the template can emit.
 * - **Pixels:** a text box is at most the frame wide (1080). Its height: 2 lines x 1.2 line height x (56 px base
 *   x 2, the largest `scale`) = 269 px, plus 2 x 0.3 em of padding = 67 px, about 336 px, plus stroke or shadow
 *   bleed. 600 px is 1.75x that.
 * - **SVG bytes:** a caption is at most 60 graphemes. 60 distinct emoji at the emoji font's 99th-percentile
 *   bitmap (5 104 B, 6.8 KB as base64; the median is 2 573 B) come to about 410 KB. The largest bitmap is 7 777 B
 *   (🎆): 60 of those come to about 622 KB and are refused rather than allowed to grow the bound (3b.4b's
 *   `<defs><image>` + `<use>` dedupe makes a repeated emoji cost once).
 * - **Output:** an 8 MiB PNG is far above what a 1080x600 RGBA box encodes to.
 * - **Time:** ONE limit, `TEXT_RENDER_DEADLINE_MS`, enforced by the worker gate with `terminate()`. The in-worker
 *   tripwire is set to the same number, so it can never be the tighter, misleading limit.
 */
export const DEFAULT_RASTER_LIMITS: Readonly<RasterLimits> = {
  maxSvgBytes: 512 * 1024,
  maxPixels: 1080 * 600,
  maxOutputBytes: 8 * 1024 * 1024,
  timeoutMs: TEXT_RENDER_DEADLINE_MS,
};

export interface RasterRequest {
  /** An SVG the engine built from its fixed template (invariant 17). */
  svg: string;
  /** The one text font resvg is given for this render. */
  font: TextFontKey;
}

export interface RasterImage {
  png: Uint8Array;
  width: number;
  height: number;
}

/** resvg's `getBBox()`: the ink box of everything drawn, in the SVG's own units. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
