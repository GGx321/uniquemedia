import type { AvatarSummary, PhotoSummary } from "../../../shared/engine";
import type { MockEngine } from "../../engine/mockEngine";
import { freePhotos, MIA, SOFIA } from "../../engine/mockEngine.testkit";

// S4.9c: the history the tests and the screenshots of «История запусков» and a launch's page stand on — the design's launches (AutopilotS4.dc.html states
// history and launch, scaled down where a test needs fewer videos), seeded into the mock (`MockEngine.seedLaunch`) as if they had run.

export const ELENA: AvatarSummary = { ...MIA, avatarId: "avatar-elena-0004", name: "Elena", masterPhotoId: "photo-elena-master" };
export const LINA: AvatarSummary = { ...MIA, avatarId: "avatar-lina-0005", name: "Lina", masterPhotoId: "photo-lina-master" };
export const ZOE: AvatarSummary = { ...MIA, avatarId: "avatar-zoe-0006", name: "Zoe", masterPhotoId: "photo-zoe-master" };

/** A moment of October 2026 in the viewer's own time, as the screens show it. */
export const octAt = (day: number, h: number, m: number): string => new Date(2026, 9, day, h, m).toISOString();

/** Mia, Sofia, Elena, Lina and Zoe, each with `free` photos of its own. */
export function historyLibrary(free = 12): { avatars: AvatarSummary[]; photos: PhotoSummary[] } {
  const roster = [MIA, SOFIA, ELENA, LINA, ZOE];
  return { avatars: roster.map((a) => ({ ...a, photoCount: free, eligibleUnusedCount: free })), photos: roster.flatMap((a) => freePhotos(free, a)) };
}

export interface SeededHistory {
  /** 8 окт., 14:02: Mia, Sofia, Elena — Mia 3 (the first published), Sofia 2 and one that did not come out, Elena 1. */
  readonly latest: { readonly launchId: string; readonly videoIds: readonly string[] };
  /** 7 окт., 18:40: Mia and Lina, every video made. */
  readonly older: string;
  /** 6 окт., 21:15: Zoe, stopped by the owner. */
  readonly stopped: string;
  /** 3 окт., 16:05: Lina from the library only, free. */
  readonly free: string;
}

export function seedHistory(engine: MockEngine): SeededHistory {
  const free = engine.seedLaunch({
    createdAt: octAt(3, 16, 5),
    endedAt: octAt(3, 16, 9),
    draft: { avatarIds: [LINA.avatarId], videosPerAvatar: 1, generate: false },
    videos: [{ avatarId: LINA.avatarId, shape: "single", size: 1, state: "done", durationMs: 8_000, bytes: 2_000_000 }],
  }).launchId;
  const stopped = engine.seedLaunch({
    createdAt: octAt(6, 21, 15),
    endedAt: octAt(6, 21, 31),
    status: "stopped",
    draft: { avatarIds: [ZOE.avatarId], videosPerAvatar: 3 },
    acceptedMicros: 2_420_000,
    plannedWorstMicros: 2_420_000,
    spentMicros: 840_000,
    videos: [
      { avatarId: ZOE.avatarId, shape: "single", size: 1, state: "done" },
      { avatarId: ZOE.avatarId, shape: "single", size: 1, state: "dropped", dropReason: "launch-stopped" },
      { avatarId: ZOE.avatarId, shape: "single", size: 1, state: "dropped", dropReason: "launch-stopped" },
    ],
  }).launchId;
  const older = engine.seedLaunch({
    createdAt: octAt(7, 18, 40),
    endedAt: octAt(7, 19, 7),
    draft: { avatarIds: [MIA.avatarId, LINA.avatarId], videosPerAvatar: 1 },
    acceptedMicros: 3_200_000,
    plannedWorstMicros: 3_200_000,
    spentMicros: 1_120_000,
    videos: [
      { avatarId: MIA.avatarId, shape: "single", size: 1, state: "done" },
      { avatarId: LINA.avatarId, shape: "single", size: 1, state: "done" },
    ],
  }).launchId;
  const latest = engine.seedLaunch({
    createdAt: octAt(8, 14, 2),
    endedAt: octAt(8, 14, 31),
    draft: { avatarIds: [MIA.avatarId, SOFIA.avatarId, ELENA.avatarId], videosPerAvatar: 3, categories: ["home", "travel", "shoot", "fit"] },
    acceptedMicros: 4_140_000,
    plannedWorstMicros: 4_140_000,
    plannedExpectedMicros: 1_340_000,
    spentMicros: 1_690_000,
    videos: [
      { avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 7_500, bytes: 1_800_000, track: { source: "trending", title: "Golden Hour Loop", artist: "Lumi" }, published: true },
      { avatarId: MIA.avatarId, shape: "collage", size: 3, state: "done", durationMs: 9_000, bytes: 2_400_000, track: { source: "trending", title: "Late Night Drive", artist: "Noor" } },
      { avatarId: MIA.avatarId, shape: "slides", size: 6, state: "done", durationMs: 7_800, bytes: 3_100_000, track: { source: "own", title: "summer-loop.m4a", artist: null } },
      { avatarId: SOFIA.avatarId, shape: "collage", size: 2, state: "done", durationMs: 8_500, bytes: 2_000_000, track: { source: "trending", title: "Soft Static", artist: "Ivo" } },
      { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 6_500, bytes: 1_500_000, track: { source: "trending", title: "Golden Hour Loop", artist: "Lumi" } },
      { avatarId: SOFIA.avatarId, shape: "single", size: 1, state: "dropped", dropReason: "not-enough-photos" },
      { avatarId: ELENA.avatarId, shape: "slides", size: 5, state: "done", durationMs: 6_500, bytes: 2_800_000, track: { source: "trending", title: "Paper Planes", artist: "Mira" } },
    ],
  });
  return { latest, older, stopped, free };
}
