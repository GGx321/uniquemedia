import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { servedProblems, unservedAnswers } from "./testing/pending";
useNativeGlobals();

// Stage 4, S4.1: a parity story can be PENDING while the real engine does not serve its commands. The harness then asks only that the real engine refuses each named command
// with its one refusal, «<command> is not implemented yet». These tests hold that check itself, on transcripts made by hand.

const NOT_YET = (type: string) => `< error INTERNAL {"detail":"${type} is not implemented yet"}`;

describe("unservedAnswers", () => {
  test("is empty when every named command was answered «not implemented yet»", () => {
    const lines = ["> autopilot.estimate {}", NOT_YET("autopilot.estimate"), "> autopilot.start {}", NOT_YET("autopilot.start")];
    expect(unservedAnswers(lines, ["autopilot.estimate", "autopilot.start"])).toEqual([]);
  });

  test("reports a command that was served", () => {
    const lines = ["> autopilot.estimate {}", '< ok {"preview":{}}'];
    expect(unservedAnswers(lines, ["autopilot.estimate"])).toEqual(['autopilot.estimate answered < ok {"preview":{}}']);
  });

  test("reports a command that was refused for another reason, even an INTERNAL one", () => {
    expect(unservedAnswers(["> autopilot.start {}", "< error VALIDATION {}"], ["autopilot.start"])).toEqual(["autopilot.start answered < error VALIDATION {}"]);
    expect(unservedAnswers(["> autopilot.start {}", '< error INTERNAL {"detail":"the engine bridge failed"}'], ["autopilot.start"])).toHaveLength(1);
    expect(unservedAnswers(["> autopilot.start {}", NOT_YET("autopilot.stop")], ["autopilot.start"])).toHaveLength(1);
  });

  test("lets a command that is served in part say which part: «videos.delete with rejectPhotos»", () => {
    const lines = ["> videos.delete {}", '< error INTERNAL {"detail":"videos.delete with rejectPhotos is not implemented yet"}'];
    expect(unservedAnswers(lines, ["videos.delete"])).toEqual([]);
  });

  test("skips the events and notes between a command and its answer, and ignores commands it was not asked about", () => {
    const lines = ["> autopilot.pause {}", "# a note", 'event video.changed {"change":"removed"}', NOT_YET("autopilot.pause"), "> videos.list {}", '< ok {"videos":[]}'];
    expect(unservedAnswers(lines, ["autopilot.pause"])).toEqual([]);
  });

  test("reports a command that was sent and never answered", () => {
    expect(unservedAnswers(["> autopilot.pause {}"], ["autopilot.pause"])).toEqual(["autopilot.pause was never answered"]);
  });

  test("a story that never sent a named command reports it: a pending story must exercise what it names", () => {
    expect(unservedAnswers(["> videos.list {}", '< ok {"videos":[]}'], ["autopilot.pause"])).toEqual(["autopilot.pause was never sent"]);
  });

  test("a command named twice is checked once", () => {
    expect(unservedAnswers(["> autopilot.pause {}", NOT_YET("autopilot.pause")], ["autopilot.pause", "autopilot.pause"])).toEqual([]);
  });
});

// Stage 4, S4.6a: the other half of a pending story. Once the real engine serves a command but the mock is not complete (S4.8), the story cannot match line for line yet; the
// real engine is then held to the opposite: each such command must be SERVED, answered with anything but «not implemented yet» (an ok, or a refusal of its own).

describe("servedProblems", () => {
  test("is empty when every named command was answered, by an ok or by a refusal of its own", () => {
    const lines = ["> autopilot.estimate {}", '< ok {"preview":{}}', "> autopilot.start {}", '< error PRICE_CHANGED {"detail":"x"}', "> autopilot.stop {}", '< error NOT_FOUND {"detail":"y"}'];
    expect(servedProblems(lines, ["autopilot.estimate", "autopilot.start", "autopilot.stop"])).toEqual([]);
  });

  test("reports a command that is still refused as not implemented", () => {
    const lines = ["> autopilot.pause {}", NOT_YET("autopilot.pause")];
    expect(servedProblems(lines, ["autopilot.pause"])).toEqual([`autopilot.pause answered ${NOT_YET("autopilot.pause")}, but the engine serves it now`]);
  });

  test("reports an INTERNAL answer of any kind: a served command that breaks is not served (L11)", () => {
    const lines = ["> autopilot.pause {}", '< error INTERNAL {"detail":"the launch\'s view does not fit the contract"}'];
    expect(servedProblems(lines, ["autopilot.pause"])).toHaveLength(1);
  });

  test("reports a command that was sent once served and once not: every send counts", () => {
    const lines = ["> autopilot.pause {}", '< ok {"launch":{}}', "> autopilot.pause {}", NOT_YET("autopilot.pause")];
    expect(servedProblems(lines, ["autopilot.pause"])).toHaveLength(1);
  });

  test("reports a command that was sent and never answered, and one that was never sent", () => {
    expect(servedProblems(["> autopilot.pause {}"], ["autopilot.pause"])).toEqual(["autopilot.pause was never answered"]);
    expect(servedProblems(["> videos.list {}", '< ok {"videos":[]}'], ["autopilot.pause"])).toEqual(["autopilot.pause was never sent"]);
  });

  test("skips the events and notes between a command and its answer, and ignores commands it was not asked about", () => {
    const lines = ["> autopilot.pause {}", "# a note", 'event autopilot.changed {"launch":{}}', '< ok {"launch":{}}', "> autopilot.stop {}", NOT_YET("autopilot.stop")];
    expect(servedProblems(lines, ["autopilot.pause"])).toEqual([]);
  });

  test("a command named twice is checked once", () => {
    expect(servedProblems(["> autopilot.pause {}", NOT_YET("autopilot.pause")], ["autopilot.pause", "autopilot.pause"])).toHaveLength(1);
  });
});
