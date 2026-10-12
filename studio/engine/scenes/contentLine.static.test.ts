import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.9b1 (plan s5a3 §5.3): the word gate has one home. The lists live in shared/scenes/words.ts (the revealing words) and shared/engine/ageText.ts (the
// youth words); the level-aware check is shared/scenes/contentLine.ts; the bold exemption lives in shared/scenes/banks/boldRules.ts. No other production
// module keeps its own copy, and the sites that gate a text call `contentProblems`, so the renderer's mock can never disagree with the engine.

const STUDIO = resolve(import.meta.dir, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
    return [path];
  });
}

/** Production source of the Studio: no tests, no test kits, no `testing/` helper folders. */
const PRODUCTION = walk(STUDIO)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|testkit)\.tsx?$/.test(file) && !/[\\/]testing[\\/]/.test(file))
  .map((file) => ({ path: relative(STUDIO, file).split("\\").join("/"), code: readFileSync(file, "utf8") }));

const filesWith = (pattern: RegExp): string[] => PRODUCTION.filter((f) => pattern.test(f.code)).map((f) => f.path).sort();

describe("the word gate has one home (static)", () => {
  test("the scan reads the production source (it is not vacuous)", () => {
    expect(PRODUCTION.length).toBeGreaterThan(300);
    expect(filesWith(/\bcontentProblems\b/).length).toBeGreaterThan(0);
  });

  test("the patterns catch what they are for (negative control)", () => {
    expect(/bikini\|swimsuit/.test("const X = /\\b(bikini|swimsuit|swimwear)\\b/i;")).toBe(true);
    expect(/bikini\|swimsuit/.test("never name bikini, swimsuit, swimwear")).toBe(false);
  });

  test("the revealing-word alternation is written once, in shared/scenes/words.ts", () => {
    expect(filesWith(/bikini\|swimsuit/)).toEqual(["shared/scenes/words.ts"]);
  });

  test("only the content line, the re-export and the unchanged LLM-path sites name the revealing-word list or its helpers", () => {
    expect(filesWith(/\b(?:REVEALING_WORDS|revealingWordsIn|hasRevealingWord)\b/)).toEqual([
      "engine/scenes/index.ts",
      "engine/scenes/poolGen.ts",
      "engine/scenes/pools.ts",
      "engine/scenes/words.ts",
      "engine/scenes/writer.ts",
      "shared/scenes/contentLine.ts",
      "shared/scenes/words.ts",
    ]);
  });

  test("the sites that gate a text call contentProblems and none calls sentenceProblems", () => {
    for (const site of ["engine/scenes/assembler.ts", "engine/sceneSets/edit.ts", "engine/sceneSets/launchDraw.ts", "engine/sceneSets/toRun.ts", "renderer/engine/mockSceneSets.ts"]) {
      const file = PRODUCTION.find((f) => f.path === site);
      expect(file, site).toBeDefined();
      expect({ site, calls: /\bcontentProblems\(/.test(file?.code ?? "") }).toEqual({ site, calls: true });
    }
    expect(filesWith(/\bsentenceProblems\(/)).toEqual(["engine/scenes/assembler.ts"]);
  });

  test("the sites that gate a text name their level (all four at ordinary until S5.9c)", () => {
    for (const site of ["engine/scenes/assembler.ts", "engine/sceneSets/edit.ts", "engine/sceneSets/launchDraw.ts", "engine/sceneSets/toRun.ts", "renderer/engine/mockSceneSets.ts"]) {
      const code = PRODUCTION.find((f) => f.path === site)?.code ?? "";
      const calls = [...code.matchAll(/\bcontentProblems\(([^;\n]*)/g)].map((m) => m[1] ?? "");
      expect({ site, calls: calls.length > 0, allOrdinary: calls.every((c) => /"ordinary"\)/.test(c)) }).toEqual({ site, calls: true, allOrdinary: true });
    }
  });

  test("the renderer's mock keeps no word list of its own", () => {
    const mock = PRODUCTION.find((f) => f.path === "renderer/engine/mockSceneSets.ts");
    expect(mock?.code).toBeDefined();
    expect(mock?.code).not.toMatch(/REVEALING_WORDS|youthWords|swimsuit/);
  });

  // Review: a renamed list (/\b(thong|bikini|lingerie)\b/) slipped past the name checks above. The mock files hold no revealing or youth vocabulary at all,
  // under any name; the one known hit is a sample vibe in the mock engine's seed data, which no word gate reads.
  const VOCABULARY =
    /\b(?:bikinis?|swimsuits?|swimwear|lingerie|thongs?|bras?|bralettes?|panties|panty|underwear|briefs|topless|naked|stockings?|slip dress(?:es)?|babydolls?|girls?|girlish|teens?|teenage\w*|schoolgirls?|schools?|child\w*|kids?|petite|young\w*|baby|babies|minors?|uniforms?)\b/gi;
  const vocabularyIn = (files: readonly { path: string; code: string }[]): string[] =>
    files.flatMap((f) => [...new Set(Array.from(f.code.matchAll(VOCABULARY), (m) => m[0].toLowerCase()))].map((word) => `${f.path}: ${word}`)).sort();

  test("the vocabulary scan catches a renamed list (negative control)", () => {
    expect(vocabularyIn([{ path: "x.ts", code: "const OUT = /\\b(thong|bikini|lingerie)\\b/i;" }])).toEqual(["x.ts: bikini", "x.ts: lingerie", "x.ts: thong"]);
    expect(vocabularyIn([{ path: "x.ts", code: "const OK = /\\b(zebra|bramble)\\b/i;" }])).toEqual([]);
  });

  test("the renderer's mock files name no revealing or youth word", () => {
    const mocks = PRODUCTION.filter((f) => /^renderer\/engine\/mock[^/]*\.tsx?$/.test(f.path));
    expect(mocks.length).toBeGreaterThan(3);
    expect(vocabularyIn(mocks)).toEqual(["renderer/engine/mockEngine.ts: girl"]);
  });

  test("the bold exemption is named only in boldRules.ts and read only by the content line", () => {
    expect(filesWith(/\bBOLD_EXEMPT_YOUTH\b/)).toEqual(["shared/scenes/banks/boldRules.ts", "shared/scenes/contentLine.ts"]);
    expect(filesWith(/babydoll/i)).toEqual(["shared/scenes/banks/boldRules.ts", "shared/scenes/contentLine.ts"]);
  });
});
