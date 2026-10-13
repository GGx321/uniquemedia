import { describe, expect, test } from "bun:test";
import { clipTimings, PROOF_READ_TRIES, REAL_CLIP_TIMINGS, SHORT_CLIP_TIMINGS, type ClipTimings } from "./timings";

// 5b.1, S5.V3b (plan s5b1 §5.15, critic M6): every duration of the clip money path lives in one object, so the engine tests, the parity rigs and the packaged smoke can run
// «proof 2 min → Grok», `late` and the holds in milliseconds. The REAL set is the durations of I5.47, I5.48 and §5.13; the SHORT set is the same ones, a thousand times smaller.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const KEYS = Object.keys(REAL_CLIP_TIMINGS) as (keyof ClipTimings)[];

describe("the real set", () => {
  test("polls every 20 s", () => {
    expect(REAL_CLIP_TIMINGS.pollMs).toBe(20 * SECOND);
  });

  test("reads /generation first at 15 s and again at 2 min after the terminal status", () => {
    expect(REAL_CLIP_TIMINGS.proofFirstReadMs).toBe(15 * SECOND);
    expect(REAL_CLIP_TIMINGS.proofSecondReadMs).toBe(2 * MINUTE);
  });

  test("abandons an attempt 20 min after the submit and gives up on a late file at 60 min", () => {
    expect(REAL_CLIP_TIMINGS.lifetimeMs).toBe(20 * MINUTE);
    expect(REAL_CLIP_TIMINGS.lateGiveUpMs).toBe(60 * MINUTE);
  });

  test("polls a late clip every 60 s", () => {
    expect(REAL_CLIP_TIMINGS.latePollMs).toBe(60 * SECOND);
  });

  test("holds an uncertain submit 20 min, a terminal status 2 min and a submitted job 60 min", () => {
    expect(REAL_CLIP_TIMINGS.holdUncertainMs).toBe(20 * MINUTE);
    expect(REAL_CLIP_TIMINGS.holdTerminalMs).toBe(2 * MINUTE);
    expect(REAL_CLIP_TIMINGS.holdSubmittedMs).toBe(60 * MINUTE);
  });

  test("shows an export's progress line after 2 s", () => {
    expect(REAL_CLIP_TIMINGS.exportProgressMs).toBe(2 * SECOND);
  });

  test("reads a free call three times before it calls it unreadable", () => {
    expect(PROOF_READ_TRIES).toBe(3);
  });

  test("is frozen, so a test cannot change what production reads", () => {
    expect(Object.isFrozen(REAL_CLIP_TIMINGS)).toBe(true);
  });
});

describe("the short set", () => {
  test("is the real set divided by a thousand", () => {
    for (const key of KEYS) expect(SHORT_CLIP_TIMINGS[key] * 1_000).toBe(REAL_CLIP_TIMINGS[key]);
  });

  test("keeps the order of every pair of durations the real set has", () => {
    for (const a of KEYS) {
      for (const b of KEYS) {
        expect(Math.sign(SHORT_CLIP_TIMINGS[a] - SHORT_CLIP_TIMINGS[b])).toBe(Math.sign(REAL_CLIP_TIMINGS[a] - REAL_CLIP_TIMINGS[b]));
      }
    }
  });

  test("keeps 15 s < 2 min < 20 min < 60 min as milliseconds", () => {
    const s = SHORT_CLIP_TIMINGS;
    expect(s.proofFirstReadMs).toBeLessThan(s.proofSecondReadMs);
    expect(s.proofSecondReadMs).toBeLessThan(s.lifetimeMs);
    expect(s.lifetimeMs).toBeLessThan(s.lateGiveUpMs);
  });

  test("is whole milliseconds, never zero", () => {
    for (const key of KEYS) {
      expect(Number.isInteger(SHORT_CLIP_TIMINGS[key])).toBe(true);
      expect(SHORT_CLIP_TIMINGS[key]).toBeGreaterThan(0);
    }
  });

  test("is frozen", () => {
    expect(Object.isFrozen(SHORT_CLIP_TIMINGS)).toBe(true);
  });
});

describe("clipTimings", () => {
  test("answers the real set by default", () => {
    expect(clipTimings()).toBe(REAL_CLIP_TIMINGS);
  });

  test("answers the short set when asked for it", () => {
    expect(clipTimings("short")).toBe(SHORT_CLIP_TIMINGS);
  });
});
