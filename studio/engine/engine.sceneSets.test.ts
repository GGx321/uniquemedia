import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EngineReply } from "./control";
import { z } from "zod";
import type { EventMessage, ResponseMessage, SceneSetView } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import type { LedgerLine } from "./money/ledger";
import { chatBody, fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, failed, GOOD, jobEnd, NOW, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: the scene sets against a real engine over a real ledger and library in a temp dir; every request goes to a fake fetch (prices, and the scene writer's
// chat completions), nothing reaches the network. A scene set is an avatar's planned run held before any image is paid for: compose writes its sentences
// (a paid job, chunk by chunk), the owner edits for free, and «Дописать» writes what is still missing within the attempts each chunk has left.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-scene-sets-");
const libraryDir = () => join(dir(), "library");

/** One writer attempt at its ceilings (14K in, 8K out) at the fallback prices; two attempts for a chunk. */
const ATTEMPT = 37_500;
const SET = "set-seed-0001";
const RUN = "run-seed-0001";
const JOB = "job-seed-0001";
const AT = "2026-10-07T12:00:00.000Z";
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

type Started = Awaited<ReturnType<typeof startEngine>>;
type Engine = Started["engine"];
type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

let seeded = 0;

/** A saved, active avatar, as a picked candidate would be. */
async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

interface SeedOptions {
  count?: number;
  /** The first N scenes get a sentence, as written chunks would. */
  written?: number;
  write?: { k: number; kind: "compose" | "unwritten"; jobId: string; stoppedBy?: "cancelled" | "rate-limited" | "provider-error" | "network" | "timeout" };
  sceneSetId?: string;
  runId?: string;
}

/** A set on disk as a compose would have left it, before any call or after some. */
async function seedSet(avatarId: string, options: SeedOptions = {}): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
  const sceneSetId = options.sceneSetId ?? SET;
  const set = sampleSet({ sceneSetId, avatarId, runId: options.runId ?? RUN, count: options.count ?? 35, written: options.written ?? 0 });
  await library.sceneSets.create({ ...set, write: options.write ?? null, writes: options.write?.k ?? 0 });
  return sceneSetId;
}

const attemptId = (chunk: number, n: number, sceneSetId = SET) => `${sceneSetId}:writer-${chunk}#${n}`;

function reserve(id: string, jobId = JOB): LedgerLine {
  return { type: "reserve", attemptId: id, jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: ATTEMPT, at: AT };
}
function settle(id: string, costMicros: number, estimated = false): LedgerLine {
  return { type: "settle", attemptId: id, costMicros, estimated, at: AT };
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
const rejectedAnswer: Reply = { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) };
const refusal: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
const rateLimited: Reply = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };

/** A fake OpenRouter: the writer's chat calls take `writer` (by default: a good answer for the slots asked), price GETs are offline (the fallback table). */
function sceneNetwork(opts: { writer?: Handler; image?: Handler; prices?: (call: FetchCall) => Reply | Promise<Reply> } = {}) {
  let writes = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (isWriter(call)) return (opts.writer ?? goodAnswer)(call, ++writes);
    if (call.url.endsWith("/images")) return (opts.image ?? (() => ({ hang: true })))(call, 0);
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

function engineOver(net: ReturnType<typeof sceneNetwork>, opts: { key?: string | null; monthlyBudgetMicros?: number; clock?: () => number; withFaceGate?: boolean; beforeRename?: (path: string) => void; beforeRead?: (path: string) => void; beforeList?: (dir: string) => void } = {}) {
  const deps = {
    ...(opts.beforeRename === undefined && opts.beforeRead === undefined && opts.beforeList === undefined ? {} : { library: { testHooks: { ...(opts.beforeRename === undefined ? {} : { beforeRename: opts.beforeRename }), ...(opts.beforeRead === undefined ? {} : { beforeRead: opts.beforeRead }), ...(opts.beforeList === undefined ? {} : { beforeList: opts.beforeList }) } } }),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    // A photo run needs a wired face gate to start; a fake one that passes every photo is all a test of the avatar's claim needs.
    ...(opts.withFaceGate === true ? { qaGates: [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }] } : {}),
  };
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", ...(opts.monthlyBudgetMicros === undefined ? {} : { monthlyBudgetMicros: opts.monthlyBudgetMicros }) }) },
    net,
    ...(opts.key === undefined ? {} : { key: opts.key }),
    deps,
  });
}

/** A chat answer held until `release`, after the request has arrived. */
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

const POSES = { profile: false, back: false };
/** A run folder as `createRun` makes it: what a set's pre-issued run id becomes when its run starts. */
const RUN_SCHEMA = z.object({ n: z.number() });

function composeCommand(avatarId: string, over: Record<string, unknown> = {}): unknown {
  const count = typeof over.count === "number" ? over.count : 20;
  // The accepted worst case a window would send: what the estimate says (chunks of 25, two attempts each at the ceiling).
  return command("scenes.compose", { avatarId, count, categories: ["home"], poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT, ...over });
}

function composed(response: ResponseMessage): { sceneSetId: string; jobId: string | null } {
  const result = ok(response);
  if (result.type !== "scenes.compose") throw new Error(`expected a compose answer, got ${result.type}`);
  return result.result;
}

async function setOf(engine: Engine, avatarId: string): Promise<SceneSetView> {
  const result = ok(await engine.handle(command("scenes.get", { avatarId })));
  if (result.type !== "scenes.get") throw new Error(`expected a get answer, got ${result.type}`);
  if (result.result.sceneSet === null) throw new Error("the avatar has no scene set");
  return result.result.sceneSet;
}

async function noSet(engine: Engine, avatarId: string): Promise<{ unreadable: number }> {
  const result = ok(await engine.handle(command("scenes.get", { avatarId })));
  if (result.type !== "scenes.get") throw new Error(`expected a get answer, got ${result.type}`);
  expect(result.result.sceneSet).toBeNull();
  return { unreadable: result.result.unreadable };
}

function estimateOf(response: ResponseMessage): { expectedMicros: number; worstMicros: number } {
  const result = ok(response);
  if (result.type !== "scenes.estimateCompose" && result.type !== "scenes.estimateWrite") throw new Error(`expected an estimate, got ${result.type}`);
  return result.result.estimate;
}

const estimateWrite = (sceneSetId = SET) => command("scenes.estimateWrite", { sceneSetId, target: { kind: "unwritten" } });
const writeCommand = (revision: number, acceptedWorstMicros: number, sceneSetId = SET) => command("scenes.write", { sceneSetId, revision, target: { kind: "unwritten" }, acceptedWorstMicros });
const edit = (revision: number, op: unknown, sceneSetId = SET) => command("scenes.edit", { sceneSetId, revision, op });

function jobOf(response: ResponseMessage): string {
  const result = ok(response);
  if (result.type !== "scenes.write") throw new Error(`expected a write answer, got ${result.type}`);
  return result.result.jobId;
}

function changes(events: () => EventMessage[]): SceneSetView[] {
  return events().flatMap((e) => (e.type === "scenes.changed" && e.payload.change === "upserted" ? [e.payload.sceneSet] : []));
}

function ledgerReserves(): string[] {
  return readLedger().flatMap((l) => (l.type === "reserve" ? [String(l.attemptId)] : []));
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

function setFile(avatarId: string, sceneSetId = SET): string {
  return join(libraryDir(), "avatars", avatarId, "scenes", `${sceneSetId}.json`);
}

function setFiles(avatarId: string): string[] {
  const folder = join(libraryDir(), "avatars", avatarId, "scenes");
  return existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith(".json")) : [];
}

const code = (response: ResponseMessage) => failed(response).error.code;
/** The whole refusal: its code, and the scene reason (and scene) the window reads. */
const refused = (response: ResponseMessage) => failed(response).error;

// ---------- scenes.estimateCompose ----------

describe("scenes.estimateCompose", () => {
  test("is the writer's worst case for the scenes at the prices it can get: chunks of 25, two attempts each", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(sceneNetwork());
    const worst = async (count: number) => estimateOf(await engine.handle(command("scenes.estimateCompose", { avatarId, count, categories: ["home"], poses: POSES }))).worstMicros;

    expect(await worst(20)).toBe(2 * ATTEMPT);
    expect(await worst(26)).toBe(4 * ATTEMPT);
    expect(await worst(100)).toBe(8 * ATTEMPT);
  });

  test("an empty set is free", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(sceneNetwork());
    expect(estimateOf(await engine.handle(command("scenes.estimateCompose", { avatarId, count: 0, categories: [], poses: POSES })))).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("is NOT_FOUND for an avatar that cannot get photos, or a custom category the library does not hold, before any price is fetched", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    expect(code(await engine.handle(command("scenes.estimateCompose", { avatarId: "avatar-nobody-404", count: 5, categories: ["home"], poses: POSES })))).toBe("NOT_FOUND");
    expect(code(await engine.handle(command("scenes.estimateCompose", { avatarId, count: 5, categories: ["home", "cat-no-such-category"], poses: POSES })))).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(0);
  });
});

// ---------- scenes.compose ----------

describe("scenes.compose", () => {
  test("writes the set, its run id and every chunk's attempt ids to disk BEFORE the first call", async () => {
    const avatarId = await seedAvatar();
    const onArrival: { file: Record<string, unknown> | null; reserved: string[] }[] = [];
    const net = sceneNetwork({
      writer: (call, n) => {
        const files = setFiles(avatarId);
        onArrival.push({ file: files[0] === undefined ? null : JSON.parse(readFileSync(join(libraryDir(), "avatars", avatarId, "scenes", files[0]), "utf8")), reserved: ledgerReserves() });
        return goodAnswer(call, n);
      },
    });
    const { engine, events } = await engineOver(net);

    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 30 })));
    await jobEnd(events, jobId ?? "none");

    expect(onArrival).toHaveLength(2);
    const first = onArrival[0];
    expect(first?.file).toMatchObject({ sceneSetId, avatarId, schemaVersion: 1, write: { k: 1, kind: "compose", jobId } });
    const file = first?.file as { runId: string; chunks: { attemptIds: string[] }[] };
    expect(file.runId).toMatch(/^[a-z0-9-]{8,64}$/);
    expect(file.chunks.map((c) => c.attemptIds[0])).toEqual([`${sceneSetId}:writer-1#1`, `${sceneSetId}:writer-2#1`]);
    // The id the first call went out under was already in the file the moment it was reserved.
    expect(first?.reserved).toEqual([`${sceneSetId}:writer-1#1`]);
  });

  test("answers once the job is launched; the job writes every chunk, and the last scenes.changed comes BEFORE job.done", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(sceneNetwork());

    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 30 })));
    const end = await jobEnd(events, jobId ?? "none");

    expect(end).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "scenes", sceneSetId, avatarId, written: 30, unwritten: 0 } } });
    const all = events();
    const lastChange = all.findLastIndex((e) => e.type === "scenes.changed");
    expect(lastChange).toBeGreaterThan(-1);
    expect(lastChange).toBeLessThan(all.findIndex((e) => e.type === "job.done"));
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "ready", stoppedBy: null, write: null, spentMicros: 2 * 11_200 });
    expect(view.scenes.every((s) => s.text !== null && s.unwritten === null)).toBe(true);
  });

  test("tells the progress in scenes: the job counts the scenes it writes", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(sceneNetwork());
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 30 })));
    await jobEnd(events, jobId ?? "none");

    const progress = events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "scenes" ? [[e.payload.done, e.payload.total]] : []));
    expect(progress.at(0)).toEqual([0, 30]);
    expect(progress.at(-1)).toEqual([30, 30]);
  });

  test("each chunk's sentences are in the set before the next chunk is asked", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    let second = false;
    const net = sceneNetwork({
      writer: (call, n) => {
        if (n === 1) return goodAnswer(call, n);
        second = true;
        return gate.handler(call, n);
      },
    });
    const { engine, events } = await engineOver(net);
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 30 })));
    await until(() => second, "the second chunk's request");

    const view = await setOf(engine, avatarId);
    expect(view.status).toBe("writing");
    expect(view.scenes.slice(0, 25).every((s) => s.text !== null)).toBe(true);
    expect(view.scenes.slice(25).every((s) => s.text === null)).toBe(true);
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("a request at the model right now is not in the spend, the interrupted ones are", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    expect(await setOf(engine, avatarId)).toMatchObject({ status: "writing", spentMicros: 0, openReserveMicros: 0, write: { kind: "compose", count: 5 } });
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("an empty set is free: no job, no call, no key needed, and the set is announced", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net, { key: null });

    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 0, categories: [], acceptedWorstMicros: 0 })));

    expect(jobId).toBeNull();
    expect(net.calls).toHaveLength(0);
    expect(await setOf(engine, avatarId)).toMatchObject({ sceneSetId, status: "ready", scenes: [], chunks: [], spentMicros: 0 });
    expect(changes(events).map((s) => s.sceneSetId)).toEqual([sceneSetId]);
  });

  test("PRICE_CHANGED when the price rose above the accepted worst case: nothing is sent, reserved or written", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine } = await engineOver(net);

    expect(code(await engine.handle(composeCommand(avatarId, { acceptedWorstMicros: 2 * ATTEMPT - 1 })))).toBe("PRICE_CHANGED");

    expect(net.writerCalls()).toHaveLength(0);
    expect(setFiles(avatarId)).toEqual([]);
    expect(ledgerReserves()).toEqual([]);
  });

  test("a refused compose lets go of the avatar and of the library: the same click with the right price goes through", async () => {
    const avatarId = await seedAvatar();
    const { engine, events, posted } = await engineOver(sceneNetwork());
    await mkdir(join(dir(), "other"));

    expect(code(await engine.handle(composeCommand(avatarId, { acceptedWorstMicros: 1 })))).toBe("PRICE_CHANGED");
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000009", path: join(dir(), "other") });
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000009" });
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000010", path: libraryDir() });

    const { jobId } = composed(await engine.handle(composeCommand(avatarId)));
    await jobEnd(events, jobId ?? "none");
  });

  test("BUDGET_EXCEEDED when the month has no room for the worst case: nothing is written", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(sceneNetwork(), { monthlyBudgetMicros: 2 * ATTEMPT - 1 });

    expect(code(await engine.handle(composeCommand(avatarId)))).toBe("BUDGET_EXCEEDED");
    expect(setFiles(avatarId)).toEqual([]);
  });

  test("every request is reserved under the job's own scope, capped at the worst case it was priced at", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(sceneNetwork());
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await jobEnd(events, jobId ?? "none");

    expect(readLedger()[0]).toMatchObject({ type: "reserve", jobId, scope: { avatarJobId: jobId }, worstMicros: ATTEMPT });
  });

  test("is AUTH_INVALID without a key, and a 401 marks the key rejected", async () => {
    const avatarId = await seedAvatar();
    const noKey = await engineOver(sceneNetwork(), { key: null });
    expect(code(await noKey.engine.handle(composeCommand(avatarId)))).toBe("AUTH_INVALID");
  });

  test("NOT_FOUND for an avatar that cannot get photos or a custom category the library lacks, before anything is written", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(sceneNetwork());
    expect(code(await engine.handle(composeCommand("avatar-nobody-404")))).toBe("NOT_FOUND");
    expect(code(await engine.handle(composeCommand(avatarId, { categories: ["home", "cat-no-such-category"] })))).toBe("NOT_FOUND");
    expect(setFiles(avatarId)).toEqual([]);
  });

  test("RECONCILE_REQUIRED while the ledger holds an open reserve", async () => {
    const avatarId = await seedAvatar();
    await writeLedger(dir(), [reserve("run-other-0001:slot-1#1", "job-other-0001")]);
    const { engine } = await engineOver(sceneNetwork());
    expect(code(await engine.handle(composeCommand(avatarId)))).toBe("RECONCILE_REQUIRED");
  });

  test("a custom category is planned from its pool and the set keeps its snapshot", async () => {
    const avatarId = await seedAvatar();
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("cust") });
    const activities = [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ];
    await library.categories.create({
      categoryId: "cat-paris-cafes",
      name: "Кофейни Парижа",
      description: "кофейни",
      label: "Paris cafes",
      style: "phone",
      pool: {
        locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({ name, times: ["morning", "midday"], activities, mirror: i === 2 })),
        outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
        shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
      },
      model: "x-ai/grok-4.3",
      spentMicros: 5_000,
    });
    const { engine, events } = await engineOver(sceneNetwork());
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 6, categories: ["cat-paris-cafes"] })));
    await jobEnd(events, jobId ?? "none");

    const view = await setOf(engine, avatarId);
    expect(view.categories).toEqual([{ ref: "cat-paris-cafes", name: "Кофейни Парижа" }]);
    expect(view.scenes.every((s) => s.category === "cat-paris-cafes" && s.categoryName === "Кофейни Парижа")).toBe(true);
  });

  test("a category with poses [back] plans every scene from behind with a shot nobody holds a phone for, whatever the run's toggles say, and the set keeps its poses in the snapshot (CS.8a)", async () => {
    const avatarId = await seedAvatar();
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("angled") });
    const activities = [
      { text: "lying on her stomach, texting", twoHanded: false },
      { text: "lying on her stomach, writing", twoHanded: true },
    ];
    await library.categories.create({
      categoryId: "cat-lying-down",
      name: "Лежит на животе",
      description: "Лежит на животе в домашних шортиках и топике. Вид сзади",
      label: "Lying at home",
      style: "phone",
      pool: {
        locations: ["a sunny bedroom", "a living room rug", "a sofa by the window", "a quiet balcony mat", "a bedroom with a tall mirror"].map((name, i) => ({ name, times: ["morning", "midday"], activities, mirror: i === 4 })),
        outfits: ["home shorts and a tank top", "a soft hoodie and shorts", "a cotton tee and joggers"],
        shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
        poses: ["back"],
      },
      model: "x-ai/grok-4.3",
      spentMicros: 5_000,
    });
    const { engine, events } = await engineOver(sceneNetwork());
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 12, categories: ["cat-lying-down"], poses: { profile: false, back: false } })));
    await jobEnd(events, jobId ?? "none");

    const view = await setOf(engine, avatarId);
    expect(view.scenes).toHaveLength(12);
    expect(view.scenes.every((s) => s.pose === "back" && s.shot !== "selfie" && s.shot !== "mirror")).toBe(true);
    // The view carries the category's own angles, from the snapshot, for the strip's line; a category without them (and a built-in) carries no key.
    expect(view.categories).toEqual([{ ref: "cat-lying-down", name: "Лежит на животе", poses: ["back"] }]);
    const stored = JSON.parse(readFileSync(setFile(avatarId, view.sceneSetId), "utf8"));
    expect(stored.categories).toEqual([{ ref: "cat-lying-down", name: "Лежит на животе", label: "Lying at home", style: "phone", poses: ["back"] }]);
  });

  test("the avatar's vibe never reaches the writer: no compose body carries it", async () => {
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("vibe") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits({ ...TRAITS, vibe: "zebra lantern marmalade" }), descriptor: GOOD });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    const { jobId } = composed(await engine.handle(composeCommand(avatar.id, { count: 30 })));
    await jobEnd(events, jobId ?? "none");

    const sent = net.calls.map((c) => `${c.url}\n${JSON.stringify(c.headers)}\n${c.body ?? ""}`.toLowerCase());
    expect(net.writerCalls().length).toBeGreaterThan(0);
    for (const text of sent) for (const word of ["zebra", "lantern", "marmalade"]) expect(text).not.toContain(word);
  });
});

// ---------- one open set, concurrency ----------

describe("one open set per avatar, and one paid job per avatar", () => {
  test("a second compose while the avatar has an open set is VALIDATION, and nothing is reserved or written; after a discard it goes through", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(sceneNetwork());
    const first = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await jobEnd(events, first.jobId ?? "none");
    const reservesBefore = ledgerReserves().length;

    expect(refused(await engine.handle(composeCommand(avatarId, { count: 5 })))).toMatchObject({ code: "VALIDATION", sceneReason: "open-set" });
    expect(ledgerReserves()).toHaveLength(reservesBefore);
    expect(setFiles(avatarId)).toHaveLength(1);

    ok(await engine.handle(command("scenes.discard", { sceneSetId: first.sceneSetId })));
    const second = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await jobEnd(events, second.jobId ?? "none");
    expect(second.sceneSetId).not.toBe(first.sceneSetId);
  });

  test("a set that is used does not stand in the way: its run folder exists, so a new set may be composed", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("run") });
    await library.createRun(RUN, { n: 1 }, RUN_SCHEMA);
    const { engine, events } = await engineOver(sceneNetwork());

    expect(await setOf(engine, avatarId)).toMatchObject({ status: "used", runId: RUN });
    const next = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await jobEnd(events, next.jobId ?? "none");
    expect((await setOf(engine, avatarId)).sceneSetId).toBe(next.sceneSetId);
  });

  test("compose is refused while the avatar's scenes job runs: IN_FLIGHT, nothing reserved", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    expect(code(await engine.handle(composeCommand(avatarId, { count: 5 })))).toBe("IN_FLIGHT");
    expect(ledgerReserves()).toHaveLength(1);
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("compose and «Дописать» are refused while the avatar runs a photo run: IN_FLIGHT, nothing reserved for them", async () => {
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("runav") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    await seedSet(avatar.id, { count: 3, write: { k: 1, kind: "compose", jobId: JOB, stoppedBy: "network" } });
    const net = sceneNetwork({ image: () => ({ hang: true }) });
    const { engine, events } = await engineOver(net, { withFaceGate: true });
    const run = ok(await engine.handle(command("runs.start", { avatarId: avatar.id, count: 1, categories: ["home"], poses: POSES, acceptedWorstMicros: 10_000_000 })));
    if (run.type !== "runs.start") throw new Error("expected a run");
    const revision = (await setOf(engine, avatar.id)).revision;
    const reservesBefore = ledgerReserves().length;

    expect(code(await engine.handle(composeCommand(avatar.id, { count: 5 })))).toBe("IN_FLIGHT");
    expect(code(await engine.handle(writeCommand(revision, 10 * ATTEMPT)))).toBe("IN_FLIGHT");
    expect(ledgerReserves()).toHaveLength(reservesBefore);

    ok(await engine.handle(command("runs.cancel", { runId: run.result.runId })));
    await jobEnd(events, run.result.jobId);
  });

  test("a photo run cannot start for the avatar while its scenes job runs: IN_FLIGHT", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    expect(code(await engine.handle(command("runs.start", { avatarId, count: 4, categories: ["home"], poses: POSES, acceptedWorstMicros: 10_000_000 })))).toBe("IN_FLIGHT");
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("«Дописать» is refused while the avatar's scenes job runs", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");
    const revision = (await setOf(engine, avatarId)).revision;

    expect(code(await engine.handle(writeCommand(revision, 10 * ATTEMPT, sceneSetId)))).toBe("IN_FLIGHT");
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("a library switch is refused while a scenes job runs, and allowed once it ended", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, posted, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    await mkdir(join(dir(), "other"));
    const open = (callId: string) => ({ kind: "control", type: "library.open", callId, path: join(dir(), "other") });
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    await engine.receive(open("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    gate.release();
    await jobEnd(events, jobId ?? "none");
    await engine.receive(open("call-00000002"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
  });

  test("money.reconcile is refused while a scenes job runs", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    expect(code(await engine.handle(command("money.reconcile")))).toBe("IN_FLIGHT");
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("the avatar is not deleted while a scenes job runs", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const started = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { jobId } = composed(await started.engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    await started.engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
    expect(EngineReply.parse(started.posted.at(-1))).toMatchObject({ error: { code: "IN_FLIGHT" } });
    gate.release();
    await jobEnd(started.events, jobId ?? "none");
  });

  test("an avatar's scene sets are inside its folder, so a delete takes them to the Trash with it", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5 });
    const started = await engineOver(sceneNetwork());

    await started.engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
    const reply = EngineReply.parse(started.posted.at(-1));
    expect(reply.error).toBeUndefined();
    expect(setFile(avatarId).startsWith(reply.deletePlan?.folder ?? "no folder")).toBe(true);
    expect(existsSync(setFile(avatarId))).toBe(true);
  });
});

// ---------- scenes.get and the state machine ----------

describe("scenes.get", () => {
  test("is null for an avatar with no set, and the open set once there is one", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(sceneNetwork());
    expect(await noSet(engine, avatarId)).toEqual({ unreadable: 0 });
    await seedSet(avatarId, { count: 5, written: 5 });
    expect(await setOf(engine, avatarId)).toMatchObject({ sceneSetId: SET, avatarId, status: "ready" });
  });

  test("counts a set file it cannot read and leaves it where it is", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(setFile(avatarId, "set-broken-0002"), "{ not json");
    const { engine } = await engineOver(sceneNetwork());

    const result = ok(await engine.handle(command("scenes.get", { avatarId })));
    expect(result).toMatchObject({ result: { unreadable: 1, sceneSet: { sceneSetId: SET } } });
    expect(readFileSync(setFile(avatarId, "set-broken-0002"), "utf8")).toBe("{ not json");
  });

  test("is NOT_FOUND for an avatar the library does not have", async () => {
    const { engine } = await engineOver(sceneNetwork());
    expect(code(await engine.handle(command("scenes.get", { avatarId: "avatar-nobody-404" })))).toBe("NOT_FOUND");
  });
});

describe("the state machine at every crash point", () => {
  const compose = { k: 1, kind: "compose" as const, jobId: JOB };

  test("killed after the set was written, before the first reserve: stopped (closed), both attempts left, nothing spent", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);

    expect(view).toMatchObject({ status: "stopped", stoppedBy: "closed", spentMicros: 0, openReserveMicros: 0 });
    expect(view.chunks.map((c) => c.attemptsLeft)).toEqual([2, 2]);
    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(4 * ATTEMPT);
  });

  test("killed between a reserve and its answer: stopped (closed), the reserve counted at its worst, one attempt left for that chunk, paid calls wait for the reconcile", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    await writeLedger(dir(), [reserve(attemptId(1, 1))]);
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);

    expect(view).toMatchObject({ status: "stopped", stoppedBy: "closed", spentMicros: ATTEMPT, openReserveMicros: ATTEMPT });
    expect(view.chunks.map((c) => c.attemptsLeft)).toEqual([1, 2]);
    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(ATTEMPT + 2 * ATTEMPT);
    expect(code(await engine.handle(writeCommand(view.revision, 3 * ATTEMPT)))).toBe("RECONCILE_REQUIRED");
  });

  test("after the reconcile closed that reserve at its worst: «Дописать» sends ONE more attempt for the chunk, never a fresh pair, and never the reserved id", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    await writeLedger(dir(), [reserve(attemptId(1, 1)), settle(attemptId(1, 1), ATTEMPT, true)]);
    const net = sceneNetwork({ writer: () => rejectedAnswer });
    const { engine, events } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    expect(view.chunks[0]?.attemptsLeft).toBe(1);

    const jobId = jobOf(await engine.handle(writeCommand(view.revision, ATTEMPT)));
    await jobEnd(events, jobId);

    expect(net.writerCalls()).toHaveLength(1);
    expect(ledgerReserves()).toEqual([attemptId(1, 1), attemptId(1, 2)]);
    const after = await setOf(engine, avatarId);
    expect(after.scenes.every((s) => s.unwritten === "gave-up" && s.gaveUpBy === "rejected")).toBe(true);
    expect(after).toMatchObject({ status: "ready" });
  });

  test("killed after a chunk's answer was settled but before it was written into the set: the paid attempt is counted, the scenes are still waiting", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    await writeLedger(dir(), [reserve(attemptId(1, 1)), settle(attemptId(1, 1), 11_000)]);
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);

    expect(view).toMatchObject({ status: "stopped", stoppedBy: "closed", spentMicros: 11_000, openReserveMicros: 0 });
    expect(view.chunks.map((c) => c.attemptsLeft)).toEqual([1, 2]);
  });

  test("killed after chunk 1 was written, before chunk 2: stopped (closed) with the 10 scenes of chunk 2 waiting", async () => {
    const avatarId = await seedAvatar();
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("c1") });
    const set = sampleSet({ sceneSetId: SET, avatarId, runId: RUN, count: 35, written: 25 });
    await library.sceneSets.create({ ...set, write: compose, writes: 1 });
    await writeLedger(dir(), [reserve(attemptId(1, 1)), settle(attemptId(1, 1), 11_000)]);
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);

    expect(view).toMatchObject({ status: "stopped", stoppedBy: "closed" });
    expect(view.scenes.filter((s) => s.unwritten === "pending")).toHaveLength(10);
    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(2 * ATTEMPT);
  });

  test("killed after every chunk was written, before the write was cleared: nothing is left, the set reads ready", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5, write: compose });
    const { engine } = await engineOver(sceneNetwork());
    expect(await setOf(engine, avatarId)).toMatchObject({ status: "ready", stoppedBy: null });
  });

  test("a write that recorded why it stopped says so after a restart", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, write: { ...compose, stoppedBy: "rate-limited" } });
    const { engine } = await engineOver(sceneNetwork());
    expect(await setOf(engine, avatarId)).toMatchObject({ status: "stopped", stoppedBy: "rate-limited" });
  });

  test("a chunk with its attempts all used is «не составлена» and costs nothing to «Дописать»", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    await writeLedger(dir(), [reserve(attemptId(1, 1)), settle(attemptId(1, 1), 11_000), reserve(attemptId(1, 2)), settle(attemptId(1, 2), 11_000)]);
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);

    expect(view.chunks.map((c) => [c.attemptsLeft, c.gaveUpBy])).toEqual([
      [0, "no-attempts"],
      [2, null],
    ]);
    expect(view.scenes.filter((s) => s.gaveUpBy === "no-attempts")).toHaveLength(25);
    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(2 * ATTEMPT);
  });
});

// ---------- scenes.write ----------

describe("scenes.write: «Дописать»", () => {
  const compose = { k: 1, kind: "compose" as const, jobId: JOB, stoppedBy: "network" as const };

  test("writes only the chunks still waiting, from their next unused id, and ends with the set ready", async () => {
    const avatarId = await seedAvatar();
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("w1") });
    await library.sceneSets.create({ ...sampleSet({ sceneSetId: SET, avatarId, runId: RUN, count: 35, written: 25 }), write: compose, writes: 1 });
    await writeLedger(dir(), [reserve(attemptId(1, 1)), settle(attemptId(1, 1), 11_000), reserve(attemptId(2, 1)), settle(attemptId(2, 1), 0)]);
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    const view = await setOf(engine, avatarId);

    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.done", payload: { result: { kind: "scenes", written: 10, unwritten: 0 } } });
    expect(net.writerCalls()).toHaveLength(1);
    expect(slotsAskedFor(net.writerCalls()[0] as FetchCall)).toEqual([26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(ledgerReserves()).toEqual([attemptId(1, 1), attemptId(2, 1), attemptId(2, 2)]);
    expect(await setOf(engine, avatarId)).toMatchObject({ status: "ready", stoppedBy: null, write: null });
  });

  test("records the write before its first call: the set holds write 2 under the new job", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);

    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT)));
    await until(() => gate.arrived() === 1, "the request");

    const file = JSON.parse(readFileSync(setFile(avatarId), "utf8")) as { write: unknown; writes: number; revision: number };
    expect(file).toMatchObject({ write: { k: 2, kind: "unwritten", jobId }, writes: 2 });
    expect(file.write).not.toHaveProperty("stoppedBy");
    expect(file.revision).toBeGreaterThan(view.revision);
    gate.release();
    await jobEnd(events, jobId);
  });

  test("a chunk a job gave up on is not retried, and the job goes on with the next chunk", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    const net = sceneNetwork({ writer: (call, n) => (n <= 2 ? rejectedAnswer : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    const first = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 4 * ATTEMPT)));
    const end = await jobEnd(events, first);

    expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 10, unwritten: 25 } } });
    const view = await setOf(engine, avatarId);
    expect(view.chunks.map((c) => c.gaveUpBy)).toEqual(["rejected", null]);
    expect(view.scenes.filter((s) => s.gaveUpBy === "rejected")).toHaveLength(25);
    expect(view.status).toBe("ready");
    expect(code(await engine.handle(writeCommand(view.revision, 4 * ATTEMPT)))).toBe("VALIDATION");
  });

  test("a provider's refusal ends that chunk and the job goes on", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    const net = sceneNetwork({ writer: (call, n) => (n === 1 ? refusal : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 4 * ATTEMPT)));
    await jobEnd(events, jobId);

    const view = await setOf(engine, avatarId);
    expect(view.chunks.map((c) => c.gaveUpBy)).toEqual(["refused", null]);
    expect(net.writerCalls()).toHaveLength(2);
  });

  test("a free failure stops the job: job.failed after scenes.changed, the set stopped by the rate limit with both attempts kept", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const { engine, events } = await engineOver(sceneNetwork({ writer: () => rateLimited }));
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 2 * ATTEMPT)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.failed", payload: { kind: "scenes", jobId, sceneSetId: SET, avatarId, error: { code: "RATE_LIMITED" } } });
    const all = events();
    expect(all.findLastIndex((e) => e.type === "scenes.changed")).toBeLessThan(all.findIndex((e) => e.type === "job.failed"));
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "rate-limited", spentMicros: 0 });
    expect(view.chunks[0]?.attemptsLeft).toBe(2);
    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(2 * ATTEMPT);
  });

  test("a dropped connection leaves the reserve open: stopped by the network, one attempt left, paid calls wait for the reconcile", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const { engine, events } = await engineOver(sceneNetwork({ writer: () => ({ reject: new TypeError("fetch failed") }) }));
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 2 * ATTEMPT)));
    await jobEnd(events, jobId);

    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "network", spentMicros: ATTEMPT, openReserveMicros: ATTEMPT });
    expect(view.chunks[0]?.attemptsLeft).toBe(1);
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { reconcileNeeded: true } });
  });

  test("a 401 fails the job with its error and marks the key rejected", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const { engine, events } = await engineOver(sceneNetwork({ writer: () => ({ status: 401, body: { error: { message: "bad key" } } }) }));
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 2 * ATTEMPT)));
    await jobEnd(events, jobId);

    expect(await setOf(engine, avatarId)).toMatchObject({ status: "stopped", stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } });
    expect(code(await engine.handle(composeCommand(avatarId)))).toBe("AUTH_INVALID");
  });

  test("scenes.cancel aborts the request, ends the job cancelled after scenes.changed, keeps the chunks written and leaves the reserve open", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    const net = sceneNetwork({ writer: (call, n) => (n === 1 ? goodAnswer(call, n) : { hang: true }) });
    const { engine, events } = await engineOver(net);
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 4 * ATTEMPT)));
    await until(() => net.writerCalls().length === 2, "the second request");

    ok(await engine.handle(command("scenes.cancel", { sceneSetId: SET })));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.cancelled", payload: { kind: "scenes", jobId, sceneSetId: SET, avatarId } });
    const all = events();
    expect(all.findLastIndex((e) => e.type === "scenes.changed")).toBeLessThan(all.findIndex((e) => e.type === "job.cancelled"));
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "cancelled", openReserveMicros: ATTEMPT });
    expect(view.scenes.slice(0, 25).every((s) => s.text !== null)).toBe(true);
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { reconcileNeeded: true } });
  });

  test("a soft stop lets the request in flight finish and saves its chunk, asks no next chunk, leaves no open reserve, and the set reads stopped", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 60, write: compose }); // three chunks: 25 + 25 + 10
    const second = held();
    const net = sceneNetwork({ writer: (call, n) => (n === 2 ? second.handler(call, n) : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 6 * ATTEMPT)));
    await until(() => second.arrived() === 1, "the second chunk's request");

    expect(engine.softStopScenes(SET)).toBe(true);
    second.release();
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.cancelled", payload: { kind: "scenes", jobId, sceneSetId: SET, avatarId } });
    expect(net.writerCalls()).toHaveLength(2);
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "cancelled", openReserveMicros: 0 });
    expect(view.scenes.slice(0, 50).every((s) => s.text !== null)).toBe(true);
    expect(view.scenes.slice(50).every((s) => s.text === null)).toBe(true);
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { reconcileNeeded: false } });
  });

  test("a «Дописать» after a soft stop takes the next unused id of the chunk that was left", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: compose });
    const first = held(() => rejectedAnswer);
    const net = sceneNetwork({ writer: (call, n) => (n === 1 ? first.handler(call, n) : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    const jobId = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 4 * ATTEMPT)));
    await until(() => first.arrived() === 1, "the first request");
    engine.softStopScenes(SET);
    first.release();
    await jobEnd(events, jobId);
    expect(net.writerCalls()).toHaveLength(1);

    const again = jobOf(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 4 * ATTEMPT)));
    await until(() => events().some((e) => e.type === "job.done" && e.payload.jobId === again), "the second job's end");

    expect(ledgerReserves()).toContain(attemptId(1, 2));
    expect(ledgerReserves().filter((id) => id === attemptId(1, 1))).toHaveLength(1);
  });

  test("a soft stop that comes while the prices load ends the job before its first request, with no reserve", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
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
    const revision = (await setOf(engine, avatarId)).revision;
    const writing = engine.handle(writeCommand(revision, 2 * ATTEMPT));
    await until(() => priceRequested, "the price request");

    expect(engine.softStopScenes(SET)).toBe(true);
    release();
    expect(jobOf(await writing)).toBeTruthy();
    await until(() => events().some((e) => e.type === "job.cancelled"), "job.cancelled");

    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
  });

  test("a soft stop that arrives while the write is being recorded in the set (before its job exists) is applied when the job is registered: no request, job.cancelled", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const net = sceneNetwork();
    let engineRef: Engine | null = null;
    const stops: boolean[] = [];
    const { engine, events } = await engineOver(net, {
      beforeRename: (path) => {
        // The only rename of the set's file after the engine opened is the write's own record (beginWrite).
        if (stops.length === 0 && path.includes(SET)) stops.push(engineRef?.softStopScenes(SET) ?? false);
      },
    });
    engineRef = engine;
    const revision = (await setOf(engine, avatarId)).revision;
    const jobId = jobOf(await engine.handle(writeCommand(revision, 2 * ATTEMPT)));
    await jobEnd(events, jobId);

    expect(stops).toEqual([true]);
    expect(net.writerCalls()).toHaveLength(0);
    expect(events().some((e) => e.type === "job.cancelled" && e.payload.jobId === jobId)).toBe(true);
    expect(ledgerReserves()).toEqual([]);
  });

  test("a soft stop of a set with no running job is false", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const { engine } = await engineOver(sceneNetwork());
    expect(engine.softStopScenes(SET)).toBe(false);
    expect(engine.softStopScenes("set-unknown-0001")).toBe(false);
  });

  test("PRICE_CHANGED above the accepted worst case, nothing is sent; BUDGET_EXCEEDED when the month has no room", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const net = sceneNetwork();
    const { engine } = await engineOver(net, { monthlyBudgetMicros: 2 * ATTEMPT - 1 });
    const revision = (await setOf(engine, avatarId)).revision;
    expect(code(await engine.handle(writeCommand(revision, 2 * ATTEMPT - 1)))).toBe("PRICE_CHANGED");
    expect(code(await engine.handle(writeCommand(revision, 2 * ATTEMPT)))).toBe("BUDGET_EXCEEDED");
    expect(net.writerCalls()).toHaveLength(0);
  });

  test("VALIDATION when nothing is waiting; SCENES_CHANGED for a stale revision; VALIDATION for a used set; NOT_FOUND for an unknown set", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, written: 3 });
    const { engine } = await engineOver(sceneNetwork());
    const revision = (await setOf(engine, avatarId)).revision;

    expect(refused(await engine.handle(writeCommand(revision, 10 * ATTEMPT)))).toMatchObject({ code: "VALIDATION", sceneReason: "nothing-waiting" });
    expect(code(await engine.handle(writeCommand(revision + 5, 10 * ATTEMPT)))).toBe("SCENES_CHANGED");
    expect(code(await engine.handle(writeCommand(1, 10 * ATTEMPT, "set-nobody-0404")))).toBe("NOT_FOUND");
  });

  test("a set already used is refused", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("u") });
    await library.createRun(RUN, { n: 1 }, RUN_SCHEMA);
    const { engine } = await engineOver(sceneNetwork());
    expect(refused(await engine.handle(writeCommand((await setOf(engine, avatarId)).revision, 10 * ATTEMPT)))).toMatchObject({ code: "VALIDATION", sceneReason: "set-used" });
  });

  test("an edit that arrives while the write waits for the prices is refused IN_FLIGHT (the set is live from the claim), nothing is lost, and the write goes through on its revision", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
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
    const revision = (await setOf(engine, avatarId)).revision;

    const writing = engine.handle(writeCommand(revision, 2 * ATTEMPT));
    await until(() => priceRequested, "the price request");
    expect(code(await engine.handle(edit(revision, { op: "remove", sceneIds: [1] })))).toBe("IN_FLIGHT");
    release();

    const jobId = jobOf(await writing);
    await jobEnd(events, jobId);
    expect((await setOf(engine, avatarId)).scenes.every((s) => !s.removed && s.text !== null)).toBe(true);
  });

  test("a write refused after the set was shown as writing (the price moved) is announced again, so another window does not stay on «Дописываем…»", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
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
    const revision = (await setOf(engine, avatarId)).revision;

    // Window A sends a write whose accepted price is too low; window B reads the set while the prices are still loading.
    const refusedWrite = engine.handle(writeCommand(revision, 1));
    await until(() => priceRequested, "the price request");
    const windowB = await setOf(engine, avatarId);
    expect(windowB.status).toBe("writing");
    const heardBefore = changes(events).length;
    release();

    expect(code(await refusedWrite)).toBe("PRICE_CHANGED");
    // Window B applies what it hears by revision, as the renderer's store does: the last upsert at or after its own read is what it shows.
    const heard = changes(events)
      .slice(heardBefore)
      .filter((view) => view.revision >= windowB.revision);
    expect(heard.at(-1)).toMatchObject({ status: "stopped", write: null });
    expect(await setOf(engine, avatarId)).toMatchObject({ status: "stopped", write: null });
    expect(ledgerReserves()).toEqual([]);
  });

  test("a write cancelled before it began is announced as the set it is again, before job.cancelled", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
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
    const revision = (await setOf(engine, avatarId)).revision;
    const writing = engine.handle(writeCommand(revision, 2 * ATTEMPT));
    await until(() => priceRequested, "the price request");
    ok(await engine.handle(command("scenes.cancel", { sceneSetId: SET })));
    release();
    expect(jobOf(await writing)).toBeTruthy();
    await until(() => events().some((e) => e.type === "job.cancelled"), "job.cancelled");

    const order = events().flatMap((e, i) =>
      e.type === "job.cancelled" ? [`cancelled@${i}`] : e.type === "scenes.changed" && e.payload.change === "upserted" && e.payload.sceneSet.status !== "writing" ? [`settled@${i}`] : [],
    );
    expect(order[0]?.startsWith("settled")).toBe(true);
  });

  test("a write whose revision moved while it was being made is SCENES_CHANGED, whatever it waits on", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: compose });
    const { engine } = await engineOver(sceneNetwork());
    const revision = (await setOf(engine, avatarId)).revision;
    ok(await engine.handle(edit(revision, { op: "remove", sceneIds: [1] })));

    expect(code(await engine.handle(writeCommand(revision, 2 * ATTEMPT)))).toBe("SCENES_CHANGED");
    expect(ledgerReserves()).toEqual([]);
  });

  test("scenes the owner removed are never sent, and a text he typed makes a scene written", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, write: compose });
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    let revision = (await setOf(engine, avatarId)).revision;
    const removed = ok(await engine.handle(edit(revision, { op: "remove", sceneIds: [2] })));
    if (removed.type !== "scenes.edit" || !("sceneSet" in removed.result)) throw new Error("expected the set");
    revision = removed.result.sceneSet.revision;
    const typed = ok(await engine.handle(edit(revision, { op: "text", sceneId: 1, text: "Typed by the owner." })));
    if (typed.type !== "scenes.edit" || !("sceneSet" in typed.result)) throw new Error("expected the set");
    revision = typed.result.sceneSet.revision;

    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(2 * ATTEMPT);
    const jobId = jobOf(await engine.handle(writeCommand(revision, 2 * ATTEMPT)));
    await jobEnd(events, jobId);

    expect(slotsAskedFor(net.writerCalls()[0] as FetchCall)).toEqual([3, 4, 5]);
    const view = await setOf(engine, avatarId);
    expect(view.scenes[0]).toMatchObject({ text: "Typed by the owner.", edited: true });
    expect(view.scenes[1]).toMatchObject({ removed: true, text: null });
  });
});

// ---------- scenes.edit ----------

describe("scenes.edit", () => {
  test("a text edit is written, announced and answered with the next revision", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { engine, events } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);

    const result = ok(await engine.handle(edit(before.revision, { op: "text", sceneId: 2, text: "She waves from the pier." })));

    if (result.type !== "scenes.edit" || !("sceneSet" in result.result)) throw new Error("expected the set");
    expect(result.result.sceneSet.revision).toBe(before.revision + 1);
    expect(result.result.sceneSet.scenes[1]).toMatchObject({ text: "She waves from the pier.", edited: true });
    expect(changes(events).at(-1)?.revision).toBe(before.revision + 1);
    expect(JSON.parse(readFileSync(setFile(avatarId), "utf8")).scenes[1]).toMatchObject({ text: "She waves from the pier.", edited: true });
  });

  test.each([
    ["empty", "   ", "empty"],
    ["too-long", "a".repeat(601), "too-long"],
    ["not-one-line", "one\ntwo", "not-one-line"],
    ["control-char", "bell\u0007", "control-char"],
    ["revealing-word", "She wears a bikini.", "revealing-word"],
    ["youth-word", "A teenage girl smiles.", "youth-word"],
  ])("the problem %s is a result, naming its reason, and changes nothing", async (_name, text, reason) => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { engine, events } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);

    const result = ok(await engine.handle(edit(before.revision, { op: "text", sceneId: 1, text })));

    expect(result).toMatchObject({ result: { problem: { reason } } });
    expect(await setOf(engine, avatarId)).toEqual(before);
    expect(changes(events)).toEqual([]);
  });

  test("a stale revision is SCENES_CHANGED and nothing is lost: two edits made on one revision, the second is refused", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { engine } = await engineOver(sceneNetwork());
    const { revision } = await setOf(engine, avatarId);

    ok(await engine.handle(edit(revision, { op: "text", sceneId: 1, text: "From window A." })));
    expect(code(await engine.handle(edit(revision, { op: "remove", sceneIds: [2] })))).toBe("SCENES_CHANGED");

    const view = await setOf(engine, avatarId);
    expect(view.scenes[0]?.text).toBe("From window A.");
    expect(view.scenes[1]?.removed).toBe(false);
  });

  test("two edits at once on one revision: one lands, one is refused", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { engine } = await engineOver(sceneNetwork());
    const { revision } = await setOf(engine, avatarId);

    const answers = await Promise.all([engine.handle(edit(revision, { op: "text", sceneId: 1, text: "A." })), engine.handle(edit(revision, { op: "text", sceneId: 2, text: "B." }))]);

    expect(answers.map((a) => a.ok).sort()).toEqual([false, true]);
    expect(answers.filter((a) => !a.ok).map(code)).toEqual(["SCENES_CHANGED"]);
  });

  test("removing many scenes is one revision and one scenes.changed, and works on scenes still waiting", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 35, write: { k: 1, kind: "compose", jobId: JOB } });
    const { engine, events } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);
    const pending = before.scenes.filter((s) => s.unwritten === "pending").map((s) => s.sceneId);
    expect(pending).toHaveLength(35);

    const result = ok(await engine.handle(edit(before.revision, { op: "remove", sceneIds: pending.slice(0, 10) })));

    if (result.type !== "scenes.edit" || !("sceneSet" in result.result)) throw new Error("expected the set");
    expect(result.result.sceneSet.revision).toBe(before.revision + 1);
    expect(result.result.sceneSet.scenes.filter((s) => s.removed)).toHaveLength(10);
    expect(changes(events)).toHaveLength(1);
  });

  test("removing every waiting scene leaves nothing to write: the set reads ready and «Дописать» is refused", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, write: { k: 1, kind: "compose", jobId: JOB, stoppedBy: "network" } });
    const { engine } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);
    expect(before.status).toBe("stopped");

    const result = ok(await engine.handle(edit(before.revision, { op: "remove", sceneIds: before.scenes.map((s) => s.sceneId) })));
    if (result.type !== "scenes.edit" || !("sceneSet" in result.result)) throw new Error("expected the set");

    expect(result.result.sceneSet).toMatchObject({ status: "ready", stoppedBy: null });
    expect(estimateOf(await engine.handle(estimateWrite())).worstMicros).toBe(0);
  });

  test("a restore brings a removed scene back as it was, and as waiting if it never had a sentence", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, write: { k: 1, kind: "compose", jobId: JOB } });
    const { engine } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);
    const removed = ok(await engine.handle(edit(before.revision, { op: "remove", sceneIds: [3] })));
    if (removed.type !== "scenes.edit" || !("sceneSet" in removed.result)) throw new Error("expected the set");
    const restored = ok(await engine.handle(edit(removed.result.sceneSet.revision, { op: "restore", sceneIds: [3] })));
    if (restored.type !== "scenes.edit" || !("sceneSet" in restored.result)) throw new Error("expected the set");

    expect(restored.result.sceneSet.scenes[2]).toMatchObject({ removed: false, unwritten: "pending" });
  });

  test("a scene the set does not have is VALIDATION and changes nothing", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { engine } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);
    expect(refused(await engine.handle(edit(before.revision, { op: "remove", sceneIds: [1, 99] })))).toMatchObject({ code: "VALIDATION", sceneReason: "scene-missing", sceneId: 99 });
    expect(await setOf(engine, avatarId)).toEqual(before);
  });

  test("is refused while the set's job runs: IN_FLIGHT", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");
    const { revision } = await setOf(engine, avatarId);

    expect(code(await engine.handle(edit(revision, { op: "remove", sceneIds: [1] }, sceneSetId)))).toBe("IN_FLIGHT");
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("is refused once the set is used: VALIDATION, nothing changes", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("u2") });
    await library.createRun(RUN, { n: 1 }, RUN_SCHEMA);
    const { engine } = await engineOver(sceneNetwork());
    const before = await setOf(engine, avatarId);

    expect(refused(await engine.handle(edit(before.revision, { op: "remove", sceneIds: [1] })))).toMatchObject({ code: "VALIDATION", sceneReason: "set-used" });
    expect(await setOf(engine, avatarId)).toEqual(before);
  });

  test("NOT_FOUND for a set that is not there", async () => {
    await seedAvatar();
    const { engine } = await engineOver(sceneNetwork());
    expect(code(await engine.handle(edit(1, { op: "remove", sceneIds: [1] }, "set-nobody-0404")))).toBe("NOT_FOUND");
  });
});

// ---------- scenes.discard, scenes.cancel ----------

describe("scenes.discard", () => {
  test("deletes the set and announces it removed; the money it cost stays in the ledger", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(sceneNetwork());
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await jobEnd(events, jobId ?? "none");
    const linesBefore = readLedger().length;

    ok(await engine.handle(command("scenes.discard", { sceneSetId })));

    expect(setFiles(avatarId)).toEqual([]);
    expect(events().at(-1)).toMatchObject({ type: "scenes.changed", payload: { change: "removed", sceneSetId, avatarId } });
    expect(readLedger()).toHaveLength(linesBefore);
    await noSet(engine, avatarId);
  });

  test("is refused during a job (cancel first): IN_FLIGHT, and the set stays", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");

    expect(code(await engine.handle(command("scenes.discard", { sceneSetId })))).toBe("IN_FLIGHT");
    expect(setFiles(avatarId)).toHaveLength(1);
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("is refused for a used set: VALIDATION", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("u3") });
    await library.createRun(RUN, { n: 1 }, RUN_SCHEMA);
    const { engine } = await engineOver(sceneNetwork());
    expect(code(await engine.handle(command("scenes.discard", { sceneSetId: SET })))).toBe("VALIDATION");
    expect(setFiles(avatarId)).toHaveLength(1);
  });

  test("NOT_FOUND for a set that is not there", async () => {
    await seedAvatar();
    const { engine } = await engineOver(sceneNetwork());
    expect(code(await engine.handle(command("scenes.discard", { sceneSetId: "set-nobody-0404" })))).toBe("NOT_FOUND");
  });
});

describe("scenes.cancel", () => {
  test("answers ok for a set whose job is not running, and NOT_FOUND for an unknown set", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    const { engine } = await engineOver(sceneNetwork());
    expect(ok(await engine.handle(command("scenes.cancel", { sceneSetId: SET })))).toMatchObject({ result: { sceneSetId: SET } });
    expect(code(await engine.handle(command("scenes.cancel", { sceneSetId: "set-nobody-0404" })))).toBe("NOT_FOUND");
  });
});

describe("a refused command never touches the live mark of another job (fix round 1)", () => {
  test("a write refused IN_FLIGHT during a compose leaves the set writing: edits and discard are still IN_FLIGHT and cancel really cancels the job", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await until(() => gate.arrived() === 1, "the request");
    const { revision } = await setOf(engine, avatarId);

    expect(code(await engine.handle(writeCommand(revision, 10 * ATTEMPT, sceneSetId)))).toBe("IN_FLIGHT");

    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "writing", stoppedBy: null });
    expect(view.write).toMatchObject({ kind: "compose", count: 5 });
    expect(code(await engine.handle(command("scenes.discard", { sceneSetId })))).toBe("IN_FLIGHT");
    expect(code(await engine.handle(edit(revision, { op: "remove", sceneIds: [1] }, sceneSetId)))).toBe("IN_FLIGHT");
    expect(existsSync(setFile(avatarId, sceneSetId))).toBe(true);

    ok(await engine.handle(command("scenes.cancel", { sceneSetId })));
    const end = await jobEnd(events, jobId ?? "none");
    expect(end).toMatchObject({ type: "job.cancelled", payload: { kind: "scenes", jobId, sceneSetId, avatarId } });
    gate.release();
  });

  test("two writes at once on one set start exactly one job: the other is IN_FLIGHT and records nothing in the file", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: { k: 1, kind: "compose", jobId: JOB, stoppedBy: "network" } });
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { revision } = await setOf(engine, avatarId);

    const answers = await Promise.all([engine.handle(writeCommand(revision, 2 * ATTEMPT)), engine.handle(writeCommand(revision, 2 * ATTEMPT))]);

    const codes = answers.map((a) => (a.ok ? "ok" : failed(a).error.code));
    expect(codes.filter((c) => c === "ok")).toHaveLength(1);
    expect(codes.filter((c) => c === "IN_FLIGHT")).toHaveLength(1);
    const started = answers.flatMap((a) => (a.ok ? [jobOf(a)] : []));
    await until(() => gate.arrived() === 1, "the request");
    expect(JSON.parse(readFileSync(setFile(avatarId), "utf8"))).toMatchObject({ writes: 2, write: { k: 2, jobId: started[0] } });
    gate.release();
    await jobEnd(events, started[0] ?? "none");
    expect(events().filter((e) => e.type === "job.failed")).toHaveLength(0);
  });
});

describe("the start of a write is announced (fix round 1)", () => {
  test("a compose announces its set as writing with the full scene count, the same as scenes.get says at that moment", async () => {
    const avatarId = await seedAvatar();
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 20 })));
    await until(() => gate.arrived() === 1, "the request");

    const [first] = changes(events);
    expect(first).toMatchObject({ status: "writing", write: { kind: "compose", count: 20 } });
    expect((await setOf(engine, avatarId)).write).toEqual(first?.write ?? null);
    gate.release();
    await jobEnd(events, jobId ?? "none");
  });

  test("«Дописать» announces the set as writing, on the revision beginWrite made, before the first chunk is answered", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, write: { k: 1, kind: "compose", jobId: JOB, stoppedBy: "network" } });
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const before = await setOf(engine, avatarId);

    const jobId = jobOf(await engine.handle(writeCommand(before.revision, 2 * ATTEMPT)));
    await until(() => gate.arrived() === 1, "the request");

    const announced = changes(events);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ status: "writing", revision: before.revision + 1, write: { kind: "unwritten", count: 3 } });
    gate.release();
    await jobEnd(events, jobId);
  });
});

describe("an accepted paid chunk is never lost to the store (fix round 1)", () => {
  const LONG = Array.from({ length: 7 }, () => SENTENCE).join(" ");

  test("an accepted sentence of 700 chars is stored as the writer wrote it, and its chunk is written on the first attempt", async () => {
    expect(LONG.length).toBeGreaterThan(650);
    const avatarId = await seedAvatar();
    const long: Handler = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: LONG })) }), { cost: 0.0112 }) });
    const net = sceneNetwork({ writer: long });
    const { engine, events } = await engineOver(net);

    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    const end = await jobEnd(events, jobId ?? "none");

    expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 5, unwritten: 0 } } });
    expect(net.writerCalls()).toHaveLength(1);
    const view = await setOf(engine, avatarId);
    expect(view.scenes.map((s) => s.text)).toEqual(Array.from({ length: 5 }, () => LONG));
    expect(view.chunks[0]).toMatchObject({ attemptsLeft: 1, gaveUpBy: null });
  });

  test("the owner's own edit is still limited to 600 chars", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 3, written: 3 });
    const { engine } = await engineOver(sceneNetwork());
    const { revision } = await setOf(engine, avatarId);

    const result = ok(await engine.handle(edit(revision, { op: "text", sceneId: 1, text: LONG })));

    expect(result).toMatchObject({ result: { problem: { reason: "too-long" } } });
  });

  test("a transient disk error while storing an accepted chunk is retried once: the chunk is written, the job is done", async () => {
    const avatarId = await seedAvatar();
    let setWrites = 0;
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net, {
      beforeRename: (path) => {
        // The set's file is written by the compose (1st), then by the chunk's save (2nd): the 2nd fails once.
        if (path.includes(`${join("scenes", "")}`) && ++setWrites === 2) throw new Error("the disk hiccuped");
      },
    });

    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    const end = await jobEnd(events, jobId ?? "none");

    expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 5, unwritten: 0 } } });
    expect(setWrites).toBeGreaterThanOrEqual(3);
    expect(net.writerCalls()).toHaveLength(1);
    expect((await setOf(engine, avatarId)).scenes.every((s) => s.text !== null)).toBe(true);
  });
});

describe("what the view claims stays true (fix round 1)", () => {
  test("a delete that went through announces each of the avatar's sets removed, before avatar.removed", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5 });
    const started = await engineOver(sceneNetwork());

    await started.engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
    await started.engine.receive({ kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId, token: "token-00000001", outcome: "trashed" });

    const told = started.events().flatMap((e) => (e.type === "scenes.changed" && e.payload.change === "removed" ? [`set:${e.payload.sceneSetId}`] : e.type === "avatar.removed" ? ["avatar"] : []));
    expect(told).toEqual([`set:${SET}`, "avatar"]);
  });

  test("a delete that was kept announces no set removed", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5 });
    const started = await engineOver(sceneNetwork());

    await started.engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
    await started.engine.receive({ kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId, token: "token-00000001", outcome: "kept" });

    expect(started.events().filter((e) => e.type === "scenes.changed" && e.payload.change === "removed")).toEqual([]);
  });

  test("the compose outcome is the one the job ended with: removing scenes afterwards does not change it", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork({ writer: (call, n) => (n === 1 ? goodAnswer(call, n) : rejectedAnswer) });
    const { engine, events } = await engineOver(net);
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 30 })));
    await jobEnd(events, jobId ?? "none");
    const ended = await setOf(engine, avatarId);
    expect(ended.lastCompose).toEqual({ total: 30, written: 25, gaveUp: 5 });

    ok(await engine.handle(edit(ended.revision, { op: "remove", sceneIds: [1, 2, 3, 26, 27] }, sceneSetId)));

    expect((await setOf(engine, avatarId)).lastCompose).toEqual({ total: 30, written: 25, gaveUp: 5 });
  });
});

describe("the snapshot", () => {
  test("lists a scenes job of this engine's life, so a window that opens later still sees it", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(sceneNetwork());
    const { sceneSetId, jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    await jobEnd(events, jobId ?? "none");

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("expected a snapshot");
    expect(snapshot.result.jobs.find((j) => j.kind === "scenes")).toEqual({ kind: "scenes", jobId: jobId ?? "none", sceneSetId, avatarId, status: "done", done: 5, total: 5, result: { kind: "scenes", sceneSetId, avatarId, written: 5, unwritten: 0 } });
  });
});

void NOW;

// CS.7 fix round 2: a read the OS fails (EIO, EMFILE, EBUSY under an antivirus, EPERM) is injected through the library's `beforeRead`/`beforeList` seams, so
// these run on every platform. It is not «the set is gone»: a paid answer whose save hits one is stored on the retry, a check before a new set refuses.
describe("a read the OS fails (fix round 2)", () => {
  const osError = (name: string): Error => Object.assign(new Error(`${name}: injected`), { code: name });
  const isSetFile = (path: string): boolean => path.endsWith(".json") && path.includes(`${join("scenes", "")}`);

  /** Fails the set file's reads once the writer's answer has arrived: `times` of them (Infinity: for good). */
  function failAfterTheAnswer(name: string, times: number) {
    const state = { answered: false, failed: 0 };
    const writer: Handler = (call, n) => {
      state.answered = true;
      return goodAnswer(call, n);
    };
    const beforeRead = (path: string): void => {
      if (!state.answered || state.failed >= times || !isSetFile(path)) return;
      state.failed += 1;
      throw osError(name);
    };
    return { state, writer, beforeRead };
  }

  for (const name of ["EIO", "EMFILE", "EBUSY", "EPERM"]) {
    test(`${name} once on the set file between the writer's answer and the save: the chunk is retried from memory, the job is done, the text is in the set, one reserve`, async () => {
      const avatarId = await seedAvatar();
      const fail = failAfterTheAnswer(name, 1);
      const net = sceneNetwork({ writer: fail.writer });
      const { engine, events } = await engineOver(net, { beforeRead: fail.beforeRead });

      const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
      const end = await jobEnd(events, jobId ?? "none");

      expect(fail.state.failed).toBe(1);
      expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 5, unwritten: 0 } } });
      expect(net.writerCalls()).toHaveLength(1);
      expect(ledgerReserves()).toHaveLength(1);
      expect((await setOf(engine, avatarId)).scenes.every((s) => s.text !== null)).toBe(true);
    });
  }

  test("a read that keeps failing ends the job with the real cause, not «not found», and the attempt is not paid for twice", async () => {
    const avatarId = await seedAvatar();
    const fail = failAfterTheAnswer("EIO", Number.POSITIVE_INFINITY);
    const net = sceneNetwork({ writer: fail.writer });
    const { engine, events } = await engineOver(net, { beforeRead: fail.beforeRead });

    const { jobId } = composed(await engine.handle(composeCommand(avatarId, { count: 5 })));
    const end = await jobEnd(events, jobId ?? "none");

    expect(end).toMatchObject({ type: "job.failed" });
    const detail = end.type === "job.failed" ? (end.payload.error.detail ?? "") : "";
    expect(detail).toContain("EIO");
    expect(detail).not.toContain("no readable scene set");
    expect(net.writerCalls()).toHaveLength(1);
    expect(ledgerReserves()).toHaveLength(1);
  });

  test("compose is refused as library-unreadable when one record of the avatar's scenes hits an OS error: it may be the open set, so no second set is written and nothing is reserved", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, { count: 5, written: 5 });
    let failedReads = 0;
    const net = sceneNetwork();
    const { engine } = await engineOver(net, {
      beforeRead: (path) => {
        if (failedReads === 0 && path.endsWith(`${SET}.json`)) {
          failedReads += 1;
          throw osError("EIO");
        }
      },
    });

    const answer = refused(await engine.handle(composeCommand(avatarId, { count: 5 })));

    expect(answer).toMatchObject({ code: "VALIDATION", sceneReason: "library-unreadable" });
    expect(setFiles(avatarId)).toEqual([`${SET}.json`]);
    expect(ledgerReserves()).toEqual([]);
    expect(net.writerCalls()).toHaveLength(0);
  });

  test("compose is refused as library-unreadable when the avatar's scenes/ cannot be listed (EMFILE), whether or not the folder is there", async () => {
    const avatarId = await seedAvatar();
    const net = sceneNetwork();
    const { engine } = await engineOver(net, {
      beforeList: () => {
        throw osError("EMFILE");
      },
    });

    const answer = refused(await engine.handle(composeCommand(avatarId, { count: 5 })));

    expect(answer).toMatchObject({ code: "VALIDATION", sceneReason: "library-unreadable" });
    expect(setFiles(avatarId)).toEqual([]);
    expect(ledgerReserves()).toEqual([]);
  });

  test("a free compose (count 0) is refused the same way and writes nothing", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(sceneNetwork(), {
      beforeList: () => {
        throw osError("EBUSY");
      },
    });

    expect(refused(await engine.handle(composeCommand(avatarId, { count: 0 })))).toMatchObject({ code: "VALIDATION", sceneReason: "library-unreadable" });
    expect(setFiles(avatarId)).toEqual([]);
  });
});
