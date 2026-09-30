import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { layoutCaption, type CaptionLayout } from "./layout";
useNativeGlobals();

// Glyphs can reach past their advance (Caveat's `[` by 0.3 em, its `f` and `j`). The layout carries how far the ink of
// the first and the last text run of each line sticks out, so the template can size the box by ink, not by advance.

const measure = (run: string): number => run.length * 60;
/** At 100 px: every `[` sticks out 30 to the right and 20 to the left, every `j` 25 to the left, every `f` 12 to the right. */
const overhang = (run: string): { left: number; right: number } => ({
  left: run.startsWith("[") ? 20 : run.startsWith("j") ? 25 : 0,
  right: run.endsWith("[") ? 30 : run.endsWith("f") ? 12 : 0,
});

function lay(text: string, over: { scale?: number; inkOverhang?: typeof overhang } = {}): CaptionLayout {
  return layoutCaption({ text, scale: over.scale ?? 1, measure, emojiAspect: () => 136 / 128, ...(over.inkOverhang === undefined ? {} : { inkOverhang: over.inkOverhang }) });
}

describe("the ink of a line's ends", () => {
  test("a line ending in a glyph that overhangs reports it, scaled to the drawn size", () => {
    const [line] = lay("Hey [", { inkOverhang: overhang }).lines;
    expect(line?.inkRight).toBeCloseTo(0.3 * 56, 6);
    expect(line?.inkLeft).toBe(0);
  });

  test("a line starting with one reports it on the left", () => {
    const [line] = lay("jump", { inkOverhang: overhang }).lines;
    expect(line?.inkLeft).toBeCloseTo(0.25 * 56, 6);
  });

  test("scales with the caption's size", () => {
    const [line] = lay("Hey [", { scale: 2, inkOverhang: overhang }).lines;
    expect(line?.inkRight).toBeCloseTo(0.3 * 112, 6);
  });

  test("follows the shrunk size, not the base size", () => {
    const layout = lay(`${"x".repeat(60)}[`, { inkOverhang: overhang });
    expect(layout.fontSize).toBeLessThan(56);
    expect(layout.lines[0]?.inkRight).toBeCloseTo(0.3 * layout.fontSize, 6);
  });

  test("is asked for the first and last text run of each line only", () => {
    const asked: string[] = [];
    lay("jump over the fence [", { inkOverhang: (run) => (asked.push(run), overhang(run)) });
    expect(new Set(asked)).toEqual(new Set(["jump", "["]));
  });

  test("each line of a two-line caption has its own", () => {
    const layout = lay("jump\nover [", { inkOverhang: overhang });
    expect(layout.lines.map((line) => [line.inkLeft, line.inkRight])).toEqual([
      [expect.closeTo(0.25 * 56, 6), 0],
      [0, expect.closeTo(0.3 * 56, 6)],
    ]);
  });

  test("an emoji at either end has none: its bitmap is inside its own width", () => {
    const [line] = lay("\u{1F600} hi \u{1F600}", { inkOverhang: () => ({ left: 50, right: 50 }) }).lines;
    expect(line?.inkLeft).toBe(0);
    expect(line?.inkRight).toBe(0);
  });

  test("the overhang of a text run beside an emoji counts on the far side only", () => {
    const [line] = lay("hi\u{1F600}", { inkOverhang: () => ({ left: 10, right: 10 }) }).lines;
    expect(line?.inkLeft).toBeCloseTo(0.1 * 56, 6);
    expect(line?.inkRight).toBe(0);
  });

  test("is zero for every line when no measure of it is given", () => {
    for (const line of lay("Hey [\nx").lines) expect([line.inkLeft, line.inkRight]).toEqual([0, 0]);
  });

  test("a negative overhang (the glyph stops short of its advance) is zero, never negative", () => {
    const [line] = lay("hi", { inkOverhang: () => ({ left: -8, right: -3 }) }).lines;
    expect([line?.inkLeft, line?.inkRight]).toEqual([0, 0]);
  });

  test("does not change the width or the size the layout fits: those are by advance", () => {
    const plain = lay("Hey [");
    const inked = lay("Hey [", { inkOverhang: overhang });
    expect(inked.fontSize).toBe(plain.fontSize);
    expect(inked.textWidth).toBe(plain.textWidth);
  });

  test("a measure that answers nonsense is refused", () => {
    expect(() => lay("hi", { inkOverhang: () => ({ left: Number.NaN, right: 0 }) })).toThrow(expect.objectContaining({ name: "CaptionLayoutError", code: "BAD_MEASURE" }));
  });
});
