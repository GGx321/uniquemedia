import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvatarDescriptor, CategorySnapshot, EngineError } from "../../shared/engine";
import { openLibrary, type Library } from "../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { Budget, scopeKey } from "../money/budget";
import { Ledger, type Scope } from "../money/ledger";
import { PriceBook } from "../money/prices";
import { chatBody, fakeFetch, imageBody, JPEG, makeClient, type FetchCall, type Reply } from "../openrouter/testing/fakes";
import { plan as planScenes } from "../scenes";
import { isImpliedSlot, redressSlot } from "../scenes/redress";
import { templateSentence } from "../../shared/scenes/template";
import type { PlanSlot } from "../scenes/schema";
import { RunEventSchema, type RunEvent } from "./journal";
import { buildRunPlan, buildSceneRunPlan, RunPlanSchema, type RunPlan, type SceneRunSource } from "./plan";
import { CpuPool, NetworkPool } from "./pools";
import { reportingTo, runPhotoRun, type RunJobEnd } from "./runJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// 2026-11-04 (the owner's answers after S5.BAR, «1 А» and «2 А»): what a run draws of a STORED slot that today's rules would not plan. Every image prompt is assembled in the run job, so
// every stored scene meets the rule there: a set's scene, a request run's plan, an autopilot slice, a resume of an old run.
// - An imported avatar (or one of unknown origin) is never drawn under an implied cover. A slot with no sentence yet is re-dressed in lingerie, deterministically, on the same route and
//   reserve; a stored sentence (a set's text, a sentence journaled before) ends its slot for free (`slot-text-problem`), unless the owner wrote it.
// - A «rooms» slot on her balcony in a custom world at the water (lingerie over the water) is never drawn: it ends for free, for every avatar.

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };
const GROK = "x-ai/grok-imagine-image-2.0";
const TEXT = "x-ai/grok-4.3";
const CAP = 9_000_000;
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const COVER_WORDS = /\b(?:sheets?|bedsheets?|towels?|foam|bubbles)\b/i;
const CUSTOM = "cat-fixture-sea";
const SNAPSHOT: CategorySnapshot = { ref: CUSTOM, name: "Море", label: "Sea trip", style: "phone" };

let dir = "";
let library: Library;
let avatarId = "";
let budget: Budget;
const caps = new Map<string, number>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-run-job-stored-"));
  await mkdir(join(dir, "library"));
  library = (await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("lib"), downscaleReference: async () => JPEG })).library;
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR.text });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  avatarId = avatar.id;
  caps.clear();
  const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
  budget = new Budget(ledger, { runCapMicros: (scope) => caps.get(scopeKey(scope)) ?? 0, monthlyBudgetMicros: 50_000_000, clock: () => NOW, monotonic: () => 0 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A nightwear plan at «Смелая» drawn for a Studio-created avatar, with at least one implied cover: what a plan stored before the origin rule may hold for anyone. */
function nightwearWithCovers(count: number): { seed: number; slots: PlanSlot[] } {
  for (let seed = 1; seed < 200; seed++) {
    const slots = planScenes({ seed, count, categories: ["nightwear"], level: "bold", impliedNudity: true }).slots;
    if (slots.some(isImpliedSlot) && slots.some((s) => !isImpliedSlot(s))) return { seed, slots };
  }
  throw new Error("no nightwear plan with an implied cover");
}

async function requestRun(slots: PlanSlot[], seed: number, categories: CategorySnapshot[] = []): Promise<RunPlan> {
  const run = buildRunPlan({
    runId: RUN_ID,
    avatarId,
    createdAt: new Date(NOW).toISOString(),
    request: { avatarId, count: slots.length, categories: ["nightwear"], level: "bold" },
    imageAgeCheck: "off",
    models: { imageModel: GROK, textModel: TEXT },
    capMicros: CAP,
    plannedWorstMicros: CAP,
    ...(categories.length === 0 ? {} : { categories }),
    scenes: { version: 1, seed, slots },
  });
  await library.createRun(RUN_ID, run, RunPlanSchema);
  caps.set(scopeKey(SCOPE), CAP);
  return run;
}

async function setRun(scenes: SceneRunSource[], categories: CategorySnapshot[] = []): Promise<RunPlan> {
  const run = buildSceneRunPlan({
    runId: RUN_ID,
    avatarId,
    createdAt: new Date(NOW).toISOString(),
    sceneSetId: "set-00000001",
    imageAgeCheck: "off",
    models: { imageModel: GROK, textModel: TEXT },
    capMicros: CAP,
    plannedWorstMicros: CAP,
    scenes,
    ...(categories.length === 0 ? {} : { categories }),
  });
  await library.createRun(RUN_ID, run, RunPlanSchema);
  caps.set(scopeKey(SCOPE), CAP);
  return run;
}

function network(writer: (call: FetchCall) => Reply = () => ({ status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.001 }) })) {
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return { status: 200, body: imageBody(PNG_1X1, { cost: 0.04 }) };
    if (call.url.endsWith("/chat/completions")) return writer(call);
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 96 }, () => route));
  return { fetch: net.fetch, imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")), chatCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions")) };
}

function start(run: RunPlan, net: ReturnType<typeof network>, studioCreated: boolean): Promise<RunJobEnd> {
  const pool = new NetworkPool({ max: 4 });
  const { client } = makeClient(reportingTo(pool, net.fetch));
  return runPhotoRun(
    {
      generateImage: client.generateImage,
      chat: client.chat,
      budget,
      priceBook: PriceBook.fallback(),
      library,
      pool,
      cpu: new CpuPool(2),
      gates: [],
      now: () => new Date(NOW),
      errorOf: (error: unknown): EngineError => ({ code: "INTERNAL", detail: error instanceof Error ? error.message : String(error) }),
      impliedNudityOf: () => studioCreated,
    },
    { plan: run, jobId: "job-00000001", descriptor: DESCRIPTOR, signal: new AbortController().signal },
  );
}

async function journal(): Promise<RunEvent[]> {
  return (await library.readJournal(RUN_ID, RunEventSchema)).events;
}
async function promptsBySlot(): Promise<Map<number, string>> {
  return new Map((await journal()).flatMap((e) => (e.type === "prompts" ? e.prompts.map((p) => [p.slotIndex, p.prompt] as const) : [])));
}
const reservedSlots = (): Set<number> =>
  new Set(budget.ledger.lines.flatMap((l) => (l.type === "reserve" ? [Number(/:slot-(\d+)#/.exec(l.attemptId)?.[1] ?? 0)] : [])).filter((n) => n > 0));

describe("a stored implied cover with no sentence yet is re-dressed for an imported avatar", () => {
  test("every slot is drawn; the implied ones in lingerie with no cover word, on the route, and nothing is asked of the writer", async () => {
    const { seed, slots } = nightwearWithCovers(10);
    const implied = slots.filter(isImpliedSlot).map((s) => s.slotIndex);
    const run = await requestRun(slots, seed);
    const net = network();
    const end = await start(run, net, false);
    expect(end.status).toBe("done");
    expect(end.status === "done" && end.photoIds).toHaveLength(slots.length);
    expect(net.chatCalls()).toHaveLength(0);
    const prompts = await promptsBySlot();
    for (const slotIndex of implied) expect({ slotIndex, cover: COVER_WORDS.test(prompts.get(slotIndex) ?? "sheet") }).toEqual({ slotIndex, cover: false });
    expect(net.imageCalls().every((call) => call.json().model !== GROK)).toBe(true);
  });

  test("the avatar's history keeps the outfit she was drawn in, never the cover", async () => {
    const { seed, slots } = nightwearWithCovers(10);
    const run = await requestRun(slots, seed);
    await start(run, network(), false);
    const history = await library.recentPairs(avatarId, 50);
    expect(history).toHaveLength(slots.length);
    expect(history.filter((h) => COVER_WORDS.test(h.outfit))).toEqual([]);
  });

  test("a Studio-created avatar is drawn the stored frame, its cover included", async () => {
    const { seed, slots } = nightwearWithCovers(10);
    const implied = slots.filter(isImpliedSlot).map((s) => s.slotIndex);
    const run = await requestRun(slots, seed);
    await start(run, network(), true);
    const prompts = await promptsBySlot();
    expect(implied.some((slotIndex) => COVER_WORDS.test(prompts.get(slotIndex) ?? ""))).toBe(true);
  });
});

describe("a stored sentence of an implied cover is skipped for free for an imported avatar", () => {
  /** A set's scenes: the nightwear plan's slots, each with the sentence the set holds. */
  const sources = (slots: readonly PlanSlot[], edited: ReadonlySet<number> = new Set()): SceneRunSource[] =>
    slots.map((slot, i) => ({ sceneId: i + 1, text: `In her bedroom, she ${slot.activity}, wearing ${slot.outfit}.`, slot, ...(edited.has(slot.slotIndex) ? { edited: true } : {}) }));

  test("a set's scene: no request and no reserve for it, its slot ends slot-text-problem, the others are drawn", async () => {
    const { slots } = nightwearWithCovers(8);
    const implied = slots.filter(isImpliedSlot).map((s) => s.slotIndex);
    const run = await setRun(sources(slots));
    const net = network();
    const end = await start(run, net, false);
    expect(end.status).toBe("done");
    expect(end.status === "done" && end.photoIds).toHaveLength(slots.length - implied.length);
    expect(end.status === "done" && end.failedReasons).toEqual(implied.map((slotIndex) => ({ slotIndex, reason: "slot-text-problem" })));
    expect(net.imageCalls()).toHaveLength(slots.length - implied.length);
    for (const slotIndex of implied) expect({ slotIndex, reserved: reservedSlots().has(slotIndex) }).toEqual({ slotIndex, reserved: false });
    const ends = (await journal()).flatMap((e) => (e.type === "slot" && e.status === "failed" ? [{ slotIndex: e.slotIndex, code: e.error?.code, reason: e.error?.sceneReason }] : []));
    expect(ends).toEqual(implied.map((slotIndex) => ({ slotIndex, code: "VALIDATION", reason: "slot-text-problem" })));
  });

  test("the owner's own edit of such a scene is his and is drawn as he wrote it; a Studio-created avatar's scene is drawn too", async () => {
    const { slots } = nightwearWithCovers(8);
    const implied = new Set(slots.filter(isImpliedSlot).map((s) => s.slotIndex));
    const edited = await setRun(sources(slots, implied));
    expect(edited.scenes.slots.filter((s) => implied.has(s.slotIndex)).every((s) => "ownText" in s && s.ownText === true)).toBe(true);
    const end = await start(edited, network(), false);
    expect(end.status === "done" && end.photoIds).toHaveLength(slots.length);
  });

  test("a Studio-created avatar's stored scene is drawn as stored", async () => {
    const { slots } = nightwearWithCovers(8);
    const run = await setRun(sources(slots));
    const end = await start(run, network(), true);
    expect(end.status === "done" && end.photoIds).toHaveLength(slots.length);
  });

  test("a resume: a sentence journaled before the rule is skipped for free, the rest drawn", async () => {
    const { seed, slots } = nightwearWithCovers(10);
    const implied = slots.filter(isImpliedSlot).map((s) => s.slotIndex);
    const run = await requestRun(slots, seed);
    const sentences = run.writerChunks.flatMap((c) => c.slotIndexes).map((slotIndex) => ({ slotIndex, sentence: `In her bedroom, she lies under the white sheet (${slotIndex}).` }));
    for (const chunk of run.writerChunks) {
      await library.appendJournal(RUN_ID, { type: "writer", chunk: chunk.chunk, sentences: sentences.filter((s) => chunk.slotIndexes.includes(s.slotIndex)), at: new Date(NOW).toISOString() }, RunEventSchema);
    }
    const net = network();
    const end = await start(run, net, false);
    expect(end.status === "done" && end.failedReasons).toEqual(implied.map((slotIndex) => ({ slotIndex, reason: "slot-text-problem" })));
    expect(net.imageCalls()).toHaveLength(slots.length - implied.length);
  });

  test("a resume of a run whose earlier job re-dressed and wrote the slot draws it re-dressed, as written", async () => {
    const { seed, slots } = nightwearWithCovers(10);
    const implied = slots.filter(isImpliedSlot);
    const run = await requestRun(slots, seed);
    // What the earlier job journaled: the template's sentence of each re-dressed slot (and of every other slot as it is).
    const written = slots.map((slot) => {
      const now = isImpliedSlot(slot) ? redressSlot(slot, seed) : slot;
      if (now === null) throw new Error("no re-dress");
      return { slotIndex: slot.slotIndex, sentence: templateSentence({ ...now, route: now.route }, { key: `${RUN_ID}:${now.attemptIdBase}` }) ?? "" };
    });
    for (const chunk of run.writerChunks) {
      await library.appendJournal(RUN_ID, { type: "writer", chunk: chunk.chunk, sentences: written.filter((s) => chunk.slotIndexes.includes(s.slotIndex)), at: new Date(NOW).toISOString() }, RunEventSchema);
    }
    const net = network();
    const end = await start(run, net, false);
    expect({ failed: end.status === "done" ? (end.failedReasons ?? []) : "not done", photos: end.status === "done" ? end.photoIds.length : 0 }).toEqual({ failed: [], photos: slots.length });
    const prompts = await promptsBySlot();
    for (const slot of implied) expect({ slotIndex: slot.slotIndex, cover: COVER_WORDS.test(prompts.get(slot.slotIndex) ?? "sheet") }).toEqual({ slotIndex: slot.slotIndex, cover: false });
  });
});

describe("an old «rooms» slot on her balcony in a world at the water is skipped for free (item 1)", () => {
  const balcony = (slotIndex: number): PlanSlot => ({
    slotIndex,
    category: CUSTOM,
    location: "her balcony",
    timeOfDay: "morning",
    activity: "leans on the railing in the sun",
    outfit: "a white lace bra and panties",
    shot: "friend",
    capture: "timer",
    pose: "front",
    attemptIdBase: `slot-${slotIndex}`,
    repeatedPair: false,
    level: "flirty",
    route: "seedream",
    world: "the sundeck of a sailing yacht",
  });
  const room = (slotIndex: number): PlanSlot => ({ ...balcony(slotIndex), location: "her room", activity: "sits up in bed, knees drawn up" });

  test.each([false, true])("a set's scene ends slot-text-problem with no request, whatever the avatar's origin (Studio-created: %p)", async (studio) => {
    const run = await setRun(
      [balcony(1), room(2)].map((slot, i) => ({ sceneId: i + 1, text: `${i === 0 ? "On her balcony" : "In her room"}, she ${slot.activity}, wearing ${slot.outfit}.`, slot })),
      [SNAPSHOT],
    );
    const net = network();
    const end = await start(run, net, studio);
    expect({ reasons: end.status === "done" && end.failedReasons, images: net.imageCalls().length }).toEqual({ reasons: [{ slotIndex: 1, reason: "slot-text-problem" }], images: 1 });
  });

  test("a request run's slot is never asked of the writer: its chunk asks only the others", async () => {
    const asked: number[][] = [];
    const writer = (call: FetchCall): Reply => {
      const user = (call.json().messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "";
      const slots = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1)) as { slotIndex: number }[];
      asked.push(slots.map((s) => s.slotIndex));
      const scenes = slots.map((s) => ({ slotIndex: s.slotIndex, sentence: "In her room, she sits up in bed, knees drawn up in a white lace bra and panties, the sea glittering through the porthole." }));
      return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.002 }) };
    };
    const run = await requestRun([balcony(1), room(2)], 7, [SNAPSHOT]);
    const net = network(writer);
    const end = await start(run, net, false);
    expect(asked.flat().includes(1)).toBe(false);
    expect({ reasons: end.status === "done" && end.failedReasons, images: net.imageCalls().length }).toEqual({ reasons: [{ slotIndex: 1, reason: "slot-text-problem" }], images: 1 });
  });
});
