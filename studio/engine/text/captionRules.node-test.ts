import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { join } from "node:path";
import { graphemeCount, MAX_CAPTION_GRAPHEMES } from "../../shared/engine";
import { captionIssues, type CaptionContext } from "../../shared/text/captionRules";
import { GRAPHEME_CASES } from "./captionRules.boundaries";
import { openEmojiFont } from "./emoji/emojiFont";
import { assertBudget } from "../../testing/tiers";
import { loadEmojiFont } from "./fonts";

// The caption rules under ELECTRON'S NODE, the product's own runtime (the engine is an Electron utilityProcess):
// its ICU decides where `Intl.Segmenter` cuts graphemes, and the 60-character limit, the emoji runs and the line count
// all stand on that. The same boundary table runs under Bun in captionRules.test.ts.
// Bundled and run by studio/scripts/electronNodeTests.ts; named `.node-test.ts` so `bun test` never loads it.

const root = process.env.STUDIO_ROOT;
if (root === undefined || root === "") throw new Error("STUDIO_ROOT is not set: run this through studio/scripts/electronNodeTests.ts");

const VS15 = "\u{FE0E}";
const VS16 = "\u{FE0F}";
const KEYCAP = "\u{20E3}";

let ctx: CaptionContext;
before(async () => {
  const font = openEmojiFont(new Uint8Array(await loadEmojiFont(join(root, "studio", "assets", "fonts"))));
  ctx = { hasEmoji: (codePoints) => font.has(codePoints) };
});

describe("the grapheme count on Electron's ICU", () => {
  for (const { name, text, graphemes } of GRAPHEME_CASES) {
    test(`counts ${name} as ${graphemes}`, () => {
      assert.equal(graphemeCount(text), graphemes);
    });

    test(`puts the 60 / 61 boundary right for ${name}`, () => {
      const filler = "a".repeat(MAX_CAPTION_GRAPHEMES - graphemes);
      assert.equal(captionIssues(`${filler}${text}`, ctx).includes("too-long"), false);
      assert.equal(captionIssues(`${filler}a${text}`, ctx).includes("too-long"), true);
    });
  }
});

describe("the verdicts that depend on the segmenter", () => {
  const verdicts: [string, string, string[]][] = [
    ["a bare (c)", "\u{A9}", ["charset"]],
    ["(c) with VS16", `\u{A9}${VS16}`, ["charset"]],
    ["(tm) with VS16", `\u{2122}${VS16}`, ["charset"]],
    ["(r) with VS15", `\u{AE}${VS15}`, ["charset"]],
    ["a keycap", `#${VS16}${KEYCAP}`, []],
    ["a pictograph without VS16", "\u{2764}", []],
    ["a pictograph with VS15", `\u{2764}${VS15}`, ["emoji-text-style"]],
    ["a flag", "\u{1F1FA}\u{1F1F8}", []],
    ["a lone regional indicator", "\u{1F1FA}", ["emoji-missing"]],
    ["a subdivision flag", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", []],
    ["a black flag with a cancel tag only", "\u{1F3F4}\u{E007F}", ["emoji-missing"]],
    ["a skin tone", "\u{1F44D}\u{1F3FD}", []],
    ["a ZWJ profession", "\u{1F469}\u{200D}\u{1F4BB}", []],
    ["a ZWJ in text", "a\u{200D}b", ["charset"]],
    ["a combining mark on a letter", "e\u{301}", ["charset"]],
    ["three lines", "a\nb\nc", ["too-many-lines"]],
    ["two CRLF lines", "a\r\nb", []],
  ];
  for (const [name, text, expected] of verdicts) {
    test(`gives ${JSON.stringify(expected)} for ${name}`, () => {
      assert.deepEqual(captionIssues(text, ctx), expected);
    });
  }
});

describe("the worst inputs on Electron's Node", () => {
  const fill = (unit: string, n = 1024): string => unit.repeat(Math.floor(n / unit.length));
  const worst: [string, string][] = [
    ["1 then spaces", `1${" ".repeat(1023)}`],
    ["1 then newlines", `1${"\n".repeat(1023)}`],
    ["1 then no-break spaces", `1${"\u{A0}".repeat(1023)}`],
    ["words", "coffee ".repeat(150)],
    ["ellipses", fill("\u{2026}")],
    ["emoji", fill("\u{1F600}")],
    ["regional indicators", fill("\u{1F1FA}")],
    ["combining marks", `a${"\u{301}".repeat(1023)}`],
    ["a ZWJ chain", `${"\u{1F469}\u{200D}".repeat(500)}x`],
  ];
  for (const [name, text] of worst) {
    // Tagged for the perf run, which holds it to 250 ms; every other run still bounds it (generously) against catastrophic backtracking.
    test(`[perf] stays under 250 ms: ${name}`, () => {
      const started = performance.now();
      captionIssues(text, ctx);
      const ms = performance.now() - started;
      console.log(`caption worst-case ${name}: ${ms.toFixed(1)} ms`);
      assertBudget(ms, 250, `caption worst-case ${name}`);
    });
  }
});
