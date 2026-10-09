import type { Scenario } from "./scenarios";
import type { World } from "./rigs";
import type { Answer } from "./transcript";

// Stage 4, S4.8: the batch autopilot as a launch that RUNS, told through its commands and compared engine against mock, line for line. The real rig runs the engine as the app builds it (its
// default launch steps over a fake OpenRouter, the rig's fake ffmpeg and a track store) and the mock runs its launch on its clock; a story reads the launch only at the STABLE points it waits
// for (`Transcript.untilLaunch`), so a tick more or less cannot move a line. What a story writes is limited to what both engines are bound to say (transcript.ts `launchFacts`): not the prices,
// the clock, or how many requests a batch sends. The plan is all-generated (`library: false`): a generated video asks for the same photos from both planners (a single 1, a collage 3, slides 5),
// while the photos a LIBRARY video takes are drawn by the engine's planner from the seed and fixed in the mock (the S4.8 report names that difference).
//
// The five stories S4.1 left pending stay pending (scenarios.autopilot.ts): their transcripts say «drawing» and «awaiting-review» in the answer to the start, which a canned mock gives and no
// engine can (a phase is written by a pass that runs after the start has answered). These stories are their lifted equivalents on the real timeline, APPENDED.

const ENOUGH = 10_000_000;
const NOT_ENOUGH = 0;
const NO_LAUNCH = "launch-00000000";

/** The draft of these stories: Mia, two slides videos, every photo new. */
const draftOf = (w: World, over: Record<string, unknown> = {}) => ({
  avatarIds: [w.avatarId],
  videosPerAvatar: 2,
  mix: { single: 0, collage: 0, slides: 100 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
  planSeed: 4_242,
  ...over,
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

const launchOf = (answer: Answer): Record<string, unknown> | null => (answer.ok ? record(answer.result.launch) : null);
const launchIdOf = (answer: Answer): string => {
  const id = launchOf(answer)?.launchId;
  return typeof id === "string" ? id : NO_LAUNCH;
};

/** The row of a launch that waits for its review: its set and the revision the owner saw. */
function reviewRowOf(launch: Record<string, unknown>): { avatarId: string; sceneSetId: string; revision: number } | null {
  const rows = launch.avatars;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const r = record(row);
    if (r?.phase === "awaiting-review" && typeof r.avatarId === "string" && typeof r.sceneSetId === "string" && typeof r.setRevision === "number") return { avatarId: r.avatarId, sceneSetId: r.sceneSetId, revision: r.setRevision };
  }
  return null;
}

const phases = (launch: Record<string, unknown>): string[] => (Array.isArray(launch.avatars) ? launch.avatars.map((a) => String(record(a)?.phase)) : []);
const isDone = (launch: Record<string, unknown>): boolean => launch.status === "done";
const isAwaitingReview = (launch: Record<string, unknown>): boolean => phases(launch).includes("awaiting-review");
const holds = (reason: string) => (launch: Record<string, unknown>): boolean => record(launch.paidHold)?.reason === reason;

type Telling = Parameters<Scenario["run"]>[0];

/** Starts the launch and answers its id, and the row waiting for review when the story reviews. */
async function begin(t: Telling, w: World, over: Record<string, unknown> = {}): Promise<{ launch: string }> {
  const started = await t.callLaunch("autopilot.start", { draft: draftOf(w, over), acceptedWorstMicros: ENOUGH });
  return { launch: launchIdOf(started) };
}

/** Waits until an avatar's scenes wait for the owner, and answers the row the owner would press «Продолжить запуск» on. */
async function review(t: Telling, launch: string): Promise<{ avatarId: string; sceneSetId: string; revision: number }> {
  let row: { avatarId: string; sceneSetId: string; revision: number } | null = null;
  await t.untilLaunch(launch, "the scenes wait for the owner's review", (l) => {
    row = reviewRowOf(l);
    return row !== null;
  });
  if (row === null) throw new Error("the launch never reached its review");
  return row;
}

/**
 * `autopilot.continueAfterReview` for the row the story waited for. `stale` sends a revision the set has moved past; the transcript writes the revision as seen (`<seen>`) or one more
 * (`<seen+1>`), because the number is the set file's own count of writes.
 */
function proceed(t: Telling, launch: string, row: { avatarId: string; sceneSetId: string; revision: number }, over: { sceneSetId?: string; avatarId?: string; stale?: boolean } = {}, brief = false): Promise<Answer> {
  const sent = { launchId: launch, avatarId: over.avatarId ?? row.avatarId, sceneSetId: over.sceneSetId ?? row.sceneSetId, revision: row.revision + (over.stale === true ? 1 : 0) };
  return t.callLaunch("autopilot.continueAfterReview", sent, { brief, written: { ...sent, revision: over.stale === true ? "<seen+1>" : "<seen>" } });
}

export const LAUNCH_RUN_SCENARIOS: readonly Scenario[] = [
  {
    name: "autopilot (running): a launch with the review off composes, draws, montages and renders by itself and ends done; a launch that is done is over",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("the start answers at once: every avatar planned, nothing spent");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "done", isDone);
      t.note("the launch read at its end: its rows, its videos, its history line");
      await t.callLaunch("autopilot.get", { launchId: launch });
      await t.callLaunch("autopilot.list", {});
      t.note("a launch that is done cannot be paused, resumed or stopped, and does not block the next");
      await t.callLaunch("autopilot.pause", { launchId: launch });
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      await t.callLaunch("autopilot.stop", { launchId: launch });
      const next = await begin(t, w, { videosPerAvatar: 1 });
      await t.untilLaunch(next.launch, "the second launch done", isDone);
      await t.callLaunch("autopilot.list", {});
    },
  },
  {
    name: "autopilot (running): a start below the engine's worst case is PRICE_CHANGED and writes nothing, and one launch is unfinished at a time",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("an accepted worst case below the plan's: refused, nothing written");
      await t.callLaunch("autopilot.start", { draft: draftOf(w, { sceneReview: true }), acceptedWorstMicros: NOT_ENOUGH });
      await t.callLaunch("autopilot.list", {});
      t.note("one that covers it starts the launch");
      const { launch } = await begin(t, w, { sceneReview: true });
      await review(t, launch);
      t.note("a second launch while one is unfinished: refused, and the preview says a launch is active");
      await t.callLaunch("autopilot.start", { draft: draftOf(w, { sceneReview: true }), acceptedWorstMicros: ENOUGH });
      await t.callLaunch("autopilot.estimate", { draft: draftOf(w) });
      await t.callLaunch("autopilot.stop", { launchId: launch });
      t.note("once it is over the preview has no launch active");
      await t.callLaunch("autopilot.estimate", { draft: draftOf(w, { avatarIds: [w.otherAvatarId], library: true }) });
    },
  },
  {
    name: "autopilot (running): with the review on the scenes wait for the owner, a stale revision and a foreign set are refused, «Продолжить запуск» draws, and an approval is given once",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const { launch } = await begin(t, w, { sceneReview: true });
      const row = await review(t, launch);
      t.note("the launch while it waits: composed and paid for, nothing drawn, the avatar awaits its review");
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("a revision that moved, a set that is not the one waiting, an avatar that is not in the launch");
      await proceed(t, launch, row, { stale: true });
      await proceed(t, launch, row, { sceneSetId: "set-parity-9999" });
      await proceed(t, launch, row, { avatarId: w.otherAvatarId });
      t.note("the owner continues: the draw starts");
      await proceed(t, launch, row, {}, true);
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("an approval is given once");
      await proceed(t, launch, row);
    },
  },
  {
    name: "autopilot (running): a launch is paused where nothing is in flight, an approval during the pause is only recorded, and «Продолжить · до $R» takes a sum that covers R",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const { launch } = await begin(t, w, { sceneReview: true });
      const row = await review(t, launch);
      t.note("a launch that runs cannot be resumed");
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      t.note("pause: nothing is in flight, so it is paused at once; twice is refused");
      await t.callLaunch("autopilot.pause", { launchId: launch });
      await t.callLaunch("autopilot.pause", { launchId: launch });
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("while it is paused the approval is only recorded; «Продолжить» starts the draw");
      await proceed(t, launch, row);
      t.note("«Продолжить · до $R»: a sum below the remaining worst case is refused, one that covers it resumes");
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: NOT_ENOUGH });
      await t.callLaunch("autopilot.get", { launchId: launch });
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "autopilot (running): a stop ends the launch from its review wait and from a pause; what was not made is dropped, and a stopped launch is over",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const first = await begin(t, w, { sceneReview: true });
      const row = await review(t, first.launch);
      t.note("stop at the review: the scenes are the owner's again, the videos are dropped, what was paid stays spent");
      await t.callLaunch("autopilot.stop", { launchId: first.launch });
      await t.callLaunch("autopilot.get", { launchId: first.launch });
      t.note("a stopped launch is over: nothing moves it, and its review is not waiting");
      await t.callLaunch("autopilot.stop", { launchId: first.launch });
      await t.callLaunch("autopilot.pause", { launchId: first.launch });
      await t.callLaunch("autopilot.resume", { launchId: first.launch, acceptedRemainingMicros: ENOUGH });
      await proceed(t, first.launch, row);
      t.note("the composed set is the owner's own open set now: a plan that needs new photos for the avatar is refused until the owner discards it");
      await t.callLaunch("autopilot.start", { draft: draftOf(w, { sceneReview: true }), acceptedWorstMicros: ENOUGH });
      await t.callLaunch("scenes.discard", { sceneSetId: row.sceneSetId });
      t.note("stop from a pause");
      const second = await begin(t, w, { sceneReview: true });
      await review(t, second.launch);
      await t.callLaunch("autopilot.pause", { launchId: second.launch });
      await t.callLaunch("autopilot.stop", { launchId: second.launch });
      await t.callLaunch("autopilot.list", {});
    },
  },
  {
    name: "autopilot (running): OpenRouter's 402 holds the paid work for a person, «Продолжить» is open and clears the hold, and the launch ends done",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      control.launch.fault("credits");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "the credits hold", holds("credits"));
      t.note("held: the avatar is parked, nothing is spent, «Продолжить» is open");
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("the owner tops up and continues");
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("a launch that runs with no hold has nothing to continue");
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
    },
  },
  {
    name: "autopilot (running): OpenRouter's 401 holds the launch and closes «Продолжить» until a new key is stored, and then the launch ends done",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      control.launch.fault("key");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "the key hold", holds("key"));
      t.note("held, and «Продолжить» is closed by the key");
      await t.callLaunch("autopilot.get", { launchId: launch });
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      t.note("a new key opens it");
      await control.launch.newKey();
      await t.callLaunch("autopilot.get", { launchId: launch });
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "autopilot (running): a full disk holds the renders (a free hold), «Продолжить» is not asked for, and the launch goes on to done when the disk has room",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("the folder has no room for a video: the photos are bought and drawn, and the videos wait");
      control.freeSpace(1_000_000);
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "the disk hold", (l) => record(l.freeHold) !== null);
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("room again: the hold ends by itself");
      control.freeSpace(null);
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "autopilot (running): with no track stored the videos wait for music and the launch keeps running; a track that appears ends the wait",
    rig: { launch: true },
    async run(t, w, control) {
      t.note("nothing is stored: the photos are bought and drawn, and every video waits for a track");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "the videos wait for music", (l) => Number(l.waitingMusic) === 2);
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("a track is stored: the wait ends with no further event");
      await control.musicTracks();
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "autopilot (running): the app is quit with a request in flight; the launch is paused by the quit, «Продолжить» asks for a reconcile first, and after it the launch goes on to done",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      control.launch.hangWriter();
      const { launch } = await begin(t, w, { sceneReview: true });
      await t.untilLaunch(launch, "a request in flight", (l) => Number(record(l.inFlight)?.requests) > 0);
      t.note("the owner quits the app and opens it again");
      await control.launch.quit();
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("the request in flight died with the process: its reserve is open, so «Продолжить» waits for the reconcile");
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      t.note("the owner reconciles in Settings (the answer's figures are the ledger's own)");
      await t.quiet(async () => {
        await t.call("money.reconcile", {});
      });
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("a sum below the remaining worst case is refused; one that covers it resumes, and the scenes are composed again");
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: NOT_ENOUGH });
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      const row = await review(t, launch);
      await proceed(t, launch, row, {}, true);
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "autopilot (running): a slice job that ends INTERNAL holds the launch as «internal» (a failed job), «Продолжить» is open and runs the job again, and the launch ends done",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("the avatar's master photo cannot be prepared: the compose is paid, and the slice's job ends INTERNAL before any photo is requested");
      control.launch.fault("job-failed");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "the internal hold", holds("internal"));
      t.note("held, with «Продолжить» open: the hold is a failed job, not the launch's own check");
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("the master is whole again; the owner continues and the job runs again");
      await control.launch.repairMaster();
      await t.callLaunch("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  // S4.6p (appended): the price of drawing photos, free. The figures are each engine's own (the transcript writes what both are bound to say), the photos and the refusals are the contract.
  {
    name: "autopilot (running): the price of drawing is free and told by the engine — a launch's photos still to draw, a count of an avatar's, and the refusals of a launch or an avatar that is not there",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const { launch } = await begin(t, w, { sceneReview: true });
      const row = await review(t, launch);
      t.note("the scenes wait for the owner: the photos «Продолжить запуск» would draw, the same as the price of that many photos of the avatar");
      const byLaunch = await t.callLaunch("runs.estimateImages", { launchId: launch, avatarId: row.avatarId });
      const photos = byLaunch.ok && typeof byLaunch.result.photos === "number" ? byLaunch.result.photos : 0;
      const byCount = await t.callLaunch("runs.estimateImages", { avatarId: row.avatarId, count: photos });
      // The figures are each engine's own, but within one engine the launch's price of N photos must be the avatar's price of N photos: the transcript says whether it is.
      const figure = (answer: Answer): string => (answer.ok ? JSON.stringify([record(answer.result.estimate)?.expectedMicros, record(answer.result.estimate)?.worstMicros]) : "refused");
      t.note(`the launch's price is the price of that many photos of the avatar: ${String(figure(byLaunch) === figure(byCount))}`);
      t.note("an avatar the launch does not hold, and a launch there is not, are NOT_FOUND; so is an avatar the library does not have");
      await t.callLaunch("runs.estimateImages", { launchId: launch, avatarId: w.otherAvatarId });
      await t.callLaunch("runs.estimateImages", { launchId: NO_LAUNCH, avatarId: row.avatarId });
      await t.callLaunch("runs.estimateImages", { avatarId: "avatar-nobody-0404", count: 3 });
      t.note("once the launch is over it is no unfinished launch");
      await t.callLaunch("autopilot.stop", { launchId: launch });
      await t.callLaunch("runs.estimateImages", { launchId: launch, avatarId: row.avatarId });
    },
  },
];
