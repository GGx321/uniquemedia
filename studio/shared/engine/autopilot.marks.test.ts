import { describe, expect, test } from "bun:test";
import { AutopilotGetResult, LaunchVideo, UnreadableLaunch } from "./autopilot";
import { OkResponse } from "./commands";
import { PROTOCOL_VERSION } from "./envelope";
import { EngineError } from "./errors";
import { LATER, NOW, view, videoDone } from "./autopilot.fixtures";

// Stage 4, S4.6g (additive, no bump): what `autopilot.get` says of a launch's videos after the owner's «Опубликовано» marks and deletes (`removed`, `publishedAt`,
// `publishedUnknown`, the result's `published`), where an unreadable launch entry came from (`UnreadableLaunch.scope`) and a delete whose outcome is not known
// (`EngineError.outcome`). Each field is optional, so a payload from before S4.6g parses unchanged and gains nothing.

const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;
const withVideo = (over: Record<string, unknown>) => ({ ...videoDone, ...over });

describe("LaunchVideo.removed", () => {
  test("a video from before S4.6g parses and gains no field", () => {
    const parsed = LaunchVideo.parse(videoDone);
    expect(parsed).toEqual(videoDone);
    expect("removed" in parsed).toBe(false);
    expect("publishedUnknown" in parsed).toBe(false);
  });

  test("a finished video whose record was deleted since is removed", () => {
    expect(LaunchVideo.parse(withVideo({ removed: true })).removed).toBe(true);
  });

  test("removed is the flag true or absent, never false or another word", () => {
    expect(LaunchVideo.safeParse(withVideo({ removed: false })).success).toBe(false);
    expect(LaunchVideo.safeParse(withVideo({ removed: "yes" })).success).toBe(false);
  });

  test("only a finished video can be removed: one still rendering, waiting for music or dropped has no record to lose", () => {
    const rendering = { ...videoDone, state: "rendering", bytes: null, durationMs: null, track: null };
    expect(LaunchVideo.safeParse(rendering).success).toBe(true);
    expect(LaunchVideo.safeParse({ ...rendering, removed: true }).success).toBe(false);
    const waiting = { ...videoDone, state: "waiting-music", videoId: null, bytes: null, track: null };
    expect(LaunchVideo.safeParse(waiting).success).toBe(true);
    expect(LaunchVideo.safeParse({ ...waiting, removed: true }).success).toBe(false);
    const dropped = { ...videoDone, state: "dropped", dropReason: "render-failed", bytes: null };
    expect(LaunchVideo.safeParse(dropped).success).toBe(true);
    expect(LaunchVideo.safeParse({ ...dropped, removed: true }).success).toBe(false);
  });

  test("a removed video may keep its mark: the log outlives the record", () => {
    expect(LaunchVideo.safeParse(withVideo({ removed: true, publishedAt: NOW })).success).toBe(true);
  });
});

describe("LaunchVideo.publishedUnknown", () => {
  test("a finished video whose avatar's marks cannot be read says so, and carries no time", () => {
    expect(LaunchVideo.parse(withVideo({ publishedUnknown: true })).publishedUnknown).toBe(true);
  });

  test("unknown and a time contradict each other: the mark is either read or not", () => {
    expect(LaunchVideo.safeParse(withVideo({ publishedUnknown: true, publishedAt: LATER })).success).toBe(false);
  });

  test("the flag is true or absent, and only a finished video has a mark to be unknown", () => {
    expect(LaunchVideo.safeParse(withVideo({ publishedUnknown: false })).success).toBe(false);
    const dropped = { ...videoDone, state: "dropped", dropReason: "render-failed", bytes: null };
    expect(LaunchVideo.safeParse({ ...dropped, publishedUnknown: true }).success).toBe(false);
  });
});

describe("AutopilotGetResult.published", () => {
  const base = { launch: view, log: [], videos: [videoDone] };

  test("an answer from before S4.6g parses and gains no field", () => {
    expect("published" in AutopilotGetResult.parse(base)).toBe(false);
  });

  test("says whether the marks could be read, as videos.list does: ok or unknown", () => {
    expect(answers("autopilot.get", { ...base, published: "ok" })).toBe(true);
    expect(answers("autopilot.get", { ...base, published: "unknown" })).toBe(true);
    expect(answers("autopilot.get", { ...base, published: "maybe" })).toBe(false);
    expect(answers("autopilot.get", { ...base, published: true })).toBe(false);
  });
});

describe("UnreadableLaunch.scope", () => {
  const entry = { entryId: "0123456789abcdef" };

  test("an entry from before S4.6g parses and gains no field", () => {
    expect("scope" in UnreadableLaunch.parse({ ...entry, reason: "io-error" })).toBe(false);
  });

  test("an entry that did not read from the disk says whether it was the folder or one file", () => {
    expect(UnreadableLaunch.parse({ ...entry, reason: "io-error", scope: "folder" }).scope).toBe("folder");
    expect(UnreadableLaunch.parse({ ...entry, reason: "io-error", scope: "file" }).scope).toBe("file");
    expect(UnreadableLaunch.safeParse({ ...entry, reason: "io-error", scope: "disk" }).success).toBe(false);
  });

  test("a damaged or newer file is always a file: scope is for the io-error only", () => {
    expect(UnreadableLaunch.safeParse({ ...entry, reason: "invalid", scope: "file" }).success).toBe(false);
    expect(UnreadableLaunch.safeParse({ ...entry, reason: "too-new", scope: "file" }).success).toBe(false);
  });
});

describe("EngineError.outcome", () => {
  test("a refusal from before S4.6g parses and gains no field", () => {
    const parsed = EngineError.parse({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    expect("outcome" in parsed).toBe(false);
  });

  test("an export refusal can say the work may have gone on: its outcome is unknown", () => {
    expect(EngineError.parse({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", outcome: "unknown" }).outcome).toBe("unknown");
  });

  test("the outcome is the word unknown, and only an EXPORT_UNAVAILABLE carries it", () => {
    expect(EngineError.safeParse({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", outcome: "failed" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "INTERNAL", outcome: "unknown" }).success).toBe(false);
  });
});
