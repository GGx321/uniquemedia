import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { coverageOf } from "../../shared/scenes/template";
import { SceneSetStore, type StoredSceneSet } from "../library/sceneSets";
import { useTempDir } from "../library/testing/helpers";
import { writerAttemptWorstMicros, writerCallOf } from "../money/estimate";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { NetworkPool } from "../runs/pools";
import { POOLS, type PlanSlot } from "../scenes";
import { categoryLabelOf } from "../scenes/categories";
import { LLM_ONLY_POOL, LLM_ONLY_REF, llmOnlySnapshot } from "../scenes/testing/llmOnlyFixture";
import { PLACE_PREPOSITIONS, writerBoldMessages, writerMessages } from "../scenes/writer";
import { planSceneSet } from "./compose";
import { beginIdea, beginRewrite, withReviewWriteAccepted, withReviewWriteClosed } from "./reviewMutations";
import { runReviewWrite } from "./reviewWriteJob";
import { reviewWriteEstimate } from "./estimate";
import { planReviewWrite } from "./reviewPlan";
import { ideaSystemPrompt } from "../scenes/ideaWriter";
import { OWN_BOLD_COVERAGE } from "../../shared/scenes/ownScene";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA4, plan s5a4 §5.3.4 «The mode», r2.1 L3; the BA5a review's R2-L2): a rewrite of planned scenes is asked in the mode of the scenes it sends the model.
// A rewrite of a custom category's «Смелая» scene sends the bold prompt and reserves the bold call's worst case, `writerAttemptWorstMicros(book,
// writerCallOf("bold"))`; any other rewrite, and every idea write, is asked as before at the ordinary call's.

const root = useTempDir("studio-review-write-mode-");
const AVATAR = "avatar-aaaa-0001";
const SET = "set-aaaa-0001";

let money: Money;
let store: SceneSetStore;
beforeEach(async () => {
  money = await setupMoney();
  store = new SceneSetStore(root());
});
afterEach(async () => {
  await money.cleanup();
});

/** A composed set of the model-only custom category at `level`, every scene written. */
async function seed(level: "flirty" | "bold"): Promise<StoredSceneSet> {
  const planned = planSceneSet({
    sceneSetId: SET,
    avatarId: AVATAR,
    runId: "run-aaaa-0001",
    jobId: "job-aaaa-0001",
    count: 4,
    categories: [LLM_ONLY_REF],
    level,
    pools: { ...POOLS, [LLM_ONLY_REF]: LLM_ONLY_POOL },
    snapshots: [llmOnlySnapshot()],
    recentPairs: [],
    textModel: "x-ai/grok-4.3",
  });
  return store.create({ ...planned, scenes: planned.scenes.map((s) => ({ ...s, text: `An old sentence (${s.sceneId}).` })) });
}

async function setNow(): Promise<StoredSceneSet> {
  const set = await store.get(AVATAR, SET);
  if (set === null) throw new Error("the set is gone");
  return set;
}

const slotOf = (set: StoredSceneSet, sceneId: number): PlanSlot => {
  const scene = set.scenes.find((s) => s.sceneId === sceneId);
  if (scene === undefined || scene.origin !== "planned") throw new Error("not planned");
  return scene.slot;
};

function askedIn(call: FetchCall): { slotIndex: number; location?: string; activity?: string; outfit?: string; world?: string }[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
}

/** The place with its own preposition (S5.BA4d, PLACE_PREPOSITIONS): «On her balcony», «By her window», «In her room». */
const placed = (location: string): string => {
  const prep = PLACE_PREPOSITIONS[location]?.[0] ?? "in";
  return `${prep.charAt(0).toUpperCase()}${prep.slice(1)} ${location}`;
};

/** A sentence each planned slot asked about passes its reader with (its place, «she» and its activity, its outfit, no gaze). */
const keeping: Step = (call: FetchCall): Reply => ({
  status: 200,
  body: chatBody(JSON.stringify({ scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: `${placed(s.location ?? "")}, she ${s.activity} in ${s.outfit}, a cup of tea beside her.` })) }), { cost: 0.004 }),
});
const ideaAnswer: Step = (call: FetchCall): Reply => ({
  status: 200,
  body: chatBody(JSON.stringify({ scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: "She sips coffee on a sunny balcony, a cup in her free hand.", pose: "front" })) }), { cost: 0.004 }),
});

/** Runs the set's newest write (the one the test just recorded). */
async function run(steps: Step[], impliedNudity?: boolean) {
  const k = (await setNow()).writes;
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const pool = new NetworkPool({ max: 6 });
  const end = runReviewWrite(
    {
      chat: client.chat,
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      load: async () => setNow(),
      accept: async (k, sentences, angles, partial) => {
        await store.update(AVATAR, SET, (s) => withReviewWriteAccepted(s, k, sentences, angles, { partial: partial === true }));
      },
      giveUp: async (k) => {
        await store.update(AVATAR, SET, (s) => withReviewWriteClosed(s, k));
      },
      progress: () => undefined,
      ...(impliedNudity === undefined ? {} : { impliedNudity }),
    },
    { k, jobId: "job-aaaa-0002", scope: { avatarJobId: "job-aaaa-0002" }, signal: new AbortController().signal },
  );
  return { net, end };
}

const reserves = (): number[] => money.lines().flatMap((l) => (l.type === "reserve" && typeof l.worstMicros === "number" ? [l.worstMicros] : []));
const systemOf = (call: FetchCall | undefined): string => {
  const messages = call?.json().messages;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  return typeof first === "object" && first !== null && "content" in first && typeof first.content === "string" ? first.content : "";
};
const rewrite = (sceneIds: number[]) => (s: StoredSceneSet) => beginRewrite(s, { jobId: "job-aaaa-0002", sceneIds, redraw: false, slots: [], snapshots: [] });

describe("a rewrite of planned scenes is asked in their mode", () => {
  test("a custom category's «Смелая» scene: the bold prompt, and the bold call's worst case reserved (48 750 µ$)", async () => {
    const set = await seed("bold");
    expect(slotOf(set, 2).route).toBe("seedream");
    await store.update(AVATAR, SET, rewrite([2]));
    const { net, end } = await run([keeping]);
    expect(await end).toEqual({ status: "done", written: 1, unwritten: 0 });
    expect(systemOf(net.calls[0])).toBe(writerBoldMessages([slotOf(set, 2)])[0]?.content ?? "");
    expect(reserves()).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("bold"))]);
    expect(reserves()).toEqual([48_750]);
  });

  test.each([
    ["an avatar of unknown origin: the kept one", undefined],
    ["a Studio-created avatar: the open one", true],
  ] as const)("its accepted sentence carries the outfit's coverage by origin, once (%s)", async (_, impliedNudity) => {
    const set = await seed("bold");
    const slot = slotOf(set, 2);
    const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
    const worn = hit?.bank.outfits.find((o) => o.text === slot.outfit);
    if (hit === undefined || worn === undefined) throw new Error("a routed custom scene is in a «Смелая» bank");
    const coverage = coverageOf(hit.moment ?? {}, worn, impliedNudity === true);
    await store.update(AVATAR, SET, rewrite([2]));
    await (await run([keeping], impliedNudity)).end;
    const said = `In ${slot.location}, she ${slot.activity} in ${slot.outfit}, a cup of tea beside her.`;
    expect((await setNow()).scenes.find((s) => s.sceneId === 2)?.text).toBe(coverage === undefined ? said : `${said} ${coverage}`);
  });

  test("the same category's scene at «Кокетливая»: the compose prompt byte for byte, and today's 37 500", async () => {
    const set = await seed("flirty");
    await store.update(AVATAR, SET, rewrite([2]));
    const { net, end } = await run([keeping]);
    expect(await end).toMatchObject({ status: "done" });
    expect(systemOf(net.calls[0])).toBe(writerMessages([slotOf(set, 2)], undefined, categoryLabelOf([llmOnlySnapshot()]))[0]?.content ?? "");
    expect(reserves()).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("ordinary"))]);
    expect(reserves()).toEqual([37_500]);
  });

  // 2026-10-28, S5.BA9 (plan s5a4 §8 BA9, Q-F → 1): this row pinned «the idea writer has no bold mode in this slice». BA9 gives it one, so an idea write on a «Смелая» set is now
  // asked in the bold variant at the bold call (the rows below); what it pinned of the compose prompt still holds: the idea write never sends the compose writer's bold prompt.
  test("an idea write on a «Смелая» set never sends the compose writer's bold prompt", async () => {
    await seed("bold");
    await store.update(AVATAR, SET, (s) => beginIdea(s, { jobId: "job-aaaa-0002", idea: "кофе на балконе утром", count: 1, shot: "friend", mirrorAllowed: false, scenes: [{ sceneId: 5, shot: "friend", pose: "front" }] }));
    const { net, end } = await run([ideaAnswer]);
    expect(await end).toMatchObject({ status: "done" });
    expect(systemOf(net.calls[0])).not.toBe(writerBoldMessages([])[0]?.content);
  });
});

// 5a.4 (S5.BA9, plan s5a4 §8 BA9): an own scene of a «Смелая» set is written by the idea writer's bold variant, asked, priced and reserved as the bold writer call (its prompt does not fit
// the ordinary 14K ceiling, ideaWriter.bold.test.ts). Below «Смелая» the idea write is the one it always was: the ordinary prompt byte for byte, at today's 37 500.
describe("an idea write is asked in its set's mode (S5.BA9)", () => {
  const LINGERIE = "She lies across her bed in a black lace bra and panties, propped on one elbow, smiling at the viewer.";
  const lingerieAnswer: Step = (call: FetchCall): Reply => ({
    status: 200,
    body: chatBody(JSON.stringify({ scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: LINGERIE, pose: "front" })) }), { cost: 0.004 }),
  });
  const idea = (s: StoredSceneSet) => beginIdea(s, { jobId: "job-aaaa-0002", idea: "в белье на кровати", count: 1, shot: "friend", mirrorAllowed: false, scenes: [{ sceneId: 5, shot: "friend", pose: "front" }] });
  const ownText = async (): Promise<string | null | undefined> => (await setNow()).scenes.find((s) => s.sceneId === 5)?.text;

  test("an imported avatar's: the bold variant that says lingerie at most, the bold call's 48 750 reserved, and the lingerie sentence kept with the kept coverage", async () => {
    await seed("bold");
    await store.update(AVATAR, SET, idea);
    const { net, end } = await run([lingerieAnswer]);
    expect(await end).toEqual({ status: "done", written: 1, unwritten: 0 });
    expect(systemOf(net.calls[0])).toBe(ideaSystemPrompt(false, { impliedNudity: false }));
    expect(systemOf(net.calls[0])).toContain("lingerie at most");
    expect(reserves()).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("bold"))]);
    expect(reserves()).toEqual([48_750]);
    expect(await ownText()).toBe(`${LINGERIE} ${OWN_BOLD_COVERAGE}`);
  });

  test("a Studio-created avatar's: the variant that allows the implied cover, and the sentence kept as written", async () => {
    await seed("bold");
    await store.update(AVATAR, SET, idea);
    const { net, end } = await run([lingerieAnswer], true);
    expect(await end).toMatchObject({ status: "done" });
    expect(systemOf(net.calls[0])).toBe(ideaSystemPrompt(false, { impliedNudity: true }));
    expect(reserves()).toEqual([48_750]);
    expect(await ownText()).toBe(LINGERIE);
  });

  test("a rewrite of an own scene of a «Смелая» set: the bold variant at the bold call too", async () => {
    await seed("bold");
    await store.update(AVATAR, SET, idea);
    await (await run([lingerieAnswer])).end;
    await store.update(AVATAR, SET, rewrite([5]));
    const before = reserves().length;
    const { net, end } = await run([lingerieAnswer]);
    expect(await end).toMatchObject({ status: "done" });
    expect(systemOf(net.calls[0])).toBe(ideaSystemPrompt(false, { impliedNudity: false }));
    expect(reserves().slice(before)).toEqual([48_750]);
  });

  test.each([
    ["«Кокетливая»", "flirty", 37_500],
    ["«Смелая»", "bold", 48_750],
  ] as const)("%s: the idea write's estimate is what its job reserves, attempt for attempt (%s, %d a request)", async (_name, level, attempt) => {
    const set = await seed(level);
    const plan = await planReviewWrite({ set, target: { kind: "idea", idea: "в белье на кровати", count: 1, shot: "friend" }, ledger: null, customCategories: async () => [] });
    const estimate = reviewWriteEstimate({ book: money.priceBook, asOf: "2026-10-28" }, set.models.text, plan.count, plan.attemptsLeft, plan.modelScenes, plan.mode);
    await store.update(AVATAR, SET, (s) => plan.begin(s, "job-aaaa-0002"));
    await (await run([lingerieAnswer, lingerieAnswer])).end;
    expect(reserves().length).toBeGreaterThan(0);
    for (const reserve of reserves()) expect(reserve).toBe(attempt);
    expect(estimate.worstMicros).toBe(plan.attemptsLeft * attempt);
  });

  test("at «Кокетливая»: the ordinary idea prompt byte for byte, today's 37 500, and lingerie still refused", async () => {
    await seed("flirty");
    await store.update(AVATAR, SET, idea);
    const { net, end } = await run([lingerieAnswer, lingerieAnswer]);
    expect(await end).toMatchObject({ status: "failed" });
    expect(systemOf(net.calls[0])).toBe(ideaSystemPrompt(false));
    expect(reserves()).toEqual([37_500, 37_500]);
  });
});
