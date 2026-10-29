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

  // S5.7R carry-over: the engine draws the flirty slots from the frames that show her face first (a hidden frame gets no flirty gaze, cue or moment); the mock does the same.

  // S5.7R carry-over (LOW, I5.27): the engine's slot stores a capture only when it says more than the stored shot (a timer on `friend`, a prone selfie on `selfie`), and the view echoes
  // only that; the mock echoed the shot's own capture too.

  test("an ordinary set, asked or not, holds no flirty scene", async () => {
    for (const over of [{}, { level: "ordinary" }]) expect((await composed(over, 30)).view.scenes.some((s) => s.level !== undefined)).toBe(false);
  });

});

