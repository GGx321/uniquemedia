import type { LaunchVideo } from "../engine/autopilot";

// S4.6g: how a launch's finished videos meet the library's facts — the owner's «Опубликовано» marks (`published.jsonl`) and whether the video's record still exists. One
// definition, used by the engine's `autopilot.get` / `autopilot.list` and by the renderer's mock, so the two cannot answer differently. Pure.

/**
 * An avatar's marks as its published log reads. `absent`: nothing was ever marked (no log). `ok`: `at` holds the time of the mark of every video whose last line sets it.
 * `unknown`: the log could not be read (torn, damaged, or the disk did not answer). The engine's `PublishedRead` fits it.
 */
export type MarksRead = { readonly state: "absent" } | { readonly state: "ok"; readonly at: ReadonlyMap<string, string> } | { readonly state: "unknown" };

/**
 * Whether a finished video's record was deleted since: the avatar's records were looked at (`records`) and its file id is not among them. `records` undefined means they could
 * not be looked at, and not knowing is not a delete.
 */
export function isRemoved(records: ReadonlySet<string> | undefined, videoId: string | null): boolean {
  return records !== undefined && videoId !== null && !records.has(videoId);
}

/**
 * A finished video with its mark and its record's fate; any other video is returned as it is. `marks` undefined (no way to look) leaves the mark the video had; an `unknown`
 * log gives `publishedUnknown` and no time, so the window never reads a mark it could not see as "not published".
 */
export function joinVideoFacts(video: LaunchVideo, records: ReadonlySet<string> | undefined, marks: MarksRead | undefined): LaunchVideo {
  if (video.state !== "done") return video;
  const removed = isRemoved(records, video.videoId) ? { removed: true as const } : {};
  if (marks === undefined) return { ...video, ...removed };
  if (marks.state === "unknown") return { ...video, publishedAt: null, publishedUnknown: true, ...removed };
  const at = marks.state === "ok" && video.videoId !== null ? (marks.at.get(video.videoId) ?? null) : null;
  return { ...video, publishedAt: at, ...removed };
}

/** `autopilot.get`'s `published`, as `videos.list`'s: `unknown` when any avatar's log cannot be read, `ok` when one reads and holds marks, absent while no avatar has a log. */
export function publishedOverall(marks: readonly MarksRead[]): "ok" | "unknown" | undefined {
  if (marks.some((m) => m.state === "unknown")) return "unknown";
  return marks.some((m) => m.state === "ok") ? "ok" : undefined;
}
