import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineFailure } from "../engineFailure";
import { openLibrary, type Library } from "../library";
import type { StoredSceneSet } from "../library/sceneSets";
import { rejectionOf, steppingClock, useTempDir } from "../library/testing/helpers";
import { ownScene, sampleSet } from "../library/testing/sceneSetSample";
import { buildSceneRunPlan } from "../runs/plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { approveLaunchSet, drawLaunchSlice, ensureSliceRuns, unlinkLaunchSet, type DrawSliceInput, type LaunchSetDeps, type SliceStatus } from "./launchDraw";
import { LaunchRegistry } from "./launchRegistry";
import { runSnapshots, runSources } from "./toRun";
import { MemoryLaunches } from "./testing/memoryLaunches";
useNativeGlobals();
setDefaultTimeout(30_000);

// S4.5a (plan §3.4, §3.7, §4.3, §4.7): the launch's approval freezes the set's list of scenes; slices of at most 25 are drawn from that list, each entry
// written in the set BEFORE its run folder exists; a stop unlinks the set by the phase it is in. Everything here is the library and the set's file; no
// money moves and no job runs.

const root = useTempDir("studio-launch-draw-");
const LAUNCH = "launch-0a1b2c3d4e5f";
const SET = "set-aaaa-0001";
const RUN = "run-aaaa-0001";

interface Seed {
  count?: number;
  written?: number;
  own?: number[];
  launchId?: string | null;
  /** A folder of its own under the temp dir, for a test that makes several libraries. */
  sub?: string;
}

async function seeded(seed: Seed = {}) {
  const launches = new MemoryLaunches().add(LAUNCH);
  const registry = new LaunchRegistry(launches);
  const dir = seed.sub === undefined ? root() : join(root(), seed.sub);
  await mkdir(dir, { recursive: true });
  const { library } = await openLibrary(dir, { now: steppingClock("2026-10-07T12:00:00.000Z") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: "a 25-year-old woman with hazel eyes" });
  const count = seed.count ?? 6;
  const base = sampleSet({ sceneSetId: SET, runId: RUN, avatarId: avatar.id, count, written: seed.written ?? count });
  const own = (seed.own ?? []).map((id) => ownScene(id));
  const launchId = seed.launchId === undefined ? LAUNCH : seed.launchId;
  await library.sceneSets.create({
    ...base,
    scenes: [...base.scenes, ...own.map((s) => s as never)],
    ...(launchId === null ? {} : { launchId }),
  });
  const deps: LaunchSetDeps = { library, isLive: () => false, registry };
  return { library, avatarId: avatar.id, deps, registry, launches };
}

const approve = (deps: LaunchSetDeps, over: Partial<{ revision: number; plannedCount: number; launchId: string }> = {}) =>
  approveLaunchSet(deps, { sceneSetId: SET, launchId: LAUNCH, revision: 1, plannedCount: 6, ...over });

const reasonOf = (error: unknown): { code: string; sceneReason?: string } => {
  expect(error).toBeInstanceOf(EngineFailure);
  const { code, sceneReason } = (error as EngineFailure).error;
  return { code, ...(sceneReason === undefined ? {} : { sceneReason }) };
};

/** The plan a slice's run is created with: the real scene-run plan over the slice's scenes, as the engine builds it. */
const build: DrawSliceInput["build"] = (current, slice) => {
  const chosen = new Set(slice.sceneIds);
  const scenes = runSources({ ...current, scenes: current.scenes.map((s) => ({ ...s, removed: !chosen.has(s.sceneId) })) });
  return buildSceneRunPlan({
    runId: slice.runId,
    avatarId: current.avatarId,
    createdAt: "2026-10-07T12:00:00.000Z",
    sceneSetId: current.sceneSetId,
    imageAgeCheck: "off",
    models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
    capMicros: slice.capMicros,
    plannedWorstMicros: slice.capMicros,
    scenes,
    categories: runSnapshots(current, scenes),
  });
};

const never: (runId: string) => SliceStatus = () => ({ finished: false });

function slice(deps: LaunchSetDeps, over: Partial<DrawSliceInput> = {}) {
  let n = 0;
  return drawLaunchSlice(deps, {
    sceneSetId: SET,
    launchId: LAUNCH,
    size: 25,
    drawMicros: 1_000_000,
    capFor: (s) => s * 1000,
    statusOf: never,
    newId: () => `run-slice-${String(++n).padStart(4, "0")}`,
    build,
    ...over,
  });
}

async function setOf(library: Library, avatarId: string): Promise<StoredSceneSet> {
  const set = await library.sceneSets.get(avatarId, SET);
  if (set === null) throw new Error("the set is gone");
  return set;
}

// ---------- approval ----------

describe("approveLaunchSet", () => {
  test("freezes the active scenes with text, in the set's order, and makes one revision", async () => {
    const { library, avatarId, deps } = await seeded({ count: 6 });
    await library.sceneSets.update(avatarId, SET, (s) => ({ ...s, scenes: s.scenes.map((x) => (x.sceneId === 3 ? { ...x, removed: true } : x)) }));

    const approved = await approve(deps, { revision: 2, plannedCount: 6 });

    expect(approved.launchDraw).toEqual({ launchId: LAUNCH, sceneIds: [1, 2, 4, 5, 6], slices: [] });
    expect(approved.revision).toBe(3);
    expect((await setOf(library, avatarId)).launchDraw?.sceneIds).toEqual([1, 2, 4, 5, 6]);
  });

  test("removes the active scenes that have no text in the same write", async () => {
    const { library, avatarId, deps } = await seeded({ count: 6, written: 4 });

    const approved = await approve(deps);

    expect(approved.launchDraw?.sceneIds).toEqual([1, 2, 3, 4]);
    expect(approved.scenes.filter((s) => s.removed).map((s) => s.sceneId)).toEqual([5, 6]);
    expect((await setOf(library, avatarId)).revision).toBe(2);
  });

  test("accepts M = n: as many active scenes as the launch planned", async () => {
    const { deps } = await seeded({ count: 6 });
    const approved = await approve(deps, { plannedCount: 6 });
    expect(approved.launchDraw?.sceneIds).toHaveLength(6);
  });

  test("refuses over-plan at M = n + 1 and writes nothing", async () => {
    const { library, avatarId, deps } = await seeded({ count: 6 });

    const refusal = await rejectionOf(approve(deps, { plannedCount: 5 }));

    expect(reasonOf(refusal)).toEqual({ code: "VALIDATION", sceneReason: "over-plan" });
    const after = await setOf(library, avatarId);
    expect(after.revision).toBe(1);
    expect(after.launchDraw).toBeUndefined();
  });

  test("accepts M below n: fewer photos than planned", async () => {
    const { deps } = await seeded({ count: 6, written: 3 });
    const approved = await approve(deps, { plannedCount: 6 });
    expect(approved.launchDraw?.sceneIds).toEqual([1, 2, 3]);
  });

  test("leaves the owner's own scenes out of M and out of the frozen list", async () => {
    const { deps } = await seeded({ count: 4, own: [10, 11] });

    const approved = await approve(deps, { plannedCount: 4 });

    expect(approved.launchDraw?.sceneIds).toEqual([1, 2, 3, 4]);
  });

  test("an own scene does not tip M over the plan", async () => {
    const { deps } = await seeded({ count: 4, own: [10, 11, 12] });
    await approve(deps, { plannedCount: 4 });
  });

  test("refuses a set with no active planned scene with text", async () => {
    const { deps } = await seeded({ count: 3, written: 0, own: [10] });

    const refusal = await rejectionOf(approve(deps, { plannedCount: 3 }));

    expect(reasonOf(refusal)).toEqual({ code: "VALIDATION", sceneReason: "no-active-scenes" });
  });

  test("refuses SCENES_CHANGED when the revision moved", async () => {
    const { deps } = await seeded();

    const refusal = await rejectionOf(approve(deps, { revision: 7 }));

    expect(reasonOf(refusal).code).toBe("SCENES_CHANGED");
  });

  test("refuses IN_FLIGHT while a job of the set runs", async () => {
    const { deps } = await seeded();

    const refusal = await rejectionOf(approve({ ...deps, isLive: () => true }));

    expect(reasonOf(refusal).code).toBe("IN_FLIGHT");
  });

  test("refuses a set that belongs to no launch as not awaiting", async () => {
    const plain = await seeded({ launchId: null });
    expect(reasonOf(await rejectionOf(approve(plain.deps)))).toEqual({ code: "VALIDATION", sceneReason: "not-awaiting" });
  });

  test("refuses a set that belongs to another launch as not awaiting", async () => {
    const { deps } = await seeded();
    const refusal = await rejectionOf(approve(deps, { launchId: "launch-9z8y7x6w5v4u" }));
    expect(reasonOf(refusal)).toEqual({ code: "VALIDATION", sceneReason: "not-awaiting" });
  });

  test("refuses as not awaiting once the launch is finished, stopped or removed (the unlinked rule), and writes nothing", async () => {
    const { library, avatarId, deps, launches } = await seeded();
    launches.finish(LAUNCH);

    const refusal = await rejectionOf(approve(deps));

    expect(reasonOf(refusal)).toEqual({ code: "VALIDATION", sceneReason: "not-awaiting" });
    expect((await setOf(library, avatarId)).revision).toBe(1);
  });

  test("approving again with the same launch changes nothing: no second revision", async () => {
    const { library, avatarId, deps } = await seeded();
    const first = await approve(deps);

    const second = await approve(deps, { revision: first.revision });

    expect(second.launchDraw).toEqual(first.launchDraw);
    expect((await setOf(library, avatarId)).revision).toBe(first.revision);
  });
});

// ---------- slices ----------

describe("drawLaunchSlice", () => {
  async function approvedSet(count = 60) {
    const s = await seeded({ count });
    await approve(s.deps, { plannedCount: count });
    return s;
  }

  test("draws the first slice under the set's own run id and creates its run folder", async () => {
    const { library, avatarId, deps } = await approvedSet(10);

    const drawn = await slice(deps, { size: 4 });

    expect(drawn).toMatchObject({ kind: "drawn", runId: RUN, sceneIds: [1, 2, 3, 4], capMicros: 4000, created: true });
    expect(await library.runFolderExists(RUN)).toBe(true);
    expect((await setOf(library, avatarId)).launchDraw?.slices).toEqual([{ runId: RUN, sceneIds: [1, 2, 3, 4], capMicros: 4000 }]);
  });

  test("draws the next slice with a new run id and scenes the first did not take", async () => {
    const { library, deps } = await approvedSet(10);
    await slice(deps, { size: 4 });

    const second = await slice(deps, { size: 4 });

    expect(second).toMatchObject({ kind: "drawn", runId: "run-slice-0001", sceneIds: [5, 6, 7, 8] });
    expect(await library.runFolderExists("run-slice-0001")).toBe(true);
  });

  test("a slice holds 25 photos at most: 25 is drawn, 26 is refused", async () => {
    const { deps } = await approvedSet(60);

    expect(await slice(deps, { size: 25 })).toMatchObject({ kind: "drawn" });
    const refusal = await rejectionOf(slice(deps, { size: 26 }));
    expect(refusal).toBeInstanceOf(RangeError);
  });

  test("a slice of no photos is refused", async () => {
    const { deps } = await approvedSet(10);
    expect(await rejectionOf(slice(deps, { size: 0 }))).toBeInstanceOf(RangeError);
  });

  test("draws what is left when fewer scenes remain than the slice asks for", async () => {
    const { deps } = await approvedSet(6);
    await slice(deps, { size: 4 });

    const last = await slice(deps, { size: 4 });

    expect(last).toMatchObject({ kind: "drawn", sceneIds: [5, 6] });
  });

  test("says none left when every scene of the frozen list is drawn", async () => {
    const { deps } = await approvedSet(3);
    await slice(deps, { size: 3 });

    expect(await slice(deps, { size: 3 })).toEqual({ kind: "none-left" });
  });

  test("draws nothing once the launch is finished, stopped or removed: not awaiting, no entry, no run", async () => {
    const { library, avatarId, deps, launches } = await approvedSet(10);
    launches.finish(LAUNCH);

    const refusal = await rejectionOf(slice(deps, { size: 3 }));

    expect(reasonOf(refusal)).toEqual({ code: "VALIDATION", sceneReason: "not-awaiting" });
    expect((await setOf(library, avatarId)).launchDraw?.slices).toEqual([]);
    expect(await library.listRuns()).toEqual([]);
  });

  test("refuses a set that was not approved by this launch", async () => {
    const { deps } = await seeded();
    const refusal = await rejectionOf(slice(deps));
    expect(reasonOf(refusal)).toEqual({ code: "VALIDATION", sceneReason: "not-awaiting" });
  });

  test("writes the slice's entry in the set and links its run BEFORE the run folder is created", async () => {
    const { library, avatarId, registry, launches } = await approvedSet(10);
    const seen: { entry: unknown; linked: string | undefined; folder: boolean }[] = [];
    const watched = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") {
          return async (...args: Parameters<Library["createRun"]>) => {
            const set = await target.sceneSets.get(avatarId, SET);
            seen.push({ entry: set?.launchDraw?.slices.at(-1), linked: registry.launchOfRun(args[0]), folder: await target.runFolderExists(args[0]) });
            return target.createRun(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(launches.isUnfinished(LAUNCH)).toBe(true);

    await slice({ library: watched, isLive: () => false, registry }, { size: 3 });

    expect(seen).toEqual([{ entry: { runId: RUN, sceneIds: [1, 2, 3], capMicros: 3000 }, linked: LAUNCH, folder: false }]);
  });

  test("a kill after the entry and before createRun resumes to exactly one run for the entry", async () => {
    const { library, avatarId, deps } = await approvedSet(10);
    const dying = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") return async () => Promise.reject(new Error("killed before createRun"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rejectionOf(slice({ ...deps, library: dying }, { size: 4 }));
    expect((await setOf(library, avatarId)).launchDraw?.slices).toHaveLength(1);
    expect(await library.runFolderExists(RUN)).toBe(false);

    const again = await slice(deps, { size: 4 });

    expect(again).toMatchObject({ kind: "drawn", runId: RUN, sceneIds: [1, 2, 3, 4], created: true });
    expect((await setOf(library, avatarId)).launchDraw?.slices).toHaveLength(1);
    expect(await library.listRuns()).toEqual([RUN]);
  });

  test("a kill after createRun resumes to exactly one run for the entry", async () => {
    const { library, avatarId, deps } = await approvedSet(10);
    const dying = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") {
          return async (...args: Parameters<Library["createRun"]>) => {
            await target.createRun(...args);
            throw new Error("killed after createRun");
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rejectionOf(slice({ ...deps, library: dying }, { size: 4 }));

    const recovered = await ensureSliceRuns(deps, { sceneSetId: SET, launchId: LAUNCH, build });

    expect(recovered.created).toEqual([]);
    expect((await setOf(library, avatarId)).launchDraw?.slices).toHaveLength(1);
    expect(await library.listRuns()).toEqual([RUN]);
  });

  test("recovery creates the run of an entry that has no folder, once, with the entry's own id", async () => {
    const { library, deps } = await approvedSet(10);
    const dying = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") return async () => Promise.reject(new Error("killed before createRun"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rejectionOf(slice({ ...deps, library: dying }, { size: 4 }));

    const first = await ensureSliceRuns(deps, { sceneSetId: SET, launchId: LAUNCH, build });
    const second = await ensureSliceRuns(deps, { sceneSetId: SET, launchId: LAUNCH, build });

    expect(first.created).toEqual([RUN]);
    expect(second.created).toEqual([]);
    expect(await library.listRuns()).toEqual([RUN]);
  });

  test("shrinks an entry that has no folder when the price rose, and never raises its cap", async () => {
    const { library, avatarId, deps } = await approvedSet(10);
    const dying = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") return async () => Promise.reject(new Error("killed before createRun"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rejectionOf(slice({ ...deps, library: dying }, { size: 5, capFor: (s) => s * 100 }));

    const rose = await slice(deps, { size: 5, capFor: (s) => s * 120 });

    expect(rose).toMatchObject({ kind: "drawn", runId: RUN, sceneIds: [1, 2, 3, 4], capMicros: 480 });
    expect((await setOf(library, avatarId)).launchDraw?.slices).toEqual([{ runId: RUN, sceneIds: [1, 2, 3, 4], capMicros: 480 }]);
  });

  test("creates an entry that has no folder with the lower cap when the price fell", async () => {
    const { library, deps } = await approvedSet(10);
    const dying = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") return async () => Promise.reject(new Error("killed before createRun"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rejectionOf(slice({ ...deps, library: dying }, { size: 5, capFor: (s) => s * 100 }));

    const fell = await slice(deps, { size: 5, capFor: (s) => s * 80 });

    expect(fell).toMatchObject({ kind: "drawn", sceneIds: [1, 2, 3, 4, 5], capMicros: 400 });
  });

  test("the scenes an entry gave up when it shrank are drawn by the next slice", async () => {
    const { library, deps } = await approvedSet(10);
    const dying = new Proxy(library, {
      get(target, key) {
        if (key === "createRun") return async () => Promise.reject(new Error("killed before createRun"));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await rejectionOf(slice({ ...deps, library: dying }, { size: 5, capFor: (s) => s * 100 }));
    await slice(deps, { size: 5, capFor: (s) => s * 120 });

    const next = await slice(deps, { size: 5, capFor: (s) => s * 100, drawMicros: 1_000_000 });

    expect(next).toMatchObject({ kind: "drawn", sceneIds: [5, 6, 7, 8, 9] });
  });

  test("says no room when not even one photo fits what the draw allocation has left", async () => {
    const { deps } = await approvedSet(10);
    await slice(deps, { size: 4, drawMicros: 4500, capFor: (s) => s * 1000 });

    const next = await slice(deps, { size: 4, drawMicros: 4500, capFor: (s) => s * 1000 });

    expect(next).toEqual({ kind: "no-room", leftMicros: 500 });
  });

  test("shrinks a new slice to the largest size whose cap fits the room", async () => {
    const { deps } = await approvedSet(10);
    await slice(deps, { size: 4, drawMicros: 6500, capFor: (s) => s * 1000 });

    const next = await slice(deps, { size: 4, drawMicros: 6500, capFor: (s) => s * 1000 });

    expect(next).toMatchObject({ kind: "drawn", sceneIds: [5, 6], capMicros: 2000 });
  });

  test("a finished slice gives back its slack: what it did not spend is room again", async () => {
    const { deps } = await approvedSet(10);
    const first = await slice(deps, { size: 4, drawMicros: 6000, capFor: (s) => s * 1000 });
    expect(first).toMatchObject({ kind: "drawn", runId: RUN, capMicros: 4000 });
    const statusOf = (runId: string): SliceStatus => (runId === RUN ? { finished: true, committedMicros: 1000 } : { finished: false });

    const next = await slice(deps, { size: 5, drawMicros: 6000, capFor: (s) => s * 1000, statusOf });

    expect(next).toMatchObject({ kind: "drawn", sceneIds: [5, 6, 7, 8, 9], capMicros: 5000 });
  });

  test("refuses to sum caps of live slices above the draw allocation (A2, property over random prices, sizes and finishes)", async () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 8; round++) {
      const s = await seeded({ count: 60, sub: `round-${round}` });
      await approve(s.deps, { plannedCount: 60 });
      const drawMicros = 5_000 + Math.floor(random() * 60_000);
      const committed = new Map<string, number>();
      const statusOf = (runId: string): SliceStatus => {
        const c = committed.get(runId);
        return c === undefined ? { finished: false } : { finished: true, committedMicros: c };
      };
      let n = 0;
      const seenScenes: number[] = [];
      for (let step = 0; step < 14; step++) {
        const price = 200 + Math.floor(random() * 900);
        const result = await drawLaunchSlice(s.deps, {
          sceneSetId: SET,
          launchId: LAUNCH,
          size: 1 + Math.floor(random() * 25),
          drawMicros,
          capFor: (size) => size * price,
          statusOf,
          newId: () => `run-prop-${round}-${++n}`,
          build,
        });
        if (result.kind === "drawn") seenScenes.push(...result.sceneIds);
        const set = await setOf(s.library, s.avatarId);
        const slices = set.launchDraw?.slices ?? [];
        const total = slices.reduce((sum, entry) => {
          const status = statusOf(entry.runId);
          return sum + (status.finished ? status.committedMicros : entry.capMicros);
        }, 0);
        expect(total).toBeLessThanOrEqual(drawMicros);
        // Finish a random live slice at a random share of its cap (a settle below its reserve).
        const live = slices.filter((entry) => !statusOf(entry.runId).finished);
        const done = live[Math.floor(random() * live.length)];
        if (done !== undefined && random() < 0.6) committed.set(done.runId, Math.floor(done.capMicros * random()));
      }
      expect(new Set(seenScenes).size).toBe(seenScenes.length);
      expect((await s.library.listRuns()).length).toBe(((await setOf(s.library, s.avatarId)).launchDraw?.slices ?? []).length);
    }
  });
});

// ---------- unlink ----------

describe("unlinkLaunchSet", () => {
  test("a set awaiting review: clears the launch id, revision + 1, nothing else", async () => {
    const { library, avatarId, deps, registry } = await seeded();
    registry.linkSet(SET, LAUNCH);
    const before = await setOf(library, avatarId);

    const result = await unlinkLaunchSet(deps, SET);

    const after = await setOf(library, avatarId);
    expect(result).toEqual({ phase: "awaiting" });
    expect(after.launchId).toBeUndefined();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.scenes).toEqual(before.scenes);
    expect(registry.launchOfSet(SET)).toBeUndefined();
  });

  test("an approved set with no slice folder: clears the draw and the launch id, revision + 1; the set is an ordinary open set", async () => {
    const { library, avatarId, deps } = await seeded();
    const approved = await approve(deps);

    const result = await unlinkLaunchSet(deps, SET);

    const after = await setOf(library, avatarId);
    expect(result).toEqual({ phase: "approved" });
    expect(after.launchId).toBeUndefined();
    expect(after.launchDraw).toBeUndefined();
    expect(after.revision).toBe(approved.revision + 1);
    expect(await library.runFolderExists(RUN)).toBe(false);
  });

  test("an approved set whose first entry has no folder (killed before createRun) is still unlinked as approved", async () => {
    const { library, avatarId, deps } = await seeded();
    await approve(deps);
    await library.sceneSets.update(avatarId, SET, (s) => (s.launchDraw === undefined ? s : { ...s, launchDraw: { ...s.launchDraw, slices: [{ runId: RUN, sceneIds: [1, 2], capMicros: 10 }] } }));

    const result = await unlinkLaunchSet(deps, SET);

    expect(result).toEqual({ phase: "approved" });
    expect((await setOf(library, avatarId)).launchDraw).toBeUndefined();
  });

  test("a set drawn in part stays used: its launch id and draw are cleared and its runs are unlinked", async () => {
    const { library, avatarId, deps, registry } = await seeded({ count: 10 });
    await approve(deps, { plannedCount: 10 });
    await slice(deps, { size: 3 });
    await slice(deps, { size: 3 });
    expect(registry.launchOfRun(RUN)).toBe(LAUNCH);

    const result = await unlinkLaunchSet(deps, SET);

    const after = await setOf(library, avatarId);
    expect(result).toEqual({ phase: "drawn" });
    expect(after.launchId).toBeUndefined();
    expect(after.launchDraw).toBeUndefined();
    expect(await library.runFolderExists(RUN)).toBe(true);
    expect(registry.launchOfRun(RUN)).toBeUndefined();
    expect(registry.launchOfRun("run-slice-0001")).toBeUndefined();
  });

  test("a set of the owner's own changes nothing: no revision", async () => {
    const { library, avatarId, deps } = await seeded({ launchId: null });

    const result = await unlinkLaunchSet(deps, SET);

    expect(result).toEqual({ phase: "plain" });
    expect((await setOf(library, avatarId)).revision).toBe(1);
  });

  test("unlinking twice is the same as once", async () => {
    const { library, avatarId, deps } = await seeded();
    await unlinkLaunchSet(deps, SET);
    const once = await setOf(library, avatarId);

    await unlinkLaunchSet(deps, SET);

    expect((await setOf(library, avatarId)).revision).toBe(once.revision);
  });
});

// ---------- the set file ----------

describe("the set file", () => {
  test("a set made without the launch fields is written back without them (today's files read and write unchanged)", async () => {
    const { library, avatarId, deps } = await seeded({ launchId: null });
    await library.sceneSets.update(avatarId, SET, (s) => ({ ...s, scenes: s.scenes.map((x) => (x.sceneId === 1 ? { ...x, removed: true } : x)) }));

    const raw = JSON.parse(await readFile(join(root(), "avatars", avatarId, "scenes", `${SET}.json`), "utf8")) as Record<string, unknown>;

    expect("launchId" in raw).toBe(false);
    expect("launchDraw" in raw).toBe(false);
    expect(raw.revision).toBe(2);
    expect(deps.library).toBe(library);
  });
});
