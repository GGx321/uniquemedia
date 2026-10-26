import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CategorySnapshot } from "../../shared/engine";
import { SceneSetStore, type StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { useTempDir } from "../library/testing/helpers";
import { writerAttemptWorstMicros, writerCallOf } from "../money/estimate";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { NetworkPool } from "../runs/pools";
import { POOLS, type PlanSlot } from "../scenes";
import { LLM_ONLY_POOL, LLM_ONLY_REF, llmOnlySnapshot } from "../scenes/testing/llmOnlyFixture";
import { PLACE_PREPOSITIONS, writerBoldMessages, writerMessages } from "../scenes/writer";
import { categoryLabelOf } from "../scenes/categories";
import { planSceneSet } from "./compose";
import { withChunkGivenUp, withChunkWritten } from "./mutations";
import { runSceneWrite } from "./writeJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA4, plan s5a4 §5.3.4 «The mode», r2.1 L3; the BA5a review's R2-L2): the set's writer job asks each pending chunk in its mode. A chunk whose scenes for
// the model hold a «Смелая» frame is asked with the bold prompt and reserves the bold call's worst case, `writerAttemptWorstMicros(book, writerCallOf("bold"))`;
// any other chunk is asked as before and reserves the ordinary call's. The sentences it saves carry the coverage by the avatar's origin.

const root = useTempDir("studio-scene-write-mode-");
const AVATAR = "avatar-aaaa-0001";
const SET = "set-aaaa-0001";
// The category only the model writes (its activities never read after «she is»), so at «Кокетливая» too every scene is a request. It has no water place, so every
// «Смелая» scene draws from «rooms».
const CUSTOM = LLM_ONLY_REF;
const SNAPSHOT: CategorySnapshot = llmOnlySnapshot();
const LACE_KEPT = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";

let money: Money;
let store: SceneSetStore;
beforeEach(async () => {
  money = await setupMoney();
  store = new SceneSetStore(root());
});
afterEach(async () => {
  await money.cleanup();
});

async function seedComposed(level: "flirty" | "bold", count = 3): Promise<StoredSceneSet> {
  const planned = planSceneSet({
    sceneSetId: SET,
    avatarId: AVATAR,
    runId: "run-aaaa-0001",
    jobId: "job-aaaa-0001",
    count,
    categories: [CUSTOM],
    level,
    pools: { ...POOLS, [CUSTOM]: LLM_ONLY_POOL },
    snapshots: [SNAPSHOT],
    recentPairs: [],
    textModel: "x-ai/grok-4.3",
  });
  return store.create(planned);
}

/** The slots a request asked about, as its own prompt names them. */
function askedIn(call: FetchCall): { slotIndex: number; location: string; activity: string; outfit: string; world?: string }[] {
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

/** A sentence each slot asked about passes its reader with: «she» and its activity word for word, its outfit as given, its place named, no gaze; `extra` after the outfit. */
const keeping =
  (extra = ""): Step =>
  (call: FetchCall): Reply => ({
    status: 200,
    body: chatBody(
      JSON.stringify({
        scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: `${placed(s.location)}${s.world === undefined ? "" : ` while staying near ${s.world.replace(/^an? /, "the ")}`}, she ${s.activity} in ${s.outfit}${extra}, a cup of tea beside her.` })),
      }),
      { cost: 0.006 },
    ),
  });

function run(steps: Step[], deps: { impliedNudity?: boolean } = {}) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const pool = new NetworkPool({ max: 6 });
  const end = runSceneWrite(
    {
      chat: client.chat,
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      load: async () => {
        const set = await store.get(AVATAR, SET);
        if (set === null) throw new Error("the set is gone");
        return set;
      },
      saveChunk: async (_chunk, sentences) => {
        await store.update(AVATAR, SET, (s) => withChunkWritten(s, sentences));
      },
      giveUp: async (chunk, by) => {
        await store.update(AVATAR, SET, (s) => withChunkGivenUp(s, chunk, by));
      },
      progress: () => undefined,
      ...deps,
    },
    { jobId: "job-aaaa-0001", scope: { avatarJobId: "job-aaaa-0001" }, signal: new AbortController().signal },
  );
  return { net, end };
}

const reserves = (): number[] => money.lines().flatMap((l) => (l.type === "reserve" && typeof l.worstMicros === "number" ? [l.worstMicros] : []));
const systemOf = (call: FetchCall | undefined): string => {
  const messages = call?.json().messages;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  return typeof first === "object" && first !== null && "content" in first && typeof first.content === "string" ? first.content : "";
};
const planned = (set: StoredSceneSet): PlanSlot[] => set.scenes.flatMap((s) => (s.origin === "planned" ? [s.slot] : []));
async function setNow(): Promise<StoredSceneSet> {
  const set = await store.get(AVATAR, SET);
  if (set === null) throw new Error("the set is gone");
  return set;
}

describe("a compose asks each chunk in its mode", () => {
  test("a custom category at «Смелая»: the bold prompt, and every attempt reserves the bold call's worst case (48 750 µ$)", async () => {
    const set = await seedComposed("bold");
    expect(planned(set).every((slot) => slot.route === "seedream" && slot.world !== undefined)).toBe(true);
    const { net, end } = run([keeping()]);
    expect(await end).toEqual({ status: "done", written: 3, unwritten: 0 });
    expect(systemOf(net.calls[0])).toBe(writerBoldMessages(planned(set))[0]?.content ?? "");
    expect(reserves()).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("bold"))]);
    expect(reserves()).toEqual([48_750]);
  });

  test("its second attempt reserves the same: a refused answer is asked again in bold mode", async () => {
    await seedComposed("bold");
    const { net, end } = run([{ status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) }, keeping()]);
    expect(await end).toMatchObject({ status: "done", written: 3 });
    expect(net.calls).toHaveLength(2);
    expect(reserves()).toEqual([48_750, 48_750]);
  });

  test("the same category at «Кокетливая»: the ordinary prompt and today's 37 500", async () => {
    const set = await seedComposed("flirty");
    const { net, end } = run([keeping()]);
    expect(await end).toMatchObject({ status: "done" });
    expect(systemOf(net.calls[0])).toBe(writerMessages(planned(set), undefined, categoryLabelOf([SNAPSHOT]))[0]?.content ?? "");
    expect(reserves()).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("ordinary"))]);
    expect(reserves()).toEqual([37_500]);
  });

  test("a saved bold sentence carries its outfit's coverage once: the kept one for an avatar of unknown origin", async () => {
    await seedComposed("bold");
    await run([keeping()]).end;
    const set = await setNow();
    for (const scene of set.scenes) {
      if (scene.origin !== "planned" || scene.text === null) throw new Error("every scene is written");
      if (/\blace bra and panties\b/.test(scene.slot.outfit)) expect(scene.text.split(LACE_KEPT)).toHaveLength(2);
    }
  });

  test("a Studio-created avatar's bold sentence carries the open one (none for lace)", async () => {
    await seedComposed("bold", 12);
    await run([keeping()], { impliedNudity: true }).end;
    const set = await setNow();
    expect(set.scenes.some((s) => s.origin === "planned" && /\blace bra and panties\b/.test(s.slot.outfit))).toBe(true);
    expect(set.scenes.every((s) => s.text !== null && !s.text.includes(LACE_KEPT))).toBe(true);
  });
});

describe("an old set's rewrite (r2.1 L3): a pre-5a.4 «Смелая» set of «Ночнушки и бельё»", () => {
  // Its cotton scenes were drawn on the owner's model at the ordinary tier (no route); Q-A2 removed the cotton, so the template no longer writes them. Its satin and
  // lace scenes were drawn on the route and still render. Hand-built, so the oracle never depends on the planner.
  const cotton = (sceneId: number, activity: string, outfit: string): PlanSlot => ({
    slotIndex: sceneId,
    category: "nightwear",
    location: "her bed",
    timeOfDay: "night",
    activity,
    outfit,
    shot: "selfie",
    pose: "front",
    attemptIdBase: `slot-${sceneId}`,
    repeatedPair: false,
    capture: "above",
    level: "ordinary",
  });
  const onTheRoute = (sceneId: number, activity: string, outfit: string): PlanSlot => ({ ...cotton(sceneId, activity, outfit), level: "flirty", route: "seedream" });
  const SLOTS: PlanSlot[] = [
    cotton(1, "lies back against the pillows", "an oversized sleep tee"),
    onTheRoute(2, "lies back, one knee up", "a black lace bra and panties"),
    cotton(3, "rests her cheek on the pillow", "cotton pajama shorts and a tee"),
    onTheRoute(4, "lies back against the pillows", "a satin slip nightdress"),
  ];

  async function seedOld(): Promise<StoredSceneSet> {
    const base = sampleSet({ sceneSetId: SET, categories: ["nightwear"], count: 4 });
    const scenes = SLOTS.map((slot) => ({ sceneId: slot.slotIndex, origin: "planned" as const, slot, text: null, edited: false, removed: false }));
    return store.create({ ...base, request: { ...base.request, level: "bold" }, scenes, chunks: [{ ...(base.chunks[0] as (typeof base.chunks)[number]), sceneIds: [1, 2, 3, 4] }] });
  }

  test("the cotton scenes go to the writer in one bold-mode chunk, priced and reserved at WRITER_BOLD_CALL; the routed ones are the template's", async () => {
    await seedOld();
    const { net, end } = run([keeping(" over her panties")]);
    expect(await end).toEqual({ status: "done", written: 4, unwritten: 0 });
    expect(net.calls).toHaveLength(1);
    expect(askedIn(net.calls[0] as FetchCall).map((s) => s.slotIndex)).toEqual([1, 3]);
    expect(systemOf(net.calls[0])).toBe(writerBoldMessages([SLOTS[0] as PlanSlot])[0]?.content ?? "");
    expect(reserves()).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("bold"))]);
  });

  test("each cotton sentence is held to its own content level (bold, by its category): «panties» passes; no place is asked of a slot without a world; nothing is refused as a mixed chunk", async () => {
    await seedOld();
    // No word of the place («bed», «room»): a slot without a world is not held to one.
    const placeless: Step = (call) => ({
      status: 200,
      body: chatBody(JSON.stringify({ scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: `She ${s.activity} in ${s.outfit} over her panties, a cup of tea beside her.` })) }), { cost: 0.006 }),
    });
    const { net, end } = run([placeless]);
    expect(await end).toEqual({ status: "done", written: 4, unwritten: 0 });
    expect(net.calls).toHaveLength(1);
    const set = await setNow();
    expect(set.scenes.find((s) => s.sceneId === 1)?.text).toBe("She lies back against the pillows in an oversized sleep tee over her panties, a cup of tea beside her.");
    expect(set.scenes.find((s) => s.sceneId === 3)?.text).toBe("She rests her cheek on the pillow in cotton pajama shorts and a tee over her panties, a cup of tea beside her.");
  });
});
