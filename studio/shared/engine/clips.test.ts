import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BOLD_CLIPS,
  clipBilledMicros,
  clipExpectedMicros,
  clipReserveMicros,
  clipWorstMicros,
  ClipCost,
  ClipExport,
  ClipExportProfile,
  ClipFace,
  ClipFailReason,
  ClipMotionChoice,
  ClipOptions,
  ClipQuality,
  ClipSeconds,
  ClipSummary,
  CLIP_OPTION_KEYS,
  EXPORT_FPS,
  GROK_FALLBACK,
  MAX_LISTED_CLIPS,
  type BoldClipsMode,
  type ClipPriceParts,
  type ClipPrices,
} from "./clips";

// Stage 5, 5b.1, S5.V1 (plan s5b1 §5.2, §5.9, §8): the clip contract. The prices below are the dated table of §5.9 (Kling 3.0 std 720p 84 000 µ$/s, pro 1080p 112 000,
// Grok 1.5 720p 140 000 + 10 000 per input image); every figure asserted is a row of §5.9.

const PRICES: ClipPrices = {
  std: { perSecondMicros: 84_000, perInputImageMicros: 0 },
  pro: { perSecondMicros: 112_000, perInputImageMicros: 0 },
  grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 },
};

const parts = (over: Partial<ClipPriceParts> = {}): ClipPriceParts => ({ model: "kling", quality: "std", seconds: 5, mode: "auto", fallback: "auto", bold: false, prices: PRICES, ...over });

const estimate = (expectedMicros: number, worstMicros: number) => ({ expectedMicros, worstMicros, prices: "live" as const, pricesAsOf: "2026-10-13" });

describe("the constants", () => {
  test("GROK_FALLBACK defaults to auto (I5.47)", () => {
    expect(GROK_FALLBACK).toBe("auto");
  });

  test("BOLD_CLIPS is kling-only, the owner's final answer to Q-A (I5.57)", () => {
    expect(BOLD_CLIPS).toBe("kling-only");
  });

  test("EXPORT_FPS defaults to interpolate (I5.55)", () => {
    expect(EXPORT_FPS).toBe("interpolate");
  });

  test("a listing is cut at 500 clips", () => {
    expect(MAX_LISTED_CLIPS).toBe(500);
  });
});

describe("no second copy of the switches", () => {
  const STUDIO = resolve(import.meta.dir, "../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  const DECLARATION = /\b(?:const|let|var)\s+(?:GROK_FALLBACK|BOLD_CLIPS)\b/;

  test("shared/engine/clips.ts declares both", () => {
    const source = readFileSync(join(STUDIO, "shared/engine/clips.ts"), "utf8");
    expect(source).toMatch(/export const GROK_FALLBACK\b/);
    expect(source).toMatch(/export const BOLD_CLIPS\b/);
  });

  test("nothing under engine/ or renderer/ declares either again", () => {
    const copies = [...walk(join(STUDIO, "engine")), ...walk(join(STUDIO, "renderer"))].filter((file) => DECLARATION.test(readFileSync(file, "utf8")));
    expect(copies).toEqual([]);
  });
});

describe("ClipQuality and ClipSeconds", () => {
  test("quality is std or pro", () => {
    expect(ClipQuality.safeParse("std").success).toBe(true);
    expect(ClipQuality.safeParse("pro").success).toBe(true);
    expect(ClipQuality.safeParse("hd").success).toBe(false);
  });

  test("seconds are 5 or 10 and nothing between", () => {
    expect(ClipSeconds.safeParse(5).success).toBe(true);
    expect(ClipSeconds.safeParse(10).success).toBe(true);
    expect(ClipSeconds.safeParse(7).success).toBe(false);
    expect(ClipSeconds.safeParse(0).success).toBe(false);
    expect(ClipSeconds.safeParse("5").success).toBe(false);
  });
});

describe("the per-attempt figures (I5.46)", () => {
  test("a reserve is (seconds + 1) x the per-second price plus the input image", () => {
    expect(clipReserveMicros(PRICES.std, 5)).toBe(504_000);
    expect(clipReserveMicros(PRICES.pro, 10)).toBe(1_232_000);
    expect(clipReserveMicros(PRICES.grok, 5)).toBe(850_000);
    expect(clipReserveMicros(PRICES.grok, 10)).toBe(1_550_000);
  });

  test("a billed figure is the seconds x the per-second price plus the input image", () => {
    expect(clipBilledMicros(PRICES.std, 5)).toBe(420_000);
    expect(clipBilledMicros(PRICES.pro, 5)).toBe(560_000);
    expect(clipBilledMicros(PRICES.grok, 5)).toBe(710_000);
    expect(clipBilledMicros(PRICES.grok, 10)).toBe(1_410_000);
  });
});

describe("a price that cannot be a price", () => {
  test("a negative, infinite or missing per-second price is refused loudly, never reserved as NaN", () => {
    expect(() => clipReserveMicros({ perSecondMicros: -1, perInputImageMicros: 0 }, 5)).toThrow(RangeError);
    expect(() => clipReserveMicros({ perSecondMicros: Number.POSITIVE_INFINITY, perInputImageMicros: 0 }, 5)).toThrow(RangeError);
    expect(() => clipBilledMicros({ perSecondMicros: Number.NaN, perInputImageMicros: 0 }, 5)).toThrow(RangeError);
  });

  test("a negative input-image price is refused too", () => {
    expect(() => clipBilledMicros({ perSecondMicros: 84_000, perInputImageMicros: -1 }, 5)).toThrow(RangeError);
  });

  test("a fractional per-second price is refused by both formulas: prices are whole micro-dollars", () => {
    expect(() => clipReserveMicros({ perSecondMicros: 84_000.5, perInputImageMicros: 0 }, 5)).toThrow(RangeError);
    expect(() => clipBilledMicros({ perSecondMicros: 84_000.5, perInputImageMicros: 0 }, 5)).toThrow(RangeError);
  });

  test("a fractional input-image price is refused by both formulas", () => {
    expect(() => clipReserveMicros({ perSecondMicros: 84_000, perInputImageMicros: 0.5 }, 5)).toThrow(RangeError);
    expect(() => clipBilledMicros({ perSecondMicros: 84_000, perInputImageMicros: 0.5 }, 5)).toThrow(RangeError);
  });

  test("a price past the safe integers is refused by both formulas", () => {
    const huge = { perSecondMicros: Number.MAX_SAFE_INTEGER + 1, perInputImageMicros: 0 };
    expect(() => clipReserveMicros(huge, 5)).toThrow(RangeError);
    expect(() => clipBilledMicros(huge, 5)).toThrow(RangeError);
  });

  test("a result past the safe integers is refused by both formulas", () => {
    const big = { perSecondMicros: Number.MAX_SAFE_INTEGER, perInputImageMicros: 0 };
    expect(() => clipReserveMicros(big, 5)).toThrow(RangeError);
    expect(() => clipBilledMicros(big, 5)).toThrow(RangeError);
  });

  test("a free model (0) is a legal price", () => {
    expect(clipReserveMicros({ perSecondMicros: 0, perInputImageMicros: 0 }, 5)).toBe(0);
  });
});

describe("clipWorstMicros: the rows of plan §5.9", () => {
  const ROWS: ReadonlyArray<[string, Partial<ClipPriceParts>, number, number]> = [
    // [name, parts, worst in mode auto, worst in mode offer]
    ["std 5 s", { quality: "std", seconds: 5 }, 850_000, 504_000],
    ["pro 5 s", { quality: "pro", seconds: 5 }, 850_000, 672_000],
    ["std 10 s", { quality: "std", seconds: 10 }, 1_550_000, 924_000],
    ["pro 10 s", { quality: "pro", seconds: 10 }, 1_550_000, 1_232_000],
  ];

  for (const [name, over, auto, offer] of ROWS) {
    test(`${name}: the dearest branch in mode auto, Kling alone in mode offer`, () => {
      expect(clipWorstMicros(parts({ ...over, mode: "auto" }))).toBe(auto);
      expect(clipWorstMicros(parts({ ...over, mode: "offer" }))).toBe(offer);
    });

    test(`${name}: fallback none is Kling alone in both modes`, () => {
      expect(clipWorstMicros(parts({ ...over, mode: "auto", fallback: "none" }))).toBe(offer);
      expect(clipWorstMicros(parts({ ...over, mode: "offer", fallback: "none" }))).toBe(offer);
    });

    test(`${name}: a frame of «Смелая» under kling-only is Kling alone, whatever fallback was asked`, () => {
      expect(clipWorstMicros(parts({ ...over, mode: "auto", fallback: "auto", bold: true, boldClips: "kling-only" }))).toBe(offer);
      expect(clipWorstMicros(parts({ ...over, mode: "auto", fallback: "auto", bold: true }))).toBe(offer);
    });
  }

  test("a frame of «Смелая» under with-fallback follows the engine's mode like any other frame", () => {
    expect(clipWorstMicros(parts({ bold: true, boldClips: "with-fallback", mode: "auto", fallback: "auto" }))).toBe(850_000);
    expect(clipWorstMicros(parts({ bold: true, boldClips: "with-fallback", mode: "offer", fallback: "auto" }))).toBe(504_000);
  });

  test("a frame of «Смелая» under off never sends Grok either", () => {
    expect(clipWorstMicros(parts({ bold: true, boldClips: "off", mode: "auto", fallback: "auto" }))).toBe(504_000);
  });

  test("a Grok clip (the offer) is Grok's reserve alone, in both modes and whatever fallback was asked", () => {
    expect(clipWorstMicros(parts({ model: "grok", seconds: 5, mode: "offer", fallback: "none" }))).toBe(850_000);
    expect(clipWorstMicros(parts({ model: "grok", seconds: 10, mode: "offer", fallback: "none" }))).toBe(1_550_000);
    expect(clipWorstMicros(parts({ model: "grok", seconds: 5, mode: "auto", fallback: "auto" }))).toBe(850_000);
  });

  test("when Kling's reserve is the dearer branch it is the worst (a price book where Grok is cheap)", () => {
    const cheapGrok: ClipPrices = { ...PRICES, grok: { perSecondMicros: 10_000, perInputImageMicros: 0 } };
    expect(clipWorstMicros(parts({ prices: cheapGrok, mode: "auto", fallback: "auto" }))).toBe(504_000);
  });
});

describe("clipExpectedMicros: the billed figure of the model that runs first", () => {
  test("Kling std and pro, 5 and 10 s", () => {
    expect(clipExpectedMicros(parts({ quality: "std", seconds: 5 }))).toBe(420_000);
    expect(clipExpectedMicros(parts({ quality: "pro", seconds: 5 }))).toBe(560_000);
    expect(clipExpectedMicros(parts({ quality: "std", seconds: 10 }))).toBe(840_000);
    expect(clipExpectedMicros(parts({ quality: "pro", seconds: 10 }))).toBe(1_120_000);
  });

  test("Grok, 5 and 10 s", () => {
    expect(clipExpectedMicros(parts({ model: "grok", seconds: 5 }))).toBe(710_000);
    expect(clipExpectedMicros(parts({ model: "grok", seconds: 10 }))).toBe(1_410_000);
  });

  test("the mode, the fallback and the frame's level do not move it", () => {
    expect(clipExpectedMicros(parts({ mode: "offer", fallback: "none", bold: true }))).toBe(420_000);
  });
});

describe("clipWorstMicros never falls below a branch that can run (brute force)", () => {
  const QUALITIES = ["std", "pro"] as const;
  const SECONDS = [5, 10] as const;
  const MODES = ["auto", "offer"] as const;
  const FALLBACKS = ["auto", "none"] as const;
  const MODELS = ["kling", "grok"] as const;
  const BOLD_MODES: readonly BoldClipsMode[] = ["kling-only", "with-fallback", "off"];
  const PRICE_BOOKS: readonly ClipPrices[] = [
    PRICES,
    { ...PRICES, grok: { perSecondMicros: 1, perInputImageMicros: 0 } },
    { ...PRICES, std: { perSecondMicros: 900_000, perInputImageMicros: 5 } },
    { std: { perSecondMicros: 83_333, perInputImageMicros: 1 }, pro: { perSecondMicros: 111_111, perInputImageMicros: 0 }, grok: { perSecondMicros: 139_999, perInputImageMicros: 9_999 } },
  ];

  test("over models x options x modes x fallbacks x levels x price books", () => {
    let combinations = 0;
    for (const prices of PRICE_BOOKS)
      for (const model of MODELS)
        for (const quality of QUALITIES)
          for (const seconds of SECONDS)
            for (const mode of MODES)
              for (const fallback of FALLBACKS)
                for (const bold of [false, true])
                  for (const boldClips of BOLD_MODES) {
                    const p = parts({ prices, model, quality, seconds, mode, fallback, bold, boldClips });
                    const worst = clipWorstMicros(p);
                    const first = model === "grok" ? prices.grok : prices[quality];
                    expect(Number.isInteger(worst)).toBe(true);
                    expect(worst).toBeGreaterThanOrEqual(clipReserveMicros(first, seconds));
                    expect(worst).toBeGreaterThanOrEqual(clipExpectedMicros(p));
                    // The Grok branch can run only on a Kling clip, in mode auto, with a fallback, and not on a frame of «Смелая» that kling-only or off keep to Kling.
                    const boldKeptToKling = bold && boldClips !== "with-fallback";
                    if (model === "kling" && mode === "auto" && fallback === "auto" && !boldKeptToKling) expect(worst).toBeGreaterThanOrEqual(clipReserveMicros(prices.grok, seconds));
                    combinations += 1;
                  }
    expect(combinations).toBe(4 * 2 * 2 * 2 * 2 * 2 * 2 * 3);
  });

  test("the expected figure never exceeds the worst, so an Estimate built from the pair parses", () => {
    for (const quality of QUALITIES)
      for (const seconds of SECONDS)
        for (const model of MODELS) {
          const p = parts({ quality, seconds, model });
          expect(clipExpectedMicros(p)).toBeLessThanOrEqual(clipWorstMicros(p));
        }
  });
});

describe("ClipMotionChoice", () => {
  const scene = { id: "scene", source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" };
  const code = { id: "g-blink-smile", source: "code", label: "Моргает и улыбается", text: "she blinks and smiles a little" };

  test("the photo's own scene motion is `scene`", () => {
    expect(ClipMotionChoice.safeParse(scene).success).toBe(true);
  });

  test("a code motion is `g-` and a slug", () => {
    expect(ClipMotionChoice.safeParse(code).success).toBe(true);
  });

  test("an id that is neither `scene` nor `g-…` is refused", () => {
    expect(ClipMotionChoice.safeParse({ ...code, id: "x-blink" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code, id: "g-" }).success).toBe(false);
  });

  test("the id `scene` belongs to the source `scene` only", () => {
    expect(ClipMotionChoice.safeParse({ ...scene, source: "code" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code, source: "scene" }).success).toBe(false);
  });

  test("a label is at most 40 characters and not empty", () => {
    expect(ClipMotionChoice.safeParse({ ...code, label: "я".repeat(40) }).success).toBe(true);
    expect(ClipMotionChoice.safeParse({ ...code, label: "я".repeat(41) }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code, label: "" }).success).toBe(false);
  });

  test("an empty text is refused, and so is a key the contract does not know", () => {
    expect(ClipMotionChoice.safeParse({ ...code, text: "" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code, extra: 1 }).success).toBe(false);
  });
});

describe("ClipOptions", () => {
  const motion = { id: "scene", source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" };
  const code = { id: "g-blink-smile", source: "code", label: "Моргает и улыбается", text: "she blinks and smiles a little" };
  const prices = { std5: estimate(420_000, 850_000), pro5: estimate(560_000, 850_000), std10: estimate(840_000, 1_550_000), pro10: estimate(1_120_000, 1_550_000), grok5: estimate(710_000, 850_000), grok10: estimate(1_410_000, 1_550_000) };
  const noFallbackPrices = { std5: estimate(420_000, 504_000), pro5: estimate(560_000, 672_000), std10: estimate(840_000, 924_000), pro10: estimate(1_120_000, 1_232_000) };
  const fits = { std5: "with-fallback", pro5: "with-fallback", std10: "without-fallback", pro10: "none" };
  const suitable = { suitable: true, photoId: "photo-0001", motions: [motion, code], prices, fallback: "auto", bold: false, noFallbackPrices, monthFits: fits };
  const unsuitable = { suitable: false, photoId: "photo-0001", reason: "no-motion" };

  test("a suitable photo parses", () => {
    expect(ClipOptions.safeParse(suitable).success).toBe(true);
  });

  test("the option keys are the four Kling options", () => {
    expect([...CLIP_OPTION_KEYS]).toEqual(["std5", "pro5", "std10", "pro10"]);
  });

  test("an unsuitable photo carries exactly one reason", () => {
    expect(ClipOptions.safeParse(unsuitable).success).toBe(true);
    expect(ClipOptions.safeParse({ ...unsuitable, reason: undefined }).success).toBe(false);
    expect(ClipOptions.safeParse({ suitable: false, photoId: "photo-0001" }).success).toBe(false);
  });

  test("an unsuitable photo takes each of the six reasons and no other", () => {
    for (const reason of ["no-motion", "not-a-gallery-photo", "age-unverified", "photo-unreadable", "not-vertical", "bold-off"]) {
      expect(ClipOptions.safeParse({ ...unsuitable, reason }).success).toBe(true);
    }
    for (const reason of ["unknown-motion", "grok-not-offered", "one-at-a-time", "download-expired", "other"]) {
      expect(ClipOptions.safeParse({ ...unsuitable, reason }).success).toBe(false);
    }
  });

  test("an unsuitable photo carries no prices or motions", () => {
    expect(ClipOptions.safeParse({ ...unsuitable, prices }).success).toBe(false);
    expect(ClipOptions.safeParse({ ...unsuitable, motions: [motion] }).success).toBe(false);
  });

  test("a suitable photo has one to four motions", () => {
    expect(ClipOptions.safeParse({ ...suitable, motions: [] }).success).toBe(false);
    expect(ClipOptions.safeParse({ ...suitable, motions: [motion] }).success).toBe(true);
    const four = [motion, code, { ...code, id: "g-a" }, { ...code, id: "g-b" }];
    expect(ClipOptions.safeParse({ ...suitable, motions: four }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...suitable, motions: [...four, { ...code, id: "g-c" }] }).success).toBe(false);
  });

  test("a motion id does not repeat", () => {
    expect(ClipOptions.safeParse({ ...suitable, motions: [code, code] }).success).toBe(false);
  });

  test("fallback is auto, offer or none", () => {
    const alone = { std5: "without-fallback", pro5: "without-fallback", std10: "none", pro10: "none" };
    expect(ClipOptions.safeParse({ ...suitable, fallback: "auto" }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...suitable, fallback: "offer", monthFits: alone }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...suitable, fallback: "none", monthFits: alone }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...suitable, fallback: "grok" }).success).toBe(false);
  });

  test("fallback none: monthFits never says with-fallback", () => {
    const alone = { std5: "without-fallback", pro5: "without-fallback", std10: "without-fallback", pro10: "none" };
    expect(ClipOptions.safeParse({ ...suitable, fallback: "none", monthFits: alone }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...suitable, fallback: "none", monthFits: { ...alone, std5: "with-fallback" } }).success).toBe(false);
    expect(ClipOptions.safeParse({ ...suitable, fallback: "none" }).success).toBe(false);
  });

  test("a frame of «Смелая» (kling-only) has fallback none", () => {
    const bold = { ...suitable, bold: true, fallback: "none", monthFits: { ...fits, std5: "without-fallback", pro5: "without-fallback" } };
    expect(ClipOptions.safeParse(bold).success).toBe(true);
    expect(ClipOptions.safeParse({ ...bold, fallback: "auto" }).success).toBe(false);
    expect(ClipOptions.safeParse({ ...bold, fallback: "offer" }).success).toBe(false);
  });

  test("fallback offer: monthFits never says with-fallback either (no Grok reserve stands behind an offer)", () => {
    const alone = { std5: "without-fallback", pro5: "without-fallback", std10: "none", pro10: "none" };
    expect(ClipOptions.safeParse({ ...suitable, fallback: "offer", monthFits: alone }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...suitable, fallback: "offer", monthFits: { ...alone, std5: "with-fallback" } }).success).toBe(false);
  });

  test("an ordinary frame may have fallback none (the owner's choice, or a month that fits Kling alone)", () => {
    expect(ClipOptions.safeParse({ ...suitable, fallback: "none", bold: false, monthFits: { std5: "without-fallback", pro5: "none", std10: "none", pro10: "none" } }).success).toBe(true);
  });

  test("monthFits names every option and no other value", () => {
    const { pro10: _pro10, ...missing } = fits;
    expect(ClipOptions.safeParse({ ...suitable, monthFits: missing }).success).toBe(false);
    expect(ClipOptions.safeParse({ ...suitable, monthFits: { ...fits, std5: "maybe" } }).success).toBe(false);
  });

  test("the prices cover all six options and the Kling-alone prices the four Kling ones", () => {
    const { grok10: _grok10, ...missing } = prices;
    expect(ClipOptions.safeParse({ ...suitable, prices: missing }).success).toBe(false);
    const { pro10: _pro10, ...missingAlone } = noFallbackPrices;
    expect(ClipOptions.safeParse({ ...suitable, noFallbackPrices: missingAlone }).success).toBe(false);
  });

  test("a price whose expected cost exceeds its worst case is refused", () => {
    expect(ClipOptions.safeParse({ ...suitable, prices: { ...prices, std5: { ...prices.std5, expectedMicros: 900_000 } } }).success).toBe(false);
  });

  test("a key the contract does not know is refused", () => {
    expect(ClipOptions.safeParse({ ...suitable, extra: true }).success).toBe(false);
    expect(ClipOptions.safeParse({ ...unsuitable, extra: true }).success).toBe(false);
  });
});

describe("ClipCost", () => {
  test("the four kinds", () => {
    for (const kind of ["billed", "estimated", "open"]) expect(ClipCost.safeParse({ micros: 420_000, kind }).success).toBe(true);
    expect(ClipCost.safeParse({ micros: 0, kind: "free" }).success).toBe(true);
    expect(ClipCost.safeParse({ micros: 1, kind: "paid" }).success).toBe(false);
  });

  test("free is only ever 0", () => {
    expect(ClipCost.safeParse({ micros: 1, kind: "free" }).success).toBe(false);
  });

  test("money is a whole number of micro-dollars, never negative", () => {
    expect(ClipCost.safeParse({ micros: 0.5, kind: "billed" }).success).toBe(false);
    expect(ClipCost.safeParse({ micros: -1, kind: "billed" }).success).toBe(false);
  });
});

describe("ClipFace", () => {
  test("a match and a mismatch carry the p75 and the frames", () => {
    expect(ClipFace.safeParse({ verdict: "match", p75: 0.71, frames: 11 }).success).toBe(true);
    expect(ClipFace.safeParse({ verdict: "mismatch", p75: 0.48, frames: 11 }).success).toBe(true);
  });

  test("a skipped check says why, and `why` belongs to skipped only", () => {
    for (const why of ["hidden", "profile", "few-faces", "worker"]) expect(ClipFace.safeParse({ verdict: "skipped", why, frames: 0 }).success).toBe(true);
    expect(ClipFace.safeParse({ verdict: "skipped", frames: 0 }).success).toBe(true);
    expect(ClipFace.safeParse({ verdict: "match", p75: 0.7, frames: 11, why: "hidden" }).success).toBe(false);
    expect(ClipFace.safeParse({ verdict: "skipped", why: "other", frames: 0 }).success).toBe(false);
  });

  test("a match or a mismatch has a p75, a skipped check has none", () => {
    expect(ClipFace.safeParse({ verdict: "match", frames: 11 }).success).toBe(false);
    expect(ClipFace.safeParse({ verdict: "skipped", p75: 0.5, frames: 2, why: "few-faces" }).success).toBe(false);
  });

  test("a p75 is a similarity between -1 and 1", () => {
    expect(ClipFace.safeParse({ verdict: "match", p75: 1.01, frames: 11 }).success).toBe(false);
    expect(ClipFace.safeParse({ verdict: "mismatch", p75: -1.01, frames: 11 }).success).toBe(false);
  });
});

describe("ClipExportProfile and ClipExport", () => {
  const exported = { rootId: "root-00000001", relPath: "Nini/2026-10-13_clip_001.mp4", profile: "1080p30-interp", at: "2026-10-13T10:00:00.000Z", bytes: 4_000_000, sha256: "a".repeat(64) };

  test("the profile says which fps mode made the file: interpolated, duplicated or native 24", () => {
    expect([...ClipExportProfile.options]).toEqual(["1080p30-interp", "1080p30-dup", "1080p24"]);
  });

  test("the first draft's single profile is gone", () => {
    expect(ClipExportProfile.safeParse("reencode-1080p30").success).toBe(false);
  });

  test("an export parses with each profile", () => {
    for (const profile of ClipExportProfile.options) expect(ClipExport.safeParse({ ...exported, profile }).success).toBe(true);
  });

  test("fileState is optional, and is the shared FileState including changed", () => {
    for (const fileState of ["present", "missing", "changed", "elsewhere", "unchecked"]) expect(ClipExport.safeParse({ ...exported, fileState }).success).toBe(true);
    expect(ClipExport.safeParse({ ...exported, fileState: "gone" }).success).toBe(false);
  });

  test("the file is named like a render's: <SafeName>/<date>_<kind>_<NNN>.mp4", () => {
    expect(ClipExport.safeParse({ ...exported, relPath: "../x.mp4" }).success).toBe(false);
    expect(ClipExport.safeParse({ ...exported, relPath: "/Users/alex/x.mp4" }).success).toBe(false);
  });

  test("the sha256 is 64 lowercase hex characters and the size is positive", () => {
    expect(ClipExport.safeParse({ ...exported, sha256: "A".repeat(64) }).success).toBe(false);
    expect(ClipExport.safeParse({ ...exported, sha256: "a".repeat(63) }).success).toBe(false);
    expect(ClipExport.safeParse({ ...exported, bytes: 0 }).success).toBe(false);
  });
});

describe("ClipFailReason", () => {
  test("is the closed set of §5.2", () => {
    const actual: string[] = [...ClipFailReason.options];
    expect(actual.sort()).toEqual(
      [
        "refused-free",
        "refused-both",
        "refused-paid",
        "refused-unknown",
        "provider-error",
        "grok-no-room",
        "bad-request",
        "submit-uncertain",
        "late",
        "lost",
        "download-failed",
        "invalid-file",
        "disk-full",
        "no-credits",
        "key-invalid",
        "rate-limited",
        "download-expired",
      ].sort(),
    );
  });
});

describe("ClipSummary", () => {
  const base = {
    clipId: "clip-0000001",
    avatarId: "avatar-aaaa-0001",
    photoId: "photo-0001",
    createdAt: "2026-10-13T10:00:00.000Z",
    seen: false,
    motion: { source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    model: "kling-std",
    fallback: false,
    recovered: false,
    cost: { micros: 420_000, kind: "billed" },
    exports: [],
  };
  const ready = { ...base, status: "ready", width: 720, height: 1280, durationMs: 5_000, face: { verdict: "match", p75: 0.71, frames: 11 } };
  const failed = { ...base, status: "failed", cost: { micros: 0, kind: "free" }, failure: { reason: "refused-free" } };

  test("a ready clip parses", () => {
    expect(ClipSummary.safeParse(ready).success).toBe(true);
  });

  test("a failed clip parses", () => {
    expect(ClipSummary.safeParse(failed).success).toBe(true);
  });

  test("a ready clip requires its face", () => {
    const { face: _face, ...noFace } = ready;
    expect(ClipSummary.safeParse(noFace).success).toBe(false);
  });

  test("a failed clip requires its failure", () => {
    const { failure: _failure, ...noFailure } = failed;
    expect(ClipSummary.safeParse(noFailure).success).toBe(false);
  });

  test("a failed clip has no file facts and a ready clip has no failure", () => {
    expect(ClipSummary.safeParse({ ...failed, width: 720 }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...ready, failure: { reason: "late" } }).success).toBe(false);
  });

  test("a failure may carry the Grok offer (an Estimate) and a retry time", () => {
    const offer = { ...failed, failure: { reason: "refused-free", grokOffer: estimate(710_000, 850_000) } };
    expect(ClipSummary.safeParse(offer).success).toBe(true);
    const retry = { ...failed, cost: { micros: 420_000, kind: "billed" }, failure: { reason: "download-failed" }, retryDownloadUntil: "2026-10-13T11:00:00.000Z" };
    expect(ClipSummary.safeParse(retry).success).toBe(true);
  });

  test("retryDownloadUntil belongs to a failed download only, as in the record", () => {
    const until = "2026-10-13T11:00:00.000Z";
    for (const reason of ["download-failed", "invalid-file", "disk-full"]) {
      expect(ClipSummary.safeParse({ ...failed, failure: { reason }, retryDownloadUntil: until }).success).toBe(true);
    }
    expect(ClipSummary.safeParse({ ...failed, failure: { reason: "refused-free" }, retryDownloadUntil: until }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...failed, failure: { reason: "download-expired" }, retryDownloadUntil: until }).success).toBe(false);
  });

  test("the cost kind free is only ever 0", () => {
    expect(ClipSummary.safeParse({ ...failed, cost: { micros: 5, kind: "free" } }).success).toBe(false);
  });

  test("the model is the one that made the file: kling-std, kling-pro or grok", () => {
    for (const model of ["kling-std", "kling-pro", "grok"]) expect(ClipSummary.safeParse({ ...ready, model }).success).toBe(true);
    expect(ClipSummary.safeParse({ ...ready, model: "kling" }).success).toBe(false);
  });

  test("the request is what the owner asked for", () => {
    expect(ClipSummary.safeParse({ ...ready, request: { model: "grok", quality: "pro", seconds: 10, fallback: "none" } }).success).toBe(true);
    expect(ClipSummary.safeParse({ ...ready, request: { model: "kling", quality: "std", seconds: 5, fallback: "offer" } }).success).toBe(false);
  });

  test("the exports list carries the shared FileState and a bad one is refused", () => {
    const exported = { rootId: "root-00000001", relPath: "Nini/2026-10-13_clip_001.mp4", profile: "1080p30-interp", at: "2026-10-13T10:00:00.000Z", bytes: 4_000_000, sha256: "a".repeat(64), fileState: "changed" };
    expect(ClipSummary.safeParse({ ...ready, exports: [exported] }).success).toBe(true);
    expect(ClipSummary.safeParse({ ...ready, exports: [{ ...exported, profile: "reencode-1080p30" }] }).success).toBe(false);
  });

  test("a key the contract does not know is refused", () => {
    expect(ClipSummary.safeParse({ ...ready, extra: 1 }).success).toBe(false);
  });
});
