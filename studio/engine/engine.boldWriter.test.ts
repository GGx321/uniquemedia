import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { slotCoverageOf } from "../shared/scenes/template";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { RunEventSchema, type RunEvent } from "./runs/journal";
import { RunPlanSchema, type RunPlan } from "./runs/plan";
import type { QaGate } from "./runs/qa";
import type { PlanSlot } from "./scenes";
import { LLM_ONLY_REF } from "./scenes/testing/llmOnlyFixture";
import { PLACE_PREPOSITIONS, writerBoldMessages } from "./scenes/writer";
import type { StoredSceneSet } from "./library/sceneSets";
import { command, engineSettings, GOOD, jobEnd, ledgerLines, network, ok, portraitPng, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { seedLlmOnlyCategory } from "./testing/llmOnlyCategory";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// 5a.4 (S5.BA5, plan s5a4 §5.3, I5.74, I5.77; the BA4 hand-off): a run started straight from the photo card, with no scene set, at «Смелая» over a custom category draws its slots on
// the route, and the model writes them. Its writer phase is the planned writer's (`plannedWriterConfig`): each such chunk is asked with the bold prompt and reserves the bold call's
// worst case (48 750 µ$ an attempt, the figure the run's estimate priced), and the coverage its sentences end with is the avatar's origin's (`studioCreated`). The template's own
// sentences of a run («Дом» at «Смелая») end with the same coverage by origin.

const dir = useEngineDir("studio-engine-bold-writer-");
const libraryDir = () => join(dir(), "library");
const BOLD_ATTEMPT = 48_750;

let seeded = 0;

/** An active avatar: made in Studio (a wizard `candidate-4` master) or read as imported (a generated master with no wizard slot). */
async function seedAvatar(studio: boolean): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`boldw${++seeded}`) });
  const avatar = await library.createAvatar({ name: studio ? "Ava" : "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const source = studio ? { ...SAMPLE_SOURCE, slot: "candidate-4" } : SAMPLE_SOURCE;
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, source, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  await seedLlmOnlyCategory(libraryDir());
  return avatar.id;
}

/** The slots a writer request asked about, as its own prompt names them. */
function askedIn(call: FetchCall): { slotIndex: number; location: string; activity: string; outfit: string; world?: string }[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
}

/** The place opened with a preposition the bold reader takes for it (S5.BA4d): «On her balcony», «By her window»; «In» for every other place. */
const opener = (location: string): string => {
  const first = PLACE_PREPOSITIONS[location]?.[0] ?? "in";
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${location}`;
};
/** A sentence each asked slot passes the bold reader with: its place, «she» and its activity word for word, its outfit as given. */
const keeping = (call: FetchCall): Reply => ({
  status: 200,
  body: chatBody(
    JSON.stringify({
      scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: `${opener(s.location)}${s.world === undefined ? "" : ` while staying near ${s.world.replace(/^an? /, "the ")}`}, she ${s.activity} in ${s.outfit}, a cup of tea beside her.` })),
    }),
    { cost: 0.006 },
  ),
});

const systemOf = (call: FetchCall | undefined): string => {
  const messages = call?.json().messages;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  return typeof first === "object" && first !== null && "content" in first && typeof first.content === "string" ? first.content : "";
};

const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });

async function boot() {
  const net = network({ descriptors: [keeping, keeping, keeping, keeping], image: () => ({ hang: true }) });
  const settings = engineSettings(dir(), { imageAgeCheck: "off" });
  const started = await startEngine(dir(), { init: { settings }, net, deps: { qaGates: [faceGate()] } });
  return { ...started, net };
}

/** Starts a run at «Смелая» at its own estimate and waits until its writer phase has journaled every chunk. */
async function boldRun(started: Awaited<ReturnType<typeof boot>>, avatarId: string, categories: string[], count: number): Promise<{ plan: RunPlan; written: Map<number, string>; runId: string }> {
  const asked = { avatarId, count, categories, level: "bold" };
  const estimate = ok(await started.engine.handle(command("runs.estimate", asked)));
  if (estimate.type !== "runs.estimate") throw new Error(`expected an estimate, got ${estimate.type}`);
  const answer = ok(await started.engine.handle(command("runs.start", { ...asked, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
  if (answer.type !== "runs.start") throw new Error(`expected a start, got ${answer.type}`);
  const library = started.engine.library;
  if (library === null) throw new Error("no library");
  const plan = await library.readRun(answer.result.runId, RunPlanSchema);
  const writerEvents = async (): Promise<RunEvent[]> => (await library.readJournal(answer.result.runId, RunEventSchema)).events.filter((e) => e.type === "writer" && e.partial !== true);
  let events: RunEvent[] = [];
  const poll = setInterval(() => void writerEvents().then((found) => (events = found)), 5);
  try {
    try {
      await until(() => events.length === plan.writerChunks.length, "the writer's chunks in the journal", 15_000);
    } finally {
      clearInterval(poll);
    }
    const written = new Map(events.flatMap((e) => (e.type === "writer" ? e.sentences.map((s): [number, string] => [s.slotIndex, s.sentence]) : [])));
    return { plan, written, runId: answer.result.runId };
  } finally {
    // The run's job is still writing its journal, even when the wait above failed: cancel it and wait for its end, so the teardown never removes the library under it.
    ok(await started.engine.handle(command("runs.cancel", { runId: answer.result.runId })));
    await jobEnd(started.events, answer.result.jobId);
  }
}

const boldRunIds = (started: Awaited<ReturnType<typeof boot>>, avatarId: string) => boldRun(started, avatarId, [LLM_ONLY_REF], 4);

/**
 * Whether a sentence ends with the coverage of the avatar's origin and not the other one: where the two differ, it ends with its own (an origin with none says none, so it must
 * not end with the other's); where they agree there is nothing to tell.
 */
function endsByOrigin(text: string, slot: PlanSlot, studio: boolean): boolean {
  const mine = slotCoverageOf({ ...slot, route: slot.route }, studio);
  const other = slotCoverageOf({ ...slot, route: slot.route }, !studio);
  if (mine === other) return true;
  return mine === undefined ? other === undefined || !text.endsWith(other) : text.endsWith(mine);
}

const plannedOf = (plan: RunPlan): PlanSlot[] => plan.scenes.slots.flatMap((slot) => ("kind" in slot ? [] : [slot]));

describe("a run straight from the card at «Смелая» over a custom category", () => {
  test("asks the model with the bold prompt, and its attempt reserves the bold call's worst case", async () => {
    const avatarId = await seedAvatar(false);
    const started = await boot();
    const { plan } = await boldRun(started, avatarId, [LLM_ONLY_REF], 4);
    const writerCalls = started.net.calls.filter((c) => c.url.endsWith("/chat/completions"));
    expect(writerCalls.length).toBeGreaterThan(0);
    expect(systemOf(writerCalls[0])).toBe(writerBoldMessages(plannedOf(plan))[0]?.content ?? "");
    const reserved = ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" && l.attemptId.includes(":writer-") ? [l.worstMicros] : []));
    expect(reserved).toEqual([BOLD_ATTEMPT]);
  });

  for (const studio of [true, false]) {
    test(`its sentences end with the coverage of an avatar ${studio ? "made in Studio" : "read as imported"}`, async () => {
      const avatarId = await seedAvatar(studio);
      const started = await boot();
      const { plan, written } = await boldRun(started, avatarId, [LLM_ONLY_REF], 4);
      const slots = plannedOf(plan);
      expect(slots.some((slot) => slotCoverageOf({ ...slot, route: slot.route }, true) !== slotCoverageOf({ ...slot, route: slot.route }, false))).toBe(true);
      for (const slot of slots) expect({ slot: slot.slotIndex, byOrigin: endsByOrigin(written.get(slot.slotIndex) ?? "", slot, studio) }).toEqual({ slot: slot.slotIndex, byOrigin: true });
    });
  }
});

describe("a run that is cancelled after its writer phase", () => {
  test("has journaled the end of its job before the test goes on, so a teardown cannot race its writes", async () => {
    const avatarId = await seedAvatar(false);
    const started = await boot();
    const { runId } = await boldRunIds(started, avatarId);
    const journal = await started.engine.library?.readJournal(runId, RunEventSchema);
    const jobs = (journal?.events ?? []).flatMap((e) => (e.type === "job" ? [e.status] : []));
    expect(jobs.at(-1)).toBe("cancelled");
  });
});

describe("a run's template sentences at «Смелая»", () => {
  for (const studio of [true, false]) {
    test(`«Дом» at «Смелая»: every sentence ends with the coverage of an avatar ${studio ? "made in Studio" : "read as imported"}`, async () => {
      const avatarId = await seedAvatar(studio);
      const started = await boot();
      const { plan, written } = await boldRun(started, avatarId, ["home"], 6);
      const slots = plannedOf(plan);
      expect(slots.some((slot) => slotCoverageOf({ ...slot, route: slot.route }, true) !== slotCoverageOf({ ...slot, route: slot.route }, false))).toBe(true);
      for (const slot of slots) expect({ slot: slot.slotIndex, byOrigin: endsByOrigin(written.get(slot.slotIndex) ?? "", slot, studio) }).toEqual({ slot: slot.slotIndex, byOrigin: true });
    });
  }
});

/** Composes at «Смелая» (the model writes a custom category's scenes, the template every built-in one) and answers the set once it is written. */
async function boldCompose(started: Awaited<ReturnType<typeof boot>>, avatarId: string, categories: string[], count: number): Promise<StoredSceneSet> {
  const answer = ok(await started.engine.handle(command("scenes.compose", { avatarId, count, categories, level: "bold", acceptedWorstMicros: 10_000_000 })));
  if (answer.type !== "scenes.compose") throw new Error(`expected a compose, got ${answer.type}`);
  if (answer.result.jobId !== null) await jobEnd(started.events, answer.result.jobId);
  const set = await started.engine.library?.sceneSets.get(avatarId, answer.result.sceneSetId);
  if (set === null || set === undefined) throw new Error("no set");
  return set;
}

const textsOf = (set: StoredSceneSet): Map<number, string> => new Map(set.scenes.flatMap((scene) => (scene.origin === "planned" && scene.text !== null ? [[scene.sceneId, scene.text] as const] : [])));
const slotsOfSet = (set: StoredSceneSet): PlanSlot[] => set.scenes.flatMap((scene) => (scene.origin === "planned" ? [scene.slot] : []));

describe("a set's writes end their «Смелая» sentences with the coverage of the avatar's origin", () => {
  for (const studio of [true, false]) {
    for (const [what, categories] of [["a custom category (the bold writer)", [LLM_ONLY_REF]], ["«Дом» (the template)", ["home"]]] as const) {
      test(`a compose of ${what} for an avatar ${studio ? "made in Studio" : "read as imported"}`, async () => {
        const avatarId = await seedAvatar(studio);
        const started = await boot();
        const set = await boldCompose(started, avatarId, [...categories], 6);
        const texts = textsOf(set);
        const slots = slotsOfSet(set);
        expect(texts.size).toBe(slots.length);
        expect(slots.some((slot) => slotCoverageOf({ ...slot, route: slot.route }, true) !== slotCoverageOf({ ...slot, route: slot.route }, false))).toBe(true);
        for (const slot of slots) expect({ slot: slot.slotIndex, byOrigin: endsByOrigin(texts.get(slot.slotIndex) ?? "", slot, studio) }).toEqual({ slot: slot.slotIndex, byOrigin: true });
      });
    }

    test(`a rewrite of «Дом» scenes for an avatar ${studio ? "made in Studio" : "read as imported"}`, async () => {
      const avatarId = await seedAvatar(studio);
      const started = await boot();
      const set = await boldCompose(started, avatarId, ["home"], 6);
      const target = { kind: "rewrite" as const, sceneIds: [1, 2, 3], redraw: true };
      const write = ok(await started.engine.handle(command("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros: 10_000_000 })));
      if (write.type !== "scenes.write") throw new Error(`expected a write, got ${write.type}`);
      await jobEnd(started.events, write.result.jobId);
      const after = await started.engine.library?.sceneSets.get(avatarId, set.sceneSetId);
      if (after === null || after === undefined) throw new Error("no set");
      const texts = textsOf(after);
      const rewritten = slotsOfSet(after).filter((slot) => target.sceneIds.includes(slot.slotIndex));
      for (const slot of rewritten) expect({ slot: slot.slotIndex, byOrigin: endsByOrigin(texts.get(slot.slotIndex) ?? "", slot, studio) }).toEqual({ slot: slot.slotIndex, byOrigin: true });
    });
  }
});
