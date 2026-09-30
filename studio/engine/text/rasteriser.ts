import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { initWasm as resvgInitWasm, Resvg, type ResvgRenderOptions } from "@resvg/resvg-wasm";
import { FontLoadError, loadTextFonts, TEXT_FONTS, type ReadBytes, type TextFontKey } from "./fonts";
import { verticalMetrics as readVerticalMetrics, type VerticalMetrics } from "./sfnt";
import { checkRasterWasmBytes, DEFAULT_RASTER_LIMITS, RASTER_WASM, RasterError, type Box, type RasterImage, type RasterLimits, type RasterRequest } from "./rasterTypes";

export { checkRasterWasmBytes, DEFAULT_RASTER_LIMITS, RASTER_ERROR_CODES, RASTER_WASM, RasterError, TEXT_RENDER_DEADLINE_MS } from "./rasterTypes";
export type { Box, RasterErrorCode, RasterImage, RasterLimits, RasterRequest } from "./rasterTypes";

/**
 * The resvg-wasm rasteriser itself (plan 3b.2; SP2, spike/text-raster/). It runs INSIDE the text worker thread
 * (worker/textWorker.ts), never on the engine's event loop: the round-1 review measured what the SP2 numbers
 * had hidden. The «Без фона» shadow costs 67-284 ms per caption, any filter at 1080x360 at least 39 ms, a
 * full-frame shadow 1.3-1.4 s and 20 blurred rects 4.5 s, and a synchronous wasm call cannot be interrupted from
 * its own thread. So the engine talks to a worker through a gate that owns the deadline (`terminate()`).
 *
 * - **Loaded like the jsquash codecs** (decode/realBackend.ts): the `.wasm` is read from disk (or from inside
 *   app.asar, where the runtime's `fs` reads it transparently under the integrity fuse), sha256-checked,
 *   compiled, and the compiled Module handed to `initWasm`. Never `fetch`.
 * - **Fonts** are passed as `fontBuffers`, one text font per render; resvg has no system fonts in the wasm
 *   build, so nothing else can be drawn with.
 * - **Bounds checked before the expensive part** (rasterTypes.ts derives the numbers): the SVG's bytes, then,
 *   once resvg has parsed it, the canvas in pixels (each side rounded up) and the PNG's bytes; the elapsed time
 *   of parse, shape and paint together is a tripwire that discards a late result.
 * - **Every failure is a hard `RasterError`**, never a fallback picture: resvg throws on a control character, on
 *   malformed XML and on an empty document.
 * - **A wasm trap breaks the instance.** 600 nested `<g opacity>` ran resvg out of memory, and its `free()` then
 *   threw "recursive use of an object", which used to replace the error and leak the object. After a failed
 *   `render()` or `getBBox()`, or a `free()` that fails, the rasteriser is marked broken: it answers `BROKEN`
 *   from then on, and its worker must be replaced (the gate terminates it).
 *
 * Nothing here resolves a path (runtime.test.ts): the wasm path and the font directory are parameters, handed in
 * by the engine entry through the worker's `workerData`.
 */

/** The parts of a resvg instance this file uses. The real `Resvg` satisfies it; tests reproduce a trap with a fake. */
export interface ResvgLike {
  readonly width: number;
  readonly height: number;
  render(): { readonly width: number; readonly height: number; asPng(): Uint8Array; free(): void };
  getBBox(): { x: number; y: number; width: number; height: number; free(): void } | undefined;
  free(): void;
}

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
  /** Injectable for tests; the default is resvg's own constructor. */
  newResvg?: (svg: string, options: ResvgRenderOptions) => ResvgLike;
}

export interface TextRasteriser {
  /** Loads and verifies the wasm and the fonts once. Idempotent; a failure is not remembered, so the next call retries. */
  init(): Promise<void>;
  /** Draws the SVG. Initialises on its own; renders run one at a time. Rejects with a `RasterError`. */
  render(request: RasterRequest): Promise<RasterImage>;
  /**
   * resvg's own `getBBox()` (the measuring 3b.4b's layout uses: the shaper that draws is the one that measures),
   * or null when nothing is drawn. Synchronous, so layout can loop over words; requires `init()` first.
   * Throws a `RasterError`.
   */
  measure(request: RasterRequest): Box | null;
  /** The font's `hhea` line metrics (where the caption layout puts a baseline), read once at load. Synchronous; requires `init()` first. Throws a `RasterError`. */
  verticalMetrics(font: TextFontKey): VerticalMetrics;
  /** True after a wasm trap or a failed `free()`: every later call answers `BROKEN` and the owner must replace this rasteriser. */
  isBroken(): boolean;
}

type InitWasm = (module: WebAssembly.Module) => Promise<void>;

/**
 * resvg can be initialised once per process ("Already initialized"), while a test or a respawn may build several
 * rasterisers, so the initialisation is shared per `initWasm`.
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

/** A wasm trap, or what resvg-wasm's own wrapper says once one has happened. An ordinary parse error is neither. */
function looksLikeTrap(error: unknown): boolean {
  if (error instanceof WebAssembly.RuntimeError) return true;
  return /unreachable|out of bounds|out of memory|recursive use|aliasing|\babort(?:ed)?\b/i.test(messageOf(error));
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
  const newResvg = deps.newResvg ?? ((svg: string, options: ResvgRenderOptions): ResvgLike => new Resvg(svg, options));

  let fonts: Record<TextFontKey, Uint8Array> | null = null;
  let metrics: Record<TextFontKey, VerticalMetrics> | null = null;
  let pending: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let broken = false;
  /** What broke it (the trap, then the `free()` that failed after it), in order. Rides on every later BROKEN answer. */
  const brokenBy: unknown[] = [];

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

  /** The metrics of every font, read at load: a font that has none fails the load, the way a corrupt one does. */
  function metricsOf(loaded: Record<TextFontKey, Uint8Array>): Record<TextFontKey, VerticalMetrics> {
    const out = {} as Record<TextFontKey, VerticalMetrics>;
    for (const key of Object.keys(loaded) as TextFontKey[]) {
      try {
        out[key] = readVerticalMetrics(loaded[key]);
      } catch (cause) {
        throw new RasterError("FONT_UNAVAILABLE", `${TEXT_FONTS[key].file} has no usable line metrics: ${messageOf(cause)}`, { cause });
      }
    }
    return out;
  }

  function init(): Promise<void> {
    if (broken) return Promise.reject(brokenError());
    if (fonts !== null) return Promise.resolve();
    pending ??= load().then(
      (loaded) => {
        metrics = metricsOf(loaded);
        fonts = loaded;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  function brokenError(): RasterError {
    return new RasterError("BROKEN", `an earlier wasm failure left resvg unusable (${brokenBy.map(messageOf).join("; then ")}); the worker must be replaced`, { cause: brokenBy[0] });
  }

  function markBroken(cause: unknown): void {
    brokenBy.push(cause);
    broken = true;
  }

  /** Frees a resvg object. A `free()` that throws (it does after a trap) marks the instance broken and is otherwise ignored. */
  function release(object: { free(): void }): void {
    try {
      object.free();
    } catch (cause) {
      markBroken(cause);
    }
  }

  /**
   * The one path every render and measure takes: the checks that come before resvg does any work, the parse,
   * the canvas cap, the work itself, and the deadline over all of it. `work` failing means resvg trapped or
   * failed mid-call, so the instance is broken; a parse that throws is an ordinary error unless it looks like a trap.
   */
  function guarded<T>(request: RasterRequest, work: (resvg: ResvgLike) => T): T {
    if (broken) throw brokenError();
    if (fonts === null) throw new RasterError("NOT_INITIALISED", "init() has not completed");
    if (Buffer.byteLength(request.svg, "utf8") > limits.maxSvgBytes) {
      throw new RasterError("SVG_TOO_LARGE", `the SVG is over ${limits.maxSvgBytes} bytes`);
    }
    const started = now();
    let resvg: ResvgLike;
    try {
      resvg = newResvg(request.svg, {
        font: { fontBuffers: [fonts[request.font]], defaultFontFamily: TEXT_FONTS[request.font].family },
        shapeRendering: 2,
        textRendering: 1,
      });
    } catch (cause) {
      if (looksLikeTrap(cause)) markBroken(cause);
      throw new RasterError("RENDER_FAILED", `resvg refused the SVG: ${messageOf(cause)}`, { cause });
    }
    try {
      const pixels = Math.ceil(resvg.width) * Math.ceil(resvg.height);
      if (!(pixels <= limits.maxPixels)) {
        throw new RasterError("RASTER_TOO_LARGE", `a ${resvg.width}x${resvg.height} canvas is over ${limits.maxPixels} pixels`);
      }
      let result: T;
      try {
        result = work(resvg);
      } catch (cause) {
        markBroken(cause);
        throw new RasterError("RENDER_FAILED", `resvg failed: ${messageOf(cause)}`, { cause });
      }
      const elapsed = now() - started;
      if (elapsed > limits.timeoutMs) throw new RasterError("RENDER_TIMEOUT", `the call took ${Math.round(elapsed)} ms, over ${limits.timeoutMs} ms`);
      return result;
    } finally {
      release(resvg);
    }
  }

  function renderNow(request: RasterRequest): RasterImage {
    const image = guarded(request, (resvg) => {
      const painted = resvg.render();
      try {
        return { width: painted.width, height: painted.height, png: painted.asPng() };
      } finally {
        release(painted);
      }
    });
    if (image.png.byteLength > limits.maxOutputBytes) throw new RasterError("OUTPUT_TOO_LARGE", `the PNG is ${image.png.byteLength} bytes, over ${limits.maxOutputBytes}`);
    return image;
  }

  return {
    init,

    isBroken: () => broken,

    verticalMetrics(font) {
      if (broken) throw brokenError();
      if (metrics === null) throw new RasterError("NOT_INITIALISED", "init() has not completed");
      const found = metrics[font];
      if (found === undefined) throw new RasterError("FONT_UNAVAILABLE", `no font ${String(font)}`);
      return found;
    },

    async render(request) {
      await init();
      const job = tail.then(nextTurn).then(() => renderNow(request));
      // A failed render must not break the queue behind it.
      tail = job.catch(() => undefined);
      return job;
    },

    measure(request) {
      return guarded(request, (resvg) => {
        const box = resvg.getBBox();
        if (box === undefined) return null;
        const measured = { x: box.x, y: box.y, width: box.width, height: box.height };
        release(box);
        return measured;
      });
    },
  };
}
