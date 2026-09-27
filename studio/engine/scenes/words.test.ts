import { describe, expect, test } from "bun:test";
import { hasRevealingWord, revealingWordsIn, REVEALING_WORDS } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Review round 1 (MEDIUM): the revealing-word guard was duplicated in
// pools.ts and writer.ts. This is the one place it now lives; pools.ts,
// writer.ts and assembler.ts all import it from here.

describe("REVEALING_WORDS / hasRevealingWord", () => {
  test.each([
    ["a bikini", true],
    ["a swimsuit", true],
    ["swimwear", true],
    ["a lace lingerie set", true],
    ["a sports bra and shorts", true],
    ["a thong", true],
    ["stockings", true],
    ["thigh-high stockings", true],
    ["a satin slip dress", true],
    ["a short silk robe over lingerie", true],
    ["a tailored black blazer", false],
    ["a cozy hoodie", false],
  ])("%j -> %p", (text, expected) => {
    expect(REVEALING_WORDS.test(text)).toBe(expected);
    expect(hasRevealingWord(text)).toBe(expected);
  });

  test("is safe to call .test() repeatedly (non-global: no shared lastIndex state)", () => {
    expect(REVEALING_WORDS.test("a bikini")).toBe(true);
    expect(REVEALING_WORDS.test("a bikini")).toBe(true);
    expect(REVEALING_WORDS.test("a plain dress")).toBe(false);
    expect(REVEALING_WORDS.test("a bikini")).toBe(true);
  });
});

describe("revealingWordsIn", () => {
  test.each([
    ["she wears a bikini at the pool", ["bikini"]],
    ["a lace lingerie set and heels", ["lingerie"]],
    ["a sports bra and running shorts", ["sports bra"]],
    ["an oversized cream sweater", []],
  ])("%j -> %p", (text, expected) => {
    expect(revealingWordsIn(text).map((w) => w.toLowerCase())).toEqual(expected);
  });

  test("is safe to call repeatedly with different inputs (no shared state across calls)", () => {
    expect(revealingWordsIn("a bikini")).toEqual(["bikini"]);
    expect(revealingWordsIn("a plain dress")).toEqual([]);
    expect(revealingWordsIn("a bikini and stockings")).toEqual(["bikini", "stockings"]);
  });
});
