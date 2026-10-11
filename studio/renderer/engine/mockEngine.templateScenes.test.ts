import { describe, expect, test } from "bun:test";
import type { CategoryPool, CategorySummary, SceneCategory, SceneSetView } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { captureOfShot, shotOf } from "../../shared/scenes/captures";
import { covers } from "../../shared/scenes/custom";
import { momentAllowed } from "../../shared/scenes/template";
import { llmPossibleSlots, writerChunksWorst } from "../../shared/scenes/writerBound";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../engine/scenes/testing/llmOnlyFixture";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";
import { MOCK_SCENE_ATTEMPT_WORST } from "./mockSceneSets";

// 5a.2 (S5.6e, plan s5a2 §5.7): the mock writes a scene set the way the engine does since S5.6c1. Every scene of a built-in category, and of a custom category the
// code template covers, is written by the shared template at once and costs nothing; only the scenes of an uncovered custom category go to the model, and the
// mock prices them with the engine's own bound (`writerChunksWorst`). `cat-llm-only-fixture` (the engine's fixture, one definition) is the category the model path
// is tested on.

const POSES = { profile: false, back: false };
const ATTEMPT = MOCK_SCENE_ATTEMPT_WORST;
const FIXTURE: CategorySummary = { ...LLM_ONLY_CATEGORY_RECORD, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" };

/** A custom category whose activities all read after «she is»: the template covers it, so it costs nothing to write. */
const COVERED_POOL: CategoryPool = {
  locations: [
    { name: "a corner cafe", times: ["morning", "midday"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "stirring a cappuccino", twoHanded: true }], mirror: false },
    { name: "a flower stall", times: ["midday"], activities: [{ text: "smelling a bouquet", twoHanded: false }], mirror: false },
  ],
  outfits: ["a beige trench coat and jeans", "a striped tee and a beret"],
  shotDeck: ["friend", "friend", "candid"],
};
const COVERED: CategorySummary = {
  ...LLM_ONLY_CATEGORY_RECORD,
  categoryId: "cat-covered-fixture",
  name: "Кофейни",
  description: "кофейни",
  label: "Cafes",
  pool: COVERED_POOL,
  createdAt: "2026-10-05T10:01:00.000Z",
  updatedAt: "2026-10-05T10:01:00.000Z",
};

const BUILT_INS: readonly SceneCategory[] = ["home", "travel", "shoot", "glam", "fit"];

function mockWith(...categories: CategorySummary[]): Mock {
  return makeMock({ categories });
}

const estimateCompose = async (m: Mock, count: number, categories: readonly string[]) =>
  (await unwrap(m.client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count, categories, poses: POSES } as never))).estimate;

const compose = (m: Mock, count: number, categories: readonly string[], acceptedWorstMicros = 10_000_000) =>
  m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories, poses: POSES, acceptedWorstMicros } as never);

async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}

async function composedAndWritten(m: Mock, count: number, categories: readonly string[]): Promise<SceneSetView> {
  await unwrap(compose(m, count, categories));
  m.scheduler.runAll();
  return setOf(m);
}

describe("scenes.estimateCompose, since the code template writes the scenes", () => {
  test("prices a compose of built-in categories at nothing, whatever the count", async () => {
    const m = mockWith();
    for (const count of [1, 20, 100]) {
      expect(await estimateCompose(m, count, BUILT_INS)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    }
  });

  test("prices a custom category the template covers at nothing", async () => {
    expect(covers(COVERED_POOL)).toBe(true);
    const m = mockWith(COVERED);
    expect(await estimateCompose(m, 20, [COVERED.categoryId])).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("prices an uncovered custom category at the shared bound: one chunk of two attempts for 20 scenes", async () => {
    const m = mockWith(FIXTURE);
    expect((await estimateCompose(m, 20, [LLM_ONLY_REF])).worstMicros).toBe(2 * ATTEMPT);
  });

  test("prices 26 scenes of an uncovered category at two chunks, never more than the plan's own chunk count", async () => {
    const m = mockWith(FIXTURE);
    expect((await estimateCompose(m, 26, [LLM_ONLY_REF])).worstMicros).toBe(2 * 2 * ATTEMPT);
  });

  test("prices «Дом» 50 plus an uncovered custom 50 at three chunks: $0.225, not the $0.30 a writer for every scene cost", async () => {
    const m = mockWith(FIXTURE);
    const estimate = await estimateCompose(m, 100, ["home", LLM_ONLY_REF]);
    expect(estimate.worstMicros).toBe(225_000);
  });

  test("never prices below the engine's bound for the same plan, over every mix of built-in and uncovered counts", async () => {
    const m = mockWith(FIXTURE);
    for (const count of [1, 5, 24, 25, 26, 49, 50, 51, 99, 100]) {
      for (const categories of [["home"], [LLM_ONLY_REF], ["home", LLM_ONLY_REF], ["home", "travel", LLM_ONLY_REF]]) {
        const refs = categories.map((c) => c as never);
        const base = Math.floor(count / refs.length);
        const split = refs.map((ref, i) => ({ ref, count: base + (i < count - base * refs.length ? 1 : 0) }));
        const bound = writerChunksWorst(split, (ref) => ref !== LLM_ONLY_REF) * 2 * ATTEMPT;
        const worst = (await estimateCompose(m, count, categories)).worstMicros;
        expect(worst).toBeGreaterThanOrEqual(bound);
        expect(llmPossibleSlots(split, (ref) => ref !== LLM_ONLY_REF) === 0).toBe(worst === 0);
      }
    }
  });
});

describe("scenes.compose, since the code template writes the scenes", () => {
  test("writes every scene of the built-in categories and spends nothing", async () => {
    const m = mockWith();
    const view = await composedAndWritten(m, 25, BUILT_INS);
    expect(view.status).toBe("ready");
    expect(view.scenes.every((s) => s.text !== null)).toBe(true);
    expect(view.spentMicros).toBe(0);
  });

  test("lets a compose of a built-in category through at an accepted worst case of nothing", async () => {
    const m = mockWith();
    expect((await compose(m, 10, ["home"], 0)).ok).toBe(true);
  });

  test("writes no scene with the model: no chunk has an answered attempt", async () => {
    const m = mockWith();
    const view = await composedAndWritten(m, 30, ["home", "travel"]);
    expect(view.chunks.every((c) => c.attemptsLeft === 2 && c.gaveUpBy === null)).toBe(true);
  });

  test("plans each built-in scene as a pair of its category's bank: the place by name, the activity a moment of that place", async () => {
    const m = mockWith();
    const view = await composedAndWritten(m, 50, BUILT_INS);
    const bankOf = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness" } as const;
    for (const scene of view.scenes) {
      if (scene.place === null || scene.category === "own" || !(scene.category in bankOf)) throw new Error(`scene ${scene.sceneId} is not a built-in planned scene`);
      const place = BANKS[bankOf[scene.category as SceneCategory]].places.find((p) => p.name === scene.place?.location);
      expect(place).toBeDefined();
      expect(place?.moments.map((mo) => mo.text)).toContain(scene.place.activity);
    }
  });

  test("draws a capture from the category's deck: a mirror shot lands on a mirror place of the bank", async () => {
    const m = mockWith();
    const view = await composedAndWritten(m, 50, ["home"]);
    const mirrored = view.scenes.filter((s) => s.shot === "mirror");
    expect(mirrored.length).toBeGreaterThan(0);
    for (const scene of mirrored) {
      const place = BANKS.home.places.find((p) => p.name === scene.place?.location);
      expect(place?.mirror).toBe(true);
    }
  });

  test("the fixture's scenes go to the writer: priced, asked, and paid at the typical share", async () => {
    const m = mockWith(FIXTURE);
    const view = await composedAndWritten(m, 20, [LLM_ONLY_REF]);
    expect(view.scenes.every((s) => s.text !== null)).toBe(true);
    expect(view.spentMicros).toBe(9_150);
  });

  test("a mixed set writes the built-in scenes free and asks the model for the fixture's alone", async () => {
    const m = mockWith(FIXTURE);
    const view = await composedAndWritten(m, 20, ["home", LLM_ONLY_REF]);
    expect(view.status).toBe("ready");
    // 10 scenes for the model at the writer's typical 457.5 µ$ each (the built-in 10 cost nothing).
    expect(view.spentMicros).toBe(4_575);
  });
});

describe("every scene the mock plans from a bank is one the template writes", () => {
  test("writes every scene of every built-in category for every count and with every angle the run allows, and spends nothing", async () => {
    for (const poses of [POSES, { profile: true, back: true }]) {
      for (const count of [1, 7, 20, 41, 100]) {
        const m = mockWith();
        await unwrap(m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: BUILT_INS, poses, acceptedWorstMicros: 0 } as never));
        m.scheduler.runAll();
        const view = await setOf(m);
        expect(view.scenes.filter((s) => s.text === null).map((s) => s.sceneId)).toEqual([]);
        expect(view.spentMicros).toBe(0);
      }
    }
  });
});

describe("«Другая сцена» on a scene the template writes", () => {
  async function rewrite(m: Mock, set: SceneSetView, redraw: boolean, sceneId = 1) {
    const target = { kind: "rewrite", sceneIds: [sceneId], redraw };
    const estimate = (await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target } as never))).estimate;
    const answer = await m.client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros: estimate.worstMicros } as never);
    m.scheduler.runAll();
    return { estimate, answer, after: await setOf(m) };
  }

  test("is priced at nothing, with a redraw or without one", async () => {
    const m = mockWith();
    const set = await composedAndWritten(m, 10, BUILT_INS);
    for (const redraw of [true, false]) {
      const target = { kind: "rewrite", sceneIds: [2], redraw };
      const estimate = (await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target } as never))).estimate;
      expect(estimate).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    }
  });

  test("draws a new place and writes it at once, spending nothing, even though the write did not ask for a redraw", async () => {
    const m = mockWith();
    const set = await composedAndWritten(m, 10, BUILT_INS);
    const before = set.scenes[0];
    const { answer, after } = await rewrite(m, set, false);
    expect(answer.ok).toBe(true);
    const now = after.scenes[0];
    expect(now?.place?.location).not.toBe(before?.place?.location);
    expect(now?.text).not.toBe(before?.text);
    expect(after.spentMicros).toBe(0);
  });

  test("is still the model's for a fixture scene: priced at its attempts and paid at the typical share", async () => {
    const m = mockWith(FIXTURE);
    const set = await composedAndWritten(m, 5, [LLM_ONLY_REF]);
    const spentBefore = set.spentMicros ?? 0;
    const { estimate, after } = await rewrite(m, set, false);
    expect(estimate.worstMicros).toBe(2 * ATTEMPT);
    expect((after.spentMicros ?? 0) - spentBefore).toBe(458);
  });
});

describe("a set that was stopped before the template, and «Дописать» on it", () => {
  test("an old-pool scene (a place no bank has) still waits for the writer, and «Дописать» is priced for it", async () => {
    const m = makeMock({
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: "set-old-0001",
          count: 2,
          scenes: [
            { category: "home", shot: "friend", pose: "front", place: { location: "a sunny kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt and shorts" } },
            { category: "home", shot: "friend", pose: "three-quarter", place: { location: "a cosy living room", timeOfDay: "evening", activity: "reading on the sofa", outfit: "an oversized knit sweater" } },
          ],
          written: 0,
          stopped: "closed",
        },
      ],
    });
    const estimate = (await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: "set-old-0001", target: { kind: "unwritten" } }))).estimate;
    expect(estimate.worstMicros).toBe(2 * ATTEMPT);
  });

  test("a scene of a bank pair that was never written is written free by «Дописать», at a price of nothing", async () => {
    const found = BANKS.home.places.flatMap((p) => p.moments.flatMap((mo) => mo.captures.filter((c) => captureOfShot(shotOf(c)) === c && momentAllowed(mo, c, "front")).map((c) => ({ place: p, moment: mo, capture: c }))))[0];
    if (found === undefined) throw new Error("the home bank has no moment a front-facing capture allows");
    const { place, moment, capture } = found;
    const outfit = moment.outfits?.[0] ?? BANKS.home.outfits.find((o) => o.pinOnly !== true)?.text ?? "";
    const m = makeMock({
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: "set-bank-0001",
          count: 1,
          scenes: [{ category: "home", shot: shotOf(capture), pose: "front", place: { location: place.name, timeOfDay: place.times[0] ?? "morning", activity: moment.text, outfit } }],
          written: 0,
          stopped: "closed",
        },
      ],
    });
    const estimate = (await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: "set-bank-0001", target: { kind: "unwritten" } }))).estimate;
    expect(estimate).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });
});
