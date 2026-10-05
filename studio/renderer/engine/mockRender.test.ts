import { describe, expect, test } from "bun:test";
import { mockRelPath } from "./mockRender";

// The mock numbers export files like the engine's name claim (`engine/videos/exportNumbers.ts`): above the highest number a record still names, and on a
// case-insensitive root a name in another letter case is the same name.

describe("mockRelPath", () => {
  test("starts above the highest number a record names, whatever became of its file", () => {
    expect(mockRelPath("Mia", "2026-10-05", "photo", new Set(), ["Mia/2026-10-05_photo_002.mp4"])).toBe("Mia/2026-10-05_photo_003.mp4");
  });

  test("takes the first number above that no file holds", () => {
    expect(mockRelPath("Mia", "2026-10-05", "photo", new Set(["Mia/2026-10-05_photo_003.mp4"]), ["Mia/2026-10-05_photo_002.mp4"])).toBe("Mia/2026-10-05_photo_004.mp4");
  });

  test("another day, kind or folder does not move the counter", () => {
    expect(mockRelPath("Mia", "2026-10-05", "photo", new Set(), ["Mia/2026-10-04_photo_009.mp4", "Mia/2026-10-05_mix_009.mp4", "Zoe/2026-10-05_photo_009.mp4"])).toBe("Mia/2026-10-05_photo_001.mp4");
  });

  test("a name in another letter case counts only on a case-insensitive root", () => {
    const named = ["mia/2026-10-05_PHOTO_005.mp4"];

    expect(mockRelPath("Mia", "2026-10-05", "photo", new Set(), named, true)).toBe("Mia/2026-10-05_photo_006.mp4");
    expect(mockRelPath("Mia", "2026-10-05", "photo", new Set(), named, false)).toBe("Mia/2026-10-05_photo_001.mp4");
  });
});
