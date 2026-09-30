import { describe, expect, test } from "bun:test";
import { RASTER_ERROR_CODES, RasterError } from "./rasterTypes";

describe("RasterError", () => {
  test("names a caption rule when it is built with one", () => {
    const error = new RasterError("CAPTION_INVALID", "the caption breaks a rule", { captionIssue: "too-long" });
    expect(error.code).toBe("CAPTION_INVALID");
    expect(error.captionIssue).toBe("too-long");
  });

  test("carries no caption rule otherwise", () => {
    expect(new RasterError("RENDER_FAILED", "resvg refused it").captionIssue).toBeUndefined();
  });

  test("keeps the cause it is given next to the caption rule", () => {
    const cause = new Error("underlying");
    const error = new RasterError("CAPTION_INVALID", "x", { cause, captionIssue: "charset" });
    expect(error.cause).toBe(cause);
    expect(error.captionIssue).toBe("charset");
  });

  test("is refused for a caption rule on any other code, so a rule never rides on a render failure", () => {
    expect(() => new RasterError("RENDER_FAILED", "x", { captionIssue: "charset" })).toThrow(TypeError);
  });

  test("is refused for CAPTION_INVALID without a rule, so the contract's TEXT_INVALID always has one", () => {
    expect(() => new RasterError("CAPTION_INVALID", "x")).toThrow(TypeError);
  });

  test("lists CAPTION_INVALID among the codes that may cross the worker wire", () => {
    expect(RASTER_ERROR_CODES).toContain("CAPTION_INVALID");
  });
});
