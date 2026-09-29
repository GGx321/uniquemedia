import { describe, expect, test } from "bun:test";
import { STICKER_LIMITS } from "./apng";
import { STICKER_CATEGORIES, STICKER_ID_PATTERN, STICKER_MANIFEST, stickerById } from "./manifest";

describe("the built-in sticker manifest", () => {
  test("holds 8 to 12 stickers (S19)", () => {
    expect(STICKER_MANIFEST.length).toBeGreaterThanOrEqual(8);
    expect(STICKER_MANIFEST.length).toBeLessThanOrEqual(12);
  });
  test("gives every sticker a distinct kebab-case id", () => {
    const ids = STICKER_MANIFEST.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(STICKER_ID_PATTERN);
  });
  test("gives every sticker a distinct non-empty Russian name", () => {
    const names = STICKER_MANIFEST.map((s) => s.nameRu);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[А-Яа-яЁё][А-Яа-яЁё\s-]*$/);
  });
  test("puts every sticker in a declared category", () => {
    const declared = new Set(STICKER_CATEGORIES.map((c) => c.id));
    for (const s of STICKER_MANIFEST) expect(declared.has(s.category)).toBe(true);
  });
  test("declares no category that is empty", () => {
    const used = new Set(STICKER_MANIFEST.map((s) => s.category));
    for (const c of STICKER_CATEGORIES) expect(used.has(c.id)).toBe(true);
  });
  test("gives every category a distinct Russian name", () => {
    const names = STICKER_CATEGORIES.map((c) => c.nameRu);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length).toBeGreaterThan(0);
  });
  test("gives every sticker at least two distinct lower-case tags", () => {
    for (const s of STICKER_MANIFEST) {
      expect(s.tags.length).toBeGreaterThanOrEqual(2);
      expect(new Set(s.tags).size).toBe(s.tags.length);
      for (const t of s.tags) expect(t).toMatch(/^[a-z]+$/);
    }
  });
  test("authors every loop as a whole number of 30 fps frames within the cap, and short (<= 60) to keep the loop cache small", () => {
    for (const s of STICKER_MANIFEST) {
      expect(Number.isInteger(s.loopFrames)).toBe(true);
      expect(s.loopFrames).toBeGreaterThanOrEqual(2);
      expect(s.loopFrames).toBeLessThanOrEqual(60);
      expect(s.loopFrames).toBeLessThanOrEqual(STICKER_LIMITS.maxLoopFrames);
    }
  });
  test("keeps every sticker square, even-sized and within the pixel cap", () => {
    for (const s of STICKER_MANIFEST) {
      expect(s.size % 2).toBe(0);
      expect(s.size).toBeLessThanOrEqual(STICKER_LIMITS.maxSide);
    }
  });
  test("finds a sticker by id and returns nothing for an unknown or inherited one", () => {
    const first = STICKER_MANIFEST[0];
    expect(first && stickerById(first.id)).toBe(first);
    expect(stickerById("nope")).toBeUndefined();
    expect(stickerById("constructor")).toBeUndefined();
    expect(stickerById("__proto__")).toBeUndefined();
  });
});
