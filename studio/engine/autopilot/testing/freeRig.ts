import { afterEach } from "bun:test";
import { emptyUsage } from "../../../shared/autopilot/track";
import type { LaunchDraft } from "../../../shared/engine/autopilot";
import { createFreeSteps, type FreeStepsDeps } from "../freeSteps";
import type { FileVideo, LaunchFile } from "../launchFile";
import type { PlanPhoto } from "../planner";
import { failure, FakeLibrary, FakeProvenance, FakeVideos, fixedMusic, memoryLaunch, noDrafts, prefetching, type MemoryLaunch } from "./freeHarness";
import { A, stampedFile } from "./launchFixtures";
import { distinctPhotos } from "./planFixtures";

// Test-only: the rig the free steps' tests share (one launch of library videos over the doubles of `freeHarness`).

export const POLL = 2;
export const LAUNCH = "launch-fixture-0001";
export const MUSIC = { source: "trending" as const, trackId: "track-00000001", startMs: 1500 };

export interface Options {
  draft?: Partial<LaunchDraft>;
  photos?: number;
  /** Replace the launch file the steps start from. */
  file?: (file: LaunchFile) => LaunchFile;
  deps?: Partial<FreeStepsDeps>;
  auto?: boolean;
  /** The runs the paid path would report: a function so a test changes them while the steps run. */
  slices?: () => { runIds: readonly string[]; over: boolean };
  music?: boolean;
}

const active: Array<() => Promise<void>> = [];

/** Call at the top of a test file: steps still polling when a test ends are told to stop, so no timer outlives its test. */
export function useRigCleanup(): void {
  afterEach(async () => {
    for (const stop of active.splice(0)) await stop().catch(() => undefined);
  });
}

/** Registers something to stop when the test ends (for a test that builds its own steps). */
export function stopAfterTest(stop: () => Promise<void>): void {
  active.push(stop);
}

export function rig(options: Options = {}) {
  const photos: PlanPhoto[] = distinctPhotos(options.photos ?? 8, { avatarId: A }, 3);
  const library = new FakeLibrary().add(A, photos);
  const draft = { library: true, generate: false, videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 }, ...options.draft };
  const base = stampedFile(draft, {}, { [A]: photos });
  const launch = memoryLaunch(options.file === undefined ? base : options.file(base));
  const provenance = new FakeProvenance();
  const videos = new FakeVideos(provenance);
  videos.auto = options.auto ?? true;
  const music = fixedMusic();
  const focusLog: string[] = [];
  const usageCalls: string[] = [];
  const state: { library: FakeLibrary | null; slices: NonNullable<Options["slices"]> } = { library, slices: options.slices ?? (() => ({ runIds: [], over: true })) };
  const deps: FreeStepsDeps = {
    library: () => state.library,
    videos: videos.videos,
    renderLife: videos.lifeOf,
    liveRenders: videos.live,
    focus: prefetching(focusLog),
    photoIdsInDrafts: noDrafts,
    sliceRuns: async () => state.slices(),
    trackUsage: async (avatarId) => {
      usageCalls.push(avatarId);
      return emptyUsage();
    },
    ...(options.music === false ? {} : { chooseMusic: music.choose }),
    provenance,
    pollMs: POLL,
    idlePollMs: POLL,
    recheckMs: POLL,
    warn: () => undefined,
    ...options.deps,
  };
  const steps = createFreeSteps(deps);
  active.push(() => steps.release(launch.ctx));
  return { photos, library, launch, provenance, videos, music, focusLog, usageCalls, steps, state, start: () => steps.begin(launch.ctx) };
}

export const videosOf = (launch: MemoryLaunch, avatarId = A): FileVideo[] => launch.file().avatars.find((a) => a.avatarId === avatarId)?.videos ?? [];
export const patchVideo = (file: LaunchFile, key: string, patch: Partial<FileVideo>): LaunchFile => ({
  ...file,
  avatars: file.avatars.map((a) => ({ ...a, videos: a.videos.map((v) => (v.key === key ? { ...v, ...patch } : v)) })),
});
export const settleFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export { failure, FakeLibrary, FakeProvenance, FakeVideos };
