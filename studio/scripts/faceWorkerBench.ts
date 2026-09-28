/**
 * T7c measurement (not a test, not run by CI): the reviewers' scenarios for the
 * face gate, in-thread (how it ran before T7c) versus through the face worker.
 *
 *   bun studio/scripts/faceWorkerBench.ts inthread
 *   bun studio/scripts/faceWorkerBench.ts worker
 *
 * One process per mode, so each one's resident memory is its own. Scenarios:
 *   4x2K   four 2K (1536x2752) checks issued at once — in-thread they queue one
 *          after another behind the old mutex, through the worker behind its lane;
 *   12MP   one 12 MP (3024x4032) master embed;
 * reporting wall time, the largest gap of a 4 ms timer on the engine's event
 * loop (how long it could not run anything else), and resident memory: peak
 * while running and steady 1.5 s later. The worker mode also reports the
 * resident memory after terminating the worker (what recycling would give back).
 * Runs under Bun, so the absolute numbers are Bun's; the comparison is what counts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRealDecodeBackend } from "../engine/decode/realBackend";
import { createWasmImageDecoder } from "../engine/decode/wasmDecode";
import { createFaceGate } from "../engine/face/gate";
import { FIXTURE_IMAGE_DIR, REPO_ROOT, realWorkerSpawner, twelveMegapixelJpeg, twoKJpeg } from "../engine/face/testing/realWorker";
import { createWorkerFaceGate } from "../engine/face/worker/workerGate";
import { MASTER } from "../engine/face/fixtures/expected";
import { faceModelPaths } from "./faceModelCache";

const mode = process.argv[2];
if (mode !== "inthread" && mode !== "worker") throw new Error("usage: faceWorkerBench.ts inthread|worker");

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
const never = new AbortController().signal;

interface Sample {
  label: string;
  wallMs: number;
  maxGapMs: number;
  peakRssMb: number;
  steadyRssMb: number;
}

async function measure(label: string, work: () => Promise<unknown>): Promise<Sample> {
  let last = performance.now();
  const started = last;
  let maxGap = 0;
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 4);
  await work();
  clearInterval(timer);
  const finished = performance.now();
  peak = Math.max(peak, process.memoryUsage.rss());
  await Bun.sleep(1500);
  Bun.gc(true);
  return { label, wallMs: Math.round(finished - started), maxGapMs: Math.round(Math.max(maxGap, finished - last)), peakRssMb: mb(peak), steadyRssMb: mb(process.memoryUsage.rss()) };
}

const masterBytes = new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file)));
const twoK = twoKJpeg();
const twelveMp = twelveMegapixelJpeg();
const samples: Sample[] = [];
const baselineRss = mb(process.memoryUsage.rss());
let afterTerminateMb: number | undefined;

if (mode === "inthread") {
  const decode = createWasmImageDecoder(await createRealDecodeBackend(join(REPO_ROOT, "node_modules")));
  const paths = faceModelPaths(REPO_ROOT);
  const gate = await createFaceGate({ yunet: new Uint8Array(await readFile(paths.yunet)), sface: new Uint8Array(await readFile(paths.sface)) });
  const masterEmbedding = await gate.embed(await decode(masterBytes, never));
  // The old FIFO mutex: one decode + inference at a time.
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
  const check = () => serialized(async () => gate.check({ pose: "front", image: await decode(twoK, never), masterEmbedding }));
  await check(); // warm-up
  samples.push(await measure("4x2K concurrent checks", () => Promise.all([check(), check(), check(), check()])));
  samples.push(await measure("12MP master embed", () => serialized(async () => gate.embed(await decode(twelveMp, never)))));
  await gate.dispose();
} else {
  const gate = createWorkerFaceGate({ spawnWorker: realWorkerSpawner() });
  await gate.start();
  const masterEmbedding = await gate.embed(masterBytes, never);
  const check = () => gate.check({ pose: "front", bytes: twoK, masterEmbedding }, never);
  await check(); // warm-up
  samples.push(await measure("4x2K concurrent checks", () => Promise.all([check(), check(), check(), check()])));
  samples.push(await measure("12MP master embed", () => gate.embed(twelveMp, never)));
  await gate.dispose(); // terminates the worker
  await Bun.sleep(1000);
  Bun.gc(true);
  afterTerminateMb = mb(process.memoryUsage.rss());
}

console.log(JSON.stringify({ mode, baselineRssMb: baselineRss, samples, afterTerminateMb }, null, 2));
process.exit(0);
