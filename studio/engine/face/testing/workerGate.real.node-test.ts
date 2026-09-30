import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ffmpegPath } from "../../../node/ffmpegBinary";
import { createRealDecodeBackend } from "../../decode/realBackend";
import { createWasmImageDecoder } from "../../decode/wasmDecode";
import { createFocusResolver } from "../../focus/focusResolver";
import { openLibrary } from "../../library/library";
import { SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/sampleData";
import { createFaceGate } from "../gate";
import { NoFaceInReferenceError } from "../noFaceError";
import { FIXTURE_IMAGE_DIR, MODELS_PRESENT, REPO_ROOT, realWorkerInit, realWorkerSpawner, sharedRealFaceGate, twelveMegapixelJpeg, twoKJpeg } from "./realWorker";
import { faceModelPaths } from "../../../scripts/faceModelCache";
import { MASTER } from "../fixtures/expected";
import { createWorkerFaceGate, type WorkerFaceGate } from "../worker/workerGate";

// T7c: the REAL face worker — real models, real codecs — behind
// createWorkerFaceGate. workerGate.test.ts pins the lifecycle against a
// scripted worker; this file pins what only the real thing can show: that
// the engine's event loop really stays free during a 2K check, that a real
// computation really is interruptible, and that load failures name their
// cause. (Byte-exact parity through the worker: parity.test.ts.)

// These tests terminate a real worker running WASM, so they run under ELECTRON'S NODE, the product's own runtime, and
// not under Bun, where that teardown segfaults the runtime in a few percent of runs (`Segmentation fault at address
// 0x3C`, `mprotect failed: 487` on Windows) with no failed test. This file is bundled by
// studio/scripts/electronNodeTests.ts (`bun build --target=node`) and run as `ELECTRON_RUN_AS_NODE=1 <electron> --test
// <bundle>`, with the built worker next to it; the runner sets STUDIO_ROOT. It is named `.node-test.ts` so `bun test`
// never loads it. The runner fails a run with a skipped test, so nothing here skips itself.

const IS_CI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

// The models are never committed. In CI a step fetches them (`bun run models:face`), and a run without them must fail
// here, not go green over tests that could not load. Locally the same message tells what to run.
test("the face models must be present, never silently skipped", () => {
  assert.equal(MODELS_PRESENT, true, `the face models are missing${IS_CI ? " in CI" : ""}: run \`bun run models:face\``);
});

// The shared gate is never disposed by a test; `node --test` keeps the process alive while its worker runs.
after(async () => {
  await sharedRealFaceGate().dispose();
});

const gates: WorkerFaceGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

function ownGate(overrides: Parameters<typeof realWorkerInit>[0]): WorkerFaceGate {
  const gate = createWorkerFaceGate({ spawnWorker: realWorkerSpawner(overrides) });
  gates.push(gate);
  return gate;
}

/** A fresh temp dir per test, removed after it (the `node:test` twin of the bun helper). */
function useTempDir(prefix: string): () => string {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
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

describe("the real face worker", () => {
  test("a 2K check leaves the engine's event loop free: the largest timer gap stays well under what the same check blocks in-thread", { timeout: 60_000 }, async () => {
    const image = twoKJpeg();

    // Control: the same decode + inference on THIS thread, as before T7c.
    const decode = createWasmImageDecoder(await createRealDecodeBackend(join(REPO_ROOT, "node_modules")));
    // The wasm paths are given, as the worker's own are: a bundled test has no node_modules next to it to find them by.
    const inThread = await createFaceGate(
      {
        yunet: new Uint8Array(await readFile(faceModelPaths(REPO_ROOT).yunet)),
        sface: new Uint8Array(await readFile(faceModelPaths(REPO_ROOT).sface)),
      },
      undefined,
      realWorkerInit().wasmPaths,
    );
    let control: { maxGapMs: number; durationMs: number };
    try {
      const masterEmbedding = await inThread.embed(await decode(new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file))), live()));
      await inThread.check({ pose: "front", image: await decode(image, live()), masterEmbedding }); // warm-up
      control = await timerGapDuring(async () => inThread.check({ pose: "front", image: await decode(image, live()), masterEmbedding }));
    } finally {
      await inThread.dispose();
    }

    const gate = sharedRealFaceGate();
    await gate.start();
    const masterEmbedding = await masterEmbeddingVia(gate);
    await gate.check({ pose: "front", bytes: image, masterEmbedding }, live()); // warm-up
    const worker = await timerGapDuring(() => gate.check({ pose: "front", bytes: image, masterEmbedding }, live()));

    // The control must actually block (else this test measures nothing) ...
    assert.ok(control.maxGapMs > 40, `the control blocked the loop for only ${control.maxGapMs} ms`);
    // ... and the worker path must not: a fraction of it. (Relative only: an absolute millisecond bound is flaky on 3-4 vCPU runners and under Windows' 15.6 ms timer.)
    assert.ok(worker.maxGapMs < control.maxGapMs / 2, `worker gap ${worker.maxGapMs} ms against control gap ${control.maxGapMs} ms`);
    assert.ok(worker.durationMs > worker.maxGapMs * 2, `duration ${worker.durationMs} ms against gap ${worker.maxGapMs} ms`);
  });

  test("cancelling a real 2K check mid-flight terminates the worker promptly, and the next check succeeds on a respawned worker", { timeout: 60_000 }, async () => {
    const image = twoKJpeg();
    const gate = sharedRealFaceGate();
    await gate.start();
    const masterEmbedding = await masterEmbeddingVia(gate);

    const controller = new AbortController();
    const running = gate.check({ pose: "front", bytes: image, masterEmbedding }, controller.signal).then(
      () => "finished",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    await sleep(5); // inside decode or inference already
    const abortedAt = performance.now();
    controller.abort(new Error("cancelled by the job"));
    assert.equal(await running, "cancelled by the job");
    const tookMs = performance.now() - abortedAt;
    assert.ok(tookMs < 1_000, `the abort took ${tookMs} ms to settle`);

    const verdict = await gate.check({ pose: "front", bytes: image, masterEmbedding }, live());
    assert.ok(["match", "mismatch", "no-face"].includes(verdict.kind), `unexpected verdict ${verdict.kind}`);
  });

  test("a 12 MP master embeds through the worker (normalization runs inside it)", { timeout: 60_000 }, async () => {
    const gate = sharedRealFaceGate();
    const embedding = await gate.embed(twelveMegapixelJpeg(), live());
    assert.equal(embedding.length, 128);
  });

  test("a reference with no face rejects embed with NoFaceInReferenceError", { timeout: 30_000 }, async () => {
    const gate = sharedRealFaceGate();
    const flat = flatGreyJpeg(); // a valid JPEG with nothing to detect
    await assert.rejects(gate.embed(flat, live()), NoFaceInReferenceError);
  });

  test("detect finds the fixture master's face and reports the source size", { timeout: 30_000 }, async () => {
    const gate = sharedRealFaceGate();
    const detection = await gate.detect(new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file))), live());
    assert.deepEqual([detection.width, detection.height], [864, 1152]);
    // Measured with YuNet on this fixture: the box centre is at (0.503, 0.488) of the image.
    const face = detection.face;
    assert.notEqual(face, null);
    assert.ok(Math.abs(((face?.x ?? 0) + (face?.width ?? 0) / 2) / 864 - 0.503) < 0.05); // Bun's toBeCloseTo(_, 1): within 0.05
    assert.ok(Math.abs(((face?.y ?? 0) + (face?.height ?? 0) / 2) / 1152 - 0.488) < 0.05);
  });

  test("detect reports the box in SOURCE pixels for a 2K image that was normalised down before detection", { timeout: 60_000 }, async () => {
    const gate = sharedRealFaceGate();
    const detection = await gate.detect(twoKJpeg(), live());
    assert.deepEqual([detection.width, detection.height], [1536, 2752]);
    // The master letterboxed into 1536x2752: 1536x2048 of picture, 352 px of grey above and below.
    const face = detection.face;
    assert.notEqual(face, null);
    // Measured error in x: 0.014 (a different scale is a different detection). A box left in normalised pixels would miss by far more.
    assert.ok(Math.abs(((face?.x ?? 0) + (face?.width ?? 0) / 2) / 1536 - 0.503) < 0.02);
    assert.ok(Math.abs(((face?.y ?? 0) + (face?.height ?? 0) / 2) / 2752 - (352 + 0.488 * 2048) / 2752) < 0.02);
  });

  test("detect answers a null face, not an error, for an image with nothing to detect", { timeout: 30_000 }, async () => {
    const gate = sharedRealFaceGate();
    assert.equal((await gate.detect(flatGreyJpeg(), live())).face, null);
  });

  test("an undecodable candidate rejects check with an ordinary Error and leaves the worker alive (systemic, never a retry verdict)", { timeout: 30_000 }, async () => {
    const gate = sharedRealFaceGate();
    const masterEmbedding = await masterEmbeddingVia(gate);
    const notAnImage = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const error = await gate.check({ pose: "front", bytes: notAnImage, masterEmbedding }, live()).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof Error, "an ordinary Error was expected");
    assert.match(error.message, /unsupported image format/);
    assert.equal((await gate.check({ pose: "front", bytes: new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, MASTER.file))), masterEmbedding }, live())).kind, "match");
  });
});

describe("start-up failures of the real worker name their cause", () => {
  test("a model file that does not exist rejects start() and leaves no worker behind", { timeout: 30_000 }, async () => {
    const gate = ownGate({ models: { yunetPath: join(tmpdir(), "no-such-yunet.onnx"), sfacePath: realWorkerInit().models.sfacePath } });
    await assert.rejects(gate.start(), /no-such-yunet\.onnx/);
  });

  test("model bytes that do not match the pinned sha256 are refused, naming the hash mismatch", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "face-worker-"));
    try {
      const tampered = join(dir, "face_detection_yunet_2023mar.onnx");
      writeFileSync(tampered, Uint8Array.of(1, 2, 3));
      const gate = ownGate({ models: { yunetPath: tampered, sfacePath: realWorkerInit().models.sfacePath } });
      await assert.rejects(gate.start(), /hash mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a workerData the worker cannot parse is refused up front, by the engine, with the validation message", () => {
    assert.throws(() => realWorkerSpawner({ nodeModulesDir: "" }), /nodeModulesDir/);
  });
});

// S8: the focus resolver over the REAL detector, the real fixtures and a real
// library folder. focusResolver.test.ts pins the caching, fallback and bounds
// against a scripted gate; this pins that the point it derives really lands on
// the face.
describe("focus resolution on the real face fixtures", () => {
  const libraryRoot = useTempDir("studio-focus-real-");

  /** Points measured with YuNet on the committed fixtures: the centre of the largest face box, as fractions of the image. */
  const MEASURED = {
    [MASTER.file]: { x: 0.503, y: 0.488 },
    "render-best-home-1.jpg": { x: 0.516, y: 0.408 },
    "render-worst-fitness-3.jpg": { x: 0.371, y: 0.479 }, // a small face (11 percent of the height), off to the left
  } as const;

  async function libraryWith(images: ReadonlyArray<{ bytes: Uint8Array; width: number; height: number }>) {
    const { library } = await openLibrary(libraryRoot(), { now: steppingClock(), newId: sequentialIds() });
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const photoIds: string[] = [];
    for (const image of images) {
      const photo = await library.addPhoto(avatar.id, image.bytes, samplePhotoMeta({ mediaType: "image/jpeg", width: image.width, height: image.height }));
      photoIds.push(photo.id);
    }
    return { library, avatarId: avatar.id, photoIds };
  }

  const fixtureJpeg = async (file: string) => new Uint8Array(await readFile(join(FIXTURE_IMAGE_DIR, file)));

  for (const [file, expected] of Object.entries(MEASURED)) {
    test(`centres the focus on the face in ${file}`, { timeout: 30_000 }, async () => {
      const size = file === MASTER.file ? { width: 864, height: 1152 } : { width: 720, height: 1280 };
      const { library, avatarId, photoIds } = await libraryWith([{ bytes: await fixtureJpeg(file), ...size }]);
      const { focusFor } = createFocusResolver({ library, faceGate: sharedRealFaceGate() });
      const { focus, resolved } = await focusFor(avatarId, photoIds[0] ?? "");
      assert.equal(resolved, true);
      assert.ok(Math.abs(focus.x - expected.x) < 0.005, `x ${focus.x} against ${expected.x}`);
      assert.ok(Math.abs(focus.y - expected.y) < 0.005, `y ${focus.y} against ${expected.y}`);
    });
  }

  test("gives the (0.5, 0.38) fallback for an image with no face, and it is not an error", { timeout: 30_000 }, async () => {
    const { library, avatarId, photoIds } = await libraryWith([{ bytes: flatGreyJpeg(), width: 640, height: 640 }]);
    const { focusFor } = createFocusResolver({ library, faceGate: sharedRealFaceGate() });
    assert.deepEqual(await focusFor(avatarId, photoIds[0] ?? ""), { focus: { x: 0.5, y: 0.38 }, resolved: true }); // judged: there is really no face
  });

  test("a restarted resolver answers from the saved file: the second one never reaches the detector", { timeout: 30_000 }, async () => {
    const { library, avatarId, photoIds } = await libraryWith([{ bytes: await fixtureJpeg(MASTER.file), width: 864, height: 1152 }]);
    const real = sharedRealFaceGate();
    const firstResolver = createFocusResolver({ library, faceGate: real });
    const first = await firstResolver.focusFor(avatarId, photoIds[0] ?? "");
    await firstResolver.flush();
    let detections = 0;
    const counting = {
      isBroken: () => real.isBroken(),
      detect: (bytes: Uint8Array, signal: AbortSignal) => {
        detections += 1;
        return real.detect(bytes, signal);
      },
    };
    assert.deepEqual(await createFocusResolver({ library, faceGate: counting }).focusFor(avatarId, photoIds[0] ?? ""), first);
    assert.equal(detections, 0);
  });

  test("fillMissingFocus fills a headless spec's null cells from the real detector and leaves a set focus alone", { timeout: 30_000 }, async () => {
    const { library, avatarId, photoIds } = await libraryWith([
      { bytes: await fixtureJpeg(MASTER.file), width: 864, height: 1152 },
      { bytes: await fixtureJpeg("render-best-home-1.jpg"), width: 720, height: 1280 },
    ]);
    const { fillMissingFocus } = createFocusResolver({ library, faceGate: sharedRealFaceGate() });
    const [a = "", b = ""] = photoIds;
    const base = { durationMs: 2_000, transitionIn: "cut" as const, motion: "kenburns" as const };
    const { spec: filled, unresolved } = await fillMissingFocus({
      schemaVersion: 1,
      avatarId,
      layers: [],
      music: null,
      seed: 1,
      clips: [
        { ...base, clipId: "clip-001", kind: "photo", cell: { photo: { source: "scene", photoId: a }, focus: null } },
        { ...base, clipId: "clip-002", kind: "photo", cell: { photo: { source: "scene", photoId: b }, focus: { x: 0.1, y: 0.9 } } },
      ],
    });
    const [first, second] = filled.clips;
    const firstFocus = first?.kind === "photo" ? first.cell.focus : null;
    assert.deepEqual(unresolved, []);
    assert.ok(Math.abs((firstFocus?.x ?? 9) - 0.503) < 0.005);
    assert.ok(Math.abs((firstFocus?.y ?? 9) - 0.488) < 0.005);
    assert.deepEqual(second?.kind === "photo" ? second.cell.focus : null, { x: 0.1, y: 0.9 });
  });
});

function flatGreyJpeg(): Uint8Array {
  const result = spawnSync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=640x640", "-frames:v", "1", "-c:v", "mjpeg", "-f", "mjpeg", "pipe:1"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg could not build the faceless test image: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}
