import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { DEFAULT_RASTER_LIMITS } from "../rasterTypes";
import { boundedMessage, TextWorkerInitSchema, TextWorkerRequestSchema, TextWorkerResponseSchema } from "./protocol";
useNativeGlobals();

const png = (n = 8): ArrayBuffer => new Uint8Array(n).buffer;

describe("TextWorkerInitSchema", () => {
  test("takes exactly the two paths the worker needs", () => {
    expect(TextWorkerInitSchema.safeParse({ wasmPath: "/a/index_bg.wasm", fontDir: "/a/fonts" }).success).toBe(true);
  });

  test("refuses an empty path, a missing one and an unknown key", () => {
    expect(TextWorkerInitSchema.safeParse({ wasmPath: "", fontDir: "/f" }).success).toBe(false);
    expect(TextWorkerInitSchema.safeParse({ wasmPath: "/w" }).success).toBe(false);
    expect(TextWorkerInitSchema.safeParse({ wasmPath: "/w", fontDir: "/f", limits: {} }).success).toBe(false);
  });
});

describe("TextWorkerRequestSchema", () => {
  test("accepts a render and a measure of a known font", () => {
    expect(TextWorkerRequestSchema.safeParse({ type: "render", id: 0, svg: "<svg/>", font: "manrope" }).success).toBe(true);
    expect(TextWorkerRequestSchema.safeParse({ type: "measure", id: 7, svg: "<svg/>", font: "caveat" }).success).toBe(true);
  });

  test("refuses an unknown font, a negative or fractional id and an unknown type", () => {
    expect(TextWorkerRequestSchema.safeParse({ type: "render", id: 0, svg: "x", font: "comic-sans" }).success).toBe(false);
    expect(TextWorkerRequestSchema.safeParse({ type: "render", id: -1, svg: "x", font: "manrope" }).success).toBe(false);
    expect(TextWorkerRequestSchema.safeParse({ type: "render", id: 1.5, svg: "x", font: "manrope" }).success).toBe(false);
    expect(TextWorkerRequestSchema.safeParse({ type: "layout", id: 1, svg: "x", font: "manrope" }).success).toBe(false);
  });

  test("lets an oversized SVG through as data, so the worker answers SVG_TOO_LARGE instead of dying on a parse failure", () => {
    expect(TextWorkerRequestSchema.safeParse({ type: "render", id: 0, svg: "x".repeat(DEFAULT_RASTER_LIMITS.maxSvgBytes + 1), font: "manrope" }).success).toBe(true);
  });

  test("refuses extra keys", () => {
    expect(TextWorkerRequestSchema.safeParse({ type: "render", id: 0, svg: "x", font: "manrope", extra: 1 }).success).toBe(false);
  });
});

describe("TextWorkerResponseSchema", () => {
  test("accepts ready, load-failed, rendered, measured and failed", () => {
    expect(TextWorkerResponseSchema.safeParse({ type: "ready" }).success).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ type: "load-failed", message: "no wasm" }).success).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ type: "rendered", id: 1, width: 10, height: 5, png: png(), workerMs: 1.5 }).success).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ type: "measured", id: 1, box: { x: 0, y: 1, width: 2, height: 3 }, workerMs: 0.2 }).success).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ type: "measured", id: 1, box: null, workerMs: 0.2 }).success).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "RENDER_FAILED", message: "x", fatal: true }).success).toBe(true);
  });

  test("refuses a picture whose canvas is over the pixel cap, or whose PNG is over the byte cap", () => {
    expect(TextWorkerResponseSchema.safeParse({ type: "rendered", id: 1, width: 1080, height: 601, png: png(), workerMs: 1 }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ type: "rendered", id: 1, width: 10, height: 10, png: png(DEFAULT_RASTER_LIMITS.maxOutputBytes + 1), workerMs: 1 }).success).toBe(false);
  });

  test("refuses an empty PNG, a zero-sized canvas and a PNG that is not an ArrayBuffer", () => {
    expect(TextWorkerResponseSchema.safeParse({ type: "rendered", id: 1, width: 10, height: 10, png: png(0), workerMs: 1 }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ type: "rendered", id: 1, width: 0, height: 10, png: png(), workerMs: 1 }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ type: "rendered", id: 1, width: 10, height: 10, png: [1, 2, 3], workerMs: 1 }).success).toBe(false);
  });

  test("refuses a non-finite box, an unknown error code and an over-long message", () => {
    expect(TextWorkerResponseSchema.safeParse({ type: "measured", id: 1, box: { x: Number.NaN, y: 0, width: 1, height: 1 }, workerMs: 0 }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "SOMETHING", message: "x", fatal: false }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "RENDER_FAILED", message: "x".repeat(2001), fatal: false }).success).toBe(false);
  });
});

describe("boundedMessage", () => {
  test("keeps a short message and cuts a long one to the wire bound, marking the cut", () => {
    expect(boundedMessage("short")).toBe("short");
    const cut = boundedMessage("y".repeat(5000));
    expect(cut.length).toBe(2000);
    expect(cut.endsWith("…")).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ type: "load-failed", message: cut }).success).toBe(true);
  });
});
