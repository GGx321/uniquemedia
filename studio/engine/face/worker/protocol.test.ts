import { describe, expect, test } from "bun:test";
import { EMBEDDING_LENGTH, FaceWorkerRequestSchema, boundedMessage, FaceWorkerResponseSchema } from "./protocol";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
useNativeGlobals();

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

describe("boundedMessage fits any error text into the wire bound", () => {
  const LONG = `${"first issue: ".padEnd(100, "-")}${"x".repeat(5_000)}`;

  test("leaves a short message untouched", () => {
    expect(boundedMessage("no such file")).toBe("no such file");
  });

  test("leaves a message of exactly the bound untouched", () => {
    const exact = "y".repeat(2_000);
    expect(boundedMessage(exact)).toBe(exact);
  });

  test("cuts a message one character over the bound to the bound", () => {
    expect(boundedMessage("y".repeat(2_001)).length).toBe(2_000);
  });

  test("keeps the beginning of a long message, where the cause is", () => {
    expect(boundedMessage(LONG).startsWith("first issue: ")).toBe(true);
  });

  test("a long load-failed message becomes valid on the wire instead of a protocol violation", () => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "load-failed", message: boundedMessage(LONG) }).success).toBe(true);
  });

  test("a long failed message becomes valid on the wire instead of a protocol violation", () => {
    expect(FaceWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "error", message: boundedMessage(LONG) }).success).toBe(true);
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

describe("detect (S8: the focus point of a placed photo)", () => {
  const face = { x: 10, y: 20, width: 30, height: 40 };
  const detected = (over: Record<string, unknown> = {}) => ({ type: "detected", id: 1, width: 100, height: 200, face, ...over });

  test("accepts a detect request carrying only bytes", () => {
    expect(FaceWorkerRequestSchema.safeParse({ type: "detect", id: 1, bytes: new ArrayBuffer(1) }).success).toBe(true);
  });

  test("rejects a detect request with an extra field (no embedding is ever sent for it)", () => {
    expect(FaceWorkerRequestSchema.safeParse({ type: "detect", id: 1, bytes: new ArrayBuffer(1), masterEmbedding: unit() }).success).toBe(false);
  });

  test("rejects a detect request whose bytes are not an ArrayBuffer", () => {
    expect(FaceWorkerRequestSchema.safeParse({ type: "detect", id: 1, bytes: "abc" }).success).toBe(false);
  });

  test("accepts a detected response with a face and one without", () => {
    expect(FaceWorkerResponseSchema.safeParse(detected()).success).toBe(true);
    expect(FaceWorkerResponseSchema.safeParse(detected({ face: null })).success).toBe(true);
  });

  test.each([0, -1, 1.5, Number.NaN])("rejects an image width of %p", (width) => {
    expect(FaceWorkerResponseSchema.safeParse(detected({ width })).success).toBe(false);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects a face box holding %p", (bad) => {
    expect(FaceWorkerResponseSchema.safeParse(detected({ face: { ...face, x: bad } })).success).toBe(false);
  });

  test("rejects a face box of zero or negative size", () => {
    expect(FaceWorkerResponseSchema.safeParse(detected({ face: { ...face, width: 0 } })).success).toBe(false);
    expect(FaceWorkerResponseSchema.safeParse(detected({ face: { ...face, height: -4 } })).success).toBe(false);
  });

  test("rejects a face box with an unknown field", () => {
    expect(FaceWorkerResponseSchema.safeParse(detected({ face: { ...face, score: 0.9 } })).success).toBe(false);
  });
});
