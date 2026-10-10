import { chooseTrack, trackKey, type TrackChoice, type TrackUsage } from "../../shared/autopilot/track";
import type { MusicStatus } from "../../shared/engine";
import { collectAutopilotCandidates, type AutopilotCandidates, type CandidateSources } from "../music/autopilotCandidates";
import type { AutoRefreshAnswer, AutoRefreshRequest } from "../music/service";

// Stage 4, S4.6c2 (plan §7, §19): the free steps' MUSIC ports, built from what the engine already has.
//
//   chooseMusic:  the candidates (`collectAutopilotCandidates`: saved trends that are not explicit, plus the own tracks flagged «для автопилота») feed `chooseTrack` with the avatar's
//                 usage. The answer is a track with its start, or «waiting» (no candidate, or none long enough). Nothing is requested or downloaded: it is free.
//   autoRefresh:  `MusicService.autoRefresh` is the ONLY path that may refresh the trends without a click, and its own rule (A11) decides; this port only carries the question.
//
// The sources are read once per PASS of the free steps (`pass`), not once per video: a launch of 50 videos asks the flag log one time per look, and the next look reads them again so a
// track that appeared meanwhile (a finished refresh, a newly flagged own track) is seen at once.

export interface ChooseMusicInput {
  avatarId: string;
  totalMs: number;
  seed: number;
  usage: TrackUsage;
  /** The free steps' pass counter: calls with the same number share one read of the candidate sources. Absent: every call reads. */
  pass?: number;
}

/** What the free steps need to ask for an automatic refresh and to let the service forget a closed launch. */
export interface AutoRefreshDep {
  /** How many tracks the autopilot could choose from now. */
  candidateCount(): Promise<number>;
  /** The tracks the autopilot could choose from now, by the key the usage counts them under (`trackKey`): a refresh is judged by the keys it added, not by the change in the count. */
  candidateKeys(): Promise<readonly string[]>;
  request(request: AutoRefreshRequest): Promise<AutoRefreshAnswer>;
  /** The music card's status: the refresh's state, the tracks stored and the quota left. Read to tell the owner (the log) what a refresh brought. */
  status(): Promise<MusicStatus>;
  /** The launch has closed (done or stopped). */
  release(launchId: string): void;
}

export interface MusicPorts {
  chooseMusic(input: ChooseMusicInput): Promise<TrackChoice>;
  /** The candidate collection itself (S4.10 fix B): what the plan card counts, read from the very sources `chooseMusic` picks from. Free, read afresh at every call, asks for nothing. */
  candidates(): Promise<AutopilotCandidates>;
  autoRefresh: AutoRefreshDep;
}

/** The part of `MusicService` the ports use. */
export interface AutoRefreshService {
  autoRefresh(request: AutoRefreshRequest): Promise<AutoRefreshAnswer>;
  status(): Promise<MusicStatus>;
  releaseLaunch(launchId: string): void;
}

export function createMusicPorts(sources: CandidateSources, service: AutoRefreshService): MusicPorts {
  let cached: { pass: number; read: Promise<AutopilotCandidates> } | null = null;
  const candidatesFor = (pass: number | undefined): Promise<AutopilotCandidates> => {
    if (pass !== undefined && cached?.pass === pass) return cached.read;
    const read = collectAutopilotCandidates(sources);
    if (pass === undefined) return read;
    const entry = { pass, read };
    cached = entry;
    // A read that failed is not kept: the next call of the same pass tries again.
    read.catch(() => {
      if (cached === entry) cached = null;
    });
    return read;
  };
  return {
    candidates: () => collectAutopilotCandidates(sources),
    async chooseMusic(input) {
      const { candidates, flaggedOwn } = await candidatesFor(input.pass);
      return chooseTrack({ candidates, flaggedOwn, usage: input.usage, totalMs: input.totalMs, seed: input.seed });
    },
    autoRefresh: {
      candidateCount: async () => (await collectAutopilotCandidates(sources)).candidates.length,
      candidateKeys: async () => (await collectAutopilotCandidates(sources)).candidates.map((c) => (c.source === "trending" ? trackKey("trending", c.trackId) : trackKey("own", c.mediaId))),
      request: (request) => service.autoRefresh(request),
      status: () => service.status(),
      release: (launchId) => service.releaseLaunch(launchId),
    },
  };
}
