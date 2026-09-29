import { describe, expect, test } from "bun:test";
import { PASS1_SHARE_PERCENT, ProgressFold, renderTimeoutMs } from "./progress";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// A render job's `done` counts frames of the FINAL video. Pass 1 (the clips)
// takes the first PASS1_SHARE_PERCENT of that range, pass 2 the rest.

describe("ProgressFold", () => {
  test("pass 1 is the first 35 percent of the range, measured on this machine at 35/65", () => {
    expect(PASS1_SHARE_PERCENT).toBe(35);
  });

  test("gives nothing until a pass has made a frame", () => {
    const fold = new ProgressFold(300);

    expect(fold.pass1(0)).toBeNull();
    expect(fold.pass2(0)).toBeNull();
  });

  test("maps the frames of pass 1 into its share of the range", () => {
    const fold = new ProgressFold(300);

    expect(fold.pass1(150)).toBe(52); // floor(150 x 0.35)
    expect(fold.pass1(300)).toBe(105); // the whole share
  });

  test("continues from the end of pass 1 when pass 2 starts, and maps pass 2 into the rest", () => {
    const fold = new ProgressFold(300);
    fold.pass1(300);

    expect(fold.pass2(1)).toBeNull(); // one frame of 300 is under one frame of the range: nothing new to say
    expect(fold.pass2(2)).toBe(106);
    expect(fold.pass2(150)).toBe(105 + 97); // floor(150 x 195 / 300)
  });

  test("never reaches total while the job runs: the last frame is left for the job's own end", () => {
    const fold = new ProgressFold(300);
    fold.pass1(300);

    expect(fold.pass2(300)).toBe(299);
  });

  test("never reports a lower number than before, whichever pass or order the frames come in", () => {
    const fold = new ProgressFold(300);
    const seen: number[] = [];
    for (const n of [100, 40, 300, 300]) seen.push(fold.pass1(n) ?? -1);
    for (const n of [0, 10, 5, 200, 100, 300]) seen.push(fold.pass2(n) ?? -1);

    const reported = seen.filter((n) => n >= 0);
    expect(reported).toEqual([...reported].sort((a, b) => a - b));
    expect(new Set(reported).size).toBe(reported.length);
  });

  test("returns null for a frame count that adds nothing", () => {
    const fold = new ProgressFold(300);
    fold.pass1(150);

    expect(fold.pass1(150)).toBeNull();
    expect(fold.pass1(100)).toBeNull();
  });

  test("clamps a pass that reports more frames than the video has", () => {
    const fold = new ProgressFold(300);

    expect(fold.pass1(9999)).toBe(105);
    expect(fold.pass2(9999)).toBe(299);
  });

  test("ignores negative and non-finite counts", () => {
    const fold = new ProgressFold(300);

    expect(fold.pass1(-5)).toBeNull();
    expect(fold.pass1(Number.NaN)).toBeNull();
    expect(fold.pass2(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  test("a full two-pass run in small steps is strictly below total, monotonic, and within the range", () => {
    const total = 450; // a 15 s video
    const fold = new ProgressFold(total);
    const seen: number[] = [];
    for (let n = 1; n <= total; n += 7) seen.push(fold.pass1(n) ?? -1);
    for (let n = 1; n <= total; n += 5) seen.push(fold.pass2(n) ?? -1);

    const reported = seen.filter((n) => n >= 0);
    expect(reported.length).toBeGreaterThan(10);
    for (let i = 1; i < reported.length; i++) expect(reported[i]).toBeGreaterThan(reported[i - 1] ?? 0);
    expect(Math.max(...reported)).toBeLessThan(total);
    expect(Math.min(...reported)).toBeGreaterThanOrEqual(0);
  });
});

describe("renderTimeoutMs", () => {
  test("is 30 times the video's length: 450 s for a 15 s render", () => {
    expect(renderTimeoutMs(450)).toBe(450_000);
  });

  test("is 120 s for the shortest montage, 4 s", () => {
    expect(renderTimeoutMs(120)).toBe(120_000);
  });

  test("is never under 90 s", () => {
    expect(renderTimeoutMs(30)).toBe(90_000); // 1 s: 30 s would be too tight
    expect(renderTimeoutMs(89)).toBe(90_000);
    expect(renderTimeoutMs(0)).toBe(90_000);
  });

  test("steps over the floor exactly at 90 frames (3 s), where 30 x length passes 90 s", () => {
    expect(renderTimeoutMs(90)).toBe(90_000);
    expect(renderTimeoutMs(91)).toBe(91_000);
  });
});
