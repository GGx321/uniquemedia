import { describe, expect, test } from "bun:test";
import { BANKS } from "./index";
import { boldBankProblems, categoryBankProblems } from "./schema";
import type { CategoryBank } from "./types";

// 5a.4 (S5.BA2, plan s5a4 §5.2, §5.5, r2.1 N3; the S5.BA1 hand-off): the «Смелая» bank schema carries the three fields S5.BA1 put on the bank types: a place's `water`, and an item's
// `tier: "implied"` and `openCoverage`. The five's schema keeps refusing them: only a «Смелая» bank holds them.

const BEACH = BANKS.beach;
const NIGHTWEAR = BANKS.nightwear;

const firstPlace = (bank: CategoryBank) => {
  const place = bank.places[0];
  if (place === undefined) throw new Error("a bank with no place");
  return place;
};

function withPlace(bank: CategoryBank, extra: Record<string, unknown>): unknown {
  return { ...bank, places: [{ ...firstPlace(bank), ...extra }, ...bank.places.slice(1)] };
}

function withFirstMoment(bank: CategoryBank, extra: Record<string, unknown>): unknown {
  const place = firstPlace(bank);
  return { ...bank, places: [{ ...place, moments: place.moments.map((m, i) => (i === 0 ? { ...m, ...extra } : m)) }, ...bank.places.slice(1)] };
}

function withOutfit(bank: CategoryBank, text: string, extra: Record<string, unknown>): unknown {
  return { ...bank, outfits: bank.outfits.map((o) => (o.text === text ? { ...o, ...extra } : o)) };
}

const unrecognized = (problems: readonly string[]): string[] => problems.filter((p) => p.includes("Unrecognized key"));

describe("the «Смелая» schema accepts the 5a.4 fields", () => {
  test("a place may carry water: true", () => {
    expect(unrecognized(boldBankProblems(withPlace(BEACH, { water: true })))).toEqual([]);
  });

  test("a moment may carry tier implied and an open coverage", () => {
    expect(unrecognized(boldBankProblems(withFirstMoment(NIGHTWEAR, { tier: "implied", openCoverage: "The white sheet is pulled up to her chest." })))).toEqual([]);
  });

  test("an outfit may carry tier implied and an open coverage", () => {
    expect(unrecognized(boldBankProblems(withOutfit(NIGHTWEAR, "only the white bedsheet", { tier: "implied", openCoverage: "The white sheet is pulled up to her chest." })))).toEqual([]);
    expect(unrecognized(boldBankProblems(withOutfit(BEACH, "a black bikini", { openCoverage: "Her bikini is black." })))).toEqual([]);
  });

  test("the shapes stay strict: water is true or absent, the tier is implied or absent, an open coverage is a string", () => {
    expect(boldBankProblems(withPlace(BEACH, { water: false })).join("\n")).toMatch(/\[shape\]/);
    expect(boldBankProblems(withFirstMoment(NIGHTWEAR, { tier: "nude" })).join("\n")).toMatch(/\[shape\]/);
    expect(boldBankProblems(withOutfit(BEACH, "a black bikini", { tier: "nude" })).join("\n")).toMatch(/\[shape\]/);
    expect(boldBankProblems(withOutfit(BEACH, "a black bikini", { openCoverage: 3 })).join("\n")).toMatch(/\[shape\]/);
  });
});

describe("the five's schema keeps refusing them", () => {
  const home = BANKS.home;
  test.each<[string, unknown]>([
    ["water on a place", withPlace(home, { water: true })],
    ["tier on a moment", withFirstMoment(home, { tier: "implied" })],
    ["an open coverage on a moment", withFirstMoment(home, { openCoverage: "Her tee covers her." })],
  ])("%s", (_name, bank) => {
    expect(categoryBankProblems(bank, "home").join("\n")).toMatch(/\[shape\].*Unrecognized key/);
  });
});
