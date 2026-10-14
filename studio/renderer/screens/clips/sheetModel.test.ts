import { describe, expect, test } from "bun:test";
import type { ClipMonthFit, ClipOptions, Estimate } from "../../../shared/engine";
import { sheetView } from "./sheetModel";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §6 38, 38c, 38e; README «Деньги на экране»): what the «Оживить фото» sheet shows for each option, read off the engine's `clips.options` and nothing
// else. The price line, the buttons' ceilings and which buttons there are come from the engine's estimates and its `monthFits`; the sheet adds and compares no figure.

type Suitable = Extract<ClipOptions, { suitable: true }>;
const est = (expectedMicros: number, worstMicros: number): Estimate => ({ expectedMicros, worstMicros, prices: "live", pricesAsOf: "2026-10-10" });
const KLING = { std5: est(420_000, 504_000), pro5: est(560_000, 672_000), std10: est(840_000, 924_000), pro10: est(1_120_000, 1_232_000) };
const AUTO = { std5: est(420_000, 850_000), pro5: est(560_000, 850_000), std10: est(840_000, 1_550_000), pro10: est(1_120_000, 1_550_000) };
const GROK = { grok5: est(710_000, 850_000), grok10: est(1_410_000, 1_550_000) };
const fits = (fit: ClipMonthFit) => ({ std5: fit, pro5: fit, std10: fit, pro10: fit });

function options(fallback: "auto" | "offer" | "none", over: Partial<Suitable> = {}): Suitable {
  const kling = fallback === "auto" ? AUTO : KLING;
  return {
    suitable: true,
    photoId: "photo-nini-0007",
    motions: [{ id: "g-blink", source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" }],
    prices: { ...kling, ...GROK },
    fallback,
    bold: fallback === "none",
    noFallbackPrices: KLING,
    monthFits: fits(fallback === "auto" ? "with-fallback" : "without-fallback"),
    ...over,
  };
}

const at = (o: Suitable, quality: "std" | "pro", seconds: 5 | 10) => sheetView(o, { motionId: "g-blink", quality, seconds });

describe("the price line and the button, per option and mode (README «Деньги на экране»)", () => {
  const table: [string, "std" | "pro", 5 | 10, string, string][] = [
    ["Обычное · 5 секунд", "std", 5, "$0.42", "$0.85"],
    ["Чётче · 5 секунд", "pro", 5, "$0.56", "$0.85"],
    ["Обычное · 10 секунд", "std", 10, "$0.84", "$1.55"],
    ["Чётче · 10 секунд", "pro", 10, "$1.12", "$1.55"],
  ];
  for (const [name, quality, seconds, expected, worst] of table) {
    test(`mode auto, ${name}: «Обычно ${expected} · не больше ${worst}», «Оживить · до ${worst}»`, () => {
      const v = at(options("auto"), quality, seconds);
      expect([v.expected, v.worst, v.main.label]).toEqual([expected, worst, `до ${worst}`]);
    });
  }
  const offer: [string, "std" | "pro", 5 | 10, string, string][] = [
    ["Обычное · 5 секунд", "std", 5, "$0.42", "$0.51"],
    ["Чётче · 5 секунд", "pro", 5, "$0.56", "$0.68"],
    ["Обычное · 10 секунд", "std", 10, "$0.84", "$0.93"],
    ["Чётче · 10 секунд", "pro", 10, "$1.12", "$1.24"],
  ];
  for (const [name, quality, seconds, expected, worst] of offer) {
    test(`mode offer (and «Смелая»), ${name}: Kling alone, «не больше ${worst}»`, () => {
      expect(at(options("offer"), quality, seconds)).toMatchObject({ expected, worst, main: { label: `до ${worst}` } });
      expect(at(options("none"), quality, seconds)).toMatchObject({ expected, worst, main: { label: `до ${worst}` } });
    });
  }

  test("the accepted worst sent is the engine's own figure for the option on show", () => {
    expect(at(options("auto"), "pro", 10).main.worstMicros).toBe(1_550_000);
    expect(at(options("offer"), "pro", 10).main.worstMicros).toBe(1_232_000);
  });
});

describe("the lines under the price (38, 38e)", () => {
  test("«Модель» follows «Качество»: «Kling 3.0 · 720p», on «Чётче» «Kling 3.0 · 1080p» (the approved 38's label)", () => {
    expect(at(options("auto"), "std", 5).modelLine).toBe("Kling 3.0 · 720p");
    expect(at(options("auto"), "pro", 5).modelLine).toBe("Kling 3.0 · 1080p");
    expect(at(options("offer"), "pro", 10).modelLine).toBe("Kling 3.0 · 1080p");
  });

  test("the Grok line only in mode auto; «Запасная модель (Grok) снимает в 720p» only with «Чётче» in mode auto", () => {
    expect([at(options("auto"), "std", 5).autoNote, at(options("auto"), "std", 5).proNote]).toEqual([true, false]);
    expect(at(options("auto"), "pro", 5).proNote).toBe(true);
    expect([at(options("offer"), "pro", 5).autoNote, at(options("offer"), "pro", 5).proNote]).toEqual([false, false]);
  });

  test("38e: a frame of «Смелая» has the no-fallback line in place of the Grok line, no «без запасной модели» and no 720p line", () => {
    const v = at(options("none"), "pro", 5);
    expect([v.boldNote, v.autoNote, v.proNote, v.noFallback]).toEqual([true, false, false, null]);
    expect(at(options("offer"), "std", 5).boldNote).toBe(false);
  });
});

describe("the month (38c): what fits is the engine's `monthFits`, never a sum here", () => {
  test("auto, the room fits Kling alone: «Оживить» waits beside «Оживить без запасной модели · до $0.51», the notice names the option's need", () => {
    const v = at(options("auto", { monthFits: fits("without-fallback") }), "std", 5);
    expect(v.fits).toBe(false);
    expect(v.noFallback).toEqual({ worstMicros: 504_000, label: "до $0.51" });
    expect(v.budgetNeed).toBe("$0.85");
  });

  test("auto, the room fits neither: no second button, the notice", () => {
    const v = at(options("auto", { monthFits: fits("none") }), "std", 5);
    expect([v.fits, v.noFallback, v.budgetNeed]).toEqual([false, null, "$0.85"]);
  });

  test("auto, the room fits both: the main button, no notice, no second button", () => {
    const v = at(options("auto"), "std", 5);
    expect([v.fits, v.noFallback, v.budgetNeed]).toEqual([true, null, null]);
  });

  test("offer and «Смелая»: Kling alone fits or not (`without-fallback` / `none`); never a second button", () => {
    expect(at(options("offer"), "std", 5)).toMatchObject({ fits: true, noFallback: null, budgetNeed: null });
    expect(at(options("offer", { monthFits: fits("none") }), "std", 5)).toMatchObject({ fits: false, noFallback: null, budgetNeed: "$0.51" });
    expect(at(options("none", { monthFits: fits("none") }), "pro", 10)).toMatchObject({ fits: false, noFallback: null, budgetNeed: "$1.24" });
  });

  test("the fit is read per option: 1080p or 10 s that does not fit while 5 s 720p does", () => {
    const o = options("auto", { monthFits: { std5: "with-fallback", pro5: "without-fallback", std10: "none", pro10: "none" } });
    expect(at(o, "std", 5).fits).toBe(true);
    expect(at(o, "pro", 5).noFallback?.label).toBe("до $0.68");
    expect(at(o, "std", 10)).toMatchObject({ fits: false, noFallback: null });
  });
});
