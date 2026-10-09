import { expect, test } from "bun:test";
import { dollarsInputValue, formatUsd, formatUsdRange, formatUsdTiered, parseDollars } from "./money";

test("formats micros as dollars with two decimals, rounding to the nearest cent", () => {
  expect(formatUsd(207_600)).toBe("$0.21");
  expect(formatUsd(205_000)).toBe("$0.21");
  expect(formatUsd(204_999)).toBe("$0.20");
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(10_000_000)).toBe("$10.00");
});

test("worst cases round up, so «не больше» never understates", () => {
  expect(formatUsd(223_000, 2, "up")).toBe("$0.23");
  expect(formatUsd(220_001, 2, "up")).toBe("$0.23");
  expect(formatUsd(220_000, 2, "up")).toBe("$0.22");
  expect(formatUsd(1, 2, "up")).toBe("$0.01");
});

test("rounding down never overstates", () => {
  expect(formatUsd(229_999, 2, "down")).toBe("$0.22");
});

test("per-item prices may show 3 or 4 decimals", () => {
  expect(formatUsd(50_000, 3)).toBe("$0.050");
  expect(formatUsd(1_400, 4)).toBe("$0.0014");
  expect(formatUsd(1_450, 3)).toBe("$0.001");
  expect(formatUsd(1_500, 3)).toBe("$0.002");
});

test("large amounts are exact and grouped with a thin space", () => {
  expect(formatUsd(1_234_567_890_000)).toBe("$1 234 567.89");
  expect(formatUsd(Number.MAX_SAFE_INTEGER, 4)).toBe("$9 007 199 254.7410");
});

test("refuses fractional and negative micros", () => {
  expect(() => formatUsd(0.5)).toThrow(RangeError);
  expect(() => formatUsd(-1)).toThrow(RangeError);
});

test("parses typed dollars into integer micros without float math", () => {
  expect(parseDollars("10")).toEqual({ ok: true, micros: 10_000_000 });
  expect(parseDollars("12.5")).toEqual({ ok: true, micros: 12_500_000 });
  expect(parseDollars("0.1")).toEqual({ ok: true, micros: 100_000 });
  expect(parseDollars("0.29")).toEqual({ ok: true, micros: 290_000 });
  expect(parseDollars("$7,05")).toEqual({ ok: true, micros: 7_050_000 });
  expect(parseDollars(" 1 000 ")).toEqual({ ok: true, micros: 1_000_000_000 });
  expect(parseDollars(".5")).toEqual({ ok: true, micros: 500_000 });
  expect(parseDollars("3.")).toEqual({ ok: true, micros: 3_000_000 });
});

test("rejects what is not a positive dollar amount with cents at most", () => {
  expect(parseDollars("")).toEqual({ ok: false, reason: "empty" });
  expect(parseDollars("   ")).toEqual({ ok: false, reason: "empty" });
  expect(parseDollars("abc")).toEqual({ ok: false, reason: "format" });
  expect(parseDollars("-5")).toEqual({ ok: false, reason: "format" });
  expect(parseDollars("1e3")).toEqual({ ok: false, reason: "format" });
  expect(parseDollars(".")).toEqual({ ok: false, reason: "format" });
  expect(parseDollars("10.123")).toEqual({ ok: false, reason: "precision" });
  expect(parseDollars("0")).toEqual({ ok: false, reason: "zero" });
  expect(parseDollars("0.00")).toEqual({ ok: false, reason: "zero" });
});

test("the upper limit is inclusive and one cent over is refused", () => {
  expect(parseDollars("10000")).toEqual({ ok: true, micros: 10_000_000_000 });
  expect(parseDollars("10000.01")).toEqual({ ok: false, reason: "too-large" });
  expect(parseDollars("99999999999")).toEqual({ ok: false, reason: "too-large" });
});

test("formatUsdRange rounds the expected bound to the nearest, the worst bound up — never an understatement", () => {
  expect(formatUsdRange(1_660, 5_250, 3)).toBe("$0.002–0.006");
  expect(formatUsdRange(100_000, 104_000, 2)).toBe("$0.10–0.11");
});

test("formatUsdRange collapses to one value only when both bounds round the same", () => {
  expect(formatUsdRange(100_000, 100_000, 2)).toBe("$0.10");
});

test("the input value round-trips with the parser", () => {
  expect(dollarsInputValue(12_500_000)).toBe("12.50");
  expect(dollarsInputValue(10_000_000_000)).toBe("10000.00");
  const parsed = parseDollars(dollarsInputValue(7_050_000));
  expect(parsed).toEqual({ ok: true, micros: 7_050_000 });
});

// CS.3, the design's «Деньги на экране»: one rule for the small prices of custom categories (the pool call is $0.006 typical, $0.045 worst).
test("formatUsdTiered shows three decimals below $0.10 and two from $0.10, rounding a ceiling up and the rest to the nearest", () => {
  // The pool call's own figures at the fallback prices.
  expect(formatUsdTiered(45_000, "up")).toBe("$0.045");
  expect(formatUsdTiered(6_000, "nearest")).toBe("$0.006");
  // An open writer reserve, $0.0375: «до» rounds up, «≈» and spent money to the nearest.
  expect(formatUsdTiered(37_500, "up")).toBe("$0.038");
  expect(formatUsdTiered(5_400, "nearest")).toBe("$0.005");
  expect(formatUsdTiered(5_500, "nearest")).toBe("$0.006");
  // The boundary: 99 999 µ$ is still below $0.10 (three decimals, and rounding up reaches «$0.100»); 100 000 is two.
  expect(formatUsdTiered(99_999, "up")).toBe("$0.100");
  expect(formatUsdTiered(100_000, "up")).toBe("$0.10");
  expect(formatUsdTiered(112_500, "up")).toBe("$0.12");
  expect(formatUsdTiered(112_500, "nearest")).toBe("$0.11");
  // Nothing spent is said as nothing.
  expect(formatUsdTiered(0, "nearest")).toBe("$0.000");
});

// S4.9a: what is left (the month's room, the OpenRouter balance) is never overstated: rounded down, in the same tiers.
test("formatUsdTiered rounds what is left down, three decimals below $0.10", () => {
  expect(formatUsdTiered(8_360_000, "down")).toBe("$8.36");
  expect(formatUsdTiered(619_999, "down")).toBe("$0.61");
  expect(formatUsdTiered(45_999, "down")).toBe("$0.045");
  expect(formatUsdTiered(99_999, "down")).toBe("$0.099");
  expect(formatUsdTiered(100_000, "down")).toBe("$0.10");
  expect(formatUsdTiered(0, "down")).toBe("$0.000");
});

test("formatUsdTiered refuses what formatUsd refuses", () => {
  expect(() => formatUsdTiered(-1, "up")).toThrow(RangeError);
  expect(() => formatUsdTiered(0.5, "nearest")).toThrow(RangeError);
});
