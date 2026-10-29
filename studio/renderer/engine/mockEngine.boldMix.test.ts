import { describe, expect, test } from "bun:test";
import type { AvatarSummary, SceneSetView } from "../../shared/engine";
import { levelCountsOf } from "../../shared/scenes/level";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// 5a.3 (S5.9c, plan s5a3 §12): the mock mirrors the engine's «Смелая»: the two «Смелая» categories draw the 20 / 40 / 40 mix, a scene echoes its level and its Seedream route, a
// redraw keeps both, a «Смелая» category below «Смелая» is refused for free, and the owner's edits of a «Смелая» scene are held to the youth words only. Facts only: the mock
// keeps its own deterministic dealing, but every phrase is the bank's and every count is the shared formula's.

const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-0001",
  createdAt: "2026-09-24T09:00:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};
const WORST = 10_000_000;

function makeMock() {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA] });
  return { client: mockEngineClient(engine), scheduler };
}
type Mock = ReturnType<typeof makeMock>;

async function setOf(m: Mock): Promise<SceneSetView> {
  const got = await m.client.request("scenes.get", { avatarId: MIA.avatarId });
  if (!got.ok || got.result.sceneSet === null) throw new Error("no set");
  return got.result.sceneSet;
}

async function composed(over: Record<string, unknown>, count = 30): Promise<{ m: Mock; view: SceneSetView }> {
  const m = makeMock();
  const made = await m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, acceptedWorstMicros: WORST, ...over } as never);
  if (!made.ok) throw new Error(`compose refused: ${made.error.code} ${made.error.sceneReason ?? ""}`);
  m.scheduler.runAll();
  return { m, view: await setOf(m) };
}


describe("a bold set of the «Смелая» categories on the mock", () => {
  test.each([["nightwear"], ["beach"]] as const)("%s: the scenes hold the 20 / 40 / 40 mix, exactly, at every size", async (category) => {
    for (const count of [1, 2, 3, 5, 6, 10, 12, 25]) {
      const { view } = await composed({ categories: [category], level: "bold" }, count);
      const got = { bold: view.scenes.filter((s) => s.level === "bold").length, flirty: view.scenes.filter((s) => s.level === "flirty").length, ordinary: view.scenes.filter((s) => s.level === undefined).length };
      expect({ count, got }).toEqual({ count, got: levelCountsOf(count) });
    }
  });

  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4 #1): «Смелая» is every category's, so «Дом» in a bold mix draws the bold mix on the route, not the «Кокетливая» one (the mock's stop-gap; S5.BA7 spreads the
  // tiers over the whole request). The «Кокетливая» mix of «Дом» is told on a «Кокетливая» set, kept.

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear outfit is on Seedream now, so its ordinary scenes are too; the scenes off the route were a «Смелая» «Дом» set's, as on the engine.
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, BA2 part 2 review L1): «Смелая» plans «Дом» on the route once the mock mirrors the engine, so the off-the-route control is a «Кокетливая» «Дом» set's.

});

describe("a «Смелая» category below «Смелая» on the mock", () => {
  test.each([[undefined], ["ordinary"], ["flirty"]] as const)("is refused for free by the estimate and the compose of a set at level %s", async (level) => {
    const m = makeMock();
    const asked = { avatarId: MIA.avatarId, count: 10, categories: ["home", "nightwear"], ...(level === undefined ? {} : { level }) };
    for (const reply of [await m.client.request("scenes.estimateCompose", asked as never), await m.client.request("scenes.compose", { ...asked, acceptedWorstMicros: WORST } as never)]) {
      expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "bold-level-needed" } });
    }
    const got = await m.client.request("scenes.get", { avatarId: MIA.avatarId });
    expect(got.ok ? got.result.sceneSet : "not ok").toBeNull();
  });

});

