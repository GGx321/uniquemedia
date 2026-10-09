import type { AvatarSummary, EngineError, LaunchDraftInput, LaunchView, PhotoSummary } from "../../shared/engine";
import type { MockTrackSeed } from "./mockMusicStore";
import type { MockEngineOptions } from "./mockEngine";
import { freePhotos, makeMock, MIA, NORA, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// Test support for the launch the mock RUNS (Stage 4, S4.8): a world with Mia (6 free photos), Sofia (12) and an archived Nora, stored tracks, the image price fixed at $0.05, and the
// helpers every test of the run shares. Test-only.

export const IMAGE = 50_000;

/** A stored track long enough for any video the mock's launch makes (6.5 s). */
export function track(n: number, over: Partial<MockTrackSeed> = {}): MockTrackSeed {
  return { trackId: `track-run-${String(n).padStart(4, "0")}`, title: `Run track ${n}`, artist: "Run artist", durationMs: 12_000, explicit: false, highlightsMs: [1_500], hasCover: false, peaks: Array.from({ length: 240 }, (_, i) => (i * 7) % 1001), ...over };
}

/** The mock with the launch's world; the tracks are stored unless `tracks` says otherwise. */
export function runWorld(over: MockEngineOptions = {}, tracks: readonly MockTrackSeed[] | null = [track(1), track(2)]): Mock {
  const photos: PhotoSummary[] = [...freePhotos(6, MIA), ...freePhotos(12, SOFIA)];
  const countOf = (a: AvatarSummary): number => photos.filter((p) => p.avatarId === a.avatarId).length;
  const avatars = [MIA, SOFIA, NORA].map((a) => ({ ...a, photoCount: countOf(a), eligibleUnusedCount: countOf(a) }));
  const mock = makeMock({ avatars, photos, ...over });
  mock.engine.setRunImagePrice(IMAGE);
  if (tracks !== null) mock.engine.seedMusicTracks(tracks);
  return mock;
}

export const draftOf = (over: Partial<LaunchDraftInput> = {}): LaunchDraftInput => ({
  avatarIds: [MIA.avatarId],
  videosPerAvatar: 4,
  mix: { single: 50, collage: 25, slides: 25 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...over,
});

/** Estimates, then starts the launch with exactly the worst case the preview showed. */
export async function startRun(mock: Mock, over: Partial<LaunchDraftInput> = {}): Promise<LaunchView> {
  const draft = draftOf(over);
  const preview = (await unwrap(mock.client.request("autopilot.estimate", { draft }))).preview;
  return (await unwrap(mock.client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }))).launch;
}

export async function viewOf(mock: Mock, launchId: string): Promise<LaunchView> {
  return (await unwrap(mock.client.request("autopilot.get", { launchId }))).launch;
}

/** Moves the mock's clock one task at a time until `want` holds of the launch's view; the failure says where the launch stood. */
export async function runUntil(mock: Mock, launchId: string, what: string, want: (view: LaunchView) => boolean, limit = 600): Promise<LaunchView> {
  let view = await viewOf(mock, launchId);
  for (let i = 0; i < limit && !want(view); i++) {
    if (!mock.scheduler.next()) break;
    view = await viewOf(mock, launchId);
  }
  if (!want(view)) {
    throw new Error(`the launch never reached ${what}: ${view.status}, rows ${view.avatars.map((a) => `${a.phase}${a.waiting ? `/${a.waiting.reason}` : ""}`).join(",")}, hold ${view.paidHold?.reason ?? "none"}, free hold ${view.freeHold?.reason ?? "none"}`);
  }
  return view;
}

export const toDone = (mock: Mock, launchId: string): Promise<LaunchView> => runUntil(mock, launchId, "done", (v) => v.status === "done");

/** Runs `ticks` tasks of the mock's clock. */
export function tick(mock: Mock, ticks = 1): void {
  for (let i = 0; i < ticks; i++) mock.scheduler.next();
}

export async function errorOf<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: EngineError }>): Promise<EngineError> {
  const r = await reply;
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

/** «Продолжить» as the window sends it: R as the view states it. */
export async function resumeRun(mock: Mock, launchId: string): Promise<LaunchView> {
  const view = await viewOf(mock, launchId);
  return (await unwrap(mock.client.request("autopilot.resume", { launchId, acceptedRemainingMicros: view.remainingMicros }))).launch;
}

export { MIA, NORA, SOFIA, unwrap };
export type { Mock };
