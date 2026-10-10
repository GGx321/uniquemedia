import type { LaunchPreview } from "../../shared/engine/autopilot";
import { buildAutopilotCandidates, type AutopilotCandidates, type FlaggedOwnTrack } from "../music/autopilotCandidates";
import { boundedRead } from "./launchWiring";

// Stage 4, S4.10 fix B (plan §7, §9, §37): the plan card's music line, filled by the engine. The candidates are counted from the very collection the free steps choose from
// (`MusicPorts.candidates`, one ports instance), the requests left and the word on the automatic refresh from the music service's DRY RUN (`autoRefreshOutlook`: it reserves nothing,
// writes nothing and sends nothing). Free, and bounded: a read that fails or does not answer in `readMs` never takes the estimate down.

export interface MusicCardDeps {
  /** The collection the free steps choose from (the saved trends and the flagged own tracks). */
  candidates(): Promise<AutopilotCandidates>;
  /** What is counted when the own tracks cannot be read in time: the saved trends (in memory) and the last good read of the flagged own tracks of this library. */
  fallback(): AutopilotCandidates;
  /** The auto-refresh dry run for a launch that would find `candidateCount` candidates. */
  outlook(candidateCount: number): Promise<{ autoRefresh: LaunchPreview["music"]["autoRefresh"]; quotaRemaining: number | null }>;
  /** How long the whole card may take: both reads share it. */
  readMs: number;
}

/**
 * The last successful read of the flagged own tracks, per library root. The read waits for the media area to be ready, which on a slow share can take longer than the card may wait;
 * the card then counts these instead of claiming there are none. A library not read yet has none to recall (an honest «unknown» the contract cannot say, so: empty).
 */
export class LastGoodOwnTracks {
  readonly #byRoot = new Map<string, readonly FlaggedOwnTrack[]>();

  remember(root: string, tracks: readonly FlaggedOwnTrack[]): void {
    this.#byRoot.set(root, tracks);
  }

  recall(root: string): readonly FlaggedOwnTrack[] {
    return this.#byRoot.get(root) ?? [];
  }
}

const EMPTY: AutopilotCandidates = buildAutopilotCandidates({ trends: [], ownFlagged: [] });

export async function musicCardOf(deps: MusicCardDeps): Promise<LaunchPreview["music"]> {
  // ONE deadline for the whole card: the second read gets what the first left, so the bound is `readMs`, not twice that. A read that answers at once still counts when no time is left.
  const deadline = performance.now() + deps.readMs;
  const left = (): number => Math.max(0, deadline - performance.now());
  let found: AutopilotCandidates;
  try {
    found = await boundedRead(() => deps.candidates(), left(), "the autopilot's music candidates");
  } catch {
    // The own tracks live in the library, which may be slow or damaged: the saved trends, which are in memory, are still counted.
    try {
      found = deps.fallback();
    } catch {
      found = EMPTY;
    }
  }
  const candidates = found.candidates.length;
  let outlook: Awaited<ReturnType<MusicCardDeps["outlook"]>>;
  try {
    outlook = await boundedRead(() => deps.outlook(candidates), left(), "the auto-refresh outlook");
  } catch {
    // Nothing is known of the quota: no figure, and the trends are not promised a refresh.
    outlook = { autoRefresh: "no-quota", quotaRemaining: null };
  }
  return { candidates, ownFlagged: found.flaggedOwn.size, explicitSkipped: found.explicitSkipped, autoRefresh: outlook.autoRefresh, quotaRemaining: outlook.quotaRemaining };
}
