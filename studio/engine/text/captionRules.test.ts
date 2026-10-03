import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CAPTION_ISSUES, MAX_CAPTION_GRAPHEMES, MAX_CAPTION_UNITS, type CaptionIssue } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { type CaptionContext, captionIssue, captionIssues, TEXT_ALLOWED } from "../../shared/text/captionRules";
import { GRAPHEME_CASES } from "./captionRules.boundaries";
import { type EmojiFont, openEmojiFont } from "./emoji/emojiFont";
import { loadPinnedEmojiFont } from "./emoji/emojiFont.testkit";
import { loadTextFonts, TEXT_FONT_KEYS } from "./fonts";
import { cmapCoverage } from "./sfnt";
useNativeGlobals();

// Written with escapes: an invisible character (ZWJ, VS15, VS16, a tag) must never depend on the editor.
const ZWJ = "\u{200D}";
const VS15 = "\u{FE0E}";
const VS16 = "\u{FE0F}";
const KEYCAP = "\u{20E3}";
const CANCEL_TAG = "\u{E007F}";
const tag = (letters: string): string => Array.from(letters, (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
const ENGLAND = `\u{1F3F4}${tag("gbeng")}${CANCEL_TAG}`;

let font: EmojiFont;
beforeAll(async () => {
  font = openEmojiFont(await loadPinnedEmojiFont());
});

/** The real emoji font's `has`, as the engine wires it. */
const ctx = (): CaptionContext => ({ hasEmoji: (codePoints) => font.has(codePoints) });
const issues = (text: string): CaptionIssue[] => captionIssues(text, ctx());

describe("a caption that passes", () => {
  test.each([
    "Good morning",
    "Coffee first, then the world.",
    "It's 5am and I'm up",
    "“Quotes” and ‘quotes’ – with dashes — and an ellipsis…",
    "Two lines\nof text",
    "CRLF lines\r\nare fine too",
    "Hello \u{1F44B}",
    "Top 10 spots",
    `${ENGLAND} match day`,
    `Team \u{1F1FA}\u{1F1F8} \u{1F1EC}\u{1F1E7}`,
    "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB} at work",
    "\u{2764} \u{2714} \u{2708} \u{2600} \u{203C} \u{27A1} \u{261D}",
    `#${VS16}${KEYCAP} 1${VS16}${KEYCAP} *${VS16}${KEYCAP}`,
  ])("has no issue: %p", (text) => {
    expect(issues(text)).toEqual([]);
  });

  test("printable ASCII, all of it", () => {
    const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
    expect(issues(ascii.slice(0, 60))).toEqual([]);
    expect(issues(ascii.slice(60))).toEqual([]);
  });
});

describe("charset", () => {
  test.each([
    ["an accented letter", "caf\u{E9}"],
    ["Cyrillic", "Привет"],
    ["Greek", "\u{3B1}\u{3B2}"],
    ["a tab", "a\tb"],
    ["U+0001", "a\u{1}b"],
    ["NUL", "a\u{0}b"],
    ["DEL", "a\u{7F}b"],
    ["a C1 control", "a\u{85}b"],
    ["a lone CR", "a\rb"],
    ["a line separator", "a\u{2028}b"],
    ["a paragraph separator", "a\u{2029}b"],
    ["a no-break space", "a\u{A0}b"],
    ["a zero-width space", "a\u{200B}b"],
    ["a bidi override", "a\u{202E}b"],
    ["a BOM", "\u{FEFF}a"],
    ["a lone surrogate", "a\u{D800}b"],
    ["an euro sign", "\u{20AC}5"],
    ["a fullwidth letter", "\u{FF21}"],
    ["an Arabic-Indic digit", "\u{661}"],
    ["a combining mark on a letter", "e\u{301}"],
    ["a private-use character", "a\u{E000}b"],
  ])("refuses %s", (_name, text) => {
    expect(issues(text)).toContain("charset");
  });

  test.each([
    ["ZWJ between letters", `te${ZWJ}en`],
    ["ZWNJ between letters", "te\u{200C}en"],
    ["VS16 after a letter", `a${VS16}b`],
    ["VS15 after a letter", `a${VS15}b`],
    ["VS16 after a digit without a keycap", `1${VS16}`],
    ["U+20E3 after a letter", `a${KEYCAP}`],
    ["a ZWJ before a skin tone modifier after a letter", `a${ZWJ}\u{1F3FD}`],
    ["a tag character in text", `a${tag("g")}b`],
    ["a cancel tag in text", `a${CANCEL_TAG}`],
  ])("refuses %s inside a text run", (_name, text) => {
    expect(issues(text)).toContain("charset");
  });

  test.each(["\u{2605}", "\u{2606}", "\u{2605}\u{2605}\u{2605}", "5 \u{2606} rating"])("refuses %p: not an emoji, and no text font draws it", (text) => {
    expect(issues(text)).toEqual(["charset"]);
  });

  test("the five text fonts have neither \u{2605} nor \u{2606}, so refusing them is what stops tofu", async () => {
    const fonts = await loadTextFonts(join(import.meta.dir, "..", "..", "assets", "fonts"));
    for (const key of TEXT_FONT_KEYS) {
      const has = cmapCoverage(fonts[key]);
      expect([key, has(0x2605), has(0x2606)]).toEqual([key, false, false]);
    }
  });

  test("every character the charset accepts, found by asking it about all of Unicode, is in all five text fonts", async () => {
    const fonts = await loadTextFonts(join(import.meta.dir, "..", "..", "assets", "fonts"));
    const accepted: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (TEXT_ALLOWED.test(String.fromCodePoint(cp))) accepted.push(cp);
    }
    // 95 printable ASCII, 7 typographic marks and the line feed, which is a break and has no glyph.
    expect(accepted).toHaveLength(95 + 7 + 1);
    const drawn = accepted.filter((cp) => cp !== 0x0a);
    const missing = TEXT_FONT_KEYS.flatMap((key) => {
      const has = cmapCoverage(fonts[key]);
      return drawn.filter((cp) => !has(cp)).map((cp) => `${key}:U+${cp.toString(16)}`);
    });
    expect(missing).toEqual([]);
  });

  test("a line feed and a CRLF are the only line breaks", () => {
    expect([issues("a\nb"), issues("a\r\nb")]).toEqual([[], []]);
  });
});

describe("(c) (r) and (tm) are refused in every form", () => {
  const SIGNS: [string, string][] = [
    ["\u{A9}", "copyright"],
    ["\u{AE}", "registered"],
    ["\u{2122}", "trade mark"],
  ];

  describe.each(SIGNS)("%s (%s)", (sign) => {
    test("bare", () => {
      expect(issues(sign)).toEqual(["charset"]);
    });

    test("with VS16 (the emoji presentation): the segmenter makes it an emoji run, and it is still refused", () => {
      expect(issues(`${sign}${VS16}`)).toEqual(["charset"]);
    });

    test("with VS15: refused as the sign, not as a text-style emoji", () => {
      expect(issues(`${sign}${VS15}`)).toEqual(["charset"]);
    });

    test("inside a word", () => {
      expect(issues(`Brand${sign} shoes`)).toEqual(["charset"]);
    });

    test("at the start and the end of the caption", () => {
      expect([issues(`${sign}2026`), issues(`all rights${sign}`)]).toEqual([["charset"], ["charset"]]);
    });

    test("next to an emoji", () => {
      expect(issues(`\u{1F600}${sign}${VS16}\u{1F600}`)).toEqual(["charset"]);
    });

    test("inside a ZWJ sequence", () => {
      expect(issues(`\u{1F469}${ZWJ}${sign}${VS16}`)).toEqual(["charset"]);
    });

    test("with a skin tone or a keycap mark after it", () => {
      expect([issues(`${sign}\u{1F3FD}`), issues(`${sign}${KEYCAP}`)]).toEqual([["charset"], ["charset"]]);
    });
  });

  test("the segmenter really does make the VS16 forms emoji runs the font covers (the case this rule exists for)", () => {
    expect(font.has(`\u{A9}${VS16}`)).toBe(true);
  });

  test("all three at once are one issue", () => {
    expect(issues("\u{A9}\u{AE}\u{2122}")).toEqual(["charset"]);
  });
});

describe("emoji the font cannot draw", () => {
  test.each([
    ["an emoji with a combining mark", "\u{1F600}\u{301}"],
    ["an emoji with a ZWNJ", "\u{1F600}\u{200C}"],
    ["a lone regional indicator", "\u{1F1FA}"],
    ["a lone regional indicator between words", "go \u{1F1FA} go"],
    ["a third regional indicator after a flag", "\u{1F1FA}\u{1F1F8}\u{1F1FA}"],
    ["a subdivision flag that does not exist", `\u{1F3F4}${tag("gbxyz")}${CANCEL_TAG}`],
    ["the black flag with only the cancel tag (it draws a white flag with a question mark)", `\u{1F3F4}${CANCEL_TAG}`],
    ["the black flag with tags and no cancel tag", `\u{1F3F4}${tag("gbeng")}`],
    ["a cancel tag after another pictograph", `\u{1F600}${CANCEL_TAG}`],
    ["a tag sequence on a non-flag base", `\u{1F600}${tag("gb")}${CANCEL_TAG}`],
    ["a ZWJ with nothing to join", `\u{1F600}${ZWJ}`],
    ["an invented ZWJ sequence", `\u{1F600}${ZWJ}\u{1F600}`],
  ])("refuses %s", (_name, text) => {
    expect(issues(text)).toEqual(["emoji-missing"]);
  });

  test("asks the font about the emoji cluster's code points, and about nothing else", () => {
    const asked: number[][] = [];
    captionIssues("a \u{1F600} b", { hasEmoji: (cps) => (asked.push([...cps]), true) });
    expect(asked).toEqual([[0x1f600]]);
  });

  test("never asks the font about text, so has('#') being true cannot let anything through", () => {
    const asked: number[][] = [];
    captionIssues("# 1 * 0", { hasEmoji: (cps) => (asked.push([...cps]), true) });
    expect(asked).toEqual([]);
  });

  test("a font that lacks the emoji refuses it", () => {
    expect(captionIssues("\u{1F600}", { hasEmoji: () => false })).toEqual(["emoji-missing"]);
  });

  test("a font that has it lets the same emoji through", () => {
    expect(captionIssues("\u{1F600}", { hasEmoji: () => true })).toEqual([]);
  });

  test("asks about every emoji, and names one issue however many are missing", () => {
    expect(captionIssues("\u{1F600}\u{1F601}\u{1F602}", { hasEmoji: () => false })).toEqual(["emoji-missing"]);
  });

  test("a flag that the font has passes", () => {
    expect(issues("\u{1F1FA}\u{1F1F8}")).toEqual([]);
  });

  test("a subdivision flag that the font has passes", () => {
    expect(issues(ENGLAND)).toEqual([]);
  });
});

describe("text-style pictographs", () => {
  test.each(["\u{2764}", "\u{2714}", "\u{2708}", "\u{2600}", "\u{2744}", "\u{27A1}", "\u{270C}", "\u{261D}", "\u{203C}"])("%p without VS16 is an emoji, and the font has it", (text) => {
    expect(issues(text)).toEqual([]);
  });

  test.each(["\u{2764}", "\u{2714}", "\u{2708}"])("%p is an emoji, so a font without it refuses it as missing, not as text", (text) => {
    expect(captionIssues(text, { hasEmoji: () => false })).toEqual(["emoji-missing"]);
  });

  test.each(["\u{2764}", "\u{2714}", "\u{2708}"])("%p with VS16 passes", (text) => {
    expect(issues(`${text}${VS16}`)).toEqual([]);
  });
});

describe("emoji-text-style (VS15)", () => {
  test.each(["\u{2764}", "\u{1F600}", "\u{2714}", "\u{1F44D}", "\u{261D}"])("refuses %p with VS15", (base) => {
    expect(issues(`${base}${VS15}`)).toEqual(["emoji-text-style"]);
  });

  test("refuses VS15 inside a sequence", () => {
    expect(issues(`\u{1F469}${VS15}${ZWJ}\u{1F4BB}`)).toEqual(["emoji-text-style"]);
  });

  test("refuses it whether or not the font would answer for the cluster", () => {
    expect(captionIssues(`\u{2764}${VS15}`, { hasEmoji: () => true })).toEqual(["emoji-text-style"]);
  });

  test("the reader really has no bitmap for it (the reason for the refusal)", () => {
    expect([font.has(`\u{2764}${VS15}`), font.has(`\u{1F600}${VS15}`)]).toEqual([false, false]);
  });

  test("a VS15 after a letter is a charset problem, not a text-style one", () => {
    expect(issues(`a${VS15}`)).toEqual(["charset"]);
  });

  test("the same emoji with VS16 is fine", () => {
    expect(issues(`\u{2764}${VS16}`)).toEqual([]);
  });
});

describe("keycaps", () => {
  test.each([`#${VS16}${KEYCAP}`, `*${VS16}${KEYCAP}`, `0${VS16}${KEYCAP}`, `9${VS16}${KEYCAP}`, `#${KEYCAP}`, `1${KEYCAP}`])("%p is an emoji run the font has: the ASCII in it is not a charset problem", (text) => {
    expect(issues(text)).toEqual([]);
  });

  test("a bare # * or digit is plain text", () => {
    expect(issues("#tbt * 5")).toEqual([]);
  });

  test("a keycap missing its base (VS16 and U+20E3 alone) is refused", () => {
    expect(issues(`${VS16}${KEYCAP}`)).toContain("charset");
  });

  test("digit keycaps in a row are each an emoji run the font has", () => {
    expect(issues(`1${VS16}${KEYCAP}8${VS16}${KEYCAP}+`)).toEqual([]);
  });
});

describe("too-long: 60 characters as a person counts them", () => {
  const couple = `\u{1F469}${ZWJ}\u{2764}${VS16}${ZWJ}\u{1F468}`;
  const cases: [string, (n: number) => string][] = [
    ["ASCII letters", (n) => "a".repeat(n)],
    ["emoji", (n) => "\u{1F44D}".repeat(n)],
    ["ZWJ sequences of five code points", (n) => `\u{1F469}${ZWJ}\u{1F4BB}`.repeat(n)],
    ["ZWJ couples of six code points", (n) => couple.repeat(n)],
    ["flags of two code points", (n) => "\u{1F1FA}\u{1F1F8}".repeat(n)],
    ["keycaps of three code points", (n) => `1${VS16}${KEYCAP}`.repeat(n)],
    ["skin tones of two code points", (n) => "\u{1F44D}\u{1F3FD}".repeat(n)],
    ["subdivision flags of seven code points", (n) => ENGLAND.repeat(n)],
  ];

  describe.each(cases)("%s", (_name, make) => {
    test("59 pass", () => {
      expect(issues(make(MAX_CAPTION_GRAPHEMES - 1))).toEqual([]);
    });

    test("60 pass", () => {
      expect(issues(make(MAX_CAPTION_GRAPHEMES))).toEqual([]);
    });

    test("61 are too long", () => {
      expect(issues(make(MAX_CAPTION_GRAPHEMES + 1))).toEqual(["too-long"]);
    });
  });

  test("combining marks do not add characters: 60 letters with marks are 60 (and a charset problem)", () => {
    expect(issues("e\u{301}".repeat(60))).toEqual(["charset"]);
  });

  test("61 letters with combining marks are too long as well", () => {
    expect(issues("e\u{301}".repeat(61))).toEqual(["charset", "too-long"]);
  });

  test("text and emoji mixed are counted together", () => {
    expect(issues(`${"a".repeat(30)}${"\u{1F44D}".repeat(30)}`)).toEqual([]);
    expect(issues(`${"a".repeat(30)}${"\u{1F44D}".repeat(31)}`)).toEqual(["too-long"]);
  });

  test("a line break is a character: 30 + LF + 29 fit, 30 + LF + 30 do not", () => {
    expect(issues(`${"a".repeat(30)}\n${"b".repeat(29)}`)).toEqual([]);
    expect(issues(`${"a".repeat(30)}\n${"b".repeat(30)}`)).toEqual(["too-long"]);
  });

  test("a CRLF is one character, not two: 30 + CRLF + 29 fit", () => {
    expect(issues(`${"a".repeat(30)}\r\n${"b".repeat(29)}`)).toEqual([]);
  });

  test("spaces count", () => {
    expect(issues(" ".repeat(61))).toEqual(["too-long"]);
  });

  test.each([...GRAPHEME_CASES])("counts $name as $graphemes", ({ text, graphemes }) => {
    const filler = "a".repeat(MAX_CAPTION_GRAPHEMES - graphemes);
    expect(issues(`${filler}${text}`).includes("too-long")).toBe(false);
    expect(issues(`${filler}a${text}`).includes("too-long")).toBe(true);
  });

  test("the UTF-16 bound comes first: over it, nothing else is read", () => {
    expect(issues(`\u{A9}${"a".repeat(MAX_CAPTION_UNITS)}`)).toEqual(["too-long"]);
  });

  test("at exactly the UTF-16 bound the grapheme count decides", () => {
    expect(issues("a".repeat(MAX_CAPTION_UNITS))).toEqual(["too-long"]);
  });

  test("the longest legal caption in code units, sixty of the longest sequences, is not refused for its length", () => {
    const kiss = "\u{1F469}\u{1F3FD}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F48B}\u{200D}\u{1F468}\u{1F3FB}";
    expect(issues(kiss.repeat(60)).includes("too-long")).toBe(false);
  });
});

describe("too-many-lines: a line is what an explicit newline ends", () => {
  test.each([
    ["one line", "a", []],
    ["two lines with LF", "a\nb", []],
    ["two lines with CRLF", "a\r\nb", []],
    ["a trailing LF makes a second, empty line", "a\n", []],
    ["a leading LF makes a first, empty line", "\na", []],
    ["three lines with LF", "a\nb\nc", ["too-many-lines"]],
    ["three lines with CRLF", "a\r\nb\r\nc", ["too-many-lines"]],
    ["three lines with mixed breaks", "a\r\nb\nc", ["too-many-lines"]],
    ["a blank line in the middle is a line", "a\n\nb", ["too-many-lines"]],
    ["two trailing LFs are two more lines", "a\n\n", ["too-many-lines"]],
    ["a lone CR is no break (and is a charset problem)", "a\rb\rc", ["charset"]],
  ] as const)("%s", (_name, text, expected) => {
    expect(issues(text)).toEqual([...expected]);
  });

  test("the same text with LF and CRLF has the same verdict", () => {
    const lines = ["one", "two", "three"];
    expect([issues(lines.slice(0, 2).join("\n")), issues(lines.slice(0, 2).join("\r\n")), issues(lines.join("\n")), issues(lines.join("\r\n"))]).toEqual([[], [], ["too-many-lines"], ["too-many-lines"]]);
  });

  test("emoji lines count the same", () => {
    expect(issues("\u{1F44D}\n\u{1F44D}\n\u{1F44D}")).toEqual(["too-many-lines"]);
  });

  test("60 characters in three lines are refused for the lines, not the length", () => {
    expect(issues(`${"a".repeat(20)}\n${"b".repeat(19)}\n${"c".repeat(19)}`)).toEqual(["too-many-lines"]);
  });
});

describe("empty and blank captions", () => {
  test("the empty caption has no issue here: 'at least one character' is the contract's Caption schema", () => {
    expect(issues("")).toEqual([]);
  });

  test.each([" ", "   ", "\n", " \n "])("a blank caption %p breaks no caption rule (it draws an empty plaque; the editor decides)", (text) => {
    expect(issues(text)).toEqual([]);
  });
});

describe("the order and the first issue", () => {
  test("a caption that breaks every rule names them in K19 order", () => {
    const text = `\u{A9}\u{1F600}\u{301} \u{2764}${VS15}\nb\nc${"x".repeat(60)}`;
    expect(issues(text)).toEqual([...CAPTION_ISSUES]);
  });

  test("captionIssue is the first of them", () => {
    expect(captionIssue(`\u{2764}${VS15}\nb\nc`, ctx())).toBe("emoji-text-style");
  });

  test("captionIssue is null for a caption that passes", () => {
    expect(captionIssue("Hello", ctx())).toBeNull();
  });

  test("each issue appears once however many times it is broken", () => {
    expect(issues("\u{A9}\u{AE}\u{2122} \u{A9}")).toEqual(["charset"]);
  });
});

describe("the function is pure", () => {
  test("gives the same answer twice", () => {
    const text = `\u{A9} \u{1F476}`;
    expect(issues(text)).toEqual(issues(text));
  });

  test("never throws on hostile input", () => {
    const hostile = ["\u{D800}", "\u{DC00}\u{D800}", "\u{0}".repeat(100), "\u{200D}".repeat(500), `\u{1F600}${"\u{301}".repeat(300)}`, "\u{E0001}".repeat(200), "a".repeat(5000)];
    for (const text of hostile) expect(() => issues(text)).not.toThrow();
  });

  const fill = (unit: string, n = MAX_CAPTION_UNITS): string => unit.repeat(Math.floor(n / unit.length));
  const WORST: [string, string][] = [
    ["words", "coffee ".repeat(150)],
    ["digits", "1".repeat(1024)],
    ["a ZWJ chain", `${"\u{1F469}\u{200D}".repeat(500)}x`],
    ["1 then spaces", `1${" ".repeat(1023)}`],
    ["1 then newlines", `1${"\n".repeat(1023)}`],
    ["1 then CRLFs", `1${"\r\n".repeat(511)}`],
    ["1 then no-break spaces", `1${"\u{A0}".repeat(1023)}`],
    ["one long word", "t".repeat(1024)],
    ["dashes", fill("-")],
    ["ellipses", fill("\u{2026}")],
    ["copyright signs", fill("\u{A9}")],
    ["emoji", fill("\u{1F600}")],
    ["emoji with VS15", fill(`\u{2764}${VS15}`)],
    ["regional indicators", fill("\u{1F1FA}")],
    ["keycaps", fill(`1${VS16}${KEYCAP}`)],
    ["combining marks", `a${"\u{301}".repeat(1023)}`],
    ["tags", `\u{1F3F4}${"\u{E0067}".repeat(1020)}${CANCEL_TAG}`],
    ["lines", fill("a\n")],
  ];

  test.each(WORST)("stays fast on the longest text it will read: %s", (_name, text) => {
    const started = performance.now();
    issues(text);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("stays fast on the whole table together", () => {
    const started = performance.now();
    for (const [, text] of WORST) issues(text);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
