import { describe, expect, test } from "bun:test";
import type { LaunchVideo } from "../engine/autopilot";
import { videoDone } from "../engine/autopilot.fixtures";
import { isRemoved, joinVideoFacts, publishedOverall, type MarksRead } from "./videoFacts";

// S4.6g: how a launch's finished videos meet the library's facts, shared by the engine and the mock so both answer alike: a video whose record is not among the avatar's is
// removed, a mark is the log's word, and a log that cannot be read is `unknown`, never a plain null.

const AT = "2026-10-09T11:00:00.000Z";
const ok = (at: Record<string, string>): MarksRead => ({ state: "ok", at: new Map(Object.entries(at)) });
const ID = videoDone.videoId ?? "";
const rendering: LaunchVideo = { ...videoDone, state: "rendering", bytes: null, durationMs: null, track: null };

describe("isRemoved", () => {
  test("is true only when the avatar's records were looked at and the video's id is not among them", () => {
    expect(isRemoved(new Set(["video-other-0001"]), ID)).toBe(true);
    expect(isRemoved(new Set([ID]), ID)).toBe(false);
  });

  test("is false when the records could not be looked at: not knowing is not a delete", () => {
    expect(isRemoved(undefined, ID)).toBe(false);
  });

  test("is false for a video with no file id", () => {
    expect(isRemoved(new Set(), null)).toBe(false);
  });
});

describe("joinVideoFacts", () => {
  test("gives a finished video the time of its mark", () => {
    expect(joinVideoFacts(videoDone, new Set([ID]), ok({ [ID]: AT })).publishedAt).toBe(AT);
  });

  test("leaves a finished video unmarked when the log reads and does not hold it", () => {
    const joined = joinVideoFacts(videoDone, new Set([ID]), ok({}));
    expect(joined.publishedAt).toBeNull();
    expect("publishedUnknown" in joined).toBe(false);
  });

  test("says the mark is unknown, with no time, when the log cannot be read", () => {
    expect(joinVideoFacts(videoDone, new Set([ID]), { state: "unknown" })).toMatchObject({ publishedAt: null, publishedUnknown: true });
  });

  test("an avatar that was never marked has no log: unmarked, and not unknown", () => {
    const joined = joinVideoFacts(videoDone, new Set([ID]), { state: "absent" });
    expect(joined.publishedAt).toBeNull();
    expect("publishedUnknown" in joined).toBe(false);
  });

  test("with no marks given (no way to look) the video keeps what it had", () => {
    expect(joinVideoFacts({ ...videoDone, publishedAt: AT }, new Set([ID]), undefined).publishedAt).toBe(AT);
  });

  test("marks a finished video whose record is gone as removed, and keeps its mark", () => {
    expect(joinVideoFacts(videoDone, new Set(), ok({ [ID]: AT }))).toMatchObject({ removed: true, publishedAt: AT });
  });

  test("returns a video that is not finished as it was", () => {
    expect(joinVideoFacts(rendering, new Set(), ok({ [ID]: AT }))).toEqual(rendering);
  });
});

describe("publishedOverall", () => {
  test("is unknown when any avatar's log cannot be read", () => {
    expect(publishedOverall([ok({}), { state: "unknown" }])).toBe("unknown");
  });

  test("is ok when the logs read and at least one avatar has marks", () => {
    expect(publishedOverall([{ state: "absent" }, ok({})])).toBe("ok");
  });

  test("is absent while no avatar has a log, as videos.list has none", () => {
    expect(publishedOverall([{ state: "absent" }])).toBeUndefined();
    expect(publishedOverall([])).toBeUndefined();
  });
});
