import { hashText } from "./hash";

// The autopilot's track chooser (Stage 4 plan §7 and its amendments). Pure: the candidates, the owner's «для автопилота» flags and the avatar's
// usage come in as data; the answer is a track with its start point, or a typed «waiting».
//
// - Candidates: trending tracks that are not explicit (in the current list or kept from an earlier one), plus the owner's own tracks that are
//   flagged for the autopilot. An explicit track and an unflagged own track NEVER qualify.
// - A track FITS a video only if its length is at least `startMs` plus the video's length (equal passes).
// - Among the tracks that fit, the least used for the avatar ranks first. The count only RANKS: it never excludes a track, so a track used
//   many times is still chosen when it is the only one that fits.
// - The video waits only when there is no candidate at all, or every candidate is too short.

/** A video among the avatar's last this many counts as «recent» for the tie rule. */
export const AUTOPILOT_RECENT_VIDEOS = 5;
/** The likely default start seen in many tracks (`LIKELY_DEFAULT_MS` of the track shape), tried after every real highlight. */
export const LIKELY_DEFAULT_START_MS = 1500;
/** The contract's furthest start into a track (10 minutes), mirrored so this module needs no zod. */
const MAX_SOURCE_OFFSET_MS = 600_000;

export interface TrackHighlight {
  readonly ms: number;
  readonly likelyDefault: boolean;
}

/** A track the chooser may pick. `durationMs` is the PROVEN length (`decodedMs` of a stored trending track, the decoded length of an own one). */
export type TrackCandidate =
  | {
      readonly source: "trending";
      readonly trackId: string;
      readonly durationMs: number;
      readonly highlights: readonly TrackHighlight[];
      readonly explicit: boolean;
      /** In the current trend list, as against kept from an earlier one. */
      readonly inList: boolean;
    }
  | { readonly source: "own"; readonly mediaId: string; readonly durationMs: number };

/** How the avatar's tracks have been used, from its video records (`trackUsage`) plus the videos of this launch. */
export interface TrackUsage {
  /** By `trackKey`: how many of the avatar's videos used the track. A missing key is zero. */
  readonly counts: ReadonlyMap<string, number>;
  /** The keys of the avatar's last videos (`AUTOPILOT_RECENT_VIDEOS`), newest first. */
  readonly recent: readonly string[];
  /** False when some records could not be read: the counts may be low. The chooser still ranks by them and never waits because of it. */
  readonly complete: boolean;
}

export type ChosenMusic =
  | { readonly source: "trending"; readonly trackId: string; readonly startMs: number }
  | { readonly source: "own"; readonly mediaId: string; readonly startMs: number };

/** `no-candidate`: nothing qualifies (none stored, all explicit, no own track flagged). `all-too-short`: something qualifies but nothing is long enough. */
export type TrackChoice = { readonly kind: "chosen"; readonly music: ChosenMusic } | { readonly kind: "waiting"; readonly reason: "no-candidate" | "all-too-short" };

export interface ChooseTrackInput {
  readonly candidates: readonly TrackCandidate[];
  /** The media ids of the own tracks the owner flagged «для автопилота» (the flag store, S4.5d). */
  readonly flaggedOwn: ReadonlySet<string>;
  readonly usage: TrackUsage;
  /** The video's length: `autopilotTotalMs` of its spec. */
  readonly totalMs: number;
  /** The video's seed: the last tie-break. */
  readonly seed: number;
}

/** The key a track is counted under: the source keeps a trending id and an own media id apart. */
export const trackKey = (source: "trending" | "own", id: string): string => `${source}:${id}`;

const keyOf = (candidate: TrackCandidate): string => (candidate.source === "trending" ? trackKey("trending", candidate.trackId) : trackKey("own", candidate.mediaId));

export const emptyUsage = (): TrackUsage => ({ counts: new Map<string, number>(), recent: [], complete: true });

/** The usage after one more video used `key`: the count up by one, the key first among the recent videos. The original is not changed. */
export function withUse(usage: TrackUsage, key: string): TrackUsage {
  const counts = new Map(usage.counts);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return { counts, recent: [key, ...usage.recent].slice(0, AUTOPILOT_RECENT_VIDEOS), complete: usage.complete };
}

/**
 * Where in the track the video starts, or null when the track is too short for it. The first highlight (ascending, the likely default
 * excluded) whose window fits; else 1500 if it fits; else 0 if it fits. A window fits when `start + totalMs <= durationMs`.
 */
export function startFor(candidate: TrackCandidate, totalMs: number): number | null {
  const fits = (start: number): boolean => Number.isSafeInteger(start) && start >= 0 && start <= MAX_SOURCE_OFFSET_MS && start + totalMs <= candidate.durationMs;
  if (candidate.source === "trending") {
    const ascending = candidate.highlights
      .filter((highlight) => !highlight.likelyDefault && highlight.ms !== LIKELY_DEFAULT_START_MS)
      .map((highlight) => highlight.ms)
      .sort((a, b) => a - b);
    const hit = ascending.find(fits);
    if (hit !== undefined) return hit;
  }
  if (fits(LIKELY_DEFAULT_START_MS)) return LIKELY_DEFAULT_START_MS;
  return fits(0) ? 0 : null;
}

const qualifies = (candidate: TrackCandidate, flaggedOwn: ReadonlySet<string>): boolean => (candidate.source === "trending" ? !candidate.explicit : flaggedOwn.has(candidate.mediaId));

/** On a tie in count and recency: a track of the current trend list, then an own track, then a trend kept from an older list. */
const classOf = (candidate: TrackCandidate): number => (candidate.source === "own" ? 1 : candidate.inList ? 0 : 2);

/** The track for one video, or why it waits. See the module's notes for the rules. */
export function chooseTrack(input: ChooseTrackInput): TrackChoice {
  const { usage, totalMs, seed } = input;
  const qualifying = input.candidates.filter((candidate) => qualifies(candidate, input.flaggedOwn));
  if (qualifying.length === 0) return { kind: "waiting", reason: "no-candidate" };

  const recent = new Set(usage.recent);
  const fitting = qualifying.flatMap((candidate) => {
    const startMs = startFor(candidate, totalMs);
    if (startMs === null) return [];
    const key = keyOf(candidate);
    return [{ candidate, startMs, key, count: usage.counts.get(key) ?? 0, isRecent: recent.has(key) ? 1 : 0, tie: hashText(seed, key) }];
  });
  fitting.sort((a, b) => a.count - b.count || a.isRecent - b.isRecent || classOf(a.candidate) - classOf(b.candidate) || a.tie - b.tie || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const best = fitting[0];
  if (best === undefined) return { kind: "waiting", reason: "all-too-short" };
  const { candidate, startMs } = best;
  return { kind: "chosen", music: candidate.source === "trending" ? { source: "trending", trackId: candidate.trackId, startMs } : { source: "own", mediaId: candidate.mediaId, startMs } };
}
