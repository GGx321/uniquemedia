import { expect, test } from "bun:test";
import { IMPORT_GOOD_SHORT_SIDE, IMPORT_SMALL_SHORT_SIDE, isSmallImportPhoto } from "./importPhoto";

// The large-screen audit (H2): the import takes a photo of any size, and the owner's master is 246 × 281 — soft in every card and
// a weak reference for every photo run. The import screen advises against a small one; it never refuses it (no new gate).

test("the thresholds: advice under 768 px on the short side, 1024 px recommended", () => {
  expect(IMPORT_SMALL_SHORT_SIDE).toBe(768);
  expect(IMPORT_GOOD_SHORT_SIDE).toBe(1024);
});

test("a photo whose short side is under 768 px is small, whichever side that is", () => {
  expect(isSmallImportPhoto({ width: 246, height: 281 })).toBe(true);
  expect(isSmallImportPhoto({ width: 767, height: 2000 })).toBe(true);
  expect(isSmallImportPhoto({ width: 2000, height: 767 })).toBe(true);
  expect(isSmallImportPhoto({ width: 1, height: 1 })).toBe(true);
});

test("a short side of 768 px or more is not", () => {
  expect(isSmallImportPhoto({ width: 768, height: 768 })).toBe(false);
  expect(isSmallImportPhoto({ width: 768, height: 1024 })).toBe(false);
  expect(isSmallImportPhoto({ width: 1024, height: 1365 })).toBe(false);
  expect(isSmallImportPhoto({ width: 4096, height: 4096 })).toBe(false);
});

test("no advice on a size that is not known: zero, negative or not a finite number", () => {
  expect(isSmallImportPhoto({ width: 0, height: 0 })).toBe(false);
  expect(isSmallImportPhoto({ width: 0, height: 1365 })).toBe(false);
  expect(isSmallImportPhoto({ width: -246, height: 281 })).toBe(false);
  expect(isSmallImportPhoto({ width: Number.NaN, height: 281 })).toBe(false);
  expect(isSmallImportPhoto({ width: 246, height: Number.POSITIVE_INFINITY })).toBe(false);
});
