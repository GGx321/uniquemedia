import { describe, expect, test } from "bun:test";
import { FRAME_W } from "../../../shared/montage";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { TEXT_FONT_KEYS, TEXT_FONTS } from "../fonts";
import { layoutCaption, type CaptionLayout } from "../../../shared/text/layout";
import { buildCaptionSvg, CaptionTemplateError, EMOJI_BASELINE, escapeXml, inkFor, measureSvg, type TemplateInput } from "./template";
useNativeGlobals();

// The template is the ONLY place caption text meets markup (invariant 17): these tests read the SVG it builds as text,
// the way a hostile caption would try to abuse it. Rendering it is renderer.test.ts's and template.property.test.ts's job.

const METRICS = { unitsPerEm: 2000, ascender: 2132, descender: -600 };
const EMOJI_ASPECT = 136 / 128;
const measure = (run: string): number => run.length * 60;
/** What the emoji reader would hand over: a stable key per distinct glyph and a base64 body. */
const emojiKey = (codePoints: readonly number[]): number => codePoints.reduce((sum, cp) => sum * 31 + cp, 7) % 100_000;
const emojiImage = (codePoints: readonly number[]) => ({ key: emojiKey(codePoints), base64: `QUJD${emojiKey(codePoints)}` });

function layoutOf(text: string, scale = 1): CaptionLayout {
  return layoutCaption({ text, scale, measure, emojiAspect: () => EMOJI_ASPECT });
}

function build(text: string, over: Partial<TemplateInput> = {}, scale = 1) {
  return buildCaptionSvg({ layout: layoutOf(text, scale), font: "manrope", style: "plaque", color: "#ffffff", metrics: METRICS, emoji: emojiImage, ...over });
}

const tagNames = (svg: string): string[] => [...svg.matchAll(/<([A-Za-z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1] ?? "");
const count = (svg: string, tag: string): number => tagNames(svg).filter((name) => name === tag).length;

describe("escapeXml", () => {
  test("turns the five markup characters into entities", () => {
    expect(escapeXml(`<b> & "q" 'x'`)).toBe("&lt;b&gt; &amp; &quot;q&quot; &apos;x&apos;");
  });

  test("escapes an ampersand first, so an entity in the text is drawn as text", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  test("leaves ordinary text and the typographic marks alone", () => {
    expect(escapeXml("it’s a “day” – ok…")).toBe("it’s a “day” – ok…");
  });

  test.each(["\u0000", "\u0001", "\u001F", "\u007F", "\u0085", "\r", "\t"])("refuses the control character %j", (character) => {
    expect(() => escapeXml(`a${character}b`)).toThrow(CaptionTemplateError);
  });

  test("refuses a lone surrogate", () => {
    expect(() => escapeXml("a\uD800b")).toThrow(CaptionTemplateError);
  });

  test("refuses the two code points XML 1.0 cannot carry", () => {
    expect(() => escapeXml("a￾b")).toThrow(CaptionTemplateError);
    expect(() => escapeXml("a￿b")).toThrow(CaptionTemplateError);
  });
});

describe("hostile text stays character data", () => {
  const HOSTILE = `<b>&amp; "q" 'x' </text><rect width="9999" height="9999" fill="red"/><image href="file:///etc/passwd"/><script>1</script>`;

  test("adds no element: one plaque rect, one text per piece, no image, no script", () => {
    const { svg } = build(HOSTILE);
    expect(count(svg, "rect")).toBe(1);
    expect(count(svg, "image")).toBe(0);
    expect(count(svg, "script")).toBe(0);
    expect(count(svg, "use")).toBe(0);
  });

  test("no raw markup character is left inside any text node", () => {
    const { svg } = build(HOSTILE, { style: "outline" });
    const nodes = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1] ?? "");
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node).not.toContain(">");
      expect(node.replace(/&(?:lt|gt|amp|quot|apos);/g, "")).not.toMatch(/[<&"']/);
    }
  });

  test("the escaped forms are there, so the characters are drawn", () => {
    const { svg } = build(`<b>&amp; "q"`);
    expect(svg).toContain("&lt;b&gt;&amp;amp;");
    expect(svg).toContain("&quot;q&quot;");
  });

  test("only the template's own elements ever appear, for every style", () => {
    const allowed = new Set(["svg", "defs", "filter", "feGaussianBlur", "feOffset", "feFlood", "feComposite", "feMerge", "feMergeNode", "rect", "g", "text", "image", "use"]);
    for (const style of ["none", "plaque", "outline"] as const) {
      const { svg } = build(`${HOSTILE} \u{1F600}`, { style });
      expect(tagNames(svg).filter((name) => !allowed.has(name))).toEqual([]);
    }
  });

  test("the only hrefs are engine-built data:image/png URIs and #eN references, nothing else", () => {
    const { svg } = build(`x \u{1F600} y \u{1F469}‍\u{1F4BB} \u{1F600}`, { style: "none" });
    const hrefs = [...svg.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^(?:data:image\/png;base64,[A-Za-z0-9+/=]+|#e\d+)$/);
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/xlink:|file:|https?:/);
  });

  test("the font family and weight come from the manifest, never from the caption", () => {
    for (const key of TEXT_FONT_KEYS) {
      const { svg } = build("hello", { font: key });
      expect(svg).toContain(`font-family="${TEXT_FONTS[key].family}"`);
      expect(svg).toContain(`font-weight="${TEXT_FONTS[key].weight}"`);
    }
  });
});

describe("colours", () => {
  test("a colour that is not lowercase #rrggbb is refused before it reaches the markup", () => {
    for (const color of ['#fff', '#FFFFFF', 'red', '#ffffff" onload="x', '', '#ggg000', 'url(#e0)', '#ffffff\n']) {
      expect(() => build("hi", { color })).toThrow(CaptionTemplateError);
    }
  });

  test("inkFor picks #111111 on a light colour and #ffffff on a dark one", () => {
    expect(inkFor("#ffffff")).toBe("#111111");
    expect(inkFor("#ffd166")).toBe("#111111");
    expect(inkFor("#ff9ec4")).toBe("#111111");
    expect(inkFor("#9ad9ff")).toBe("#111111");
    expect(inkFor("#ff7a59")).toBe("#111111");
    expect(inkFor("#111111")).toBe("#ffffff");
    expect(inkFor("#000000")).toBe("#ffffff");
    expect(inkFor("#1f2a44")).toBe("#ffffff");
  });

  test("inkFor never picks the ink that is nearer the colour: white plaque gives dark ink, black plaque white ink", () => {
    for (const color of ["#ffffff", "#f5f5f5", "#000000", "#0a0a0a", "#808080"]) {
      const ink = inkFor(color);
      const contrast = (a: string, b: string): number => {
        const lum = (hex: string): number =>
          [1, 3, 5]
            .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
            .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
            .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
        const [hi, lo] = [Math.max(lum(a), lum(b)), Math.min(lum(a), lum(b))];
        return (hi + 0.05) / (lo + 0.05);
      };
      const other = ink === "#111111" ? "#ffffff" : "#111111";
      expect(contrast(color, ink)).toBeGreaterThanOrEqual(contrast(color, other));
    }
  });
});

describe("the plaque style", () => {
  test("its colour paints the plaque and the text takes the contrasting ink", () => {
    const light = build("hello", { style: "plaque", color: "#ffd166" }).svg;
    expect(light).toMatch(/<rect [^>]*fill="#ffd166"/);
    expect(light).toMatch(/<text [^>]*fill="#111111"/);
    const dark = build("hello", { style: "plaque", color: "#111111" }).svg;
    expect(dark).toMatch(/<rect [^>]*fill="#111111"/);
    expect(dark).toMatch(/<text [^>]*fill="#ffffff"/);
  });

  test("the plaque is a rounded rectangle over the whole box, with no filter and no stroke", () => {
    const { svg, width, height } = build("hello");
    expect(svg).toMatch(new RegExp(`<rect width="${width}" height="${height}" rx="[0-9.]+"`));
    expect(svg).not.toContain("<filter");
    expect(svg).not.toContain("stroke");
  });

  test("the box is the text plus the mockup's padding: half an em each side, 0.13 above and 0.21 below", () => {
    const layout = layoutOf("hello");
    const { width, height } = build("hello");
    expect(width).toBe(Math.ceil(layout.textWidth + 2 * 0.5 * layout.fontSize));
    expect(height).toBe(Math.ceil(layout.lineHeight + (0.13 + 0.21) * layout.fontSize));
  });

  test("the radius is 0.3 em, and never more than half the height", () => {
    const layout = layoutOf("hello");
    const rx = Number(/rx="([0-9.]+)"/.exec(build("hello").svg)?.[1]);
    expect(rx).toBeCloseTo(0.3 * layout.fontSize, 2);
    const tiny = layoutCaption({ text: "a", scale: 0.5, measure: () => 1, emojiAspect: () => 1 });
    const { svg, height } = buildCaptionSvg({ layout: tiny, font: "manrope", style: "plaque", color: "#ffffff", metrics: METRICS, emoji: emojiImage });
    expect(Number(/rx="([0-9.]+)"/.exec(svg)?.[1])).toBeLessThanOrEqual(height / 2);
  });
});

describe("the outline style", () => {
  test("the colour is the text colour and a black stroke sits under it", () => {
    const { svg } = build("hello", { style: "outline", color: "#ffd166" });
    expect(svg).toMatch(/<text [^>]*fill="#ffd166"/);
    expect(svg).toMatch(/<text [^>]*stroke="#000000"/);
    expect(svg).toContain('paint-order="stroke fill"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).not.toContain("<rect");
    expect(svg).not.toContain("<filter");
  });

  test("a dark text colour flips the stroke to white", () => {
    const { svg } = build("hello", { style: "outline", color: "#111111" });
    expect(svg).toMatch(/<text [^>]*stroke="#ffffff"/);
    expect(svg).not.toContain('stroke="#000000"');
  });

  test("the stroke is 0.125 em wide", () => {
    const layout = layoutOf("hello");
    const width = Number(/stroke-width="([0-9.]+)"/.exec(build("hello", { style: "outline" }).svg)?.[1]);
    expect(width).toBeCloseTo(0.125 * layout.fontSize, 2);
  });
});

describe("the no-background style", () => {
  test("the colour is the text colour, over a soft shadow made by one filter on one group", () => {
    const { svg } = build("hello", { style: "none", color: "#9ad9ff" });
    expect(svg).toMatch(/<text [^>]*fill="#9ad9ff"/);
    expect(count(svg, "filter")).toBe(1);
    expect(count(svg, "g")).toBe(1);
    expect(svg).toMatch(/<g filter="url\(#s\)">/);
    expect(svg).not.toContain("<rect");
    expect(svg).not.toContain("stroke");
  });

  test("the shadow is black at 55%, and white at 50% under a dark text colour", () => {
    expect(build("hello", { style: "none", color: "#ffffff" }).svg).toContain('flood-color="#000000" flood-opacity="0.55"');
    expect(build("hello", { style: "none", color: "#111111" }).svg).toContain('flood-color="#ffffff" flood-opacity="0.5"');
  });

  test("the light shadow under a dark text colour is the mockup's own: 8 px of blur and 1 px down, i.e. sigma 0.168 em and 0.042 em", () => {
    const size = layoutOf("hello").fontSize;
    const { svg } = build("hello", { style: "none", color: "#111111" });
    expect(Number(/stdDeviation="([0-9.]+)"/.exec(svg)?.[1])).toBeCloseTo(0.168 * size, 2);
    expect(Number(/dy="([0-9.]+)"/.exec(svg)?.[1])).toBeCloseTo(0.042 * size, 2);
  });

  test("the dark shadow is the mockup's 12 px of blur (cut to sigma 0.2 em to fit the frame) and 2 px down: 0.084 em", () => {
    const size = layoutOf("hello").fontSize;
    const { svg } = build("hello", { style: "none", color: "#ffffff" });
    expect(Number(/stdDeviation="([0-9.]+)"/.exec(svg)?.[1])).toBeCloseTo(0.2 * size, 2);
    expect(Number(/dy="([0-9.]+)"/.exec(svg)?.[1])).toBeCloseTo(0.084 * size, 2);
  });

  test("the filter covers the whole box, so the blur is never cut short of it", () => {
    const { svg, width, height } = build("hi", { style: "none" });
    expect(svg).toContain(`filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"`);
  });

  test("the box leaves room for three sigma of blur on every side", () => {
    const layout = layoutOf("hello");
    const { width } = build("hello", { style: "none" });
    expect(width).toBeGreaterThanOrEqual(Math.ceil(layout.textWidth + 2 * 3 * 0.2 * layout.fontSize));
  });
});

describe("the box", () => {
  test("is never wider than the frame, in any style, for the widest text at the largest scale", () => {
    for (const style of ["none", "plaque", "outline"] as const) {
      for (const scale of [0.5, 1, 2]) {
        const { width } = build("w".repeat(60), { style }, scale);
        expect(width).toBeLessThanOrEqual(FRAME_W);
      }
    }
  });

  test("two lines of the widest text at the largest scale stay within the rasteriser's canvas budget", () => {
    for (const style of ["none", "plaque", "outline"] as const) {
      const { width, height } = build("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp", { style }, 2);
      expect(width * height).toBeLessThanOrEqual(1080 * 600);
    }
  });

  test("the SVG states the same width and height as the box, whole pixels", () => {
    const { svg, width, height } = build("hello world");
    expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
    expect(svg).toContain(`width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`);
  });

  test("a layout wider than the frame is refused, not silently clipped", () => {
    const wide: CaptionLayout = { fontSize: 100, lineHeight: 115, lines: [{ items: [{ kind: "text", text: "x", x: 0, width: 1200 }], width: 1200, inkLeft: 0, inkRight: 0, text: "x" }], textWidth: 1200 };
    expect(() => buildCaptionSvg({ layout: wide, font: "manrope", style: "plaque", color: "#ffffff", metrics: METRICS, emoji: emojiImage })).toThrow(CaptionTemplateError);
  });
});

describe("lines and baselines", () => {
  test("each line is centred in the box, and the second baseline is one line height below the first", () => {
    const { svg } = build("aaaa bbbb cccc dddd eeee ffff gggg hhhh");
    const ys = [...svg.matchAll(/<text x="[0-9.]+" y="([0-9.]+)"/g)].map((m) => Number(m[1]));
    const distinct = [...new Set(ys)];
    expect(distinct).toHaveLength(2);
    expect((distinct[1] ?? 0) - (distinct[0] ?? 0)).toBeCloseTo(layoutOf("aaaa bbbb cccc dddd eeee ffff gggg hhhh").lineHeight, 1);
  });

  test("a baseline puts the font's ascent plus descent in the middle of the line box", () => {
    const layout = layoutOf("hello");
    const first = Number(/<text x="[0-9.]+" y="([0-9.]+)"/.exec(build("hello").svg)?.[1]);
    const ascent = (2132 / 2000) * layout.fontSize;
    const descent = (600 / 2000) * layout.fontSize;
    expect(first).toBeCloseTo(0.13 * layout.fontSize + (layout.lineHeight - (ascent + descent)) / 2 + ascent, 1);
  });

  test("an explicit line break gives two <text> rows even for a short caption", () => {
    const { svg } = build("one\ntwo");
    expect(new Set([...svg.matchAll(/<text x="[0-9.]+" y="([0-9.]+)"/g)].map((m) => m[1])).size).toBe(2);
  });

  test("numbers are written to two decimals, so the SVG is the same text on every platform", () => {
    const { svg } = build("hello world", {}, 1.23456);
    for (const value of svg.matchAll(/\b(?:x|y|font-size)="(-?[0-9]+(?:\.[0-9]+)?)"/g)) {
      expect(value[1]).toMatch(/^-?[0-9]+(?:\.[0-9]{1,2})?$/);
    }
  });
});

describe("emoji", () => {
  test("each distinct emoji is defined once, in <defs>, and used by reference", () => {
    const { svg } = build(`\u{1F600} \u{1F600} \u{1F600} ab \u{1F469}‍\u{1F4BB}`);
    expect(count(svg, "image")).toBe(2);
    expect(count(svg, "use")).toBe(4);
    expect(svg).toMatch(/<defs><image id="e0" /);
    expect(svg).toContain('<use href="#e0"');
    expect(svg).toContain('<use href="#e1"');
    expect([...svg.matchAll(/<image id="(e\d+)"/g)].map((m) => m[1])).toEqual(["e0", "e1"]);
  });

  test("an emoji is 1.15 em tall at its bitmap's aspect, on the provisional 0.82 baseline", () => {
    const layout = layoutOf(`\u{1F600}`);
    const { svg } = build(`\u{1F600}`);
    const height = 1.15 * layout.fontSize;
    expect(EMOJI_BASELINE).toBe(0.82);
    expect(Number(/<image id="e0" width="[0-9.]+" height="([0-9.]+)"/.exec(svg)?.[1])).toBeCloseTo(height, 2);
    expect(Number(/<image id="e0" width="([0-9.]+)"/.exec(svg)?.[1])).toBeCloseTo(height * EMOJI_ASPECT, 2);
  });

  test("the picture sits so the baseline cuts it at 82% from its top", () => {
    const layout = layoutOf(`a \u{1F600}`);
    const { svg } = build(`a \u{1F600}`);
    const text = /<text x="[0-9.]+" y="([0-9.]+)"/.exec(svg);
    const use = /<use href="#e0" x="[0-9.]+" y="([0-9.]+)"/.exec(svg);
    const base = Number(text?.[1]);
    const top = Number(use?.[1]);
    expect(top).toBeCloseTo(base - 0.82 * 1.15 * layout.fontSize, 1);
  });

  test("the base64 is embedded as given, once per distinct emoji", () => {
    const { svg } = build(`\u{1F600} \u{1F600}`);
    expect(svg.split(`data:image/png;base64,${emojiImage([0x1f600]).base64}`)).toHaveLength(2);
  });

  test("a base64 body with anything outside the alphabet is refused", () => {
    expect(() => build("\u{1F600}", { emoji: () => ({ key: 1, base64: 'AAA"/><script>' }) })).toThrow(CaptionTemplateError);
  });

  test("the SVG is much smaller than one copy of the bitmap per use", () => {
    const body = "A".repeat(6000);
    const many = `\u{1F600} `.repeat(20).trim();
    const { svg } = build(many, { emoji: () => ({ key: 5, base64: body }) });
    expect(Buffer.byteLength(svg, "utf8")).toBeLessThan(6000 * 2);
  });
});

describe("measureSvg", () => {
  test("holds one text run at 100 px in the font, between two bars, and stays a tiny canvas", () => {
    const svg = measureSvg("manrope", `a<b`);
    expect(svg).toContain('font-size="100"');
    expect(svg).toContain('font-family="Manrope"');
    expect(svg).toContain(">|a&lt;b|</text>");
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toMatch(/width="\d{1,2}" height="\d{1,2}"/);
  });

  test("carries the font's letter spacing, and only where it has one", () => {
    expect(measureSvg("manrope", "a")).toContain('letter-spacing="-2"');
    expect(measureSvg("oswald", "a")).toContain('letter-spacing="1"');
    expect(measureSvg("playfair", "a")).not.toContain("letter-spacing");
  });
});

describe("letter spacing in the drawn text", () => {
  test("the drawn text carries the same spacing as the measured one, scaled to the size", () => {
    const layout = layoutOf("hello");
    const { svg } = build("hello", { font: "manrope" });
    const spacing = Number(/letter-spacing="(-?[0-9.]+)"/.exec(svg)?.[1]);
    expect(spacing).toBeCloseTo(-0.02 * layout.fontSize, 2);
    expect(build("hello", { font: "playfair" }).svg).not.toContain("letter-spacing");
  });
});
