import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { SAMPLE_SOURCE, samplePhotoMeta } from "../library/testing/sampleData";
import type { RenderTrack, RenderTrackSource } from "../music/renderTrack";
import { until } from "../testing/engineHarness";
import { readVideoRecordFiles } from "../videos/listing";
import { videoPaths, type VideoProvenance } from "../videos/record";
import { CrashError, failureOf, rig, useWorld, type World } from "../videos/testing/kit";
import { fillingFocus, serviceRig, type ServiceRig } from "../videos/testing/serviceKit";
import { PNG_1X1 } from "../library/testing/sampleData";
import { createFreeSteps, freeLibraryOf, type FreeSteps, type RenderLife } from "./freeSteps";
import { stampedFile } from "./testing/launchFixtures";
import { memoryLaunch, noDrafts, type MemoryLaunch } from "./testing/freeHarness";
import { randomPdq, rng } from "./testing/planFixtures";
import { planAvatarInput } from "./libraryInput";
import { trackUsage } from "./trackUsage";
import type { LaunchFile } from "./launchFile";
useNativeGlobals();

// S4.6c1 end to end: a library-only launch through the REAL video service, queue, commit and library, with fixture photos (a scripted ffmpeg and track, as the video service's own tests use).
// No paid call exists on this path: the steps are given no money port at all. Adoption by provenance is tried against real intents and records on disk.

const world = useWorld();
const TRACK_ID = "4199287736976977";
const LAUNCH = "launch-fixture-0001";
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop().catch(() => undefined);
});

const trackOf = (decodedMs: number): RenderTrack => ({ data: new Uint8Array([1, 2, 3]), check: async () => undefined, bytes: 1, sha256: "c".repeat(64), decodedMs, title: "A Song Title", artist: null, forbidden: [] });
const tracks: RenderTrackSource = { stored: (id) => (id === TRACK_ID ? { decodedMs: 60_000 } : null), openForRender: async () => trackOf(60_000) };

/** More free photos for the avatar of the world (home), with far-apart hashes. */
async function addPhotos(w: World, count: number): Promise<void> {
  const next = rng(11);
  for (let i = 0; i < count; i++) await w.library.addPhoto(w.avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" }, qa: { pdq: randomPdq(next) } }));
}

function lifeOf(r: ServiceRig): (jobId: string) => RenderLife {
  return (jobId) => r.queue.states().find((s) => s.jobId === jobId)?.status ?? "gone";
}

interface Run {
  r: ServiceRig;
  launch: MemoryLaunch;
  steps: FreeSteps;
  focusSeen: MontageDraft[];
}

function start(w: World, r: ServiceRig, focusSeen: MontageDraft[], draft: Parameters<typeof stampedFile>[0], over: (file: LaunchFile) => LaunchFile = (f) => f, library = w.library): Run {
  const photos = planAvatarInput(library, w.avatar.id, false, true).photos;
  const launch = memoryLaunch(over(stampedFile({ library: true, generate: false, avatarIds: [w.avatar.id], ...draft }, {}, { [w.avatar.id]: photos })));
  const steps = createFreeSteps({
    library: () => freeLibraryOf(library),
    videos: { renderInternal: (input) => r.service.renderInternal(input), settled: () => r.service.settled() },
    renderLife: lifeOf(r),
    focus: { prefetchFocus: async (_avatarId, _photoId) => ({ focus: { x: 0.5, y: 0.4 }, resolved: true }) },
    photoIdsInDrafts: noDrafts,
    sliceRuns: async () => ({ runIds: [], over: true }),
    trackUsage: (avatarId) => trackUsage(library.root, avatarId),
    chooseMusic: async () => ({ kind: "chosen", music: { source: "trending", trackId: TRACK_ID, startMs: 0 } }),
    pollMs: 5,
    recheckMs: 5,
    warn: () => undefined,
  });
  stops.push(() => steps.release(launch.ctx));
  steps.begin(launch.ctx);
  return { r, launch, steps, focusSeen };
}

const rigFor = (w: World, focusSeen: MontageDraft[] = []): ServiceRig =>
  serviceRig(w, { size: 2, deps: { tracks, focus: () => fillingFocus(focusSeen), renderOverrides: { runDeps: { measure: async () => -5.7 } }, recover: { deps: { scratchMinAgeMs: 0 } } } });

describe("a library-only launch, end to end", () => {
  test("renders every planned video through the real service: records with provenance, each at most 10 s, no photo twice, the launch done", async () => {
    const w = world();
    await addPhotos(w, 12);
    const focusSeen: MontageDraft[] = [];
    const r = rigFor(w, focusSeen);
    const run = start(w, r, focusSeen, { videosPerAvatar: 5, mix: { single: 40, collage: 40, slides: 20 }, categories: ["home"] });
    await until(() => run.launch.finished(), "the launch to finish");
    await r.queue.idle();

    const records = (await readVideoRecordFiles(w.libraryRoot, w.avatar.id)).records;
    const done = run.launch.file().avatars[0]?.videos.filter((v) => v.state === "done") ?? [];
    expect(done.length).toBeGreaterThan(0);
    expect(records).toHaveLength(done.length);
    const photoIds = new Set<string>();
    for (const record of records) {
      expect(record).toMatchObject({ origin: "autopilot", launchId: LAUNCH });
      expect(record.durationMs).toBeLessThanOrEqual(10_000);
      expect(record.spec.layers).toEqual([]);
      for (const clip of record.spec.clips) {
        const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
        for (const cell of cells) {
          if (cell.photo?.source !== "scene") continue;
          expect(photoIds.has(cell.photo.photoId)).toBe(false);
          photoIds.add(cell.photo.photoId);
        }
      }
    }
    expect(new Set(records.map((rec) => rec.launchVideoKey)).size).toBe(records.length);
    expect(r.queue.states().every((s) => s.status === "done" && s.kind === "render" && s.launchId === LAUNCH)).toBe(true);
  });

  test("the focus is prefetched: the render command finds no photo left to judge (no detect during the render)", async () => {
    const w = world();
    await addPhotos(w, 3);
    const focusSeen: MontageDraft[] = [];
    const r = rigFor(w, focusSeen);
    const run = start(w, r, focusSeen, { videosPerAvatar: 3, categories: ["home"] });
    await until(() => run.launch.finished(), "the launch to finish");
    expect(focusSeen.length).toBeGreaterThan(0);
    for (const spec of focusSeen) {
      for (const clip of spec.clips) {
        const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
        for (const cell of cells) expect(cell.focus).not.toBeNull();
      }
    }
  });

  test("the photos of the videos are used for good: the library no longer offers them", async () => {
    const w = world();
    await addPhotos(w, 3);
    const r = rigFor(w);
    const run = start(w, r, [], { videosPerAvatar: 3, categories: ["home"] });
    await until(() => run.launch.finished(), "the launch to finish");
    await r.queue.idle();
    const free = w.library.eligibleUnusedPhotos(w.avatar.id).filter((p) => p.source.kind === "generated" && p.source.category === "home");
    expect(free.length).toBeLessThan(4);
  });
});

describe("adoption by provenance against the real disk", () => {
  const provenance = (key: string): VideoProvenance => ({ origin: "autopilot", launchId: LAUNCH, launchVideoKey: key });

  async function dieAfterTheIntent(w: World, photoId: string): Promise<void> {
    const kit = await rig(world, { input: { provenance: provenance("0-1"), spec: { schemaVersion: 1, avatarId: w.avatar.id, layers: [], music: null, seed: 7, clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "scene", photoId }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs: 4_000, transitionIn: "cut" }] } } });
    await failureOf(
      kit.run({
        hooks: {
          reached: (step) => {
            if (step === "dir-synced") {
              kit.fs.die();
              throw new CrashError(step);
            }
          },
        },
      }),
    );
  }

  test("a crash between the intent and the record: recovery adopts it, the launch takes the record, and the key gets no second video", async () => {
    const w = world();
    await addPhotos(w, 6);
    const first = w.photos[0]?.id ?? "";
    await dieAfterTheIntent(w, first);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(await readdir(paths.pendingDir)).toHaveLength(1);

    // The engine starts again: a fresh library object, the service recovers in the background.
    const reopened = await w.reopen();
    const focusSeen: MontageDraft[] = [];
    const r = serviceRig(w, { library: reopened, size: 2, deps: { tracks, focus: () => fillingFocus(focusSeen), renderOverrides: { runDeps: { measure: async () => -5.7 } }, recover: { deps: { scratchMinAgeMs: 0 } } } });
    r.service.libraryOpened(reopened);

    const run = start(
      w,
      r,
      focusSeen,
      { videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 }, categories: ["home", "travel"], planSeed: 5 },
      (file) => ({
        ...file,
        avatars: file.avatars.map((a) => ({ ...a, videos: a.videos.map((v) => (v.key === "0-1" ? { ...v, state: "rendering" as const, photoIds: [first], music: { source: "trending" as const, trackId: TRACK_ID, startMs: 0 }, previousStickerId: null } : v)) })),
      }),
      reopened,
    );
    await until(() => run.launch.finished(), "the launch to finish");
    await r.queue.idle();

    const records = (await readVideoRecordFiles(w.libraryRoot, w.avatar.id)).records;
    expect(records.filter((rec) => rec.launchVideoKey === "0-1")).toHaveLength(1);
    expect(records).toHaveLength(3);
    expect(run.launch.file().avatars[0]?.videos.find((v) => v.key === "0-1")?.state).toBe("done");
    expect(r.queue.states().some((s) => s.kind === "render" && s.launchId === LAUNCH && s.videoId === records.find((rec) => rec.launchVideoKey === "0-1")?.id)).toBe(false);
  });
});
