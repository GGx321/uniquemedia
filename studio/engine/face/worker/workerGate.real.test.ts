import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath } from "../../../node/ffmpegBinary";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { createRealDecodeBackend } from "../../decode/realBackend";
import { createWasmImageDecoder } from "../../decode/wasmDecode";
import { createFaceGate } from "../gate";
import { NoFaceInReferenceError } from "../noFaceError";
import { FIXTURE_IMAGE_DIR, MODELS_PRESENT, REPO_ROOT, realWorkerInit, realWorkerSpawner, twelveMegapixelJpeg, twoKJpeg } from "../testing/realWorker";
import { faceModelPaths } from "../../../scripts/faceModelCache";
import { MASTER } from "../fixtures/expected";
import { createWorkerFaceGate, type WorkerFaceGate } from "./workerGate";
useNativeGlobals();

// T7c: the REAL face worker — real models, real codecs — behind
// createWorkerFaceGate. workerGate.test.ts pins the lifecycle against a
// scripted worker; this file pins what only the real thing can show: that
// the engine's event loop really stays free during a 2K check, that a real
// computation really is interruptible, and that load failures name their
// cause. (Byte-exact parity through the worker: parity.test.ts.)

const gates: WorkerFaceGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

function realGate(overrides: Parameters<typeof realWorkerInit>[0] = {}): WorkerFaceGate {
  const gate = createWorkerFaceGate({ spawnWorker: realWorkerSpawner(overrides) });
  gates.push(gate);
  return gate;
}

const live = (): AbortSignal => new AbortController().signal;

/** Runs `work` while a 4 ms timer ticks on THIS event loop, and reports the largest gap between ticks: how long the loop was ever unable to run anything else. */
async function timerGapDuring(work: () => Promise<unknown>): Promise<{ maxGapMs: number; durationMs: number }> {
  let last = performance.now();
  const started = last;
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 4);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  const finished = performance.now();
  // The stretch since the last tick counts too: a loop blocked for the whole check never ticks at all.
  return { maxGapMs: Math.max(maxGapMs, finished - last), durationMs: finished - started };
}

async function masterEmbeddingVia(gate: WorkerFaceGate): Promise<Float32Array> {
  return gate.embed(new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file))), live());
}

describe.skipIf(!MODELS_PRESENT)("the real face worker", () => {
  test("a 2K check leaves the engine's event loop free: the largest timer gap stays well under what the same check blocks in-thread", async () => {
    const image = twoKJpeg();

    // Control: the same decode + inference on THIS thread, as before T7c.
    const decode = createWasmImageDecoder(await createRealDecodeBackend(join(REPO_ROOT, "node_modules")));
    const inThread = await createFaceGate({
      yunet: new Uint8Array(await readFile(faceModelPaths(REPO_ROOT).yunet)),
      sface: new Uint8Array(await readFile(faceModelPaths(REPO_ROOT).sface)),
    });
    let control: { maxGapMs: number; durationMs: number };
    try {
      const masterEmbedding = await inThread.embed(await decode(new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file))), live()));
      await inThread.check({ pose: "front", image: await decode(image, live()), masterEmbedding }); // warm-up
      control = await timerGapDuring(async () => inThread.check({ pose: "front", image: await decode(image, live()), masterEmbedding }));
    } finally {
      await inThread.dispose();
    }

    const gate = realGate();
    await gate.start();
    const masterEmbedding = await masterEmbeddingVia(gate);
    await gate.check({ pose: "front", bytes: image, masterEmbedding }, live()); // warm-up
    const worker = await timerGapDuring(() => gate.check({ pose: "front", bytes: image, masterEmbedding }, live()));

    // The control must actually block (else this test measures nothing) ...
    expect(control.maxGapMs).toBeGreaterThan(40);
    // ... and the worker path must not: a fraction of it, and small in absolute terms.
    expect(worker.maxGapMs).toBeLessThan(control.maxGapMs / 2);
    expect(worker.maxGapMs).toBeLessThan(40);
    expect(worker.durationMs).toBeGreaterThan(worker.maxGapMs * 2);
  }, 60_000);

  test("cancelling a real 2K check mid-flight terminates the worker promptly, and the next check succeeds on a respawned worker", async () => {
    const image = twoKJpeg();
    const gate = realGate();
    await gate.start();
    const masterEmbedding = await masterEmbeddingVia(gate);

    const controller = new AbortController();
    const running = gate.check({ pose: "front", bytes: image, masterEmbedding }, controller.signal).then(
      () => "finished",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    await Bun.sleep(5); // inside decode or inference already
    const abortedAt = performance.now();
    controller.abort(new Error("cancelled by the job"));
    expect(await running).toBe("cancelled by the job");
    expect(performance.now() - abortedAt).toBeLessThan(1_000);

    const verdict = await gate.check({ pose: "front", bytes: image, masterEmbedding }, live());
    expect(["match", "mismatch", "no-face"]).toContain(verdict.kind);
  }, 60_000);

  test("a 12 MP master embeds through the worker (normalization runs inside it)", async () => {
    const gate = realGate();
    const embedding = await gate.embed(twelveMegapixelJpeg(), live());
    expect(embedding.length).toBe(128);
  }, 60_000);

  test("a reference with no face rejects embed with NoFaceInReferenceError", async () => {
    const gate = realGate();
    const flat = flatGreyJpeg(); // a valid JPEG with nothing to detect
    await expect(gate.embed(flat, live())).rejects.toBeInstanceOf(NoFaceInReferenceError);
  }, 30_000);

  test("an undecodable candidate rejects check with an ordinary Error and leaves the worker alive (systemic, never a retry verdict)", async () => {
    const gate = realGate();
    const masterEmbedding = await masterEmbeddingVia(gate);
    const notAnImage = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const error = await gate.check({ pose: "front", bytes: notAnImage, masterEmbedding }, live()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unsupported image format/);
    expect((await gate.check({ pose: "front", bytes: new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file))), masterEmbedding }, live())).kind).toBe("match");
  }, 30_000);
});

describe.skipIf(!MODELS_PRESENT)("start-up failures of the real worker name their cause", () => {
  test("a model file that does not exist rejects start() and leaves no worker behind", async () => {
    const gate = realGate({ models: { yunetPath: join(tmpdir(), "no-such-yunet.onnx"), sfacePath: realWorkerInit().models.sfacePath } });
    await expect(gate.start()).rejects.toThrow(/no-such-yunet\.onnx/);
  }, 30_000);

  test("model bytes that do not match the pinned sha256 are refused, naming the hash mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "face-worker-"));
    try {
      const tampered = join(dir, "face_detection_yunet_2023mar.onnx");
      writeFileSync(tampered, Uint8Array.of(1, 2, 3));
      const gate = realGate({ models: { yunetPath: tampered, sfacePath: realWorkerInit().models.sfacePath } });
      await expect(gate.start()).rejects.toThrow(/hash mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a workerData the worker cannot parse is refused up front, by the engine, with the validation message", () => {
    expect(() => realWorkerSpawner({ nodeModulesDir: "" })).toThrow(/nodeModulesDir/);
  });
});

function flatGreyJpeg(): Uint8Array {
  const result = spawnSync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=640x640", "-frames:v", "1", "-c:v", "mjpeg", "-f", "mjpeg", "pipe:1"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg could not build the faceless test image: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}
