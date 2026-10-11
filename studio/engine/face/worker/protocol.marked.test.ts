import { describe, expect, test } from "bun:test";
import { PoseSchema } from "../../scenes/schema";
import { ScenePose } from "../../../shared/engine";
import { EMBEDDING_LENGTH, FaceVerdictSchema, FaceWorkerRequestSchema, FaceWorkerResponseSchema } from "./protocol";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
useNativeGlobals();

// S5.6f: the wire carries the `body` pose and the `marked` verdict; the planner's poses stay four.

const embedding = (): Float32Array => {
  const e = new Float32Array(EMBEDDING_LENGTH);
  e[0] = 1;
  return e;
};

describe("the strict FaceVerdictSchema and `marked`", () => {
  test("accepts a marked verdict", () => {
    expect(FaceVerdictSchema.safeParse({ kind: "marked", similarity: 0.4, faces: 1, headRatio: 0.2 }).success).toBe(true);
  });

  test("round-trips a marked verdict unchanged", () => {
    const verdict = { kind: "marked", similarity: -0.1, faces: 2, headRatio: 0.05 } as const;
    expect(FaceVerdictSchema.parse(verdict)).toEqual(verdict);
  });

  test("a marked verdict travels in a checked response", () => {
    const response = { type: "checked", id: 3, verdict: { kind: "marked", similarity: 0.4, faces: 1, headRatio: 0.2 } };
    expect(FaceWorkerResponseSchema.safeParse(response).success).toBe(true);
  });

  test("refuses a marked verdict without its similarity", () => {
    expect(FaceVerdictSchema.safeParse({ kind: "marked", faces: 1, headRatio: 0.2 }).success).toBe(false);
  });

  test("refuses a marked verdict with an extra field", () => {
    expect(FaceVerdictSchema.safeParse({ kind: "marked", similarity: 0.4, faces: 1, headRatio: 0.2, extra: 1 }).success).toBe(false);
  });

  test("still refuses an unknown kind", () => {
    expect(FaceVerdictSchema.safeParse({ kind: "maybe-marked", similarity: 0.4, faces: 1, headRatio: 0.2 }).success).toBe(false);
  });
});

describe("the worker request and the body pose", () => {
  test("a check request may carry the body pose", () => {
    expect(FaceWorkerRequestSchema.safeParse({ type: "check", id: 1, pose: "body", bytes: new ArrayBuffer(1), masterEmbedding: embedding() }).success).toBe(true);
  });

  test("a check request still refuses an unknown pose", () => {
    expect(FaceWorkerRequestSchema.safeParse({ type: "check", id: 1, pose: "overhead", bytes: new ArrayBuffer(1), masterEmbedding: embedding() }).success).toBe(false);
  });
});

describe("the planner's poses stay four", () => {
  test("PoseSchema has the four planner poses and no body", () => {
    expect(PoseSchema.options).toEqual(["front", "three-quarter", "profile", "back"]);
  });

  test("ScenePose has the four planner poses and no body", () => {
    expect(ScenePose.options).toEqual(["front", "three-quarter", "profile", "back"]);
  });

  test("a planner slot cannot take the body pose", () => {
    expect(PoseSchema.safeParse("body").success).toBe(false);
  });
});
