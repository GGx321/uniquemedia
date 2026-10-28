import { describe, expect, test } from "bun:test";
import { BANKS } from "./index";
import { boldBankProblems, categoryBankProblems } from "./schema";

describe("the shipped banks", () => {
  test("still load: all seven are valid", () => {
    for (const category of ["home", "travel", "photoshoot", "glamour", "fitness"] as const) expect(categoryBankProblems(BANKS[category], category)).toEqual([]);
    expect(boldBankProblems(BANKS.nightwear)).toEqual([]);
    expect(boldBankProblems(BANKS.beach)).toEqual([]);
  });
});
