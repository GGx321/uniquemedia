import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PlanSlot } from "../scenes";
import { asLibraryReference, setupMoney, type Money } from "../openrouter/testing/fakes";
import type { QaInput, QaPrepareInput } from "./qa";
import { createFaceQaGate, FACE_GATE_NAME, type FaceQaGateDeps } from "./faceGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7b: the face gate's QaGate adapter. `FaceGate` itself (studio/engine/face)
// never decodes an image file and never learns about QaInput/QaVerdict — this
// adapter is the only place that bridges the two.
//
// Money review H1/M1/N1/H2 (2c review round 2) reshaped this adapter:
// - H1: the master embedding is computed by `prepare()`, once per job,
//   BEFORE any image is generated — never lazily on the first candidate's
//   own `check()` (the old, reversed design).
// - M1/N1: `prepare()` is given the master's ORIGINAL file bytes
//   (`QaPrepareInput.masterOriginal`), never the OpenRouter-bound downscale.
// - H2: the cache is keyed by avatarId + the master bytes' own sha256, only
//   a successful embedding is kept (a rejection evicts), and the shared
//   computation runs independent of any one caller's own abort signal.
// Section A.4 (the decode decision): a candidate that cannot be decoded now
// propagates uncaught — systemic, never a per-photo `retry` — because these
// bytes already passed the pdq gate's own decode.
// T7c: the decode and the inference run in the face worker thread
// (face/worker/workerGate.ts), so this adapter hands it BYTES and the run's
// own signal; the FIFO lane, its cancellation semantics (N5, B1) and the
// real interruption of a computation in flight live — and are pinned — there.

const SLOT: PlanSlot = {
  slotIndex: 1,
  attemptIdBase: "slot-1",
  location: "kitchen",
  timeOfDay: "morning",
  activity: "making coffee",
  outfit: "robe",
  category: "home",
  shot: "candid",
  pose: "front",
  repeatedPair: false,
};

const MASTER_BYTES = asLibraryReference(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
const MASTER_ORIGINAL_A = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 1);
const MASTER_ORIGINAL_B = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 2);
/** N10: the sha256 `check()` must be given to match what `prepare()` (given MASTER_ORIGINAL_A, faceGate.ts's own internal hash) actually cached. */
const MASTER_ORIGINAL_A_SHA256 = createHash("sha256").update(MASTER_ORIGINAL_A).digest("hex");
const MASTER_ORIGINAL_B_SHA256 = createHash("sha256").update(MASTER_ORIGINAL_B).digest("hex");
const CANDIDATE_BYTES = Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 4, 5, 6);
const MASTER_EMBEDDING = new Float32Array([1, 0, 0]);

const opened: Money[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((m) => m.cleanup()));
});

async function money(): Promise<Money> {
  const m = await setupMoney();
  opened.push(m);
  return m;
}

function prepareInput(overrides: Partial<QaPrepareInput> = {}): QaPrepareInput {
  return {
    avatarId: "avatar-1",
    masterOriginal: MASTER_ORIGINAL_A,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function input(overrides: Partial<QaInput> = {}, money_: Money): QaInput {
  return {
    runId: "run-1",
    jobId: "job-1",
    avatarId: "avatar-1",
    attemptId: "run-1:slot-1#1",
    scope: { runId: "run-1" },
    budget: money_.budget,
    priceBook: money_.priceBook,
    slot: SLOT,
    image: { bytes: CANDIDATE_BYTES, mediaType: "image/jpeg", width: 400, height: 800 },
    signal: new AbortController().signal,
    chat: () => {
      throw new Error("must not be called: face is a free gate");
    },
    beforeSend: () => true,
    photosByAvatar: () => [],
    master: MASTER_BYTES,
    masterSha256: MASTER_ORIGINAL_A_SHA256,
    ...overrides,
  };
}

/** A fake `WorkerFaceGate` (the real one lives in studio/engine/face/worker): `embed` and `check` are both injectable. */
function fakeFaceGate(overrides: Partial<FaceQaGateDeps["faceGate"]> = {}): FaceQaGateDeps["faceGate"] {
  return {
    embed: async () => MASTER_EMBEDDING,
    check: async () => ({ kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 }),
    isBroken: () => false,
    ...overrides,
  };
}

describe("a broken worker gate", () => {
  test("is reported as unavailable by the QA gate, and a healthy one as available", () => {
    let broken = false;
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ isBroken: () => broken }) });
    expect(gate.available?.()).toBe(true);
    broken = true;
    expect(gate.available?.()).toBe(false);
  });

  test("refuses prepare() even when the master's embedding is already cached, and asks the worker for nothing", async () => {
    let broken = false;
    let embedCalls = 0;
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ isBroken: () => broken, embed: async () => (embedCalls++, MASTER_EMBEDDING) }) });
    await gate.prepare?.(prepareInput()); // caches the embedding
    broken = true;
    await expect(gate.prepare?.(prepareInput())).rejects.toThrow(/broken/);
    expect(embedCalls).toBe(1);
  });
});

describe("createFaceQaGate", () => {
  test("name is 'face' and it is free", () => {
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    expect(gate.name).toBe(FACE_GATE_NAME);
    expect(gate.paid).toBe(false);
  });

  test("has no releaseClaim: it never claims anything, so runJob.ts's unconditional release is a harmless no-op for it", () => {
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    expect(gate.releaseClaim).toBeUndefined();
  });

  test("implements prepare", () => {
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    expect(typeof gate.prepare).toBe("function");
  });
});

describe("prepare() (H1: computes the master embedding eagerly, before any check())", () => {
  test("embeds input.masterOriginal's bytes — never QaInput.master (M1/N1)", async () => {
    const embedCalls: Uint8Array[] = [];
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ embed: async (bytes) => (embedCalls.push(bytes), MASTER_EMBEDDING) }) });

    await gate.prepare?.(prepareInput());

    expect(embedCalls).toEqual([MASTER_ORIGINAL_A]);
  });

  test("computes the embedding once and reuses it across N later check()s of the same avatar", async () => {
    const m = await money();
    let embedCalls = 0;
    let embedded: Uint8Array | undefined;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: async (bytes) => {
          embedCalls++;
          embedded = bytes;
          return MASTER_EMBEDDING;
        },
      }),
    });

    await gate.prepare?.(prepareInput());
    for (let i = 0; i < 5; i++) {
      const verdict = await gate.check(input({ attemptId: `run-1:slot-${i + 1}#1` }, m));
      expect(verdict.verdict).toBe("pass");
    }

    expect(embedCalls).toBe(1);
    expect(embedded).toEqual(MASTER_ORIGINAL_A);
  });

  test("a master with no detectable face: embed() rejects, and prepare() rejects (the gate cannot run for this avatar at all)", async () => {
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: async () => {
          throw new Error("face/gate: embed() found no face in the reference image");
        },
      }),
    });

    await expect(gate.prepare?.(prepareInput())).rejects.toThrow(/no face/);
  });

  test("H2: a failed prepare() is not cached — a retry (e.g. a resume's own prepare()) gets a fresh attempt", async () => {
    let embedCalls = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: async () => {
          embedCalls++;
          if (embedCalls === 1) throw new Error("transient decode failure");
          return MASTER_EMBEDDING;
        },
      }),
    });

    await expect(gate.prepare?.(prepareInput())).rejects.toThrow("transient decode failure");
    await gate.prepare?.(prepareInput()); // same avatarId + same masterOriginal — a fresh attempt, not the cached failure.

    expect(embedCalls).toBe(2);
  });

  test("H2: keyed by avatarId + the master bytes' own sha256 — a different masterOriginal for the same avatarId recomputes", async () => {
    let embedCalls = 0;
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ embed: async () => (embedCalls++, MASTER_EMBEDDING) }) });

    await gate.prepare?.(prepareInput({ masterOriginal: MASTER_ORIGINAL_A }));
    await gate.prepare?.(prepareInput({ masterOriginal: MASTER_ORIGINAL_B }));

    expect(embedCalls).toBe(2);
  });

  test("H2: the same avatarId + the same masterOriginal bytes reuse the cache across separate prepare() calls (e.g. across resumes)", async () => {
    let embedCalls = 0;
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ embed: async () => (embedCalls++, MASTER_EMBEDDING) }) });

    await gate.prepare?.(prepareInput({ masterOriginal: MASTER_ORIGINAL_A }));
    await gate.prepare?.(prepareInput({ masterOriginal: MASTER_ORIGINAL_A }));

    expect(embedCalls).toBe(1);
  });

  test("H2: a caller's own signal aborting during the master embed does not kill the shared computation — a second call with a live signal still succeeds, embed() ran once", async () => {
    let embedCalls = 0;
    let resolveEmbed: ((embedding: Float32Array) => void) | undefined;
    const pendingEmbed = new Promise<Float32Array>((resolve) => {
      resolveEmbed = resolve;
    });
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ embed: async () => (embedCalls++, pendingEmbed) }) });

    const controllerA = new AbortController();
    const prepareA = gate.prepare?.(prepareInput({ signal: controllerA.signal }));
    controllerA.abort(new Error("caller A gave up waiting"));
    await expect(prepareA).rejects.toThrow("caller A gave up waiting");

    // The shared computation is still in flight; let it finish now.
    resolveEmbed?.(MASTER_EMBEDDING);

    // A second caller joins the very same computation — embed() is never called again.
    await gate.prepare?.(prepareInput({ signal: new AbortController().signal }));

    expect(embedCalls).toBe(1);
  });

  test("N11: a computation that never settles is evicted after embeddingComputeTimeoutMs — a LATER job gets a fresh attempt, not stuck forever", async () => {
    let embedCalls = 0;
    const gate = createFaceQaGate({
      // The first embed() never settles and ignores its signal (a backend that
      // cannot be interrupted); the second answers.
      faceGate: fakeFaceGate({ embed: async () => (++embedCalls === 1 ? new Promise<Float32Array>(() => {}) : MASTER_EMBEDDING) }),
      embeddingComputeTimeoutMs: 20,
    });

    // The first caller's wait is bounded by its own signal, but the
    // underlying computation is not.
    const firstController = new AbortController();
    setTimeout(() => firstController.abort(new Error("first caller gave up waiting")), 5);
    const first = gate.prepare?.(prepareInput({ signal: firstController.signal }));
    await expect(first).rejects.toThrow("first caller gave up waiting");

    // Past embeddingComputeTimeoutMs (20 ms): the cache entry must have been
    // evicted, so a later job (a resume, a brand new run) gets a fresh
    // computation — never the same permanently-hung promise, forever.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await gate.prepare?.(prepareInput());

    expect(embedCalls).toBe(2); // the hung computation, then the fresh one — not a third.
  });

  test("B2: a SLOW (not hung) computation evicted mid-flight, then resolving, still leaves check() a usable entry", async () => {
    // Round-2 verification, B2: job 1 is cancelled during a slow (>30 s in
    // production) master computation; the resume (job 2) reuses the very
    // same pending promise; N11's own eviction timer fires while it is
    // still pending; the computation THEN resolves successfully — job 2's
    // own prepare() call, still awaiting that exact promise, succeeds. But
    // the cache entry was already evicted, so the FIRST check() afterwards
    // found nothing and threw GateBroken after a paid image. Fixed:
    // embeddingFor re-installs the successful result if the slot is still
    // empty (or unchanged) once the awaited value actually arrives.
    const m = await money();
    let release: (() => void) | undefined;
    const gateP = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = createFaceQaGate({
      // A backend that keeps working past the bound (ignores its signal) and then succeeds.
      faceGate: fakeFaceGate({
        embed: async () => {
          await gateP;
          return MASTER_EMBEDDING;
        },
      }),
      embeddingComputeTimeoutMs: 30,
    });

    const j1Controller = new AbortController();
    setTimeout(() => j1Controller.abort(new Error("job 1 gave up")), 10);
    const j1 = gate.prepare?.(prepareInput({ signal: j1Controller.signal })).catch(() => "j1 gave up");

    await new Promise((resolve) => setTimeout(resolve, 20));
    // job 2 (a resume) starts with a much longer bound, reusing the same pending computation.
    const j2 = gate.prepare?.(prepareInput({ signal: new AbortController().signal }));

    // Past embeddingComputeTimeoutMs (30 ms since the computation started at
    // t=0): the eviction timer fires while the computation is STILL pending.
    await new Promise((resolve) => setTimeout(resolve, 40));
    release?.(); // the computation finishes at ~40ms+, after eviction.
    await j2; // job 2's own prepare() succeeded.
    await j1;

    const verdict = await gate.check(input({}, m));
    expect(verdict.verdict).toBe("pass");
  });

  test("T7c: the shared embedding computation runs against a signal that aborts at embeddingComputeTimeoutMs, so a real worker is terminated instead of occupying the lane forever", async () => {
    let seen: AbortSignal | undefined;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: (_bytes, signal) => {
          seen = signal;
          return new Promise<Float32Array>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
      }),
      embeddingComputeTimeoutMs: 20,
    });

    await expect(gate.prepare?.(prepareInput())).rejects.toThrow(/timed out/i);
    expect(seen?.aborted).toBe(true);
  });

  test("T7c: a caller giving up does NOT abort that shared signal — only the computation's own bound does (H2)", async () => {
    let seen: AbortSignal | undefined;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: (_bytes, signal) => {
          seen = signal;
          return new Promise<Float32Array>(() => {});
        },
      }),
      embeddingComputeTimeoutMs: 5_000,
    });
    const controller = new AbortController();
    const waiting = gate.prepare?.(prepareInput({ signal: controller.signal }));
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow("gave up");
    expect(seen?.aborted).toBe(false);
  });

  test("an already-aborted signal rejects prepare() immediately", async () => {
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    const controller = new AbortController();
    controller.abort(new Error("run cancelled before prepare"));

    await expect(gate.prepare?.(prepareInput({ signal: controller.signal }))).rejects.toThrow("run cancelled before prepare");
  });
});

describe("check() requires a prior prepare()", () => {
  test("throws clearly if prepare() was never called for this avatar (a wiring bug, not a per-photo problem)", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });

    await expect(gate.check(input({}, m))).rejects.toThrow(/prepare/);
  });

  test("N10: throws if the cached embedding's sha does not match this job's own masterSha256 (a stale or differently keyed preparation)", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    // prepare()d for MASTER_ORIGINAL_A, but this check() claims a DIFFERENT job's masterSha256 (B).
    await gate.prepare?.(prepareInput({ masterOriginal: MASTER_ORIGINAL_A }));

    await expect(gate.check(input({ masterSha256: MASTER_ORIGINAL_B_SHA256 }, m))).rejects.toThrow(/prepare/);
  });

  test("N10: succeeds when the cached embedding's sha matches this job's own masterSha256", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    await gate.prepare?.(prepareInput({ masterOriginal: MASTER_ORIGINAL_A }));

    const verdict = await gate.check(input({ masterSha256: MASTER_ORIGINAL_A_SHA256 }, m));

    expect(verdict.verdict).toBe("pass");
  });
});

describe("check() hands the worker gate what it needs", () => {
  test("T7c: passes the candidate's bytes, the slot's pose, the master embedding and the run's own signal — serialization and interruption are the worker gate's job", async () => {
    const m = await money();
    const seen: { bytes: Uint8Array; pose: string; masterEmbedding: Float32Array; signal: AbortSignal }[] = [];
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async (checkInput, signal) => {
          seen.push({ bytes: checkInput.bytes, pose: checkInput.pose, masterEmbedding: checkInput.masterEmbedding, signal });
          return { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      }),
    });
    await gate.prepare?.(prepareInput());
    const controller = new AbortController();

    await gate.check(input({ slot: { ...SLOT, pose: "three-quarter" }, signal: controller.signal }, m));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.bytes).toEqual(CANDIDATE_BYTES);
    expect(seen[0]?.pose).toBe("three-quarter");
    expect(seen[0]?.masterEmbedding).toEqual(MASTER_EMBEDDING);
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  test("T7c: the master embedding lookup still waits on the caller's own signal — a cancelled check rejects at once", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ embed: () => new Promise<Float32Array>(() => {}) }) });
    void gate.prepare?.(prepareInput({ signal: new AbortController().signal })).catch(() => {});
    const controller = new AbortController();
    const checking = gate.check(input({ signal: controller.signal }, m));
    controller.abort(new Error("run cancelled"));
    await expect(checking).rejects.toThrow("run cancelled");
  });
});

describe("check() (verdict mapping and failures)", () => {
  test("A.4: an undecodable candidate image — the worker's failure — propagates uncaught (systemic — never a retry verdict)", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async () => {
          throw new Error("wasm decode: corrupt JPEG data");
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    await expect(gate.check(input({}, m))).rejects.toThrow(/corrupt JPEG/);
  });

  test("abort mid-check: the worker gate's rejection with the run's abort reason propagates the same way", async () => {
    const m = await money();
    const controller = new AbortController();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async (_input, signal) => {
          controller.abort(new Error("run cancelled"));
          throw signal.reason;
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    await expect(gate.check(input({ signal: controller.signal }, m))).rejects.toThrow("run cancelled");
  });

  test("match: passes with qa.faceCos and qa.headRatio set from the verdict's similarity/headRatio", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "match", similarity: 0.812345, faces: 1, headRatio: 0.271 }) }),
    });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({}, m));

    expect(verdict).toEqual({ verdict: "pass", qa: { faceCos: 0.812345, headRatio: 0.271 } });
  });

  test("L7: clamps a similarity that overflows past 1 by a rounding step, so addPhoto never throws on the schema's own faceCos <= 1 bound", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "match", similarity: 1.0000000000000002, faces: 1, headRatio: 0.271 }) }),
    });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({}, m));

    expect(verdict).toEqual({ verdict: "pass", qa: { faceCos: 1, headRatio: 0.271 } });
  });

  test("L7: clamps a similarity that underflows past -1", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "match", similarity: -1.0000000000000002, faces: 1, headRatio: 0.271 }) }),
    });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({}, m));

    expect(verdict).toEqual({ verdict: "pass", qa: { faceCos: -1, headRatio: 0.271 } });
  });

  test("mismatch: retries, gross drift below the threshold", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "mismatch", similarity: 0.4, faces: 1, headRatio: 0.2 }) }),
    });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("no-face: retries", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ check: async () => ({ kind: "no-face", faces: 0 }) }) });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("multiple-faces: retries, on any pose", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ check: async () => ({ kind: "multiple-faces", faces: 2 }) }) });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({ slot: { ...SLOT, pose: "back" } }, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("unexpected-face on a back shot: retries", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "unexpected-face", faces: 1, headRatio: 0.25 }) }),
    });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({ slot: { ...SLOT, pose: "back" } }, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("skipped-by-pose (profile, or a clean back shot): passes with no qa fields — no identity check for this pose", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ check: async () => ({ kind: "skipped-by-pose", faces: 0 }) }) });
    await gate.prepare?.(prepareInput());

    const verdict = await gate.check(input({ slot: { ...SLOT, pose: "profile" } }, m));

    expect(verdict).toEqual({ verdict: "pass" });
  });

  test("passes the slot's own pose straight to the underlying FaceGate.check", async () => {
    const m = await money();
    const seen: Parameters<FaceQaGateDeps["faceGate"]["check"]>[0][] = [];
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async (input) => {
          seen.push(input);
          return { kind: "skipped-by-pose", faces: 0 };
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    await gate.check(input({ slot: { ...SLOT, pose: "profile" } }, m));

    expect(seen[0]?.pose).toBe("profile");
    expect(seen[0]?.masterEmbedding).toEqual(MASTER_EMBEDDING);
  });

  test("a broken underlying FaceGate.check (not a decode problem) throws, uncaught — the gate cannot run at all", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async () => {
          throw new Error("onnxruntime-web: session run failed");
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    await expect(gate.check(input({}, m))).rejects.toThrow(/session run failed/);
  });
});
