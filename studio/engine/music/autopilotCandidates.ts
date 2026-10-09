import type { TrackCandidate } from "../../shared/autopilot/track";
import type { TrendingCandidate } from "./trackStore";

// The candidate list for the autopilot's track chooser (Stage 4, S4.5d; plan §7). Two sources:
//
//   - SAVED TRENDS: every stored trending track, of the current list or kept from an earlier one (`inList` says which; `music.list` offers the current one only, the
//     autopilot is not bound to it), unless it is explicit. «Never explicit» trusts the provider's flag (`explicit = is_explicit === true`, `listSchema.ts`).
//   - OWN TRACKS the owner flagged «для автопилота» (and that are still valid own tracks: `MediaService.autopilotTracks`).
//
// An explicit track and an unflagged own track are NOT in the list. The chooser (`shared/autopilot/track.ts`) filters the same way on its own, so a list built elsewhere cannot
// let one through; this is the list the orchestrator hands it, together with `flaggedOwn`.

/** A flagged own track as the media service tells it: the id and the decoded length. */
export interface FlaggedOwnTrack {
  readonly mediaId: string;
  readonly durationMs: number;
}

export interface AutopilotCandidates {
  readonly candidates: readonly TrackCandidate[];
  /** The ids of the own tracks in `candidates`: the chooser's `flaggedOwn`. */
  readonly flaggedOwn: ReadonlySet<string>;
  /** Saved trends left out for being explicit: the plan screen may say so. */
  readonly explicitSkipped: number;
}

export interface CandidateInput {
  readonly trends: readonly TrendingCandidate[];
  readonly ownFlagged: readonly FlaggedOwnTrack[];
}

/** The list from the two sources. Pure: nothing is changed. Trends first, in the order given, then the own tracks, each once. */
export function buildAutopilotCandidates(input: CandidateInput): AutopilotCandidates {
  const candidates: TrackCandidate[] = [];
  let explicitSkipped = 0;
  for (const trend of input.trends) {
    if (trend.explicit) explicitSkipped++;
    else candidates.push(trend);
  }
  const flaggedOwn = new Set<string>();
  for (const own of input.ownFlagged) {
    if (flaggedOwn.has(own.mediaId)) continue;
    flaggedOwn.add(own.mediaId);
    candidates.push({ source: "own", mediaId: own.mediaId, durationMs: own.durationMs });
  }
  return { candidates, flaggedOwn, explicitSkipped };
}

/** What the engine needs of the track store for a launch (S4.6w): the saved trends the chooser picks from, and the title and artist the results list names a video's track by. `TrackStore` satisfies it. */
export interface AutopilotTrends {
  storedTrends(): TrendingCandidate[];
  labelOf(trackId: string): { title: string | null; artist: string | null } | null;
}

/** No saved trends at all: an engine without a music folder offers the autopilot its own flagged tracks only. */
export const NO_TRENDS: AutopilotTrends = { storedTrends: () => [], labelOf: () => null };

/** Where the lists come from: the track store and the media service (structural, so a test needs neither). */
export interface CandidateSources {
  readonly trends: { storedTrends(): TrendingCandidate[] };
  readonly media: { autopilotTracks(): Promise<FlaggedOwnTrack[]> };
}

/** Reads both sources and builds the list. Free: no request, no download. */
export async function collectAutopilotCandidates(sources: CandidateSources): Promise<AutopilotCandidates> {
  return buildAutopilotCandidates({ trends: sources.trends.storedTrends(), ownFlagged: await sources.media.autopilotTracks() });
}
