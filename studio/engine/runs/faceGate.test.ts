import { afterEach, describe, expect, test } from "bun:test";
import type { FaceGateImage, FaceGateInput } from "../face";
import type { PlanSlot } from "../scenes";
import { asLibraryReference, setupMoney, type Money } from "../openrouter/testing/fakes";
import type { QaInput } from "./qa";
import { createFaceQaGate, FACE_GATE_NAME, type FaceQaGateDeps } from "./faceGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7b: the face gate's QaGate adapter. `FaceGate` itself (studio/engine/face)
// never decodes an image file and never learns about QaInput/QaVerdict — this
// adapter is the only place that bridges the two: it decodes both the
// candidate image and (once per avatar) the master reference via
// `input.decodeImage` (T7b's own decode decision: Electron's nativeImage,
// reached through main — see control.ts/studio/main/imageDecode.ts — because
// the engine's utilityProcess has no nativeImage of its own), then maps
// FaceGate's verdict onto the hybrid hard-retry policy the owner picked
// (config.ts, policy.ts): match/skipped-by-pose pass, everything else
// (no-face, multiple-faces, unexpected-face, mismatch) retries. It never
// itself decides identity — `deps.faceGate` (real: studio/engine/face's
// `createFaceGate()`) does that; this file only pins the adapter's own
// wiring: decode timing, the master-embedding cache, and the verdict mapping.

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

  test("computes the master embedding once and reuses it across N photos of the same avatar", async () => {
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

    for (let i = 0; i < 5; i++) {
      const verdict = await gate.check(input({ attemptId: `run-1:slot-${i + 1}#1` }, m));
      expect(verdict.verdict).toBe("pass");
    }

    expect(embedCalls).toBe(1);
    expect(embedded).toEqual(DECODED);
  });

  test("decodes the master through input.decodeImage, not any other path", async () => {
    const m = await money();
    const decodeCalls: Uint8Array[] = [];
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });

    await gate.check(input({ decodeImage: async (bytes) => (decodeCalls.push(bytes), DECODED) }, m));

    // First decode call is the master (embedding is computed before the candidate check).
    expect(decodeCalls[0]).toBe(MASTER_BYTES);
  });

  test("a master with no detectable face: embed() rejects, and check() throws (the gate cannot run for this avatar at all)", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: async () => {
          throw new Error("face/gate: embed() found no face in the reference image");
        },
      }),
    });

    await expect(gate.check(input({}, m))).rejects.toThrow(/no face/);
  });

  test("a master embed failure is cached too: a second photo does not retry the embed and fails the same way", async () => {
    const m = await money();
    let embedCalls = 0;
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({
        embed: async () => {
          embedCalls++;
          throw new Error("no face in master");
        },
      }),
    });

    await expect(gate.check(input({ attemptId: "a" }, m))).rejects.toThrow();
    await expect(gate.check(input({ attemptId: "b" }, m))).rejects.toThrow();

    expect(embedCalls).toBe(1);
  });

  test("an undecodable candidate image (decodeImage rejects, not aborted): retries", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });

    const verdict = await gate.check(
      input(
        {
          decodeImage: async (bytes) => {
            if (bytes === MASTER_BYTES) return DECODED; // the master still decodes fine
            throw new Error("ffmpeg-equivalent: not a supported image");
          },
        },
        m,
      ),
    );

    expect(verdict).toEqual({ verdict: "retry", reason: expect.stringContaining("could not be decoded") });
  });

  test("abort mid-inference: a signal-aborted decodeImage rejection propagates (thrown), not turned into a retry", async () => {
    const m = await money();
    const controller = new AbortController();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });

    const check = gate.check(
      input(
        {
          signal: controller.signal,
          decodeImage: async (bytes) => {
            if (bytes === MASTER_BYTES) return DECODED;
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

    const verdict = await gate.check(input({}, m));

    expect(verdict).toEqual({ verdict: "pass", qa: { faceCos: 0.812345, headRatio: 0.271 } });
  });

  test("mismatch: retries, gross drift below the threshold", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "mismatch", similarity: 0.4, faces: 1, headRatio: 0.2 }) }),
    });

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("no-face: retries", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ check: async () => ({ kind: "no-face", faces: 0 }) }) });

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("multiple-faces: retries, on any pose", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ check: async () => ({ kind: "multiple-faces", faces: 2 }) }) });

    const verdict = await gate.check(input({ slot: { ...SLOT, pose: "back" } }, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("unexpected-face on a back shot: retries", async () => {
    const m = await money();
    const gate = createFaceQaGate({
      faceGate: fakeFaceGate({ check: async () => ({ kind: "unexpected-face", faces: 1, headRatio: 0.25 }) }),
    });

    const verdict = await gate.check(input({ slot: { ...SLOT, pose: "back" } }, m));

    expect(verdict.verdict).toBe("retry");
  });

  test("skipped-by-pose (profile, or a clean back shot): passes with no qa fields — no identity check for this pose", async () => {
    const m = await money();
    const gate = createFaceQaGate({ faceGate: fakeFaceGate({ check: async () => ({ kind: "skipped-by-pose", faces: 0 }) }) });

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

    await expect(gate.check(input({}, m))).rejects.toThrow(/session run failed/);
  });

  test("has no releaseClaim: it never claims anything, so runJob.ts's unconditional release is a harmless no-op for it", () => {
    const gate = createFaceQaGate({ faceGate: fakeFaceGate() });
    expect(gate.releaseClaim).toBeUndefined();
  });
});
