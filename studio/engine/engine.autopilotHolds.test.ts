import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LaunchView, type LaunchDraftInput, type ResponseMessage } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import type { LaunchFile } from "./autopilot/launchFile";
import { createPaidSteps } from "./autopilot/paidSteps";
import { composeSteps } from "./autopilot/stepsComposer";
import type { LaunchSteps, LaunchStepsContext } from "./autopilot/steps";
import { FakeTimers } from "./autopilot/testing/paidRig";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, fakeFetch, imageBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, GOOD, ledgerLines, MODERATION, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { within } from "./testing/within";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b2 (plan §4.6, §3.8; invariants A6, A13, A19): the failure table in the real engine, over a real library, ledger, launch store and Budget group, with a fake OpenRouter (nothing
// reaches the network) and a clock the test owns. Each row asserts the ledger's lines, the hold, that the steps sent nothing more, and that free work went on. The free part is a probe: a
// part behind the composer that can still write the launch file, which is all «free work goes on through a hold» needs from it (A13).

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-autopilot-holds-");
const libraryDir = () => join(dir(), "library");
const launchPath = (launchId: string) => join(libraryDir(), "autopilot", `${launchId}.json`);

const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const FACE = [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }];
const MIN = 60_000;

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

let seeded = 0;

async function seedAvatar(name = "Mia"): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`holds${++seeded}`) });
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
  const net = fakeFetch(Array.from({ length: 1024 }, () => route));
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

/** The free part of a launch, as far as these rows need it: a part behind the composer that keeps the context it was begun with. */
function freeProbe() {
  let held: LaunchStepsContext | null = null;
  const steps: LaunchSteps = {
    begin: (ctx) => {
      held = ctx;
    },
    drain: () => Promise.resolve(),
    release: () => Promise.resolve(),
    inFlight: () => ({ requests: 0, renders: 0 }),
  };
  return {
    steps,
    ctx: (): LaunchStepsContext => {
      if (held === null) throw new Error("the free part was not begun");
      return held;
    },
  };
}

type Started = Awaited<ReturnType<typeof boot>>;

/** An engine over the test folders with the paid steps (on the test's timers) and a free probe behind the composer. */
async function boot(net: ReturnType<typeof network>, opts: { budget?: number } = {}) {
  await mkdir(join(dir(), "export"), { recursive: true });
  const holder: { engine: Awaited<ReturnType<typeof startEngine>>["engine"] | null } = { engine: null };
  const timers = new FakeTimers();
  const probe = freeProbe();
  const steps = createPaidSteps({
    port: () => {
      if (holder.engine === null) throw new Error("the engine is not started yet");
      return holder.engine;
    },
    timers,
    clock: () => timers.now,
  });
  const started = await startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: opts.budget ?? 10_000_000 }) },
    net,
    deps: { qaGates: FACE, launchSteps: composeSteps(steps, probe.steps) },
  });
  holder.engine = started.engine;
  const booted = { ...started, timers, probe };
  live = booted;
  return booted;
}

/** The engine the running test booted: `holdOf` asks its launch. */
let live: { probe: ReturnType<typeof freeProbe> } | null = null;

const bounded = <T>(promise: Promise<T>, label: string): Promise<T> => within(promise, 30_000, label);

async function call(started: Started, type: string, payload: unknown): Promise<ResponseMessage> {
  return bounded(started.engine.handle(command(type, payload)), type);
}

async function startLaunch(started: Started, draft: LaunchDraftInput): Promise<LaunchView> {
  const estimate = ok(await call(started, "autopilot.estimate", { draft }));
  if (estimate.type !== "autopilot.estimate") throw new Error("not an estimate");
  const { preview } = estimate.result;
  const answer = ok(await call(started, "autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }));
  if (answer.type !== "autopilot.start") throw new Error("not a start");
  return answer.result.launch;
}

async function viewOf(started: Started, launchId: string): Promise<LaunchView> {
  const answer = ok(await call(started, "autopilot.get", { launchId }));
  if (answer.type !== "autopilot.get") throw new Error("wrong answer");
  return answer.result.launch;
}

async function logOf(started: Started, launchId: string) {
  const answer = ok(await call(started, "autopilot.get", { launchId }));
  if (answer.type !== "autopilot.get") throw new Error("wrong answer");
  return answer.result.log;
}

const fileOf = (launchId: string): LaunchFile => JSON.parse(readFileSync(launchPath(launchId), "utf8")) as LaunchFile;
/**
 * The launch's hold as the steps see it (the orchestrator's copy), the file's when the launch is over. Not the file alone: it is written before the copy is replaced, and a test that moves the
 * clock the moment the file shows a hold would fire a timer at a launch that does not know the hold yet.
 */
const holdOf = (launchId: string) => {
  try {
    return live?.probe.ctx().file().paidHold ?? null;
  } catch {
    return existsSync(launchPath(launchId)) ? fileOf(launchId).paidHold : null;
  }
};
const phaseOf = (launchId: string, row = 0): string | undefined => (existsSync(launchPath(launchId)) ? fileOf(launchId).avatars[row]?.phase : undefined);

async function reachHold(launchId: string, reason: string): Promise<NonNullable<LaunchFile["paidHold"]>> {
  await until(() => holdOf(launchId)?.reason === reason, `the ${reason} hold`, 30_000);
  const hold = holdOf(launchId);
  if (hold === null) throw new Error("no hold");
  return hold;
}

const idle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Free work goes on through a paid hold (A13): the launch still runs, and the free part can still write its file. */
async function expectFreeWorkGoesOn(started: Started, launchId: string): Promise<void> {
  const before = fileOf(launchId).revision;
  expect(started.probe.ctx().isRunning()).toBe(true);
  await bounded(
    started.probe.ctx().update((f) => ({ ...f, avatars: f.avatars.map((a, i) => (i === 0 ? { ...a, videos: a.videos.map((v, j) => (j === 0 ? { ...v, state: "waiting-photos" as const } : v)) } : a)) })),
    "the free part's write",
  );
  expect(fileOf(launchId).revision).toBeGreaterThan(before);
  expect(fileOf(launchId).status).toBe("running");
}

const reserveIds = (): string[] => ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
const imageReserveIds = (): string[] => reserveIds().filter((id) => !id.includes(":writer-"));

// ---------- a definitive answer: credits and key ----------

describe("§4.6 in the engine: a 402 and a 401 hold the launch at no cost", () => {
  test("INSUFFICIENT_CREDITS: «credits», every reserve closed, nothing more is sent, free work goes on", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: () => ({ status: 402, body: { error: { message: "Insufficient credits" } } }) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    const hold = await reachHold(launch.launchId, "credits");
    expect(hold.detail).toEqual({});
    await idle();
    const sent = net.imageCalls().length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(3);
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
    expect((await logOf(started, launch.launchId)).some((l) => l.kind === "hold-credits")).toBe(true);
    await idle();
    expect(net.imageCalls()).toHaveLength(sent);
    await expectFreeWorkGoesOn(started, launch.launchId);
    // The owner tops up and clicks: a 402 is always admitted, and the answer of the next request decides.
    expect((await viewOf(started, launch.launchId)).resumeBlockedBy).toBeNull();
  });

  test("AUTH_INVALID: «key», the key reads as rejected, nothing more is sent, and free work goes on", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    await reachHold(launch.launchId, "key");
    await idle();
    const sent = net.imageCalls().length;
    await idle();
    expect(net.imageCalls()).toHaveLength(sent);
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
    expect((await logOf(started, launch.launchId)).some((l) => l.kind === "hold-key")).toBe(true);
    // A stored key that OpenRouter rejected blocks «Продолжить» until a new one is stored (§3.7).
    expect((await viewOf(started, launch.launchId)).resumeBlockedBy).toBe("key");
    await expectFreeWorkGoesOn(started, launch.launchId);
  });
});

// ---------- no answer ----------

describe("§4.6 in the engine: a request that gets no answer", () => {
  test("the first drop leaves the reserves open at worst, holds as «network» for a minute, and the slice goes on with the NEXT attempt ids", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: (call, n) => (n <= 3 ? OFFLINE : goodImage(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    const hold = await reachHold(launch.launchId, "network");
    expect(hold.detail).toEqual({ drops: 1, attempt: 1, nextAt: started.timers.iso(MIN) });
    // The ledger: three attempts were sent and none was answered, so three reserves stay open (counted at worst), one per photo in flight.
    const firstRound = imageReserveIds();
    expect(firstRound).toHaveLength(3);
    expect(firstRound.every((id) => id.endsWith("#1"))).toBe(true);
    expect(started.engine.budget?.ledger.openReserves()).toHaveLength(3);
    expect((await logOf(started, launch.launchId)).find((l) => l.kind === "network-retry")).toMatchObject({ attempt: 1, attempts: 2, afterMs: MIN });
    await expectFreeWorkGoesOn(started, launch.launchId);

    started.timers.advance(MIN - 1);
    await idle();
    expect(net.imageCalls()).toHaveLength(3);
    started.timers.advance(1);
    await until(() => phaseOf(launch.launchId) === "montage", "the montage after the automatic continue", 30_000);
    const all = imageReserveIds();
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((id) => id.endsWith("#2"))).toHaveLength(3);
    expect(all.filter((id) => id.endsWith("#3"))).toHaveLength(0);
    expect(holdOf(launch.launchId)).toBeNull();
    expect(fileOf(launch.launchId).avatars[0]?.photosDone).toBe(3);
    // The first round's reserves are still open: they stay counted at worst until a reconcile.
    expect(started.engine.budget?.ledger.openReserves()).toHaveLength(3);
  });

  test("a final 429 is settled at $0 with no open reserve, and continues by itself the same way (no attempt is burnt)", async () => {
    const avatarId = await seedAvatar();
    const limited: Reply = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };
    const net = network({ image: (call, n) => (n <= 3 ? limited : goodImage(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    const hold = await reachHold(launch.launchId, "network");
    expect(hold.detail).toMatchObject({ drops: 1, attempt: 1 });
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
    started.timers.advance(MIN);
    await until(() => phaseOf(launch.launchId) === "montage", "the montage after the automatic continue", 30_000);
    expect(fileOf(launch.launchId).avatars[0]?.photosDone).toBe(3);
  });

  test("three drops of one slice: the third holds for a person with no retry, the ledger's open reserves block «Продолжить» until a reconcile, and the clock changes nothing", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: () => OFFLINE });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    await reachHold(launch.launchId, "network");
    started.timers.advance(MIN);
    await until(() => (holdOf(launch.launchId)?.detail as { drops?: number } | undefined)?.drops === 2 && started.timers.pending() === 1, "the second drop and its wait", 30_000);
    started.timers.advance(5 * MIN);
    await until(() => (holdOf(launch.launchId)?.detail as { drops?: number } | undefined)?.drops === 3, "the third drop", 30_000);
    expect(holdOf(launch.launchId)?.detail).toEqual({ drops: 3, attempt: 2, nextAt: null });
    expect(started.timers.pending()).toBe(0);
    const sent = net.imageCalls().length;
    started.timers.advance(24 * 60 * MIN);
    await idle();
    expect(net.imageCalls()).toHaveLength(sent);
    // Three attempts of each of the three photos are open at worst: no photo has an attempt left.
    expect(started.engine.budget?.ledger.openReserves()).toHaveLength(9);
    expect((await viewOf(started, launch.launchId)).resumeBlockedBy).toBe("network");
    await expectFreeWorkGoesOn(started, launch.launchId);
  });
});

// ---------- the ledger halts ----------

describe("§4.6 in the engine: a settle above the reserved worst case", () => {
  test("SETTLE_ABOVE_WORST holds as «halt» with the code, the money is stopped, and nothing more is sent", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: (_call, n) => ({ status: 200, body: imageBody(portraitPng(((n - 1) % 4) + 1), { cost: 0.9 }) }) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    const hold = await reachHold(launch.launchId, "halt");
    expect(hold.detail).toEqual({ code: "SETTLE_ABOVE_WORST" });
    await idle();
    const sent = net.imageCalls().length;
    await idle();
    expect(net.imageCalls()).toHaveLength(sent);
    expect((await logOf(started, launch.launchId)).find((l) => l.kind === "hold-halt")).toMatchObject({ code: "SETTLE_ABOVE_WORST" });
    expect((await viewOf(started, launch.launchId)).resumeBlockedBy).toBe("halt");
    await expectFreeWorkGoesOn(started, launch.launchId);
  });
});

// ---------- the failure-rate guard ----------

describe("§4.6 in the engine: the failure-rate guard", () => {
  test("a slice of 25 in which moderation refused every photo skips the avatar before the second slice is bought, with the counts", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: () => MODERATION });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId], { videosPerAvatar: 30 }));
    await until(() => phaseOf(launch.launchId) === "skipped", "the skip", 45_000);
    expect(fileOf(launch.launchId).avatars[0]?.skipped).toEqual({ reason: "failure-rate", failed: 25, total: 25 });
    const skippedLine = (await logOf(started, launch.launchId)).find((l) => l.kind === "skipped");
    expect(skippedLine).toMatchObject({ avatarId, reason: "failure-rate", failed: 25, total: 25 });
    // One slice was drawn and bought; the five scenes left were never drawn.
    const sent = net.imageCalls().length;
    await idle();
    expect(net.imageCalls()).toHaveLength(sent);
    expect(holdOf(launch.launchId)).toBeNull();
    // Every refused attempt was settled at $0: no reserve is open, and nothing was spent on photos.
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
  });
});

// ---------- host.power ----------

describe("host.power in the engine (plan §3.8)", () => {
  test("suspend while the writer's request is in flight: the request finishes, no image is requested while the Mac sleeps, and resume goes on", async () => {
    const avatarId = await seedAvatar();
    const hold = gate();
    const net = network({ writer: async (call, n) => (await hold.promise, goodWriter(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    await until(() => net.writerCalls().length === 1, "the writer request", 30_000);
    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "suspend" }), "suspend");
    hold.open();
    await idle(400);
    expect(net.writerCalls()).toHaveLength(1);
    expect(net.imageCalls()).toEqual([]);
    expect(fileOf(launch.launchId).status).toBe("running");
    expect(holdOf(launch.launchId)).toBeNull();

    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "resume" }), "resume");
    await until(() => phaseOf(launch.launchId) === "montage", "the montage after the wake-up", 45_000);
    expect(net.imageCalls()).toHaveLength(3);
    expect(fileOf(launch.launchId).avatars[0]?.photosDone).toBe(3);
  });

  test("S4.10 M-1: the Mac wakes while the slice's requests are still in flight; they end after the wake-up: no hold, the slice goes on to the montage", async () => {
    const avatarId = await seedAvatar();
    const hold = gate();
    const net = network({ image: async (call, n) => (n <= 3 ? (await hold.promise, goodImage(call, n)) : goodImage(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    await until(() => net.imageCalls().length === 3, "the slice's requests in flight", 30_000);
    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "suspend" }), "suspend");
    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "resume" }), "resume");
    // The requests answer only now, AFTER the wake-up: the slice ends cancelled by the soft stop the sleep sent.
    hold.open();
    await until(() => phaseOf(launch.launchId) === "montage", "the montage after the wake-up", 45_000);
    expect(holdOf(launch.launchId)).toBeNull();
    expect(fileOf(launch.launchId).avatars[0]?.photosDone).toBe(3);
  });

  test("S4.10 M-2: a writer request that gets no answer is the no-answer rule of §4.6 (a minute, then «Дописать»), not an internal hold", async () => {
    const avatarId = await seedAvatar();
    const net = network({ writer: (call, n) => (n <= 3 ? OFFLINE : goodWriter(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    const hold = await reachHold(launch.launchId, "network");
    expect(hold.detail).toEqual({ drops: 1, attempt: 1, nextAt: started.timers.iso(MIN) });
    expect(Object.keys(fileOf(launch.launchId).autoContinues ?? {})).toEqual([expect.stringContaining(":scenes")]);
    expect((await logOf(started, launch.launchId)).find((l) => l.kind === "network-retry")).toMatchObject({ attempt: 1, attempts: 2, afterMs: MIN });
    expect(net.imageCalls()).toEqual([]);
    started.timers.advance(MIN);
    await until(() => phaseOf(launch.launchId) === "montage", "the montage after the automatic continue", 45_000);
    expect(holdOf(launch.launchId)).toBeNull();
  });

  test("suspend and resume with nothing running change nothing and send nothing", async () => {
    const net = network();
    const started = await boot(net);
    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "suspend" }), "suspend");
    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "resume" }), "resume");
    expect(net.paidCalls()).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a launch whose engine slept is not left suspended by a lost wake-up: «Продолжить» after a hold runs again", async () => {
    const avatarId = await seedAvatar();
    const net = network({ image: (call, n) => (n <= 3 ? { status: 402, body: { error: { message: "Insufficient credits" } } } : goodImage(call, n)) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    await reachHold(launch.launchId, "credits");
    await bounded(started.engine.applyControl({ kind: "control", type: "host.power", state: "suspend" }), "suspend");
    const view = await viewOf(started, launch.launchId);
    ok(await call(started, "autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: view.remainingMicros }));
    await until(() => phaseOf(launch.launchId) === "montage", "the montage after the click", 45_000);
  });
});

// ---------- «Пауза» and «Стоп» (A6) ----------

describe("«Пауза» during a slice (A6)", () => {
  test("the attempts in flight end under the ordinary rules, no new attempt leaves (not even the fallback after a refusal), and the button leaves no open reserve", async () => {
    const avatarId = await seedAvatar();
    const hold = gate();
    const net = network({ image: async () => (await hold.promise, MODERATION) });
    const started = await boot(net);
    const launch = await startLaunch(started, draftOf([avatarId]));
    await until(() => net.imageCalls().length === 3, "the three attempts in flight", 30_000);
    const pausing = await call(started, "autopilot.pause", { launchId: launch.launchId });
    expect(ok(pausing).type).toBe("autopilot.pause");
    hold.open();
    await until(() => fileOf(launch.launchId).status === "paused", "the pause", 30_000);
    await idle(300);
    // Each refused photo would have had a fallback attempt; the soft stop sent none.
    expect(net.imageCalls()).toHaveLength(3);
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
    expect(holdOf(launch.launchId)).toBeNull();
    expect(started.timers.pending()).toBe(0);
  });
});
