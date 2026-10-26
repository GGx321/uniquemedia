import { describe, expect, test } from "bun:test";
import type { StoredSceneSet } from "../library/sceneSets";
import { llmOnlySet, sampleSet } from "../library/testing/sceneSetSample";
import { LLM_ONLY_POOL, LLM_ONLY_REF, llmOnlySnapshot } from "../scenes/testing/llmOnlyFixture";
import type { CoversOf, SplitEntry } from "../../shared/scenes/writerBound";
import { WRITER_BOLD_CALL, WRITER_CALL, writerExpectedMicros, writerWorstMicros } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { composeEstimate, sceneSetPriceModels, writeEstimate, writerCeilingMicros } from "./estimate";
import { fakeLedger } from "./testing/fakeLedger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: what a compose and a «Дописать» could cost. The estimate IS the accepted worst the job's cap is set to, so it prices exactly the calls the
// job may send: per chunk `min(2 − answered, unused ids) × the writer's ceiling` (never a fresh pair after an interruption).

const MODEL = "x-ai/grok-4.3";
const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
/** One writer attempt at its ceilings (14K in, 8K out) at the fallback prices. */
const CEILING = 37_500;
const SET = "set-aaaa-0001";
const id = (chunk: number, n: number) => `${SET}:writer-${chunk}#${n}`;

// 5a.2 (S5.6c2, m11): a built-in scene is written by the code template, so a built-in set asks the writer for nothing. The writer-money tests below keep
// their figures on `cat-llm-only-fixture`, whose scenes the template cannot write (`stored`), and each has its built-in twin (`storedHome`).
function stored(count: number): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...llmOnlySet({ count }) };
}

function storedHome(count: number): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count }) };
}

const fixtureSplit = (count: number): SplitEntry[] => [{ ref: LLM_ONLY_REF, count }];
const homeSplit = (count: number): SplitEntry[] => [{ ref: "home", count }];
const NOTHING_COVERED: CoversOf = () => false;
const EVERYTHING_COVERED: CoversOf = () => true;

const without = (set: StoredSceneSet, from: number): StoredSceneSet => ({ ...set, scenes: set.scenes.map((s) => (s.sceneId > from ? { ...s, removed: true } : s)) });

describe("sceneSetPriceModels", () => {
  test("prices the settings' text model and no image model", () => {
    expect(sceneSetPriceModels(MODEL)).toEqual({ imageModels: [], chatModels: [MODEL] });
  });
});

// 5a.4 (S5.BA5, plan s5a4 I5.77, BA3 review M-1): a compose at «Смелая» puts every custom scene on the route, which the template does not render, so its writer is priced for
// every custom scene whatever the pool's coverage below «Смелая», at the bold call (writerCallOf("bold"): 48 750 µ$ an attempt, 97 500 µ$ a chunk). Below «Смелая» nothing moves.
describe("composeEstimate at «Смелая»", () => {
  const BOLD_CEILING = 48_750;
  const bold = { ...WRITER_BOLD_CALL, model: MODEL };

  test("a custom 20 the template covers below «Смелая» is one bold chunk: 97 500 µ$, expected at the bold call's typical tokens", () => {
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(20), EVERYTHING_COVERED, "bold")).toMatchObject({ worstMicros: 2 * BOLD_CEILING, expectedMicros: writerExpectedMicros(PRICED.book, bold, 1, 20) });
  });

  test("100 custom scenes are four bold chunks, covered or not", () => {
    for (const covers of [EVERYTHING_COVERED, NOTHING_COVERED]) expect(composeEstimate(PRICED, MODEL, fixtureSplit(100), covers, "bold").worstMicros).toBe(4 * 2 * BOLD_CEILING);
  });

  test("«Дом» 20 beside a custom 20 at «Смелая»: the custom block may touch two chunks, its 20 scenes expected in two requests", () => {
    const mixed = composeEstimate(PRICED, MODEL, [{ ref: "home", count: 20 }, { ref: LLM_ONLY_REF, count: 20 }], EVERYTHING_COVERED, "bold");
    expect(mixed).toMatchObject({ worstMicros: 2 * 2 * BOLD_CEILING, expectedMicros: writerExpectedMicros(PRICED.book, bold, 2, 20) });
  });

  test("built-in scenes at «Смелая» still ask the writer for nothing: the template renders their routed slots", () => {
    expect(composeEstimate(PRICED, MODEL, homeSplit(40), NOTHING_COVERED, "bold")).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("below «Смелая» the figures are the ordinary call's, as they were", () => {
    for (const level of [undefined, "ordinary", "flirty"] as const) {
      expect({ level, worst: composeEstimate(PRICED, MODEL, fixtureSplit(20), NOTHING_COVERED, level).worstMicros }).toEqual({ level, worst: 2 * CEILING });
      expect({ level, worst: composeEstimate(PRICED, MODEL, fixtureSplit(20), EVERYTHING_COVERED, level).worstMicros }).toEqual({ level, worst: 0 });
    }
  });

  test("writerCeilingMicros is the mode's one attempt: 37 500 µ$ ordinary, 48 750 µ$ bold", () => {
    expect([writerCeilingMicros(PRICED, MODEL, "ordinary"), writerCeilingMicros(PRICED, MODEL, "bold")]).toEqual([CEILING, BOLD_CEILING]);
  });
});

describe("composeEstimate", () => {
  test("is the writer's worst case for the scenes of an uncovered custom category: chunks of 25, two attempts each at the ceiling", () => {
    const writer = { ...WRITER_CALL, model: MODEL };
    for (const count of [1, 20, 25, 26, 60, 100]) {
      expect(composeEstimate(PRICED, MODEL, fixtureSplit(count), NOTHING_COVERED, undefined).worstMicros).toBe(writerWorstMicros(PRICED.book, writer, count));
    }
  });

  test("20 scenes are one chunk: $0.075, and 100 are four: $0.30", () => {
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(20), NOTHING_COVERED, undefined).worstMicros).toBe(2 * CEILING);
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(100), NOTHING_COVERED, undefined).worstMicros).toBe(4 * 2 * CEILING);
  });

  test("26 scenes are two chunks: the second one's attempts are priced too", () => {
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(26), NOTHING_COVERED, undefined).worstMicros).toBe(2 * 2 * CEILING);
  });

  test("expects the writer's typical tokens, never above the worst", () => {
    const estimate = composeEstimate(PRICED, MODEL, fixtureSplit(20), NOTHING_COVERED, undefined);
    expect(estimate.expectedMicros).toBeGreaterThan(0);
    expect(estimate.expectedMicros).toBeLessThan(estimate.worstMicros);
  });

  test("an empty set costs nothing", () => {
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(0), NOTHING_COVERED, undefined)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    expect(composeEstimate(PRICED, MODEL, [], NOTHING_COVERED, undefined)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("says where its prices come from", () => {
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(20), NOTHING_COVERED, undefined)).toMatchObject({ prices: "fallback", pricesAsOf: "2026-09-24" });
  });

  // The template side of the same questions.
  test("a built-in set costs nothing to compose: the code template writes every scene", () => {
    for (const count of [1, 20, 26, 100]) {
      expect(composeEstimate(PRICED, MODEL, homeSplit(count), NOTHING_COVERED, undefined)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    }
  });

  test("a custom category the template covers costs nothing either", () => {
    expect(composeEstimate(PRICED, MODEL, fixtureSplit(40), EVERYTHING_COVERED, undefined)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("Home 50 plus an uncovered custom 50: 3 chunks at 2 attempts, $0.225", () => {
    const split: SplitEntry[] = [{ ref: "home", count: 50 }, { ref: LLM_ONLY_REF, count: 50 }];
    expect(composeEstimate(PRICED, MODEL, split, NOTHING_COVERED, undefined).worstMicros).toBe(3 * 2 * CEILING);
  });

  test("a mixed set expects the typical tokens of the model's scenes only", () => {
    const mixed = composeEstimate(PRICED, MODEL, [{ ref: "home", count: 20 }, { ref: LLM_ONLY_REF, count: 20 }], NOTHING_COVERED, undefined);
    const allModel = composeEstimate(PRICED, MODEL, fixtureSplit(40), NOTHING_COVERED, undefined);
    const half = composeEstimate(PRICED, MODEL, fixtureSplit(20), NOTHING_COVERED, undefined);
    expect(mixed.expectedMicros).toBe(half.expectedMicros);
    expect(mixed.expectedMicros).toBeLessThan(allModel.expectedMicros);
  });

  test("a set with no scene for the model never prices the writer's model", () => {
    expect(composeEstimate(PRICED, "vendor/unlisted-model", homeSplit(20), NOTHING_COVERED, undefined)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });
});

describe("writeEstimate: «Дописать»", () => {
  test("a fresh 35-scene set: 25 + 10 scenes are two chunks of two attempts, $0.15", () => {
    expect(writeEstimate(PRICED, stored(35), fakeLedger({})).worstMicros).toBe(4 * CEILING);
  });

  test("after the first chunk's request was interrupted: one attempt for it and two for the next, $0.1125", () => {
    const ledger = fakeLedger({ [id(1, 1)]: {} });
    expect(writeEstimate(PRICED, stored(35), ledger).worstMicros).toBe(CEILING + 2 * CEILING);
  });

  test("a chunk that got a free 429 keeps both its attempts", () => {
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 0 } } });
    expect(writeEstimate(PRICED, stored(35), ledger).worstMicros).toBe(4 * CEILING);
  });

  test("removing the 10 scenes of the second chunk leaves the first chunk's attempt: $0.0375", () => {
    const ledger = fakeLedger({ [id(1, 1)]: {} });
    expect(writeEstimate(PRICED, without(stored(35), 25), ledger).worstMicros).toBe(CEILING);
  });

  test("a chunk out of attempts is not priced and not counted, and the next chunk is", () => {
    const ledger = fakeLedger({ [id(1, 1)]: {}, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(writeEstimate(PRICED, stored(35), ledger).worstMicros).toBe(2 * CEILING);
  });

  test("a chunk a job gave up on is not priced", () => {
    const set = stored(35);
    const gaveUp = { ...set, chunks: set.chunks.map((c) => (c.chunk === 2 ? { ...c, gaveUp: "refused" as const } : c)) };
    expect(writeEstimate(PRICED, gaveUp, fakeLedger({})).worstMicros).toBe(2 * CEILING);
  });

  test("a chunk whose scenes the owner typed text into is not requested at all, so it costs nothing", () => {
    const set = stored(35);
    const typed = { ...set, scenes: set.scenes.map((s) => (s.sceneId > 25 ? { ...s, text: "Typed by the owner.", edited: true } : s)) };
    expect(writeEstimate(PRICED, typed, fakeLedger({})).worstMicros).toBe(2 * CEILING);
  });

  test("a chunk with one scene typed still pays its full ceiling for the rest", () => {
    const set = stored(10);
    const typed = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 1 ? { ...s, text: "Typed.", edited: true } : s)) };
    expect(writeEstimate(PRICED, typed, fakeLedger({})).worstMicros).toBe(2 * CEILING);
  });

  test("a set with nothing waiting costs nothing", () => {
    const set = stored(10);
    const done = { ...set, scenes: set.scenes.map((s) => ({ ...s, text: "A sentence." })) };
    expect(writeEstimate(PRICED, done, fakeLedger({}))).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("expects the typical tokens of the scenes it asks for, never above the worst", () => {
    const estimate = writeEstimate(PRICED, stored(35), fakeLedger({}));
    expect(estimate.expectedMicros).toBeGreaterThan(0);
    expect(estimate.expectedMicros).toBeLessThanOrEqual(estimate.worstMicros);
  });

  test("with the ledger unreadable it prices every chunk as untouched", () => {
    expect(writeEstimate(PRICED, stored(35), null).worstMicros).toBe(4 * CEILING);
  });

  // 5a.2 (S5.6c2): a chunk whose every scene the code template writes is `free`: it is written with no request, so it adds nothing, whatever its attempts.
  describe("the template's chunks", () => {
    const POOLS = { [LLM_ONLY_REF]: LLM_ONLY_POOL };
    /** 52 scenes over Home + the fixture: chunk 1 is all Home (free), chunk 2 mixes 1 Home with 24 fixture scenes, chunk 3 is 2 fixture scenes. */
    const mixed = (): StoredSceneSet => ({
      schemaVersion: 1,
      revision: 1,
      createdAt: "2026-10-07T10:00:00.000Z",
      updatedAt: "2026-10-07T10:00:00.000Z",
      ...sampleSet({ count: 52, categories: ["home", LLM_ONLY_REF], pools: POOLS, snapshots: [llmOnlySnapshot()] }),
    });

    test("a built-in set costs nothing to write: every chunk is free", () => {
      expect(writeEstimate(PRICED, storedHome(35), fakeLedger({}))).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    });

    test("a free chunk next to chunks for the model adds nothing: only the model's chunks are priced", () => {
      expect(mixed().chunks.length).toBe(3);
      expect(writeEstimate(PRICED, mixed(), fakeLedger({})).worstMicros).toBe(2 * 2 * CEILING);
    });

    test("a free chunk with every attempt used stays free, and the model's chunks keep their own attempts", () => {
      const ledger = fakeLedger({ [id(1, 1)]: {}, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
      expect(writeEstimate(PRICED, mixed(), ledger).worstMicros).toBe(2 * 2 * CEILING);
    });

    test("a free chunk a job gave up on is offered again at no cost", () => {
      const set = mixed();
      const gaveUp = { ...set, chunks: set.chunks.map((c) => (c.chunk === 1 ? { ...c, gaveUp: "refused" as const } : c)) };
      expect(writeEstimate(PRICED, gaveUp, fakeLedger({})).worstMicros).toBe(2 * 2 * CEILING);
    });

    test("the expected cost follows the scenes the model must write, not the scenes of the chunks it is asked about", () => {
      const estimate = writeEstimate(PRICED, mixed(), fakeLedger({}));
      const modelScenes = 24 + 2;
      expect(estimate.expectedMicros).toBe(composeEstimate(PRICED, MODEL, fixtureSplit(modelScenes), NOTHING_COVERED, undefined).expectedMicros);
    });

    test("a set whose only pending chunk is free and given up prices at 0", () => {
      const set = storedHome(10);
      const gaveUp = { ...set, chunks: set.chunks.map((c) => ({ ...c, gaveUp: "refused" as const })) };
      expect(writeEstimate(PRICED, gaveUp, fakeLedger({}))).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    });
  });
});
