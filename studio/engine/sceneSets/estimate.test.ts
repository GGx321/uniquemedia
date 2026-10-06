import { describe, expect, test } from "bun:test";
import type { StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { WRITER_CALL, writerWorstMicros } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { composeEstimate, sceneSetPriceModels, writeEstimate } from "./estimate";
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

function stored(count: number): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count }) };
}

const without = (set: StoredSceneSet, from: number): StoredSceneSet => ({ ...set, scenes: set.scenes.map((s) => (s.sceneId > from ? { ...s, removed: true } : s)) });

describe("sceneSetPriceModels", () => {
  test("prices the settings' text model and no image model", () => {
    expect(sceneSetPriceModels(MODEL)).toEqual({ imageModels: [], chatModels: [MODEL] });
  });
});

describe("composeEstimate", () => {
  test("is the writer's worst case for the scenes: chunks of 25, two attempts each at the ceiling", () => {
    const writer = { ...WRITER_CALL, model: MODEL };
    for (const count of [1, 20, 25, 26, 60, 100]) {
      expect(composeEstimate(PRICED, MODEL, count).worstMicros).toBe(writerWorstMicros(PRICED.book, writer, count));
    }
  });

  test("20 scenes are one chunk: $0.075, and 100 are four: $0.30", () => {
    expect(composeEstimate(PRICED, MODEL, 20).worstMicros).toBe(2 * CEILING);
    expect(composeEstimate(PRICED, MODEL, 100).worstMicros).toBe(4 * 2 * CEILING);
  });

  test("26 scenes are two chunks: the second one's attempts are priced too", () => {
    expect(composeEstimate(PRICED, MODEL, 26).worstMicros).toBe(2 * 2 * CEILING);
  });

  test("expects the writer's typical tokens, never above the worst", () => {
    const estimate = composeEstimate(PRICED, MODEL, 20);
    expect(estimate.expectedMicros).toBeGreaterThan(0);
    expect(estimate.expectedMicros).toBeLessThan(estimate.worstMicros);
  });

  test("an empty set costs nothing", () => {
    expect(composeEstimate(PRICED, MODEL, 0)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("says where its prices come from", () => {
    expect(composeEstimate(PRICED, MODEL, 20)).toMatchObject({ prices: "fallback", pricesAsOf: "2026-09-24" });
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
});
