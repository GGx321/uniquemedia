import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView, SceneView } from "../../shared/engine";
import { flirtyCountOf } from "../../shared/scenes/level";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// 5a.2b (S5.7b, I5.26, I5.28): the mock mirrors the engine's «Подача» mix and the angle from the scene on a composed set. Exactly round(0.6 × n) of a built-in
// category's scenes are flirty under «Кокетливая», none under «Обычная»; the request's `poses` change nothing; a category holds at most ⌊n/5⌋ scenes facing away,
// and a hand-held capture is never one of them; a redraw keeps the level and never turns a scene to face away.

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
const CATEGORIES = ["home", "travel", "shoot", "glam", "fit"] as const;
const HAND = new Set(["mirror-hidden", "mirror", "above", "prone", "over-shoulder", "selfie"]);
const isAway = (scene: SceneView): boolean => scene.pose === "profile" || scene.pose === "back";

function makeMock() {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA] });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, client };
}
type Mock = ReturnType<typeof makeMock>;

async function setOf(m: Mock): Promise<SceneSetView> {
  const got = await m.client.request("scenes.get", { avatarId: MIA.avatarId });
  if (!got.ok || got.result.sceneSet === null) throw new Error("no set");
  return got.result.sceneSet;
}

async function composed(over: Record<string, unknown>, count: number, categories: readonly string[] = CATEGORIES): Promise<{ m: Mock; view: SceneSetView }> {
  const m = makeMock();
  const made = await m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories, acceptedWorstMicros: WORST, ...over } as never);
  if (!made.ok) throw new Error(`compose refused: ${made.error.code}`);
  m.scheduler.runAll();
  return { m, view: await setOf(m) };
}

const ofCategory = (view: SceneSetView, category: string): SceneView[] => view.scenes.filter((s) => s.category === category);

describe("«Кокетливая» on a composed set", () => {
  test.each([5, 10, 25, 50, 100])("%i scenes over five categories hold round(0.6 × n) flirty scenes in each category", async (count) => {
    const { view } = await composed({ level: "flirty" }, count);
    for (const category of CATEGORIES) {
      const own = ofCategory(view, category);
      expect(own.filter((s) => s.level === "flirty")).toHaveLength(flirtyCountOf(own.length, "flirty"));
    }
  });

  test("an ordinary set, asked or not, holds no flirty scene", async () => {
    for (const over of [{}, { level: "ordinary" }]) expect((await composed(over, 30)).view.scenes.some((s) => s.level !== undefined)).toBe(false);
  });

  test("a flirty set differs from an ordinary one in its moments only: the same captures, in the same places of the deck", async () => {
    const ordinary = (await composed({}, 30)).view.scenes.map((s) => s.capture);
    const flirty = (await composed({ level: "flirty" }, 30)).view.scenes.map((s) => s.capture);
    expect(flirty).toEqual(ordinary);
  });
});

describe("the angle comes from the scene on a composed set", () => {
  test("the request's poses change nothing: toggles on and off compose the very same scenes", async () => {
    const off = await composed({ poses: { profile: false, back: false } }, 40);
    const on = await composed({ poses: { profile: true, back: true } }, 40);
    expect(on.view.scenes).toEqual(off.view.scenes);
  });

  test.each([10, 20, 30, 50])("a category of a %i-scene set holds at most a fifth of its scenes facing away, and some do", async (count) => {
    const { view } = await composed({}, count, ["home", "travel"]);
    let away = 0;
    for (const category of ["home", "travel"]) {
      const own = ofCategory(view, category);
      const n = own.filter(isAway).length;
      away += n;
      expect(n).toBeLessThanOrEqual(Math.floor(own.length / 5));
    }
    expect(away).toBeGreaterThan(0);
  });

  test("a hand-held capture is never a scene facing away", async () => {
    const { view } = await composed({}, 100);
    for (const scene of view.scenes) if (scene.capture !== undefined && HAND.has(scene.capture)) expect(isAway(scene)).toBe(false);
  });

  test("a plan of fewer than 5 scenes in a category holds none facing away", async () => {
    const { view } = await composed({}, 4, ["travel"]);
    expect(view.scenes.some(isAway)).toBe(false);
  });
});

describe("a redraw on the mock", () => {
  /** Redraws the scenes five at a time (the most one write takes), each batch against the set's current revision. */
  async function redrawAll(m: Mock, ids: readonly number[]): Promise<SceneSetView> {
    for (let i = 0; i < ids.length; i += 5) {
      const view = await setOf(m);
      const made = await m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target: { kind: "rewrite", sceneIds: ids.slice(i, i + 5), redraw: true }, acceptedWorstMicros: 75_000 } as never);
      expect(made).toMatchObject({ ok: true });
      m.scheduler.runAll();
    }
    return setOf(m);
  }

  test("keeps the level of a flirty scene and of an ordinary one", async () => {
    const { m, view } = await composed({ level: "flirty" }, 20, ["home"]);
    const flirty = view.scenes.filter((s) => s.level === "flirty").map((s) => s.sceneId);
    const ordinary = view.scenes.filter((s) => s.level !== "flirty").map((s) => s.sceneId);
    expect(flirty.length).toBeGreaterThan(0);
    expect(ordinary.length).toBeGreaterThan(0);
    const after = await redrawAll(m, [...flirty, ...ordinary]);
    for (const id of flirty) expect(after.scenes.find((s) => s.sceneId === id)?.level).toBe("flirty");
    for (const id of ordinary) expect(after.scenes.find((s) => s.sceneId === id)?.level).toBeUndefined();
  });

  test("never turns a scene that faces the camera away from it", async () => {
    const { m, view } = await composed({}, 30, ["travel"]);
    const facing = view.scenes.filter((s) => !isAway(s)).map((s) => s.sceneId);
    const after = await redrawAll(m, facing);
    for (const id of facing) expect(isAway(after.scenes.find((s) => s.sceneId === id) as SceneView)).toBe(false);
  });
});
