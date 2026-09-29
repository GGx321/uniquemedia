import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { initWasm as resvgInitWasm, Resvg } from "@resvg/resvg-wasm";
import { FontLoadError, loadTextFonts, TEXT_FONTS, type ReadBytes, type TextFontKey } from "./fonts";

/**
 * The text rasteriser runtime (plan 3b.2; SP2, spike/text-raster/): resvg-wasm
 * initialised once in the engine, drawing an SVG the engine built into a PNG.
 *
 * - **Loaded like the jsquash codecs** (decode/realBackend.ts): the `.wasm` is read
 *   from disk (or from inside app.asar, where Electron's `fs` reads it
 *   transparently and the integrity fuse keeps covering it), sha256-checked,
 *   compiled, and the compiled Module handed to `initWasm`. Never `fetch`.
 * - **Fonts** are passed as `fontBuffers`, one text font per render; resvg has no
 *   system fonts in the wasm build, so nothing else can be drawn with.
 * - **In-process, not a worker.** SP2 measured 1-8 ms per caption box (the layer,
 *   never a whole frame) and 0.3-1.8 ms of layout, so a worker's own cost would
 *   dwarf the work. What keeps the event loop free instead:
 *   1. renders run one at a time and each starts on a fresh event-loop turn;
 *   2. the SVG's size in bytes and its canvas in pixels are capped BEFORE anything
 *      is allocated, and the canvas cap bounds the wasm call's worst case (a full
 *      1080x1920 frame is 32 ms in SP2);
 *   3. a render that still ran past `timeoutMs` is discarded as RENDER_TIMEOUT.
 *      That last bound is a tripwire, not preemption: a synchronous wasm call
 *      cannot be interrupted from its own thread, and (2) is what limits it.
 * - **The output is capped** (`maxOutputBytes`).
 * - **Every failure is a hard `RasterError`**, never a fallback picture: resvg
 *   throws on a control character, on malformed XML and on an empty document.
 *
 * The engine resolves no path itself (runtime.test.ts), so the wasm path and the
 * font directory are parameters. The engine entry passes `out-studio/engine/...`
 * (copied there by scripts/prepareTextAssets.ts, so they sit inside app.asar);
 * tests pass `node_modules` and `studio/assets/fonts`.
 */

/** The wasm `@resvg/resvg-wasm` 2.6.2 ships, pinned: only this version was tested (SP2). */
export const RASTER_WASM = {
  version: "2.6.2",
  file: "index_bg.wasm",
  sha256: "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70",
  bytes: 2_478_606,
} as const;

/** Throws WASM_UNAVAILABLE unless `bytes` is exactly the pinned resvg-wasm file. `label` names where it was read from. */
export function checkRasterWasmBytes(bytes: Uint8Array, label: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== RASTER_WASM.bytes || actual !== RASTER_WASM.sha256) {
    throw new RasterError("WASM_UNAVAILABLE", `${label} is not the pinned resvg-wasm ${RASTER_WASM.version} (${bytes.byteLength} bytes, sha256 ${actual})`);
  }
}

export type RasterErrorCode =
  | "WASM_UNAVAILABLE"
  | "FONT_UNAVAILABLE"
  | "NOT_INITIALISED"
  | "SVG_TOO_LARGE"
  | "RASTER_TOO_LARGE"
  | "OUTPUT_TOO_LARGE"
  | "RENDER_TIMEOUT"
  | "RENDER_FAILED";

export class RasterError extends Error {
  readonly code: RasterErrorCode;

  constructor(code: RasterErrorCode, message: string, options?: ErrorOptions) {
    super(`text rasteriser: ${message}`, options);
    this.name = "RasterError";
    this.code = code;
  }
}

export interface RasterLimits {
  /** The SVG source, in UTF-8 bytes. */
  maxSvgBytes: number;
  /** Canvas width x height. */
  maxPixels: number;
  /** The encoded PNG, in bytes. */
  maxOutputBytes: number;
  /** A render slower than this is discarded. */
  timeoutMs: number;
}

/**
 * A caption box is at most 1080 px wide and a few hundred tall; the ceiling is one
 * full Reels frame. 60 emoji inline as base64 PNGs come to about 0.2 MB of SVG.
 */
export const DEFAULT_RASTER_LIMITS: Readonly<RasterLimits> = {
  maxSvgBytes: 2 * 1024 * 1024,
  maxPixels: 1080 * 1920,
  maxOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 1000,
};

export interface RasterDeps {
  /** The resvg `index_bg.wasm`. */
  wasmPath: string;
  /** The directory holding the five text TTFs (fonts.ts). */
  fontDir: string;
  limits?: Partial<RasterLimits>;
  /** Injectable for tests. */
  readFile?: ReadBytes;
  /** Injectable for tests; the default is resvg's own. */
  initWasm?: (module: WebAssembly.Module) => Promise<void>;
  /** A monotonic clock in ms, injectable for tests. */
  now?: () => number;
}

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

export interface TextRasteriser {
  /** Loads and verifies the wasm and the fonts once. Idempotent; a failure is not remembered, so the next call retries. */
  init(): Promise<void>;
  /** Draws the SVG. Initialises on its own; renders run one at a time. Rejects with a `RasterError`. */
  render(request: RasterRequest): Promise<RasterImage>;
  /**
   * resvg's own `getBBox()` (the measuring 3b.4b's layout uses: the shaper that draws is the
   * one that measures), or null when nothing is drawn. Synchronous, so layout can loop over
   * words; requires `init()` first. Throws a `RasterError`.
   */
  measure(request: RasterRequest): Box | null;
}

type InitWasm = (module: WebAssembly.Module) => Promise<void>;
type ResvgInstance = InstanceType<typeof Resvg>;

/**
 * resvg can be initialised once per process ("Already initialized"), while a test or a
 * respawn may build several rasterisers, so the initialisation is shared per `initWasm`.
 */
const sharedInit = new Map<InitWasm, Promise<void>>();

function initOnce(initWasm: InitWasm, bytes: Uint8Array): Promise<void> {
  const existing = sharedInit.get(initWasm);
  if (existing !== undefined) return existing;
  const started = WebAssembly.compile(bytes).then(initWasm);
  sharedInit.set(initWasm, started);
  started.catch(() => sharedInit.delete(initWasm));
  return started;
}

/** resvg-wasm throws bare strings as well as Errors. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lets timers and I/O run before the next render. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createTextRasteriser(deps: RasterDeps): TextRasteriser {
  const limits: RasterLimits = { ...DEFAULT_RASTER_LIMITS, ...deps.limits };
  const read = deps.readFile ?? readFile;
  const initWasm: InitWasm = deps.initWasm ?? resvgInitWasm;
  const now = deps.now ?? (() => performance.now());

  let fonts: Record<TextFontKey, Uint8Array> | null = null;
  let pending: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Record<TextFontKey, Uint8Array>> {
    let bytes: Uint8Array;
    try {
      bytes = await read(deps.wasmPath);
    } catch (cause) {
      throw new RasterError("WASM_UNAVAILABLE", `cannot read ${deps.wasmPath}: ${messageOf(cause)}`, { cause });
    }
    checkRasterWasmBytes(bytes, deps.wasmPath);
    try {
      await initOnce(initWasm, bytes);
    } catch (cause) {
      throw new RasterError("WASM_UNAVAILABLE", `resvg-wasm would not initialise: ${messageOf(cause)}`, { cause });
    }
    try {
      return await loadTextFonts(deps.fontDir, read);
    } catch (cause) {
      if (cause instanceof FontLoadError) throw new RasterError("FONT_UNAVAILABLE", cause.message, { cause });
      throw cause;
    }
  }

  function init(): Promise<void> {
    if (fonts !== null) return Promise.resolve();
    pending ??= load().then(
      (loaded) => {
        fonts = loaded;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  /** Parses the SVG with the request's font. The caller frees the result. */
  function open(request: RasterRequest): ResvgInstance {
    if (fonts === null) throw new RasterError("NOT_INITIALISED", "init() has not completed");
    if (Buffer.byteLength(request.svg, "utf8") > limits.maxSvgBytes) {
      throw new RasterError("SVG_TOO_LARGE", `the SVG is over ${limits.maxSvgBytes} bytes`);
    }
    try {
      return new Resvg(request.svg, {
        font: { fontBuffers: [fonts[request.font]], defaultFontFamily: TEXT_FONTS[request.font].family },
        shapeRendering: 2,
        textRendering: 1,
      });
    } catch (cause) {
      throw new RasterError("RENDER_FAILED", `resvg refused the SVG: ${messageOf(cause)}`, { cause });
    }
  }

  function renderNow(request: RasterRequest): RasterImage {
    const resvg = open(request);
    try {
      const pixels = resvg.width * resvg.height;
      if (!(pixels <= limits.maxPixels)) {
        throw new RasterError("RASTER_TOO_LARGE", `a ${resvg.width}x${resvg.height} canvas is over ${limits.maxPixels} pixels`);
      }
      const started = now();
      let width: number;
      let height: number;
      let png: Uint8Array;
      try {
        const image = resvg.render();
        try {
          width = image.width;
          height = image.height;
          png = image.asPng();
        } finally {
          image.free();
        }
      } catch (cause) {
        throw new RasterError("RENDER_FAILED", `resvg failed to render: ${messageOf(cause)}`, { cause });
      }
      const elapsed = now() - started;
      if (elapsed > limits.timeoutMs) throw new RasterError("RENDER_TIMEOUT", `the render took ${Math.round(elapsed)} ms, over ${limits.timeoutMs} ms`);
      if (png.byteLength > limits.maxOutputBytes) throw new RasterError("OUTPUT_TOO_LARGE", `the PNG is ${png.byteLength} bytes, over ${limits.maxOutputBytes}`);
      return { png, width, height };
    } finally {
      resvg.free();
    }
  }

  return {
    init,

    async render(request) {
      await init();
      const job = tail.then(nextTurn).then(() => renderNow(request));
      // A failed render must not break the queue behind it.
      tail = job.catch(() => undefined);
      return job;
    },

    measure(request) {
      const resvg = open(request);
      try {
        const box = resvg.getBBox();
        if (box === undefined) return null;
        const measured = { x: box.x, y: box.y, width: box.width, height: box.height };
        box.free();
        return measured;
      } catch (cause) {
        throw new RasterError("RENDER_FAILED", `resvg failed to measure: ${messageOf(cause)}`, { cause });
      } finally {
        resvg.free();
      }
    },
  };
}
