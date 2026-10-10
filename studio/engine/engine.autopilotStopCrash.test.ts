import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createPaidSteps } from "./autopilot/paidSteps";
import { LaunchStores } from "./autopilot/lookup";
import type { EngineDeps } from "./engine";
import { within } from "./testing/within";
import { failed, ledgerLines, ok, until, useEngineDir } from "./testing/engineHarness";
import { crashKit, fakeRender, ledgerSpentOf, type Started } from "./testing/crashKit";
import { draftOf, network, type WiringNetwork } from "./testing/wiringKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6d (plan §3.7, §10 A20): a kill during each unlink of «Стоп». «Стоп» persists `stopping`, lets what is in flight finish, UNLINKS each set of the launch (one write of the set's
// file under its mutex: `launchId` cleared, `launchDraw` too for a set not yet drawn from), freezes the figures, and only then writes `stopped`. A process that dies anywhere in that must leave
// a state the next start can finish: the launch `stopping` or `stopped`, no group left registered, no open reserve of the launch, and every set back with its owner (no `launchId` that blocks
// anything; A20). The kill is a copy of the disk taken inside the write itself: just before the rename of the set's file (the old file, the new one beside it as a temp), just after the rename,
// and just before the launch file's final `stopped` write (the sets already released: the crash window F1 closes).

setDefaultTimeout(120_000);

// Registered BEFORE `useEngineDir`: hooks run first in, first out, and the engines must be shut down before their folder is removed.
afterEach(() => kit.shutdownAll());
const dir = useEngineDir("studio-engine-stop-crash-");
const kit = crashKit(dir);
beforeEach(() => kit.reset());

type Phase = "composing" | "awaiting" | "approved" | "drawn";
type Point = "before the set's rename" | "after the set's rename" | "before the final write";

const PHASES: Phase[] = ["composing", "awaiting", "approved", "drawn"];
const POINTS: Point[] = ["before the set's rename", "after the set's rename", "before the final write"];

/** The text of the file a write is about to rename into `finalPath` (its temp sibling) or has just renamed there. */
function pendingText(finalPath: string, point: "before" | "after"): string | null {
  if (point === "after") return existsSync(finalPath) ? readFileSync(finalPath, "utf8") : null;
  const folder = dirname(finalPath);
  const temp = readdirSync(folder).find((name) => name.startsWith(`.${basename(finalPath)}.`) && name.endsWith(".tmp"));
  return temp === undefined ? null : readFileSync(join(folder, temp), "utf8");
}

const parsed = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
};

interface Scene {
  first: Started;
  net: WiringNetwork;
  launchId: string;
  avatarId: string;
  sceneSetId: string;
  /** Opens the held writer (the composing phase). */
  release: () => void;
  /** «Стоп», as the window sends it. */
  stop: () => Promise<void>;
}

/** An engine at `phase`, with the test hooks that take the copy at `point` of the stop's unlink. `taken()` says whether the copy was made. */
async function atPhase(phase: Phase, point: Point, review: boolean, videos = 1) {
  const avatarId = await kit.seedAvatar(0);
  let open: () => void = () => undefined;
  const writerGate = phase === "composing" ? new Promise<void>((resolve) => (open = resolve)) : undefined;
  const net = network(writerGate === undefined ? {} : { writerGate });
  const state = { armed: false, taken: false, sceneSetId: "", launchId: "" };

  const take = (): void => {
    if (state.taken) return;
    state.taken = true;
    kit.snapshot([net]);
  };
  // The set's unlink is the write of its file that has no `launchId`; the launch's final write is the one that says `stopped`.
  const isUnlink = (path: string, which: "before" | "after"): boolean => state.armed && state.sceneSetId !== "" && basename(path).includes(state.sceneSetId) && parsed(pendingText(path, which))?.launchId === undefined;
  const testHooks = {
    beforeRename: (path: string): void => {
      if (point === "before the set's rename" && isUnlink(path, "before")) take();
    },
    afterRename: (path: string): void => {
      if (point === "after the set's rename" && isUnlink(path, "after")) take();
    },
  };
  const finalWrite = (which: "before" | "after") => (path: string): void => {
    if (point !== "before the final write" || !state.armed || !basename(path).startsWith(state.launchId)) return;
    if (parsed(pendingText(path, which))?.status === "stopped") take();
  };
  const launches = new LaunchStores({ beforeRename: finalWrite("before") });

  const holder: { engine: Started["engine"] | null } = { engine: null };
  const paidOnly = createPaidSteps({
    port: () => {
      if (holder.engine === null) throw new Error("the engine is not started yet");
      return holder.engine;
    },
  });
  const deps: Partial<EngineDeps> = {
    ...fakeRender(),
    library: { testHooks },
    launches,
    // The drawn phase stops at the montage: the paid part alone ran, nothing renders.
    ...(phase === "drawn" ? { launchSteps: paidOnly } : {}),
  };
  const first = await kit.boot(net, deps);
  holder.engine = first.engine;
  const launch = await kit.startLaunch(first, draftOf([avatarId], { sceneReview: review, videosPerAvatar: videos }));
  state.launchId = launch.launchId;
  const generation = kit.fileOf(launch.launchId).avatars[0]?.generation;
  if (generation === null || generation === undefined) throw new Error("the avatar does not generate");
  state.sceneSetId = generation.sceneSetId;

  const stop = async (): Promise<void> => {
    state.armed = true;
    ok(await kit.call(first, "autopilot.stop", { launchId: launch.launchId }));
  };
  const scene: Scene = { first, net, launchId: launch.launchId, avatarId, sceneSetId: generation.sceneSetId, release: open, stop };
  return { scene, state };
}

/** Brings the launch to `phase` and presses «Стоп»; the hook takes the copy somewhere inside it. */
async function reach(scene: Scene, phase: Phase): Promise<void> {
  const { first, launchId, avatarId, sceneSetId, net } = scene;
  if (phase === "composing") {
    await kit.waitView(first, launchId, "the writer request", () => net.writerCalls().length === 1, 60_000);
    // «Стоп» with the writer's request in flight: the soft stop waits for it, the chunk is saved, and then the set is unlinked.
    const stopping = scene.stop();
    scene.release();
    await stopping;
    return;
  }
  await kit.waitFile(launchId, "the review wait", (f) => f.avatars[0]?.phase === "awaiting-review");
  if (phase === "approved") {
    const set = await first.engine.library?.sceneSets.get(avatarId, sceneSetId);
    await first.engine.approveLaunchSet({ sceneSetId, launchId, revision: set?.revision ?? 0, plannedCount: 5 });
  }
  await within(scene.stop(), 60_000, "«Стоп»");
}

describe("a kill during the unlink of «Стоп»: the next start finishes it and every set is back with its owner (A20)", () => {
  const cells = PHASES.flatMap((phase) => POINTS.map((point) => ({ label: `${phase} · ${point}`, phase, point })));
  test.each(cells)("$label", async ({ phase, point }) => {
    // The drawn phase needs a slice folder: the review is off there so the paid part draws at once; every other phase waits for the owner's review (or for the writer).
    const review = phase !== "drawn" && phase !== "composing";
    const { scene, state } = await within(atPhase(phase, point, review), 90_000, "the launch to start");
    if (phase === "drawn") {
      await kit.waitFile(scene.launchId, "the draw to finish", (f) => f.avatars[0]?.phase === "montage");
      await within(scene.stop(), 60_000, "«Стоп»");
    } else await within(reach(scene, phase), 90_000, "the phase");
    // A stop with a request in flight answers at once and finishes behind the answer: the copy is taken when it gets to the write.
    await until(() => state.taken, "the copy inside the stop", 30_000);
    await kit.kill(scene.first);

    // What the copy holds: the launch still `stopping` (the final write had not landed) and the set as the point says.
    const onDisk = kit.fileOf(scene.launchId);
    expect(onDisk.status).toBe("stopping");
    // F1: the figure is frozen before the sets are let go, so it is on disk at every point of the unlink.
    expect(onDisk.reviewWritesMicros).toBe(0);
    // The set's file in the copy: still linked before the rename, released after it, and already released when only the final write is left.
    const setFile = readdirSync(kit.libraryDir(), { recursive: true }).map(String).find((name) => basename(name) === `${scene.sceneSetId}.json`);
    expect(setFile).not.toBeUndefined();
    const setOnDisk = parsed(readFileSync(join(kit.libraryDir(), setFile ?? ""), "utf8"));
    expect(setOnDisk?.launchId !== undefined).toBe(point === "before the set's rename");

    const net2 = network();
    const second = await kit.boot(net2, fakeRender());
    await second.engine.settled();
    const view = await kit.waitFor(second, scene.launchId, "the stop to be finished", (v) => v.status === "stopped", 30_000);
    expect(view.spentMicros).toBeLessThanOrEqual(view.plannedWorstMicros);

    // Consistent: stopped, its group gone, no open reserve, nothing sent by the restart.
    const file = kit.fileOf(scene.launchId);
    expect(file.status).toBe("stopped");
    expect(file.reviewWritesMicros).toBe(0);
    expect(file.paidHold).toBeNull();
    expect(second.engine.launchGroups.groupOf({ attemptId: `${scene.sceneSetId}:writer-9#1`, scope: { avatarJobId: "job-x" } })).toBeNull();
    expect(second.engine.budget?.ledger.openReserves()).toEqual([]);
    expect(net2.paidCalls()).toEqual([]);

    // Returned to the owner: no `launchId` on the set or on its run, and the set's own commands are not refused as the launch's.
    const listed = await second.engine.library?.sceneSets.list(scene.avatarId);
    expect(listed?.sets.map((s) => s.sceneSetId)).toEqual([scene.sceneSetId]);
    expect(listed?.sets[0]?.launchId).toBeUndefined();
    expect(listed?.sets[0]?.launchDraw).toBeUndefined();
    const runs = ok(await kit.call(second, "runs.list", {}));
    if (runs.type !== "runs.list") throw new Error("wrong answer");
    expect(runs.result.runs.filter((r) => r.launchId !== undefined)).toEqual([]);
    const set = listed?.sets[0];
    if (phase === "drawn") {
      // A set drawn from stays used; its run is the owner's own: the manual commands answer for their own reasons, never as «launch-set».
      const resume = await kit.call(second, "runs.resume", { runId: set?.runId ?? "", acceptedWorstMicros: 1 });
      if (!resume.ok) expect(resume.error.sceneReason).not.toBe("launch-set");
    } else {
      const edited = ok(await kit.call(second, "scenes.edit", { sceneSetId: scene.sceneSetId, revision: set?.revision ?? 0, op: { op: "text", sceneId: 1, text: "The owner rewrites the first scene after the stop." } }));
      expect(edited.type).toBe("scenes.edit");
      const discarded = await kit.call(second, "scenes.discard", { sceneSetId: scene.sceneSetId });
      expect(discarded.ok || discarded.error.sceneReason !== "launch-set").toBe(true);
    }
    // The launch can not be resumed or stopped again: it is over.
    failed(await kit.call(second, "autopilot.resume", { launchId: scene.launchId, acceptedRemainingMicros: 0 }));
  });
});


// S4.10 fix A, M1 (money): a launch of two slices (6 videos of 5-photo slides = 30 photos = 25 + 5). The unlink erases the set's `launchId` and `launchDraw`, and the launch file names only the
// set's own run, so a restart that finds the launch after the release used to rebuild its Budget group WITHOUT the second slice and write a smaller figure over the right one.
describe("a kill after the sets are released: the figure written at the end is the ledger's (S4.10 M1)", () => {
  /** The runs of the avatar and the ledger's sum over the launch's scopes, read from the copy the second engine opened. */
  async function ledgerSum(second: Started, scene: { avatarId: string; sceneSetId: string }): Promise<number> {
    const runs = ok(await kit.call(second, "runs.list", {}));
    if (runs.type !== "runs.list") throw new Error("wrong answer");
    const runIds = runs.result.runs.filter((r) => r.avatarId === scene.avatarId).map((r) => r.runId);
    expect(runIds).toHaveLength(2);
    return ledgerSpentOf(ledgerLines(kit.root()), scene.sceneSetId, runIds);
  }

  test("a stop killed just before the final «stopped» write ends with spentMicros equal to the ledger sum of both slices", async () => {
    const { scene, state } = await within(atPhase("drawn", "before the final write", false, 6), 90_000, "the launch to start");
    await kit.waitFile(scene.launchId, "both slices to be drawn", (f) => f.avatars[0]?.phase === "montage");
    await within(scene.stop(), 60_000, "«Стоп»");
    await until(() => state.taken, "the copy inside the stop", 30_000);
    await kit.kill(scene.first);
    expect(kit.fileOf(scene.launchId).status).toBe("stopping");

    const second = await kit.boot(network(), fakeRender());
    await second.engine.settled();
    const view = await kit.waitFor(second, scene.launchId, "the stop to be finished", (v) => v.status === "stopped", 30_000);
    const expected = await ledgerSum(second, scene);
    expect(expected).toBeGreaterThan(1_000_000);
    expect(view.spentMicros).toBe(expected);
    expect(kit.fileOf(scene.launchId).spentMicros).toBe(expected);
  });

  /** A launch of 6 videos that runs to its end on the default steps; the copy is taken right before the `done` write. */
  async function finishingLaunch() {
    const avatarId = await kit.seedAvatar(0);
    const net = network();
    const state = { taken: false, launchId: "" };
    const launches = new LaunchStores({
      beforeRename: (path: string): void => {
        if (state.taken || state.launchId === "" || !basename(path).startsWith(state.launchId)) return;
        if (parsed(pendingText(path, "before"))?.status === "done") {
          state.taken = true;
          kit.snapshot([net]);
        }
      },
    });
    const first = await kit.boot(net, { ...fakeRender(), launches });
    const launch = await kit.startLaunch(first, draftOf([avatarId], { videosPerAvatar: 6 }));
    state.launchId = launch.launchId;
    const sceneSetId = kit.fileOf(launch.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    await until(() => state.taken, "the copy right before the «done» write", 150_000);
    await kit.kill(first);
    return { launchId: launch.launchId, avatarId, sceneSetId };
  }

  test("a finish killed just before the «done» write reports the ledger sum of both slices, not the group a restart could rebuild", async () => {
    const scene = await within(finishingLaunch(), 180_000, "the launch to reach its end");
    const onDisk = kit.fileOf(scene.launchId);
    expect(onDisk.reviewWritesMicros).toBe(0);
    const net2 = network();
    const second = await kit.boot(net2, fakeRender());
    await second.engine.settled();
    const view = (await kit.getLaunch(second, scene.launchId)).launch;
    expect(view.spentMicros).toBe(await ledgerSum(second, scene));
    expect(net2.paidCalls()).toEqual([]);
  });
});

// S4.10 fix A, crash LOW-1: the finish froze its figures and every video was final, but the process died before the `done` write. The restart used to pause such a launch and ask
// «Продолжить · до $R» for nothing; it now ends it, the way it ends a stop it finds under way.
describe("a finish killed before the «done» write comes back done (S4.10 LOW-1)", () => {
  test("the restart completes the launch: done, nothing to continue, nothing sent", async () => {
    const avatarId = await kit.seedAvatar(0);
    const net = network();
    const state = { taken: false, launchId: "" };
    const launches = new LaunchStores({
      beforeRename: (path: string): void => {
        if (state.taken || state.launchId === "" || !basename(path).startsWith(state.launchId)) return;
        if (parsed(pendingText(path, "before"))?.status === "done") {
          state.taken = true;
          kit.snapshot([net]);
        }
      },
    });
    const first = await kit.boot(net, { ...fakeRender(), launches });
    const launch = await kit.startLaunch(first, draftOf([avatarId], { videosPerAvatar: 2 }));
    state.launchId = launch.launchId;
    await until(() => state.taken, "the copy right before the «done» write", 150_000);
    await kit.kill(first);
    const frozen = kit.fileOf(launch.launchId);
    expect(frozen.status).toBe("running");
    expect(frozen.reviewWritesMicros).toBe(0);

    const net2 = network();
    const second = await kit.boot(net2, fakeRender());
    await second.engine.settled();
    const view = (await kit.getLaunch(second, launch.launchId)).launch;
    expect(view.status).toBe("done");
    expect(view.resumeBlockedBy).toBeNull();
    expect(view.paused).toBeNull();
    const file = kit.fileOf(launch.launchId);
    expect(file.status).toBe("done");
    expect(file.endedAt).not.toBeNull();
    expect(file.avatars[0]?.videos.every((v) => v.state === "done")).toBe(true);
    expect(net2.paidCalls()).toEqual([]);
    expect(second.engine.launchGroups.has(launch.launchId)).toBe(false);
  });
});
