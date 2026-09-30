import { describe, expect, test } from "bun:test";
import { decideRange } from "./range";

const SIZE = 1000;
const partial = (start: number, end: number) => ({ kind: "partial" as const, start, end });
const unsatisfiable = { kind: "unsatisfiable" as const };

describe("decideRange", () => {
  test("no Range header means the whole file", () => {
    expect(decideRange(null, SIZE)).toEqual({ kind: "whole" });
  });

  test("0-0 is the first byte alone", () => {
    expect(decideRange("bytes=0-0", SIZE)).toEqual(partial(0, 0));
  });

  test("the last byte by its position", () => {
    expect(decideRange("bytes=999-999", SIZE)).toEqual(partial(999, 999));
  });

  test("the last byte by a suffix of 1", () => {
    expect(decideRange("bytes=-1", SIZE)).toEqual(partial(999, 999));
  });

  test("an open-ended range runs to the last byte", () => {
    expect(decideRange("bytes=500-", SIZE)).toEqual(partial(500, 999));
  });

  test("an end beyond EOF is clamped to the last byte", () => {
    expect(decideRange("bytes=900-5000", SIZE)).toEqual(partial(900, 999));
  });

  test("a suffix longer than the file is the whole file as a partial", () => {
    expect(decideRange("bytes=-5000", SIZE)).toEqual(partial(0, 999));
  });

  test("a start at EOF is unsatisfiable", () => {
    expect(decideRange("bytes=1000-", SIZE)).toEqual(unsatisfiable);
  });

  test("a start beyond EOF is unsatisfiable", () => {
    expect(decideRange("bytes=1001-1002", SIZE)).toEqual(unsatisfiable);
  });

  test("a suffix of 0 is unsatisfiable", () => {
    expect(decideRange("bytes=-0", SIZE)).toEqual(unsatisfiable);
  });

  test("an end before the start is unsatisfiable", () => {
    expect(decideRange("bytes=10-5", SIZE)).toEqual(unsatisfiable);
  });

  test("multiple ranges are unsatisfiable: the protocol never builds multipart answers", () => {
    expect(decideRange("bytes=0-1,5-6", SIZE)).toEqual(unsatisfiable);
  });

  test("any range on an empty file is unsatisfiable", () => {
    expect(decideRange("bytes=0-0", 0)).toEqual(unsatisfiable);
    expect(decideRange("bytes=-1", 0)).toEqual(unsatisfiable);
  });

  test("no Range header on an empty file is still the whole (empty) file", () => {
    expect(decideRange(null, 0)).toEqual({ kind: "whole" });
  });

  const malformed = [
    "",
    "bytes",
    "bytes=",
    "bytes=-",
    "bytes=a-b",
    "bytes=1-2-3",
    "bytes= 1-2",
    "bytes=1 -2",
    "items=0-1",
    "BYTES=0-1",
    "bytes=0-1;x",
    "bytes=-1-",
    "bytes=0x10-0x20",
    "bytes=+1-2",
    "bytes=1e3-",
    "bytes=1.5-2",
    "bytes=0-1\n2",
  ];
  for (const header of malformed) {
    test(`malformed ${JSON.stringify(header)} is unsatisfiable`, () => {
      expect(decideRange(header, SIZE)).toEqual(unsatisfiable);
    });
  }

  test("a number of 16 digits is unsatisfiable rather than rounded", () => {
    expect(decideRange("bytes=9007199254740993-", SIZE)).toEqual(unsatisfiable);
    expect(decideRange("bytes=0-9007199254740993", SIZE)).toEqual(unsatisfiable);
  });

  test("15 digits is read exactly", () => {
    expect(decideRange("bytes=0-999999999999999", 2_000_000_000_000_000)).toEqual(partial(0, 999_999_999_999_999));
  });

  test("leading zeros are the same number", () => {
    expect(decideRange("bytes=0001-0002", SIZE)).toEqual(partial(1, 2));
  });

  test("surrounding whitespace of the whole header is ignored", () => {
    expect(decideRange("  bytes=1-2  ", SIZE)).toEqual(partial(1, 2));
  });
});
