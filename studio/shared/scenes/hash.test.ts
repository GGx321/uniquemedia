import { describe, expect, test } from "bun:test";
import { fnv1a, pick } from "./hash";

// 5a.2 (S5.6a): the scene banks draw by hash picks, so `shared/scenes` never imports the uniquifier's rng (src/core/rng). `fnv1a` moved here from
// engine/scenes/rngUtil.ts, which re-exports it: the values below are the published 32-bit FNV-1a values the engine pinned before the move.

describe("fnv1a", () => {
  test.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("hashes %p to the published 32-bit FNV-1a value", (text, expected) => {
    expect(fnv1a(text)).toBe(expected);
  });

  // Taken from engine/scenes/rngUtil.ts before the move: the planner's category discriminator and the look module's per-slot keys (phoneLook.ts).
  test.each([
    ["home", 0xd2c8c28e],
    ["run-1:slot-1:room", 0xa8ff4d15],
    ["a1b2c3:slot-4:imperfection", 0xeac59a55],
  ])("hashes %p to the value the engine's draws were made with", (text, expected) => {
    expect(fnv1a(text)).toBe(expected);
  });
});

describe("pick", () => {
  const LIST = ["a", "b", "c", "d", "e"] as const;

  test("is the item at fnv1a(`${key}:${stream}`) modulo the list's length", () => {
    expect(pick(LIST, "run-7:slot-3", "gaze")).toBe(LIST[fnv1a("run-7:slot-3:gaze") % LIST.length]);
  });

  test("gives the same item for the same key and stream, every time", () => {
    expect(pick(LIST, "k", "cue")).toBe(pick(LIST, "k", "cue"));
  });

  test("draws different streams of one key independently", () => {
    const byStream = new Set(["gaze", "cue", "detail", "hair", "dedup:1", "dedup:2"].map((stream) => pick(LIST, "run-1:slot-1", stream)));
    expect(byStream.size).toBeGreaterThan(1);
  });

  test("reaches every item of the list over many keys", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => pick(LIST, `run-${i}`, "gaze")));
    expect([...seen].sort()).toEqual([...LIST]);
  });

  test("returns the only item of a one-item list", () => {
    expect(pick(["only"], "any", "stream")).toBe("only");
  });

  test("refuses an empty list", () => {
    expect(() => pick([], "k", "s")).toThrow(RangeError);
  });
});
