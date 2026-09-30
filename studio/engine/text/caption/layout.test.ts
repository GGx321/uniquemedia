import { describe, expect, test } from "bun:test";
import { TEXT_BASE_PX } from "../../../shared/montage";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { CaptionLayoutError, EMOJI_HEIGHT_EM, layoutCaption, TEXT_FIT_WIDTH, type CaptionLayout, type LayoutInput } from "./layout";
useNativeGlobals();

// The layout is pure: the measuring is a function handed in. These tests use a fake one, a fixed 60 units per character
// at the 100 px reference (0.6 em, like a wide monospace), so every expected width is arithmetic a reader can redo.

const CHAR_100 = 60;
const measure = (run: string): number => run.length * CHAR_100;
/** The 136x128 bitmap of the bundled emoji font. */
const EMOJI_ASPECT = 136 / 128;

function lay(text: string, over: Partial<LayoutInput> = {}): CaptionLayout {
  return layoutCaption({ text, scale: 1, measure, emojiAspect: () => EMOJI_ASPECT, ...over });
}

const texts = (layout: CaptionLayout): string[] => layout.lines.map((line) => line.text);

describe("size", () => {
  test("a caption that fits is drawn at the base size times its scale", () => {
    expect(lay("hello world").fontSize).toBe(TEXT_BASE_PX);
    expect(lay("hello world", { scale: 1.5 }).fontSize).toBe(84);
    expect(lay("hello world", { scale: 0.5 }).fontSize).toBe(28);
    expect(lay("hello world", { scale: 2 }).fontSize).toBe(112);
  });

  test("a scale that is not a whole number of pixels is kept to a hundredth", () => {
    expect(lay("hello", { scale: 1.3 }).fontSize).toBe(72.8);
    expect(lay("hello", { scale: 1.23456 }).fontSize).toBe(69.14);
  });

  test("the line height is 1.15 em", () => {
    const layout = lay("hello", { scale: 1.5 });
    expect(layout.lineHeight).toBeCloseTo(84 * 1.15, 6);
  });

  test("the fit width is 929 px, 86% of the frame", () => {
    expect(TEXT_FIT_WIDTH).toBe(929);
  });
});

describe("one line", () => {
  test("a short caption is one line of its words", () => {
    const layout = lay("hello world");
    expect(texts(layout)).toEqual(["hello world"]);
    expect(layout.lines).toHaveLength(1);
  });

  test("its width is the words plus the spaces between them at the drawn size", () => {
    const layout = lay("hello world");
    // 5 + 1 + 5 characters at 0.6 em of 56 px.
    expect(layout.textWidth).toBeCloseTo(11 * 0.6 * 56, 6);
  });

  test("words are placed left to right with one space between them", () => {
    const [line] = lay("ab cd").lines;
    const items = line?.items ?? [];
    expect(items[0]?.x).toBe(0);
    expect(items[1]?.x).toBeCloseTo(3 * 0.6 * 56, 9);
    expect(items[0]?.width).toBeCloseTo(2 * 0.6 * 56, 9);
    expect(items[1]?.width).toBeCloseTo(2 * 0.6 * 56, 9);
  });

  test("runs of spaces collapse to one and the ends are trimmed", () => {
    expect(texts(lay("  ab   cd  "))).toEqual(["ab cd"]);
  });

  test("a caption of one word that fits is not split", () => {
    expect(texts(lay("hello"))).toEqual(["hello"]);
  });
});

describe("two lines", () => {
  const EIGHT = "aaaa bbbb cccc dddd eeee ffff gggg hhhh";

  test("a caption too wide for one line is split into two balanced lines", () => {
    const layout = lay(EIGHT);
    expect(texts(layout)).toEqual(["aaaa bbbb cccc dddd", "eeee ffff gggg hhhh"]);
    expect(layout.fontSize).toBe(TEXT_BASE_PX);
  });

  test("the split makes the wider line as narrow as it can be, not as full as it can be", () => {
    // Seven words of four characters: 4 + 3 or 3 + 4 make a widest line of 4 words (638 px); filling line one up to the fit
    // (5 words, 806 px) would leave 2 words below it and a widest line of 806 px.
    const layout = lay("aaaa bbbb cccc dddd eeee ffff gggg");
    expect(Math.max(...layout.lines.map((line) => line.width))).toBeCloseTo(4 * 4 * 0.6 * 56 + 3 * 0.6 * 56, 6);
  });

  test("with equal choices the shorter line is the top one", () => {
    expect(texts(lay("aaaa bbbb cccc dddd eeee ffff gggg"))).toEqual(["aaaa bbbb cccc", "dddd eeee ffff gggg"]);
  });

  test("each line is centred against the widest by its own width, and reports it", () => {
    const layout = lay("aaaa bbbb cccc dddd eeee ffff gggg");
    expect(layout.lines.map((line) => line.width)).toEqual([layout.lines[0]?.width ?? 0, layout.lines[1]?.width ?? 0]);
    expect(layout.textWidth).toBe(Math.max(...layout.lines.map((line) => line.width)));
  });

  test("the layout never uses a third line", () => {
    const layout = lay(Array.from({ length: 30 }, () => "word").join(" "));
    expect(layout.lines.length).toBeLessThanOrEqual(2);
  });
});

describe("explicit line breaks", () => {
  test("an LF makes the second line even when everything would fit on one", () => {
    expect(texts(lay("one two\nthree"))).toEqual(["one two", "three"]);
  });

  test("a CRLF makes the second line as well", () => {
    expect(texts(lay("one two\r\nthree"))).toEqual(["one two", "three"]);
  });

  test("each explicit line keeps its own words and is never re-wrapped into a third", () => {
    const layout = lay("aaaa bbbb cccc dddd eeee ffff gggg hhhh\nxx");
    expect(layout.lines).toHaveLength(2);
    expect(texts(layout)[1]).toBe("xx");
  });

  test("a line that is too wide shrinks the whole caption instead of wrapping", () => {
    const layout = lay("a\n" + "b".repeat(40));
    expect(layout.lines).toHaveLength(2);
    expect(layout.fontSize).toBeLessThan(TEXT_BASE_PX);
    expect(layout.textWidth).toBeLessThanOrEqual(TEXT_FIT_WIDTH);
  });

  test("a blank line is skipped, so a caption with an empty second line is one line", () => {
    expect(texts(lay("hello\n"))).toEqual(["hello"]);
    expect(texts(lay("\nhello"))).toEqual(["hello"]);
    expect(texts(lay("hello\r\n   "))).toEqual(["hello"]);
  });

  test("three non-blank lines are refused: the caption rules stop them earlier and the layout does not draw them", () => {
    expect(() => lay("a\nb\nc")).toThrow(expect.objectContaining({ name: "CaptionLayoutError", code: "TOO_MANY_LINES" }));
  });

  test("a lone CR is not a line break: the caption schema refuses it, and the layout would only see a character", () => {
    expect(texts(lay("a\rb"))).toEqual(["a\rb"]);
  });
});

describe("shrinking to the fit width", () => {
  test("a single word wider than the fit shrinks and is never broken", () => {
    const layout = lay("x".repeat(60));
    expect(texts(layout)).toEqual(["x".repeat(60)]);
    expect(layout.fontSize).toBeLessThan(TEXT_BASE_PX);
    expect(layout.textWidth).toBeLessThanOrEqual(TEXT_FIT_WIDTH);
  });

  test("the shrunk size is a whole number of pixels and uses nearly all of the width", () => {
    const layout = lay("x".repeat(60));
    expect(Number.isInteger(layout.fontSize)).toBe(true);
    expect(layout.textWidth).toBeGreaterThan(TEXT_FIT_WIDTH * 0.94);
  });

  test("a large scale shrinks a caption that would fit at a smaller one", () => {
    const small = lay("aaaa bbbb cccc dddd", { scale: 1 });
    const large = lay("aaaa bbbb cccc dddd", { scale: 2 });
    expect(small.fontSize).toBe(56);
    expect(large.fontSize).toBeLessThanOrEqual(112);
    expect(large.textWidth).toBeLessThanOrEqual(TEXT_FIT_WIDTH);
  });

  test("text exactly the fit width does not shrink", () => {
    // 60 units per character at 100 px: 929 px at 56 px is 929 / 33.6 = 27.6 characters, so use a measure that gives exactly 929.
    const exact = lay("ab", { measure: () => (TEXT_FIT_WIDTH / TEXT_BASE_PX) * 100 });
    expect(exact.fontSize).toBe(TEXT_BASE_PX);
    expect(exact.textWidth).toBeCloseTo(TEXT_FIT_WIDTH, 6);
  });

  test("text a hair over the fit width shrinks", () => {
    const over = lay("ab", { measure: () => ((TEXT_FIT_WIDTH + 0.5) / TEXT_BASE_PX) * 100 });
    expect(over.fontSize).toBeLessThan(TEXT_BASE_PX);
  });

  test("whatever the caption and the scale, the text is never wider than the fit and the size never below one pixel", () => {
    let seed = 20260930;
    const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 400; round++) {
      const words = Array.from({ length: 1 + Math.floor(random() * 14) }, () => "w".repeat(1 + Math.floor(random() * 30)));
      const breakAt = random() < 0.3 && words.length > 1 ? 1 + Math.floor(random() * (words.length - 1)) : -1;
      const text = words.map((word, i) => (i === 0 ? word : `${i === breakAt ? "\n" : " "}${word}`)).join("");
      const scale = 0.5 + random() * 1.5;
      const layout = lay(text, { scale });
      expect(layout.textWidth).toBeLessThanOrEqual(TEXT_FIT_WIDTH + 1e-6);
      expect(layout.fontSize).toBeGreaterThanOrEqual(1);
      expect(layout.fontSize).toBeLessThanOrEqual(TEXT_BASE_PX * scale + 0.01);
      expect(layout.lines.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("emoji", () => {
  test("an emoji is one item, 1.15 em tall at the bitmap's aspect", () => {
    const [line] = lay("hi \u{1F600}").lines;
    const emoji = line?.items.find((item) => item.kind === "emoji");
    expect(emoji?.width).toBeCloseTo(56 * EMOJI_HEIGHT_EM * EMOJI_ASPECT, 6);
    expect(EMOJI_HEIGHT_EM).toBe(1.15);
  });

  test("an emoji cluster keeps its code points", () => {
    const [line] = lay("hi \u{1F469}‍\u{1F4BB}").lines;
    const emoji = line?.items.find((item) => item.kind === "emoji");
    expect(emoji?.kind === "emoji" ? emoji.codePoints : null).toEqual([0x1f469, 0x200d, 0x1f4bb]);
  });

  test("an emoji joined to a word to its left stays with that word: they are never split across lines", () => {
    const layout = lay("aaaa bbbb cccc dddd eeee ffff gggg hhhh\u{1F600}");
    const lastLine = layout.lines[layout.lines.length - 1];
    expect(lastLine?.text.endsWith("hhhh\u{1F600}")).toBe(true);
    const items = lastLine?.items ?? [];
    const word = items.slice(-2);
    expect(word[0]?.kind).toBe("text");
    expect(word[1]?.kind).toBe("emoji");
    expect((word[0]?.x ?? 0) + (word[0]?.width ?? 0)).toBeCloseTo(word[1]?.x ?? -1, 6);
  });

  test("an emoji counts in the width like any other piece", () => {
    const withEmoji = lay("ab \u{1F600}");
    expect(withEmoji.textWidth).toBeCloseTo(2 * 0.6 * 56 + 0.6 * 56 + 56 * 1.15 * EMOJI_ASPECT, 6);
  });

  test("a caption of nothing but emoji is laid out", () => {
    const layout = lay("\u{1F600}\u{1F600}\u{1F600}");
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]?.items.every((item) => item.kind === "emoji")).toBe(true);
  });

  test("sixty emoji shrink to fit and stay in one word", () => {
    const layout = lay("\u{1F600}".repeat(60));
    expect(layout.lines).toHaveLength(1);
    expect(layout.textWidth).toBeLessThanOrEqual(TEXT_FIT_WIDTH);
    expect(layout.fontSize).toBeGreaterThanOrEqual(1);
  });
});

describe("measuring", () => {
  test("each distinct text run is measured once", () => {
    const seen: string[] = [];
    lay("go go go stop go", { measure: (run) => (seen.push(run), measure(run)) });
    expect(seen.filter((run) => run === "go")).toHaveLength(1);
    expect(seen.filter((run) => run === " ")).toHaveLength(1);
  });

  test("a space is measured as itself, not assumed", () => {
    const wide = lay("ab cd", { measure: (run) => (run === " " ? 200 : run.length * CHAR_100) });
    expect(wide.textWidth).toBeCloseTo(4 * 0.6 * 56 + 2 * 56, 6);
  });

  test("a measure that answers nonsense is refused", () => {
    expect(() => lay("ab", { measure: () => Number.NaN })).toThrow(expect.objectContaining({ name: "CaptionLayoutError", code: "BAD_MEASURE" }));
    expect(() => lay("ab", { measure: () => -1 })).toThrow(expect.objectContaining({ name: "CaptionLayoutError", code: "BAD_MEASURE" }));
  });
});

describe("nothing to draw", () => {
  test("an empty caption, or one of spaces and line breaks, has no layout", () => {
    for (const text of ["", "   ", "\n", " \r\n  "]) {
      expect(() => lay(text)).toThrow(expect.objectContaining({ name: "CaptionLayoutError", code: "EMPTY" }));
    }
  });

  test("the error is an Error", () => {
    expect(new CaptionLayoutError("EMPTY", "x")).toBeInstanceOf(Error);
  });
});

describe("scale bounds", () => {
  test("a scale outside 0.5 to 2 is refused", () => {
    for (const scale of [0.49, 2.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => lay("hi", { scale })).toThrow(expect.objectContaining({ name: "CaptionLayoutError", code: "BAD_SCALE" }));
    }
  });

  test("the ends of the range are accepted", () => {
    expect(lay("hi", { scale: 0.5 }).fontSize).toBe(28);
    expect(lay("hi", { scale: 2 }).fontSize).toBe(112);
  });
});
