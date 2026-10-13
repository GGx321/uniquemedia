import { describe, expect, test } from "bun:test";
import type { Level } from "./banks/types";
import { atOrBelow } from "./level";
import { momentAllowed, type MomentTags } from "./render";

// 5a.3 (S5.9b2, plan s5a3 §6.4 and I5.37): the bank shapes rank their levels, ordinary < flirty < bold. A moment is drawn on a slot of its own level or above, never
// below: a «Смелая» moment never lands on an ordinary or flirty slot, and a flirty moment stays off an ordinary one as it always did.

const LEVELS: readonly Level[] = ["ordinary", "flirty", "bold"];
const moment = (level?: "flirty" | "bold"): MomentTags => ({ captures: ["timer"], twoHanded: false, ...(level === undefined ? {} : { level }) });

describe("the levels are ranked", () => {
  test.each<[Level | undefined, Level, boolean]>([
    [undefined, "ordinary", true],
    [undefined, "flirty", true],
    [undefined, "bold", true],
    ["flirty", "ordinary", false],
    ["flirty", "flirty", true],
    ["flirty", "bold", true],
    ["bold", "ordinary", false],
    ["bold", "flirty", false],
    ["bold", "bold", true],
  ])("an item at %s is drawn on a %s slot: %s", (item, slot, allowed) => {
    expect(atOrBelow(item, slot)).toBe(allowed);
  });
});

describe("momentAllowed reads the rank", () => {
  test("an ordinary moment fits a slot of every level", () => {
    for (const level of LEVELS) expect(momentAllowed(moment(), "timer", "front", level)).toBe(true);
  });

  test("a flirty moment fits a flirty or a bold slot, never an ordinary one", () => {
    expect(LEVELS.map((level) => momentAllowed(moment("flirty"), "timer", "front", level))).toEqual([false, true, true]);
  });

  test("a bold moment fits a bold slot only", () => {
    expect(LEVELS.map((level) => momentAllowed(moment("bold"), "timer", "front", level))).toEqual([false, false, true]);
  });

  test("the level is one rule among the others: a bold moment on a bold slot still needs its capture", () => {
    expect(momentAllowed(moment("bold"), "friend", "front", "bold")).toBe(false);
  });
});
