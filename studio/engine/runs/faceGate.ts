import type { FaceGate, FaceGateImage } from "../face";
import type { PhotoQa } from "../library";
import type { QaGate, QaInput, QaVerdict } from "./qa";

// T7b: the face gate's QaGate adapter. `studio/engine/face` (createFaceGate,
// runFaceGate, decideFaceVerdict) never decodes an image file and never
// learns about QaInput/QaVerdict — see face/index.ts's own header, which
// sketched this exact shape. This file is the only bridge: it decodes both
// the candidate image and (once per avatar, cached) the master reference via
// `input.decodeImage` (T7b's decode decision — real Electron `nativeImage`
// decoding, reached through main; see qa.ts's own comment on
// `QaInput.decodeImage`), then maps `FaceGate`'s verdict onto the owner's
// hybrid policy (face/config.ts, face/policy.ts): a `match` or
// `skipped-by-pose` passes; every clear-failure kind the owner named
// (`no-face`, `multiple-faces`, `unexpected-face`, `mismatch`) retries —
// exactly the mapping face/verdict.ts's own header documents.
//
// Free (`paid: false`): decoding through main costs no money, and neither
// does the ONNX inference itself — both run in the run's CPU pool, like the
// pdq gate. No `releaseClaim`: this gate makes no provisional claim of its
// own (nothing here is a resource another attempt could race for), so
// `runJob.ts`'s unconditional per-gate release is a harmless no-op for it,
// exactly like the age gate's.
//
// The master embedding: computed once per avatar (not per run — an avatar's
// master photo is immutable once picked, invariant 9, so caching for the
// whole engine process's life is strictly stronger than "once per run" and
// costs nothing extra across repeat runs of the same avatar). A master with
// no detectable face — `deps.faceGate.embed()` throws (its own documented
// contract) — means this gate cannot run for this avatar at ALL: the
// failure is never caught here, so it propagates as a plain thrown error.
// `runJob.ts`'s own wrapper (`checkFree`) reads an uncaught throw from a
// free gate the same way it reads a broken decoder or a missing model —
// `GateBroken`, systemic, stopping the whole run (unless the job was
// already cancelled, read as `GateDropped` instead) — never a `GateFailure`
// (qa.ts's own contract: GateFailure is for a classified failure like a rate
// limit or an invalid key, not "this avatar's data makes the gate unusable").
// The failed embed is cached too (a failing promise, same as a succeeding
// one): a second photo of the same broken avatar fails the identical way
// without a second wasted decode+embed attempt, matching the systemic
// framing above (every later image would hit the exact same problem).
//
// OWNER DECISION (documented in docs/studio/2026-09-24-stage-2-plan.md's
// "T7b wiring — decisions"): a run is NOT refused up front for an avatar
// whose master has no detectable face. The embedding is computed lazily, on
// the first candidate's own check — after that first paid image was already
// generated — rather than eagerly before any money is spent. This mirrors
// every other "gate is broken" scenario already handled by GateBroken (e.g.
// ffmpeg itself missing): the run discovers the problem on its first
// attempt, stops cleanly, and that one already-paid image's cost stands.
// Refusing eagerly would need a new QaGate lifecycle hook (qa.ts has none
// today beyond `check`/`releaseClaim`) for a single gate's own special case;
// the existing, already-reviewed failure path handles it correctly without
// one.
//
// A candidate image that cannot be decoded (decodeImage rejects, and
// `input.signal` is not the reason) is this ONE photo's own problem, like
// the pdq gate's own decode failure: `retry`. A decode rejection because
// `input.signal` fired (the run's cancel, or this gate's own outer timeout)
// is left to propagate — `runJob.ts`'s own wrapper decides whether that
// means the image is merely dropped (a cancel) or the gate itself is broken
// (its own timeout firing on what should be fast, local decoding).

export const FACE_GATE_NAME = "face";

export interface FaceQaGateDeps {
  /** The real one: studio/engine/face's `createFaceGate()`. Only `check` and `embed` are used — `dispose()` is the wiring's own concern (main.ts), not this adapter's. */
  faceGate: Pick<FaceGate, "check" | "embed">;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function qaOf(verdict: { kind: "match" | "mismatch"; similarity: number; headRatio: number }): PhotoQa {
  return { faceCos: verdict.similarity, headRatio: verdict.headRatio };
}

export function createFaceQaGate(deps: FaceQaGateDeps): QaGate {
  /** One cached (possibly still-pending, possibly rejected) embedding per avatarId, for the gate's whole life. */
  const masterEmbeddings = new Map<string, Promise<Float32Array>>();

  function embeddingFor(input: QaInput): Promise<Float32Array> {
    const cached = masterEmbeddings.get(input.avatarId);
    if (cached !== undefined) return cached;
    const embedding = (async () => {
      const decoded = await input.decodeImage(input.master, input.signal);
      return deps.faceGate.embed(decoded);
    })();
    masterEmbeddings.set(input.avatarId, embedding);
    return embedding;
  }

  return {
    name: FACE_GATE_NAME,
    paid: false,
    async check(input: QaInput): Promise<QaVerdict> {
      // Propagates uncaught on failure (see this file's own header): a broken
      // master, a broken decoder or a missing model are all "this gate cannot
      // run for this avatar/at all", never a per-photo verdict.
      const masterEmbedding = await embeddingFor(input);

      let image: FaceGateImage;
      try {
        image = await input.decodeImage(input.image.bytes, input.signal);
      } catch (error) {
        if (input.signal.aborted) throw error;
        return { verdict: "retry", reason: `the image could not be decoded for its face check: ${messageOf(error)}` };
      }

      const verdict = await deps.faceGate.check({ pose: input.slot.pose, image, masterEmbedding });
      switch (verdict.kind) {
        case "match":
          return { verdict: "pass", qa: qaOf(verdict) };
        case "skipped-by-pose":
          return { verdict: "pass" };
        case "mismatch":
          return { verdict: "retry", reason: `similarity ${verdict.similarity} is below the identity threshold (gross drift)` };
        case "no-face":
          return { verdict: "retry", reason: "no face was detected in the photo" };
        case "multiple-faces":
          return { verdict: "retry", reason: `${verdict.faces} prominent faces were detected` };
        case "unexpected-face":
          return { verdict: "retry", reason: `a face was detected on a shot posed from behind (headRatio ${verdict.headRatio})` };
      }
    },
  };
}
