import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventMessage, ResponseMessage, SceneSetView } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import { chatBody, fakeFetch, imageBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { plannedSlots, RunPlanSchema, type RunPlan } from "./runs/plan";
import { command, engineSettings, failed, GOOD, jobEnd, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// CS.5: a run made from a reviewed scene set, against a real engine over a real ledger and library in a temp dir and a fake OpenRouter. The set's sentences
// were written and paid for before; approving it draws images only. Everything here is offline.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-scenes-runs-");
const libraryDir = () => join(dir(), "library");

const SET = "set-seed-0001";
const RUN = "run-seed-0001";
const POSES = { profile: false, back: false };
/** One image attempt at the fallback prices (the low 1K price plus one reference). */
const IMAGE = 50_000;
/** What the owner's own words say, so a test can tell the set's sentence from the planner's. */
const OWN_TEXT = "She sips coffee on a balcony, one hand free.";
const TYPED = "She laughs at a friend's joke while stirring a coffee by the big window.";

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
  /** Scene ids the owner removed. */
  removed?: number[];
  /** Scene ids left with no text. */
  textless?: number[];
  /** A scene given a text of this many characters (a writer's sentence has no upper bound). */
  longText?: { sceneId: number; length: number };
  /** Scene 2 belongs to a custom category the library never held (it was deleted); the set keeps its own snapshot. */
  customScene?: boolean;
  /** One own scene (written from an idea, CS.4b) after the planned ones, with the id `count + 1`. */
  own?: boolean;
  sceneSetId?: string;
  runId?: string;
}

/** A reviewed set on disk: every scene written (as a finished compose leaves it), some removed or left empty. */
async function seedSet(avatarId: string, options: SeedOptions = {}): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
  const sceneSetId = options.sceneSetId ?? SET;
  const count = options.count ?? 5;
  const set = sampleSet({ sceneSetId, avatarId, runId: options.runId ?? RUN, count, written: count });
  const long = options.longText;
  await library.sceneSets.create({
    ...set,
    ...(options.customScene === true ? { request: { ...set.request, categories: ["home" as const, "cat-paris-cafes" as const] }, categories: [{ ref: "cat-paris-cafes" as const, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" as const }] } : {}),
    scenes: [
      ...set.scenes.map((s) => ({
        ...s,
        removed: (options.removed ?? []).includes(s.sceneId),
        text: (options.textless ?? []).includes(s.sceneId) ? null : long?.sceneId === s.sceneId ? `${"A friend laughs while the morning light moves over the table. ".repeat(20).slice(0, long.length - 1)}.` : s.text,
        ...(options.customScene === true && s.sceneId === 2 ? { slot: { ...s.slot, category: "cat-paris-cafes" as const, location: "a corner cafe in Paris", timeOfDay: "morning", activity: "reading a menu", outfit: "a beige trench coat and jeans" } } : {}),
      })),
      ...(options.own === true ? [{ sceneId: count + 1, origin: "own" as const, idea: "кофе на балконе утром", shot: "selfie" as const, pose: "three-quarter" as const, text: OWN_TEXT, edited: false, removed: false }] : []),
    ],
  });
  return sceneSetId;
}

function isWriter(call: FetchCall): boolean {
  return call.url.endsWith("/chat/completions") && JSON.stringify(call.json().response_format ?? {}).includes("scene_sentences");
}

const goodImage: Handler = () => ({ status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) });

/** A fake OpenRouter: image requests take `image` (default: a good photo), prices are offline (the fallback table), and any writer request is recorded. */
function network(opts: { image?: Handler; prices?: (call: FetchCall) => Reply | Promise<Reply> } = {}) {
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return (opts.image ?? goodImage)(call, ++images);
    if (call.url.endsWith("/chat/completions")) return { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.001 }) };
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return opts.prices === undefined ? OFFLINE : opts.prices(call);
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    writerCalls: () => net.calls.filter(isWriter),
    chatCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions")),
    paidCalls: () => net.calls.filter((c) => c.method === "POST"),
    ageCalls: () => [],
    descriptorCalls: () => [],
  };
}

function engineOver(net: ReturnType<typeof network>, opts: { key?: string | null; settings?: Parameters<typeof engineSettings>[1]; withFaceGate?: boolean } = {}) {
  const deps = opts.withFaceGate === false ? {} : { qaGates: [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }] };
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", ...opts.settings }) },
    net,
    ...(opts.key === undefined ? {} : { key: opts.key }),
    deps,
  });
}
type Engine = Awaited<ReturnType<typeof engineOver>>["engine"];

const estimateCommand = (revision: number, sceneSetId = SET) => command("runs.estimateFromScenes", { sceneSetId, revision });
const startCommand = (revision: number, acceptedWorstMicros: number, sceneSetId = SET) => command("runs.startFromScenes", { sceneSetId, revision, acceptedWorstMicros });
const edit = (revision: number, op: unknown, sceneSetId = SET) => command("scenes.edit", { sceneSetId, revision, op });
const code = (response: ResponseMessage) => failed(response).error.code;

function estimateOf(response: ResponseMessage): { expectedMicros: number; worstMicros: number } {
  const result = ok(response);
  if (result.type !== "runs.estimateFromScenes") throw new Error(`expected an estimate, got ${result.type}`);
  return result.result.estimate;
}

function startedOf(response: ResponseMessage): { runId: string; jobId: string } {
  const result = ok(response);
  if (result.type !== "runs.startFromScenes") throw new Error(`expected a start, got ${result.type}`);
  return result.result;
}

async function setOf(engine: Engine, avatarId: string): Promise<SceneSetView> {
  const result = ok(await engine.handle(command("scenes.get", { avatarId })));
  if (result.type !== "scenes.get" || result.result.sceneSet === null) throw new Error("the avatar has no scene set");
  return result.result.sceneSet;
}

async function edited(engine: Engine, revision: number, op: unknown): Promise<number> {
  const result = ok(await engine.handle(edit(revision, op)));
  if (result.type !== "scenes.edit" || !("sceneSet" in result.result)) throw new Error("expected the set");
  return result.result.sceneSet.revision;
}

function planFile(runId = RUN): string {
  return join(libraryDir(), "runs", runId, "plan.json");
}
const planOf = (runId = RUN): RunPlan => RunPlanSchema.parse(JSON.parse(readFileSync(planFile(runId), "utf8")));
const runFolders = (): string[] => (existsSync(join(libraryDir(), "runs")) ? readdirSync(join(libraryDir(), "runs")) : []);

function ledgerLines(): Record<string, unknown>[] {
  const path = join(dir(), "userData", "ledger.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
const reserves = (): string[] => ledgerLines().flatMap((l) => (l.type === "reserve" ? [String(l.attemptId)] : []));

function changes(events: () => EventMessage[]): SceneSetView[] {
  return events().flatMap((e) => (e.type === "scenes.changed" && e.payload.change === "upserted" ? [e.payload.sceneSet] : []));
}

/** The prices GET held until `release`: a start waiting on it is in its «awaits prices» window. */
function heldPrices() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  return {
    prices: async (): Promise<Reply> => {
      asked = true;
      await gate;
      return OFFLINE;
    },
    release,
    asked: () => asked,
  };
}

/** Nothing was spent, written or sent. */
function expectNothingHappened(net: ReturnType<typeof network>): void {
  expect(net.paidCalls()).toHaveLength(0);
  expect(reserves()).toEqual([]);
  expect(runFolders()).toEqual([]);
}

// ---------- runs.estimateFromScenes ----------

describe("runs.estimateFromScenes", () => {
  test("is M photos with no writer term: the active scenes with text, three attempts each at the dearest image", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, removed: [2] });
    const net = network();
    const { engine } = await engineOver(net);
    const estimate = estimateOf(await engine.handle(estimateCommand((await setOf(engine, avatarId)).revision)));

    expect(estimate.worstMicros).toBe(4 * 3 * IMAGE);
    expect(estimate.expectedMicros).toBe(4 * IMAGE);
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("falls when a scene is removed and rises when it is restored, by exactly its three attempts", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5 });
    const { engine } = await engineOver(network());
    let revision = (await setOf(engine, avatarId)).revision;
    expect(estimateOf(await engine.handle(estimateCommand(revision))).worstMicros).toBe(5 * 3 * IMAGE);
    revision = await edited(engine, revision, { op: "remove", sceneIds: [1] });
    expect(estimateOf(await engine.handle(estimateCommand(revision))).worstMicros).toBe(4 * 3 * IMAGE);
    revision = await edited(engine, revision, { op: "restore", sceneIds: [1] });
    expect(estimateOf(await engine.handle(estimateCommand(revision))).worstMicros).toBe(5 * 3 * IMAGE);
  });

  test("an age check on adds a check to every attempt", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 4 });
    const off = await engineOver(network());
    const offWorst = estimateOf(await off.engine.handle(estimateCommand((await setOf(off.engine, avatarId)).revision))).worstMicros;
    const on = await engineOver(network(), { settings: { imageAgeCheck: "on" } });
    const onWorst = estimateOf(await on.engine.handle(estimateCommand((await setOf(on.engine, avatarId)).revision))).worstMicros;
    expect(onWorst).toBeGreaterThan(offWorst);
    expect((onWorst - offWorst) % (4 * 3)).toBe(0);
  });

  test("follows the settings' image quality, not anything the set holds", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 4 });
    const low = await engineOver(network());
    const lowWorst = estimateOf(await low.engine.handle(estimateCommand((await setOf(low.engine, avatarId)).revision))).worstMicros;
    const high = await engineOver(network(), { settings: { imageQuality: "medium" } });
    const highWorst = estimateOf(await high.engine.handle(estimateCommand((await setOf(high.engine, avatarId)).revision))).worstMicros;
    expect(highWorst).toBeGreaterThan(lowWorst);
  });

  describe("prices", () => {
    /** Live endpoints for any image model asked about, and a /models list that holds none of the chat models Studio might use. */
    const liveImagesOnly = (call: FetchCall): Reply => {
      if (call.url.endsWith("/models")) return { status: 200, body: { data: [{ id: "acme/other", pricing: { prompt: "0.000001", completion: "0.000002" } }] } };
      const id = /\/images\/models\/(.+)\/endpoints$/.exec(call.url)?.[1];
      if (id === undefined) throw new Error(`unexpected request to ${call.url}`);
      return { status: 200, body: { id, endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.05 }, { billable: "input_image", unit: "image", cost_usd: 0.01 }] }] } };
    };

    test("a text model nobody lists does not block an images-only run: no writer, no text price", async () => {
      const avatarId = await seedAvatar();
      await seedSet(avatarId, { count: 5 });
      const { engine } = await engineOver(network(), { settings: { textModel: "acme/unlisted-text" } });
      expect(estimateOf(await engine.handle(estimateCommand((await setOf(engine, avatarId)).revision))).worstMicros).toBe(5 * 3 * IMAGE);
    });

    test("the prices are live when the images' are, whatever became of the text model's", async () => {
      const avatarId = await seedAvatar();
      await seedSet(avatarId, { count: 5 });
      const { engine } = await engineOver(network({ prices: liveImagesOnly }));
      const result = ok(await engine.handle(estimateCommand((await setOf(engine, avatarId)).revision)));
      if (result.type !== "runs.estimateFromScenes") throw new Error("expected an estimate");
      expect(result.result.estimate.prices).toBe("live");
    });
  });

  describe("refuses for free, in order", () => {
    async function ready(opts: SeedOptions = {}) {
      const avatarId = await seedAvatar();
      await seedSet(avatarId, opts);
      const net = network();
      const { engine } = await engineOver(net);
      return { engine, net, revision: (await setOf(engine, avatarId)).revision, avatarId };
    }

    test("a revision that moved is SCENES_CHANGED, before anything else is looked at", async () => {
      const { engine, net, revision } = await ready({ textless: [1] });
      expect(code(await engine.handle(estimateCommand(revision + 1)))).toBe("SCENES_CHANGED");
      expectNothingHappened(net);
    });

    test("an active scene with no text is VALIDATION", async () => {
      const { engine, net, revision } = await ready({ textless: [3] });
      expect(code(await engine.handle(estimateCommand(revision)))).toBe("VALIDATION");
      expectNothingHappened(net);
    });

    test("a scene with no text that the owner removed does not count", async () => {
      const { engine, revision } = await ready({ textless: [3], removed: [3] });
      expect(estimateOf(await engine.handle(estimateCommand(revision))).worstMicros).toBe(4 * 3 * IMAGE);
    });

    test("no active scene at all is VALIDATION", async () => {
      const { engine, net, revision } = await ready({ count: 3, removed: [1, 2, 3] });
      expect(code(await engine.handle(estimateCommand(revision)))).toBe("VALIDATION");
      expectNothingHappened(net);
    });

    test("more than 100 active scenes is VALIDATION", async () => {
      const { engine, net, revision } = await ready({ count: 101 });
      expect(code(await engine.handle(estimateCommand(revision)))).toBe("VALIDATION");
      expectNothingHappened(net);
    });

    test("exactly 100 active scenes is allowed", async () => {
      const { engine, revision } = await ready({ count: 101, removed: [101] });
      expect(estimateOf(await engine.handle(estimateCommand(revision))).worstMicros).toBe(100 * 3 * IMAGE);
    });

    test("a set already used is VALIDATION", async () => {
      const { engine, net, revision } = await ready();
      const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("u") });
      await library.createRun(RUN, { n: 1 }, (await import("zod")).z.object({ n: (await import("zod")).z.number() }));
      expect(code(await engine.handle(estimateCommand(revision)))).toBe("VALIDATION");
      expect(net.paidCalls()).toHaveLength(0);
    });

    test("a set nobody has is NOT_FOUND", async () => {
      const { engine } = await ready();
      expect(code(await engine.handle(estimateCommand(1, "set-nobody-0404")))).toBe("NOT_FOUND");
    });
  });
});

// ---------- runs.startFromScenes ----------

describe("runs.startFromScenes", () => {
  async function ready(opts: SeedOptions = {}, engineOpts: Parameters<typeof engineOver>[1] = {}, net = network()) {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, opts);
    const started = await engineOver(net, engineOpts);
    return { ...started, net, avatarId, revision: (await setOf(started.engine, avatarId)).revision };
  }

  test("writes a plan of exactly the active scenes in order, renumbered, with their sentences, and no writer chunks", async () => {
    const { engine, events, net, avatarId, revision: first } = await ready({ count: 5 });
    let revision = await edited(engine, first, { op: "text", sceneId: 1, text: TYPED });
    revision = await edited(engine, revision, { op: "remove", sceneIds: [2] });
    const set = await setOf(engine, avatarId);
    const { runId, jobId } = startedOf(await engine.handle(startCommand(revision, 4 * 3 * IMAGE)));
    await jobEnd(events, jobId);

    expect(runId).toBe(RUN);
    const plan = planOf();
    expect(plan.sceneSetId).toBe(SET);
    expect(plan.sceneIds).toEqual([1, 3, 4, 5]);
    expect(plan.scenes.slots.map((s) => s.slotIndex)).toEqual([1, 2, 3, 4]);
    expect<unknown>(plan.scenes.slots.map((s) => s.sentence)).toEqual([TYPED, ...[3, 4, 5].map((id) => set.scenes.find((s) => s.sceneId === id)?.text)]);
    expect<unknown>(plannedSlots(plan).map((s) => s.location)).toEqual([1, 3, 4, 5].map((id) => set.scenes.find((s) => s.sceneId === id)?.place?.location));
    expect(plan.writerChunks).toEqual([]);
    expect(plan.request).toBeUndefined();
    expect(net.writerCalls()).toHaveLength(0);
  });

  test("fixes the cap once: the accepted worst case for exactly the approved scenes, whatever more was accepted", async () => {
    const { engine, events, revision } = await ready({ count: 4 });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 5_000_000)));
    await jobEnd(events, jobId);
    const plan = planOf();
    expect(plan.capMicros).toBe(4 * 3 * IMAGE);
    expect(plan.plannedWorstMicros).toBe(4 * 3 * IMAGE);
  });

  test("draws one photo per approved scene and marks the set used, naming its run", async () => {
    const { engine, events, net, avatarId, revision } = await ready({ count: 5, removed: [2] });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 4 * 3 * IMAGE)));
    const done = await jobEnd(events, jobId);
    expect(done.type).toBe("job.done");
    expect(net.imageCalls()).toHaveLength(4);
    expect(net.writerCalls()).toHaveLength(0);
    expect(net.chatCalls()).toHaveLength(0);
    const set = await setOf(engine, avatarId);
    expect(set.status).toBe("used");
    expect(set.runId).toBe(RUN);
  });

  test("reserves image attempts only: no writer id is ever reserved", async () => {
    const { engine, events, revision } = await ready({ count: 3 });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 3 * 3 * IMAGE)));
    await jobEnd(events, jobId);
    expect(reserves()).toEqual([`${RUN}:slot-1#1`, `${RUN}:slot-2#1`, `${RUN}:slot-3#1`]);
  });

  test("sends no image before plan.json exists", async () => {
    const seen: boolean[] = [];
    const net = network({
      image: (call, n) => {
        seen.push(existsSync(planFile()));
        return goodImage(call, n);
      },
    });
    const { engine, events, revision } = await ready({ count: 3 }, {}, net);
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 3 * 3 * IMAGE)));
    await jobEnd(events, jobId);
    expect(seen).toEqual([true, true, true]);
  });

  test("captures the settings' camera realism and age-check mode in the plan, as a start does", async () => {
    const { engine, events, revision } = await ready({ count: 2 }, { settings: { cameraRealism: true } });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
    await jobEnd(events, jobId);
    expect(planOf()).toMatchObject({ cameraRealism: true, imageAgeCheck: "off" });
  });

  test("a price above what the owner accepted is PRICE_CHANGED, free, and writes nothing", async () => {
    const { engine, net, revision } = await ready({ count: 4 });
    expect(code(await engine.handle(startCommand(revision, 4 * 3 * IMAGE - 1)))).toBe("PRICE_CHANGED");
    expectNothingHappened(net);
  });

  test("a missing key is refused free, and writes nothing", async () => {
    const { engine, net, revision } = await ready({ count: 2 }, { key: null });
    expect(failed(await engine.handle(startCommand(revision, 10_000_000))).error.code).not.toBe("INTERNAL");
    expectNothingHappened(net);
  });

  describe("refuses for free, in order, writing nothing", () => {
    test("a revision that moved: SCENES_CHANGED", async () => {
      const { engine, net, revision } = await ready({ count: 3, textless: [1] });
      expect(code(await engine.handle(startCommand(revision + 1, 10_000_000)))).toBe("SCENES_CHANGED");
      expectNothingHappened(net);
    });

    test("an active scene with no text: VALIDATION", async () => {
      const { engine, net, revision } = await ready({ count: 3, textless: [2] });
      expect(code(await engine.handle(startCommand(revision, 10_000_000)))).toBe("VALIDATION");
      expectNothingHappened(net);
    });

    test("no active scene, or more than 100: VALIDATION", async () => {
      const none = await ready({ count: 2, removed: [1, 2] });
      expect(code(await none.engine.handle(startCommand(none.revision, 10_000_000)))).toBe("VALIDATION");
      expectNothingHappened(none.net);
    });

    test("more than 100 active scenes: VALIDATION", async () => {
      const many = await ready({ count: 101 });
      expect(code(await many.engine.handle(startCommand(many.revision, 100_000_000)))).toBe("VALIDATION");
      expectNothingHappened(many.net);
    });

    test("a job of the avatar running: IN_FLIGHT, and the running job is not disturbed", async () => {
      const net = network({ image: () => ({ hang: true }) });
      const avatarId = await seedAvatar();
      await seedSet(avatarId, { count: 2 });
      const { engine, events } = await engineOver(net);
      const run = ok(await engine.handle(command("runs.start", { avatarId, count: 1, categories: ["home"], poses: POSES, acceptedWorstMicros: 10_000_000 })));
      if (run.type !== "runs.start") throw new Error("expected a run");
      const revision = (await setOf(engine, avatarId)).revision;
      const before = runFolders();
      expect(code(await engine.handle(startCommand(revision, 10_000_000)))).toBe("IN_FLIGHT");
      expect(runFolders()).toEqual(before);
      ok(await engine.handle(command("runs.cancel", { runId: run.result.runId })));
      await jobEnd(events, run.result.jobId);
    });

    test("a set already used: VALIDATION, and no second run", async () => {
      const { engine, events, revision } = await ready({ count: 2 });
      const { jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
      await jobEnd(events, jobId);
      const folders = runFolders();
      expect(code(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)))).toBe("VALIDATION");
      expect(runFolders()).toEqual(folders);
    });

    test("a set nobody has: NOT_FOUND", async () => {
      const { engine } = await ready({ count: 2 });
      expect(code(await engine.handle(startCommand(1, 10_000_000, "set-nobody-0404")))).toBe("NOT_FOUND");
    });
  });

  describe("the approval race", () => {
    test("an edit that lands while the start awaits the prices: SCENES_CHANGED, nothing written, nothing sent", async () => {
      const held = heldPrices();
      const net = network({ prices: held.prices });
      const { engine, avatarId, revision } = await ready({ count: 4 }, {}, net);
      const starting = engine.handle(startCommand(revision, 4 * 3 * IMAGE));
      await until(() => held.asked(), "the price request");

      await edited(engine, revision, { op: "text", sceneId: 2, text: TYPED });
      held.release();

      expect(code(await starting)).toBe("SCENES_CHANGED");
      expectNothingHappened(net);
      const set = await setOf(engine, avatarId);
      expect(set.status).not.toBe("used");
      expect(set.scenes.find((s) => s.sceneId === 2)?.text).toBe(TYPED);
    });

    test("a removal that lands while the start awaits the prices: SCENES_CHANGED, so what is drawn is never what was not shown", async () => {
      const held = heldPrices();
      const net = network({ prices: held.prices });
      const { engine, revision } = await ready({ count: 4 }, {}, net);
      const starting = engine.handle(startCommand(revision, 4 * 3 * IMAGE));
      await until(() => held.asked(), "the price request");
      await edited(engine, revision, { op: "remove", sceneIds: [4] });
      held.release();
      expect(code(await starting)).toBe("SCENES_CHANGED");
      expectNothingHappened(net);
    });

    test("a discard that lands while the start awaits the prices: NOT_FOUND, nothing written, nothing sent", async () => {
      const held = heldPrices();
      const net = network({ prices: held.prices });
      const { engine, avatarId } = await ready({ count: 4 }, {}, net);
      const revision = (await setOf(engine, avatarId)).revision;
      const starting = engine.handle(startCommand(revision, 4 * 3 * IMAGE));
      await until(() => held.asked(), "the price request");
      ok(await engine.handle(command("scenes.discard", { sceneSetId: SET })));
      held.release();
      expect(code(await starting)).toBe("NOT_FOUND");
      expectNothingHappened(net);
    });

    test("an edit, then a discard, while the start awaits: the start refuses and writes nothing", async () => {
      const held = heldPrices();
      const net = network({ prices: held.prices });
      const { engine, revision } = await ready({ count: 4 }, {}, net);
      const starting = engine.handle(startCommand(revision, 4 * 3 * IMAGE));
      await until(() => held.asked(), "the price request");
      const next = await edited(engine, revision, { op: "remove", sceneIds: [1] });
      expect(next).toBeGreaterThan(revision);
      ok(await engine.handle(command("scenes.discard", { sceneSetId: SET })));
      held.release();
      expect(["SCENES_CHANGED", "NOT_FOUND"]).toContain(code(await starting));
      expectNothingHappened(net);
    });

    test("the avatar is free again after a refused start: its claim is released", async () => {
      const held = heldPrices();
      const net = network({ prices: held.prices });
      const { engine, events, revision } = await ready({ count: 2 }, {}, net);
      const starting = engine.handle(startCommand(revision, 2 * 3 * IMAGE));
      await until(() => held.asked(), "the price request");
      const next = await edited(engine, revision, { op: "remove", sceneIds: [1] });
      held.release();
      expect(code(await starting)).toBe("SCENES_CHANGED");
      const { jobId } = startedOf(await engine.handle(startCommand(next, 1 * 3 * IMAGE)));
      await jobEnd(events, jobId);
    });

    test("a run folder that appears while the start awaits is not overwritten: the start refuses and the folder stays as it was", async () => {
      const held = heldPrices();
      const net = network({ prices: held.prices });
      const { engine, revision } = await ready({ count: 2 }, {}, net);
      const starting = engine.handle(startCommand(revision, 2 * 3 * IMAGE));
      await until(() => held.asked(), "the price request");
      const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("u") });
      const { z } = await import("zod");
      await library.createRun(RUN, { n: 7 }, z.object({ n: z.number() }));
      held.release();
      expect(code(await starting)).toBe("VALIDATION");
      expect(JSON.parse(readFileSync(planFile(), "utf8"))).toEqual({ n: 7 });
      expect(net.paidCalls()).toHaveLength(0);
    });

    test("an edit or a discard after the run exists is refused, so nothing the owner sees can differ from what is drawn", async () => {
      const net = network({ image: () => ({ hang: true }) });
      const { engine, events, avatarId, revision } = await ready({ count: 3 }, {}, net);
      const { runId, jobId } = startedOf(await engine.handle(startCommand(revision, 3 * 3 * IMAGE)));
      const used = await setOf(engine, avatarId);
      expect(used.status).toBe("used");
      expect(code(await engine.handle(edit(used.revision, { op: "remove", sceneIds: [1] })))).toBe("VALIDATION");
      expect(code(await engine.handle(command("scenes.discard", { sceneSetId: SET })))).toBe("VALIDATION");
      expect(planOf(runId).scenes.slots).toHaveLength(3);
      ok(await engine.handle(command("runs.cancel", { runId })));
      await jobEnd(events, jobId);
    });
  });

  test("a 700-char writer sentence in the set reaches plan.json and the image prompt whole", async () => {
    const { engine, events, net, revision } = await ready({ count: 2, longText: { sceneId: 1, length: 700 } });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
    await jobEnd(events, jobId);
    const sentence = planOf().scenes.slots[0]?.sentence ?? "";
    expect(sentence).toHaveLength(700);
    expect(String(net.imageCalls()[0]?.json().prompt)).toContain(sentence.slice(0, -1));
  });

  test("a custom category the library no longer holds does not stop the run: the plan keeps the set's own snapshot, and the photo its name", async () => {
    const { engine, events, avatarId, revision } = await ready({ count: 3, customScene: true });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 3 * 3 * IMAGE)));
    await jobEnd(events, jobId);
    expect(planOf().categories).toEqual([{ ref: "cat-paris-cafes", name: "Кофейни Парижа", label: "Paris cafes", style: "phone" }]);
    const photos = ok(await engine.handle(command("photos.list", { avatarId })));
    if (photos.type !== "photos.list") throw new Error("expected the photos");
    const custom = photos.result.photos.find((p) => p.category === "cat-paris-cafes");
    expect(custom?.categoryName).toBe("Кофейни Парижа");
  });

  describe("an own scene", () => {
    const historyFile = (avatarId: string) => join(libraryDir(), "avatars", avatarId, "history.jsonl");
    const historyLines = (avatarId: string): string[] => (existsSync(historyFile(avatarId)) ? readFileSync(historyFile(avatarId), "utf8").split("\n").filter(Boolean) : []);

    test("is a slot of the plan with its shot, its pose and its sentence, after the planned ones", async () => {
      const { engine, events, revision } = await ready({ count: 3, own: true });
      const { jobId } = startedOf(await engine.handle(startCommand(revision, 4 * 3 * IMAGE)));
      await jobEnd(events, jobId);
      const plan = planOf();
      expect(plan.sceneIds).toEqual([1, 2, 3, 4]);
      expect(plan.scenes.slots[3]).toMatchObject({ kind: "own", slotIndex: 4, category: "own", shot: "selfie", pose: "three-quarter", sentence: OWN_TEXT });
      expect(plan.writerChunks).toEqual([]);
    });

    test("is drawn as a photo of the category own, with no writer request", async () => {
      const { engine, events, net, avatarId, revision } = await ready({ count: 3, own: true });
      const { jobId } = startedOf(await engine.handle(startCommand(revision, 4 * 3 * IMAGE)));
      expect((await jobEnd(events, jobId)).type).toBe("job.done");
      expect(net.imageCalls()).toHaveLength(4);
      expect(net.writerCalls()).toHaveLength(0);
      expect(net.chatCalls()).toHaveLength(0);
      const photos = ok(await engine.handle(command("photos.list", { avatarId })));
      if (photos.type !== "photos.list") throw new Error("expected the photos");
      expect(photos.result.photos.filter((p) => p.category === "own")).toHaveLength(1);
      expect(photos.result.photos.filter((p) => p.category === "home")).toHaveLength(3);
    });

    test("leaves no line in the avatar's history, which remembers the planned scenes only", async () => {
      const { engine, events, avatarId, revision } = await ready({ count: 3, own: true });
      const { jobId } = startedOf(await engine.handle(startCommand(revision, 4 * 3 * IMAGE)));
      await jobEnd(events, jobId);
      expect(historyLines(avatarId)).toHaveLength(3);
    });

    test("a set of one own scene is a run of one photo and no history", async () => {
      const { engine, events, net, avatarId, revision } = await ready({ count: 1, own: true, removed: [1] });
      const { jobId } = startedOf(await engine.handle(startCommand(revision, 3 * IMAGE)));
      await jobEnd(events, jobId);
      expect(planOf().sceneIds).toEqual([2]);
      expect(net.imageCalls()).toHaveLength(1);
      expect(historyLines(avatarId)).toEqual([]);
    });
  });

  test("a removed scene of a custom category leaves no snapshot in the plan", async () => {
    const { engine, events, revision } = await ready({ count: 3, customScene: true, removed: [2] });
    const { jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
    await jobEnd(events, jobId);
    expect(planOf().categories).toBeUndefined();
  });

  describe("no path approves a set twice", () => {
    test("a second start after the run ended is refused and makes no run", async () => {
      const { engine, events, revision } = await ready({ count: 2 });
      const { jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
      await jobEnd(events, jobId);
      const reservesBefore = reserves();
      expect(code(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)))).toBe("VALIDATION");
      expect(reserves()).toEqual(reservesBefore);
    });

    test("a second start while the run is still drawing is refused, not a second run", async () => {
      const net = network({ image: () => ({ hang: true }) });
      const { engine, events, avatarId, revision } = await ready({ count: 2 }, {}, net);
      const { runId, jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
      const used = await setOf(engine, avatarId);
      expect(["IN_FLIGHT", "VALIDATION"]).toContain(code(await engine.handle(startCommand(used.revision, 2 * 3 * IMAGE))));
      expect(runFolders()).toEqual([runId]);
      ok(await engine.handle(command("runs.cancel", { runId })));
      await jobEnd(events, jobId);
    });
  });

  describe("restart, cancel and resume", () => {
    test("a kill right after the run folder exists still reads the set as used, and lists the run as resumable", async () => {
      const net = network({ image: () => ({ hang: true }) });
      const { engine, avatarId, revision } = await ready({ count: 3 }, {}, net);
      const { runId } = startedOf(await engine.handle(startCommand(revision, 3 * 3 * IMAGE)));
      await until(() => net.imageCalls().length >= 1, "the first image request");
      // The engine process dies here (no cancel, no cleanup): a new one opens the same folders.
      const reopened = await engineOver(network());
      const set = await setOf(reopened.engine, avatarId);
      expect(set).toMatchObject({ status: "used", runId });
      const listed = ok(await reopened.engine.handle(command("runs.list", {})));
      if (listed.type !== "runs.list") throw new Error("expected the runs");
      expect(listed.result.runs.find((r) => r.runId === runId)).toMatchObject({ total: 3, open: 3 });
      void engine;
    });

    test("a cancel stops the run, runs.estimateResume prices the images left with no writer, and runs.resume draws them without one", async () => {
      let released = false;
      const net = network({ image: (call, n) => (n === 1 ? goodImage(call, n) : released ? goodImage(call, n) : { hang: true }) });
      const { engine, events, avatarId, revision } = await ready({ count: 3 }, {}, net);
      const { runId, jobId } = startedOf(await engine.handle(startCommand(revision, 3 * 3 * IMAGE)));
      await until(() => net.imageCalls().length >= 2, "the second image request");
      ok(await engine.handle(command("runs.cancel", { runId })));
      await jobEnd(events, jobId);

      const listed = ok(await engine.handle(command("runs.list", {})));
      if (listed.type !== "runs.list") throw new Error("expected the runs");
      const summary = listed.result.runs.find((r) => r.runId === runId);
      expect(summary).toMatchObject({ total: 3, done: 1, running: false });
      expect(summary?.capMicros).toBe(3 * 3 * IMAGE);

      const estimate = ok(await engine.handle(command("runs.estimateResume", { runId })));
      if (estimate.type !== "runs.estimateResume") throw new Error("expected an estimate");
      expect(estimate.result.estimate.worstMicros).toBeLessThanOrEqual(2 * 3 * IMAGE);

      released = true;
      const resumed = ok(await engine.handle(command("runs.resume", { runId, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
      if (resumed.type !== "runs.resume") throw new Error("expected a resume");
      await jobEnd(events, resumed.result.jobId);
      expect(net.writerCalls()).toHaveLength(0);
      expect(net.chatCalls()).toHaveLength(0);
      expect((await setOf(engine, avatarId)).status).toBe("used");
    });
  });

  describe("announcing the approval", () => {
    test("every window hears the set became used, naming its run, before any event of the run's job", async () => {
      const { engine, events, revision } = await ready({ count: 2 });
      const { runId, jobId } = startedOf(await engine.handle(startCommand(revision, 2 * 3 * IMAGE)));
      await jobEnd(events, jobId);
      const all = events();
      const usedAt = all.findIndex((e) => e.type === "scenes.changed" && e.payload.change === "upserted" && e.payload.sceneSet.status === "used" && e.payload.sceneSet.runId === runId);
      const firstJobEvent = all.findIndex((e) => e.type === "job.progress" || e.type === "job.done");
      expect(usedAt).toBeGreaterThanOrEqual(0);
      expect(usedAt).toBeLessThan(firstJobEvent);
    });

    test("a refused start announces nothing", async () => {
      const { engine, events, revision } = await ready({ count: 2, textless: [1] });
      const before = changes(events).length;
      expect(code(await engine.handle(startCommand(revision, 10_000_000)))).toBe("VALIDATION");
      expect(changes(events)).toHaveLength(before);
    });
  });
});
