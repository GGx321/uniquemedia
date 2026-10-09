import { describe, expect, test } from "bun:test";
import {
  AutopilotGetResult,
  AVATAR_PHASES,
  LaunchSummary,
  LaunchView,
  LAUNCH_STATUSES,
  PAID_HOLD_REASONS,
  WaitingReason,
  type EventMessage,
  type LaunchDraftInput,
} from "../../shared/engine";
import type { MockTrackSeed } from "./mockMusicStore";
import { PAID_FAULTS } from "./mockLaunchRun";
import { draftOf, MIA, runWorld, SOFIA, track, unwrap, type Mock } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: the mock's view must pass the SAME contract refines as the engine's, in every state it can reach. The S4.6v review fuzzed the engine's view; this does the same to the
// mock's: a seeded random world and a seeded random sequence of the owner's clicks and the world's changes (the testkit's switches), and after EVERY step the view the window would read
// (`autopilot.get`, the snapshot, every `autopilot.changed` announced) is parsed by the contract and checked against the invariants below. The run also records which states and reasons
// it reached, and the last test requires the whole vocabulary the mock claims to reach (so a switch that stopped working fails here even if no other test names it).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Seen {
  statuses: Set<string>;
  holds: Set<string>;
  waits: Set<string>;
  phases: Set<string>;
  blockedBy: Set<string>;
  freeHolds: Set<string>;
  waitingMusic: boolean;
  unsettled: boolean;
  inFlight: boolean;
  pausedCauses: Set<string>;
  skipped: boolean;
  dropReasons: Set<string>;
}

const seen: Seen = {
  statuses: new Set(),
  holds: new Set(),
  waits: new Set(),
  phases: new Set(),
  blockedBy: new Set(),
  freeHolds: new Set(),
  waitingMusic: false,
  unsettled: false,
  inFlight: false,
  pausedCauses: new Set(),
  skipped: false,
  dropReasons: new Set(),
};

const CATEGORIES: LaunchDraftInput["mix"][] = [
  { single: 50, collage: 25, slides: 25 },
  { single: 0, collage: 0, slides: 100 },
  { single: 100, collage: 0, slides: 0 },
  { single: 70, collage: 20, slides: 10 },
];

function randomTracks(next: () => number): MockTrackSeed[] {
  const count = Math.floor(next() * 3);
  return Array.from({ length: count }, (_, i) => track(i + 1, { durationMs: next() < 0.2 ? 3_000 : 12_000, explicit: next() < 0.15 }));
}

const DRAWN_FAULTS = PAID_FAULTS.filter((fault) => fault !== "job-failed");

async function fuzzOne(seed: number, steps: number): Promise<void> {
  const next = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const trail: string[] = [];
  const fail = (what: string): never => {
    throw new Error(`seed ${seed}: ${what}\n  after: ${trail.slice(-12).join(" > ")}`);
  };

  const mock: Mock = runWorld({ renderConcurrency: 2 }, randomTracks(next));
  let cursor = 0;
  let sets = 0;
  const ended = new Map<string, string>();

  async function check(): Promise<void> {
    const events: EventMessage[] = mock.events.slice(cursor);
    cursor = mock.events.length;
    for (const event of events) {
      if (event.type !== "autopilot.changed") continue;
      const parsed = LaunchView.safeParse(event.payload.launch);
      if (!parsed.success) fail(`an announced view breaks the contract: ${JSON.stringify(parsed.error.issues)}`);
    }
    const listed = await unwrap(mock.client.request("autopilot.list", {}));
    for (const summary of listed.launches) {
      const parsed = LaunchSummary.safeParse(summary);
      if (!parsed.success) fail(`a summary breaks the contract: ${JSON.stringify(parsed.error.issues)}`);
      const got = await unwrap(mock.client.request("autopilot.get", { launchId: summary.launchId }));
      const result = AutopilotGetResult.safeParse(got);
      if (!result.success) fail(`autopilot.get breaks the contract: ${JSON.stringify(result.error.issues)}`);
      const view = got.launch;
      seen.statuses.add(view.status);
      if (view.paused !== null) seen.pausedCauses.add(view.paused.cause);
      if (view.paidHold !== null) seen.holds.add(view.paidHold.reason);
      if (view.freeHold !== null) seen.freeHolds.add(view.freeHold.detail.exportReason);
      if (view.resumeBlockedBy !== null) seen.blockedBy.add(view.resumeBlockedBy);
      if (view.waitingMusic > 0) seen.waitingMusic = true;
      if ((view.unsettled?.requests ?? 0) > 0) seen.unsettled = true;
      if (view.inFlight.requests > 0) seen.inFlight = true;
      for (const row of view.avatars) {
        seen.phases.add(row.phase);
        if (row.waiting !== null) seen.waits.add(row.waiting.reason);
        if (row.skipped !== null) seen.skipped = true;
        if (row.dropped !== null) seen.dropReasons.add(row.dropped.reason);
      }

      // The invariants beyond the refines.
      const live = view.status !== "done" && view.status !== "stopped";
      if (view.spentMicros > view.plannedWorstMicros) fail(`spent ${view.spentMicros} passed the planned worst case ${view.plannedWorstMicros}`);
      if (!live && (view.inFlight.requests > 0 || (view.unsettled?.requests ?? 0) > 0)) fail("an ended launch has open requests");
      if (view.status !== "running" && view.status !== "pausing" && view.inFlight.requests > 0 && view.status !== "stopping") fail(`${view.status} with requests in flight`);
      if (!live && view.paidHold !== null) fail("an ended launch holds");
      if (view.resumeBlockedBy !== null && !(view.status === "paused" || (view.status === "running" && view.paidHold !== null))) fail(`resumeBlockedBy ${view.resumeBlockedBy} on ${view.status} with no hold`);
      const doneRows = view.avatars.reduce((sum, a) => sum + a.videos.done, 0);
      const doneVideos = got.videos.filter((v) => v.state === "done" && v.removed === undefined).length;
      if (doneRows !== doneVideos) fail(`the rows say ${doneRows} videos are done, the results list ${doneVideos}`);
      if (listed.launches.find((l) => l.launchId === view.launchId)?.videosDone !== doneVideos) fail("the history's count differs from the results'");
      if (live) {
        const money = (await unwrap(mock.client.request("engine.snapshot", {}))).money;
        // The ledger holds at least what the launch says is open: an EARLIER launch that ended may have left reserves of its own (a drop's), which only a reconcile closes.
        if (money.ledger === "open" && money.unsettledMicros < view.inFlight.openMicros + (view.unsettled?.openMicros ?? 0)) {
          fail(`the ledger holds ${money.unsettledMicros} open, the view says ${view.inFlight.openMicros} in flight and ${view.unsettled?.openMicros ?? 0} unsettled`);
        }
      }
      if (view.status === "done" && got.videos.some((v) => v.state === "rendering" || v.state === "waiting-music")) fail("a done launch has videos still being made");
      const recordsOf = new Map<string, Set<string>>();
      for (const v of got.videos.filter((x) => x.state === "done")) {
        if (!recordsOf.has(v.avatarId)) recordsOf.set(v.avatarId, new Set((await unwrap(mock.client.request("videos.list", { avatarId: v.avatarId }))).videos.map((r) => r.videoId)));
        if (v.videoId === null || recordsOf.get(v.avatarId)?.has(v.videoId) !== true) fail(`the finished video ${v.key} has no record in the library`);
      }

      const frozen = ended.get(view.launchId);
      const json = JSON.stringify(got);
      if (frozen !== undefined && frozen !== json) fail(`the ended launch ${view.launchId} changed after it ended`);
      if (!live) ended.set(view.launchId, json);
    }
    const snapshot = (await unwrap(mock.client.request("engine.snapshot", {}))).autopilot ?? null;
    if (snapshot !== null && !LaunchView.safeParse(snapshot).success) fail("the snapshot's view breaks the contract");
  }

  const latest = async (): Promise<string | null> => {
    const listed = await unwrap(mock.client.request("autopilot.list", {}));
    return listed.launches[0]?.launchId ?? null;
  };

  async function start(): Promise<void> {
    const draft: LaunchDraftInput = draftOf({
      avatarIds: pick([[MIA.avatarId], [SOFIA.avatarId], [MIA.avatarId, SOFIA.avatarId]]),
      videosPerAvatar: 1 + Math.floor(next() * 5),
      mix: pick(CATEGORIES),
      library: next() < 0.5,
      generate: next() < 0.8,
      sceneReview: next() < 0.4,
    });
    trail.push(`start(${draft.avatarIds.length}av,${draft.videosPerAvatar}v,lib=${draft.library},gen=${draft.generate},review=${draft.sceneReview})`);
    // An avatar archived by an earlier step is not a saved, active one: the estimate says so, and there is nothing to start.
    const estimated = await mock.client.request("autopilot.estimate", { draft });
    if (!estimated.ok) {
      if (estimated.error.code !== "NOT_FOUND") fail(`the estimate was refused as ${estimated.error.code}`);
      return;
    }
    const { preview } = estimated.result;
    await mock.client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: next() < 0.9 ? preview.estimate.worstMicros : preview.estimate.worstMicros - 1 });
  }

  const OPS: readonly [number, string, () => Promise<void>][] = [
    [8, "tick", async () => void mock.scheduler.next()],
    [6, "ticks", async () => void [1, 2, 3, 4, 5].forEach(() => mock.scheduler.next())],
    [2, "runAll", async () => mock.scheduler.runAll(40)],
    [3, "pause", async () => void (await ctl("autopilot.pause"))],
    [4, "resume", async () => void (await ctl("autopilot.resume"))],
    [1, "resume-short", async () => void (await ctl("autopilot.resume", -1))],
    [2, "stop", async () => void (await ctl("autopilot.stop"))],
    [4, "review", async () => review()],
    // A fault is armed and the clock runs until the launch meets it (a hold stands) or a few ticks pass, so the hold it raises is what the check below reads.
    [5, "fault", async () => armAndMeet()],
    [1, "three-drops", async () => armAndMeet("network", 3, 14)],
    [2, "budget-low", async () => void (await mock.client.request("settings.setBudget", { monthlyBudgetMicros: pick([0, 20_000, 100_000]) }))],
    [3, "budget-high", async () => void (await mock.client.request("settings.setBudget", { monthlyBudgetMicros: 10_000_000 }))],
    [1, "key-clear", async () => void (await mock.client.request("settings.clearApiKey", {}))],
    [2, "key-set", async () => void (await mock.client.request("settings.setApiKey", { key: "sk-or-v1-abcdef0123456789-test" }))],
    [2, "restart", async () => mock.engine.restart()],
    [1, "quit", async () => mock.engine.quitLaunch()],
    [4, "reconcile", async () => void (await mock.client.request("money.reconcile", {}))],
    [1, "halt", async () => mock.engine.haltAboveWorst()],
    [1, "require-reconcile", async () => mock.engine.requireReconcile(["open-reserves"])],
    [2, "export-away", async () => mock.engine.setExportDisk({ status: "unavailable", reason: "missing" })],
    [2, "export-back", async () => mock.engine.setExportDisk({ status: "ok" })],
    [1, "disk-low", async () => mock.engine.setExportFreeBytes(1_000_000)],
    [1, "disk-free", async () => mock.engine.setExportFreeBytes(null)],
    [1, "busy-on", async () => mock.engine.setAvatarBusy(pick([MIA.avatarId, SOFIA.avatarId]), true)],
    [2, "busy-off", async () => void [MIA.avatarId, SOFIA.avatarId].forEach((id) => mock.engine.setAvatarBusy(id, false))],
    [1, "open-set", async () => mock.engine.seedSceneSet({ avatarId: pick([MIA.avatarId, SOFIA.avatarId]), sceneSetId: `set-fuzz-${++sets}`, count: 3 })],
    [2, "open-set-closed", async () => (sets > 0 ? mock.engine.markSceneSetUsed(`set-fuzz-${sets}`) : undefined)],
    [1, "library-lost", async () => mock.engine.loseLaunchLibrary(true)],
    [2, "library-back", async () => mock.engine.loseLaunchLibrary(false)],
    [1, "music-hold", async () => mock.engine.holdLaunchMusic(true)],
    [2, "music-release", async () => mock.engine.holdLaunchMusic(false)],
    [1, "tracks", async () => mock.engine.seedMusicTracks([track(1), track(2)])],
    [1, "archive", async () => void (await mock.client.request("avatars.archive", { avatarId: pick([MIA.avatarId, SOFIA.avatarId]) }))],
    [3, "start", async () => start()],
  ];
  const total = OPS.reduce((sum, [weight]) => sum + weight, 0);

  async function ctl(type: "autopilot.pause" | "autopilot.resume" | "autopilot.stop", offset = 0): Promise<void> {
    const id = await latest();
    if (id === null) return;
    const view = (await unwrap(mock.client.request("autopilot.get", { launchId: id }))).launch;
    if (type === "autopilot.resume") await mock.client.request(type, { launchId: id, acceptedRemainingMicros: Math.max(0, view.remainingMicros + offset) });
    else await mock.client.request(type, { launchId: id });
  }

  // The draws are over the faults the seeds were written for (a longer list would move every draw of every seed); S4.6r's `job-failed` takes every second turn of `internal`, so the launch's own
  // check is still met first and the failed job is met too, with no draw of its own.
  let internals = 0;
  async function armAndMeet(fault = pick(DRAWN_FAULTS), times = pick([1, 1, 2, 3]), ticks = 4): Promise<void> {
    mock.engine.failLaunchPaidStep(fault === "internal" && internals++ % 2 === 1 ? "job-failed" : fault, times);
    for (let i = 0; i < ticks; i++) {
      if (!mock.scheduler.next()) return;
      const id = await latest();
      if (id === null) return;
      const hold = (await unwrap(mock.client.request("autopilot.get", { launchId: id }))).launch.paidHold;
      // A waiting hold (a retry to come) is met by the next tick of the clock; stop at the first hold that waits for a person, or at the first hold when one is all that was asked.
      if (hold !== null && (times < 3 || ((hold.reason === "network" || hold.reason === "price-unavailable") && hold.detail.nextAt === null))) return;
    }
  }

  async function review(): Promise<void> {
    const id = await latest();
    if (id === null) return;
    const view = (await unwrap(mock.client.request("autopilot.get", { launchId: id }))).launch;
    const row = view.avatars.find((a) => a.phase === "awaiting-review");
    if (row?.sceneSetId == null || row.setRevision == null) return;
    await mock.client.request("autopilot.continueAfterReview", { launchId: id, avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision });
  }

  await start();
  await check();
  for (let step = 0; step < steps; step++) {
    let roll = next() * total;
    let chosen = OPS[0];
    for (const op of OPS) {
      roll -= op[0];
      if (roll < 0) {
        chosen = op;
        break;
      }
    }
    if (chosen === undefined) continue;
    trail.push(chosen[1]);
    await chosen[2]();
    await check();
  }
}

describe("fuzz: the mock's view meets the contract in every state it reaches", () => {
  const SEEDS = Array.from({ length: 80 }, (_, i) => 1_000 + i * 37);
  for (const seed of SEEDS) {
    test(`seed ${seed}`, async () => {
      await fuzzOne(seed, 60);
    });
  }

  test("the runs between them reached every status, hold, wait, phase and reason the mock claims to reach", () => {
    expect([...seen.statuses].sort()).toEqual([...LAUNCH_STATUSES].sort());
    expect([...seen.holds].sort()).toEqual([...PAID_HOLD_REASONS].sort());
    expect([...seen.waits].sort()).toEqual([...WaitingReason.options].sort());
    expect([...seen.phases].sort()).toEqual([...AVATAR_PHASES].sort());
    expect([...seen.blockedBy].sort()).toEqual(["budget", "halt", "internal", "key", "network", "reconcile-required"].sort());
    expect(seen.freeHolds.has("missing")).toBe(true);
    expect(seen.freeHolds.has("not-enough-space")).toBe(true);
    expect(seen.waitingMusic).toBe(true);
    expect(seen.unsettled).toBe(true);
    expect(seen.inFlight).toBe(true);
    expect([...seen.pausedCauses].sort()).toEqual(["engine-restart", "owner", "quit"]);
    expect(seen.skipped).toBe(true);
    expect(seen.dropReasons.has("launch-stopped")).toBe(true);
  });
});
