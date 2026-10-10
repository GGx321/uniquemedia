import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LaunchView, type LaunchDraftInput, type ResponseMessage } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { createPaidSteps } from "./autopilot/paidSteps";
import { IDLE_STEPS } from "./autopilot/steps";
import type { LaunchFile } from "./autopilot/launchFile";
import type { EngineDeps } from "./engine";
import { openLibrary } from "./library";
import type { StoredSceneSet } from "./library/sceneSets";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, fakeFetch, imageBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, failed, GOOD, ledgerLines, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir, writeLedger, NOW } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b1 (plan §3.4, §3.6, §4.3, §4.7; invariants A1, A2, A3, A4, A16): the orchestrator's PAID path in the real engine, over a real library, ledger, launch store and Budget
// group, with a fake OpenRouter (nothing reaches the network). A launch composes a set under the ids it issued before the call, waits for the owner's review or approves at once,
// and draws the approved scenes in slices. A kill is simulated the way S4.5a's tests do: the engine is shut down and a new one opens the same folders, then «Продолжить».

setDefaultTimeout(45_000);

const dir = useEngineDir("studio-engine-autopilot-paid-");
const libraryDir = () => join(dir(), "library");
const launchPath = (launchId: string) => join(libraryDir(), "autopilot", `${launchId}.json`);

const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const FACE = [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }];

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

let seeded = 0;

async function seedAvatar(name = "Mia"): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name, age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

function isWriter(call: FetchCall): boolean {
  return call.url.endsWith("/chat/completions") && JSON.stringify(call.json().response_format ?? {}).includes("scene_sentences");
}

function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

const goodWriter: Handler = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) });
const goodImage: Handler = (_call, n) => ({ status: 200, body: imageBody(portraitPng(((n - 1) % 4) + 1), { cost: 0.04 }) });

/** A fake OpenRouter: the writer, the images and the credits answer from handlers; prices are offline (the fallback table). */
function network(opts: { writer?: Handler; image?: Handler } = {}) {
  let writes = 0;
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (isWriter(call)) return (opts.writer ?? goodWriter)(call, ++writes);
    if (call.url.endsWith("/images")) return (opts.image ?? goodImage)(call, ++images);
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return OFFLINE;
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    writerCalls: () => net.calls.filter(isWriter),
    priceCalls: () => net.calls.filter((c) => c.url.endsWith("/models") || c.url.endsWith("/endpoints")),
    paidCalls: () => net.calls.filter((c) => c.method === "POST"),
    ageCalls: () => [],
    descriptorCalls: () => [],
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const draftOf = (avatarIds: string[], over: Partial<LaunchDraftInput> = {}): LaunchDraftInput => ({
  avatarIds,
  videosPerAvatar: 3,
  mix: { single: 100, collage: 0, slides: 0 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...over,
});

type Started = Awaited<ReturnType<typeof boot>>;

/** An engine over the test folders with the paid steps plugged in. `steps: false` leaves the seam idle on purpose (`IDLE_STEPS`): a launch that only started. The engine's own default is the real steps now. */
async function boot(net: ReturnType<typeof network>, opts: { budget?: number; steps?: boolean; deps?: Partial<EngineDeps> } = {}) {
  await mkdir(join(dir(), "export"), { recursive: true });
  const holder: { engine: Started["engine"] | null } = { engine: null };
  const steps = createPaidSteps({
    port: () => {
      if (holder.engine === null) throw new Error("the engine is not started yet");
      return holder.engine;
    },
  });
  const started = await startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: opts.budget ?? 10_000_000 }) },
    net,
    deps: { qaGates: FACE, launchSteps: opts.steps === false ? IDLE_STEPS : steps, ...opts.deps },
  });
  holder.engine = started.engine;
  return started;
}

async function call(started: Started, type: string, payload: unknown): Promise<ResponseMessage> {
  return started.engine.handle(command(type, payload));
}

async function startLaunch(started: Started, draft: LaunchDraftInput, accepted?: number): Promise<LaunchView> {
  const estimate = ok(await call(started, "autopilot.estimate", { draft }));
  if (estimate.type !== "autopilot.estimate") throw new Error("not an estimate");
  const { preview } = estimate.result;
  const answer = ok(await call(started, "autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: accepted ?? preview.estimate.worstMicros }));
  if (answer.type !== "autopilot.start") throw new Error("not a start");
  return answer.result.launch;
}

async function launchCommand(started: Started, type: "autopilot.pause" | "autopilot.stop", launchId: string): Promise<LaunchView> {
  const answer = ok(await call(started, type, { launchId }));
  if (answer.type !== type) throw new Error("wrong answer");
  return answer.result.launch;
}

async function resume(started: Started, launch: LaunchView): Promise<LaunchView> {
  const answer = ok(await call(started, "autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: launch.remainingMicros }));
  if (answer.type !== "autopilot.resume") throw new Error("wrong answer");
  return answer.result.launch;
}

async function viewOf(started: Started, launchId: string): Promise<LaunchView> {
  const answer = ok(await call(started, "autopilot.get", { launchId }));
  if (answer.type !== "autopilot.get") throw new Error("wrong answer");
  return answer.result.launch;
}

const fileOf = (launchId: string): LaunchFile => JSON.parse(readFileSync(launchPath(launchId), "utf8")) as LaunchFile;
const phaseOf = (launchId: string, row = 0): string | undefined => fileOf(launchId).avatars[row]?.phase;
const generationOf = (launchId: string, row = 0): { sceneSetId: string; setRunId: string } => {
  const generation = fileOf(launchId).avatars[row]?.generation;
  if (generation === null || generation === undefined) throw new Error("the avatar does not generate");
  return generation;
};

async function setOf(started: Started, avatarId: string, sceneSetId: string): Promise<StoredSceneSet | null> {
  return (await started.engine.library?.sceneSets.get(avatarId, sceneSetId)) ?? null;
}

async function reachPhase(launchId: string, phase: string, row = 0): Promise<void> {
  await until(() => existsSync(launchPath(launchId)) && phaseOf(launchId, row) === phase, `phase ${phase}`, 30_000);
}

const reserves = (): string[] => ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));

/** The simulated kill: the engine ends its work gracefully (a launch that runs reads as paused) and the folders stay. */
async function kill(started: Started): Promise<void> {
  await started.engine.shutdown(2_000);
}

// ---------- review OFF ----------

describe("review OFF: compose, approve at once, draw", () => {
  test("composes the set under the ids the launch issued, approves it, draws it in a slice under the set's run id, and rests at montage (A1, A4)", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const started = await boot(net);
    expect(ledgerLines(dir())).toEqual([]);
    const launch = await startLaunch(started, draftOf([avatarId]));
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    await reachPhase(launch.launchId, "montage");

    const set = await setOf(started, avatarId, sceneSetId);
    expect(set).toMatchObject({ sceneSetId, runId: setRunId, launchId: launch.launchId });
    expect(set?.launchDraw?.sceneIds).toHaveLength(3);
    expect(set?.launchDraw?.slices.map((s) => s.runId)).toEqual([setRunId]);
    expect(net.writerCalls()).toHaveLength(1);
    expect(net.imageCalls()).toHaveLength(3);
    expect(fileOf(launch.launchId).avatars[0]?.photosDone).toBe(3);
    expect(new Set(reserves()).size).toBe(reserves().length);
    expect(reserves().filter((id) => id.startsWith(`${sceneSetId}:writer-`))).toEqual([`${sceneSetId}:writer-1#1`]);
  });

  test("the whole launch stays within W′ through the real Budget group, and its writer attempts and slice run are in that group (A2)", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId]));
    await reachPhase(launch.launchId, "montage");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const groups = started.engine.launchGroups;
    expect(groups.groupOf({ attemptId: `${sceneSetId}:writer-1#1`, scope: { avatarJobId: "job-x" } })?.capMicros).toBe(launch.plannedWorstMicros);
    expect(groups.groupOf({ attemptId: "any-attempt#1", scope: { runId: setRunId } })?.capMicros).toBe(launch.plannedWorstMicros);
    const committed = started.engine.budget?.committedOfGroup(`launch:${launch.launchId}`) ?? Number.NaN;
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThanOrEqual(launch.plannedWorstMicros);
    const view = await viewOf(started, launch.launchId);
    expect(view.spentMicros).toBe(committed);
  });

  test("a start below the recomputed W′ is PRICE_CHANGED and nothing is written or sent (A1)", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const started = await boot(net);
    const draft = draftOf([avatarId]);
    const estimate = ok(await call(started, "autopilot.estimate", { draft }));
    if (estimate.type !== "autopilot.estimate") throw new Error("not an estimate");
    const refused = failed(await call(started, "autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros - 1 }));
    expect(refused.error.code).toBe("PRICE_CHANGED");
    expect(ledgerLines(dir())).toEqual([]);
    expect(net.paidCalls()).toEqual([]);
    expect(existsSync(join(libraryDir(), "autopilot"))).toBe(false);
  });

  test("a library-only launch (Σn = 0) reads no price, makes no set, and spends zero", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId], { library: true, generate: false }));
    expect(launch.plannedWorstMicros).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(net.priceCalls()).toEqual([]);
    expect(net.paidCalls()).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
    expect(fileOf(launch.launchId).avatars[0]?.generation).toBeNull();
    expect((await viewOf(started, launch.launchId)).spentMicros).toBe(0);
  });
});

// ---------- review ON ----------

describe("review ON: compose, wait for the owner, continue", () => {
  async function composedAndWaiting(opts: { net?: ReturnType<typeof network> } = {}) {
    const avatarId = await seedAvatar();
    const net = opts.net ?? network();
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId } = generationOf(launch.launchId);
    return { avatarId, net, started, launch, sceneSetId };
  }

  test("the avatar waits in awaiting-review with the set written and nothing drawn, and the view names the set, its revision and the photos «Продолжить» would draw", async () => {
    const { avatarId, net, started, launch, sceneSetId } = await composedAndWaiting();
    const set = await setOf(started, avatarId, sceneSetId);
    expect(set?.launchDraw).toBeUndefined();
    expect(set?.scenes.every((s) => s.text !== null)).toBe(true);
    expect(net.imageCalls()).toEqual([]);
    const row = (await viewOf(started, launch.launchId)).avatars[0];
    expect(row).toMatchObject({ phase: "awaiting-review", sceneSetId, setRevision: set?.revision, scenes: 3, scenesWithoutText: 0, continuePhotos: 3 });
  });

  test("the owner's review writes are not the launch's: their attempt ids are outside its Budget group, and a manual «Дописать» on its set is still refused (A16)", async () => {
    const { avatarId, started, launch, sceneSetId } = await composedAndWaiting();
    const groups = started.engine.launchGroups;
    expect(groups.groupOf({ attemptId: `${sceneSetId}:writer-1#2`, scope: { avatarJobId: "job-x" } })?.key).toBe(`launch:${launch.launchId}`);
    expect(groups.groupOf({ attemptId: `${sceneSetId}:write-1#1`, scope: { avatarJobId: "job-x" } })).toBeNull();
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    const refused = failed(await call(started, "scenes.write", { sceneSetId, revision, target: { kind: "unwritten" }, acceptedWorstMicros: 1_000_000 }));
    expect(refused.error).toMatchObject({ code: "VALIDATION", sceneReason: "launch-set" });
  });

  test("«Продолжить запуск» approves the set and draws it: the answer says the draw started (A16)", async () => {
    const { avatarId, net, started, launch, sceneSetId } = await composedAndWaiting();
    const set = await setOf(started, avatarId, sceneSetId);
    const answer = ok(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision: set?.revision ?? 0 }));
    expect(answer.type === "autopilot.continueAfterReview" && answer.result.draw).toBe("started");
    await reachPhase(launch.launchId, "montage");
    expect(net.imageCalls()).toHaveLength(3);
    expect((await setOf(started, avatarId, sceneSetId))?.launchDraw?.sceneIds).toHaveLength(3);
  });

  test("a revision that moved is SCENES_CHANGED, a set that is not the avatar's is not-awaiting, and an approval is given once", async () => {
    const { avatarId, started, launch, sceneSetId } = await composedAndWaiting();
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    const stale = failed(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision: revision + 1 }));
    expect(stale.error.code).toBe("SCENES_CHANGED");
    const other = failed(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId: "set-someone-else-0001", revision }));
    expect(other.error).toMatchObject({ code: "VALIDATION", sceneReason: "not-awaiting" });
    ok(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }));
    const again = failed(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }));
    expect(again.error).toMatchObject({ code: "VALIDATION", sceneReason: "not-awaiting" });
  });

  test("during a pause the click only records the approval: the answer says the draw waits for «Продолжить», nothing is sent, and the resume draws (§18 item 9)", async () => {
    const { avatarId, net, started, launch, sceneSetId } = await composedAndWaiting();
    await launchCommand(started, "autopilot.pause", launch.launchId);
    await until(() => fileOf(launch.launchId).status === "paused", "the pause");
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    const answer = ok(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision }));
    expect(answer.type === "autopilot.continueAfterReview" && answer.result.draw).toBe("waits-for-resume");
    expect((await setOf(started, avatarId, sceneSetId))?.launchDraw?.sceneIds).toHaveLength(3);
    expect(phaseOf(launch.launchId)).toBe("approved-waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(net.imageCalls()).toEqual([]);
    const paused = await viewOf(started, launch.launchId);
    await resume(started, paused);
    await reachPhase(launch.launchId, "montage");
    expect(net.imageCalls()).toHaveLength(3);
  });

  test("a launch that waits for the review sends nothing more after a restart until «Продолжить», and the wait goes on after it (A5)", async () => {
    const { avatarId, started, launch, sceneSetId } = await composedAndWaiting();
    await kill(started);
    const net2 = network();
    const second = await boot(net2);
    const paused = await viewOf(second, launch.launchId);
    expect(paused.status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(net2.paidCalls()).toEqual([]);
    await resume(second, paused);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(phaseOf(launch.launchId)).toBe("awaiting-review");
    expect(net2.paidCalls()).toEqual([]);
    expect((await setOf(second, avatarId, sceneSetId))?.launchDraw).toBeUndefined();
  });
});

// ---------- stop during compose ----------

describe("«Стоп» during compose", () => {
  test("the request in flight finishes under the soft stop, no new request starts, the set is unlinked and the avatar is free (A6)", async () => {
    const avatarId = await seedAvatar();
    const hold = gate();
    const net = network({ writer: async (call, n) => (await hold.promise, goodWriter(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await until(() => net.writerCalls().length === 1, "the writer request");
    const stopping = await launchCommand(started, "autopilot.stop", launch.launchId);
    expect(stopping.status).toBe("stopping");
    hold.open();
    await until(() => fileOf(launch.launchId).status === "stopped", "the stop", 30_000);
    const { sceneSetId } = generationOf(launch.launchId);
    const set = await setOf(started, avatarId, sceneSetId);
    expect(set?.launchId).toBeUndefined();
    expect(set?.scenes.some((s) => s.text !== null)).toBe(true);
    expect(net.writerCalls()).toHaveLength(1);
    expect(net.imageCalls()).toEqual([]);
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
  });
});

// ---------- the crash matrix of the paid path (A3, A4) ----------

describe("a kill at each step boundary: after «Продолжить» there is one set, one run per slice, and no attempt id is sent twice", () => {
  /** A launch that was only started: the file, the ids and the group exist, no step ran (a kill between rows 1 and 2). */
  async function startedOnly() {
    const avatarId = await seedAvatar();
    const first = await boot(network(), { steps: false });
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await kill(first);
    return { avatarId, launch };
  }

  /** A launch composed up to the review wait, then killed. */
  async function composedThenKilled() {
    const avatarId = await seedAvatar();
    const first = await boot(network());
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    return { avatarId, launch, first };
  }

  test("row 2, before the set was written: the compose is made again under the same ids, once", async () => {
    const { avatarId, launch } = await startedOnly();
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await reachPhase(launch.launchId, "awaiting-review");
    expect(await setOf(second, avatarId, sceneSetId)).toMatchObject({ sceneSetId, runId: setRunId, launchId: launch.launchId });
    expect(net.writerCalls()).toHaveLength(1);
    expect(reserves()).toEqual([`${sceneSetId}:writer-1#1`]);
  });

  test("row 2, the set written and the answer lost: the launch's own «Дописать» takes the next unused attempt id, never the sent one", async () => {
    const { avatarId, launch, first } = await composedThenKilled();
    const { sceneSetId } = generationOf(launch.launchId);
    // The chunk's answer was lost: the sentences are not in the set, the first attempt is settled in the ledger.
    await first.engine.library?.sceneSets.update(avatarId, sceneSetId, (set) => ({ ...set, scenes: set.scenes.map((s) => (s.origin === "planned" ? { ...s, text: null } : s)) }));
    await kill(first);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await until(() => net.writerCalls().length === 1, "the second writer request");
    await reachPhase(launch.launchId, "awaiting-review");
    expect(reserves().filter((id) => id.startsWith(`${sceneSetId}:writer-`))).toEqual([`${sceneSetId}:writer-1#1`, `${sceneSetId}:writer-1#2`]);
    const committed = second.engine.budget?.committedOfGroup(`launch:${launch.launchId}`) ?? Number.POSITIVE_INFINITY;
    expect(committed).toBeLessThanOrEqual(launch.plannedWorstMicros);
  });

  test("row 2, the set file lost but the ledger holds its reserves: the avatar is skipped as set-unreadable, nothing is sent, and no id is reused (§18 item 8)", async () => {
    const { avatarId, launch, first } = await composedThenKilled();
    const { sceneSetId } = generationOf(launch.launchId);
    await kill(first);
    await first.engine.library?.sceneSets.remove(avatarId, sceneSetId);
    const net = network();
    const second = await boot(net);
    const view = await resume(second, await viewOf(second, launch.launchId));
    await until(() => phaseOf(launch.launchId) === "skipped", "the skip");
    expect(fileOf(launch.launchId).avatars[0]?.skipped).toEqual({ reason: "set-unreadable" });
    expect(net.paidCalls()).toEqual([]);
    expect(view.status).toBe("running");
    expect(reserves().filter((id) => id === `${sceneSetId}:writer-1#1`)).toHaveLength(1);
  });

  test("row 3, review OFF, the set composed and the approval not made: after «Продолжить» it is approved and drawn, and no second compose is sent", async () => {
    const avatarId = await seedAvatar();
    const first = await boot(network(), { steps: false });
    const launch = await startLaunch(first, draftOf([avatarId]));
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const generation = fileOf(launch.launchId).avatars[0]?.generation;
    // The compose ran to its end (the sentences are paid for and stored), and the process died before the approval.
    const composed = await first.engine.composeLaunchSet(
      { avatarId, count: 3, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: fileOf(launch.launchId).avatars[0]?.allocation.composeMicros ?? 0 },
      { ids: { sceneSetId, runId: setRunId }, split: generation?.split ?? [], launchId: launch.launchId },
    );
    await first.engine.whenSceneSetIdle(sceneSetId);
    expect(composed.jobId).not.toBeNull();
    await kill(first);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await reachPhase(launch.launchId, "montage");
    expect(net.writerCalls()).toEqual([]);
    expect((await setOf(second, avatarId, sceneSetId))?.launchDraw?.slices.map((s) => s.runId)).toEqual([setRunId]);
    expect(net.imageCalls()).toHaveLength(3);
    expect(reserves().filter((id) => id.startsWith(`${sceneSetId}:writer-`))).toEqual([`${sceneSetId}:writer-1#1`]);
  });

  test("row 4, the approval recorded and no slice entry: the first slice is drawn under the set's run id", async () => {
    const { avatarId, launch, first } = await composedThenKilled();
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision ?? 0;
    await first.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    await kill(first);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await reachPhase(launch.launchId, "montage");
    expect((await setOf(second, avatarId, sceneSetId))?.launchDraw?.slices.map((s) => s.runId)).toEqual([setRunId]);
    expect(net.imageCalls()).toHaveLength(3);
  });

  test("row 5, a slice entry without a run folder: the run is made once, under the entry's id", async () => {
    const { avatarId, launch, first } = await composedThenKilled();
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision ?? 0;
    const approved = await first.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    const sceneIds = approved.launchDraw?.sceneIds ?? [];
    await first.engine.library?.sceneSets.update(avatarId, sceneSetId, (set) => (set.launchDraw === undefined ? null : { ...set, launchDraw: { ...set.launchDraw, slices: [{ runId: setRunId, sceneIds, capMicros: 5_000_000 }] } }));
    await kill(first);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await reachPhase(launch.launchId, "montage");
    const set = await setOf(second, avatarId, sceneSetId);
    expect(set?.launchDraw?.slices.map((s) => s.runId)).toEqual([setRunId]);
    // The cap recorded before the crash was above what the slice can cost: it is lowered to today's, never kept or raised (A3).
    expect(set?.launchDraw?.slices[0]?.capMicros).toBeLessThan(5_000_000);
    expect(net.imageCalls()).toHaveLength(3);
  });

  test("row 5, an entry whose cap is below what its scenes cost now: the slice shrinks to the cap and the rest is drawn by the next slice, within the draw allocation (A2, A3)", async () => {
    const { avatarId, launch, first } = await composedThenKilled();
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision ?? 0;
    const approved = await first.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    const sceneIds = approved.launchDraw?.sceneIds ?? [];
    const photo = 150_000; // one photo's worst case at the fallback prices: three attempts of -e.05
    await first.engine.library?.sceneSets.update(avatarId, sceneSetId, (set) => (set.launchDraw === undefined ? null : { ...set, launchDraw: { ...set.launchDraw, slices: [{ runId: setRunId, sceneIds, capMicros: photo }] } }));
    await kill(first);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await reachPhase(launch.launchId, "montage");
    const set = await setOf(second, avatarId, sceneSetId);
    const slices = set?.launchDraw?.slices ?? [];
    expect(slices.length).toBeGreaterThanOrEqual(2);
    expect(slices[0]).toMatchObject({ runId: setRunId, capMicros: photo, sceneIds: [sceneIds[0]] });
    expect(slices.flatMap((s) => s.sceneIds).sort()).toEqual([...sceneIds].sort());
    const drawMicros = fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0;
    expect(slices.reduce((sum, s) => sum + s.capMicros, 0)).toBeLessThanOrEqual(drawMicros);
    expect(net.imageCalls()).toHaveLength(3);
  });

  test("row 5, a slice run made and never started: it is started once, inside its own cap, with no second run", async () => {
    const { avatarId, launch, first } = await composedThenKilled();
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision ?? 0;
    await first.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    const drawn = await first.engine.drawLaunchSlice({ sceneSetId, launchId: launch.launchId, size: 25, drawMicros: fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0 });
    expect(drawn).toMatchObject({ kind: "drawn", runId: setRunId });
    await kill(first);
    const net = network();
    const second = await boot(net);
    await resume(second, await viewOf(second, launch.launchId));
    await reachPhase(launch.launchId, "montage");
    expect((await setOf(second, avatarId, sceneSetId))?.launchDraw?.slices).toHaveLength(1);
    expect(net.imageCalls()).toHaveLength(3);
    expect(new Set(reserves()).size).toBe(reserves().length);
  });
});

// ---------- fix round 1 (S4.6b1 review): money ----------

describe("every slice run is in the launch's Budget group (HIGH)", () => {
  test("a launch of two slices: both runs map to the group, and «Потрачено» is the sum over every scope the launch spent in", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const started = await boot(net, { budget: 50_000_000 });
    const launch = await startLaunch(started, draftOf([avatarId], { videosPerAvatar: 30 }));
    await reachPhase(launch.launchId, "montage");
    const { sceneSetId } = generationOf(launch.launchId);
    const slices = (await setOf(started, avatarId, sceneSetId))?.launchDraw?.slices ?? [];
    expect(slices.length).toBeGreaterThanOrEqual(2);
    const key = `launch:${launch.launchId}`;
    for (const slice of slices) expect(started.engine.launchGroups.groupOf({ attemptId: "x#1", scope: { runId: slice.runId } })?.key).toBe(key);
    const everyScope = [...(started.engine.budget?.committedByScope().values() ?? [])].reduce((sum, v) => sum + v, 0);
    expect(started.engine.budget?.committedOfGroup(key)).toBe(everyScope);
    expect((await viewOf(started, launch.launchId)).spentMicros).toBe(everyScope);
  });

  test("a slice run that is not in the group is refused by the engine's internal start, and nothing is reserved", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    await started.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    await started.engine.drawLaunchSlice({ sceneSetId, launchId: launch.launchId, size: 25, drawMicros: fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0 });
    const before = reserves().length;
    started.engine.launchGroups.finish(launch.launchId);
    started.engine.launchGroups.register({ launchId: launch.launchId, capMicros: launch.plannedWorstMicros, setIds: [sceneSetId], runIds: [] });
    await expect(started.engine.startLaunchSlice(setRunId)).rejects.toMatchObject({ error: { code: "VALIDATION" } });
    expect(reserves().length).toBe(before);
  });
});

describe("the internal paid entry points need a launch that runs (MEDIUM)", () => {
  async function pausedWithDrawnSlice() {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    await started.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    await started.engine.drawLaunchSlice({ sceneSetId, launchId: launch.launchId, size: 25, drawMicros: fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0 });
    await launchCommand(started, "autopilot.pause", launch.launchId);
    await until(() => fileOf(launch.launchId).status === "paused", "the pause");
    return { avatarId, started, launch, sceneSetId, setRunId };
  }

  test("a paused launch's slice run is not started: the call is refused and the ledger gets no line", async () => {
    const { started, setRunId } = await pausedWithDrawnSlice();
    const before = ledgerLines(dir()).length;
    await expect(started.engine.startLaunchSlice(setRunId)).rejects.toMatchObject({ error: { code: "VALIDATION", detail: expect.stringContaining("not payable") } });
    expect(ledgerLines(dir()).length).toBe(before);
  });

  test("a paused launch's «Дописать» is not sent, and neither is a compose", async () => {
    const { avatarId, started, launch, sceneSetId, setRunId } = await pausedWithDrawnSlice();
    const before = ledgerLines(dir()).length;
    await expect(started.engine.writeLaunchScenes({ sceneSetId, launchId: launch.launchId, revision: 1, acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "VALIDATION", detail: expect.stringContaining("not payable") } });
    await expect(
      started.engine.composeLaunchSet(
        { avatarId, count: 3, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 1_000_000 },
        { ids: { sceneSetId: "set-other-0001", runId: "run-other-0001" }, split: [{ ref: "home", count: 3 }], launchId: launch.launchId },
      ),
    ).rejects.toMatchObject({ error: { code: "VALIDATION", detail: expect.stringContaining("not payable") } });
    expect(ledgerLines(dir()).length).toBe(before);
    expect(setRunId).toBeDefined();
  });

});

describe("an avatar is cut by the unread-sets rule only when the LAUNCH's own set cannot be read (MEDIUM, S4.10 OQ1)", () => {
  /** An approved launch set, the engine killed, and a restart on the same folders after `damage` was done to the disk. */
  async function restartedAfter(damage: (avatarId: string, sceneSetId: string) => Promise<void>) {
    const avatarId = await seedAvatar();
    const first = await boot(network());
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision ?? 0;
    await first.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    await kill(first);
    await mkdir(join(libraryDir(), "avatars", avatarId, "scenes"), { recursive: true });
    await damage(avatarId, sceneSetId);
    const linesBefore = ledgerLines(dir()).length;
    const net = network();
    const second = await boot(net);
    const paused = await viewOf(second, launch.launchId);
    await resume(second, paused);
    return { avatarId, launch, net, second, linesBefore };
  }

  test("an old manual set of the avatar that cannot be read does not cut it: the launch's own set draws after the restart", async () => {
    const { launch, net } = await restartedAfter(async (avatarId) => {
      await Bun.write(join(libraryDir(), "avatars", avatarId, "scenes", "set-foreign-0001.json"), "{not json");
    });
    await until(() => net.imageCalls().length > 0, "the draw of the launch's own set");
    expect(fileOf(launch.launchId).avatars[0]?.skipped).toBeNull();
    expect(phaseOf(launch.launchId)).not.toBe("skipped");
  });

  test("the launch's own set that cannot be read cuts the avatar: it is skipped as set-unreadable and nothing is reserved after the restart", async () => {
    const { launch, net, linesBefore } = await restartedAfter(async (avatarId, sceneSetId) => {
      await Bun.write(join(libraryDir(), "avatars", avatarId, "scenes", `${sceneSetId}.json`), "{not json");
    });
    await until(() => phaseOf(launch.launchId) === "skipped", "the skip");
    expect(fileOf(launch.launchId).avatars[0]?.skipped).toEqual({ reason: "set-unreadable" });
    expect(net.paidCalls()).toEqual([]);
    expect(ledgerLines(dir()).length).toBe(linesBefore);
  });
});

describe("the set mirrors follow the set (MEDIUM)", () => {
  test("an owner edit during the review moves the view's revision, and «Продолжить запуск» with it succeeds", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId } = generationOf(launch.launchId);
    const before = await setOf(started, avatarId, sceneSetId);
    const edited = ok(await call(started, "scenes.edit", { sceneSetId, revision: before?.revision ?? 0, op: { op: "text", sceneId: 1, text: `${SENTENCE} Edited.` } }));
    expect(edited.type).toBe("scenes.edit");
    const after = await setOf(started, avatarId, sceneSetId);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    const row = (await viewOf(started, launch.launchId)).avatars[0];
    expect(row?.setRevision).toBe(after?.revision ?? null);
    const answer = ok(await call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId, revision: row?.setRevision ?? 0 }));
    expect(answer.type === "autopilot.continueAfterReview" && answer.result.draw).toBe("started");
  });

  test("after a restart the paused launch's view already names the set and its revision", async () => {
    const avatarId = await seedAvatar();
    const first = await boot(network());
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision;
    await kill(first);
    const second = await boot(network());
    const row = (await viewOf(second, launch.launchId)).avatars[0];
    expect(row).toMatchObject({ sceneSetId, setRevision: revision, scenes: 3, continuePhotos: 3 });
  });
});

describe("an unreadable slice run is live, not pending (L1)", () => {
  test("a run folder whose plan cannot be read reports {finished: false}; only a run with no folder is absent", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    await started.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    const set = await setOf(started, avatarId, sceneSetId);
    if (set === null) throw new Error("no set");
    expect((await started.engine.sliceStatuses(set)).has(setRunId)).toBe(false);
    await started.engine.drawLaunchSlice({ sceneSetId, launchId: launch.launchId, size: 25, drawMicros: fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0 });
    await Bun.write(join(libraryDir(), "runs", setRunId, "plan.json"), "{not json");
    const after = await setOf(started, avatarId, sceneSetId);
    if (after === null) throw new Error("no set");
    expect((await started.engine.sliceStatuses(after)).get(setRunId)).toEqual({ finished: false });
  });
});

describe("a listener of the set announcements cannot swallow the event (LOW)", () => {
  test("a throwing listener leaves scenes.changed announced", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId } = generationOf(launch.launchId);
    started.engine.onSetChanged(() => {
      throw new Error("a listener defect");
    });
    const before = started.events().filter((e) => e.type === "scenes.changed").length;
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    ok(await call(started, "scenes.edit", { sceneSetId, revision, op: { op: "text", sceneId: 1, text: `${SENTENCE} Again.` } }));
    expect(started.events().filter((e) => e.type === "scenes.changed").length).toBeGreaterThan(before);
  });
});

// ---------- S4.6v: what the live card reads of the engine ----------

describe("the avatar row right after a restart (S4.6v)", () => {
  /** A review-ON launch whose set is approved and whose first slice is drawn (its run folder exists, its job never started), then the engine is killed. */
  async function killedWithADrawnSlice() {
    const avatarId = await seedAvatar();
    const first = await boot(network());
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(first, avatarId, sceneSetId))?.revision ?? 0;
    await first.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    await first.engine.drawLaunchSlice({ sceneSetId, launchId: launch.launchId, size: 25, drawMicros: fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0 });
    await kill(first);
    return { avatarId, launch, sceneSetId, setRunId };
  }

  test("names the slice drawn so far and the slots a started slice could still draw, before «Продолжить»", async () => {
    const { launch, sceneSetId } = await killedWithADrawnSlice();
    const second = await boot(network());
    // The first view asks for the row; the slices' folders are read behind it and the launch is announced when they are in.
    await viewOf(second, launch.launchId);
    await second.engine.settled();
    const view = await viewOf(second, launch.launchId);
    expect(LaunchView.safeParse(view).success).toBe(true);
    expect(view.status).toBe("paused");
    expect(view.avatars[0]).toMatchObject({ sceneSetId, scenes: 3, continuePhotos: 3, slice: { index: 1, total: 1 }, undrawnScenes: 0, resumableSlots: 3 });
  });

  test("the paused launch is announced again when the set changes after the restart", async () => {
    const avatarId = await seedAvatar();
    const first = await boot(network());
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId } = generationOf(launch.launchId);
    await kill(first);
    const second = await boot(network());
    // The window shows the paused card before the owner touches the set.
    await viewOf(second, launch.launchId);
    await second.engine.settled();
    const before = (await setOf(second, avatarId, sceneSetId))?.revision ?? 0;
    const announcedAt = (): number[] =>
      second
        .events()
        .flatMap((e) => (e.type === "autopilot.changed" ? [e.payload.launch.avatars[0]?.setRevision ?? 0] : []));
    const seen = announcedAt().length;
    ok(await call(second, "scenes.edit", { sceneSetId, revision: before, op: { op: "text", sceneId: 1, text: `${SENTENCE} Edited after the restart.` } }));
    await second.engine.settled();
    expect(announcedAt().length).toBeGreaterThan(seen);
    expect(announcedAt().at(-1)).toBeGreaterThan(before);
  });
});

describe("the launch id on sets and runs lasts as long as the launch (S4.6v)", () => {
  test("a launch's set and slice run name it while it is unfinished, and neither does once it is stopped", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    const revision = (await setOf(started, avatarId, sceneSetId))?.revision ?? 0;
    await started.engine.approveLaunchSet({ sceneSetId, launchId: launch.launchId, revision, plannedCount: 3 });
    await started.engine.drawLaunchSlice({ sceneSetId, launchId: launch.launchId, size: 25, drawMicros: fileOf(launch.launchId).avatars[0]?.allocation.drawMicros ?? 0 });

    const setLaunch = async (): Promise<string | undefined> => {
      const answer = ok(await call(started, "scenes.get", { avatarId }));
      return answer.type === "scenes.get" ? answer.result.sceneSet?.launchId : "wrong answer";
    };
    const runLaunch = async (): Promise<string | undefined> => {
      const answer = ok(await call(started, "runs.list", {}));
      return answer.type === "runs.list" ? answer.result.runs.find((r) => r.runId === setRunId)?.launchId : "wrong answer";
    };
    expect(await setLaunch()).toBe(launch.launchId);
    expect(await runLaunch()).toBe(launch.launchId);

    await launchCommand(started, "autopilot.stop", launch.launchId);
    expect(await setLaunch()).toBeUndefined();
    expect(await runLaunch()).toBeUndefined();
  });
});

describe("open reserves of an earlier process on the card (S4.6v)", () => {
  test("a reserve left by the previous process is unsettled, never in flight, and a reconcile clears it from the card", async () => {
    const avatarId = await seedAvatar();
    const first = await boot(network());
    const launch = await startLaunch(first, draftOf([avatarId], { sceneReview: true }));
    await reachPhase(launch.launchId, "awaiting-review");
    const { sceneSetId, setRunId } = generationOf(launch.launchId);
    await kill(first);
    // The previous process died with a request out: its reserve is open in the ledger, long enough ago for a reconcile to be allowed.
    await writeLedger(dir(), [
      { type: "reserve", attemptId: `${sceneSetId}:writer-9#1`, jobId: "job-dead-0001", scope: { runId: setRunId }, model: "x-ai/grok-4.3", worstMicros: 30_000, at: "2026-09-24T09:00:00.000Z" },
    ]);
    const clock = { mono: 0, wall: 0 };
    const second = await boot(network(), { deps: { monotonic: () => clock.mono, clock: () => NOW + clock.wall } });
    const paused = await viewOf(second, launch.launchId);
    expect(LaunchView.safeParse(paused).success).toBe(true);
    expect(paused).toMatchObject({ status: "paused", inFlight: { requests: 0, openMicros: 0 }, unsettled: { requests: 1, openMicros: 30_000 }, resumeBlockedBy: "reconcile-required" });

    clock.mono = 10 * 60_000;
    clock.wall = 10 * 60_000;
    const reconciled = ok(await call(second, "money.reconcile", {}));
    expect(reconciled.type).toBe("money.reconcile");
    const announced = (): LaunchView[] => second.events().flatMap((e) => (e.type === "autopilot.changed" ? [e.payload.launch] : []));
    await second.engine.settled();
    expect(announced().at(-1)?.unsettled?.requests).toBe(0);
    const after = await viewOf(second, launch.launchId);
    expect(after).toMatchObject({ inFlight: { requests: 0, openMicros: 0 }, unsettled: { requests: 0, openMicros: 0 }, spentMicros: paused.spentMicros, resumeBlockedBy: null });
  });
});
