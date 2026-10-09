import { expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LaunchView } from "../../shared/engine";
import { LaunchFile } from "../autopilot/launchFile";
import type { EngineDeps } from "../engine";
import { fakeCdn } from "../music/testing/storeKit";
import { TrackStore } from "../music/trackStore";
import { readVideoRecordFiles } from "../videos/listing";
import { acceptingVerify } from "../videos/testing/kit";
import { writingRun } from "../videos/testing/serviceKit";
import { ledgerLines, NOW, ok } from "./engineHarness";
import { wiringKit, type WiringNetwork } from "./wiringKit";
import { within } from "./within";

// Test-only (S4.6d): what the crash matrix and the stop-unlink tests share. A "kill" here is a point-in-time COPY of the whole test folder (library, userData with its ledger, export folder)
// taken in one synchronous step while the first engine is held at a seam, as the disk of a process killed at that instant: the launch file still says `running`, a request that never returned
// has its reserve open, a commit held inside the export folder's lock leaves its intent and no lock (the lock is process-wide, so a second engine on the SAME folder would wait for it for
// ever, which a dead process would not make it do). The second engine opens the copy. The first engine is then shut down, and what it does after the copy touches only the old folder.
// Both engines share one controllable clock, so a reconcile can be allowed by moving it.

export type Kit = ReturnType<typeof crashKit>;

/** The second engine of a render boundary: ffmpeg is real; the verifier accepts what it wrote and what the first engine's fake wrote (recovery verifies a record's file again). */
export const realRender: Partial<EngineDeps> = { videos: { renderOverrides: { verify: acceptingVerify, runDeps: { measure: async () => -5.7 } } } };

/**
 * The render seam the engine tests share (`engine.ownMusic.test.ts`): ffmpeg writes its output at once and the verifier accepts it, the commit, the record, the intent and the recovery stay real. A
 * boundary that is not about the render uses it in both engines, so a cell costs a second and not the five that a real render does; the boundaries OF the render render for real in the second engine.
 */
export function fakeRender(extra: { run?: () => Promise<void>; hooks?: { reached: (step: string) => Promise<never> | undefined } } = {}): Partial<EngineDeps> {
  return { videos: { renderOverrides: { verify: acceptingVerify, ...(extra.hooks === undefined ? {} : { hooks: extra.hooks }), runDeps: { run: extra.run ?? writingRun, measure: async () => -5.7 } } } };
}

export type Started = Awaited<ReturnType<ReturnType<typeof wiringKit>["boot"]>>;

const MINUTE = 60_000;

export function crashKit(base: () => string) {
  /** The folder the engines run on: the test's own, and after a crash the copy. */
  const swapped: { to: string | null } = { to: null };
  const dir = (): string => swapped.to ?? base();
  const kit = wiringKit(dir);
  const clock = { mono: 0, wall: 0 };
  const clockDeps = { monotonic: () => clock.mono, clock: () => NOW + clock.wall };
  const launchPath = (launchId: string) => join(kit.libraryDir(), "autopilot", `${launchId}.json`);

  /** An engine as the app builds it, on the shared clock; `deps` replace its parts (a test's own steps, render and face seams, a track store). */
  const booted: Started[] = [];
  const boot = async (net: WiringNetwork, deps: Partial<EngineDeps> = {}) => {
    const started = await within(kit.boot(net, { deps: { ...clockDeps, ...deps } }), 60_000, "the engine to start");
    booted.push(started);
    return started;
  };

  /** Shuts down every engine this test started (a killed one included: a second shutdown is a no-op), so no timer of a free run outlives the test. */
  async function shutdownAll(): Promise<void> {
    for (const started of booted.splice(0)) await within(started.engine.shutdown(50), 30_000, "the shutdown at the end of a test").catch(() => undefined);
  }

  /** The launch file as the disk holds it (parsed with the launch file schema). */
  const fileOf = (launchId: string): LaunchFile => LaunchFile.parse(JSON.parse(readFileSync(launchPath(launchId), "utf8")));

  /** Shuts the engine down; what it does is bounded and touches its own folder only. */
  async function kill(started: Started): Promise<void> {
    // 50 ms: a render held in its commit is given no time, as a process that dies is given none.
    await within(started.engine.shutdown(50), 30_000, "the simulated kill");
  }

  /**
   * The disk as it is NOW is copied, in one synchronous step (so the first engine cannot write in between), and every later call of the kit works on the copy. Returns how many paid requests
   * the fake OpenRouters had received at that instant. Synchronous so that a test hook inside the engine can take it at the very instant a write is about to land or has landed.
   */
  function snapshot(nets: readonly WiringNetwork[]): number {
    const from = dir();
    const to = join(base(), `after-kill-${swapped.to === null ? 1 : 2}`);
    mkdirSync(to);
    for (const name of ["library", "userData", "export"]) if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true });
    const requests = nets.reduce((sum, net) => sum + net.paidCalls().length, 0);
    swapped.to = to;
    return requests;
  }

  /** The kill: the snapshot, then the first engine is shut down (what it does after the copy touches only its own folder). */
  async function crash(first: Started, nets: readonly WiringNetwork[]): Promise<number> {
    const requests = snapshot(nets);
    await kill(first);
    return requests;
  }

  /** A track store with no track at all: a video that needs a track waits for one (A9). */
  async function emptyTrackStore(): Promise<TrackStore> {
    return TrackStore.open({ dir: join(dir(), "userData", "music-empty"), transport: fakeCdn().transport, clock: () => NOW, log: () => undefined });
  }

  /** Polls `want` on the engine's own answer of the launch; the failure message says where the launch stood. */
  const waitView = kit.waitFor;

  /** Waits until the file satisfies `want` (the disk, not the view: a boundary is a state of the files). */
  async function waitFile(launchId: string, what: string, want: (file: LaunchFile) => boolean, ms = 60_000): Promise<LaunchFile> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (existsSync(launchPath(launchId))) {
        const file = fileOf(launchId);
        if (want(file)) return file;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** «Продолжить» as the window sends it: after a reconcile if the view says the ledger needs one, with R as the view states it. Returns R. */
  async function resumeLaunch(started: Started, launchId: string): Promise<{ accepted: number; before: LaunchView }> {
    let view = (await kit.getLaunch(started, launchId)).launch;
    if (view.resumeBlockedBy === "reconcile-required") {
      clock.mono += 10 * MINUTE;
      clock.wall += 10 * MINUTE;
      ok(await kit.call(started, "money.reconcile", {}));
      await started.engine.settled();
      view = (await kit.getLaunch(started, launchId)).launch;
    }
    expect(view.resumeBlockedBy).toBeNull();
    const accepted = view.remainingMicros;
    // R is a bound, not a formality: one micro-dollar less is refused as PRICE_CHANGED, and the launch stays paused.
    if (accepted > 0) {
      const short = await kit.call(started, "autopilot.resume", { launchId, acceptedRemainingMicros: accepted - 1 });
      expect(short.ok).toBe(false);
      if (!short.ok) expect(short.error.code).toBe("PRICE_CHANGED");
      expect((await kit.getLaunch(started, launchId)).launch.status).toBe("paused");
    }
    ok(await kit.call(started, "autopilot.resume", { launchId, acceptedRemainingMicros: accepted }));
    return { accepted, before: view };
  }

  /**
   * Drives a launch until `until` holds on the file and the view; with the review on, the owner presses «Продолжить запуск» whenever an avatar waits for it. Throws if the launch
   * is stopped, or the bound passes (the message says where the launch stood).
   */
  async function drive(started: Started, launchId: string, what: string, until: (view: LaunchView, file: LaunchFile) => boolean, ms = 150_000): Promise<LaunchView> {
    const deadline = Date.now() + ms;
    const continued = new Set<string>();
    for (;;) {
      const view = (await kit.getLaunch(started, launchId)).launch;
      if (until(view, fileOf(launchId))) return view;
      if (view.status === "stopped") throw new Error("the launch was stopped");
      for (const row of view.avatars) {
        const key = `${row.avatarId}:${row.sceneSetId ?? ""}:${row.setRevision ?? 0}`;
        if (row.phase === "awaiting-review" && row.sceneSetId != null && row.setRevision != null && !continued.has(key)) {
          continued.add(key);
          ok(await kit.call(started, "autopilot.continueAfterReview", { launchId, avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision }));
        }
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (status ${view.status}, phase ${view.avatars[0]?.phase ?? "none"}, hold ${view.paidHold?.reason ?? "none"})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const driveToDone = (started: Started, launchId: string): Promise<LaunchView> => drive(started, launchId, "the launch to be done", (view) => view.status === "done");

  /** Back to the test's own folder and the clock at zero: each test starts on a fresh folder. */
  const reset = (): void => {
    swapped.to = null;
    clock.mono = 0;
    clock.wall = 0;
  };

  return { ...kit, root: dir, reset, shutdownAll, clock, boot, fileOf, launchPath, kill, snapshot, crash, emptyTrackStore, waitView, waitFile, resumeLaunch, drive, driveToDone };
}

// ---------- the ledger, read from the disk ----------

interface Reserve {
  attemptId: string;
  worstMicros: number;
  runId: string | null;
}

function reservesOf(lines: readonly Record<string, unknown>[]): Reserve[] {
  const reserves: Reserve[] = [];
  for (const line of lines) {
    if (line.type !== "reserve" || typeof line.attemptId !== "string" || typeof line.worstMicros !== "number") continue;
    const scope = line.scope;
    const runId = typeof scope === "object" && scope !== null && "runId" in scope && typeof scope.runId === "string" ? scope.runId : null;
    reserves.push({ attemptId: line.attemptId, worstMicros: line.worstMicros, runId });
  }
  return reserves;
}

/** What an attempt cost by the ledger: its settled cost, nothing when it was released, its worst case while it is open. */
function costOf(lines: readonly Record<string, unknown>[], reserve: Reserve): number {
  for (const line of lines) {
    if (line.attemptId !== reserve.attemptId) continue;
    if (line.type === "settle" && typeof line.costMicros === "number") return line.costMicros;
    if (line.type === "release") return 0;
  }
  return reserve.worstMicros;
}

/** The sum over the scopes a launch created: the writer attempts of its set and the attempts of its slice runs, each as the ledger holds it (A14). */
export function ledgerSpentOf(lines: readonly Record<string, unknown>[], sceneSetId: string, runIds: readonly string[]): number {
  const runs = new Set(runIds);
  return reservesOf(lines)
    .filter((r) => r.attemptId.startsWith(`${sceneSetId}:writer-`) || (r.runId !== null && runs.has(r.runId)))
    .reduce((sum, r) => sum + costOf(lines, r), 0);
}

// ---------- the invariants every cell ends with ----------

export interface CellFacts {
  /** The launch id and the avatar that generate (or do not). */
  launchId: string;
  avatarId: string;
  /** The paid requests the fake OpenRouters had received when the first engine was killed, and the second engine's own network. */
  firstRequests: number;
  net: WiringNetwork;
  /** What the view said when «Продолжить» was pressed. */
  accepted: number;
  before: LaunchView;
  /** Whether the launch generates photos (a library-only launch has no set, no run and no money). */
  generates: boolean;
}

/**
 * The end of every cell of the crash matrix (plan §3.6, A2, A4, A7, A14, A15): after «Продолжить» the launch is done and
 *  - there is one scene set and one run per slice entry, and no run beyond them;
 *  - no attempt id is reserved twice, no job failed with ATTEMPT_ID_REUSED, and every request that reached a fake OpenRouter has exactly one reserve that was not released;
 *  - no photo is in two videos, every record of the launch carries its provenance, the keys differ;
 *  - the videos on disk are the plan less the dropped ones;
 *  - spent never passed W′, and R was W′ less what was spent when the button was pressed (the engine takes the cap of the group from W′ alone);
 *  - the ledger's sum over the launch's scopes is the launch's `spentMicros`, to the micro-dollar.
 */
export async function expectLaunchInvariants(kit: Kit, started: Started, facts: CellFacts): Promise<LaunchView> {
  const view = (await kit.getLaunch(started, facts.launchId)).launch;
  expect(view.status).toBe("done");
  const file = kit.fileOf(facts.launchId);
  const library = started.engine.library;
  if (library === null) throw new Error("no library is open");

  // A4: ids before calls, no second set, no second run.
  const row = file.avatars.find((a) => a.avatarId === facts.avatarId);
  const lines = ledgerLines(kit.root());
  const runIds: string[] = [];
  if (facts.generates) {
    const generation = row?.generation;
    if (generation === null || generation === undefined) throw new Error("the avatar does not generate");
    const listed = await library.sceneSets.list(facts.avatarId);
    expect(listed.unreadable).toBe(0);
    expect(listed.sets.map((s) => s.sceneSetId)).toEqual([generation.sceneSetId]);
    // A finished launch has let its set go (the draw's slice entries with it), so the runs are read from the runs themselves: 25 photos at most per avatar in these launches mean ONE slice.
    const runs = ok(await kit.call(started, "runs.list", {}));
    if (runs.type !== "runs.list") throw new Error("wrong answer");
    runIds.push(...runs.result.runs.filter((r) => r.avatarId === facts.avatarId).map((r) => r.runId));
    expect(runIds).toEqual([generation.setRunId]);
  }

  // The ledger: no id twice; each request has one reserve that went out.
  const reserves = reservesOf(lines);
  expect(new Set(reserves.map((r) => r.attemptId)).size).toBe(reserves.length);
  const released = new Set(lines.flatMap((l) => (l.type === "release" && typeof l.attemptId === "string" ? [l.attemptId] : [])));
  const sent = reserves.filter((r) => !released.has(r.attemptId)).length;
  const requests = facts.firstRequests + facts.net.paidCalls().length;
  expect(requests).toBe(sent);
  const failures = started.events().filter((e) => e.type === "job.failed" && JSON.stringify(e.payload).includes("ATTEMPT_ID_REUSED"));
  expect(failures).toEqual([]);

  // A7, A15: the records.
  const records = (await readVideoRecordFiles(kit.libraryDir(), facts.avatarId)).records;
  const done = row?.videos.filter((v) => v.state === "done") ?? [];
  const dropped = row?.videos.filter((v) => v.state === "dropped") ?? [];
  expect(done.length + dropped.length).toBe(row?.videos.length ?? -1);
  // Every photo of these launches arrives and a track fits every video, so a crash may delay a video but must not lose one: the general rule (videos = plan - dropped) is held to nothing dropped here.
  expect(dropped.map((v) => v.dropReason)).toEqual([]);
  expect(row?.videos.length).toBe(file.plan.videos);
  expect(records).toHaveLength(file.plan.videos - dropped.length);
  const photos = new Set<string>();
  for (const record of records) {
    expect(record).toMatchObject({ origin: "autopilot", launchId: facts.launchId });
    for (const clip of record.spec.clips) {
      const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
      for (const cell of cells) {
        if (cell.photo?.source !== "scene") continue;
        expect(photos.has(cell.photo.photoId)).toBe(false);
        photos.add(cell.photo.photoId);
      }
    }
  }
  expect(new Set(records.map((r) => r.launchVideoKey)).size).toBe(records.length);
  expect(new Set(done.map((v) => v.videoId)).size).toBe(done.length);
  kit.expectVideosOnDisk(await kit.videosOf(started, facts.avatarId), file.plan.videos - dropped.length);

  // A2, A4, A14: the money.
  expect(view.spentMicros).toBeLessThanOrEqual(view.plannedWorstMicros);
  expect(facts.accepted).toBe(Math.max(0, view.plannedWorstMicros - facts.before.spentMicros));
  if (facts.generates) expect(view.spentMicros).toBe(ledgerSpentOf(lines, row?.generation?.sceneSetId ?? "", runIds));
  else expect(view.spentMicros).toBe(0);
  // Nothing of the launch is left open, slice attempts (`<runId>:slot-N#k`) included: the only launch of the library is this one.
  expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
  expect(file.reviewWritesMicros).toBe(0);
  return view;
}
