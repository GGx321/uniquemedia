import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { ProgressInvariants, type RenderProgress } from "./testing/progress";
useNativeGlobals();

// The parity transcript does not write a render's `done` (the engine steps by ffmpeg's frames, the mock by a clock), so what
// the numbers must satisfy is checked here instead, for every render progress either engine sends: the bar the window draws
// («Рендер · P %») depends on exactly these. Each test feeds a story to the checker and says which rule it breaks.

const TOTAL = 240;
const p = (done: number, saving = false, jobId = "job-a", total = TOTAL): RenderProgress => ({ jobId, done, total, ...(saving ? { saving: true } : {}) });

function run(...events: RenderProgress[]): void {
  const checker = new ProgressInvariants();
  for (const event of events) checker.check(event);
}

describe("a render's progress numbers", () => {
  test("accepts a queued start, steps that climb, and a saving phase at the last step", () => {
    expect(() => run(p(0), p(84), p(150), p(TOTAL - 1), p(TOTAL - 1, true))).not.toThrow();
  });

  test("accepts a saving phase with no step before it: nothing was reported, nothing is below it", () => {
    expect(() => run(p(0), p(0, true))).not.toThrow();
  });

  test("accepts two jobs interleaved: each has its own line", () => {
    expect(() => run(p(0, false, "job-a"), p(0, false, "job-b"), p(80, false, "job-a"), p(50, false, "job-b"))).not.toThrow();
  });

  test("refuses a saving phase that reads zero after progress was made (done dropped)", () => {
    expect(() => run(p(0), p(84), p(0, true))).toThrow(/goes back/);
  });

  test("refuses a saving phase below the last step", () => {
    expect(() => run(p(0), p(150), p(100, true))).toThrow(/goes back/);
  });

  test("refuses a step that goes back", () => {
    expect(() => run(p(0), p(150), p(100))).toThrow(/goes back/);
  });

  test("accepts the start twice: once when the render is queued, once when a slot frees and it runs", () => {
    expect(() => run(p(0), p(0), p(84))).not.toThrow();
  });

  test("refuses a third announcement at zero: a step is progress", () => {
    expect(() => run(p(0), p(0), p(0))).toThrow(/at most twice/);
  });

  test("refuses a start at zero after a step", () => {
    expect(() => run(p(0), p(84), p(0))).toThrow(/goes back/);
  });

  test("refuses done above the total", () => {
    expect(() => run(p(0), p(TOTAL + 1))).toThrow(/outside 0\.\.total/);
  });

  test("refuses done at the total while the job still runs: the last frame belongs to its end", () => {
    expect(() => run(p(0), p(TOTAL))).toThrow(/reaches the total/);
  });

  test("refuses a negative done", () => {
    expect(() => run(p(-1))).toThrow(/outside 0\.\.total/);
  });

  test("refuses a total that changes during the job", () => {
    expect(() => run(p(0), p(80, false, "job-a", 120))).toThrow(/total changed/);
  });

  test("refuses a job whose first progress is not its start at zero", () => {
    expect(() => run(p(84))).toThrow(/must begin at zero/);
  });

  test("refuses a step after the saving phase began", () => {
    expect(() => run(p(0), p(84), p(84, true), p(90))).toThrow(/after the saving phase/);
  });
});
