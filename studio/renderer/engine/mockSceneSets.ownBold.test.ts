import { describe, expect, test } from "bun:test";
import { PriceBook } from "../../engine/money/prices";
import { reviewWriteEstimate } from "../../engine/sceneSets/estimate";
import type { AvatarSummary, SceneSetView, SceneView } from "../../shared/engine";
import { boldContentLevel, contentProblems } from "../../shared/scenes/contentLine";
import { COVER } from "../../shared/scenes/banks/companions/outfits";
import { namesImpliedCover, OWN_BOLD_COVERAGE } from "../../shared/scenes/ownScene";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";
import { MOCK_OWN_BOLD_OUTFIT } from "./mockSceneSets";
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
/** S5.BA9 r2: an idea that asks for less than lingerie, in the English the mock's sentence repeats. */
const TOWEL_IDEA = { kind: "idea", idea: "wrapped in a towel after her shower", count: 1, shot: "friend" } as const;

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

/** The set with one own scene written from «в белье на кровати» (or `target`). */
async function withOwn(m: Mock, avatarId: string, level: "flirty" | "bold", target: typeof IDEA | typeof TOWEL_IDEA = IDEA): Promise<SceneSetView> {
  const view = await composed(m, avatarId, level);
  await unwrap(m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target, acceptedWorstMicros: WORST }));
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
  test("the mock's «Смелая» outfit is one the ordinary line refuses (a garment the bold variant draws)", () => {
    expect(contentProblems(MOCK_OWN_BOLD_OUTFIT, "ordinary").map((p) => p.reason)).toEqual(["revealing-word"]);
  });

  test("an imported avatar's is written in a «Смелая» outfit, held to the «Смелая» line, and ends with the kept coverage", async () => {
    const m = mockOf();
    const own = ownOf(await withOwn(m, MIA.avatarId, "bold"));
    expect(own.text).toContain(MOCK_OWN_BOLD_OUTFIT);
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(true);
    expect(contentProblems(own.text ?? "", boldContentLevel())).toEqual([]);
  });

  test("an avatar made in Studio's ends with no coverage", async () => {
    const m = mockOf();
    const own = ownOf(await withOwn(m, STUDIO.avatarId, "bold"));
    expect(own.text).toContain(MOCK_OWN_BOLD_OUTFIT);
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(false);
  });

  test("at «Кокетливая» it is written as before, with no coverage", async () => {
    const m = mockOf();
    const own = ownOf(await withOwn(m, MIA.avatarId, "flirty"));
    expect(own.text).not.toContain(MOCK_OWN_BOLD_OUTFIT);
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(false);
  });

  // 2026-11-03, S5.BA9 r2 (review L1): this row pinned «the scene view of an own scene says no route at either level». The field is optional on every scene, and an own scene of a
  // «Смелая» set IS drawn on the route, so the view says so, as the engine's does (sceneSets/view.ts); below «Смелая» it still says none.
  test("the scene view of an own scene says the route in a «Смелая» set, and none in a «Кокетливая» one", async () => {
    expect(ownOf(await withOwn(mockOf(), MIA.avatarId, "bold")).route).toBe("seedream");
    expect("route" in ownOf(await withOwn(mockOf(), MIA.avatarId, "flirty"))).toBe(false);
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

// S5.BA9 r2 (review M1): the mock's writer writes what the engine's reader keeps for the avatar's origin. An idea that asks for a towel is drawn in it alone only for an avatar made in
// Studio; an imported avatar's is drawn in the «Смелая» outfit (the engine refuses a towel alone for it, `implied-cover`) and ends with the kept coverage.
describe("an idea that asks for a towel at «Смелая» on the mock (S5.BA9 r2)", () => {
  test("an imported avatar's is drawn in the «Смелая» outfit, never in the towel alone, and ends with the kept coverage", async () => {
    const own = ownOf(await withOwn(mockOf(), MIA.avatarId, "bold", TOWEL_IDEA));
    expect(own.text).toContain(MOCK_OWN_BOLD_OUTFIT);
    expect(namesImpliedCover(own.text ?? "")).toBe(false);
    expect(own.text?.endsWith(OWN_BOLD_COVERAGE)).toBe(true);
  });

  test("an avatar made in Studio's is drawn as the idea says, in the towel alone", async () => {
    const own = ownOf(await withOwn(mockOf(), STUDIO.avatarId, "bold", TOWEL_IDEA));
    expect(own.text).not.toContain(MOCK_OWN_BOLD_OUTFIT);
    expect(namesImpliedCover(own.text ?? "")).toBe(true);
  });

  test("an avatar made in Studio's towel frame ends with the towel's sentence, as the engine's reader appends it (S5.BA9 r2, review M2)", async () => {
    const own = ownOf(await withOwn(mockOf(), STUDIO.avatarId, "bold", TOWEL_IDEA));
    expect(own.text?.endsWith(` ${COVER.towelOpen}`)).toBe(true);
  });
});

// S5.BA9 r2 (review L4): the engine's bold idea prompt forbids books and papers (its standing «No paper» line), so the mock's own «Смелая» scene never draws «a book beside her», whatever
// the take turns its detail to. Two idea writes on one set turn the detail through every value.
describe("the mock's own «Смелая» scene names no book (S5.BA9 r2)", () => {
  test("two idea writes in a row, in every scene they write", async () => {
    const m = mockOf();
    let view = await withOwn(m, MIA.avatarId, "bold");
    await unwrap(m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target: IDEA, acceptedWorstMicros: WORST }));
    m.scheduler.runAll();
    view = await setOf(m, MIA.avatarId);
    const own = view.scenes.filter((s) => s.origin === "own");
    expect(own.length).toBe(2);
    expect(own.filter((s) => /\bbooks?\b/i.test(s.text ?? "")).map((s) => s.sceneId)).toEqual([]);
  });
});
