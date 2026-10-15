import { describe, expect, test } from "bun:test";
import { dragKey, parseDragKey } from "./mine";

// 5b.2 part A (S5.WA4; mockup 57a `#drop`): a clip dragged out of the «Клипы» tab travels to «Кадры» by its key, as a scene photo or an own file does. Its
// copy is made (or found) when it is let go; a clip never goes into a collage cell, so only «Кадры» takes it.

describe("a clip's drag key", () => {
  test("`clip:<id>` both ways", () => {
    expect(dragKey({ source: "clip", clipId: "clip-0000004" })).toBe("clip:clip-0000004");
    expect(parseDragKey("clip:clip-0000004")).toEqual({ source: "clip", clipId: "clip-0000004" });
  });

  test("a key that is not one is nothing", () => {
    expect(parseDragKey("clip:")).toBeNull();
    expect(parseDragKey("clip:clip-0000004:9")).toBeNull();
    expect(parseDragKey("clip:../x")).toBeNull();
  });
});
