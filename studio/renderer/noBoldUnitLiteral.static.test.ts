import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// 5a.4 (S5.BA8a, plan s5a4 §8 BA8, r2.3 M1): the renderer computes no money. A «Смелая» photo's worst case (279 000 µ$ with the age check off, 294 750 µ$ with it on) is the engine's
// `unitPricesOf(…, bold = true).photoWorstMicros`; the month line used to hard-code the first and was wrong with the check on. No module of the renderer (the mock and the tests included)
// holds either figure, in any of the ways a number is written: 279000, 279_000, 279 000 (any space), 279,000, 279.000.

const RENDERER = join(import.meta.dir);
const SELF = "noBoldUnitLiteral.static.test.ts";
const SEPARATOR = "[ _,.\\u00A0\\u202F\\u2009]?";
const UNIT_LITERAL = new RegExp(`(?<![\\d])(?:279${SEPARATOR}000|294${SEPARATOR}750)(?![\\d])`, "g");

/** The bold unit's figures `source` holds. */
export function boldUnitLiterals(source: string): string[] {
  return Array.from(source.matchAll(UNIT_LITERAL), (match) => match[0]);
}

describe("the detector", () => {
  test.each(["279000", "279_000", "279 000", "279 000", "279,000", "279.000", "294750", "294_750", "294 750", "const unit = 3 * 93_000 + 279_000;"])("sees %j", (text) => {
    expect(boldUnitLiterals(text)).not.toEqual([]);
  });

  test.each(["2790000", "1279000", "93_000", "98_250", "294751", "279001", "0.279", "$0.28"])("passes %j", (text) => {
    expect(boldUnitLiterals(text)).toEqual([]);
  });
});

describe("the renderer", () => {
  test("no module holds 279 000 or 294 750", async () => {
    const files = Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: RENDERER }))
      .map((f) => f.replaceAll("\\", "/"))
      .filter((f) => f !== SELF)
      .sort();
    expect(files.length).toBeGreaterThan(100);
    const holding = (await Promise.all(files.map(async (file) => ({ file, found: boldUnitLiterals(await Bun.file(join(RENDERER, file)).text()) })))).filter(({ found }) => found.length > 0);
    expect(holding).toEqual([]);
  });
});
