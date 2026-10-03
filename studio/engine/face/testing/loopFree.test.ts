import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { loopFreeProblem, type TimerGap } from "./loopFree";
useNativeGlobals();

const control: TimerGap = { maxGapMs: 100, durationMs: 120 };
const run = (maxGapMs: number, durationMs = 220): TimerGap => ({ maxGapMs, durationMs });

describe("loopFreeProblem", () => {
  test("accepts five runs that never blocked the loop", () => {
    expect(loopFreeProblem([run(5), run(6), run(5), run(7), run(5)], control)).toBeUndefined();
  });

  test("accepts one run in five that the runner stalled (it is indistinguishable from noise at N=5)", () => {
    expect(loopFreeProblem([run(5), run(80), run(5), run(6), run(5)], control)).toBeUndefined();
  });

  test("rejects an 80 ms block on 4 of 5 runs", () => {
    expect(loopFreeProblem([run(80), run(80), run(80), run(80), run(5)], control)).toContain("blocked");
  });

  test("rejects an 80 ms block on every other run", () => {
    expect(loopFreeProblem([run(80), run(5), run(80), run(5), run(80)], control)).toContain("blocked");
    expect(loopFreeProblem([run(5), run(80), run(5), run(80), run(5)], control)).toContain("blocked");
  });

  test("rejects a worker path that blocks as long as the in-thread control in every run", () => {
    expect(loopFreeProblem([run(100), run(100), run(100), run(100), run(100)], control)).toContain("blocked");
  });

  test("rejects a control that did not block: the comparison would measure nothing", () => {
    expect(loopFreeProblem([run(5), run(5), run(5), run(5), run(5)], { maxGapMs: 30, durationMs: 40 })).toContain("control");
  });

  test("rejects a run whose duration is under twice its own gap", () => {
    expect(loopFreeProblem([run(5, 8), run(5, 8), run(5, 8), run(5, 8), run(5, 8)], control)).toContain("duration");
  });

  test("refuses to judge fewer runs than the minimum", () => {
    expect(() => loopFreeProblem([run(5), run(5)], control)).toThrow("at least");
  });
});

// The blocking run's criterion (CI-4): wide enough that a loaded runner does not flake it, still failing a check that is back on this thread.
describe("loopFreeProblem, wide", () => {
  test("accepts a worker whose gap is 70% of the control's, which the tight criterion refuses", () => {
    const runs = [run(70), run(70), run(70), run(70), run(70)];
    expect(loopFreeProblem(runs, control, "wide")).toBeUndefined();
    expect(loopFreeProblem(runs, control, "tight")).toContain("blocked");
  });

  test("rejects a check that blocks this thread as long as the control (the work back on the main thread)", () => {
    expect(loopFreeProblem([run(100), run(95), run(100), run(98), run(100)], control, "wide")).toContain("blocked");
    expect(loopFreeProblem([run(100, 100), run(100, 100), run(100, 100), run(100, 100), run(100, 100)], control, "wide")).toContain("blocked");
  });

  test("still accepts one stalled run in five, and still refuses a control that did not block", () => {
    expect(loopFreeProblem([run(5), run(120), run(5), run(6), run(5)], control, "wide")).toBeUndefined();
    expect(loopFreeProblem([run(5), run(5), run(5), run(5), run(5)], { maxGapMs: 30, durationMs: 40 }, "wide")).toContain("control");
  });
});
