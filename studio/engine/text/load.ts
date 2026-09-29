import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import type { ReadBytes } from "./fonts";
import { createTextRasteriser, RasterError, type TextRasteriser } from "./rasteriser";
import { assertTextSelfTest } from "./selfTest";

/**
 * The line the engine logs once the rasteriser has loaded and its self-test passed. The packaged smoke
 * (scripts/smoke-engine.ts) greps for it, so the fingerprint it carries is read from the real
 * utilityProcess, under the fuses, with the wasm and fonts read out of app.asar.
 */
export const TEXT_RASTERISER_READY_PREFIX = "studio engine: text rasteriser ready, fingerprint ";

export interface TextRuntimeLog {
  info(message: string): void;
  error(message: string): void;
}

export type TextRuntimeLoad = { rasteriser: TextRasteriser; fingerprint: string } | { error: string };

export interface TextRuntimeConfig {
  wasmPath: string;
  fontDir: string;
  /** Bounds the whole load. Default 10 s: it takes about 0.1 s. */
  timeoutMs?: number;
  log?: TextRuntimeLog;
  /** Injectable for tests. */
  readFile?: ReadBytes;
  /** Injectable for tests; the default is the fingerprint check of selfTest.ts. */
  selfTest?: (rasteriser: TextRasteriser) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const consoleLog: TextRuntimeLog = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

function whyOf(error: unknown): string {
  if (error instanceof RasterError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads the rasteriser (wasm and fonts, both sha256-verified) and proves it with the known-answer
 * self-test. Never throws, like the face gate's loader (engine/main.ts): a build that skipped
 * `prepareTextAssets`, a broken package or a hung load logs one clear line and returns an error, so
 * the engine still starts and only text rendering, which nothing calls before 3b.4b, is unavailable.
 */
export async function loadTextRasteriser(config: TextRuntimeConfig): Promise<TextRuntimeLoad> {
  const log = config.log ?? consoleLog;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selfTest = config.selfTest ?? assertTextSelfTest;
  const rasteriser = createTextRasteriser({ wasmPath: config.wasmPath, fontDir: config.fontDir, ...(config.readFile === undefined ? {} : { readFile: config.readFile }) });
  const timeout = timeoutSignal(timeoutMs);
  try {
    const fingerprint = await untilAborted(
      rasteriser.init().then(() => selfTest(rasteriser)),
      timeout.signal,
    );
    log.info(`${TEXT_RASTERISER_READY_PREFIX}${fingerprint}`);
    return { rasteriser, fingerprint };
  } catch (error) {
    const why = timeout.signal.aborted ? `it took longer than ${timeoutMs} ms` : whyOf(error);
    log.error(`studio engine: the text rasteriser could not be loaded (${why}); text rendering is unavailable until this is fixed`);
    return { error: why };
  } finally {
    timeout.clear();
  }
}
