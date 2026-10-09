import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResponseMessage, SceneSetView } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary, type Library } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import { chatBody, fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { RunEventSchema } from "./runs/journal";
import { buildSceneRunPlan, RunPlanSchema } from "./runs/plan";
import { MemoryLaunches } from "./sceneSets/testing/memoryLaunches";
import { runSnapshots, runSources } from "./sceneSets/toRun";
import { command, engineSettings, failed, GOOD, jobEnd, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// S4.5a: the scene-set launch path against a real engine over a real ledger and library in a temp dir, and a fake OpenRouter (nothing reaches the network).
// A batch launch composes a set under ids it issued first, approves it as a frozen list, draws it in slices, and while it is unfinished the engine refuses
// every command that would move the set or a slice from under it. A launch that is finished, stopped or removed locks nothing (the unlinked rule).

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-launch-sets-");
const libraryDir = () => join(dir(), "library");

const LAUNCH = "launch-0a1b2c3d4e5f";
const OTHER = "launch-9z8y7x6w5v4u";
const SET = "set-launch-0001";
const RUN = "run-launch-0001";
const ATTEMPT = 37_500;
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const POSES = { profile: false, back: false };
const TWO = { sceneSetId: SET, runId: RUN };

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

let seeded = 0;

async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

interface SeedOptions {
  count?: number;
  written?: number;
  launchId?: string | null;
  /** The set as a compose that never sent a request left it: a recorded write, no sentence. */
  composeRecorded?: boolean;
  draw?: { sceneIds: number[]; slices?: { runId: string; sceneIds: number[]; capMicros: number }[] };
}

/** A launch's set on disk, as compose, the review and the launch approval leave it. */
async function seedSet(avatarId: string, options: SeedOptions = {}): Promise<void> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
  const count = options.count ?? 6;
  const base = sampleSet({ ...TWO, avatarId, count, written: options.written ?? count });
  const launchId = options.launchId === undefined ? LAUNCH : options.launchId;
  await library.sceneSets.create({
    ...base,
    ...(options.composeRecorded === true ? { write: { k: 1, kind: "compose" as const, jobId: "job-seed-0001" }, writes: 1 } : {}),
    ...(launchId === null ? {} : { launchId }),
    ...(options.draw === undefined || launchId === null ? {} : { launchDraw: { launchId, sceneIds: options.draw.sceneIds, slices: options.draw.slices ?? [] } }),
  });
}

/** A run folder as a slice's `createRun` leaves it, for the first slice of a seeded draw. */
async function seedSliceRun(avatarId: string, sceneIds: number[], runId = RUN): Promise<void> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock() });
  const set = await library.sceneSets.get(avatarId, SET);
  if (set === null) throw new Error("no seeded set");
  const chosen = new Set(sceneIds);
  const scenes = runSources({ ...set, scenes: set.scenes.map((s) => ({ ...s, removed: !chosen.has(s.sceneId) })) });
  await library.createRun(
    runId,
    buildSceneRunPlan({
      runId,
      avatarId: set.avatarId,
      createdAt: "2026-10-07T12:00:00.000Z",
      sceneSetId: SET,
      imageAgeCheck: "off",
      models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
      capMicros: 1_000_000,
      plannedWorstMicros: 1_000_000,
      scenes,
      categories: runSnapshots(set, scenes),
    }),
    RunPlanSchema,
  );
}

function isWriter(call: FetchCall): boolean {
  if (!call.url.endsWith("/chat/completions")) return false;
  const format = call.json().response_format;
  return typeof format === "object" && format !== null && "json_schema" in format && JSON.stringify(format.json_schema).includes("scene_sentences");
}

function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

const goodAnswer: Handler = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) });

function sceneNetwork(opts: { writer?: Handler; prices?: (call: FetchCall) => Reply | Promise<Reply> } = {}) {
  let writes = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (isWriter(call)) return (opts.writer ?? goodAnswer)(call, ++writes);
    if (call.url.endsWith("/images")) return { hang: true };
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return opts.prices === undefined ? OFFLINE : opts.prices(call);
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    ageCalls: () => [],
    descriptorCalls: () => [],
    paidCalls: () => net.calls.filter((c) => c.method === "POST"),
    writerCalls: () => net.calls.filter(isWriter),
  };
}

function engineOver(net: ReturnType<typeof sceneNetwork>, launches = new MemoryLaunches().add(LAUNCH)) {
  return startEngine(dir(), { init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }) }, net, deps: { launches, launchMayPay: (id) => launches.isUnfinished(id) } }).then((started) => ({ ...started, launches }));
}

function held(content: Handler = goodAnswer) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  const handler: Handler = async (call, n) => {
    arrived++;
    await gate;
    return content(call, n);
  };
  return { handler, release, arrived: () => arrived };
}

function readLedger(): Record<string, unknown>[] {
  const path = join(dir(), "userData", "ledger.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

const ledgerReserves = (): string[] => readLedger().flatMap((l) => (l.type === "reserve" ? [String(l.attemptId)] : []));

function setFile(avatarId: string, sceneSetId = SET): Record<string, unknown> {
  return JSON.parse(readFileSync(join(libraryDir(), "avatars", avatarId, "scenes", `${sceneSetId}.json`), "utf8"));
}

function setFiles(avatarId: string): string[] {
  const folder = join(libraryDir(), "avatars", avatarId, "scenes");
  return existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith(".json")) : [];
}

async function viewOf(engine: Awaited<ReturnType<typeof engineOver>>["engine"], avatarId: string): Promise<SceneSetView> {
  const result = ok(await engine.handle(command("scenes.get", { avatarId })));
  if (result.type !== "scenes.get" || result.result.sceneSet === null) throw new Error("expected a set");
  return result.result.sceneSet;
}

const refusal = (response: ResponseMessage) => {
  const { code, sceneReason } = failed(response).error;
  return { code, sceneReason };
};
const LAUNCH_SET = { code: "VALIDATION", sceneReason: "launch-set" } as const;
/** Whether the command was turned away as part of a launch (an accepted command, or any other refusal, is not). */
const isLaunchSet = (response: ResponseMessage): boolean => !response.ok && response.error.sceneReason === "launch-set";

const composeBody = (avatarId: string, over: Record<string, unknown> = {}) => ({ avatarId, count: 10, categories: ["home", "travel"], poses: POSES, acceptedWorstMicros: 2 * ATTEMPT, ...over });
const internal = (over: Record<string, unknown> = {}) => ({ ids: TWO, split: [{ ref: "home" as const, count: 7 }, { ref: "travel" as const, count: 3 }], launchId: LAUNCH, ...over });

// ---------- compose with ids the launch issued ----------

describe("composeLaunchSet", () => {
  test("writes the set under the pre-issued ids, stamped with the launch, with exactly the split's scenes per category", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);

    const { sceneSetId, jobId } = await engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never);
    if (jobId === null) throw new Error("expected a job");
    await jobEnd(events, jobId);

    const file = setFile(avatarId) as { sceneSetId: string; runId: string; launchId: string; scenes: { slot: { category: string } }[]; chunks: { attemptIds: string[] }[] };
    expect(sceneSetId).toBe(SET);
    expect(file).toMatchObject({ sceneSetId: SET, runId: RUN, launchId: LAUNCH });
    expect(file.scenes.filter((s) => s.slot.category === "home")).toHaveLength(7);
    expect(file.scenes.filter((s) => s.slot.category === "travel")).toHaveLength(3);
    expect(ledgerReserves().every((id) => id.startsWith(`${SET}:writer-`))).toBe(true);
    expect(ledgerReserves()).toContain(file.chunks[0]?.attemptIds[0]);
  });

  test("a second compose with the same ids after a crash before the first request makes no second set, no request and no reserve", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { written: 0, composeRecorded: true });
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    const again = await engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never);

    expect(again).toEqual({ sceneSetId: SET, jobId: null });
    expect(setFiles(avatarId)).toEqual([`${SET}.json`]);
    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
  });

  test("a second compose with the same ids after the first finished sends no attempt id again", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    const first = await engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never);
    if (first.jobId === null) throw new Error("expected a job");
    await jobEnd(events, first.jobId);
    const reserved = ledgerReserves();
    const calls = net.writerCalls().length;

    const again = await engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never);

    expect(again.jobId).toBeNull();
    expect(setFiles(avatarId)).toEqual([`${SET}.json`]);
    expect(net.writerCalls()).toHaveLength(calls);
    expect(ledgerReserves()).toEqual(reserved);
  });

  test("refuses a compose whose ids name a set that does not belong to this launch, and sends nothing", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { launchId: OTHER, composeRecorded: true });
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    const error = await engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never).catch((e: unknown) => e);

    expect(error).toMatchObject({ error: { code: "INTERNAL" } });
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("refuses a split whose counts do not add up to the count, writes no set and sends nothing", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    const error = await engine.composeLaunchSet(composeBody(avatarId) as never, internal({ split: [{ ref: "home", count: 7 }, { ref: "travel", count: 2 }] }) as never).catch((e: unknown) => e);

    expect(error).toMatchObject({ error: { code: "VALIDATION" } });
    expect(setFiles(avatarId)).toEqual([]);
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("a soft stop that arrives while the prices load is honoured: the job ends before its first request, with no reserve", async () => {
    const avatarId = await seedAvatar();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let priceRequested = false;
    const net = sceneNetwork({
      prices: async () => {
        priceRequested = true;
        await gate;
        return OFFLINE;
      },
    });
    const { engine, events } = await engineOver(net);
    const composing = engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never);
    // Synchronously, before the call has yielded once: the live entry exists from the first line, so the stop is kept even before the library is read.
    expect(engine.softStopScenes(SET)).toBe(true);
    await until(() => priceRequested, "the price request");
    release();
    const { jobId } = await composing;
    if (jobId === null) throw new Error("expected a job");
    await jobEnd(events, jobId);

    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
    expect(events().some((e) => e.type === "job.cancelled" && e.payload.jobId === jobId)).toBe(true);
    expect((await viewOf(engine, avatarId)).status).toBe("stopped");
  });

  test("a soft stop right after a compose that is made again after a crash is honoured too: no job, no request, no reserve", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { written: 0, composeRecorded: true });
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    const again = engine.composeLaunchSet(composeBody(avatarId) as never, internal() as never);
    expect(engine.softStopScenes(SET)).toBe(true);

    expect(await again).toEqual({ sceneSetId: SET, jobId: null });
    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
    expect(engine.softStopScenes(SET)).toBe(false);
  });
});

// ---------- the refusals that close the bypass through «Фото» ----------

type Eng = Awaited<ReturnType<typeof engineOver>>["engine"];

interface Refused {
  name: string;
  /** The command that must be refused as `launch-set` while the launch is unfinished. */
  run: (engine: Eng) => Promise<ResponseMessage>;
  /** What the set needs on disk for the command to be otherwise valid. */
  seed: (avatarId: string) => Promise<void>;
}

const writeTarget = (target: unknown, accepted = 1) => (engine: Eng) => engine.handle(command("scenes.write", { sceneSetId: SET, revision: 1, target, acceptedWorstMicros: accepted }));

const SET_REFUSALS: Refused[] = [
  { name: "scenes.discard", run: (e) => e.handle(command("scenes.discard", { sceneSetId: SET })), seed: (a) => seedSet(a, { written: 3 }) },
  { name: "runs.startFromScenes", run: (e) => e.handle(command("runs.startFromScenes", { sceneSetId: SET, revision: 1, acceptedWorstMicros: 1 })), seed: (a) => seedSet(a) },
  { name: "scenes.write { unwritten }", run: writeTarget({ kind: "unwritten" }), seed: (a) => seedSet(a, { written: 3, composeRecorded: true }) },
  { name: "scenes.cancel", run: (e) => e.handle(command("scenes.cancel", { sceneSetId: SET })), seed: (a) => seedSet(a, { written: 3 }) },
  { name: "scenes.write { idea } (an own scene)", run: writeTarget({ kind: "idea", idea: "кофе на балконе утром", count: 1, shot: null }), seed: (a) => seedSet(a) },
  { name: "scenes.edit on a set the launch approved", run: (e) => e.handle(command("scenes.edit", { sceneSetId: SET, revision: 1, op: { op: "remove", sceneIds: [1] } })), seed: (a) => seedSet(a, { draw: { sceneIds: [1, 2, 3, 4, 5, 6] } }) },
];

describe("launch-set refusals on a launch's set", () => {
  for (const item of SET_REFUSALS) {
    test(`${item.name} is refused as launch-set while the launch is unfinished, and nothing changes`, async () => {
      const avatarId = await seedAvatar();
      await item.seed(avatarId);
      const net = sceneNetwork();
      const { engine } = await engineOver(net);
      const before = JSON.stringify(setFile(avatarId));

      expect(refusal(await item.run(engine))).toEqual(LAUNCH_SET);

      expect(JSON.stringify(setFile(avatarId))).toBe(before);
      expect(net.paidCalls()).toHaveLength(0);
    });

    test(`${item.name} is accepted again, as for any manual set, once the launch is finished`, async () => {
      const avatarId = await seedAvatar();
      await item.seed(avatarId);
      const { engine, launches } = await engineOver(sceneNetwork());
      launches.finish(LAUNCH);

      expect(isLaunchSet(await item.run(engine))).toBe(false);
    });

    test(`${item.name} is accepted again once the launch's file is removed`, async () => {
      const avatarId = await seedAvatar();
      await item.seed(avatarId);
      const { engine, launches } = await engineOver(sceneNetwork());
      launches.remove(LAUNCH);

      expect(isLaunchSet(await item.run(engine))).toBe(false);
    });
  }

  test("scenes.discard really discards the set once the launch is finished", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { written: 3 });
    const { engine, launches } = await engineOver(sceneNetwork());
    launches.finish(LAUNCH);

    ok(await engine.handle(command("scenes.discard", { sceneSetId: SET })));

    expect(setFiles(avatarId)).toEqual([]);
  });

  test("the free edits of a set the launch has not approved yet are allowed: the owner reviews it on «Фото»", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId);
    const { engine } = await engineOver(sceneNetwork());

    ok(await engine.handle(command("scenes.edit", { sceneSetId: SET, revision: 1, op: { op: "remove", sceneIds: [1] } })));
  });

  test("a rewrite of a scene is a paid click of its own and is not refused before the launch approves the set", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId);
    const { engine } = await engineOver(sceneNetwork());

    const response = await engine.handle(command("scenes.write", { sceneSetId: SET, revision: 1, target: { kind: "rewrite", sceneIds: [1], redraw: false }, acceptedWorstMicros: 1 }));

    expect(isLaunchSet(response)).toBe(false);
  });

  test("a rewrite after the launch approved the set is refused as launch-set", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3, 4, 5, 6] } });
    const { engine } = await engineOver(sceneNetwork());

    const response = await engine.handle(command("scenes.write", { sceneSetId: SET, revision: 1, target: { kind: "rewrite", sceneIds: [1], redraw: false }, acceptedWorstMicros: 1 }));

    expect(refusal(response)).toEqual(LAUNCH_SET);
  });

  test("the approval through the engine freezes the set: an edit that follows is refused as launch-set", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId);
    const { engine } = await engineOver(sceneNetwork());

    const approved = await engine.approveLaunchSet({ sceneSetId: SET, launchId: LAUNCH, revision: 1, plannedCount: 6 });

    expect(approved.launchDraw?.sceneIds).toEqual([1, 2, 3, 4, 5, 6]);
    const response = await engine.handle(command("scenes.edit", { sceneSetId: SET, revision: approved.revision, op: { op: "remove", sceneIds: [1] } }));
    expect(refusal(response)).toEqual(LAUNCH_SET);
  });
});

describe("launch-set refusals on a launch's slice run", () => {
  async function withSlice() {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3, 4, 5, 6], slices: [{ runId: RUN, sceneIds: [1, 2, 3], capMicros: 150_000 }] } });
    await seedSliceRun(avatarId, [1, 2, 3]);
    return avatarId;
  }

  test("runs.resume of a slice run is refused as launch-set, from a registry rebuilt at the library's open", async () => {
    await withSlice();
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    const response = await engine.handle(command("runs.resume", { runId: RUN, acceptedWorstMicros: 1_000_000 }));

    expect(refusal(response)).toEqual(LAUNCH_SET);
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("runs.cancel of a slice run is refused as launch-set", async () => {
    await withSlice();
    const { engine } = await engineOver(sceneNetwork());

    expect(refusal(await engine.handle(command("runs.cancel", { runId: RUN })))).toEqual(LAUNCH_SET);
  });

  test("runs.resume and runs.cancel are accepted again as for any manual run once the launch is finished", async () => {
    await withSlice();
    const { engine, launches } = await engineOver(sceneNetwork());
    launches.finish(LAUNCH);

    expect(isLaunchSet(await engine.handle(command("runs.resume", { runId: RUN, acceptedWorstMicros: 1 })))).toBe(false);
    ok(await engine.handle(command("runs.cancel", { runId: RUN })));
  });

  test("runs.cancel is accepted again once the launch's file is removed", async () => {
    await withSlice();
    const { engine, launches } = await engineOver(sceneNetwork());
    launches.remove(LAUNCH);

    ok(await engine.handle(command("runs.cancel", { runId: RUN })));
  });

  test("runs.list marks the slice run with its launch while the launch is unfinished, and not after", async () => {
    await withSlice();
    const { engine, launches } = await engineOver(sceneNetwork());
    const listed = async () => {
      const result = ok(await engine.handle(command("runs.list")));
      if (result.type !== "runs.list") throw new Error("expected a list");
      return result.result.runs.find((r) => r.runId === RUN);
    };

    expect((await listed())?.launchId).toBe(LAUNCH);
    launches.finish(LAUNCH);
    expect((await listed())?.launchId).toBeUndefined();
  });

  test("scenes.get marks the set with its launch while the launch is unfinished, and not after", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId);
    const { engine, launches } = await engineOver(sceneNetwork());

    expect((await viewOf(engine, avatarId)).launchId).toBe(LAUNCH);
    launches.finish(LAUNCH);
    expect((await viewOf(engine, avatarId)).launchId).toBeUndefined();
  });
});

// ---------- slices through the engine ----------

describe("drawLaunchSlice", () => {
  test("draws a slice into a run whose cap is the images-only worst case of its scenes, and marks the run with the launch", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3, 4, 5, 6] } });
    const { engine } = await engineOver(sceneNetwork());

    const drawn = await engine.drawLaunchSlice({ sceneSetId: SET, launchId: LAUNCH, size: 4, drawMicros: 10_000_000 });

    if (drawn.kind !== "drawn") throw new Error(`expected a slice, got ${drawn.kind}`);
    expect(drawn).toMatchObject({ runId: RUN, sceneIds: [1, 2, 3, 4], created: true });
    expect(drawn.capMicros).toBeGreaterThan(0);
    const listed = ok(await engine.handle(command("runs.list")));
    if (listed.type !== "runs.list") throw new Error("expected a list");
    expect(listed.result.runs.find((r) => r.runId === RUN)).toMatchObject({ launchId: LAUNCH, total: 4, capMicros: drawn.capMicros });
    expect((await viewOf(engine, avatarId)).status).toBe("used");
  });

  test("says no room when the draw allocation cannot pay for one photo, and makes no run", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3] } });
    const { engine } = await engineOver(sceneNetwork());

    const drawn = await engine.drawLaunchSlice({ sceneSetId: SET, launchId: LAUNCH, size: 3, drawMicros: 1 });

    expect(drawn.kind).toBe("no-room");
    expect((await viewOf(engine, avatarId)).status).not.toBe("used");
  });
});

// ---------- unlink on a stop ----------

describe("unlinkLaunchSet", () => {
  test("a set that is composing waits for the soft stop to end, then is unlinked", async () => {
    const avatarId = await seedAvatar();
    const second = held();
    const net = sceneNetwork({ writer: (call, n) => (n === 1 ? second.handler(call, n) : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    const { jobId } = await engine.composeLaunchSet(composeBody(avatarId, { count: 10 }) as never, internal() as never);
    if (jobId === null) throw new Error("expected a job");
    await until(() => second.arrived() === 1, "the writer's request");
    expect(engine.softStopScenes(SET)).toBe(true);
    let unlinked = false;
    const unlinking = engine.unlinkLaunchSet(SET).then((result) => {
      unlinked = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(unlinked).toBe(false);
    expect(setFile(avatarId).launchId).toBe(LAUNCH);

    second.release();
    await jobEnd(events, jobId);
    const result = await unlinking;

    expect(result.phase).toBe("awaiting");
    expect(setFile(avatarId).launchId).toBeUndefined();
    expect(ledgerReserves().every((id) => id.startsWith(`${SET}:writer-`))).toBe(true);
    ok(await engine.handle(command("scenes.discard", { sceneSetId: SET })));
  });

  test("a set awaiting review is unlinked and is then the avatar's ordinary open set", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId);
    const { engine } = await engineOver(sceneNetwork());

    const result = await engine.unlinkLaunchSet(SET);

    expect(result.phase).toBe("awaiting");
    expect((await viewOf(engine, avatarId)).launchId).toBeUndefined();
    ok(await engine.handle(command("scenes.edit", { sceneSetId: SET, revision: 2, op: { op: "remove", sceneIds: [1] } })));
  });

  test("an approved set with no slice folder has its draw and launch id cleared (revision + 1): edits, discard and runs.startFromScenes are accepted", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3, 4, 5, 6] } });
    const { engine, launches } = await engineOver(sceneNetwork());
    expect(launches.isUnfinished(LAUNCH)).toBe(true);

    const result = await engine.unlinkLaunchSet(SET);

    expect(result.phase).toBe("approved");
    const file = setFile(avatarId);
    expect(file.launchId).toBeUndefined();
    expect(file.launchDraw).toBeUndefined();
    expect(file.revision).toBe(2);
    // The launch is still unfinished in the lookup: it is the cleared set, not the lookup, that frees the avatar.
    ok(await engine.handle(command("scenes.edit", { sceneSetId: SET, revision: 2, op: { op: "remove", sceneIds: [1] } })));
    expect(isLaunchSet(await engine.handle(command("runs.startFromScenes", { sceneSetId: SET, revision: 3, acceptedWorstMicros: 1 })))).toBe(false);
    ok(await engine.handle(command("scenes.discard", { sceneSetId: SET })));
  });

  test("a set drawn in part stays used and its runs become manual: resume and cancel are accepted while the lookup still says the launch is unfinished", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3, 4, 5, 6], slices: [{ runId: RUN, sceneIds: [1, 2, 3], capMicros: 150_000 }] } });
    await seedSliceRun(avatarId, [1, 2, 3]);
    const { engine } = await engineOver(sceneNetwork());
    expect(refusal(await engine.handle(command("runs.cancel", { runId: RUN })))).toEqual(LAUNCH_SET);

    const result = await engine.unlinkLaunchSet(SET);

    expect(result.phase).toBe("drawn");
    expect((await viewOf(engine, avatarId)).status).toBe("used");
    ok(await engine.handle(command("runs.cancel", { runId: RUN })));
    expect(isLaunchSet(await engine.handle(command("runs.resume", { runId: RUN, acceptedWorstMicros: 1 })))).toBe(false);
  });
});

// ---------- fix round 1 ----------

/** A launch store that reads `<library>/autopilot/` only once it is handed the opened library, as S4.6a's will: it cannot know the launches before. */
class LearnsAtOpen extends MemoryLaunches {
  override hasUnfinished(library?: Library): boolean {
    if (library === undefined) return false;
    this.add(LAUNCH);
    return true;
  }
}

async function seedApprovedSet(avatarId: string, count = 6): Promise<void> {
  await seedSet(avatarId, { count, draw: { sceneIds: Array.from({ length: count }, (_, i) => i + 1) } });
}

describe("the registry across a library's lifetime", () => {
  test("confirming the live library again under another spelling of its path keeps the links made at runtime", async () => {
    const avatarId = await seedAvatar();
    await seedApprovedSet(avatarId);
    const { engine } = await engineOver(sceneNetwork());
    const drawn = await engine.drawLaunchSlice({ sceneSetId: SET, launchId: LAUNCH, size: 3, drawMicros: 10_000_000 });
    expect(drawn.kind).toBe("drawn");
    expect(refusal(await engine.handle(command("runs.cancel", { runId: RUN })))).toEqual(LAUNCH_SET);

    const spelled = `${libraryDir()}/`;
    await engine.receive({ kind: "control", type: "library.open", callId: "call-open-0001", path: spelled });
    await engine.receive({ kind: "control", type: "library.confirm", callId: "call-confirm-0001", path: spelled });

    expect(refusal(await engine.handle(command("runs.cancel", { runId: RUN })))).toEqual(LAUNCH_SET);
    expect(refusal(await engine.handle(command("runs.resume", { runId: RUN, acceptedWorstMicros: 1 })))).toEqual(LAUNCH_SET);
  });

  test("after a restart the slice of a launch the store only learns of once the library is open still refuses a resume", async () => {
    const avatarId = await seedAvatar();
    await seedApprovedSet(avatarId);
    const first = await engineOver(sceneNetwork());
    expect((await first.engine.drawLaunchSlice({ sceneSetId: SET, launchId: LAUNCH, size: 3, drawMicros: 10_000_000 })).kind).toBe("drawn");
    await first.engine.shutdown();

    const second = await engineOver(sceneNetwork(), new LearnsAtOpen());

    expect(refusal(await second.engine.handle(command("runs.resume", { runId: RUN, acceptedWorstMicros: 1 })))).toEqual(LAUNCH_SET);
    expect(refusal(await second.engine.handle(command("runs.cancel", { runId: RUN })))).toEqual(LAUNCH_SET);
  });
});

describe("unlinking a set drawn in part", () => {
  test("leaves its remaining scenes undrawable by hand: start, «Дописать», discard and edit all refuse as set-used", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 6, written: 6, composeRecorded: true, draw: { sceneIds: [1, 2, 3, 4], slices: [{ runId: RUN, sceneIds: [1, 2], capMicros: 100_000 }] } });
    await seedSliceRun(avatarId, [1, 2]);
    const { engine } = await engineOver(sceneNetwork());
    expect((await engine.unlinkLaunchSet(SET)).phase).toBe("drawn");
    const revision = (await viewOf(engine, avatarId)).revision;
    const SET_USED = { code: "VALIDATION", sceneReason: "set-used" } as const;

    expect(refusal(await engine.handle(command("runs.startFromScenes", { sceneSetId: SET, revision, acceptedWorstMicros: 1 })))).toEqual(SET_USED);
    expect(refusal(await engine.handle(command("scenes.write", { sceneSetId: SET, revision, target: { kind: "unwritten" }, acceptedWorstMicros: 1 })))).toEqual(SET_USED);
    expect(refusal(await engine.handle(command("scenes.discard", { sceneSetId: SET })))).toEqual(SET_USED);
    expect(refusal(await engine.handle(command("scenes.edit", { sceneSetId: SET, revision, op: { op: "remove", sceneIds: [3] } })))).toEqual(SET_USED);
  });
});

describe("the slice statuses the draw allocation is counted from", () => {
  const SLICE_CAP = 300_000;
  const DRAW = 520_000;

  /** Slice 1 (scenes 1-3, entry cap SLICE_CAP) exists on disk; `closed` closes its slots and settles it at 50 000 µ$, below its cap. */
  async function sliceOne(closed: boolean): Promise<void> {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { draw: { sceneIds: [1, 2, 3, 4, 5, 6], slices: [{ runId: RUN, sceneIds: [1, 2, 3], capMicros: SLICE_CAP }] } });
    await seedSliceRun(avatarId, [1, 2, 3]);
    const { library } = await openLibrary(libraryDir(), { now: steppingClock() });
    if (closed) {
      for (const slotIndex of [1, 2, 3]) await library.appendJournal(RUN, { type: "slot", slotIndex, status: "failed", error: { code: "MODERATION_REFUSED" }, at: "2026-10-07T12:00:00.000Z" }, RunEventSchema);
      await writeLedger(dir(), [
        { type: "reserve", attemptId: `${RUN}:slot-1#1`, jobId: "job-seed-0001", scope: { runId: RUN }, model: "x-ai/grok-imagine-image-2.0", worstMicros: 100_000, at: "2026-10-07T12:00:00.000Z" },
        { type: "settle", attemptId: `${RUN}:slot-1#1`, costMicros: 50_000, estimated: false, at: "2026-10-07T12:00:00.000Z" },
      ]);
    }
  }

  const next = async (engine: Eng) => engine.drawLaunchSlice({ sceneSetId: SET, launchId: LAUNCH, size: 3, drawMicros: DRAW });

  test("a slice whose slots are all closed and that settled below its cap gives the slack back: the next slice sees draw minus committed", async () => {
    await sliceOne(true);
    const { engine } = await engineOver(sceneNetwork());

    const drawn = await next(engine);

    expect(drawn).toMatchObject({ kind: "drawn", sceneIds: [4, 5, 6] });
  });

  test("a slice with an open slot keeps its whole cap held", async () => {
    await sliceOne(false);
    const { engine } = await engineOver(sceneNetwork());

    const drawn = await next(engine);

    expect(drawn.kind === "drawn" ? drawn.sceneIds.length : 0).toBeLessThan(3);
  });

  test("a slice whose plan cannot be read keeps its whole cap held", async () => {
    await sliceOne(true);
    await writeFile(join(libraryDir(), "runs", RUN, "plan.json"), "{ not json");
    const { engine } = await engineOver(sceneNetwork());

    const drawn = await next(engine);

    expect(drawn.kind === "drawn" ? drawn.sceneIds.length : 0).toBeLessThan(3);
  });
});
