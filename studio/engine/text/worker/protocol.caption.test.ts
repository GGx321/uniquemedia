import { describe, expect, test } from "bun:test";
import { MAX_CAPTION_UNITS } from "../../../shared/engine/montage";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { DEFAULT_RASTER_LIMITS } from "../rasterTypes";
import { TextWorkerRequestSchema, TextWorkerResponseSchema } from "./protocol";
useNativeGlobals();

const png = (n = 8): ArrayBuffer => new Uint8Array(n).buffer;
const request = { type: "caption", id: 3, value: "sunday reset", font: "manrope", style: "plaque", color: "#ffffff", scale: 1 } as const;
const layout = { fontSize: 56, lines: ["sunday reset"], width: 400, height: 90 };
const captioned = { type: "captioned", id: 3, width: 400, height: 90, png: png(), layout, workerMs: 4.5 } as const;

describe("the caption request", () => {
  test("accepts a layer's fields", () => {
    expect(TextWorkerRequestSchema.safeParse(request).success).toBe(true);
  });

  test("takes the value as data of any length, so an over-long caption is answered CAPTION_INVALID instead of killing the worker on a parse failure", () => {
    expect(TextWorkerRequestSchema.safeParse({ ...request, value: "x".repeat(10_000) }).success).toBe(true);
    expect(TextWorkerRequestSchema.safeParse({ ...request, value: "" }).success).toBe(true);
  });

  test("refuses an unknown font or style", () => {
    expect(TextWorkerRequestSchema.safeParse({ ...request, font: "comic" }).success).toBe(false);
    expect(TextWorkerRequestSchema.safeParse({ ...request, style: "neon" }).success).toBe(false);
  });

  test("refuses a colour that is not lowercase #rrggbb, so nothing else can reach the template", () => {
    for (const color of ["#fff", "#FFFFFF", "red", '#ffffff" onload="x', "", "#ffffff "]) {
      expect(TextWorkerRequestSchema.safeParse({ ...request, color }).success).toBe(false);
    }
  });

  test("refuses a scale outside 0.5 to 2 and one that is not a number", () => {
    for (const scale of [0.49, 2.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      expect(TextWorkerRequestSchema.safeParse({ ...request, scale }).success).toBe(false);
    }
    expect(TextWorkerRequestSchema.safeParse({ ...request, scale: 0.5 }).success).toBe(true);
    expect(TextWorkerRequestSchema.safeParse({ ...request, scale: 2 }).success).toBe(true);
  });

  test("refuses an extra key and a missing one", () => {
    expect(TextWorkerRequestSchema.safeParse({ ...request, svg: "<svg/>" }).success).toBe(false);
    const { color: _color, ...missing } = request;
    expect(TextWorkerRequestSchema.safeParse(missing).success).toBe(false);
  });
});

describe("the captioned response", () => {
  test("accepts a picture with its resolved layout", () => {
    expect(TextWorkerResponseSchema.safeParse(captioned).success).toBe(true);
  });

  test("refuses a canvas over the pixel cap and a PNG over the byte cap", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, width: 1080, height: 601 }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, png: png(DEFAULT_RASTER_LIMITS.maxOutputBytes + 1) }).success).toBe(false);
  });

  test("refuses an empty PNG and a PNG that is not an ArrayBuffer", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, png: png(0) }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, png: [1, 2, 3] }).success).toBe(false);
  });

  test("refuses a layout with a third line, a non-finite size or no lines", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, lines: ["a", "b", "c"] } }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, lines: [] } }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, fontSize: Number.NaN } }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, fontSize: 0 } }).success).toBe(false);
  });

  test("accepts the worst legal caption's layout: 41 kiss emoji are 41 graphemes, 615 UTF-16 units and 410 code points on one line", () => {
    const kiss = "\u{1F469}\u{1F3FD}‍❤️‍\u{1F48B}‍\u{1F468}\u{1F3FB}";
    const line = kiss.repeat(41);
    expect(line.length).toBe(615);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, lines: [line] } }).success).toBe(true);
  });

  test("accepts a line as long as the contract lets a caption be, and refuses one longer", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, lines: ["a".repeat(MAX_CAPTION_UNITS)] } }).success).toBe(true);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, lines: ["a".repeat(MAX_CAPTION_UNITS + 1)] } }).success).toBe(false);
  });

  test("refuses a layout whose box is not the picture's", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, width: 399 } }).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, layout: { ...layout, height: 91 } }).success).toBe(false);
  });

  test("refuses an extra key", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...captioned, svg: "x" }).success).toBe(false);
  });
});

describe("a failed response with a caption rule", () => {
  const failed = { type: "failed", id: 3, code: "CAPTION_INVALID", message: "the caption breaks a rule", fatal: false } as const;

  test("carries the rule with CAPTION_INVALID", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...failed, captionIssue: "charset" }).success).toBe(true);
  });

  test("refuses CAPTION_INVALID without a rule and a rule on any other code, mirroring the contract's TEXT_INVALID", () => {
    expect(TextWorkerResponseSchema.safeParse(failed).success).toBe(false);
    expect(TextWorkerResponseSchema.safeParse({ ...failed, code: "RENDER_FAILED", captionIssue: "charset" }).success).toBe(false);
  });

  test("refuses a rule the contract does not have", () => {
    expect(TextWorkerResponseSchema.safeParse({ ...failed, captionIssue: "rude" }).success).toBe(false);
  });

  test("an ordinary failure still carries no rule", () => {
    expect(TextWorkerResponseSchema.safeParse({ type: "failed", id: 1, code: "RENDER_FAILED", message: "x", fatal: true }).success).toBe(true);
  });
});
