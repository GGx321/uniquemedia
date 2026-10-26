import { describe, expect, test } from "bun:test";
import { WRITER_BOLD_CALL, WRITER_CALL, writerAttemptWorstMicros, writerChunksMicros } from "../../engine/money/estimate";
import { PriceBook } from "../../engine/money/prices";
import { SCENE_CHUNK_ATTEMPTS } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MOCK_BOLD_SCENE_ATTEMPT_WORST, MOCK_SCENE_ATTEMPT_WORST } from "./mockSceneSets";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 r2.4 §5.3.4 «The mock», the S5.WC4 pattern): the mock cannot import `engine/`, so the price of one writer attempt is written out in
// mockSceneSets.ts and HELD to the engine here, by a test that imports both. The day the engine's writer call or its price changes, this fails and says
// which figure to move. At the bundled (fallback) prices of the default text model.

const BOOK = PriceBook.fallback();

const ROWS = [
  { mode: "ordinary", mock: MOCK_SCENE_ATTEMPT_WORST, call: WRITER_CALL, attempt: 37_500, chunk: 75_000 },
  { mode: "bold", mock: MOCK_BOLD_SCENE_ATTEMPT_WORST, call: WRITER_BOLD_CALL, attempt: 48_750, chunk: 97_500 },
] as const;

describe("the mock's writer attempt is the engine's", () => {
  for (const row of ROWS) {
    test(`${row.mode}: one attempt is writerAttemptWorstMicros at the bundled prices (${row.attempt} µ$)`, () => {
      expect([row.mock, writerAttemptWorstMicros(BOOK, row.call)]).toEqual([row.attempt, row.attempt]);
    });

    test(`${row.mode}: a chunk at worst is its answered attempts at that price (${row.chunk} µ$)`, () => {
      expect([SCENE_CHUNK_ATTEMPTS * row.mock, writerChunksMicros(BOOK, row.call, 1)]).toEqual([row.chunk, row.chunk]);
    });
  }

  test("the mock's chunk attempts are both shapes' maxAttempts", () => {
    expect([WRITER_CALL.maxAttempts, WRITER_BOLD_CALL.maxAttempts]).toEqual([SCENE_CHUNK_ATTEMPTS, SCENE_CHUNK_ATTEMPTS]);
  });
});
