import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../engine/montage";
import { notYetSupportedIssues } from "./notYetSupported";
import { trackIssues } from "./trackIssues";

// 3c.5: N9 is lifted for a trending track, and the engine's referential answer for it is `track-unavailable` or
// `track-too-short`: ONE function, used by the engine and by the mock, so the two cannot say it differently.

const photoClip = (n: number, durationMs: number): MontageDraft["clips"][number] => ({
  clipId: `clip-${n}`,
  durationMs,
  transitionIn: "cut",
  kind: "photo",
  cell: { photo: { source: "scene", photoId: `photo-${n}` }, focus: null },
  motion: "static",
});
const trending = (startMs: number, trackId = "4199287736976977"): MontageDraft["music"] => ({ source: "trending", trackId, startMs });
const spec = (music: MontageDraft["music"], clips: MontageDraft["clips"] = [photoClip(1, 2000), photoClip(2, 2000)]): Pick<MontageDraft, "clips" | "music"> => ({ clips, music });

describe("notYetSupportedIssues and music (N9)", () => {
  test("no longer refuses a trending track", () => {
    expect(notYetSupportedIssues({ ...spec(trending(0)), layers: [] })).toEqual([]);
  });

  test("still refuses an own track, until 3f.4", () => {
    expect(notYetSupportedIssues({ ...spec({ source: "own", mediaId: "media-0000001", startMs: 0 }), layers: [] })).toEqual([{ code: "not-yet-supported", path: ["music"] }]);
  });

  test("says nothing for a montage with no music", () => {
    expect(notYetSupportedIssues({ ...spec(null), layers: [] })).toEqual([]);
  });
});

describe("trackIssues", () => {
  const holds = (decodedMs: number) => (trackId: string) => (trackId === "4199287736976977" ? { decodedMs } : null);

  test("is nothing for a montage with no music", () => {
    expect(trackIssues(spec(null), holds(8000))).toEqual([]);
  });

  test("is nothing for a track that is stored and long enough", () => {
    expect(trackIssues(spec(trending(0)), holds(8000))).toEqual([]);
  });

  test("is nothing for a track exactly as long as startMs plus the montage", () => {
    expect(trackIssues(spec(trending(4000)), holds(8000))).toEqual([]);
  });

  test("is track-too-short for a track one millisecond short of startMs plus the montage", () => {
    expect(trackIssues(spec(trending(4001)), holds(8000))).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });

  test("is track-too-short for a start beyond the end of the track", () => {
    expect(trackIssues(spec(trending(600_000)), holds(8000))).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });

  test("is track-unavailable for a track the store does not hold", () => {
    expect(trackIssues(spec(trending(0, "123")), holds(8000))).toEqual([{ code: "track-unavailable", path: ["music"] }]);
  });

  test("is track-unavailable for every track when there is no store at all", () => {
    expect(trackIssues(spec(trending(0)), undefined)).toEqual([{ code: "track-unavailable", path: ["music"] }]);
  });

  test("is nothing for an own track: that is still N9's, and no track store holds it", () => {
    expect(trackIssues(spec({ source: "own", mediaId: "media-0000001", startMs: 0 }), undefined)).toEqual([]);
  });

  test("measures the montage by the clips' own lengths", () => {
    expect(trackIssues(spec(trending(0), [photoClip(1, 3000), photoClip(2, 3000), photoClip(3, 3000)]), holds(8000))).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });

  test("never asks the store about a track the montage does not use", () => {
    const asked: string[] = [];
    trackIssues(spec(null), (id) => (asked.push(id), null));
    expect(asked).toEqual([]);
  });
});
