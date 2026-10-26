import { describe, expect, test } from "bun:test";
import type { AvatarSummary, SceneSetView, SceneView } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { atOrBelow, levelCountsOf } from "../../shared/scenes/level";
import { DEFAULT_TRAITS } from "../lib/traits";
import { BANK_OF } from "./mockBankScenes";
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

const bankOf = (scene: SceneView) => BANKS[BANK_OF[scene.category as keyof typeof BANK_OF]];
const itemsOf = (scene: SceneView) => {
  const bank = bankOf(scene);
  const moment = bank.places.find((p) => p.name === scene.place?.location)?.moments.find((mo) => mo.text === scene.place?.activity);
  const outfit = bank.outfits.find((o) => o.text === scene.place?.outfit);
  if (moment === undefined || outfit === undefined) throw new Error(`the mock drew an item the bank does not have: ${scene.place?.location} | ${scene.place?.activity} | ${scene.place?.outfit}`);
  return { moment, outfit };
};
const levelOf = (scene: SceneView) => scene.level ?? "ordinary";

describe("a bold set of the «Смелая» categories on the mock", () => {
  test.each([["nightwear"], ["beach"]] as const)("%s: the scenes hold the 20 / 40 / 40 mix, exactly, at every size", async (category) => {
    for (const count of [1, 2, 3, 5, 6, 10, 12, 25]) {
      const { view } = await composed({ categories: [category], level: "bold" }, count);
      const got = { bold: view.scenes.filter((s) => s.level === "bold").length, flirty: view.scenes.filter((s) => s.level === "flirty").length, ordinary: view.scenes.filter((s) => s.level === undefined).length };
      expect({ count, got }).toEqual({ count, got: levelCountsOf(count) });
    }
  });

  test("a mixed set holds each category's own counts, and the five among them draw the «Кокетливая» mix", async () => {
    const { view } = await composed({ categories: ["home", "nightwear", "beach"], level: "bold" }, 30);
    for (const category of ["nightwear", "beach"]) {
      const own = view.scenes.filter((s) => s.category === category);
      expect(own.filter((s) => s.level === "bold")).toHaveLength(levelCountsOf(own.length).bold);
      expect(own.filter((s) => s.level === "flirty")).toHaveLength(levelCountsOf(own.length).flirty);
    }
    const home = view.scenes.filter((s) => s.category === "home");
    expect(home.filter((s) => s.level === "flirty")).toHaveLength(6);
    expect(home.some((s) => s.level === "bold" || s.route !== undefined)).toBe(false);
  });

  test("the set shows its level, and every scene is written by the shared template", async () => {
    const { view } = await composed({ categories: ["nightwear", "beach"], level: "bold" }, 20);
    expect(view.level).toBe("bold");
    expect(view.scenes.every((s) => s.text !== null)).toBe(true);
  });

  test("a scene takes nothing above its level and shows the Seedream route exactly when it drew a Seedream item", async () => {
    for (const category of ["nightwear", "beach"] as const) {
      const { view } = await composed({ categories: [category], level: "bold" }, 40);
      for (const scene of view.scenes) {
        const { moment, outfit } = itemsOf(scene);
        expect({ scene: scene.sceneId, moment: atOrBelow(moment.level, levelOf(scene)), outfit: atOrBelow(outfit.level, levelOf(scene)) }).toEqual({ scene: scene.sceneId, moment: true, outfit: true });
        expect({ scene: scene.sceneId, route: scene.route }).toEqual({ scene: scene.sceneId, route: moment.route === "seedream" || outfit.route === "seedream" ? "seedream" : undefined });
      }
    }
  });

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear outfit is on Seedream now, so its ordinary scenes are too; the scenes off the route are a «Смелая» «Дом» set's (still drawn as
  // «Кокетливая» until S5.BA3 plans its companion), as on the engine.
  test("every nightwear scene is drawn on Seedream, its ordinary ones included, and a «Смелая» «Дом» scene is not", async () => {
    const { view } = await composed({ categories: ["nightwear"], level: "bold" }, 40);
    expect(view.scenes.filter((s) => s.level === "bold").every((s) => s.route === "seedream")).toBe(true);
    expect(view.scenes.filter((s) => s.level === undefined).length).toBeGreaterThan(0);
    expect(view.scenes.filter((s) => s.level === undefined).every((s) => s.route === "seedream")).toBe(true);
    const home = await composed({ categories: ["home"], level: "bold" }, 20);
    expect(home.view.scenes.length).toBeGreaterThan(0);
    expect(home.view.scenes.every((s) => s.route === undefined)).toBe(true);
  });

  test("every beach scene is drawn on Seedream: every beach outfit is swimwear", async () => {
    const { view } = await composed({ categories: ["beach"], level: "bold" }, 30);
    expect(view.scenes.every((s) => s.route === "seedream")).toBe(true);
  });

  test("a legs share gives legs scenes of the bank at their level", async () => {
    const { view } = await composed({ categories: ["nightwear"], level: "bold", legsShare: 30 }, 30);
    const legs = view.scenes.filter((s) => s.framing === "legs");
    expect(legs.length).toBeGreaterThan(0);
    for (const scene of legs) {
      const { moment, outfit } = itemsOf(scene);
      expect(moment.legs).toEqual({ framing: "legs" });
      expect(atOrBelow(outfit.level, levelOf(scene))).toBe(true);
    }
  });
});

describe("«Другая сцена» on a «Смелая» scene on the mock", () => {
  test("keeps the scene's level and route, within its level", async () => {
    const { m, view } = await composed({ categories: ["nightwear", "beach"], level: "bold" }, 20);
    // A write covers at most five scenes: two of them, one batch from each category.
    for (const category of ["nightwear", "beach"]) {
      const current = await setOf(m);
      const ids = current.scenes.filter((s) => s.category === category).slice(0, 5).map((s) => s.sceneId);
      const made = await m.client.request("scenes.write", { sceneSetId: current.sceneSetId, revision: current.revision, target: { kind: "rewrite", sceneIds: ids, redraw: true }, acceptedWorstMicros: 600_000 } as never);
      expect(made).toMatchObject({ ok: true });
      m.scheduler.runAll();
    }
    const after = await setOf(m);
    for (const scene of after.scenes) {
      const before = view.scenes.find((s) => s.sceneId === scene.sceneId);
      expect({ scene: scene.sceneId, level: scene.level }).toEqual({ scene: scene.sceneId, level: before?.level });
      const { moment, outfit } = itemsOf(scene);
      expect(atOrBelow(moment.level, levelOf(scene)) && atOrBelow(outfit.level, levelOf(scene))).toBe(true);
      expect(scene.route).toBe(moment.route === "seedream" || outfit.route === "seedream" ? "seedream" : undefined);
    }
    expect(after.scenes.some((s, i) => s.place?.activity !== view.scenes[i]?.place?.activity)).toBe(true);
  });
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

  test("is refused by runs.estimate and runs.start the same way", async () => {
    const m = makeMock();
    const asked = { avatarId: MIA.avatarId, count: 5, categories: ["beach"], level: "flirty" };
    expect(await m.client.request("runs.estimate", asked as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "bold-level-needed" } });
    expect(await m.client.request("runs.start", { ...asked, acceptedWorstMicros: WORST } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", sceneReason: "bold-level-needed" } });
  });

  test("the autopilot's estimate and start are refused with the launch reason", async () => {
    const m = makeMock();
    const draft = { avatarIds: [MIA.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["nightwear"], library: false, generate: true, sceneReview: false, stickers: false };
    expect(await m.client.request("autopilot.estimate", { draft } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", launchReason: "bold-level-needed" } });
    expect(await m.client.request("autopilot.start", { draft: { ...draft, planSeed: 5 }, acceptedWorstMicros: WORST } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION", launchReason: "bold-level-needed" } });
  });

  test("«Смелая» with or without a «Смелая» category, and the five at any level, are not refused for it", async () => {
    const m = makeMock();
    for (const [categories, level] of [[["home"], "bold"], [["nightwear"], "bold"], [["home"], "flirty"], [["home"], undefined]] as const) {
      const reply = await m.client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count: 5, categories: [...categories], ...(level === undefined ? {} : { level }) } as never);
      expect(reply).not.toMatchObject({ error: { sceneReason: "bold-level-needed" } });
    }
  });
});

describe("the owner's edit of a «Смелая» scene on the mock", () => {
  const BOLD_TEXT = "She lies under the sheet, topless, in a white string bikini bottom, naked otherwise.";

  async function edit(view: SceneSetView, m: Mock, sceneId: number, text: string) {
    return m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op: { op: "text", sceneId, text } } as never);
  }

  test("lets «topless», «naked» and «bikini» through on a «Смелая» scene and refuses a youth word", async () => {
    const { m, view } = await composed({ categories: ["nightwear"], level: "bold" }, 4);
    expect(await edit(view, m, 1, BOLD_TEXT)).toMatchObject({ ok: true, result: { sceneSet: expect.anything() } });
    expect(await edit(await setOf(m), m, 2, "A teenage girl in a bikini.")).toMatchObject({ ok: true, result: { problem: { reason: "youth-word" } } });
  });

  test("refuses the revealing word on a scene of «Дом»", async () => {
    const { m, view } = await composed({ categories: ["home"], level: "bold" }, 4);
    expect(await edit(view, m, 1, BOLD_TEXT)).toMatchObject({ ok: true, result: { problem: { reason: "revealing-word" } } });
  });
});
