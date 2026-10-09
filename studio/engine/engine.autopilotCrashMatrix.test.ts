import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPaidSteps } from "./autopilot/paidSteps";
import { IDLE_STEPS } from "./autopilot/steps";
import type { EngineDeps } from "./engine";
import { imageBody } from "./openrouter/testing/fakes";
import { ledgerLines, ok, portraitPng, useEngineDir } from "./testing/engineHarness";
import { crashKit, expectLaunchInvariants, fakeRender, realRender, type Started } from "./testing/crashKit";
import { draftOf, network, type WiringNetwork } from "./testing/wiringKit";
import { within } from "./testing/within";
import { readVideoRecordFiles } from "./videos/listing";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6d (plan §3.6, §10 A2 A4 A5 A7 A14 A15): the crash matrix. For each of the ten step boundaries of §3.6, with the scene review ON and OFF, a REAL engine (the engine's default steps: the paid
// path, the free path, real ffmpeg renders over fixture photos, a fake OpenRouter) is killed at the boundary, a second engine opens the same library and the same ledger, the owner reconciles if the
// view asks for it and presses «Продолжить · до $R», and the launch must reach `done` with: one scene set and one run per slice, no attempt id twice, no photo in two videos, the videos on disk
// equal to the plan less the dropped, spent within W′ and equal to the ledger's sum over the launch's scopes. See `crashKit.expectLaunchInvariants`.
//
// A kill is a point-in-time COPY of the test folder (library, userData with the ledger, export folder) taken synchronously while the first engine is held at a seam: the disk of a process killed
// at that instant (the launch file still `running`, a lost request's reserve open). The second engine opens the COPY, not the same folder (the export root's lock and the set's mutex are
// process-wide, so a second engine on the same folder would wait for a lock a dead process would have released). The boundary is reached either by running the engine's own steps until a seam
// holds them (a request, a face check, a render or a commit step that never returns), or, where the steps would run past it in the same tick, by driving the engine's own methods
// (`composeLaunchSet`, `approveLaunchSet`, `drawLaunchSlice`) under idle steps. Renders are mostly the engine tests' fake ffmpeg (commit, record, intent and recovery stay real); the cells of rows
// 9 and 10 render for real in the second engine. Every cell checks that its boundary was really reached before the copy, so a cell can never pass by missing the state it names.

setDefaultTimeout(300_000);

// Registered BEFORE `useEngineDir`: hooks run first in, first out, and the engines must be shut down before their folder is removed.
afterEach(() => kit.shutdownAll());
const dir = useEngineDir("studio-engine-crash-matrix-");
const kit = crashKit(dir);
beforeEach(() => kit.reset());

const never = (): Promise<never> => new Promise<never>(() => undefined);

interface Run {
  /** The scene review switch of the launch. */
  review: boolean;
}

interface Halted {
  launchId: string;
  avatarId: string;
  /** Every fake OpenRouter the first engine used. */
  nets: WiringNetwork[];
  first: Started;
  /** Whether the launch generates photos. */
  generates: boolean;
}

/** The reserves of the ledger of the attempts that are still open. */
const openReserveIds = (): string[] => {
  const closed = new Set(ledgerLines(dir()).flatMap((l) => ((l.type === "settle" || l.type === "release") && typeof l.attemptId === "string" ? [l.attemptId] : [])));
  return ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" && !closed.has(l.attemptId) ? [l.attemptId] : []));
};

/** The video records on disk for the avatar. */
async function readRecords(avatarId: string) {
  return (await readVideoRecordFiles(kit.libraryDir(), avatarId)).records;
}

/** A launch of one avatar, `videos` slides of 5 photos each, nothing in the library. The first engine runs `deps`. */
async function launchWith(run: Run, opts: { deps?: Partial<EngineDeps>; net?: WiringNetwork; videos?: number; afterBoot?: (first: Started) => void }): Promise<{ first: Started; net: WiringNetwork; launchId: string; avatarId: string }> {
  const avatarId = await kit.seedAvatar(0);
  const net = opts.net ?? network();
  const first = await kit.boot(net, { ...fakeRender(), ...opts.deps });
  opts.afterBoot?.(first);
  const launch = await kit.startLaunch(first, draftOf([avatarId], { sceneReview: run.review, videosPerAvatar: opts.videos ?? 1 }));
  return { first, net, launchId: launch.launchId, avatarId };
}

/** The engine's own composing, approving and drawing, called from outside under idle steps: the persisted state the steps would leave between two of their writes. */
async function viaEngine(started: Started, launchId: string, avatarId: string, upTo: "compose" | "approve" | "slice-entry" | "slice-run") {
  const file = kit.fileOf(launchId);
  const row = file.avatars[0];
  const generation = row?.generation;
  if (row === undefined || generation === null || generation === undefined) throw new Error("the avatar does not generate");
  const count = generation.split.reduce((sum, s) => sum + s.count, 0);
  await started.engine.composeLaunchSet(
    { avatarId, count, categories: file.draft.categories, poses: file.draft.poses, acceptedWorstMicros: row.allocation.composeMicros },
    { ids: { sceneSetId: generation.sceneSetId, runId: generation.setRunId }, split: generation.split, launchId },
  );
  await started.engine.whenSceneSetIdle(generation.sceneSetId);
  if (upTo === "compose") return generation;
  const set = await started.engine.library?.sceneSets.get(avatarId, generation.sceneSetId);
  const approved = await started.engine.approveLaunchSet({ sceneSetId: generation.sceneSetId, launchId, revision: set?.revision ?? 0, plannedCount: count });
  if (upTo === "approve") return generation;
  if (upTo === "slice-entry") {
    // A slice entry whose run folder was never made: the cap it recorded is above what the slice can cost now.
    await started.engine.library?.sceneSets.update(avatarId, generation.sceneSetId, (current) =>
      current.launchDraw === undefined ? null : { ...current, launchDraw: { ...current.launchDraw, slices: [{ runId: generation.setRunId, sceneIds: approved.launchDraw?.sceneIds ?? [], capMicros: 5_000_000 }] } },
    );
    return generation;
  }
  await started.engine.drawLaunchSlice({ sceneSetId: generation.sceneSetId, launchId, size: 25, drawMicros: row.allocation.drawMicros });
  return generation;
}

type Halt = (run: Run) => Promise<Halted>;

/**
 * What the second engine sends after «Продолжить» (the launch's one avatar writes 5 scenes and draws 5 photos), and whether the view asks for a reconcile first (a request that never
 * returned left its reserve open). The numbers are the point of the matrix: a writer request for a set that is complete, or a photo the first engine already paid for, is a second set or a
 * second draw.
 */
interface Expected {
  writer: number;
  images: number;
  reconcile: boolean;
}

/** The ten boundaries of plan §3.6 (row 5 and row 9 have more than one place to die). */
const BOUNDARIES: { id: string; name: string; halt: Halt; expected: Expected; realRender?: boolean }[] = [
  {
    id: "1",
    expected: { writer: 1, images: 5, reconcile: false },
    name: "row 1, start: the file with its ids, no step ran",
    halt: async (run) => {
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: { launchSteps: IDLE_STEPS } });
      expect((await first.engine.library?.sceneSets.list(avatarId))?.sets).toEqual([]);
      expect(ledgerLines(dir())).toEqual([]);
      expect(kit.fileOf(launchId).avatars[0]?.generation).not.toBeNull();
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "2",
    expected: { writer: 1, images: 5, reconcile: true },
    name: "row 2, compose: the writer's request is out and never answers",
    halt: async (run) => {
      const net = network({ writer: () => ({ hangForever: true }) });
      const { first, launchId, avatarId } = await launchWith(run, { net });
      await kit.waitView(first, launchId, "the writer request", () => net.writerCalls().length === 1, 60_000);
      const sceneSetId = kit.fileOf(launchId).avatars[0]?.generation?.sceneSetId ?? "";
      expect(openReserveIds()).toEqual([`${sceneSetId}:writer-1#1`]);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "3",
    expected: { writer: 0, images: 5, reconcile: false },
    name: "row 3, the set is written and not approved (review: waiting; off: killed before the approval)",
    halt: async (run) => {
      if (run.review) {
        const { first, net, launchId, avatarId } = await launchWith(run, {});
        await kit.waitFile(launchId, "the review wait", (f) => f.avatars[0]?.phase === "awaiting-review");
        return { first, nets: [net], launchId, avatarId, generates: true };
      }
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: { launchSteps: IDLE_STEPS } });
      const generation = await viaEngine(first, launchId, avatarId, "compose");
      const set = await first.engine.library?.sceneSets.get(avatarId, generation.sceneSetId);
      expect(set?.launchDraw).toBeUndefined();
      expect(set?.scenes.every((s) => s.text !== null)).toBe(true);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "4",
    expected: { writer: 0, images: 5, reconcile: false },
    name: "row 4, the approval is recorded and no slice entry exists",
    halt: async (run) => {
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: { launchSteps: IDLE_STEPS } });
      const generation = await viaEngine(first, launchId, avatarId, "approve");
      const set = await first.engine.library?.sceneSets.get(avatarId, generation.sceneSetId);
      expect(set?.launchDraw?.sceneIds).toHaveLength(5);
      expect(set?.launchDraw?.slices).toEqual([]);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "5a",
    expected: { writer: 0, images: 5, reconcile: false },
    name: "row 5, a slice entry whose run folder was never made",
    halt: async (run) => {
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: { launchSteps: IDLE_STEPS } });
      const generation = await viaEngine(first, launchId, avatarId, "slice-entry");
      const set = await first.engine.library?.sceneSets.get(avatarId, generation.sceneSetId);
      expect(set?.launchDraw?.slices.map((e) => e.runId)).toEqual([generation.setRunId]);
      expect(await first.engine.library?.runFolderExists(generation.setRunId)).toBe(false);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "5b",
    expected: { writer: 0, images: 1, reconcile: true },
    name: "row 5, a slice in flight: four photos are saved, the third request never answers",
    halt: async (run) => {
      const net = network({ image: (_call, n) => (n === 3 ? { hangForever: true } : { status: 200, body: imageBody(portraitPng(((n - 1) % 4) + 1), { cost: 0.04 }) }) });
      // QA answers in 300 ms: a copy taken on the settle lines alone would hold paid photos that are not saved yet.
      const slowFace = [{ name: "face", paid: false, check: async () => (await new Promise((resolve) => setTimeout(resolve, 300)), { verdict: "pass" as const }) }];
      const { first, launchId, avatarId } = await launchWith(run, { net, deps: { qaGates: slowFace } });
      const setRunId = kit.fileOf(launchId).avatars[0]?.generation?.setRunId ?? "";
      await kit.drive(first, launchId, "all five requests of the slice", () => net.imageCalls().length === 5, 60_000);
      // A settle line is written when the answer ARRIVES, before the gates, the library write and the slot's end: a copy taken then holds paid photos that are not saved, which a restart
      // rightly buys again. The boundary is "four photos SAVED in the library"; the settles are asserted after it.
      const savedPhotos = async (): Promise<number> => {
        const listed = ok(await kit.call(first, "photos.list", { avatarId }));
        if (listed.type !== "photos.list") throw new Error("wrong answer");
        return listed.result.photos.filter((p) => p.runId === setRunId).length;
      };
      const deadline = Date.now() + 60_000;
      while ((await savedPhotos()) < 4) {
        if (Date.now() > deadline) throw new Error("timed out waiting for four saved photos");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await savedPhotos()).toBe(4);
      expect(ledgerLines(dir()).filter((l) => l.type === "settle" && typeof l.attemptId === "string" && l.attemptId.startsWith(`${setRunId}:`))).toHaveLength(4);
      expect(openReserveIds().filter((id) => id.startsWith(`${setRunId}:`))).toHaveLength(1);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "6",
    expected: { writer: 0, images: 0, reconcile: false },
    name: "row 6, the photos arrived and nothing is assigned",
    halt: async (run) => {
      const holder: { engine: Started["engine"] | null } = { engine: null };
      const steps = createPaidSteps({
        port: () => {
          if (holder.engine === null) throw new Error("the engine is not started yet");
          return holder.engine;
        },
      });
      const { first, net, launchId, avatarId } = await launchWith(run, {
        deps: { launchSteps: steps },
        afterBoot: (started) => {
          holder.engine = started.engine;
        },
      });
      await kit.drive(first, launchId, "the photos to arrive", (_view, file) => file.avatars[0]?.phase === "montage");
      const file = kit.fileOf(launchId);
      expect(file.avatars[0]?.photosDone).toBe(5);
      expect(file.avatars[0]?.videos.map((v) => v.state)).not.toContain("assigned");
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "7",
    expected: { writer: 0, images: 0, reconcile: false },
    name: "row 7, the photos are assigned and the video waits for a track",
    halt: async (run) => {
      const empty = await kit.emptyTrackStore();
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: { musicTracks: empty, musicTrends: empty } });
      await kit.drive(first, launchId, "the video to wait for music", (_view, file) => file.avatars[0]?.videos.every((v) => v.state === "waiting-music") === true);
      expect(kit.fileOf(launchId).avatars[0]?.videos[0]?.photoIds).toHaveLength(5);
      expect(first.engine.renders.states()).toEqual([]);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "8",
    expected: { writer: 0, images: 0, reconcile: false },
    name: "row 8, the focus of the assigned photos is being prefetched",
    halt: async (run) => {
      const seen = { detect: false };
      const faceGate = {
        detect: () => {
          seen.detect = true;
          return never();
        },
        isBroken: () => false,
      };
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: { faceGate } });
      await kit.drive(first, launchId, "the face check", () => seen.detect, 90_000);
      expect(kit.fileOf(launchId).avatars[0]?.videos[0]?.state).toBe("assigned");
      expect(first.engine.renders.states()).toEqual([]);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "9a",
    expected: { writer: 0, images: 0, reconcile: false },
    realRender: true,
    name: "row 9, a render is running and nothing of it is on disk",
    halt: async (run) => {
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: fakeRender({ run: never }) });
      await kit.drive(first, launchId, "the render to run", () => first.engine.renders.states().some((s) => s.kind === "render" && s.launchId === launchId && s.status === "running"), 90_000);
      expect(kit.fileOf(launchId).avatars[0]?.videos[0]?.state).toBe("rendering");
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "9b",
    expected: { writer: 0, images: 0, reconcile: false },
    realRender: true,
    name: "row 9, the render's intent is on disk and its record is not",
    halt: async (run) => {
      const reached = { intent: false };
      const hooks = {
        reached: (step: string): Promise<never> | undefined => {
          if (step !== "intent-written") return undefined;
          reached.intent = true;
          return never();
        },
      };
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: fakeRender({ hooks }) });
      await kit.drive(first, launchId, "the intent", () => reached.intent, 90_000);
      expect(kit.fileOf(launchId).avatars[0]?.videos[0]?.state).toBe("rendering");
      expect(await readRecords(avatarId)).toHaveLength(0);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "9c",
    expected: { writer: 0, images: 0, reconcile: false },
    realRender: true,
    name: "row 9, the record and the intent are both on disk and the video is not marked done",
    halt: async (run) => {
      const reached = { linked: false };
      const hooks = {
        reached: (step: string): Promise<never> | undefined => {
          if (step !== "record-linked") return undefined;
          reached.linked = true;
          return never();
        },
      };
      const { first, net, launchId, avatarId } = await launchWith(run, { deps: fakeRender({ hooks }) });
      await kit.drive(first, launchId, "the record", () => reached.linked, 90_000);
      expect(kit.fileOf(launchId).avatars[0]?.videos[0]?.state).toBe("rendering");
      expect(await readRecords(avatarId)).toHaveLength(1);
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
  {
    id: "10",
    expected: { writer: 0, images: 0, reconcile: false },
    realRender: true,
    name: "row 10, one video is done and the next render is held",
    halt: async (run) => {
      const committed = { count: 0, held: false };
      const hooks = {
        reached: (step: string): Promise<never> | undefined => {
          if (step === "record-committed") committed.count += 1;
          if (committed.count < 1 || step !== "verified") return undefined;
          committed.held = true;
          return never();
        },
      };
      const { first, net, launchId, avatarId } = await launchWith(run, { videos: 2, deps: fakeRender({ hooks }) });
      await kit.drive(first, launchId, "one video done and the next held", (_view, file) => committed.held && file.avatars[0]?.videos.filter((v) => v.state === "done").length === 1, 120_000);
      expect(kit.fileOf(launchId).status).toBe("running");
      return { first, nets: [net], launchId, avatarId, generates: true };
    },
  },
];

describe("the crash matrix: a kill at each step boundary of plan §3.6, then «Продолжить»", () => {
  const cells = BOUNDARIES.flatMap((b) => [true, false].map((review) => ({ label: `${b.name} · review ${review ? "ON" : "OFF"}`, boundary: b, review })));
  test.each(cells)("$label", async ({ boundary, review }) => {
    const halted = await within(boundary.halt({ review }), 150_000, "reaching the boundary");
    const firstRequests = await kit.crash(halted.first, halted.nets);

    const net2 = network();
    const second = await kit.boot(net2, boundary.realRender === true ? realRender : fakeRender());
    const paused = (await kit.getLaunch(second, halted.launchId)).launch;
    expect(paused.status).toBe("paused");
    expect(paused.resumeBlockedBy).toBe(boundary.expected.reconcile ? "reconcile-required" : null);
    // A5: a restart makes no reserve and no render until «Продолжить».
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(net2.paidCalls()).toEqual([]);
    expect(second.engine.renders.states()).toEqual([]);

    const { accepted, before } = await kit.resumeLaunch(second, halted.launchId);
    // Review ON, set not yet approved (rows 1 to 3): «Продолжить» brings the avatar back to the review wait and draws NOTHING until the owner continues. A restart that approved by itself
    // would draw here, and the wait below would never see the phase or the images would not be empty.
    if (review && ["1", "2", "3"].includes(boundary.id)) {
      await kit.waitView(second, halted.launchId, "the review wait after «Продолжить»", (v) => v.avatars[0]?.phase === "awaiting-review", 60_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await kit.getLaunch(second, halted.launchId)).launch.avatars[0]?.phase).toBe("awaiting-review");
      expect(net2.imageCalls()).toEqual([]);
    }
    await within(kit.driveToDone(second, halted.launchId), 200_000, "the resumed launch");
    expect([net2.writerCalls().length, net2.imageCalls().length]).toEqual([boundary.expected.writer, boundary.expected.images]);
    // A3, A2: no run's cap is above the draw allocation. A slice entry the first engine recorded with a cap far above what its 5 scenes cost (row 5a: 5 000 000) is lowered to today's cost,
    // which for one slice of all 5 scenes is exactly the allocation; a resume that kept the old cap would show here.
    const runs = ok(await kit.call(second, "runs.list", {}));
    if (runs.type !== "runs.list") throw new Error("wrong answer");
    const drawMicros = kit.fileOf(halted.launchId).avatars[0]?.allocation.drawMicros ?? 0;
    for (const run of runs.result.runs) expect(run.capMicros).toBeLessThanOrEqual(drawMicros);
    if (boundary.id === "5a") expect(runs.result.runs.map((r) => r.capMicros)).toEqual([drawMicros]);
    await within(expectLaunchInvariants(kit, second, { launchId: halted.launchId, avatarId: halted.avatarId, firstRequests, net: net2, accepted, before, generates: halted.generates }), 60_000, "the invariants");
  });
});

describe("the two ends of the matrix that need no table", () => {
  test("row 0, estimate: it persists nothing, so a kill after it leaves nothing to recover and a fresh launch runs to done", async () => {
    const avatarId = await kit.seedAvatar(0);
    const net1 = network();
    const first = await kit.boot(net1, fakeRender());
    const draft = draftOf([avatarId], { videosPerAvatar: 1 });
    ok(await kit.call(first, "autopilot.estimate", { draft }));
    expect(existsSync(join(kit.libraryDir(), "autopilot")) ? readdirSync(join(kit.libraryDir(), "autopilot")) : []).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
    const firstRequests = await kit.crash(first, [net1]);

    const net2 = network();
    const second = await kit.boot(net2, fakeRender());
    const listed = ok(await kit.call(second, "autopilot.list", {}));
    if (listed.type !== "autopilot.list") throw new Error("wrong answer");
    expect(listed.result.launches).toEqual([]);
    const launch = await kit.startLaunch(second, draft);
    await kit.driveToDone(second, launch.launchId);
    await within(expectLaunchInvariants(kit, second, { launchId: launch.launchId, avatarId, firstRequests, net: net2, accepted: launch.plannedWorstMicros, before: launch, generates: true }), 60_000, "the invariants");
  });

  test("a library-only launch killed with its render running spends nothing before or after: no request, no ledger line, and the video is made once", async () => {
    const avatarId = await kit.seedAvatar(10);
    const net1 = network();
    const first = await kit.boot(net1, fakeRender({ run: never }));
    // The plan seed is fixed: two slides of 5 photos, which every stored excerpt can carry (see engine.autopilotWiring.test.ts).
    const launch = await kit.startLaunch(first, draftOf([avatarId], { library: true, generate: false, videosPerAvatar: 2, planSeed: 7 }));
    await kit.drive(first, launch.launchId, "the render to run", () => first.engine.renders.states().some((s) => s.kind === "render" && s.launchId === launch.launchId && s.status === "running"), 60_000);
    const firstRequests = await kit.crash(first, [net1]);
    expect(ledgerLines(dir())).toEqual([]);

    const net2 = network();
    const second = await kit.boot(net2, realRender);
    expect((await kit.getLaunch(second, launch.launchId)).launch).toMatchObject({ status: "paused", resumeBlockedBy: null, remainingMicros: 0 });
    const { accepted, before } = await kit.resumeLaunch(second, launch.launchId);
    await within(kit.driveToDone(second, launch.launchId), 150_000, "the resumed library-only launch");
    expect(net2.paidCalls()).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
    await within(expectLaunchInvariants(kit, second, { launchId: launch.launchId, avatarId, firstRequests, net: net2, accepted, before, generates: false }), 60_000, "the invariants");
  });
});
