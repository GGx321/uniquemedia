import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { ImportProgressInvariants, type ImportProgress } from "./testing/progress";
useNativeGlobals();

// 3f.6: an import's progress has two stages, and the rules the numbers must satisfy follow them: the copy counts bytes and may end at its total;
// the prepare counts the importer's units, starts at zero of its own total, never goes back and never reaches that total before the job has ended;
// the order is copy, then prepare, and never back; and what the probe judged does not change.

const BYTES = 1000;
const UNITS = 90;
const FACTS = { hdrToSdr: true, fromFps: 60 } as const;

const copy = (done: number, jobId = "job-a", total = BYTES, queued = false): ImportProgress => ({ jobId, done, total, ...(queued ? { queued: true } : {}) });
const prep = (done: number, jobId = "job-a", total = UNITS, prepare: ImportProgress["prepare"] = undefined): ImportProgress => ({
  jobId,
  done,
  total,
  stage: "prepare",
  ...(prepare === undefined ? {} : { prepare }),
});

function run(...events: ImportProgress[]): void {
  const checker = new ImportProgressInvariants();
  for (const event of events) checker.check(event);
}

describe("an import's progress through its two stages", () => {
  test("accepts a copy, then a prepare that begins at zero of its own total and climbs", () => {
    expect(() => run(copy(0), copy(500), copy(1000), prep(0), prep(30), prep(89))).not.toThrow();
  });

  test("accepts what the probe judged at the begin, repeated unchanged, and a copy that says its stage out loud", () => {
    expect(() => run({ ...copy(0), stage: "copy" }, copy(1000), prep(0, "job-a", UNITS, FACTS), prep(10, "job-a", UNITS, FACTS), prep(89, "job-a", UNITS, FACTS))).not.toThrow();
  });

  test("accepts a queued job, then its copy and its prepare, and two jobs interleaved", () => {
    expect(() => run(copy(0, "job-b", BYTES, true), copy(0, "job-a"), copy(1000, "job-a"), prep(0, "job-a"), copy(0, "job-b"), prep(20, "job-a"), copy(1000, "job-b"), prep(0, "job-b", 30))).not.toThrow();
  });

  test("accepts a prepare of one unit: the begin is all it says", () => {
    expect(() => run(copy(0), copy(1000), prep(0, "job-a", 1))).not.toThrow();
  });

  test("refuses a prepare that begins before the copy is whole: the copy comes first", () => {
    expect(() => run(copy(0), copy(400), prep(0))).toThrow(/copy.*(whole|total)|before the copy/);
  });

  test("refuses a prepare at the start of a job: nothing was copied", () => {
    expect(() => run(prep(0))).toThrow(/begin|copy/);
  });

  test("refuses a copy after the prepare began: the stages never go back", () => {
    expect(() => run(copy(0), copy(1000), prep(0), prep(10), copy(1000))).toThrow(/back to the copy|copy after/);
  });

  test("refuses a prepare that does not begin at zero", () => {
    expect(() => run(copy(0), copy(1000), prep(5))).toThrow(/begin.*zero|zero/);
  });

  test("refuses a prepare that begins twice", () => {
    expect(() => run(copy(0), copy(1000), prep(0), prep(10), prep(0))).toThrow(/begin|goes back/);
  });

  test("refuses a prepare's done that goes back", () => {
    expect(() => run(copy(0), copy(1000), prep(0), prep(50), prep(40))).toThrow(/goes back/);
  });

  test("refuses a prepare that reaches its total before the job has ended", () => {
    expect(() => run(copy(0), copy(1000), prep(0), prep(90))).toThrow(/reaches the total/);
  });

  test("refuses a prepare beyond its total", () => {
    expect(() => run(copy(0), copy(1000), prep(0), prep(91))).toThrow(/outside 0\.\.total/);
  });

  test("refuses a prepare whose total changes", () => {
    expect(() => run(copy(0), copy(1000), prep(0), prep(10, "job-a", 80))).toThrow(/total changed/);
  });

  test("refuses a prepare with no units (a total of zero)", () => {
    expect(() => run(copy(0, "job-a", 0), prep(0, "job-a", 0))).toThrow(/at least one unit/);
  });

  test("refuses what the probe judged changing, appearing late or vanishing", () => {
    expect(() => run(copy(0), copy(1000), prep(0, "job-a", UNITS, FACTS), prep(10, "job-a", UNITS, { hdrToSdr: false, fromFps: 60 }))).toThrow(/judged/);
    expect(() => run(copy(0), copy(1000), prep(0), prep(10, "job-a", UNITS, FACTS))).toThrow(/judged/);
    expect(() => run(copy(0), copy(1000), prep(0, "job-a", UNITS, FACTS), prep(10))).toThrow(/judged/);
  });

  test("refuses what the probe judged on a copy", () => {
    expect(() => run({ ...copy(0), prepare: FACTS })).toThrow(/judged|prepare/);
  });

  test("refuses a queued announcement in the prepare stage", () => {
    expect(() => run(copy(0), copy(1000), { ...prep(0), queued: true })).toThrow(/queued/);
  });

  test("a copy keeps its own rules: it may reach its total, and may not go back", () => {
    expect(() => run(copy(0), copy(1000))).not.toThrow();
    expect(() => run(copy(0), copy(600), copy(500))).toThrow(/goes back/);
  });

  test("the prepare's zeros are not the copy's starts: a job announced queued and then running may still begin its prepare", () => {
    expect(() => run(copy(0, "job-a", BYTES, true), copy(0), copy(1000), prep(0))).not.toThrow();
  });
});
