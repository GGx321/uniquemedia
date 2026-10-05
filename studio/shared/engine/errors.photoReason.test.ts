import { describe, expect, test } from "bun:test";
import { EngineError } from "./errors";

// Why a scene photo was refused (`EngineError.photoReason`): the window's text depends on it, so it travels as a closed code, never as free text.

describe("EngineError.photoReason", () => {
  const cell = { code: "photo-unavailable", path: ["photoIds", 0] };

  test.each(["in-video", "held-by-render", "pending-video", "index-stale", "log-needs-repair"])("PHOTO_UNAVAILABLE carries the reason %s", (photoReason) => {
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: [cell], photoReason }).success).toBe(true);
  });

  test("PHOTO_UNAVAILABLE without a reason is still valid: not every refusal has one", () => {
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: [cell] }).success).toBe(true);
  });

  test("a reason outside the closed set is refused", () => {
    expect(EngineError.safeParse({ code: "PHOTO_UNAVAILABLE", issues: [cell], photoReason: "looks-wrong" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "MONTAGE_INVALID", issues: [{ code: "layer-too-short", path: ["layers", 0] }], photoReason: "in-video" }).success).toBe(false);
  });
});
