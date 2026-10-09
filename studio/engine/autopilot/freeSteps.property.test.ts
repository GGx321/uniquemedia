import { afterEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../../shared/autopilot/track";
import type { LaunchDraft } from "../../shared/engine/autopilot";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import { createFreeSteps } from "./freeSteps";
import type { PlanPhoto } from "./planner";
import { A, B, stampedFile } from "./testing/launchFixtures";
import { FakeLibrary, FakeProvenance, FakeVideos, fixedMusic, memoryLaunch, prefetching } from "./testing/freeHarness";
import { photo, randomPdq, rng } from "./testing/planFixtures";
useNativeGlobals();

// S4.6c1, invariants A7, A8, A10 as bounded property tests: over many seeded libraries, whatever the free steps hand to the video service obeys the rules. The libraries are full of photos that
// must not be taken: rejected, used, reserved, held by a saved draft, of another avatar, outside the chosen categories.

const SEEDS = 40;
const CATEGORIES = ["home", "travel", "gym"] as const;
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop().catch(() => undefined);
});

interface World {
  /** Why a photo must never be taken, by id. */
  bad: Map<string, string>;
  photosOf: Map<string, PlanPhoto[]>;
}

function build(seed: number): { world: World; library: FakeLibrary; held: Set<string>; draft: Partial<LaunchDraft> } {
  const next = rng(seed * 7919 + 13);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const world: World = { bad: new Map(), photosOf: new Map() };
  const library = new FakeLibrary();
  const held = new Set<string>();
  for (const avatarId of [A, B]) {
    const photos: PlanPhoto[] = [];
    const count = 6 + Math.floor(next() * 14);
    for (let i = 0; i < count; i++) {
      const base = photo({ avatarId, category: pick(CATEGORIES), pdq: randomPdq(next), faceCos: next() < 0.5 ? next() : undefined });
      const roll = next();
      let p = base;
      let why: string | null = null;
      if (roll < 0.1) {
        p = { ...base, rejected: true };
        why = "rejected";
      } else if (roll < 0.2) {
        p = { ...base, usedIn: ["video-00000001"] };
        why = "used";
      } else if (roll < 0.3) {
        p = { ...base, reserved: true };
        why = "reserved";
      } else if (roll < 0.4) {
        held.add(base.id);
        why = "draft";
      } else if (roll < 0.45) {
        p = { ...base, eligible: false };
        why = "ineligible";
      } else if (base.category === "gym") {
        why = "category";
      }
      if (why !== null) world.bad.set(p.id, why);
      photos.push(p);
    }
    // A photo of the OTHER avatar sitting in this avatar's list: a bug of a reader must not become a video of the wrong avatar.
    const stranger = photo({ avatarId: avatarId === A ? B : A, category: "home", pdq: randomPdq(next) });
    world.bad.set(stranger.id, "other avatar");
    photos.push(stranger);
    world.photosOf.set(avatarId, photos);
    library.add(avatarId, photos);
  }
  const mix = pick([{ single: 70, collage: 20, slides: 10 }, { single: 100, collage: 0, slides: 0 }, { single: 0, collage: 50, slides: 50 }, { single: 34, collage: 33, slides: 33 }]);
  const draft: Partial<LaunchDraft> = { avatarIds: [A, B], videosPerAvatar: 2 + Math.floor(next() * 5), mix, categories: ["home", "travel"], stickers: next() < 0.5, planSeed: Math.floor(next() * 4_000_000_000) };
  return { world, library, held, draft };
}

function photosOf(call: { spec: { clips: ReadonlyArray<{ kind: string; cell?: { photo: { source: string; photoId?: string } | null }; cells?: ReadonlyArray<{ photo: { source: string; photoId?: string } | null }> }> } }): string[] {
  return call.spec.clips.flatMap((clip) => {
    const cells = clip.kind === "photo" && clip.cell !== undefined ? [clip.cell] : (clip.cells ?? []);
    return cells.flatMap((cell) => (cell.photo?.source === "scene" && cell.photo.photoId !== undefined ? [cell.photo.photoId] : []));
  });
}

async function run(seed: number, generated: boolean) {
  const { world, library, held, draft } = build(seed);
  const next = rng(seed + 99);
  const photos = { [A]: world.photosOf.get(A) ?? [], [B]: world.photosOf.get(B) ?? [] };
  const file = stampedFile({ library: !generated, generate: generated, ...draft }, {}, photos);
  const launch = memoryLaunch(file);
  const provenance = new FakeProvenance();
  const videos = new FakeVideos(provenance);
  videos.auto = true;
  // A render that finishes uses its photos for good, as a committed record does.
  videos.onDone = (job) => {
    for (const id of photosOf(job.input)) library.patch(id, { usedIn: [job.videoId] });
  };
  if (generated) {
    // The slices brought a random half of each avatar's usable photos.
    for (const avatarId of [A, B]) {
      const usable = (world.photosOf.get(avatarId) ?? []).filter((p) => p.avatarId === avatarId && next() < 0.6).map((p) => p.id);
      library.setRun(avatarId, "run-slice-0001", usable);
    }
  }
  const steps = createFreeSteps({
    library: () => library,
    videos: videos.videos,
    renderLife: videos.lifeOf,
    focus: prefetching(),
    photoIdsInDrafts: async () => ({ photoIds: held, complete: true }),
    sliceRuns: async () => ({ runIds: generated ? ["run-slice-0001"] : [], over: true }),
    trackUsage: async () => emptyUsage(),
    chooseMusic: fixedMusic().choose,
    provenance,
    pollMs: 2,
    recheckMs: 2,
    warn: () => undefined,
  });
  stops.push(() => steps.release(launch.ctx));
  steps.begin(launch.ctx);
  await until(() => launch.finished(), `seed ${seed} to finish`);
  return { world, videos, launch, held, library };
}

describe("A7: no photo is taken that must not be, and none goes in two videos", () => {
  test(`library videos, ${SEEDS} seeded libraries`, async () => {
    let rendered = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { world, videos } = await run(seed, false);
      const seen = new Map<string, string>();
      for (const call of videos.calls) {
        for (const id of photosOf(call)) {
          expect(world.bad.get(id) ?? "fine", `seed ${seed}: photo ${id}`).toBe("fine");
          expect(seen.has(id), `seed ${seed}: photo ${id} is in two videos`).toBe(false);
          seen.set(id, call.provenance.launchVideoKey);
          expect(world.photosOf.get(call.spec.avatarId)?.some((p) => p.id === id && p.avatarId === call.spec.avatarId)).toBe(true);
        }
        rendered += 1;
      }
    }
    // The property is not vacuous: the libraries gave the steps something to render.
    expect(rendered).toBeGreaterThan(SEEDS);
  });

  test(`generated videos from slices, ${SEEDS} seeded libraries`, async () => {
    let rendered = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { world, videos } = await run(seed, true);
      const seen = new Set<string>();
      for (const call of videos.calls) {
        for (const id of photosOf(call)) {
          expect(world.bad.get(id) ?? "fine", `seed ${seed}: photo ${id}`).toBe("fine");
          expect(seen.has(id), `seed ${seed}: photo ${id} is in two videos`).toBe(false);
          seen.add(id);
        }
        rendered += 1;
      }
    }
    expect(rendered).toBeGreaterThan(0);
  });
});

describe("A8 and A10 over the same libraries", () => {
  test("every spec is at most 10 s and no more than 8 renders are ever unfinished", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { videos } = await run(seed, false);
      expect(videos.maxUnfinished).toBeLessThanOrEqual(8);
      for (const call of videos.calls) expect(call.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0)).toBeLessThanOrEqual(10_000);
    }
  });
});
