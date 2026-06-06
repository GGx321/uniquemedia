import { test, expect } from "bun:test";
import { parseProgressFraction } from "./ffmpegProgress";

test("parses out_time_us into a fraction of duration", () => {
  const chunk = "frame=10\nout_time_us=1000000\nprogress=continue\n";
  expect(parseProgressFraction(chunk, 2)).toBeCloseTo(0.5, 5);
});

test("uses the LAST out_time_us in a multi-block chunk", () => {
  const chunk =
    "out_time_us=500000\nprogress=continue\nout_time_us=1500000\nprogress=continue\n";
  expect(parseProgressFraction(chunk, 2)).toBeCloseTo(0.75, 5);
});

test("clamps to 1 and returns 1 on progress=end", () => {
  expect(parseProgressFraction("out_time_us=9999999999\nprogress=end\n", 2)).toBe(1);
});

test("returns null when no parseable time or bad duration", () => {
  expect(parseProgressFraction("out_time_us=N/A\nprogress=continue\n", 2)).toBeNull();
  expect(parseProgressFraction("out_time_us=1000000\n", 0)).toBeNull();
});
