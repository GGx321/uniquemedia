import { describe, expect, test } from "bun:test";
import { impliedNudityOf } from "./avatarOrigin";

// 5a.4 (S5.BA1 round 2, plan s5a4 I5.74, M7): the one fail-closed reading of an avatar's origin. Only `origin === "studio"` allows an implied cover; an absent, an unknown or a
// malformed origin reads as imported. Every site that turns an origin into `TemplateContext.impliedNudity` (S5.BA3, S5.BA8) calls this and nothing else.

describe("impliedNudityOf", () => {
  test("studio allows it", () => {
    expect(impliedNudityOf({ origin: "studio" })).toBe(true);
  });

  test("imported does not", () => {
    expect(impliedNudityOf({ origin: "imported" })).toBe(false);
  });

  test("an avatar listed without an origin does not (fail-closed)", () => {
    expect(impliedNudityOf({})).toBe(false);
    expect(impliedNudityOf({ origin: undefined })).toBe(false);
  });

  test("an avatar that could not be read does not", () => {
    expect(impliedNudityOf(undefined)).toBe(false);
    expect(impliedNudityOf(null)).toBe(false);
  });

  test.each(["Studio", "STUDIO", " studio", "studio ", "created", "", 1, true, null, {}])("an unknown origin of %p does not", (origin) => {
    expect(impliedNudityOf({ origin })).toBe(false);
  });
});
