import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EventMessage, ResponseMessage, SceneSetView } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary, type LibraryDeps } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { ownScene, sampleSet } from "./library/testing/sceneSetSample";
import type { PlanSlot } from "./scenes";
import { poolOf } from "./scenes/poolGen";
import { redrawSlot } from "./scenes/redraw";
import { seedOfSet } from "./sceneSets/compose";
import type { LedgerLine } from "./money/ledger";
import { chatBody, fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, failed, GOOD, jobEnd, NOW, OFFLINE, ok, startEngine, TRAITS, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the review-time writes against a real engine over a real ledger and library in a temp dir; every request goes to a fake fetch, nothing reaches the
// network. ⟳ «Другая сцена» is a rewrite with a redraw, ⟳ on an own scene is a rewrite from its stored idea, «+ Своя сцена» is an idea write. Each is ONE writer
// request under ids of its own (`${set}:write-${k}#n`), recorded in the set with its draw BEFORE the call.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-scene-writes-");
const libraryDir = () => join(dir(), "library");

/** One writer attempt at its ceilings (14K in, 8K out) at the fallback prices. */
const ATTEMPT = 37_500;
const SET = "set-seed-0001";
const RUN = "run-seed-0001";
const AT = "2026-10-07T12:00:00.000Z";
const OLD = "An old sentence that must survive a failed write.";
const SENTENCE = "She stands at the open window with a cup in her free hand while the morning light crosses the room behind her.";
const CAT = "cat-paris-cafes" as const;

type Started = Awaited<ReturnType<typeof startEngine>>;
type Engine = Started["engine"];
type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

let seeded = 0;

async function seedAvatar(vibe?: string): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const traits = vibe === undefined ? TRAITS : { ...TRAITS, vibe };
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(traits), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

const CAFE = { category: CAT, location: "a corner cafe", activity: "reading a menu", outfit: "a beige trench coat and jeans", timeOfDay: "morning" };

const CAT_ACTIVITIES = [
  { text: "reading a menu", twoHanded: false },
  { text: "stirring a cappuccino", twoHanded: true },
];
const CAT_POOL = {
  locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({ name, times: ["morning", "midday"] as ("morning" | "midday")[], activities: CAT_ACTIVITIES, mirror: i === 2 })),
  outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress", "a long green cardigan"],
  shotDeck: ["friend", "friend", "selfie", "mirror", "candid"] as ("friend" | "selfie" | "mirror" | "candid")[],
};

/** The category the library holds NOW: its label and style differ from what the set's snapshot says, as after a regeneration. */
async function seedCategory(): Promise<void> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`cust${++seeded}`) });
  await library.categories.create({
    categoryId: CAT,
    name: "Кофейни Парижа",
    description: "кофейни",
    label: "Parisian cafes (current)",
    style: "editorial",
    pool: CAT_POOL,
    model: "x-ai/grok-4.3",
    spentMicros: 5_000,
  });
}

interface SeedOptions {
  /** Scenes 1 and 2 are in the custom category (the set's snapshot of it is stale). */
  custom?: boolean;
  /** An own scene 5 written from an idea, then hand-edited. */
  own?: boolean;
  /** Writes already started (the next is `writes + 1`). */
  writes?: number;
  records?: Record<string, unknown>[];
  poses?: { profile: boolean; back: boolean };
  count?: number;
  extra?: Record<string, unknown>;
}

/** A set as earlier writes left it: four written planned scenes, maybe an own one, and the records of the writes that are not resolved. */
async function seedReview(avatarId: string, options: SeedOptions = {}): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
  const base = sampleSet({ sceneSetId: SET, avatarId, runId: RUN, count: options.count ?? 4, written: options.count ?? 4 });
  const planned = base.scenes.map((s) => ({ ...s, text: OLD, ...(options.custom === true && s.sceneId <= 2 ? { slot: { ...s.slot, ...CAFE } } : {}) }));
  const scenes = options.own === true ? [...planned, ownScene(5, { idea: "кофе на балконе утром", text: "Typed by hand, not the idea.", edited: true, shot: "selfie", pose: "front" })] : planned;
  await library.sceneSets.create({
    ...base,
    scenes,
    ...(options.custom === true ? { categories: [{ ref: CAT, name: "Кофейни Парижа", label: "Paris cafes (old)", style: "phone" }], request: { ...base.request, categories: ["home", CAT] } } : {}),
    ...(options.poses === undefined ? {} : { request: { ...base.request, poses: options.poses } }),
    write: null,
    writes: options.writes ?? 0,
    ...(options.records === undefined ? {} : { reviewWrites: options.records }),
    ...(options.extra ?? {}),
  } as never);
  return SET;
}

const writeId = (k: number, n: number) => `${SET}:write-${k}#${n}`;

function isWriter(call: FetchCall): boolean {
  if (!call.url.endsWith("/chat/completions")) return false;
  const format = call.json().response_format;
  return typeof format === "object" && format !== null && "json_schema" in format && JSON.stringify(format.json_schema).includes("scene_sentences");
}

function listAsked(call: FetchCall): { slotIndex: number; [key: string]: unknown }[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
}
const slotsAskedFor = (call: FetchCall): number[] => listAsked(call).map((s) => s.slotIndex);

const goodAnswer: Handler = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) });
const rejectedAnswer: Reply = { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) };
const refusal: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
const rateLimited: Reply = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };

function sceneNetwork(opts: { writer?: Handler; prices?: () => Promise<Reply> } = {}) {
  let writes = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (isWriter(call)) return (opts.writer ?? goodAnswer)(call, ++writes);
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return (await opts.prices?.()) ?? OFFLINE;
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
  return { fetch: net.fetch, calls: net.calls, imageCalls: () => [], ageCalls: () => [], descriptorCalls: () => [], paidCalls: () => net.calls.filter((c) => c.method === "POST"), writerCalls: () => net.calls.filter(isWriter) };
}

function engineOver(net: ReturnType<typeof sceneNetwork>, opts: { key?: string | null; monthlyBudgetMicros?: number; testHooks?: NonNullable<Parameters<typeof startEngine>[1]>["deps"] extends infer D ? (D extends { library?: infer L } ? (L extends { testHooks?: infer H } ? H : never) : never) : never } = {}) {
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", ...(opts.monthlyBudgetMicros === undefined ? {} : { monthlyBudgetMicros: opts.monthlyBudgetMicros }) }) },
    net,
    ...(opts.key === undefined ? {} : { key: opts.key }),
    ...(opts.testHooks === undefined ? {} : { deps: { library: { testHooks: opts.testHooks } } }),
  });
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

async function setOf(engine: Engine, avatarId: string): Promise<SceneSetView> {
  const result = ok(await engine.handle(command("scenes.get", { avatarId })));
  if (result.type !== "scenes.get") throw new Error(`expected a get answer, got ${result.type}`);
  if (result.result.sceneSet === null) throw new Error("the avatar has no scene set");
  return result.result.sceneSet;
}

type Target = { kind: "rewrite"; sceneIds: number[]; redraw: boolean } | { kind: "idea"; idea: string; count: number; shot: string | null } | { kind: "resume"; write: number };
const writeCommand = (revision: number, acceptedWorstMicros: number, target: Target, sceneSetId = SET) => command("scenes.write", { sceneSetId, revision, target, acceptedWorstMicros });
const estimateCommand = (target: Target, sceneSetId = SET) => command("scenes.estimateWrite", { sceneSetId, target });
const edit = (revision: number, op: unknown, sceneSetId = SET) => command("scenes.edit", { sceneSetId, revision, op });
const rewrite = (sceneIds: number[], redraw = false): Target => ({ kind: "rewrite", sceneIds, redraw });
const idea = (text: string, count = 1, shot: string | null = null): Target => ({ kind: "idea", idea: text, count, shot });

function jobOf(response: ResponseMessage): string {
  const result = ok(response);
  if (result.type !== "scenes.write") throw new Error(`expected a write answer, got ${result.type}`);
  return result.result.jobId;
}
function estimateOf(response: ResponseMessage): { expectedMicros: number; worstMicros: number } {
  const result = ok(response);
  if (result.type !== "scenes.estimateWrite") throw new Error(`expected an estimate, got ${result.type}`);
  return result.result.estimate;
}
const code = (response: ResponseMessage) => failed(response).error.code;
/** The whole refusal: its code, and the scene reason (and scene) the window reads. */
const refused = (response: ResponseMessage) => failed(response).error;

/** Starts a write at the revision the set has now, at the price it shows, and waits for its job to end. */
async function writeAndWait(engine: Engine, events: () => EventMessage[], avatarId: string, target: Target, accepted = 2 * ATTEMPT): Promise<EventMessage> {
  const view = await setOf(engine, avatarId);
  return jobEnd(events, jobOf(await engine.handle(writeCommand(view.revision, accepted, target))));
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
const setPath = (avatarId: string) => join(libraryDir(), "avatars", avatarId, "scenes", `${SET}.json`);
const fileOf = (avatarId: string): Record<string, unknown> & { scenes: Record<string, unknown>[]; reviewWrites?: Record<string, unknown>[]; categories?: Record<string, unknown>[]; revision: number } =>
  JSON.parse(readFileSync(setPath(avatarId), "utf8"));
function reserve(id: string, jobId = "job-seed-0001"): LedgerLine {
  return { type: "reserve", attemptId: id, jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: ATTEMPT, at: AT };
}
function settle(id: string, costMicros: number, estimated = false): LedgerLine {
  return { type: "settle", attemptId: id, costMicros, estimated, at: AT };
}
const changes = (events: () => EventMessage[]): SceneSetView[] => events().flatMap((e) => (e.type === "scenes.changed" && e.payload.change === "upserted" ? [e.payload.sceneSet] : []));

/** A rewrite record as the service writes it before the call. */
function rewriteRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const k = typeof over.k === "number" ? over.k : 1;
  return { kind: "rewrite", k, jobId: "job-seed-0001", attemptIds: [1, 2, 3, 4].map((n) => writeId(k, n)), closed: false, sceneIds: [2], redraw: false, slots: [], snapshots: [], ...over };
}

// ---------- scenes.estimateWrite ----------

describe("scenes.estimateWrite: rewrite, idea and resume", () => {
  test("a rewrite and an idea write are WRITER_CALL × 2: one request, two attempts at the ceiling, whatever the count", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine } = await engineOver(sceneNetwork());

    expect(estimateOf(await engine.handle(estimateCommand(rewrite([2], true)))).worstMicros).toBe(2 * ATTEMPT);
    expect(estimateOf(await engine.handle(estimateCommand(rewrite([1, 2, 3, 4], false)))).worstMicros).toBe(2 * ATTEMPT);
    expect(estimateOf(await engine.handle(estimateCommand(idea("кофе", 1)))).worstMicros).toBe(2 * ATTEMPT);
    expect(estimateOf(await engine.handle(estimateCommand(idea("кофе", 5)))).worstMicros).toBe(2 * ATTEMPT);
  });

  test("expects the writer's typical tokens, a couple of thousandths of a dollar for one scene", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine } = await engineOver(sceneNetwork());
    const estimate = estimateOf(await engine.handle(estimateCommand(rewrite([2]))));
    expect(estimate.expectedMicros).toBeGreaterThan(300);
    expect(estimate.expectedMicros).toBeLessThan(2_500);
  });

  test("a resume is priced by the attempts its write has left: one after an open or estimated reserve, two after a free failure", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { writes: 2, records: [rewriteRecord({ k: 1, stoppedBy: "network" }), rewriteRecord({ k: 2, sceneIds: [3], stoppedBy: "rate-limited" })] });
    await writeLedger(dir(), [reserve(writeId(1, 1)), settle(writeId(1, 1), ATTEMPT, true), reserve(writeId(2, 1)), settle(writeId(2, 1), 0)]);
    const { engine } = await engineOver(sceneNetwork());

    expect(estimateOf(await engine.handle(estimateCommand({ kind: "resume", write: 1 }))).worstMicros).toBe(ATTEMPT);
    expect(estimateOf(await engine.handle(estimateCommand({ kind: "resume", write: 2 }))).worstMicros).toBe(2 * ATTEMPT);
  });

  test("the refusals are free and sent before any price is asked: an unknown scene, a removed one, mixed kinds, an own scene redrawn, no room, an unknown or resolved write", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { own: true, writes: 2, records: [rewriteRecord({ k: 2, closed: true })] });
    const net = sceneNetwork();
    const { engine } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    ok(await engine.handle(edit(view.revision, { op: "remove", sceneIds: [4] })));

    expect(refused(await engine.handle(estimateCommand(rewrite([99]))))).toMatchObject({ code: "VALIDATION", sceneReason: "scene-missing", sceneId: 99 });
    expect(refused(await engine.handle(estimateCommand(rewrite([4]))))).toMatchObject({ code: "VALIDATION", sceneReason: "target-removed", sceneId: 4 });
    expect(refused(await engine.handle(estimateCommand(rewrite([1, 5]))))).toMatchObject({ code: "VALIDATION", sceneReason: "mixed-kinds" });
    expect(refused(await engine.handle(estimateCommand(rewrite([5], true))))).toMatchObject({ code: "VALIDATION", sceneReason: "own-redraw" });
    expect(refused(await engine.handle(estimateCommand({ kind: "resume", write: 9 })))).toMatchObject({ code: "VALIDATION", sceneReason: "no-open-write" });
    expect(refused(await engine.handle(estimateCommand({ kind: "resume", write: 2 })))).toMatchObject({ code: "VALIDATION", sceneReason: "no-open-write" });
    expect(code(await engine.handle(estimateCommand(rewrite([1]), "set-nobody-404")))).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(0);
  });

  test("a redraw of a scene whose category was deleted is NOT_FOUND, free; a plain rewrite of it is priced", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { custom: true });
    const { engine } = await engineOver(sceneNetwork());

    expect(code(await engine.handle(estimateCommand(rewrite([1], true))))).toBe("NOT_FOUND");
    expect(estimateOf(await engine.handle(estimateCommand(rewrite([1], false)))).worstMicros).toBe(2 * ATTEMPT);
  });

  test("an idea that would not fit in the set (200 scenes) is VALIDATION", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { count: 198 });
    const { engine } = await engineOver(sceneNetwork());
    expect(estimateOf(await engine.handle(estimateCommand(idea("кофе", 2)))).worstMicros).toBe(2 * ATTEMPT);
    expect(code(await engine.handle(estimateCommand(idea("кофе", 3))))).toBe("VALIDATION");
  });
});

// ---------- scenes.write: rewrite ----------

describe("scenes.write: a rewrite", () => {
  test("gives the target a new sentence under write 1's first id, and touches no other scene", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    const before = fileOf(avatarId).scenes;

    const end = await writeAndWait(engine, events, avatarId, rewrite([2]));

    expect(end).toMatchObject({ type: "job.done", payload: { result: { kind: "scenes", sceneSetId: SET, avatarId, written: 1, unwritten: 0 } } });
    expect(ledgerReserves()).toEqual([writeId(1, 1)]);
    expect(slotsAskedFor(net.writerCalls()[0] as FetchCall)).toEqual([2]);
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "ready", write: null, spentMicros: 11_200 });
    expect(view.scenes.map((s) => s.text)).toEqual([OLD, `${SENTENCE} (2)`, OLD, OLD]);
    expect(fileOf(avatarId).scenes.filter((s) => s.sceneId !== 2)).toEqual(before.filter((s) => s.sceneId !== 2));
  });

  test("scenes.changed announces the write's start and its end, and the last one comes BEFORE job.done", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2, 3]))));
    await until(() => gate.arrived() === 1, "the request");

    const during = await setOf(engine, avatarId);
    expect(during).toMatchObject({ status: "writing", write: { kind: "rewrite", count: 2, sceneIds: [2, 3] }, spentMicros: 0 });
    expect(changes(events).at(-1)).toMatchObject({ status: "writing", write: { kind: "rewrite" } });
    gate.release();
    await jobEnd(events, jobId);
    const all = events();
    expect(all.findLastIndex((e) => e.type === "scenes.changed")).toBeLessThan(all.findIndex((e) => e.type === "job.done"));
    expect(changes(events).at(-1)).toMatchObject({ status: "ready", write: null });
  });

  test("a redraw is recorded with its draw and its ids BEFORE the call, and the scene shows its old place and text until the sentence is accepted", async () => {
    const avatarId = await seedAvatar();
    await seedCategory();
    await seedReview(avatarId, { custom: true });
    const onArrival: { file: ReturnType<typeof fileOf>; reserved: string[] }[] = [];
    const gate = held();
    const { engine, events } = await engineOver(
      sceneNetwork({
        writer: (call, n) => {
          onArrival.push({ file: fileOf(avatarId), reserved: ledgerReserves() });
          return gate.handler(call, n);
        },
      }),
    );
    const view = await setOf(engine, avatarId);
    const oldPlace = view.scenes[0]?.place;
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([1], true))));
    await until(() => gate.arrived() === 1, "the request");

    const first = onArrival[0];
    expect(first?.reserved).toEqual([writeId(1, 1)]);
    const record = first?.file.reviewWrites?.[0] as { kind: string; k: number; jobId: string; attemptIds: string[]; sceneIds: number[]; redraw: boolean; slots: { slotIndex: number; location: string }[]; snapshots: { ref: string; name: string; label: string; style: string }[] };
    expect(record).toMatchObject({ kind: "rewrite", k: 1, jobId, sceneIds: [1], redraw: true, attemptIds: [1, 2, 3, 4].map((n) => writeId(1, n)) });
    expect(record.slots).toHaveLength(1);
    expect(record.slots[0]?.slotIndex).toBe(1);
    expect(record.snapshots).toEqual([{ ref: CAT, name: "Кофейни Парижа", label: "Parisian cafes (current)", style: "editorial" }]);
    expect(first?.file).toMatchObject({ writes: 1 });
    // The scene itself, on disk and in the view, is still what it was.
    expect((await setOf(engine, avatarId)).scenes[0]).toMatchObject({ place: oldPlace, text: OLD });
    expect((first?.file.scenes[0] as { slot: { location: string } }).slot.location).toBe("a corner cafe");
    gate.release();
    await jobEnd(events, jobId);
  });

  test("an accepted redraw gives the scene its new place with its sentence, avoids the places and outfits the set shows, and refreshes the category's snapshot", async () => {
    const avatarId = await seedAvatar();
    await seedCategory();
    await seedReview(avatarId, { custom: true });
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    const before = await setOf(engine, avatarId);

    await writeAndWait(engine, events, avatarId, rewrite([1], true));

    const after = await setOf(engine, avatarId);
    const scene = after.scenes[0];
    expect(scene?.text).toBe(`${SENTENCE} (1)`);
    expect(scene?.place?.location).not.toBe(before.scenes[0]?.place?.location);
    expect(scene?.place?.outfit).not.toBe(before.scenes[0]?.place?.outfit);
    expect(scene?.place?.location).not.toBe(before.scenes[1]?.place?.location);
    expect(scene?.place?.outfit).not.toBe(before.scenes[1]?.place?.outfit);
    expect(scene).toMatchObject({ category: CAT, categoryName: "Кофейни Парижа", shot: before.scenes[0]?.shot });
    // The prompt carried the NEW place and the category's fresh label, never the old label.
    const asked = JSON.stringify(net.writerCalls()[0]?.json());
    expect(asked).toContain(scene?.place?.location ?? "?");
    expect(asked).toContain("Parisian cafes (current)");
    expect(asked).not.toContain("Paris cafes (old)");
    expect(fileOf(avatarId).categories).toEqual([{ ref: CAT, name: "Кофейни Парижа", label: "Parisian cafes (current)", style: "editorial" }]);
    // Scenes written earlier keep their text.
    expect(after.scenes.slice(1).map((s) => s.text)).toEqual([OLD, OLD, OLD]);
  });

  test("the draw is the one the set's seed, the scene and the write number give: it is the pure redraw over the set's own places, so it is reproducible", async () => {
    const avatarId = await seedAvatar();
    await seedCategory();
    await seedReview(avatarId, { custom: true });
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    const stored = fileOf(avatarId);
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([1], true))));
    await until(() => gate.arrived() === 1, "the request");

    const scenes = stored.scenes as unknown as { sceneId: number; slot: PlanSlot }[];
    const expected = redrawSlot({
      seed: seedOfSet(SET),
      k: 1,
      slot: scenes[0]?.slot as PlanSlot,
      pool: poolOf(CAT_POOL),
      avoid: { locations: new Set(scenes.map((s) => s.slot.location)), outfits: new Set(scenes.map((s) => s.slot.outfit)) },
      poses: { profile: false, back: false },
    });
    expect((fileOf(avatarId).reviewWrites?.[0] as { slots: unknown[] }).slots).toEqual([expected]);
    gate.release();
    await jobEnd(events, jobId);
  });

  test("a redraw of a scene whose category was deleted is refused free: NOT_FOUND, nothing written or reserved; a plain rewrite of it still works", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { custom: true });
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    const view = await setOf(engine, avatarId);

    expect(code(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([1], true))))).toBe("NOT_FOUND");
    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
    expect(fileOf(avatarId).revision).toBe(view.revision);

    const end = await writeAndWait(engine, events, avatarId, rewrite([1], false));
    expect(end).toMatchObject({ type: "job.done" });
    expect((await setOf(engine, avatarId)).scenes[0]?.text).toBe(`${SENTENCE} (1)`);
    // The plain rewrite sent the label the SET holds, since the category is gone.
    expect(JSON.stringify(net.writerCalls()[0]?.json())).toContain("Paris cafes (old)");
  });

  test("a write that fails leaves the scene exactly as it was, and says nothing is left to resume", async () => {
    const avatarId = await seedAvatar();
    await seedCategory();
    await seedReview(avatarId, { custom: true });
    const net = sceneNetwork({ writer: () => rejectedAnswer });
    const { engine, events } = await engineOver(net);
    const before = fileOf(avatarId);

    const end = await writeAndWait(engine, events, avatarId, rewrite([1], true));

    expect(end).toMatchObject({ type: "job.failed", payload: { kind: "scenes", sceneSetId: SET, avatarId } });
    expect(net.writerCalls()).toHaveLength(2);
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(1, 2)]);
    const after = fileOf(avatarId);
    expect(after.scenes).toEqual(before.scenes);
    expect(after.categories).toEqual(before.categories);
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "ready", spentMicros: 4_000 });
    expect(view.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(view.interruptedIdeas).toBeUndefined();
  });

  test("a provider's refusal is final and free of marks: MODERATION_REFUSED, one call, nothing changed", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const net = sceneNetwork({ writer: () => refusal });
    const { engine, events } = await engineOver(net);

    const end = await writeAndWait(engine, events, avatarId, rewrite([2]));

    expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "MODERATION_REFUSED" } } });
    expect(net.writerCalls()).toHaveLength(1);
    expect((await setOf(engine, avatarId)).scenes.map((s) => s.text)).toEqual([OLD, OLD, OLD, OLD]);
  });

  test("a rewrite of several scenes writes them in ONE request", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    await writeAndWait(engine, events, avatarId, rewrite([1, 2, 3, 4]));
    expect(net.writerCalls()).toHaveLength(1);
    expect(slotsAskedFor(net.writerCalls()[0] as FetchCall)).toEqual([1, 2, 3, 4]);
  });
});

// ---------- an interrupted write ----------

describe("an interrupted rewrite: a marker on its scene, the set stays ready", () => {
  test("a free failure leaves the old text and place, marks the scene with why, and keeps both attempts", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const net = sceneNetwork({ writer: () => rateLimited });
    const { engine, events } = await engineOver(net);

    const end = await writeAndWait(engine, events, avatarId, rewrite([2]));

    expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "RATE_LIMITED" } } });
    const view = await setOf(engine, avatarId);
    expect(view).toMatchObject({ status: "ready", stoppedBy: null, spentMicros: 0 });
    expect(view.scenes.map((s) => s.rewriteInterrupted)).toEqual([undefined, { write: 1, stoppedBy: "rate-limited" }, undefined, undefined]);
    expect(view.scenes.map((s) => s.text)).toEqual([OLD, OLD, OLD, OLD]);
    expect(estimateOf(await engine.handle(estimateCommand({ kind: "resume", write: 1 }))).worstMicros).toBe(2 * ATTEMPT);
  });

  test("a resume carries the same write on from its next unused id, never the one that failed, and the marker goes", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    let first = true;
    const net = sceneNetwork({
      writer: (call, n) => {
        if (first) {
          first = false;
          return rateLimited;
        }
        return goodAnswer(call, n);
      },
    });
    const { engine, events } = await engineOver(net);
    await writeAndWait(engine, events, avatarId, rewrite([2]));

    const end = await writeAndWait(engine, events, avatarId, { kind: "resume", write: 1 });

    expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 1, unwritten: 0 } } });
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(1, 2)]);
    const view = await setOf(engine, avatarId);
    expect(view.scenes[1]).toMatchObject({ text: `${SENTENCE} (2)` });
    expect(view.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(fileOf(avatarId).writes).toBe(1);
  });

  describe("a resume when the owner removed a scene of the write meanwhile", () => {
    async function interrupted(avatarId: string, sceneIds: number[]) {
      const net = sceneNetwork({ writer: (call, n) => (n === 1 ? rateLimited : goodAnswer(call, n)) });
      const harness = await engineOver(net);
      await writeAndWait(harness.engine, harness.events, avatarId, rewrite(sceneIds));
      return { ...harness, net };
    }
    async function removed(engine: Engine, avatarId: string, sceneIds: number[]): Promise<void> {
      const view = await setOf(engine, avatarId);
      ok(await engine.handle(edit(view.revision, { op: "remove", sceneIds })));
    }

    test("asks about the scenes still in the set alone, and the removed one keeps its text", async () => {
      const avatarId = await seedAvatar();
      await seedReview(avatarId);
      const { engine, events, net } = await interrupted(avatarId, [2, 3]);
      await removed(engine, avatarId, [3]);

      const end = await writeAndWait(engine, events, avatarId, { kind: "resume", write: 1 });

      expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 1 } } });
      expect(slotsAskedFor(net.writerCalls()[1] as FetchCall)).toEqual([2]);
      const view = await setOf(engine, avatarId);
      expect(view.scenes.map((s) => s.text)).toEqual([OLD, `${SENTENCE} (2)`, OLD, OLD]);
      expect(view.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    });

    test("is still priced, for the scenes that remain", async () => {
      const avatarId = await seedAvatar();
      await seedReview(avatarId);
      const { engine } = await interrupted(avatarId, [2, 3]);
      const before = estimateOf(await engine.handle(estimateCommand({ kind: "resume", write: 1 }))).worstMicros;
      await removed(engine, avatarId, [3]);
      const after = estimateOf(await engine.handle(estimateCommand({ kind: "resume", write: 1 }))).worstMicros;
      expect(after).toBeLessThanOrEqual(before);
    });

    test("with every scene of the write removed there is nothing to resume: VALIDATION, free", async () => {
      const avatarId = await seedAvatar();
      await seedReview(avatarId);
      const { engine, net } = await interrupted(avatarId, [2]);
      await removed(engine, avatarId, [2]);
      const view = await setOf(engine, avatarId);

      expect(refused(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, { kind: "resume", write: 1 })))).toMatchObject({ code: "VALIDATION", sceneReason: "target-removed" });
      expect(net.writerCalls()).toHaveLength(1);
    });
  });

  test("a restart keeps the marker, and the resume of a redraw draws nothing new: it asks about the very place the first attempt was asked about", async () => {
    const avatarId = await seedAvatar();
    await seedCategory();
    await seedReview(avatarId, { custom: true });
    const firstNet = sceneNetwork({ writer: () => rateLimited });
    const one = await engineOver(firstNet);
    await writeAndWait(one.engine, one.events, avatarId, rewrite([1], true));
    const recorded = (fileOf(avatarId).reviewWrites?.[0] as { slots: unknown[] }).slots;

    const secondNet = sceneNetwork();
    const two = await engineOver(secondNet);
    expect((await setOf(two.engine, avatarId)).scenes[0]?.rewriteInterrupted).toEqual({ write: 1, stoppedBy: "rate-limited" });
    await writeAndWait(two.engine, two.events, avatarId, { kind: "resume", write: 1 });

    expect((fileOf(avatarId).reviewWrites?.[0] as { slots: unknown[] }).slots).toEqual(recorded);
    const asked = (net: ReturnType<typeof sceneNetwork>) => JSON.stringify(listAsked(net.writerCalls()[0] as FetchCall));
    expect(asked(secondNet)).toBe(asked(firstNet));
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(1, 2)]);
  });

  test("an interruption that left an open reserve waits for the reconcile: the resume is refused, and the price after it is ONE attempt", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { writes: 1, records: [rewriteRecord({ k: 1, stoppedBy: "network" })] });
    await writeLedger(dir(), [reserve(writeId(1, 1))]);
    const net = sceneNetwork();
    const { engine } = await engineOver(net);
    const view = await setOf(engine, avatarId);

    expect(view).toMatchObject({ status: "ready", spentMicros: ATTEMPT, openReserveMicros: ATTEMPT });
    expect(view.scenes[1]?.rewriteInterrupted).toEqual({ write: 1, stoppedBy: "network" });
    expect(estimateOf(await engine.handle(estimateCommand({ kind: "resume", write: 1 }))).worstMicros).toBe(ATTEMPT);
    expect(code(await engine.handle(writeCommand(view.revision, ATTEMPT, { kind: "resume", write: 1 })))).toBe("RECONCILE_REQUIRED");
    expect(net.writerCalls()).toHaveLength(0);
  });

  test("after the reconcile's estimated settle the resume sends ONE attempt, never a fresh pair and never the reserved id; a rejected answer resolves the write", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { writes: 1, records: [rewriteRecord({ k: 1, stoppedBy: "network" })] });
    await writeLedger(dir(), [reserve(writeId(1, 1)), settle(writeId(1, 1), ATTEMPT, true)]);
    const net = sceneNetwork({ writer: () => rejectedAnswer });
    const { engine, events } = await engineOver(net);

    const end = await writeAndWait(engine, events, avatarId, { kind: "resume", write: 1 }, ATTEMPT);

    expect(end).toMatchObject({ type: "job.failed" });
    expect(net.writerCalls()).toHaveLength(1);
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(1, 2)]);
    const view = await setOf(engine, avatarId);
    expect(view.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(code(await engine.handle(writeCommand(view.revision, ATTEMPT, { kind: "resume", write: 1 })))).toBe("VALIDATION");
  });

  test("a resume of a write with no attempt left is VALIDATION, free", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { writes: 1, records: [rewriteRecord({ k: 1, stoppedBy: "network" })] });
    await writeLedger(dir(), [reserve(writeId(1, 1)), settle(writeId(1, 1), 2_000), reserve(writeId(1, 2)), settle(writeId(1, 2), 2_000)]);
    const net = sceneNetwork();
    const { engine } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    expect(refused(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, { kind: "resume", write: 1 })))).toMatchObject({ code: "VALIDATION", sceneReason: "no-attempts-left" });
    expect(net.writerCalls()).toHaveLength(0);
  });

  test("«Оставить как есть» dismisses the marker, free; the ids of that write stay burnt, so the next write is number 2", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    let first = true;
    const net = sceneNetwork({ writer: (call, n) => (first ? ((first = false), rateLimited) : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    await writeAndWait(engine, events, avatarId, rewrite([2]));
    const view = await setOf(engine, avatarId);

    const dismissed = ok(await engine.handle(edit(view.revision, { op: "dismissInterrupted", sceneIds: [2] })));
    expect(dismissed).toMatchObject({ result: { sceneSet: { status: "ready" } } });
    expect((await setOf(engine, avatarId)).scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(fileOf(avatarId).reviewWrites?.[0]).toMatchObject({ k: 1, closed: true });

    await writeAndWait(engine, events, avatarId, rewrite([2]));
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(2, 1)]);
  });

  test("a marker survives a write on another scene; only a resume or a dismissal takes it away", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    let first = true;
    const net = sceneNetwork({ writer: (call, n) => (first ? ((first = false), rateLimited) : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    await writeAndWait(engine, events, avatarId, rewrite([2]));

    await writeAndWait(engine, events, avatarId, rewrite([3]));

    const view = await setOf(engine, avatarId);
    expect(view.scenes.map((s) => s.rewriteInterrupted?.write)).toEqual([undefined, 1, undefined, undefined]);
    expect(view.scenes[2]?.text).toBe(`${SENTENCE} (3)`);
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(2, 1)]);
  });

  test("write numbers never repeat across restarts, so no id is ever sent twice", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const one = await engineOver(sceneNetwork());
    await writeAndWait(one.engine, one.events, avatarId, rewrite([2]));
    const two = await engineOver(sceneNetwork());
    await writeAndWait(two.engine, two.events, avatarId, rewrite([3]));
    const three = await engineOver(sceneNetwork());
    await writeAndWait(three.engine, three.events, avatarId, idea("кофе", 1));

    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(2, 1), writeId(3, 1)]);
    expect(new Set(ledgerReserves()).size).toBe(3);
  });

  test("a cancel while the write awaits the prices is not lost: the job ends cancelled, nothing is reserved or sent", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = false;
    const net = sceneNetwork({
      prices: async () => {
        asked = true;
        await gate;
        return OFFLINE;
      },
    });
    const { engine, events } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    const pending = engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2])));
    await until(() => asked, "the price request");

    ok(await engine.handle(command("scenes.cancel", { sceneSetId: SET })));
    release();
    const end = await jobEnd(events, jobOf(await pending));

    expect(end.type).toBe("job.cancelled");
    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
    expect((await setOf(engine, avatarId)).status).toBe("ready");
  });

  test("a cancel while the write awaits the prices leaves the set's file untouched: no write number, no marker, no idea write", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = false;
    const net = sceneNetwork({
      prices: async () => {
        asked = true;
        await gate;
        return OFFLINE;
      },
    });
    const { engine, events } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    const before = readFileSync(setPath(avatarId), "utf8");
    const pending = engine.handle(writeCommand(view.revision, 2 * ATTEMPT, idea("кофе", 1)));
    await until(() => asked, "the price request");

    ok(await engine.handle(command("scenes.cancel", { sceneSetId: SET })));
    release();
    const end = await jobEnd(events, jobOf(await pending));

    expect(end.type).toBe("job.cancelled");
    expect(readFileSync(setPath(avatarId), "utf8")).toBe(before);
    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
  });

  test("a cancel mid-request leaves the reserve open and marks the scene as cancelled", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))));
    await until(() => gate.arrived() === 1, "the request");

    ok(await engine.handle(command("scenes.cancel", { sceneSetId: SET })));
    await jobEnd(events, jobId);

    const after = await setOf(engine, avatarId);
    expect(after.scenes[1]?.rewriteInterrupted).toEqual({ write: 1, stoppedBy: "cancelled" });
    expect(after).toMatchObject({ status: "ready", openReserveMicros: ATTEMPT });
    gate.release();
  });
});

// ---------- scenes.write: idea ----------

describe("scenes.write: an idea", () => {
  test("adds k own scenes written from the idea, under ids after the set's highest, recorded with their draw BEFORE the call", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const onArrival: ReturnType<typeof fileOf>[] = [];
    const net = sceneNetwork({
      writer: (call, n) => {
        onArrival.push(fileOf(avatarId));
        return goodAnswer(call, n);
      },
    });
    const { engine, events } = await engineOver(net);

    const end = await writeAndWait(engine, events, avatarId, idea("  кофе на балконе утром  ", 3, "friend"));

    expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 3, unwritten: 0 } } });
    const record = onArrival[0]?.reviewWrites?.[0] as { kind: string; k: number; idea: string; count: number; shot: string | null; scenes: { sceneId: number; shot: string; pose: string }[] };
    expect(record).toMatchObject({ kind: "idea", k: 1, idea: "кофе на балконе утром", count: 3, shot: "friend" });
    expect(record.scenes.map((s) => s.sceneId)).toEqual([5, 6, 7]);
    expect(onArrival[0]?.scenes).toHaveLength(4);
    expect(slotsAskedFor(net.writerCalls()[0] as FetchCall)).toEqual([5, 6, 7]);
    expect(JSON.stringify(net.writerCalls()[0]?.json())).toContain("кофе на балконе утром");
    const view = await setOf(engine, avatarId);
    expect(view.scenes.slice(4)).toEqual(
      [5, 6, 7].map((sceneId) => ({
        sceneId,
        origin: "own",
        category: "own",
        categoryName: null,
        shot: "friend",
        pose: expect.stringMatching(/^(front|three-quarter)$/),
        place: null,
        idea: "кофе на балконе утром",
        text: `${SENTENCE} (${sceneId})`,
        edited: false,
        removed: false,
        unwritten: null,
        gaveUpBy: null,
        chunk: null,
      })),
    );
    expect(view.scenes.slice(0, 4).map((s) => s.text)).toEqual([OLD, OLD, OLD, OLD]);
    expect(view).toMatchObject({ status: "ready", lastCompose: { total: 4, written: 4, gaveUp: 0 } });
  });

  test("an idea in any script goes to the writer verbatim; the avatar's vibe never reaches a rewrite or an idea body", async () => {
    const avatarId = await seedAvatar("zebra lantern marmalade");
    await seedCategory();
    await seedReview(avatarId, { custom: true, own: true });
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);

    await writeAndWait(engine, events, avatarId, rewrite([1], true));
    await writeAndWait(engine, events, avatarId, rewrite([5]));
    await writeAndWait(engine, events, avatarId, idea("прогулка по набережной на закате", 2));

    expect(net.writerCalls()).toHaveLength(3);
    const sent = net.calls.map((c) => `${c.url}\n${JSON.stringify(c.headers)}\n${c.body ?? ""}`.toLowerCase());
    for (const text of sent) for (const word of ["zebra", "lantern", "marmalade"]) expect(text).not.toContain(word);
    expect(net.writerCalls().at(-1)?.body).toContain("прогулка по набережной на закате");
  });

  test("auto shots never pick the mirror, and the poses follow the set's allowance: front or three-quarter when it allows no more", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine, events } = await engineOver(sceneNetwork());
    for (let i = 0; i < 6; i++) await writeAndWait(engine, events, avatarId, idea("кофе", 5, null));

    const own = (await setOf(engine, avatarId)).scenes.filter((s) => s.origin === "own");
    expect(own).toHaveLength(30);
    expect(own.some((s) => s.shot === "mirror")).toBe(false);
    expect(own.every((s) => s.pose === "front" || s.pose === "three-quarter")).toBe(true);
  });

  test("an explicit mirror or selfie shot gives a scene that faces the camera, even when the set allows every pose", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { poses: { profile: true, back: true } });
    const { engine, events } = await engineOver(sceneNetwork());
    await writeAndWait(engine, events, avatarId, idea("кофе", 5, "mirror"));
    await writeAndWait(engine, events, avatarId, idea("кофе", 5, "selfie"));

    const own = (await setOf(engine, avatarId)).scenes.filter((s) => s.origin === "own");
    expect(own.map((s) => s.shot)).toEqual([...Array(5).fill("mirror"), ...Array(5).fill("selfie")]);
    expect(own.every((s) => s.pose === "front" || s.pose === "three-quarter")).toBe(true);
  });

  test("an idea write that cannot be answered adds no scene and leaves no trace on the set", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine, events } = await engineOver(sceneNetwork({ writer: () => rejectedAnswer }));
    await writeAndWait(engine, events, avatarId, idea("кофе", 2));
    const view = await setOf(engine, avatarId);
    expect(view.scenes).toHaveLength(4);
    expect(view.interruptedIdeas).toBeUndefined();
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(1, 2)]);
  });

  test("an interrupted idea write is listed on the set; «Повторить» carries it on under the same ids and reserved scene ids, «Не нужно» drops it", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    let first = true;
    const net = sceneNetwork({ writer: (call, n) => (first ? ((first = false), rateLimited) : goodAnswer(call, n)) });
    const { engine, events } = await engineOver(net);
    await writeAndWait(engine, events, avatarId, idea("кофе на балконе", 2, "friend"));

    const view = await setOf(engine, avatarId);
    expect(view.interruptedIdeas).toEqual([{ write: 1, idea: "кофе на балконе", count: 2, shot: "friend", stoppedBy: "rate-limited" }]);
    expect(view.scenes).toHaveLength(4);

    // A second idea write meanwhile reserves ids past the first's.
    await writeAndWait(engine, events, avatarId, idea("прогулка", 1));
    expect((await setOf(engine, avatarId)).scenes.filter((s) => s.origin === "own").map((s) => s.sceneId)).toEqual([7]);

    const end = await writeAndWait(engine, events, avatarId, { kind: "resume", write: 1 });
    expect(end).toMatchObject({ type: "job.done", payload: { result: { written: 2 } } });
    const after = await setOf(engine, avatarId);
    // The scenes of a write join the set when its sentences are accepted, so the resumed write's come after the one that finished meanwhile.
    expect(after.scenes.filter((s) => s.origin === "own").map((s) => s.sceneId)).toEqual([7, 5, 6]);
    expect(after.interruptedIdeas).toBeUndefined();
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(2, 1), writeId(1, 2)]);
  });

  test("a set with no room for the scenes refuses VALIDATION, free", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { count: 199 });
    const net = sceneNetwork();
    const { engine } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    expect(refused(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, idea("кофе", 2))))).toMatchObject({ code: "VALIDATION", sceneReason: "idea-room" });
    expect(net.writerCalls()).toHaveLength(0);
  });

  test("⟳ on an own scene writes again from its stored idea, never from the hand-edited text, and keeps its shot and pose", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { own: true });
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net);
    await writeAndWait(engine, events, avatarId, rewrite([5]));

    const body = JSON.stringify(net.writerCalls()[0]?.json());
    expect(body).toContain("кофе на балконе утром");
    expect(body).not.toContain("Typed by hand");
    expect((await setOf(engine, avatarId)).scenes[4]).toMatchObject({ origin: "own", text: `${SENTENCE} (5)`, edited: false, idea: "кофе на балконе утром", shot: "selfie", pose: "front" });
  });
});

// ---------- the money and the refusals of every review write ----------

describe("the money of a review write", () => {
  test("PRICE_CHANGED when the price rose above what the owner accepted: nothing is sent, reserved or written", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const net = sceneNetwork();
    const { engine } = await engineOver(net);
    const view = await setOf(engine, avatarId);

    for (const target of [rewrite([2]), idea("кофе", 1)]) expect(code(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT - 1, target)))).toBe("PRICE_CHANGED");

    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
    expect(fileOf(avatarId).revision).toBe(view.revision);
    expect(fileOf(avatarId).reviewWrites).toBeUndefined();
  });

  test("BUDGET_EXCEEDED when the month has no room for the worst case: nothing is written", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine } = await engineOver(sceneNetwork(), { monthlyBudgetMicros: 2 * ATTEMPT - 1 });
    const view = await setOf(engine, avatarId);
    expect(code(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))))).toBe("BUDGET_EXCEEDED");
    expect(fileOf(avatarId).reviewWrites).toBeUndefined();
  });

  test("the job's cap is the worst case it was priced at: the reserve carries the writer's ceiling under the job's own scope", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine, events } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 5 * ATTEMPT, rewrite([2]))));
    await jobEnd(events, jobId);
    expect(readLedger()[0]).toMatchObject({ type: "reserve", attemptId: writeId(1, 1), jobId, scope: { avatarJobId: jobId }, worstMicros: ATTEMPT });
  });

  test("an accepted price far above the estimate cannot raise the cap: a second attempt beyond the estimate is never reserved", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId, { writes: 1, records: [rewriteRecord({ k: 1, stoppedBy: "rate-limited" })] });
    await writeLedger(dir(), [reserve(writeId(1, 1)), settle(writeId(1, 1), 11_000), reserve(writeId(1, 2)), settle(writeId(1, 2), 0)]);
    const net = sceneNetwork({ writer: () => rejectedAnswer });
    const { engine, events } = await engineOver(net);
    // One attempt is left (one answered, one burnt free): the estimate is one ceiling, the window "accepted" ten.
    const end = await writeAndWait(engine, events, avatarId, { kind: "resume", write: 1 }, 10 * ATTEMPT);
    expect(end).toMatchObject({ type: "job.failed" });
    expect(net.writerCalls()).toHaveLength(1);
    expect(ledgerReserves()).toEqual([writeId(1, 1), writeId(1, 2), writeId(1, 3)]);
  });

  test("is AUTH_INVALID without a key", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine } = await engineOver(sceneNetwork(), { key: null });
    const view = await setOf(engine, avatarId);
    expect(code(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))))).toBe("AUTH_INVALID");
  });
});

describe("the refusals of a review write", () => {
  test("SCENES_CHANGED when the set moved since the window saw it; VALIDATION once the set is used; NOT_FOUND for a set that is not there", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);
    ok(await engine.handle(edit(view.revision, { op: "remove", sceneIds: [4] })));

    expect(code(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))))).toBe("SCENES_CHANGED");
    expect(code(await engine.handle(writeCommand(1, 2 * ATTEMPT, rewrite([2]), "set-nobody-404")))).toBe("NOT_FOUND");
  });

  test("a used set is read-only: its run's folder exists", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(libraryDir(), "runs", RUN), { recursive: true });
    const { engine } = await engineOver(sceneNetwork());
    const view = await setOf(engine, avatarId);
    expect(view.status).toBe("used");
    expect(refused(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))))).toMatchObject({ code: "VALIDATION", sceneReason: "set-used" });
  });

  test("one job at a time: a write while another runs is IN_FLIGHT and starts nothing; a free edit is refused too", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))));
    await until(() => gate.arrived() === 1, "the request");

    expect(code(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([3]))))).toBe("IN_FLIGHT");
    expect(code(await engine.handle(edit(view.revision, { op: "remove", sceneIds: [1] })))).toBe("IN_FLIGHT");
    gate.release();
    await jobEnd(events, jobId);
    expect(gate.arrived()).toBe(1);
  });

  test("a removed scene is not rewritten: VALIDATION, free", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const net = sceneNetwork();
    const { engine } = await engineOver(net);
    const view = await setOf(engine, avatarId);
    const removed = ok(await engine.handle(edit(view.revision, { op: "remove", sceneIds: [2] })));
    if (removed.type !== "scenes.edit" || !("sceneSet" in removed.result)) throw new Error("expected the set");
    expect(refused(await engine.handle(writeCommand(removed.result.sceneSet.revision, 2 * ATTEMPT, rewrite([2]))))).toMatchObject({ code: "VALIDATION", sceneReason: "target-removed", sceneId: 2 });
    expect(net.writerCalls()).toHaveLength(0);
  });
});

// ---------- carry-overs of the reviews of CS.4a ----------

describe("a crashed «Дописать» does not leave a stale «Готово»", () => {
  test("beginning a write forgets the last job's outcome: the set reads its scenes as they are", async () => {
    const avatarId = await seedAvatar();
    // 35 scenes, 25 written; the last job said «Готово 20 из 35» before the owner typed into five more.
    const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`stale${++seeded}`) });
    const base = sampleSet({ sceneSetId: SET, avatarId, runId: RUN, count: 35, written: 25 });
    await library.sceneSets.create({ ...base, write: { k: 1, kind: "compose", jobId: "job-seed-0001", stoppedBy: "network" }, writes: 1, lastOutcome: { total: 35, written: 20, gaveUp: 0 } });
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    expect(view.lastCompose).toEqual({ total: 35, written: 20, gaveUp: 0 });

    const jobId = jobOf(await engine.handle(command("scenes.write", { sceneSetId: SET, revision: view.revision, target: { kind: "unwritten" }, acceptedWorstMicros: 2 * ATTEMPT })));
    await until(() => gate.arrived() === 1, "the request");

    expect(fileOf(avatarId)).not.toHaveProperty("lastOutcome");
    expect((await setOf(engine, avatarId)).lastCompose).toEqual({ total: 35, written: 25, gaveUp: 0 });
    gate.release();
    await jobEnd(events, jobId);
    expect((await setOf(engine, avatarId)).lastCompose).toEqual({ total: 35, written: 35, gaveUp: 0 });
  });
});

describe("a store refusal is not a transient disk error", () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test("an accepted chunk whose set is gone is not retried: the store said no, and no is not a hiccup", async () => {
    const avatarId = await seedAvatar();
    const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`refuse${++seeded}`) });
    await library.sceneSets.create({ ...sampleSet({ sceneSetId: SET, avatarId, runId: RUN, count: 3 }), write: { k: 1, kind: "compose", jobId: "job-seed-0001" }, writes: 1 });
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    const jobId = jobOf(await engine.handle(command("scenes.write", { sceneSetId: SET, revision: view.revision, target: { kind: "unwritten" }, acceptedWorstMicros: 2 * ATTEMPT })));
    await until(() => gate.arrived() === 1, "the request");
    unlinkSync(setPath(avatarId));
    gate.release();
    await jobEnd(events, jobId);

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("trying once more"))).toBe(false);
  });

  test("the same for a review write's accepted answer", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const gate = held();
    const { engine, events } = await engineOver(sceneNetwork({ writer: gate.handler }));
    const view = await setOf(engine, avatarId);
    const jobId = jobOf(await engine.handle(writeCommand(view.revision, 2 * ATTEMPT, rewrite([2]))));
    await until(() => gate.arrived() === 1, "the request");
    unlinkSync(setPath(avatarId));
    gate.release();
    await jobEnd(events, jobId);

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("trying once more"))).toBe(false);
  });
});

describe("an accepted answer whose write hit a disk error after the rename", () => {
  let warn: { mockRestore: () => void };
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  /** The folder's flush fails once, right after the rename that closes a review write's record: the new text is on disk, the writer sees an error. */
  function failTheFlushThatClosesAWrite(avatarId: string) {
    const state = { failed: 0 };
    const afterRename = (path: string) => {
      if (state.failed > 0 || !path.endsWith(`${SET}.json`)) return;
      const records = JSON.parse(readFileSync(setPath(avatarId), "utf8")).reviewWrites ?? [];
      if (!records.some((r: { closed: boolean }) => r.closed)) return;
      state.failed += 1;
      throw Object.assign(new Error("EIO: the folder could not be flushed"), { code: "EIO" });
    };
    return { state, afterRename };
  }

  test("a rewrite ends done, not failed: the retry finds its record closed with the very text it wrote, and takes that as done", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const disk = failTheFlushThatClosesAWrite(avatarId);
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net, { testHooks: { afterRename: disk.afterRename } });

    const end = await writeAndWait(engine, events, avatarId, rewrite([2]));

    expect(disk.state.failed).toBe(1);
    expect(end).toMatchObject({ type: "job.done" });
    expect(net.writerCalls()).toHaveLength(1);
    expect(ledgerReserves()).toEqual([writeId(1, 1)]);
    const view = await setOf(engine, avatarId);
    expect(view.scenes[1]?.text).toContain(SENTENCE);
    expect(fileOf(avatarId).reviewWrites?.[0]).toMatchObject({ k: 1, closed: true });
  });

  test("an idea write ends done, not failed, and its scene is in the set once", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const disk = failTheFlushThatClosesAWrite(avatarId);
    const net = sceneNetwork();
    const { engine, events } = await engineOver(net, { testHooks: { afterRename: disk.afterRename } });

    const end = await writeAndWait(engine, events, avatarId, idea("кофе на балконе"));

    expect(disk.state.failed).toBe(1);
    expect(end).toMatchObject({ type: "job.done" });
    expect(ledgerReserves()).toEqual([writeId(1, 1)]);
    const view = await setOf(engine, avatarId);
    expect(view.scenes.filter((s) => s.origin === "own")).toHaveLength(1);
  });
});

describe("the files of the set", () => {
  test("a review write rewrites only the set's own file: no other file appears next to it", async () => {
    const avatarId = await seedAvatar();
    await seedReview(avatarId);
    const { engine, events } = await engineOver(sceneNetwork());
    await writeAndWait(engine, events, avatarId, rewrite([2]));
    const folder = join(libraryDir(), "avatars", avatarId, "scenes");
    expect(readdirSync(folder).filter((n) => !n.endsWith(".json"))).toEqual([]);
    expect(readdirSync(folder)).toEqual([`${SET}.json`]);
  });

  test("the clock is the harness's: NOW is a fixed instant (keeps the import honest)", () => {
    expect(typeof NOW).toBe("number");
  });
});
