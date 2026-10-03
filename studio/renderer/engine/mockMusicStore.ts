import { MAX_LISTED_TRACKS, type TrackSummary } from "../../shared/engine";
import { normaliseHighlights, provenShape, windowPeaks } from "../../shared/music/trackShape";

// The dev mock's track store (3d.1b): what the engine's `TrackStore` keeps and answers for `music.list` and `music.peaks`
// (studio/engine/music/trackStore.ts), as plain data. The highlights and the waveform window go through the SAME functions
// the store uses (studio/shared/music/trackShape.ts), so the mock cannot offer them differently. Nothing is downloaded or
// decoded: a seed says what the store would have kept after a download.

/** One stored track as the mock is told about it: what the list said, plus the waveform the decode kept. */
export interface MockTrackSeed {
  readonly trackId: string;
  readonly title: string;
  readonly artist: string | null;
  /** The proven length of the audio, in ms: the store's `decodedMs`, what `music.list` gives and every judgement goes by. */
  readonly durationMs: number;
  /**
   * What the list CLAIMED, when the decode proved another length (the engine's decode allows up to max(2 s, 5 %) apart);
   * absent, the same as `durationMs`. Like the engine, the highlights are first cut at the claim, then at the proven end.
   */
  readonly declaredMs?: number;
  readonly explicit: boolean;
  /** As the list's API sent them: unsorted, with repeats and starts past the end. The mock offers them as the store does. */
  readonly highlightsMs: readonly number[];
  readonly hasCover: boolean;
  /** The 50 ms envelope the store keeps per track, each 0 to 1000. */
  readonly peaks: readonly number[];
}

/** What the mock holds of a stored track: the summary `music.list` answers and the envelope `music.peaks` reads. */
export interface MockTrack {
  readonly summary: TrackSummary;
  readonly peaks: readonly number[];
}

/** The envelope's step, as the store writes it (`EnvelopeSchema.stepMs`). */
const ENVELOPE_STEP_MS = 50;

export function mockTrack(seed: MockTrackSeed): MockTrack {
  // As the engine: highlights normalised against the list's claim when the list is stored, the summary cut at the proven length.
  const shape = provenShape(normaliseHighlights(seed.highlightsMs, seed.declaredMs ?? seed.durationMs), seed.durationMs);
  return {
    summary: {
      trackId: seed.trackId,
      title: seed.title,
      artist: seed.artist,
      durationMs: shape.durationMs,
      explicit: seed.explicit,
      highlights: shape.highlights,
      hasCover: seed.hasCover,
    },
    peaks: seed.peaks,
  };
}

/** `music.list`: the stored tracks in list order, at most 100. */
export function listedTracks(tracks: readonly MockTrack[]): TrackSummary[] {
  return tracks.slice(0, MAX_LISTED_TRACKS).map((track) => track.summary);
}

/** `music.peaks`: a window of a stored track's waveform, or null when the store does not hold the track. */
export function peaksOfTrack(tracks: readonly MockTrack[], trackId: string, startMs: number, durationMs: number, bars: number): number[] | null {
  const track = tracks.find((candidate) => candidate.summary.trackId === trackId);
  return track === undefined ? null : windowPeaks({ stepMs: ENVELOPE_STEP_MS, peaks: track.peaks }, startMs, durationMs, bars);
}

/** What the store knows of a track for a render's check (`trackIssues`): its proven length, or null when it is not stored. */
export function storedTrack(tracks: readonly MockTrack[], trackId: string): { readonly decodedMs: number } | null {
  const track = tracks.find((candidate) => candidate.summary.trackId === trackId);
  return track === undefined ? null : { decodedMs: track.summary.durationMs };
}

const DEMO_TITLES = ["Golden Hour", "Slow Burn", "City Lights", "Paper Planes", "Last Summer", "Velvet", "Open Road", "Afterglow", "Neon Rain", "Soft Focus"] as const;
const DEMO_ARTISTS = ["Mira Vale", "The Quiet Hours", "Oslo Drive", null, "Juno Lake"] as const;
const DEMO_VARIANTS = ["", " (slowed)", " (live)"] as const;
/** Demo highlights as the API would send them: unsorted, some past the end of a short track, the 1500 default on some. */
const DEMO_HIGHLIGHTS = [
  [42_000, 1_500, 18_000],
  [30_000, 9_000],
  [1_500],
  [75_000, 12_000, 51_000, 1_500],
  [],
] as const;

/** `count` stored tracks for the dev build's music tab: 20 to 80 seconds each, a different waveform each, a few explicit, a few with no cover. */
export function demoTracks(count: number): MockTrackSeed[] {
  return Array.from({ length: count }, (_, i) => {
    const durationMs = 20_000 + ((i * 7_919) % 61) * 1_000;
    return {
      trackId: `demo-track-${String(i + 1).padStart(4, "0")}`,
      title: `${DEMO_TITLES[i % DEMO_TITLES.length]}${DEMO_VARIANTS[Math.floor(i / DEMO_TITLES.length) % DEMO_VARIANTS.length]}`,
      artist: DEMO_ARTISTS[i % DEMO_ARTISTS.length] ?? null,
      durationMs,
      explicit: i % 7 === 3,
      highlightsMs: DEMO_HIGHLIGHTS[i % DEMO_HIGHLIGHTS.length] ?? [],
      hasCover: i % 9 !== 4,
      peaks: Array.from({ length: Math.ceil(durationMs / ENVELOPE_STEP_MS) }, (_, step) => 120 + Math.round(660 * Math.abs(Math.sin(step / (9 + (i % 5) * 3)) * Math.cos(step / 41 + i))) + ((step * 37 + i * 11) % 90)),
    };
  });
}
