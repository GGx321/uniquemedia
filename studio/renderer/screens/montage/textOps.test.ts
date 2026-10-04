import { describe, expect, test } from "bun:test";
import { MAX_CAPTION_GRAPHEMES, MontageDraft, TextLayer } from "../../../shared/engine";
import { TEXT_BASE_PX } from "../../../shared/montage";
import { captionIssue } from "../../../shared/text/captionRules";
import { addTextLayer, DEFAULT_TEXT_VALUE, type LayerEdit } from "./layerOps";
import {
  captionRefusal,
  type CaptionEdit,
  insertAt,
  moveTextInside,
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  setCaption,
  setTextColor,
  setTextFont,
  setTextScale,
  setTextStyle,
  TEXT_COLORS,
  TEXT_PRESETS,
  textSize,
  textZones,
  TYPING_PAUSE_MS,
  typingGoesOn,
} from "./textOps";
import { draftSpec, stickerLayer, textLayer } from "./testkit";

// 3d.5: a text layer's properties (EditorText.dc.html, R23–R31) as pure edits over a draft. Each result is a draft the contract
// takes, and only the one field the control is about changes. The caption itself is the engine's to judge (`montages.textPreview`
// → TEXT_INVALID + `captionIssue`, shown inline): the window keeps out only what can never reach the engine, the text the contract's
// `Caption` refuses and a caption the shared layout has nothing to draw from, and words even that by the SHARED caption rules.

/** Four 2 s clips (8.0 s) with a text at 1 and a sticker at 0. */
const SPEC = draftSpec(4, { layers: [stickerLayer(0, 0, 2_000), textLayer(1, 1_000, 4_000)] });
const TEXT = 1;

const textOf = (spec: MontageDraft): TextLayer => {
  const layer = spec.layers[TEXT];
  if (layer?.kind !== "text") throw new Error("no text at 1");
  return layer;
};

function committed(edit: CaptionEdit): MontageDraft {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
  return edit.spec;
}

/** The edited draft is one the contract takes, and nothing but `field` of the text changed. */
function onlyChanged(next: MontageDraft, field: keyof TextLayer): void {
  expect(MontageDraft.safeParse(next).success).toBe(true);
  const before = textOf(SPEC);
  const after = textOf(next);
  for (const key of Object.keys(before) as (keyof TextLayer)[]) if (key !== field) expect(after[key]).toEqual(before[key]);
  expect(next.layers[0]).toBe(SPEC.layers[0]);
  expect(next.clips).toBe(SPEC.clips);
}

describe("what typed text can become the caption (the contract's Caption and the shared layout; the rest is the engine's verdict)", () => {
  test("an empty field is refused as empty; a single character is a caption", () => {
    expect(captionRefusal("")).toBe("empty");
    expect(captionRefusal("a")).toBe(null);
  });

  test("only spaces and line breaks: the shared layout has nothing to draw, so it never becomes the caption", () => {
    expect(captionRefusal(" ")).toBe("blank");
    expect(captionRefusal("   \n  ")).toBe("blank");
    expect(captionRefusal("\r\n")).toBe("blank");
    expect(captionRefusal(" a ")).toBe(null);
  });

  test("60 characters as a person counts them are a caption, 61 are too long (graphemes, not code units)", () => {
    expect(captionRefusal("a".repeat(MAX_CAPTION_GRAPHEMES))).toBe(null);
    expect(captionRefusal("a".repeat(MAX_CAPTION_GRAPHEMES + 1))).toBe("too-long");
    // ☀️ is two code units and one grapheme: 60 of them are still 60 characters.
    expect(captionRefusal("☀️".repeat(MAX_CAPTION_GRAPHEMES))).toBe(null);
    expect(captionRefusal("☀️".repeat(MAX_CAPTION_GRAPHEMES + 1))).toBe("too-long");
  });

  test("text the contract takes is left to the engine, even when its rules will refuse it (no client-side rules of its own)", () => {
    // Cyrillic, © and three lines all pass the contract's Caption: the engine answers TEXT_INVALID for them, the window shows it.
    expect(captionRefusal("утро в Лиссабоне")).toBe(null);
    expect(captionRefusal("coffee ©")).toBe(null);
    expect(captionRefusal("one\ntwo\nthree")).toBe(null);
    expect(captionRefusal("sunday reset ☀️")).toBe(null);
  });

  test("a refusal of the contract is worded by the shared rules' first issue, as the engine would word it", () => {
    // A tab is a control character: the contract refuses it, the shared charset rule names it.
    expect(captionRefusal("a\tb")).toBe("charset");
    // A bidi override.
    expect(captionRefusal("a‮b")).toBe("charset");
    // Cyrillic AND too long: the charset rule comes first in CAPTION_ISSUES order, as on the engine.
    expect(captionRefusal("ж".repeat(MAX_CAPTION_GRAPHEMES + 1))).toBe("charset");
  });
});

describe("the caption (R23)", () => {
  test("a caption the contract takes replaces the text's value, nothing else", () => {
    const next = committed(setCaption(SPEC, TEXT, "coffee first ☕"));
    expect(textOf(next).value).toBe("coffee first ☕");
    onlyChanged(next, "value");
  });

  test("the same caption is the same draft", () => {
    const edit = setCaption(SPEC, TEXT, textOf(SPEC).value);
    expect(edit.ok && edit.spec).toBe(SPEC);
  });

  test("text that cannot be the caption is refused with its reason and changes nothing", () => {
    expect(setCaption(SPEC, TEXT, "")).toEqual({ ok: false, reason: "empty" });
    expect(setCaption(SPEC, TEXT, "  ")).toEqual({ ok: false, reason: "blank" });
    expect(setCaption(SPEC, TEXT, "a".repeat(MAX_CAPTION_GRAPHEMES + 1))).toEqual({ ok: false, reason: "too-long" });
  });

  test("a text the engine will refuse is still the owner's caption (the draft keeps what was typed; the panel shows the verdict)", () => {
    expect(textOf(committed(setCaption(SPEC, TEXT, "утро"))).value).toBe("утро");
  });

  test("a layer that is not a text, or no layer at all, is a programming error", () => {
    expect(() => setCaption(SPEC, 0, "a")).toThrow(RangeError);
    expect(() => setCaption(SPEC, 2, "a")).toThrow(RangeError);
    expect(() => setTextFont(SPEC, -1, "oswald")).toThrow(RangeError);
  });
});

describe("font, style and the plaque colour (R28, R29, R31)", () => {
  test("each changes only its own field; the same value is the same draft", () => {
    const font = setTextFont(SPEC, TEXT, "caveat");
    expect(textOf(font).font).toBe("caveat");
    onlyChanged(font, "font");
    expect(setTextFont(SPEC, TEXT, textOf(SPEC).font)).toBe(SPEC);

    const style = setTextStyle(SPEC, TEXT, "outline");
    expect(textOf(style).style).toBe("outline");
    onlyChanged(style, "style");
    expect(setTextStyle(SPEC, TEXT, textOf(SPEC).style)).toBe(SPEC);

    const color = setTextColor(SPEC, TEXT, "#ffd166");
    expect(textOf(color).color).toBe("#ffd166");
    onlyChanged(color, "color");
    expect(setTextColor(SPEC, TEXT, textOf(SPEC).color)).toBe(SPEC);
  });

  test("a colour must be the contract's lowercase #rrggbb", () => {
    expect(() => setTextColor(SPEC, TEXT, "#FFD166")).toThrow(RangeError);
    expect(() => setTextColor(SPEC, TEXT, "yellow")).toThrow(RangeError);
  });

  test("the six swatches are the artboard's, white first (the styles' own default), each a colour the contract takes", () => {
    expect(TEXT_COLORS.map((c) => c.color)).toEqual(["#ffffff", "#111111", "#ffd166", "#ff9ec4", "#9ad9ff", "#ff7a59"]);
    expect(TEXT_COLORS.map((c) => c.label)).toEqual(["Белый", "Почти чёрный", "Жёлтый", "Розовый", "Голубой", "Коралловый"]);
    for (const { color } of TEXT_COLORS) expect(MontageDraft.safeParse(setTextColor(SPEC, TEXT, color)).success).toBe(true);
  });
});

describe("the size (R30, CF13: the slider moves `scale`, «Размер» shows round(scale × TEXT_BASE_PX))", () => {
  test("the shown size is the rendered pixels at scale 1 times the scale", () => {
    expect(textSize(1)).toBe(TEXT_BASE_PX);
    expect(textSize(0.5)).toBe(28);
    expect(textSize(1.5)).toBe(84);
    expect(textSize(2)).toBe(112);
  });

  test("the bounds are the contract's: it takes 0.5 and 2, and refuses a hundredth past either", () => {
    const at = (scale: number): boolean => TextLayer.safeParse({ ...textOf(SPEC), scale }).success;
    expect([MIN_TEXT_SCALE, MAX_TEXT_SCALE]).toEqual([0.5, 2]);
    expect(at(MIN_TEXT_SCALE)).toBe(true);
    expect(at(MAX_TEXT_SCALE)).toBe(true);
    expect(at(MIN_TEXT_SCALE - 0.01)).toBe(false);
    expect(at(MAX_TEXT_SCALE + 0.01)).toBe(false);
  });

  test("a scale is kept to a hundredth (the layout's own step) and held within the bounds", () => {
    expect(textOf(setTextScale(SPEC, TEXT, 1.234)).scale).toBe(1.23);
    expect(textOf(setTextScale(SPEC, TEXT, 0.5)).scale).toBe(0.5);
    expect(textOf(setTextScale(SPEC, TEXT, 0.49)).scale).toBe(0.5);
    expect(textOf(setTextScale(SPEC, TEXT, 2)).scale).toBe(2);
    expect(textOf(setTextScale(SPEC, TEXT, 2.01)).scale).toBe(2);
    onlyChanged(setTextScale(SPEC, TEXT, 1.5), "scale");
  });

  test("the same scale (after rounding) is the same draft; a scale that is no number is a programming error", () => {
    expect(setTextScale(SPEC, TEXT, 1.001)).toBe(SPEC);
    expect(() => setTextScale(SPEC, TEXT, Number.NaN)).toThrow(RangeError);
  });
});

describe("the «Стили» presets (T2) and «Добавить текст» (T1, AM7)", () => {
  test("six presets as the artboard draws them, each sample a caption the shared rules take", () => {
    expect(TEXT_PRESETS.map((p) => p.label)).toEqual(["Плашка · Manrope", "Обводка · Oswald", "Без фона · Playfair", "Без фона · Caveat", "Плашка · PT Mono", "Обводка · Manrope"]);
    expect(TEXT_PRESETS.map((p) => [p.font, p.style, p.sample])).toEqual([
      ["manrope", "plaque", "sunday reset"],
      ["oswald", "outline", "coffee first"],
      ["playfair", "none", "golden hour"],
      ["caveat", "none", "slow morning"],
      ["ptmono", "plaque", "day 01"],
      ["manrope", "outline", "wait for it"],
    ]);
    for (const preset of TEXT_PRESETS) {
      expect(captionRefusal(preset.sample)).toBe(null);
      expect(captionIssue(preset.sample, { hasEmoji: () => true })).toBe(null);
    }
  });

  function added(edit: LayerEdit): TextLayer {
    if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
    expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
    const layer = edit.spec.layers.at(-1);
    if (layer?.kind !== "text") throw new Error("no text added");
    return layer;
  }

  test("a preset adds a text at the playhead in its font and style, with its sample and the style's default colour", () => {
    const preset = TEXT_PRESETS[1];
    if (preset === undefined) throw new Error("no preset");
    const layer = added(addTextLayer(draftSpec(4), 1_000, preset));
    expect([layer.startMs, layer.endMs, layer.font, layer.style, layer.value, layer.color, layer.scale]).toEqual([1_000, 4_000, "oswald", "outline", "coffee first", "#ffffff", 1]);
  });

  test("with no preset it is the first one with the neutral sample", () => {
    const layer = added(addTextLayer(draftSpec(4), 0));
    expect([layer.font, layer.style, layer.value]).toEqual(["manrope", "plaque", DEFAULT_TEXT_VALUE]);
  });
});

// Review round 1: «a typing burst is one undo step» needs an end. The step closes when the field loses the focus (the panel) or
// after TYPING_PAUSE_MS without typing (here): 1.5 s, a default the owner may change.
describe("when a typing burst ends (one undo step per burst)", () => {
  test("the pause is 1.5 s", () => {
    expect(TYPING_PAUSE_MS).toBe(1_500);
  });

  test("a keystroke within 1.5 s of the last one goes on with the burst; at 1.5 s or later it starts a new one", () => {
    expect(typingGoesOn(10_000, 10_000)).toBe(true);
    expect(typingGoesOn(10_000, 11_499)).toBe(true);
    expect(typingGoesOn(10_000, 11_500)).toBe(false);
    expect(typingGoesOn(10_000, 60_000)).toBe(false);
  });

  test("the first keystroke opens a burst, and a clock that went back never stretches one", () => {
    expect(typingGoesOn(null, 10_000)).toBe(false);
    expect(typingGoesOn(10_000, 9_999)).toBe(false);
  });
});

describe("an emoji chip goes where the caret is (R27)", () => {
  // The caret is the textarea's: UTF-16 units. ☀️ is two (U+2600 U+FE0F), 🥐 two (a surrogate pair), ✨ one.
  test("at the caret, over a selection, and the caret lands after it", () => {
    expect(insertAt("sunday reset", 12, 12, " ☀️")).toEqual({ value: "sunday reset ☀️", caret: 15 });
    expect(insertAt("sunday reset", 0, 6, "🥐")).toEqual({ value: "🥐 reset", caret: 2 });
  });

  test("a caret outside the text is held to its ends, and a reversed selection is read in order", () => {
    expect(insertAt("abc", 99, 99, "✨")).toEqual({ value: "abc✨", caret: 4 });
    expect(insertAt("abc", -4, -1, "🥐")).toEqual({ value: "🥐abc", caret: 2 });
    expect(insertAt("abcd", 3, 1, "-")).toEqual({ value: "a-d", caret: 2 });
  });
});

// 3d.4 (AM10, left by 3d.5 for the engine's real box): a caption reaching a Reels zone is warned about like a sticker, judged on the
// box of the picture the ENGINE drew (`montages.textPreview`'s width and height, placed by the engine's `textBox`), never on an
// estimate; «Сдвинуть внутрь» moves it out by the shortest way, its size kept.
describe("a caption in the Reels zones (AM10)", () => {
  const PICTURE = { width: 400, height: 120 };
  const at = (x: number, y: number): MontageDraft => ({ ...SPEC, layers: SPEC.layers.map((l, i) => (i === TEXT ? { ...l, x, y } : l)) });

  test("which zones its box reaches, bottom first; none in the clear", () => {
    expect(textZones(textOf(at(0.5, 0.95)), PICTURE)).toEqual(["bottom"]);
    expect(textZones(textOf(at(0.95, 0.6)), PICTURE)).toEqual(["right"]);
    expect(textZones(textOf(at(0.9, 0.82)), PICTURE)).toEqual(["bottom", "right"]);
    expect(textZones(textOf(at(0.5, 0.2)), PICTURE)).toEqual([]);
  });

  test("«Сдвинуть внутрь» moves it out of every zone, its size kept; an axis it did not need keeps its value", () => {
    for (const [x, y] of [[0.5, 0.95], [0.95, 0.6], [0.9, 0.82]] as const) {
      const moved = textOf(moveTextInside(at(x, y), TEXT, PICTURE));
      expect(textZones(moved, PICTURE)).toEqual([]);
      expect([moved.value, moved.scale]).toEqual(["sunday reset", 1]);
    }
    expect(textOf(moveTextInside(at(0.5, 0.95), TEXT, PICTURE)).x).toBe(0.5);
  });

  test("the same draft when it reaches no zone", () => {
    const spec = at(0.5, 0.2);
    expect(moveTextInside(spec, TEXT, PICTURE)).toBe(spec);
  });
});
