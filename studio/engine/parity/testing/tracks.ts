import type { MockTrackSeed } from "../../../renderer/engine/mockMusicStore";
import type { MusicTrack } from "../../music/listSchema";
import { listTracks } from "../../music/testing/storeKit";

// The tracks the parity rigs' music stores hold when a scenario says so (3d.1b, `Control.musicTracks`). The real rig's TrackStore
// downloads them from a fake CDN (the 3c.1 list's real URLs, the 3c.4 excerpts), the mock is seeded with what the store keeps of
// them: the SAME list, so the two engines are told one story. No network.

/** What each of the first tracks of the fixture list is made to look like: neutral names, and the API's own mess in the highlights (unsorted, repeated, past the end, the 1500 default). */
const SHAPES: readonly { title: string; artist: string | null; highlightsMs: readonly number[]; explicit: boolean }[] = [
  { title: "Parity track one", artist: "Parity artist", highlightsMs: [5_000, 1_500, 800, 3_000, 800], explicit: false },
  { title: "Parity track two", artist: null, highlightsMs: [4_000, 99_000, 2_000], explicit: true },
  { title: "Parity track three", artist: "Parity artist", highlightsMs: [1_500], explicit: false },
  { title: "Parity track four", artist: null, highlightsMs: [], explicit: false },
];

export const PARITY_TRACK_COUNT = SHAPES.length;

/** The list the real rig's store is given: the fixture's tracks (each claiming the length of the excerpt that serves it), with the shapes above. */
export function parityListTracks(): MusicTrack[] {
  return listTracks(PARITY_TRACK_COUNT).map((track, i) => ({
    ...track,
    title: SHAPES[i]?.title ?? null,
    artist: SHAPES[i]?.artist ?? null,
    highlightsMs: SHAPES[i]?.highlightsMs ?? [],
    explicit: SHAPES[i]?.explicit ?? false,
  }));
}

/** The envelope the decode of track `index` keeps: one value per 50 ms, none alike from track to track. */
export function parityPeaks(index: number, durationMs: number): number[] {
  return Array.from({ length: Math.ceil(durationMs / 50) }, (_, step) => (step * (31 + index * 6) + index * 113) % 1001);
}

/** What the mock is seeded with for the same list. */
export function parityMockSeeds(tracks: readonly MusicTrack[]): MockTrackSeed[] {
  return tracks.map((track, i) => ({
    trackId: track.trackId,
    title: track.title ?? "Untitled track",
    artist: track.artist,
    durationMs: track.durationMs,
    explicit: track.explicit,
    highlightsMs: track.highlightsMs,
    hasCover: track.coverUrl !== null,
    peaks: parityPeaks(i, track.durationMs),
  }));
}
