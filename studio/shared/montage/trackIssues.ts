import type { MontageDraft, MontageIssue } from "../engine/montage";

/**
 * The referential half for a montage's music (3c.5): a trending track must be in the track store, and long enough for
 * `startMs` plus the montage's length. One function for the engine (`videos.render`, `montages.get`) and for the mock, so the
 * two answer the same way.
 *
 * `stored` is the store's record of a track, by id: its proven length in ms, or null when it does not hold it as stored. With
 * no store (`undefined`) no track is held. An own track is not judged here: it stays `not-yet-supported` until 3f.4 (N9), and
 * there is no store for it.
 */
export function trackIssues(spec: Pick<MontageDraft, "clips" | "music">, stored: ((trackId: string) => { readonly decodedMs: number } | null) | undefined): MontageIssue[] {
  const music = spec.music;
  if (music === null || music.source !== "trending") return [];
  const held = stored?.(music.trackId) ?? null;
  if (held === null) return [{ code: "track-unavailable", path: ["music"] }];
  const montageMs = spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
  if (held.decodedMs < music.startMs + montageMs) return [{ code: "track-too-short", path: ["music"] }];
  return [];
}
