import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, LaunchDraftInput, LaunchView, SceneSetView, SceneView } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { LEGS_CAPTURES } from "../../shared/scenes/captures";
import { apportionLegs, flirtyCountOf, legsCountOf } from "../../shared/scenes/level";
import { DEFAULT_TRAITS } from "../lib/traits";
import { BANK_OF } from "./mockBankScenes";
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
  for (const share of [15, 30] as const) {
    test.each([4, 5, 10, 20, 40, 100])(`${share} %: %i scenes over five categories hold exactly the formula's legs scenes`, async (count) => {
      const { view } = await composed({ legsShare: share }, count);
      expect(legsOf(view)).toHaveLength(legsCountOf(share, count, count));
    });
  }

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

  test("a legs scene is a legs moment of its category's bank, with a capture the moment lists, and its sentence is written by the template", async () => {
    const { view } = await composed({ legsShare: 30 }, 40);
    expect(legsOf(view).length).toBeGreaterThan(5);
    for (const scene of legsOf(view)) {
      const bank = BANKS[BANK_OF[scene.category as keyof typeof BANK_OF]];
      const moment = bank.places.find((p) => p.name === scene.place?.location)?.moments.find((m) => m.text === scene.place?.activity);
      expect(moment?.legs, `${scene.place?.location} | ${scene.place?.activity}`).toEqual({ framing: "legs" });
      expect(scene.capture).toBeDefined();
      expect(moment?.captures).toContain(scene.capture);
      expect(scene.text).toContain(scene.place?.activity ?? "never");
    }
  });

  test("an ordinary scene draws no legs moment and no legs capture", async () => {
    const { view } = await composed({ legsShare: 30 }, 40);
    for (const scene of view.scenes.filter((s) => s.framing !== "legs")) {
      expect(LEGS_CAPTURES.includes(scene.capture ?? "friend")).toBe(false);
      const bank = BANKS[BANK_OF[scene.category as keyof typeof BANK_OF]];
      expect(bank.places.find((p) => p.name === scene.place?.location)?.moments.find((m) => m.text === scene.place?.activity)?.legs).toBeUndefined();
    }
  });

  test("at home she shoots herself and the taxi is a selfie: no legs scene of «Дом» or of the taxi is a friend's photo", async () => {
    const { view } = await composed({ legsShare: 30 }, 100);
    const home = legsOf(view).filter((s) => s.category === "home");
    expect(home.length).toBeGreaterThan(3);
    for (const scene of home) expect(scene.capture).not.toBe("low-feet");
    for (const scene of legsOf(view).filter((s) => s.place?.location === "the back seat of a taxi")) expect(scene.capture).toBe("pov-legs");
  });

  test("no share, a share of 0 and a share of 0 beside «Подача» are the set without legs", async () => {
    const plain = (await composed({}, 30)).view.scenes;
    expect(plain.some((s) => s.framing !== undefined)).toBe(false);
    expect((await composed({ legsShare: 0 }, 30)).view.scenes).toEqual(plain);
  });

  test("«Подача» keeps its exact count beside legs", async () => {
    const { view } = await composed({ legsShare: 30, level: "flirty" }, 40);
    for (const category of CATEGORIES) {
      const own = ofCategory(view, category);
      expect(own.filter((s) => s.level === "flirty")).toHaveLength(flirtyCountOf(own.length, "flirty"));
    }
  });
});

describe("a request for legs with no built-in category", () => {
  const custom = "cat-paris-cafes";

  test("is refused for free with its reason by the estimate and the compose, before the category is even looked up", async () => {
    const m = makeMock();
    const asked = { avatarId: MIA.avatarId, count: 10, categories: [custom], legsShare: 15 };
    const estimate = await m.client.request("scenes.estimateCompose", asked as never);
    const compose = await m.client.request("scenes.compose", { ...asked, acceptedWorstMicros: WORST } as never);
    for (const reply of [estimate, compose]) expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "legs-built-in-only" } });
    const got = await m.client.request("scenes.get", { avatarId: MIA.avatarId });
    expect(got.ok ? got.result.sceneSet : "not ok").toBeNull();
  });

  test("is refused by runs.estimate and runs.start the same way", async () => {
    const m = makeMock();
    const asked = { avatarId: MIA.avatarId, count: 5, categories: [custom], legsShare: 30 };
    expect(await m.client.request("runs.estimate", asked as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "legs-built-in-only" } });
    expect(await m.client.request("runs.start", { ...asked, acceptedWorstMicros: WORST } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "legs-built-in-only" } });
  });

  test("a share of 0 asks for nothing, and a built-in category beside the custom one is enough", async () => {
    const m = makeMock();
    expect(await m.client.request("runs.estimate", { avatarId: MIA.avatarId, count: 5, categories: ["home", custom], legsShare: 30 } as never)).not.toMatchObject({ error: { sceneReason: "legs-built-in-only" } });
    expect(await m.client.request("runs.estimate", { avatarId: MIA.avatarId, count: 5, categories: [custom], legsShare: 0 } as never)).not.toMatchObject({ error: { sceneReason: "legs-built-in-only" } });
  });

  test("the autopilot's estimate and start are refused with the launch reason", async () => {
    const m = makeMock();
    const draft = { avatarIds: [MIA.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: [custom], legsShare: 15, library: false, generate: true, sceneReview: false, stickers: false };
    expect(await m.client.request("autopilot.estimate", { draft } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", launchReason: "legs-built-in-only" } });
    expect(await m.client.request("autopilot.start", { draft: { ...draft, planSeed: 5 }, acceptedWorstMicros: WORST } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", launchReason: "legs-built-in-only" } });
  });
});

describe("a redraw of a legs scene on the mock", () => {
  test("keeps the framing, gives a legs moment with its capture, and sends the template's text", async () => {
    const { m, view } = await composed({ legsShare: 30 }, 40);
    const ids = legsOf(view).map((s) => s.sceneId).slice(0, 5);
    expect(ids.length).toBe(5);
    const made = await m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target: { kind: "rewrite", sceneIds: ids, redraw: true }, acceptedWorstMicros: 75_000 } as never);
    expect(made).toMatchObject({ ok: true });
    m.scheduler.runAll();
    const after = await setOf(m);
    for (const id of ids) {
      const scene = after.scenes.find((s) => s.sceneId === id);
      const bank = BANKS[BANK_OF[scene?.category as keyof typeof BANK_OF]];
      expect(scene?.framing).toBe("legs");
      expect(bank.places.find((p) => p.name === scene?.place?.location)?.moments.find((mo) => mo.text === scene?.place?.activity)?.legs).toEqual({ framing: "legs" });
      expect(scene?.capture).toBeDefined();
      expect(scene?.text).toContain(scene?.place?.activity ?? "never");
    }
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

  test("a launch with no legs, or a share of 0, reviews a set without any", async () => {
    expect(legsOf(await launchSet({}))).toHaveLength(0);
    expect(legsOf(await launchSet({ legsShare: 0 }))).toHaveLength(0);
  });
});
