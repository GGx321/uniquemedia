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

export class RasterError extends Error {
  readonly code: RasterErrorCode;

  constructor(code: RasterErrorCode, message: string, options?: ErrorOptions) {
    super(`text rasteriser: ${message}`, options);
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
 *   bitmap (5.1 KB, 6.8 KB as base64) come to about 410 KB. A caption made only of the font's largest bitmaps
 *   (up to 79 KB each) is refused rather than allowed to grow the bound.
 * - **Output:** an 8 MiB PNG is far above what a 1080x600 RGBA box encodes to.
 * - **Time:** 2 s is a tripwire inside the worker; the worker gate's own deadline is the wall (terminate).
 */
export const DEFAULT_RASTER_LIMITS: Readonly<RasterLimits> = {
  maxSvgBytes: 512 * 1024,
  maxPixels: 1080 * 600,
  maxOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 2000,
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
