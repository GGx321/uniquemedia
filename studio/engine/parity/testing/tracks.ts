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

/**
 * 3d.3b verify: when a scenario asks for it, the decode of track one proves a length 1.9 s SHORTER than the list claims (the
 * store's decode check allows up to max(2 s, 5 %) apart). The store, `music.list` and every judgement go by the proven one.
 */
export const PARITY_DECODED_APART = { index: 0, shortByMs: 1_900 } as const;

/** The length the decode of track `index` proves, of a claimed `claimMs`. */
export function parityDecodedMs(index: number, claimMs: number, apart: boolean): number {
  return apart && index === PARITY_DECODED_APART.index ? claimMs - PARITY_DECODED_APART.shortByMs : claimMs;
}

/** What the mock is seeded with for the same list (`apart`: track one decoded shorter than its claim, as above). */
export function parityMockSeeds(tracks: readonly MusicTrack[], apart = false): MockTrackSeed[] {
  return tracks.map((track, i) => {
    const decodedMs = parityDecodedMs(i, track.durationMs, apart);
    return {
      trackId: track.trackId,
      title: track.title ?? "Untitled track",
      artist: track.artist,
      durationMs: decodedMs,
      ...(decodedMs === track.durationMs ? {} : { declaredMs: track.durationMs }),
      explicit: track.explicit,
      highlightsMs: track.highlightsMs,
      hasCover: track.coverUrl !== null,
      peaks: parityPeaks(i, decodedMs),
    };
  });
}
