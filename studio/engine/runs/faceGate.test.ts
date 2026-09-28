import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { FaceGateImage, FaceGateInput } from "../face";
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
const DECODED: FaceGateImage = { format: "rgba", width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) };

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
    decodeImage: async () => DECODED,
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
    decodeImage: async () => DECODED,
    ...overrides,
  };
}

/** A fake `FaceGate` (the real module lives in studio/engine/face): `embed` and `check` are both injectable. */
function fakeFaceGate(overrides: Partial<FaceQaGateDeps["faceGate"]> = {}): FaceQaGateDeps["faceGate"] {
  return {
    embed: async () => MASTER_EMBEDDING,
    check: async () => ({ kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 }),
    ...overrides,
  };
}

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
  test("decodes and embeds input.masterOriginal — never QaInput.master (M1/N1)", async () => {
    const decodeCalls: Uint8Array[] = [];
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });

    await gate.prepare?.(prepareInput({ decodeImage: async (bytes) => (decodeCalls.push(bytes), DECODED) }));

    expect(decodeCalls).toEqual([MASTER_ORIGINAL_A]);
  });

  test("computes the embedding once and reuses it across N later check()s of the same avatar", async () => {
    const m = await money();
    let embedCalls = 0;
    let embedded: FaceGateImage | undefined;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: async (image) => {
          embedCalls++;
          embedded = image;
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
    expect(embedded).toEqual(DECODED);
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

  test("H2: a caller's own signal aborting during the master decode does not kill the shared computation — a second call with a live signal still succeeds, embed() ran once", async () => {
    let embedCalls = 0;
    let resolveDecode: ((image: FaceGateImage) => void) | undefined;
    const pendingDecode = new Promise<FaceGateImage>((resolve) => {
      resolveDecode = resolve;
    });
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ embed: async () => (embedCalls++, MASTER_EMBEDDING) }) });

    const controllerA = new AbortController();
    const prepareA = gate.prepare?.(
      prepareInput({
        signal: controllerA.signal,
        decodeImage: async () => pendingDecode,
      }),
    );
    controllerA.abort(new Error("caller A gave up waiting"));
    await expect(prepareA).rejects.toThrow("caller A gave up waiting");

    // The shared computation is still in flight; resolve the decode now.
    resolveDecode?.(DECODED);

    const controllerB = new AbortController();
    await gate.prepare?.(
      prepareInput({
        signal: controllerB.signal,
        decodeImage: async () => pendingDecode, // never actually called again — the shared computation is already running.
      }),
    );

    expect(embedCalls).toBe(1);
  });

  test("N11: a computation that never settles is evicted after embeddingComputeTimeoutMs — a LATER job gets a fresh attempt, not stuck forever", async () => {
    let embedCalls = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ embed: async () => (embedCalls++, MASTER_EMBEDDING) }),
      embeddingComputeTimeoutMs: 20,
    });

    // The first caller's own decodeImage hangs forever (a real decode/ORT
    // hang, not merely this caller giving up) — its own wait is bounded by
    // its own signal, but the underlying computation is not.
    const firstController = new AbortController();
    setTimeout(() => firstController.abort(new Error("first caller gave up waiting")), 5);
    const first = gate.prepare?.(prepareInput({ signal: firstController.signal, decodeImage: () => new Promise(() => {}) }));
    await expect(first).rejects.toThrow("first caller gave up waiting");

    // Past embeddingComputeTimeoutMs (20 ms): the cache entry must have been
    // evicted, so a later job (a resume, a brand new run) gets a fresh
    // computation — never the same permanently-hung promise, forever.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await gate.prepare?.(prepareInput({ decodeImage: async () => DECODED }));

    expect(embedCalls).toBe(1); // the hung computation never actually called embed(); the fresh one did, exactly once.
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
      faceGate: fakeFaceGate({ embed: async () => MASTER_EMBEDDING }),
      embeddingComputeTimeoutMs: 30,
    });
    const decodeImage = async () => {
      await gateP;
      return DECODED;
    };

    const j1Controller = new AbortController();
    setTimeout(() => j1Controller.abort(new Error("job 1 gave up")), 10);
    const j1 = gate.prepare?.(prepareInput({ signal: j1Controller.signal, decodeImage })).catch(() => "j1 gave up");

    await new Promise((resolve) => setTimeout(resolve, 20));
    // job 2 (a resume) starts with a much longer bound, reusing the same pending computation.
    const j2 = gate.prepare?.(prepareInput({ signal: new AbortController().signal, decodeImage }));

    // Past embeddingComputeTimeoutMs (30 ms since the computation started at
    // t=0): the eviction timer fires while the computation is STILL pending.
    await new Promise((resolve) => setTimeout(resolve, 40));
    release?.(); // the computation finishes at ~40ms+, after eviction.
    await j2; // job 2's own prepare() succeeded.
    await j1;

    const verdict = await gate.check(input({}, m));
    expect(verdict.verdict).toBe("pass");
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

describe("N5: face checks are serialized (memory) — a mutex around decode + check", () => {
  test("two concurrent checks never overlap inside the underlying faceGate.check()", async () => {
    const m = await money();
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight--;
          return { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    await Promise.all([
      gate.check(input({ attemptId: "run-1:slot-1#1" }, m)),
      gate.check(input({ attemptId: "run-1:slot-2#1" }, m)),
      gate.check(input({ attemptId: "run-1:slot-3#1" }, m)),
    ]);

    expect(maxInFlight).toBe(1);
  });

  test("a cancelled waiter leaves the lane: it rejects instead of blocking the next waiter forever", async () => {
    const m = await money();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let holderAcquired = false;
    let secondRan = false;
    let calls = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async () => {
          const isHolder = calls++ === 0;
          if (isHolder) {
            holderAcquired = true;
            await firstGate; // the first caller holds the lock until released
          } else {
            secondRan = true;
          }
          return { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    const holderController = new AbortController();
    const holder = gate.check(input({ attemptId: "run-1:slot-1#1", signal: holderController.signal }, m));
    // Wait for the holder to actually be inside the underlying check() (i.e. it holds the
    // mutex) before starting the waiter — otherwise the waiter could race the holder for the
    // lock itself, which is not what this test is about. Bounded (macrotask hops, never a tight
    // microtask spin) so a real bug here fails loudly instead of hanging the whole suite.
    for (let i = 0; i < 100 && !holderAcquired; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    if (!holderAcquired) throw new Error("the holder never reached the underlying check()");

    const waiterController = new AbortController();
    const waiter = gate.check(input({ attemptId: "run-1:slot-2#1", signal: waiterController.signal }, m));
    // Let the waiter's own master-embedding lookup settle (a resolved promise, but still a real
    // microtask hop) so it is genuinely queued on the mutex itself before we abort it.
    await Promise.resolve();
    await Promise.resolve();
    waiterController.abort(new Error("cancelled while waiting for the lock"));
    await expect(waiter).rejects.toThrow("cancelled while waiting for the lock");
    expect(secondRan).toBe(false); // the waiter never actually ran the underlying check

    // The lane must still be free for a THIRD caller once the holder releases it — the
    // cancelled waiter must not have left the mutex permanently locked.
    releaseFirst?.();
    await holder;
    const third = await gate.check(input({ attemptId: "run-1:slot-3#1" }, m));
    expect(third.verdict).toBe("pass");
  });

  test("B1: a waiter cancelled while queued BEHIND an active holder must not let the next waiter overlap the holder", async () => {
    const m = await money();
    let releaseHolder: (() => void) | undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let holderAcquired = false;
    let calls = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          const isHolder = calls++ === 0;
          if (isHolder) {
            holderAcquired = true;
            await holderGate;
          }
          active--;
          return { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    const h = gate.check(input({ attemptId: "run-1:slot-h#1" }, m));
    for (let i = 0; i < 100 && !holderAcquired; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    if (!holderAcquired) throw new Error("H never reached the underlying check()");

    const acA = new AbortController();
    const a = gate.check(input({ attemptId: "run-1:slot-a#1", signal: acA.signal }, m)).catch(() => "A rejected");
    const b = gate.check(input({ attemptId: "run-1:slot-b#1" }, m));
    // Let A actually queue behind H (a real microtask hop past its own
    // master-embedding lookup) before cancelling it.
    await Promise.resolve();
    await Promise.resolve();
    acA.abort(new Error("cancel A"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // While H still holds the lock (never released yet): B must still be
    // queued, not running — A's own cancellation must not have let B jump
    // the queue and overlap H.
    expect(maxActive).toBe(1);

    releaseHolder?.();
    await Promise.all([h, a, b]);
    expect(maxActive).toBe(1);
  });

  test("B1: a hung holder released by ITS OWN signal frees the lane for the next waiter (a zombie computation)", async () => {
    const m = await money();
    let secondRan = false;
    let calls = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        check: async () => {
          const isHolder = calls++ === 0;
          if (isHolder) {
            await new Promise(() => {}); // the holder's own underlying check never settles
          }
          secondRan = true;
          return { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      }),
    });
    await gate.prepare?.(prepareInput());

    const holderController = new AbortController();
    const holder = gate.check(input({ attemptId: "run-1:slot-h#1", signal: holderController.signal }, m)).catch(() => "holder aborted");
    // Give the holder a chance to actually acquire the lock and start its own (hanging) check().
    await new Promise((resolve) => setTimeout(resolve, 10));
    holderController.abort(new Error("the run's own cancel, or the gate's own outer timeout"));
    await holder;

    // The lane must be free now — a later waiter's own check() actually runs
    // (a "zombie": the holder's own body() is still hanging in the
    // background, but it no longer holds the lock).
    const second = await gate.check(input({ attemptId: "run-1:slot-b#1", signal: new AbortController().signal }, m));
    expect(second.verdict).toBe("pass");
    expect(secondRan).toBe(true);
  });
});

describe("check() (candidate decode and verdict mapping)", () => {
  test("decodes the candidate through input.decodeImage", async () => {
    const m = await money();
    const decodeCalls: Uint8Array[] = [];
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    await gate.prepare?.(prepareInput());

    await gate.check(input({ decodeImage: async (bytes) => (decodeCalls.push(bytes), DECODED) }, m));

    expect(decodeCalls).toEqual([CANDIDATE_BYTES]);
  });

  test("A.4: an undecodable candidate image propagates uncaught (systemic — never a retry verdict)", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    await gate.prepare?.(prepareInput());

    const check = gate.check(
      input(
        {
          decodeImage: async () => {
            throw new Error("wasm decode: corrupt JPEG data");
          },
        },
        m,
      ),
    );

    await expect(check).rejects.toThrow(/corrupt JPEG/);
  });

  test("abort mid-decode: a signal-aborted decodeImage rejection propagates the same way", async () => {
    const m = await money();
    const controller = new AbortController();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    await gate.prepare?.(prepareInput());

    const check = gate.check(
      input(
        {
          signal: controller.signal,
          decodeImage: async () => {
            controller.abort(new Error("run cancelled"));
            throw controller.signal.reason;
          },
        },
        m,
      ),
    );

    await expect(check).rejects.toThrow("run cancelled");
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
    const seen: FaceGateInput[] = [];
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
