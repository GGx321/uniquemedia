import type { MontageDraft, MontageIssue } from "../engine/montage";

/**
 * The referential half for a montage's music: a trending track must be in the track store (3c.5), an own track must be an audio media of the library
 * (3f.4), and either must be long enough for `startMs` plus the montage's length. One function for the engine (`videos.render`, `montages.get`) and for
 * the mock, so the two answer the same way.
 *
 * - `stored` is the track store's record of a trending track, by id: its proven length in ms, or null when it does not hold it as stored. With no store
 *   (`undefined`) no track is held.
 * - `ownTrack` is the library's record of an own track, by media id: its decoded length in ms, or null when the library does not hold it as an audio media.
 *   With no media store (`undefined`) none is held.
 *
 * The issues: `track-unavailable` (a trending track the store lacks), `media-unavailable` (an own track the library lacks or holds as another kind: the code
 * every own media gets, at the `music` path), `track-too-short` (`decodedMs` or `durationMs` under `startMs + total`; equal passes).
 */
export function trackIssues(
  spec: Pick<MontageDraft, "clips" | "music">,
  stored: ((trackId: string) => { readonly decodedMs: number } | null) | undefined,
  ownTrack?: ((mediaId: string) => { readonly durationMs: number } | null) | undefined,
): MontageIssue[] {
  return [...trendingTrackIssues(spec, stored), ...ownTrackIssues(spec, ownTrack)];
}

const montageMsOf = (spec: Pick<MontageDraft, "clips">): number => spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);

/** The issues of a TRENDING track only: nothing for an own track or for no music. */
export function trendingTrackIssues(spec: Pick<MontageDraft, "clips" | "music">, stored: ((trackId: string) => { readonly decodedMs: number } | null) | undefined): MontageIssue[] {
  const music = spec.music;
  if (music === null || music.source !== "trending") return [];
  const held = stored?.(music.trackId) ?? null;
  if (held === null) return [{ code: "track-unavailable", path: ["music"] }];
  if (held.decodedMs < music.startMs + montageMsOf(spec)) return [{ code: "track-too-short", path: ["music"] }];
  return [];
}

/** The issues of an OWN track only: nothing for a trending track or for no music. */
export function ownTrackIssues(spec: Pick<MontageDraft, "clips" | "music">, ownTrack: ((mediaId: string) => { readonly durationMs: number } | null) | undefined): MontageIssue[] {
  const music = spec.music;
  if (music === null || music.source !== "own") return [];
  const held = ownTrack?.(music.mediaId) ?? null;
  if (held === null) return [{ code: "media-unavailable", path: ["music"] }];
  if (held.durationMs < music.startMs + montageMsOf(spec)) return [{ code: "track-too-short", path: ["music"] }];
  return [];
}
