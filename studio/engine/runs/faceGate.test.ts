import { afterEach, describe, expect, test } from "bun:test";
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
