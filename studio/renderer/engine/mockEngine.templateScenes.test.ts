import { describe, expect, test } from "bun:test";
import type { CategorySummary, SceneCategory, SceneSetView } from "../../shared/engine";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";

// 5a.2 (S5.6e, plan s5a2 §5.7): the mock writes a scene set the way the engine does since S5.6c1. Every scene of a built-in category, and of a custom category the
// code template covers, is written by the shared template at once and costs nothing; only the scenes of an uncovered custom category go to the model, and the
// mock prices them with the engine's own bound (`writerChunksWorst`). `cat-llm-only-fixture` (the engine's fixture, one definition) is the category the model path
// is tested on.

const POSES = { profile: false, back: false };


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

});

describe("scenes.compose, since the code template writes the scenes", () => {
  test("writes every scene of the built-in categories and spends nothing", async () => {
    const m = mockWith();
    const view = await composedAndWritten(m, 25, BUILT_INS);
    expect(view.status).toBe("ready");
    expect(view.scenes.every((s) => s.text !== null)).toBe(true);
    expect(view.spentMicros).toBe(0);
  });

});

