import { describe, expect, test } from "bun:test";
import { PriceBook } from "../../engine/money/prices";
import { suggestPrice, translatePrice } from "../../engine/clips/motionPrice";
import { frameFactsOf } from "../../engine/clips/frameFacts";
import { checkModelText as engineCheck, normalizeModelText as engineNormalize } from "../../engine/clips/motionCall";
import { planlessPhoto } from "../../engine/clips/testing/frameFixtures";
import { contentLevelOf } from "../../shared/scenes/contentLine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { checkModelText, MOCK_MOTION_PROBLEMS, MOCK_SUGGEST_PRICE, MOCK_TRANSLATE_PRICE, normalizeModelText } from "./mockClipMotions";
import { MOTION_PROBLEMS } from "../../shared/engine";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.6 «C», I5.66, I5.68): the mock cannot import `engine/`, so what the engine decides with is written out in mockClipMotions.ts and HELD to the engine here, by a test that can import both:
// the two prices (they follow the engine's PROVISIONAL system prompts: the day S5.WCX changes a prompt this test fails and says which figure to move), the normalising of a model's text, and the motion check on the frames the
// mock plays. The SHARED check (shared/scenes/motionText.ts) is imported by both; what is compared is the wrapper around it. Fixed seed, 400 cases, well under 2 s.

const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
const MODEL = "x-ai/grok-4.3";

describe("the prices", () => {
  test("estimateSuggest is the engine's figure at the bundled table", () => {
    const engine = suggestPrice(PRICED, MODEL);
    expect({ expectedMicros: engine.expectedMicros, worstMicros: engine.worstMicros }).toEqual(MOCK_SUGGEST_PRICE);
  });

  test("estimateIdea is the engine's figure at the bundled table", () => {
    const engine = translatePrice(PRICED, MODEL);
    expect({ expectedMicros: engine.expectedMicros, worstMicros: engine.worstMicros }).toEqual(MOCK_TRANSLATE_PRICE);
  });

  test("a call's worst case is two attempts of a whole number of micro-dollars", () => {
    expect(MOCK_SUGGEST_PRICE.worstMicros % 2).toBe(0);
    expect(MOCK_TRANSLATE_PRICE.worstMicros % 2).toBe(0);
  });

  test("the mock's closed list of problems is the contract's", () => {
    expect(MOCK_MOTION_PROBLEMS).toEqual(MOTION_PROBLEMS);
  });
});

const ordinary = frameFactsOf(planlessPhoto("home", { faceCos: 0.86 }), null);
const bold = frameFactsOf(planlessPhoto("nightwear", { faceCos: 0.86 }), null);
if (ordinary.kind !== "gallery" || bold.kind !== "gallery") throw new Error("the fixture photos are not gallery photos");
const FRAMES = [
  { name: "an ordinary frame", engine: ordinary.facts, mock: { bold: false, level: contentLevelOf({ category: "home" }) } },
  { name: "a frame of «Смелая»", engine: bold.facts, mock: { bold: true, level: contentLevelOf({ category: "nightwear" }) } },
] as const;

const CORPUS = [
  "she slowly tucks a strand of hair behind her ear",
  "She slowly tucks a strand of hair behind her ear.",
  "she slowly tucks a strand of hair behind her ear...",
  "she’s slowly tucking a strand of hair behind her ear",
  "Her hand slowly moves to her hair",
  "  she   slowly\tturns her head  ",
  "slowly she turns her head",
  "she slowly turns her head and then she slowly sits down",
  "she jumps up and spins around fast",
  "she slowly raises her phone and takes a photo",
  "she slowly takes off her robe",
  "she slowly lets her robe fall",
  "she slowly zooms in on her face",
  "she slowly looks at the camera and smiles",
  "she slowly adjusts her bra",
  "she slowly runs her hand along her naked thigh",
  "she is eight years old",
  "she slowly dances",
  "hello world",
  "",
  "she slowly turns her head toward the window and smiles gently while the wind moves her hair and the curtains and then looks back",
  "she slowly turns her head a little to one side and smiles softly at nothing",
  "she slowly sips her coffee",
  "she slowly blows a kiss",
  "она медленно поворачивает голову",
  "she slowly turns her head; she smiles",
  "she slowly says \"hello\"",
];

describe("the normalising of a model's text", () => {
  test.each(CORPUS)("is the engine's for %p", (raw) => {
    expect(normalizeModelText(raw)).toBe(engineNormalize(raw));
  });
});

describe("the motion check on the frames the mock plays", () => {
  for (const frame of FRAMES) {
    for (const source of ["vision", "own"] as const) {
      test(`on ${frame.name} for ${source}: the corpus reads as the engine's check reads it`, () => {
        for (const raw of CORPUS) expect([raw, checkModelText(frame.mock, raw, source)]).toEqual([raw, engineCheck(frame.engine, raw, source)]);
      });
    }
  }

  test("a fixed-seed fuzz of 400 texts reads as the engine's check reads them, on both frames and both sources", () => {
    // A small linear congruential generator: the same texts on every machine.
    let state = 0x9e3779b1;
    const next = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const subject = ["she", "she", "she", "her hand", "slowly she", "She"];
    const adverb = ["slowly", "gently", "quickly", "", "a little", "softly"];
    const verb = ["tucks", "turns", "raises", "takes off", "unbuttons", "smiles at", "touches", "adjusts", "sips", "looks at", "lets", "zooms", "pans", "blinks", "dances", "jumps"];
    const object = ["her hair", "her head", "her phone", "her robe", "the camera", "her bra", "her shoulder", "a cup of tea", "her smile", "the window", "her naked skin", "a strand of hair behind her ear"];
    const tail = ["", "", "and smiles", "then sits down", "while the wind moves the curtains and the light changes", "to one side", ".", "..."];
    const started = performance.now();
    for (let i = 0; i < 400; i++) {
      const raw = [subject[next(subject.length)], adverb[next(adverb.length)], verb[next(verb.length)], object[next(object.length)], tail[next(tail.length)]].filter((part) => part !== "").join(" ");
      for (const frame of FRAMES) for (const source of ["vision", "own"] as const) expect([raw, frame.name, source, checkModelText(frame.mock, raw, source)]).toEqual([raw, frame.name, source, engineCheck(frame.engine, raw, source)]);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
