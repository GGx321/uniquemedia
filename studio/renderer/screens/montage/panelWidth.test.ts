import { describe, expect, test } from "bun:test";
import { clampMediaWidth, keyedWidth, MEDIA_WIDTH, MEDIA_WIDTH_KEY, mediaWidthMax, PROPS_PX, readMediaWidth, STAGE_ROOM_PX, type WidthStorage, writeMediaWidth } from "./panelWidth";

// The media panel's width (the owner's feedback, 2026-10-05): dragged by the splitter between the panel and the stage, kept per viewer in
// localStorage. The panel never gets narrower than its rows can be read at, nor so wide that the stage loses the room the preview needs.

/** A storage that holds what it is given, or throws on every access (a viewer whose storage is blocked). */
function storage(initial: Record<string, string> = {}, broken = false): WidthStorage & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  const guard = (): void => {
    if (broken) throw new DOMException("storage is disabled", "SecurityError");
  };
  return {
    items,
    getItem: (key) => {
      guard();
      return items.get(key) ?? null;
    },
    setItem: (key, value) => {
      guard();
      items.set(key, value);
    },
    removeItem: (key) => {
      guard();
      items.delete(key);
    },
  };
}

describe("how wide the panel may be", () => {
  test("not laid out yet (no width known): the absolute maximum", () => {
    expect(mediaWidthMax(null)).toBe(MEDIA_WIDTH.max);
    expect(mediaWidthMax(0)).toBe(MEDIA_WIDTH.max);
  });

  test("a wide editor: the absolute maximum; a narrow one: what leaves the stage its room, never below the minimum", () => {
    expect(mediaWidthMax(2_000)).toBe(MEDIA_WIDTH.max);
    expect(mediaWidthMax(1_000)).toBe(1_000 - PROPS_PX - STAGE_ROOM_PX);
    expect(mediaWidthMax(500)).toBe(MEDIA_WIDTH.min);
  });

  test("the boundary: the body that leaves exactly the minimum, and one pixel more", () => {
    const tight = MEDIA_WIDTH.min + PROPS_PX + STAGE_ROOM_PX;
    expect(mediaWidthMax(tight)).toBe(MEDIA_WIDTH.min);
    expect(mediaWidthMax(tight + 1)).toBe(MEDIA_WIDTH.min + 1);
    expect(mediaWidthMax(MEDIA_WIDTH.max + PROPS_PX + STAGE_ROOM_PX + 1)).toBe(MEDIA_WIDTH.max);
  });

  // Measured in the renderer: «Обновить список — в Настройках» needs 250 px of the panel's content on one line (280 − 2 × 14 = 252), and a
  // narrower panel never gives the preview more room (it is as tall as the stage long before it is as wide). So the panel only grows.
  test("the minimum is the artboard's 280, the default: the rows were drawn for it, and the panel grows from there", () => {
    expect(MEDIA_WIDTH.default).toBe(280);
    expect(MEDIA_WIDTH.min).toBe(MEDIA_WIDTH.default);
    expect(MEDIA_WIDTH.max).toBe(2 * MEDIA_WIDTH.default);
  });
});

describe("a width held to the range", () => {
  test("below the minimum: the minimum; above the maximum: the maximum; inside: whole pixels", () => {
    expect(clampMediaWidth(100, 400)).toBe(MEDIA_WIDTH.min);
    expect(clampMediaWidth(MEDIA_WIDTH.min - 1, 400)).toBe(MEDIA_WIDTH.min);
    expect(clampMediaWidth(401, 400)).toBe(400);
    expect(clampMediaWidth(333.4, 400)).toBe(333);
  });

  test("not a number: the default (held to the maximum)", () => {
    expect(clampMediaWidth(Number.NaN, 400)).toBe(MEDIA_WIDTH.default);
    expect(clampMediaWidth(Number.POSITIVE_INFINITY, 400)).toBe(MEDIA_WIDTH.default);
    expect(clampMediaWidth(Number.NaN, MEDIA_WIDTH.min)).toBe(MEDIA_WIDTH.min);
  });
});

describe("the keys of the splitter", () => {
  test("→ and ← a 16 px step, ⇧ 64 px; Home and End the ends; Enter the default", () => {
    expect(keyedWidth("ArrowRight", false, 300, 560)).toBe(316);
    expect(keyedWidth("ArrowLeft", false, 300, 560)).toBe(284);
    expect(keyedWidth("ArrowRight", true, 300, 560)).toBe(364);
    expect(keyedWidth("ArrowLeft", true, 300, 560)).toBe(MEDIA_WIDTH.min);
    expect(keyedWidth("Home", false, 300, 560)).toBe(MEDIA_WIDTH.min);
    expect(keyedWidth("End", false, 300, 560)).toBe(560);
    expect(keyedWidth("Enter", false, 400, 560)).toBe(MEDIA_WIDTH.default);
  });

  test("held at the ends: ← at the minimum and → at the maximum stay put", () => {
    expect(keyedWidth("ArrowLeft", false, MEDIA_WIDTH.min, 560)).toBe(MEDIA_WIDTH.min);
    expect(keyedWidth("ArrowRight", false, 555, 560)).toBe(560);
    expect(keyedWidth("ArrowRight", false, 560, 560)).toBe(560);
  });

  test("any other key is not the splitter's", () => {
    for (const key of ["ArrowUp", "ArrowDown", " ", "Tab", "a"]) expect(keyedWidth(key, false, 300, 560)).toBeNull();
  });
});

describe("the viewer's stored width", () => {
  test("nothing stored, or no storage at all: none", () => {
    expect(readMediaWidth(storage())).toBeNull();
    expect(readMediaWidth(null)).toBeNull();
  });

  test("a stored number comes back held to the absolute range; anything else is no width", () => {
    expect(readMediaWidth(storage({ [MEDIA_WIDTH_KEY]: "360" }))).toBe(360);
    expect(readMediaWidth(storage({ [MEDIA_WIDTH_KEY]: "100" }))).toBe(MEDIA_WIDTH.min);
    expect(readMediaWidth(storage({ [MEDIA_WIDTH_KEY]: "99999" }))).toBe(MEDIA_WIDTH.max);
    for (const junk of ["", "wide", "NaN", "320px", "Infinity"]) expect(readMediaWidth(storage({ [MEDIA_WIDTH_KEY]: junk }))).toBeNull();
  });

  test("a storage that throws reads as none and is written without an error", () => {
    const blocked = storage({}, true);
    expect(readMediaWidth(blocked)).toBeNull();
    expect(() => writeMediaWidth(blocked, 320)).not.toThrow();
    expect(() => writeMediaWidth(blocked, null)).not.toThrow();
  });

  test("written as whole pixels; null forgets it", () => {
    const kept = storage();
    writeMediaWidth(kept, 344.6);
    expect(kept.items.get(MEDIA_WIDTH_KEY)).toBe("345");
    writeMediaWidth(kept, null);
    expect(kept.items.has(MEDIA_WIDTH_KEY)).toBe(false);
    expect(() => writeMediaWidth(null, 320)).not.toThrow();
  });
});
