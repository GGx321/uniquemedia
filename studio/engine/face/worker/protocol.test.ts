import { describe, expect, test } from "bun:test";
import { EMBEDDING_LENGTH, FaceWorkerRequestSchema, FaceWorkerResponseSchema } from "./protocol";

// T7c: the wire format's bounds. Both ends validate with these; a response
// that does not fit is a protocol violation (workerGate.ts kills the worker).

const unit = (): Float32Array => {
  const e = new Float32Array(EMBEDDING_LENGTH);
  e[0] = 1;
  return e;
};

describe("an embedding is exactly EMBEDDING_LENGTH finite floats", () => {
  test("accepts a 128-float embedding in a response and as a request's master embedding", () => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "embedded", id: 1, embedding: unit() }).success).toBe(true);
    expect(FaceWorkerRequestSchema.safeParse({ type: "check", id: 1, pose: "front", bytes: new ArrayBuffer(1), masterEmbedding: unit() }).success).toBe(true);
  });

  test.each([0, 3, 127, 129, 512])("rejects a %i-float embedding", (length) => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "embedded", id: 1, embedding: new Float32Array(length) }).success).toBe(false);
  });

  test("rejects a NaN inside an otherwise well-sized embedding", () => {
    const bad = unit();
    bad[5] = Number.NaN;
    expect(FaceWorkerResponseSchema.safeParse({ type: "embedded", id: 1, embedding: bad }).success).toBe(false);
  });

  test("rejects an Infinity inside a request's master embedding", () => {
    const bad = unit();
    bad[7] = Number.POSITIVE_INFINITY;
    expect(FaceWorkerRequestSchema.safeParse({ type: "check", id: 1, pose: "front", bytes: new ArrayBuffer(1), masterEmbedding: bad }).success).toBe(false);
  });
});

describe("message strings are bounded", () => {
  test("accepts a short load-failed and failed message", () => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "load-failed", message: "no such file" }).success).toBe(true);
    expect(FaceWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "error", message: "boom" }).success).toBe(true);
  });

  test("rejects a megabyte-long load-failed message", () => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "load-failed", message: "x".repeat(1_000_000) }).success).toBe(false);
  });

  test("rejects a megabyte-long failed message", () => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "error", message: "x".repeat(1_000_000) }).success).toBe(false);
  });
});
