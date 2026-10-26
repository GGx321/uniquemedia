import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "./envelope";
import { SceneSetView, SceneView } from "./scenes";

// 5a.4 (S5.BA1, plan s5a4 r2.2 D6, I5.78): the scene review shows a custom «Смелая» scene's world («по месту категории»), so the optional `world` rides on the strict `ScenePlace`
// of a planned SceneView. Additive, protocol 5. Present only on a custom category's scene on the Seedream route; BA3 and BA7 fill it.

const place = (over: Record<string, unknown> = {}) => ({ location: "her hotel room", timeOfDay: "evening", activity: "sits on the bed", outfit: "a white lace set", ...over });
const scene = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sceneId: 1,
  origin: "planned",
  category: "cat-paris-cafes",
  categoryName: "Paris cafes",
  shot: "friend",
  pose: "front",
  level: "bold",
  route: "seedream",
  place: place(),
  idea: null,
  text: "A friend catches her on the bed.",
  edited: false,
  removed: false,
  unwritten: null,
  gaveUpBy: null,
  chunk: 1,
  ...over,
});
const WORLD = "a cafe terrace in Paris";

describe("ScenePlace.world", () => {
  test("a custom routed scene keeps the world of its place", () => {
    expect(SceneView.parse(scene({ place: place({ world: WORLD }) })).place?.world).toBe(WORLD);
  });

  test("a place without a world parses and gains none", () => {
    const parsed = SceneView.parse(scene());
    expect(parsed.place === null || "world" in parsed.place).toBe(false);
  });

  test("a scene of the five without a world parses as before", () => {
    expect(SceneView.safeParse(scene({ category: "home", categoryName: null, level: undefined, route: undefined })).success).toBe(true);
  });

  test("a world on a built-in scene, or on a custom scene without the route, is refused", () => {
    expect(SceneView.safeParse(scene({ category: "home", categoryName: null, place: place({ world: WORLD }) })).success).toBe(false);
    expect(SceneView.safeParse(scene({ route: undefined, level: undefined, place: place({ world: WORLD }) })).success).toBe(false);
  });

  test("a world longer than a place text (120) is refused, the bound itself parses, and an empty one is refused", () => {
    expect(SceneView.safeParse(scene({ place: place({ world: "w".repeat(120) }) })).success).toBe(true);
    expect(SceneView.safeParse(scene({ place: place({ world: "w".repeat(121) }) })).success).toBe(false);
    expect(SceneView.safeParse(scene({ place: place({ world: "" }) })).success).toBe(false);
  });

  test("an own scene has no place, so no world", () => {
    const own = { sceneId: 2, origin: "own", category: "own", categoryName: null, shot: "friend", pose: "front", place: null, idea: "a walk", text: "She walks.", edited: false, removed: false, unwritten: null, gaveUpBy: null, chunk: null };
    expect(SceneView.safeParse(own).success).toBe(true);
    // The place is not null, so the «own has no place» rule refuses it too; what is pinned here is that the world refine speaks for the world, at `place.world`.
    const result = SceneView.safeParse({ ...own, place: place({ world: WORLD }) });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("place.world");
  });

  test("a set whose scene carries a world round-trips", () => {
    const view = {
      sceneSetId: "set-aaaa-0001", avatarId: "avatar-aaaa-0001", createdAt: "2026-10-07T10:00:00.000Z", revision: 1, status: "ready", stoppedBy: null, stoppedError: null, runId: null,
      level: "bold", categories: [{ ref: "cat-paris-cafes", name: "Paris cafes" }], textModel: "x-ai/grok-4.3", spentMicros: 0, openReserveMicros: 0, write: null,
      lastCompose: { total: 1, written: 1, gaveUp: 0 }, chunks: [{ chunk: 1, sceneIds: [1], attemptsLeft: 1, gaveUpBy: null }], scenes: [scene({ place: place({ world: WORLD }) })],
    };
    expect<unknown>(SceneSetView.parse(view)).toEqual(view);
  });

  test("the protocol stays at 5", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});
