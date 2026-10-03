import { describe, expect, test } from "bun:test";
import { FRAME_W } from "../../../shared/montage";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { layoutCaption, type CaptionLayout } from "../../../shared/text/layout";
import { buildCaptionSvg, INK_ORIGIN_PX, inkSvg, type TemplateInput } from "./template";
useNativeGlobals();

// The box is sized by the ink of a line's ends, not by its advance: a glyph that sticks out (Caveat's bracket, its `f`
// and `j`) must not be cut by the box's edge, whatever the style's own padding is.

const METRICS = { unitsPerEm: 2000, ascender: 2132, descender: -600 };
const measure = (run: string): number => run.length * 60;
const NO_EMOJI = { key: 1, base64: "QUJD" };

function layoutOf(text: string, overhang: (run: string) => { left: number; right: number }, scale = 1): CaptionLayout {
  return layoutCaption({ text, scale, measure, emojiAspect: () => 1, inkOverhang: overhang });
}

function build(layout: CaptionLayout, style: TemplateInput["style"]) {
  return buildCaptionSvg({ layout, font: "caveat", style, color: "#ffffff", metrics: METRICS, emoji: () => NO_EMOJI });
}

const none = (): { left: number; right: number } => ({ left: 0, right: 0 });
const firstX = (svg: string): number => Number(/<text x="(-?[0-9.]+)"/.exec(svg)?.[1]);

describe("outline", () => {
  test("keeps its own padding when nothing sticks out", () => {
    const layout = layoutOf("hello", none);
    const { width } = build(layout, "outline");
    expect(width).toBe(Math.ceil(layout.textWidth + 2 * 0.25 * layout.fontSize));
  });

  test("widens the right side by the overhang, the stroke and a pixel of antialiasing when the pad is not enough", () => {
    const layout = layoutOf("hello [", (run) => ({ left: 0, right: run.endsWith("[") ? 30 : 0 }));
    const size = layout.fontSize;
    const padRight = 0.3 * size + 0.0625 * size + 1;
    const { width } = build(layout, "outline");
    expect(width).toBe(Math.ceil(0.25 * size + layout.textWidth + padRight));
    expect(padRight).toBeGreaterThan(0.25 * size);
  });

  test("widens the left side and moves the text right by the same amount", () => {
    const wide = layoutOf("jump", (run) => ({ left: run.startsWith("j") ? 30 : 0, right: 0 }));
    const plain = layoutOf("jump", none);
    const a = build(wide, "outline");
    const b = build(plain, "outline");
    const extra = 0.3 * wide.fontSize + 0.0625 * wide.fontSize + 1 - 0.25 * wide.fontSize;
    expect(firstX(a.svg) - firstX(b.svg)).toBeCloseTo(extra, 1);
    expect(a.width - b.width).toBeGreaterThanOrEqual(Math.floor(extra));
  });

  test("an overhang the pad already covers changes nothing", () => {
    const small = layoutOf("hello", (run) => ({ left: 0, right: run.endsWith("o") ? 2 : 0 }));
    const plain = layoutOf("hello", none);
    expect(build(small, "outline").width).toBe(build(plain, "outline").width);
  });
});

describe("plaque", () => {
  test("keeps its half em when the overhang fits inside it, so the plaque does not grow for a bracket", () => {
    const layout = layoutOf("hello [", (run) => ({ left: 0, right: run.endsWith("[") ? 30 : 0 }));
    expect(build(layout, "plaque").width).toBe(Math.ceil(layout.textWidth + 2 * 0.5 * layout.fontSize));
  });

  test("grows when the overhang is more than the plaque's padding", () => {
    const layout = layoutOf("hello [", (run) => ({ left: 0, right: run.endsWith("[") ? 80 : 0 }));
    expect(build(layout, "plaque").width).toBeGreaterThan(Math.ceil(layout.textWidth + 2 * 0.5 * layout.fontSize));
  });
});

describe("no background", () => {
  test("adds the overhang to the three sigma the blur needs", () => {
    const layout = layoutOf("hello [", (run) => ({ left: 0, right: run.endsWith("[") ? 30 : 0 }));
    const size = layout.fontSize;
    const { width } = build(layout, "none");
    expect(width).toBe(Math.ceil(0.6 * size + layout.textWidth + (0.3 * size + 0.6 * size)));
  });
});

describe("inkSvg", () => {
  test("holds the run alone, with no bars, at 100 px and at x = 200, so ink to the left of the origin is measured too", () => {
    const svg = inkSvg("caveat", "a<b");
    expect(svg).toContain('x="200"');
    expect(svg).toContain(">a&lt;b</text>");
    expect(svg).not.toContain("|");
    expect(svg).toContain('font-size="100"');
    expect(svg).toContain('font-family="Caveat"');
    expect(svg).toContain('xml:space="preserve"');
  });

  test("carries the font's letter spacing exactly as the advance measure does", () => {
    expect(inkSvg("manrope", "a")).toContain('letter-spacing="-2"');
    expect(inkSvg("playfair", "a")).not.toContain("letter-spacing");
  });

  test("its origin is a named constant the renderer subtracts", () => {
    expect(INK_ORIGIN_PX).toBe(200);
  });
});

describe("the frame", () => {
  test("no style ever makes a box wider than the frame, however far the ink sticks out", () => {
    for (const style of ["none", "plaque", "outline"] as const) {
      for (const scale of [1, 2]) {
        const layout = layoutOf("w".repeat(60), () => ({ left: 100, right: 100 }), scale);
        expect(build(layout, style).width).toBeLessThanOrEqual(FRAME_W);
      }
    }
  });

  test("the text is still centred in the box: the two sides differ only by what the ink asks for", () => {
    const layout = layoutOf("hello [", (run) => ({ left: 0, right: run.endsWith("[") ? 30 : 0 }));
    const { svg, width } = build(layout, "outline");
    const leftPad = firstX(svg);
    expect(leftPad).toBeCloseTo(0.25 * layout.fontSize, 1);
    expect(width - leftPad - layout.textWidth).toBeGreaterThan(leftPad);
  });

  test("two lines are centred against each other inside the widest", () => {
    const layout = layoutOf("aaaa bbbb cccc dddd eeee ffff gggg hhhh", none);
    const { svg } = build(layout, "outline");
    const xs = [...svg.matchAll(/<text x="(-?[0-9.]+)" y="([0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const firstRow = xs.filter(([, y]) => y === xs[0]?.[1]);
    const secondRow = xs.filter(([, y]) => y !== xs[0]?.[1]);
    const left = (row: typeof xs, line: number) => (row[0]?.[0] ?? 0) - 0 * line;
    expect(left(firstRow, 0)).toBeCloseTo(0.25 * layout.fontSize + (layout.textWidth - (layout.lines[0]?.width ?? 0)) / 2, 1);
    expect(left(secondRow, 1)).toBeCloseTo(0.25 * layout.fontSize + (layout.textWidth - (layout.lines[1]?.width ?? 0)) / 2, 1);
  });
});
