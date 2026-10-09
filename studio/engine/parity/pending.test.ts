import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { unservedAnswers } from "./testing/pending";
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
