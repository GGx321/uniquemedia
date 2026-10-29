import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, LaunchDraftInput, LaunchView, SceneSetView, SceneView } from "../../shared/engine";
import { apportionLegs, legsCountOf } from "../../shared/scenes/level";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { runUntil, runWorld, startRun, unwrap } from "./mockLaunchRun.testkit";
import { ManualScheduler } from "./scheduler";

// 5a.2c (S5.8a, I5.29): the mock mirrors the engine's «Ножки» on a composed set, a refused request and a launch: facts only. The legs scenes are
// min(round-half-up(share × B), ⌊0.3 × count⌋), shared over the built-in categories by largest remainder; a legs scene is a legs moment of the bank, written by the
// shared template; a redraw keeps the framing; a request for legs with no built-in category is refused for free; a launch carries the draft's «Ножки» into its set.

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

const legsOf = (view: SceneSetView): SceneView[] => view.scenes.filter((s) => s.framing === "legs");
const ofCategory = (view: SceneSetView, category: string): SceneView[] => view.scenes.filter((s) => s.category === category);

describe("«Ножки» on a composed set", () => {

  test("the legs scenes are shared over the categories by largest remainder: the floor or the ceiling of each quota", async () => {
    const { view } = await composed({ legsShare: 30 }, 40);
    const sizes = CATEGORIES.map((c) => ofCategory(view, c).length);
    const total = legsCountOf(30, 40, 40);
    CATEGORIES.forEach((c, i) => {
      const quota = (total * (sizes[i] ?? 0)) / 40;
      const held = legsOf(view).filter((s) => s.category === c).length;
      expect(held).toBeGreaterThanOrEqual(Math.floor(quota));
      expect(held).toBeLessThanOrEqual(Math.ceil(quota));
    });
    expect(apportionLegs(total, sizes).reduce((a, b) => a + b, 0)).toBe(total);
  });

});

describe("a request for legs with no built-in category", () => {
  const custom = "cat-paris-cafes";

  test("is refused by runs.estimate and runs.start the same way", async () => {
    const m = makeMock();
    const asked = { avatarId: MIA.avatarId, count: 5, categories: [custom], legsShare: 30 };
    expect(await m.client.request("runs.estimate", asked as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "legs-built-in-only" } });
    expect(await m.client.request("runs.start", { ...asked, acceptedWorstMicros: WORST } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "legs-built-in-only" } });
  });

});

describe("a launch carries «Ножки» into its set", () => {
  const awaiting = (v: LaunchView): boolean => v.avatars.some((a) => a.phase === "awaiting-review");

  async function launchSet(over: Partial<LaunchDraftInput>): Promise<SceneSetView> {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true, ...over });
    await runUntil(mock, started.launchId, "the review", awaiting);
    const got = await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }));
    if (got.sceneSet === null) throw new Error("the launch's set is not there");
    return got.sceneSet;
  }

  test("a launch asked for legs reviews a set with the legs scenes the formula gives", async () => {
    const set = await launchSet({ legsShare: 30 });
    expect(set.scenes).toHaveLength(10);
    expect(legsOf(set)).toHaveLength(legsCountOf(30, 10, 10));
  });

});

