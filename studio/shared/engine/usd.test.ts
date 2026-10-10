import { describe, expect, test } from "bun:test";
import { isFree, limitUsd } from "./usd";

// S4.10 fix C (UI LOW 7): the one money rule of a launch, shared by the window (the card, the history, a launch's page) and by main (the notification of its end).

describe("isFree", () => {
  test("only a launch that planned nothing AND spent nothing is free", () => {
    expect(isFree(0, 0)).toBe(true);
    expect(isFree(0, 1)).toBe(false);
    expect(isFree(4_140_000, 1_250_000)).toBe(false);
  });

  test("a launch planned free that still spent (an A2 breach) is not called free", () => {
    expect(isFree(1, 0)).toBe(false);
    expect(isFree(300_000, 0)).toBe(false);
  });
});

describe("limitUsd", () => {
  test("a limit of 0 reads «$0», never «$0.000»", () => {
    expect(limitUsd(0)).toBe("$0");
  });

  test("any other limit rounds up, three decimals below $0.10", () => {
    expect(limitUsd(1)).toBe("$0.001");
    expect(limitUsd(89_001)).toBe("$0.090");
    expect(limitUsd(100_000)).toBe("$0.10");
    expect(limitUsd(4_140_000)).toBe("$4.14");
    expect(limitUsd(4_140_001)).toBe("$4.15");
  });
});
