import { describe, expect, test } from "bun:test";
import { PriceBook } from "../../engine/money/prices";
import { reviewWriteEstimate } from "../../engine/sceneSets/estimate";
import type { AvatarSummary, SceneSetView, SceneView } from "../../shared/engine";
import { boldContentLevel, contentProblems } from "../../shared/scenes/contentLine";
import { OWN_BOLD_COVERAGE } from "../../shared/scenes/ownScene";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";
useNativeGlobals();

// 5a.4 (S5.BA9, plan s5a4 §8 BA9, §5.11): the mock's «Своя сцена» at «Смелая» is the engine's. An idea write on a «Смелая» set is priced in the bold mode (the engine's
// `reviewWriteEstimate` of `writeModeOf`), its own scene is written in lingerie and, for an imported avatar (Mia), ends with the kept coverage, and the scene is drawn on the route: a run from
// the set prices it at the 2K unit and its photo carries the route. Below «Смелая» nothing moves.

const WORST = 100_000_000;
const BOLD_ATTEMPT = 93_000;
const STUDIO: AvatarSummary = { ...MIA, avatarId: "avatar-ava-0009", name: "Ava", masterPhotoId: "photo-ava-master", origin: "studio" };
const PRICED = { book: PriceBook.fallback(), asOf: "2026-10-28" };
const MODEL = "x-ai/grok-4.3";
const IDEA = { kind: "idea", idea: "в белье на кровати", count: 1, shot: "friend" } as const;

function mockOf(): Mock {
  return makeMock({ avatars: [MIA, STUDIO], photos: [] });
}

async function setOf(m: Mock, avatarId: string): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}

/** A «Дом» set of two written scenes at `level` for `avatarId`. */
async function composed(m: Mock, avatarId: string, level: "flirty" | "bold"): Promise<SceneSetView> {
  await unwrap(m.client.request("scenes.compose", { avatarId, count: 2, categories: ["home"], level, acceptedWorstMicros: WORST }));
  m.scheduler.runAll();
  return setOf(m, avatarId);
}

/** The set with one own scene written from «в белье на кровати». */
async function withOwn(m: Mock, avatarId: string, level: "flirty" | "bold"): Promise<SceneSetView> {
  const view = await composed(m, avatarId, level);
  await unwrap(m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target: IDEA, acceptedWorstMicros: WORST }));
  m.scheduler.runAll();
  return setOf(m, avatarId);
}

const ownOf = (view: SceneSetView): SceneView => {
  const own = view.scenes.find((s) => s.origin === "own");
  if (own === undefined) throw new Error("no own scene");
  return own;
};

describe("an idea write on the mock is priced in its set's mode (S5.BA9)", () => {
  test.each([
    ["«Смелая»", "bold", 97_500],
    ["«Кокетливая»", "flirty", 75_000],
  ] as const)("%s: two attempts at the engine's figure for the mode (%s, %d)", async (_name, level, worst) => {
    const m = mockOf();
    const view = await composed(m, MIA.avatarId, level);
    const { estimate } = await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: IDEA }));
    expect(estimate.worstMicros).toBe(worst);
    expect(estimate.worstMicros).toBe(reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, level === "bold" ? "bold" : "ordinary").worstMicros);
    expect(estimate.expectedMicros).toBe(reviewWriteEstimate(PRICED, MODEL, 1, 2, 1, level === "bold" ? "bold" : "ordinary").expectedMicros);
  });

  test("a rewrite of an own scene of a «Смелая» set is priced in the bold mode too", async () => {
    const m = mockOf();
    const view = await withOwn(m, MIA.avatarId, "bold");
    const { estimate } = await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: { kind: "rewrite", sceneIds: [ownOf(view).sceneId], redraw: false } }));
    expect(estimate.worstMicros).toBe(97_500);
  });
});

describe("the own scene of a «Смелая» set on the mock (S5.BA9)", () => {
  test("an imported avatar's is written in lingerie, held to the «Смелая» line, and ends with the kept coverage", async () => {
    const m = mockOf();
    const own = ownOf(await withOwn(m, MIA.avatarId, "bold"));
    expect(own.text).toContain("lingerie");
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(true);
    expect(contentProblems(own.text ?? "", boldContentLevel())).toEqual([]);
  });

  test("an avatar made in Studio's ends with no coverage", async () => {
    const m = mockOf();
    const own = ownOf(await withOwn(m, STUDIO.avatarId, "bold"));
    expect(own.text).toContain("lingerie");
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(false);
  });

  test("at «Кокетливая» it is written as before, with no coverage", async () => {
    const m = mockOf();
    const own = ownOf(await withOwn(m, MIA.avatarId, "flirty"));
    expect(own.text).not.toContain("lingerie");
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(false);
  });

  test("the scene view of an own scene says no route at either level (the contract's own scene has none)", async () => {
    const m = mockOf();
    expect("route" in ownOf(await withOwn(m, MIA.avatarId, "bold"))).toBe(false);
  });

  test("a run from the «Смелая» set prices the own scene at the 2K unit, and its photo is on the route", async () => {
    const m = mockOf();
    const view = await withOwn(m, MIA.avatarId, "bold");
    const { estimate } = await unwrap(m.client.request("runs.estimateFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision }));
    expect(estimate.boldAttemptMicros).toBe(BOLD_ATTEMPT);
    expect(estimate.worstMicros).toBe(3 * 3 * BOLD_ATTEMPT);
    await unwrap(m.client.request("runs.startFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision, acceptedWorstMicros: WORST }));
    m.scheduler.runAll();
    const { photos } = await unwrap(m.client.request("photos.list", { avatarId: MIA.avatarId }));
    const own = photos.filter((p) => p.category === "own");
    expect(own.length).toBe(1);
    expect(own.every((p) => p.route === "seedream")).toBe(true);
  });

  test("a run from a «Кокетливая» set keeps the own scene off the route", async () => {
    const m = mockOf();
    const view = await withOwn(m, MIA.avatarId, "flirty");
    await unwrap(m.client.request("runs.startFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision, acceptedWorstMicros: WORST }));
    m.scheduler.runAll();
    const { photos } = await unwrap(m.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.filter((p) => p.category === "own").every((p) => p.route === undefined)).toBe(true);
  });

  test("the owner's edit of a «Смелая» own scene may say lingerie; at «Кокетливая» it is a revealing word", async () => {
    for (const [level, ok] of [["bold", true], ["flirty", false]] as const) {
      const m = mockOf();
      const view = await withOwn(m, MIA.avatarId, level);
      const result = await unwrap(m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op: { op: "text", sceneId: ownOf(view).sceneId, text: "She lies across her bed in black lingerie." } }));
      expect({ level, problem: "problem" in result ? result.problem.reason : null }).toEqual({ level, problem: ok ? null : "revealing-word" });
    }
  });
});
