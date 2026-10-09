import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LaunchPreview, LaunchView, type LaunchDraftInput } from "../shared/engine";
import { EngineReply } from "./control";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import { FakeSteps } from "./autopilot/testing/fakeSteps";
import { command, engineSettings, failed, GOOD, ledgerLines, ok, startEngine, TRAITS, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a: the orchestrator core in the real engine, over a real library, ledger and launch store in a temp dir. The commands (estimate, start, pause, resume, stop, list,
// get, removeUnreadable), the launch file before any paid call, the ledger left alone, restart reading a running launch as paused, the single admission rule against the
// engine's own Budget, the library-switch check, the avatar rule, the snapshot and the events. The steps are a double: nothing is composed, drawn or rendered here.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-autopilot-core-");
const libraryDir = () => join(dir(), "library");
const autopilotDir = (library = libraryDir()) => join(library, "autopilot");

let seeded = 0;
async function seedAvatar(name: string, activate = true): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name, age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  if (activate) {
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  }
  return avatar.id;
}

const settingsOf = (avatarIds: string[], over: Partial<LaunchDraftInput> = {}): LaunchDraftInput => ({
  avatarIds,
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

type Started = Awaited<ReturnType<typeof startEngine>>;

async function startOver(opts: { key?: string | null; budget?: number; steps?: FakeSteps; exportFolder?: boolean } = {}): Promise<Started> {
  // The «Готовые видео» folder must be there, or the engine refuses a launch that makes videos (EXPORT_UNAVAILABLE).
  if (opts.exportFolder !== false) await mkdir(join(dir(), "export"), { recursive: true });
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: opts.budget ?? 10_000_000 }) },
    ...(opts.key === undefined ? {} : { key: opts.key }),
    ...(opts.steps === undefined ? {} : { deps: { launchSteps: opts.steps } }),
  });
}

async function previewOf(started: Started, draft: LaunchDraftInput): Promise<LaunchPreview> {
  const answer = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
  if (answer.type !== "autopilot.estimate") throw new Error("not an estimate");
  return answer.result.preview;
}

async function startLaunch(started: Started, draft: LaunchDraftInput, accepted?: number): Promise<LaunchView> {
  const preview = await previewOf(started, draft);
  const answer = ok(await started.engine.handle(command("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: accepted ?? preview.estimate.worstMicros })));
  if (answer.type !== "autopilot.start") throw new Error("not a start");
  return answer.result.launch;
}

async function launchCommand(started: Started, type: "autopilot.pause" | "autopilot.stop", launchId: string): Promise<LaunchView> {
  const answer = ok(await started.engine.handle(command(type, { launchId })));
  if (answer.type !== type) throw new Error("wrong answer");
  return answer.result.launch;
}

async function resume(started: Started, launchId: string, accepted: number): Promise<LaunchView> {
  const answer = ok(await started.engine.handle(command("autopilot.resume", { launchId, acceptedRemainingMicros: accepted })));
  if (answer.type !== "autopilot.resume") throw new Error("wrong answer");
  return answer.result.launch;
}

async function snapshotLaunch(started: Started): Promise<LaunchView | null> {
  const answer = ok(await started.engine.handle(command("engine.snapshot")));
  if (answer.type !== "engine.snapshot") throw new Error("not a snapshot");
  return answer.result.autopilot ?? null;
}

const launchFiles = (): string[] => (existsSync(autopilotDir()) ? readdirSync(autopilotDir()).filter((n) => n.endsWith(".json")) : []);
const readLaunch = (launchId: string) => JSON.parse(readFileSync(join(autopilotDir(), `${launchId}.json`), "utf8")) as { status: string; paused: { cause: string } | null; avatars: { generation: { sceneSetId: string; setRunId: string } | null }[] };

// ---------- autopilot.estimate ----------

describe("autopilot.estimate", () => {
  test("answers the plan with the engine's own figures, free: no ledger line, no launch file, no event", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const before = started.events().length;
    const preview = await previewOf(started, settingsOf([avatarId]));
    expect(LaunchPreview.safeParse(preview).success).toBe(true);
    expect(preview.totals).toEqual({ videos: 4, photosNeeded: 10, fromLibrary: 0, toGenerate: 10 });
    expect(preview.avatars[0]).toMatchObject({ avatarId, videos: 4, free: 0, toGenerate: 10, blocked: null, busy: false });
    expect(preview.estimate.worstMicros).toBeGreaterThan(preview.estimate.expectedMicros);
    expect(preview.estimate.expectedMicros).toBeGreaterThan(0);
    expect(preview.estimate.prices).toBe("fallback");
    expect(preview.month).toMatchObject({ budgetMicros: 10_000_000, committedMicros: 0, freeMicros: 10_000_000, fit: "fits" });
    expect(preview.balance).toBeNull();
    expect(preview.blockers).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
    expect(launchFiles()).toEqual([]);
    expect(started.events().length).toBe(before);
  });

  test("draws a plan seed when the draft has none, and keeps the one it is given", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const drawn = await previewOf(started, settingsOf([avatarId]));
    expect(Number.isInteger(drawn.planSeed) && drawn.planSeed >= 0 && drawn.planSeed <= 4_294_967_295).toBe(true);
    const answer = ok(await started.engine.handle(command("autopilot.estimate", { draft: { ...settingsOf([avatarId]), planSeed: 4_242 } })));
    expect(answer.type === "autopilot.estimate" && answer.result.preview.planSeed).toBe(4_242);
  });

  test("the same draft and seed plan the same videos and price them the same", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const draft = { ...settingsOf([avatarId]), planSeed: 99 };
    const one = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
    const two = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
    if (one.type !== "autopilot.estimate" || two.type !== "autopilot.estimate") throw new Error("not an estimate");
    expect(two.result.preview.estimate).toEqual(one.result.preview.estimate);
    expect(two.result.preview.avatars).toEqual(one.result.preview.avatars);
  });

  test("an avatar that is not saved and active is NOT_FOUND", async () => {
    const draftId = await seedAvatar("Draft", false);
    const started = await startOver();
    expect(failed(await started.engine.handle(command("autopilot.estimate", { draft: settingsOf([draftId]) }))).error.code).toBe("NOT_FOUND");
    expect(failed(await started.engine.handle(command("autopilot.estimate", { draft: settingsOf(["avatar-nobody-0404"]) }))).error.code).toBe("NOT_FOUND");
  });

  test("names what blocks the launch as an answer, not an error: no key, nothing enabled, a launch already running", async () => {
    const avatarId = await seedAvatar("Mia");
    const keyless = await startOver({ key: null });
    expect((await previewOf(keyless, settingsOf([avatarId]))).blockers).toContainEqual({ code: "no-key" });
    expect((await previewOf(keyless, settingsOf([avatarId], { library: false, generate: false }))).blockers).toContainEqual({ code: "nothing-enabled" });
    const started = await startOver();
    await startLaunch(started, settingsOf([avatarId]));
    expect((await previewOf(started, settingsOf([avatarId]))).blockers).toContainEqual({ code: "launch-active" });
  });

  test("an avatar with an open scene set of the owner's own is blocked for a plan that needs new photos", async () => {
    const avatarId = await seedAvatar("Mia");
    const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
    await library.sceneSets.create(sampleSet({ sceneSetId: "set-owner-0001", runId: "run-owner-0001", avatarId, count: 3, written: 3 }));
    const started = await startOver();
    const preview = await previewOf(started, settingsOf([avatarId]));
    expect(preview.avatars[0]?.blocked).toBe("open-set");
    expect(preview.blockers).toContainEqual({ code: "open-set", avatarId });
  });

  test("an unreadable launch entry is a blocker of the whole launch", async () => {
    const avatarId = await seedAvatar("Mia");
    await mkdir(autopilotDir(), { recursive: true });
    await writeFile(join(autopilotDir(), "launch-broken-0001.json"), "{not json");
    const started = await startOver();
    expect((await previewOf(started, settingsOf([avatarId]))).blockers).toContainEqual({ code: "launch-unreadable" });
  });
});

// ---------- autopilot.start ----------

describe("autopilot.start", () => {
  test("writes the launch file with its ids and allocations, registers the Budget group, begins the steps, and touches the ledger not at all (A1, A4)", async () => {
    const avatarId = await seedAvatar("Mia");
    const steps = new FakeSteps();
    const started = await startOver({ steps });
    const launch = await startLaunch(started, settingsOf([avatarId]));
    expect(LaunchView.safeParse(launch).success).toBe(true);
    expect(launch).toMatchObject({ status: "running", spentMicros: 0, remainingMicros: launch.plannedWorstMicros });
    expect(launchFiles()).toEqual([`${launch.launchId}.json`]);
    const file = readLaunch(launch.launchId);
    expect(file.status).toBe("running");
    const generation = file.avatars[0]?.generation;
    expect(generation?.sceneSetId).toBeDefined();
    expect(started.engine.launchGroups.groupOf({ attemptId: `${generation?.sceneSetId}:writer-1#1`, scope: { runId: "x" } })?.capMicros).toBe(launch.plannedWorstMicros);
    expect(steps.calls).toEqual(["begin"]);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("the plan seed of the preview makes the start plan the very videos the preview showed", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const preview = await previewOf(started, settingsOf([avatarId]));
    const launch = await startLaunch(started, settingsOf([avatarId]));
    expect(launch.plan).toEqual({ videos: preview.totals.videos, photos: preview.totals.photosNeeded, fromLibrary: preview.totals.fromLibrary, toGenerate: preview.totals.toGenerate });
    expect(launch.plannedWorstMicros).toBe(preview.estimate.worstMicros);
    expect(launch.plannedExpectedMicros).toBe(preview.estimate.expectedMicros);
  });

  test("accepts exactly W′ and refuses W′ - 1 with PRICE_CHANGED, before anything is written", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const preview = await previewOf(started, settingsOf([avatarId]));
    const draft = { ...settingsOf([avatarId]), planSeed: preview.planSeed };
    const before = started.events().length;
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: preview.estimate.worstMicros - 1 }))).error.code).toBe("PRICE_CHANGED");
    expect(launchFiles()).toEqual([]);
    expect(started.events().length).toBe(before);
    expect(ok(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: preview.estimate.worstMicros }))).type).toBe("autopilot.start");
  });

  test("a launch is unfinished until it ends: a second start is IN_FLIGHT (A12)", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    await startLaunch(started, settingsOf([avatarId]));
    const draft = { ...settingsOf([avatarId]), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error.code).toBe("IN_FLIGHT");
    expect(launchFiles()).toHaveLength(1);
  });

  test("a month that cannot hold even the expected cost is BUDGET_EXCEEDED, and nothing is written", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver({ budget: 1_000 });
    const draft = { ...settingsOf([avatarId]), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error.code).toBe("BUDGET_EXCEEDED");
    expect(launchFiles()).toEqual([]);
  });

  test("without a key a launch that generates is AUTH_INVALID; with a ledger that needs a reconcile it is RECONCILE_REQUIRED; neither writes a file", async () => {
    const avatarId = await seedAvatar("Mia");
    const keyless = await startOver({ key: null });
    const draft = { ...settingsOf([avatarId]), planSeed: 5 };
    expect(failed(await keyless.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error.code).toBe("AUTH_INVALID");
    await writeLedger(dir(), [{ type: "reserve", attemptId: "old#1", jobId: "job-old-0001", scope: { runId: "run-old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1_000, at: "2026-10-09T09:00:00.000Z" }]);
    const dirty = await startOver();
    expect(failed(await dirty.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error.code).toBe("RECONCILE_REQUIRED");
    expect(launchFiles()).toEqual([]);
  });

  test("a launch that makes videos is EXPORT_UNAVAILABLE while the export folder is not there, and the card says so; nothing is written", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver({ exportFolder: false });
    expect((await previewOf(started, settingsOf([avatarId]))).blockers).toContainEqual({ code: "export-unavailable" });
    const draft = { ...settingsOf([avatarId]), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    expect(launchFiles()).toEqual([]);
  });

  test("a draft with the library and the generation both off is VALIDATION nothing-enabled", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const draft = { ...settingsOf([avatarId], { library: false, generate: false }), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error).toMatchObject({ code: "VALIDATION", launchReason: "nothing-enabled" });
  });

  test("an avatar with an open scene set is VALIDATION open-set", async () => {
    const avatarId = await seedAvatar("Mia");
    const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
    await library.sceneSets.create(sampleSet({ sceneSetId: "set-owner-0001", runId: "run-owner-0001", avatarId, count: 3, written: 3 }));
    const started = await startOver();
    const draft = { ...settingsOf([avatarId]), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error).toMatchObject({ code: "VALIDATION", launchReason: "open-set" });
  });

  test("an unreadable launch entry blocks the start until it is removed (M7)", async () => {
    const avatarId = await seedAvatar("Mia");
    await mkdir(autopilotDir(), { recursive: true });
    await writeFile(join(autopilotDir(), "launch-broken-0001.json"), "{not json");
    const started = await startOver();
    const draft = { ...settingsOf([avatarId]), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error).toMatchObject({ code: "VALIDATION", launchReason: "launch-unreadable" });
  });

  test("an unknown avatar is NOT_FOUND", async () => {
    const started = await startOver();
    const draft = { ...settingsOf(["avatar-nobody-0404"]), planSeed: 5 };
    expect(failed(await started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 10_000_000 }))).error.code).toBe("NOT_FOUND");
  });
});

// ---------- the snapshot and the events ----------

describe("the snapshot and autopilot.changed", () => {
  test("the snapshot carries the unfinished launch, and none once it ends", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    expect(await snapshotLaunch(started)).toBeNull();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    expect(await snapshotLaunch(started)).toEqual(launch);
    await launchCommand(started, "autopilot.stop", launch.launchId);
    expect(await snapshotLaunch(started)).toBeNull();
  });

  test("every change is announced as the launch, whole, and the last announcement is the latest state", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    await launchCommand(started, "autopilot.pause", launch.launchId);
    await started.engine.settled();
    const changed = started.events().filter((e) => e.type === "autopilot.changed");
    expect(changed.length).toBeGreaterThanOrEqual(2);
    for (const event of changed) if (event.type === "autopilot.changed") expect(LaunchView.safeParse(event.payload.launch).success).toBe(true);
    const last = changed.at(-1);
    expect(last?.type === "autopilot.changed" && last.payload.launch.status).toBe("paused");
  });

  test("the announcements are coalesced: a burst of changes is not a burst of events", async () => {
    const avatarId = await seedAvatar("Mia");
    const steps = new FakeSteps();
    const started = await startOver({ steps });
    await startLaunch(started, settingsOf([avatarId]));
    await started.engine.settled();
    const before = started.events().filter((e) => e.type === "autopilot.changed").length;
    const t0 = Date.now();
    for (let n = 1; n <= 30; n++) await steps.ctx.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, photosDone: Math.min(n, 10) })) }));
    const elapsedMs = Date.now() - t0;
    const burst = started.events().filter((e) => e.type === "autopilot.changed").length - before;
    // At most four a second, however slow the disk: the announcements that fit in the time the burst took, and one more for the interval it began in.
    expect(burst).toBeLessThanOrEqual(Math.ceil(elapsedMs / 250) + 1);
    expect(burst).toBeLessThan(30);
    await started.engine.settled();
    const last = started.events().filter((e) => e.type === "autopilot.changed").at(-1);
    expect(last?.type === "autopilot.changed" && last.payload.launch.avatars[0]?.photos.done).toBe(10);
  });
});

// ---------- pause, resume, stop, list, get ----------

describe("pause, resume and stop through the engine", () => {
  test("a pause is paused by the owner and costs nothing; «Продолжить · до $R» runs it again; «Стоп» ends it and frees the library for a new launch", async () => {
    const avatarId = await seedAvatar("Mia");
    const steps = new FakeSteps();
    const started = await startOver({ steps });
    const launch = await startLaunch(started, settingsOf([avatarId]));
    const paused = await launchCommand(started, "autopilot.pause", launch.launchId);
    expect(paused).toMatchObject({ status: "paused", paused: { cause: "owner" } });
    const resumed = await resume(started, launch.launchId, paused.remainingMicros);
    expect(resumed.status).toBe("running");
    expect(steps.calls).toEqual(["begin", "drain", "begin"]);
    const stopped = await launchCommand(started, "autopilot.stop", launch.launchId);
    expect(stopped.status).toBe("stopped");
    expect((await startLaunch(started, settingsOf([avatarId]))).launchId).not.toBe(launch.launchId);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a click that the state refuses is VALIDATION, an unknown launch NOT_FOUND, and a short «до $R» PRICE_CHANGED", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    expect(failed(await started.engine.handle(command("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: 10_000_000 }))).error.code).toBe("VALIDATION");
    expect(failed(await started.engine.handle(command("autopilot.pause", { launchId: "launch-nobody0404" }))).error.code).toBe("NOT_FOUND");
    await launchCommand(started, "autopilot.pause", launch.launchId);
    expect(failed(await started.engine.handle(command("autopilot.pause", { launchId: launch.launchId }))).error.code).toBe("VALIDATION");
    expect(failed(await started.engine.handle(command("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: launch.remainingMicros - 1 }))).error.code).toBe("PRICE_CHANGED");
  });

  test("list and get answer the launch from its file, with the log", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    await launchCommand(started, "autopilot.pause", launch.launchId);
    const listed = ok(await started.engine.handle(command("autopilot.list")));
    expect(listed.type === "autopilot.list" && listed.result.launches.map((l) => [l.launchId, l.status])).toEqual([[launch.launchId, "paused"]]);
    const got = ok(await started.engine.handle(command("autopilot.get", { launchId: launch.launchId })));
    expect(got.type === "autopilot.get" && got.result.log.map((l) => l.kind)).toEqual(["start", "pausing", "paused"]);
    expect(failed(await started.engine.handle(command("autopilot.get", { launchId: "launch-nobody0404" }))).error.code).toBe("NOT_FOUND");
  });
});

// ---------- the single admission rule (A19) ----------

describe("the single admission rule, against the engine's own Budget (A19)", () => {
  test("an open reserve of THIS session does not block «Продолжить», although the UI's reconcile flag is on", async () => {
    const avatarId = await seedAvatar("Mia");
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    const paused = await launchCommand(started, "autopilot.pause", launch.launchId);
    const reserved = await started.engine.budget?.tryReserve({ attemptId: "manual#1", jobId: "job-manual-0001", scope: { runId: "run-manual-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });
    if (reserved === undefined || !reserved.ok) throw new Error("the reserve was refused");
    // A request that timed out: its reserve stays open at worst, abandoned by this process. The UI asks for a reconcile; the launch's admission rule does not.
    await started.engine.budget?.abandon(reserved.handle);
    const money = ok(await started.engine.handle(command("money.status")));
    expect(money.type === "money.status" && money.result.ledger === "open" && money.result.reconcileNeeded).toBe(true);
    expect((await snapshotLaunch(started))?.resumeBlockedBy).toBeNull();
    expect((await resume(started, launch.launchId, paused.remainingMicros)).status).toBe("running");
  });
});

// ---------- restart (A5) ----------

describe("a restart (A5)", () => {
  test("reads a running launch as paused «engine-restart», restores its Budget group, and begins nothing until «Продолжить»", async () => {
    const avatarId = await seedAvatar("Mia");
    const first = await startOver();
    const launch = await startLaunch(first, settingsOf([avatarId]));
    const setId = readLaunch(launch.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    const steps = new FakeSteps();
    const second = await startOver({ steps });
    await second.engine.settled();
    const view = await snapshotLaunch(second);
    expect(view).toMatchObject({ launchId: launch.launchId, status: "paused", paused: { cause: "engine-restart" } });
    expect(readLaunch(launch.launchId)).toMatchObject({ status: "paused", paused: { cause: "engine-restart" } });
    expect(second.engine.launchGroups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })?.key).toBe(`launch:${launch.launchId}`);
    expect(steps.calls).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
    expect((await resume(second, launch.launchId, launch.remainingMicros)).status).toBe("running");
    expect(steps.calls).toEqual(["begin"]);
  });

  test("a reserve a previous process left open blocks «Продолжить» with RECONCILE_REQUIRED, and the view says «сначала сверка»", async () => {
    const avatarId = await seedAvatar("Mia");
    const first = await startOver();
    const launch = await startLaunch(first, settingsOf([avatarId]));
    await writeLedger(dir(), [{ type: "reserve", attemptId: "old#1", jobId: "job-old-0001", scope: { runId: "run-old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1_000, at: "2026-10-09T09:00:00.000Z" }]);
    const steps = new FakeSteps();
    const second = await startOver({ steps });
    await second.engine.settled();
    expect((await snapshotLaunch(second))?.resumeBlockedBy).toBe("reconcile-required");
    expect(failed(await second.engine.handle(command("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: 10_000_000 }))).error.code).toBe("RECONCILE_REQUIRED");
    expect(steps.calls).toEqual([]);
  });

  test("a quit persists the pause as «quit»; the next start keeps that cause", async () => {
    const avatarId = await seedAvatar("Mia");
    const first = await startOver();
    const launch = await startLaunch(first, settingsOf([avatarId]));
    await first.engine.shutdown();
    expect(readLaunch(launch.launchId)).toMatchObject({ status: "paused", paused: { cause: "quit" } });
    const second = await startOver();
    await second.engine.settled();
    expect(await snapshotLaunch(second)).toMatchObject({ status: "paused", paused: { cause: "quit" } });
  });

  test("a launch file that cannot be read after the restart is listed by an opaque id, fails closed in the registry, and is removed only on request", async () => {
    const avatarId = await seedAvatar("Mia");
    const first = await startOver();
    const launch = await startLaunch(first, settingsOf([avatarId]));
    await writeFile(join(autopilotDir(), `${launch.launchId}.json`), "{torn");
    const second = await startOver();
    await second.engine.settled();
    expect(second.engine.launches.activeLaunch(launch.launchId)).toBe(launch.launchId);
    const listed = ok(await second.engine.handle(command("autopilot.list")));
    const entry = listed.type === "autopilot.list" ? listed.result.unreadable[0] : undefined;
    expect(entry?.entryId).toMatch(/^[0-9a-f]{16}$/);
    expect(failed(await second.engine.handle(command("autopilot.removeUnreadable", { entryId: "0123456789abcdef" }))).error.code).toBe("NOT_FOUND");
    expect(ok(await second.engine.handle(command("autopilot.removeUnreadable", { entryId: entry?.entryId ?? "" }))).type).toBe("autopilot.removeUnreadable");
    expect(existsSync(join(autopilotDir(), `${launch.launchId}.json`))).toBe(false);
    expect(second.engine.launches.activeLaunch(launch.launchId)).toBeUndefined();
  });
});

describe("restoring the Budget group from the sets' recorded slices (§19)", () => {
  test("a slice run that only the set's launchDraw names maps to the launch's group after a restart, before any paid command", async () => {
    const avatarId = await seedAvatar("Mia");
    const first = await startOver();
    const launch = await startLaunch(first, settingsOf([avatarId]));
    const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
    const base = sampleSet({ sceneSetId: "set-drawn-0001", runId: "run-slice-0001", avatarId, count: 6, written: 6 });
    await library.sceneSets.create({ ...base, launchId: launch.launchId, launchDraw: { launchId: launch.launchId, sceneIds: [1, 2, 3], slices: [{ runId: "run-slice-0001", sceneIds: [1, 2, 3], capMicros: 630_000 }] } });
    const second = await startOver();
    await second.engine.settled();
    expect(second.engine.launchGroups.groupOf({ attemptId: "slot-1#1", scope: { runId: "run-slice-0001" } })?.key).toBe(`launch:${launch.launchId}`);
    expect(second.engine.launchGroups.groupOf({ attemptId: "slot-1#1", scope: { runId: "run-manual-0001" } })).toBeNull();
  });
});

describe("the plan reads the library, and fails closed on what it cannot read", () => {
  async function seedFreePhoto(avatarId: string): Promise<void> {
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seedphoto${++seeded}`) });
    await library.addPhoto(avatarId, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" } }));
  }

  test("a free photo of a chosen category is taken from the library first, and the new photos are what is left", async () => {
    const avatarId = await seedAvatar("Mia");
    await seedFreePhoto(avatarId);
    const started = await startOver();
    const preview = await previewOf(started, settingsOf([avatarId], { library: true, videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } }));
    expect(preview.avatars[0]).toMatchObject({ free: 1, fromLibrary: 1, toGenerate: 1 });
  });

  test("a draft file the engine cannot read leaves it unable to say which photos drafts hold, so none is taken from the library", async () => {
    const avatarId = await seedAvatar("Mia");
    await seedFreePhoto(avatarId);
    await mkdir(join(libraryDir(), "avatars", avatarId, "montages"), { recursive: true });
    await writeFile(join(libraryDir(), "avatars", avatarId, "montages", "montage-broken-0001.json"), "{not json");
    const started = await startOver();
    const preview = await previewOf(started, settingsOf([avatarId], { library: true, videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } }));
    expect(preview.avatars[0]).toMatchObject({ free: 0, fromLibrary: 0, toGenerate: 2 });
  });
});

// ---------- the library-switch check (A12, §3.8) and the avatar rule ----------

describe("the library-switch check and the avatar rule", () => {
  let call = 0;
  const open = (path: string) => ({ kind: "control", type: "library.open", callId: `call-${String(++call).padStart(8, "0")}`, path });
  const confirm = (path: string) => ({ kind: "control", type: "library.confirm", callId: `call-${String(++call).padStart(8, "0")}`, path });
  const prepare = (avatarId: string, token = "token-00000001") => ({ kind: "control", type: "avatar.deletePrepare", callId: `call-${String(++call).padStart(8, "0")}`, avatarId, token });

  async function ask(started: Started, message: unknown): Promise<EngineReply> {
    await started.engine.receive(message);
    return EngineReply.parse(started.posted.at(-1));
  }

  async function otherLibrary(): Promise<string> {
    const path = join(dir(), "library2");
    await mkdir(path, { recursive: true });
    await openLibrary(path, { now: steppingClock(), newId: sequentialIds("other") });
    return path;
  }

  test("a running launch refuses a library switch even between two of its jobs, by an explicit check", async () => {
    const avatarId = await seedAvatar("Mia");
    const other = await otherLibrary();
    const started = await startOver();
    await startLaunch(started, settingsOf([avatarId]));
    // Nothing is in flight: no paid command, no busy avatar, no render. Only the launch says no.
    expect((await ask(started, open(other))).error?.code).toBe("IN_FLIGHT");
    expect(started.engine.library?.root).toBe(libraryDir());
  });

  test("a folder staged while the launch was paused cannot be confirmed once the launch runs again", async () => {
    const avatarId = await seedAvatar("Mia");
    const other = await otherLibrary();
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    const paused = await launchCommand(started, "autopilot.pause", launch.launchId);
    expect((await ask(started, open(other))).error).toBeUndefined();
    await resume(started, launch.launchId, paused.remainingMicros);
    expect((await ask(started, confirm(other))).error?.code).toBe("IN_FLIGHT");
    expect(started.engine.library?.root).toBe(libraryDir());
    expect(await snapshotLaunch(started)).toMatchObject({ launchId: launch.launchId, status: "running" });
  });

  test("a paused launch lets the library go: it stays with its folder and comes back with it", async () => {
    const avatarId = await seedAvatar("Mia");
    const other = await otherLibrary();
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    const setId = readLaunch(launch.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    await launchCommand(started, "autopilot.pause", launch.launchId);
    expect((await ask(started, open(other))).error).toBeUndefined();
    expect((await ask(started, confirm(other))).error).toBeUndefined();
    expect(await snapshotLaunch(started)).toBeNull();
    expect(started.engine.launchGroups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })).toBeNull();
    expect(existsSync(join(autopilotDir(), `${launch.launchId}.json`))).toBe(true);
    expect((await ask(started, open(libraryDir()))).error).toBeUndefined();
    expect((await ask(started, confirm(libraryDir()))).error).toBeUndefined();
    expect(await snapshotLaunch(started)).toMatchObject({ launchId: launch.launchId, status: "paused" });
    expect(started.engine.launchGroups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })?.key).toBe(`launch:${launch.launchId}`);
  });

  test("a switch issued while a start is under way is refused: the launch never ends up split between two libraries (M2)", async () => {
    const avatarId = await seedAvatar("Mia");
    const other = await otherLibrary();
    const started = await startOver();
    const preview = await previewOf(started, settingsOf([avatarId]));
    // Staged while nothing runs; confirmed in the same breath as the start.
    expect((await ask(started, open(other))).error).toBeUndefined();
    const draft = { ...settingsOf([avatarId]), planSeed: preview.planSeed };
    const start = started.engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: preview.estimate.worstMicros }));
    const switched = ask(started, confirm(other));
    expect((await switched).error?.code).toBe("IN_FLIGHT");
    expect(ok(await start).type).toBe("autopilot.start");
    expect(started.engine.library?.root).toBe(libraryDir());
    expect(await snapshotLaunch(started)).toMatchObject({ status: "running" });
    expect(launchFiles()).toHaveLength(1);
  });

  test("a stopped launch does not hold the library", async () => {
    const avatarId = await seedAvatar("Mia");
    const other = await otherLibrary();
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    await launchCommand(started, "autopilot.stop", launch.launchId);
    expect((await ask(started, open(other))).error).toBeUndefined();
  });

  test("an avatar of an unfinished launch cannot be deleted, paused or not; when the launch ends it can", async () => {
    const avatarId = await seedAvatar("Mia");
    const spare = await seedAvatar("Sofia");
    const started = await startOver();
    const launch = await startLaunch(started, settingsOf([avatarId]));
    const refused = await ask(started, prepare(avatarId));
    expect(refused.error?.code).toBe("IN_FLIGHT");
    expect(refused.error?.detail).toContain("autopilot");
    await launchCommand(started, "autopilot.pause", launch.launchId);
    expect((await ask(started, prepare(avatarId))).error?.code).toBe("IN_FLIGHT");
    // An avatar the launch does not have is unaffected.
    expect((await ask(started, prepare(spare, "token-00000002"))).error).toBeUndefined();
    await started.engine.receive({ kind: "control", type: "avatar.deleteFinish", callId: `call-${String(++call).padStart(8, "0")}`, avatarId: spare, token: "token-00000002", outcome: "kept" });
    await launchCommand(started, "autopilot.stop", launch.launchId);
    expect((await ask(started, prepare(avatarId, "token-00000003"))).error).toBeUndefined();
  });
});
