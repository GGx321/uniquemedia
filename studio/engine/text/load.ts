import type { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { RasterError } from "./rasterTypes";
import { assertCaptionSelfTest } from "./caption/selfTest";
import { assertTextSelfTest, selfTestSvg } from "./selfTest";
import { createTextGate, type TextGate, type TextGateOptions } from "./worker/textGate";

/**
 * The line the engine logs once the text worker has loaded and its self-test passed. The packaged smoke
 * (scripts/smoke-engine.ts) greps for it, so the fingerprint it carries is read from the real utilityProcess,
 * under the fuses, from a worker thread that read the wasm and the fonts out of app.asar.
 */
export const TEXT_RASTERISER_READY_PREFIX = "studio engine: text rasteriser ready, fingerprint ";

/** Part of the line the engine logs when the load failed; the smoke treats it as a failure wherever it appears. */
export const TEXT_RASTERISER_LOAD_FAILURE = "the text rasteriser could not be loaded";

export interface TextRuntimeLog {
  info(message: string): void;
  error(message: string): void;
}

/** What starting the worker and calling it cost, measured where it ran (the round trip is the gate's, `workerMs` the worker's own). */
export interface TextTimings {
  /** Spawning the worker until it reported ready: wasm read, hash, compile, init and the five fonts. */
  startMs: number;
  /** Mean of a few real renders as the engine sees them, message passing included. */
  roundTripMs: number;
  /** Mean of the time the worker itself spent on those renders; the difference is the per-call overhead. */
  workerMs: number;
}

/**
 * The gate is always returned, also after a failed load: it spawns a fresh worker on the next call, so a later
 * call is a retry, and the engine holds one object for the process's life (3b.4b hands it to the Engine).
 */
export type TextRuntimeLoad = { gate: TextGate; fingerprint: string; timings: TextTimings } | { gate: TextGate; error: string };

export interface TextRuntimeConfig {
  /**
   * The gate to load through, when the caller made it (the engine entry does, synchronously, so the Engine holds its gate
   * even while the load is still running). Without one the loader builds its own from `spawnWorker` and `gateOptions`.
   */
  gate?: TextGate;
  /** Starts one worker thread; the engine entry supplies the real one (worker/spawn.ts). Required unless `gate` is given. */
  spawnWorker?: () => Worker;
  gateOptions?: Omit<TextGateOptions, "spawnWorker">;
  /** Bounds the whole load, self-test included. Default 10 s: it takes well under a second. */
  timeoutMs?: number;
  log?: TextRuntimeLog;
  /** Injectable for tests; the default is the fingerprint check of selfTest.ts and then the caption check of caption/selfTest.ts (one caption with an emoji), both run through the worker. */
  selfTest?: (gate: TextGate) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TIMING_RENDERS = 5;

const consoleLog: TextRuntimeLog = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

function whyOf(error: unknown): string {
  if (error instanceof RasterError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function measure(gate: TextGate, signal: AbortSignal): Promise<Omit<TextTimings, "startMs">> {
  const request = { svg: selfTestSvg("manrope"), font: "manrope" } as const;
  let roundTrip = 0;
  let inside = 0;
  for (let i = 0; i < TIMING_RENDERS; i++) {
    const started = performance.now();
    const image = await gate.render(request, signal);
    roundTrip += performance.now() - started;
    inside += image.workerMs;
  }
  return { roundTripMs: roundTrip / TIMING_RENDERS, workerMs: inside / TIMING_RENDERS };
}

/** The text known-answer test, then the caption one: the fingerprint it returns is the text one, the packaged smoke's. */
async function defaultSelfTest(gate: TextGate): Promise<string> {
  const fingerprint = await assertTextSelfTest(gate);
  await assertCaptionSelfTest(gate);
  return fingerprint;
}

/**
 * Starts the text worker (resvg-wasm and the fonts, both sha256-verified inside it), proves it with the
 * known-answer self-test through the worker, and measures what a call costs. Never throws, like the face gate's
 * loader (engine/main.ts): a build that skipped `prepareTextAssets`, a broken package or a hung load logs one
 * clear line and returns an error, so the engine still starts and only text rendering, which nothing calls
 * before 3b.4b, is unavailable. A hung load is bounded: the signal terminates the worker.
 */
export async function loadTextRasteriser(config: TextRuntimeConfig): Promise<TextRuntimeLoad> {
  const log = config.log ?? consoleLog;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selfTest = config.selfTest ?? defaultSelfTest;
  const gate = config.gate ?? (config.spawnWorker === undefined ? undefined : createTextGate({ ...config.gateOptions, spawnWorker: config.spawnWorker }));
  if (gate === undefined) throw new TypeError("loadTextRasteriser needs a gate or a spawnWorker");
  const timeout = timeoutSignal(timeoutMs);
  try {
    const started = performance.now();
    await untilAborted(gate.start(timeout.signal), timeout.signal);
    const startMs = performance.now() - started;
    const fingerprint = await untilAborted(selfTest(gate), timeout.signal);
    const timings = { startMs, ...(await untilAborted(measure(gate, timeout.signal), timeout.signal)) };
    log.info(`${TEXT_RASTERISER_READY_PREFIX}${fingerprint}`);
    log.info(
      `studio engine: text worker timing: started in ${startMs.toFixed(1)} ms, render round trip ${timings.roundTripMs.toFixed(2)} ms (worker ${timings.workerMs.toFixed(2)} ms)`,
    );
    return { gate, fingerprint, timings };
  } catch (error) {
    const why = timeout.signal.aborted ? `it took longer than ${timeoutMs} ms` : whyOf(error);
    log.error(`studio engine: ${TEXT_RASTERISER_LOAD_FAILURE} (${why}); text rendering is unavailable until this is fixed`);
    return { gate, error: why };
  } finally {
    timeout.clear();
  }
}
