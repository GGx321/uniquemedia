import { describe, expect, test } from "bun:test";
import { WRITER_BOLD_CALL, WRITER_CALL, writerAttemptWorstMicros, writerCallOf, type WriterCall } from "./estimate";
import { PriceBook } from "./prices";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5a round 2, L2): the two writer shapes are shared by every site that asks `writerCallOf`, so neither can be changed at run time: a write
// to one would reprice every writer attempt after it.

const BOOK = PriceBook.fallback();

describe("the two shapes cannot be changed at run time (round 2, L2)", () => {
  test("both shapes and their typical tokens are frozen", () => {
    for (const call of [WRITER_CALL, WRITER_BOLD_CALL]) {
      expect([Object.isFrozen(call), Object.isFrozen(call.typicalPerScene)]).toEqual([true, true]);
    }
    expect(Object.isFrozen(WRITER_BOLD_CALL.typicalPerCall)).toBe(true);
  });

  test("a write to a shape from writerCallOf throws and leaves it as it was", () => {
    const bold: WriterCall = writerCallOf("bold");
    const before = bold.reasoningTokens;
    try {
      expect(() => {
        bold.reasoningTokens = 0;
      }).toThrow(TypeError);
    } finally {
      // A shape that is not frozen must not carry the write into the other tests.
      if (bold.reasoningTokens !== before) bold.reasoningTokens = before;
    }
    expect(writerAttemptWorstMicros(BOOK, writerCallOf("bold"))).toBe(48_750);
  });
});
