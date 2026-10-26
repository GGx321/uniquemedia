import { describe, expect, test } from "bun:test";
import { bankDraw } from "./mockBankScenes";
import { makeMock, MIA, unwrap } from "./mockEngine.testkit";
import { shotOf } from "../../shared/scenes/captures";

// 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, QB-5, BA2 part 2 review L1): the mock's seeded set can name each scene's level and route, so a test can hold a set stored before 5a.4 (the five with no
// route, next to scenes on it) without the mock's own planner, which draws «Смелая» «Дом» on the route once the mock mirrors the engine's.

describe("a seeded set's scenes keep the level and the route the seed gives them", () => {
  const home = bankDraw("home", 0);
  const nightwear = bankDraw("nightwear", 0, { level: "bold" });

  test("a scene with a route and a level is shown with both; a scene with neither is shown with neither", async () => {
    const mock = makeMock({
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: "set-seed-0001",
          count: 2,
          written: 2,
          categories: ["home", "nightwear"],
          level: "bold",
          scenes: [
            { category: "home", shot: shotOf(home.capture), pose: home.pose, place: home.place, text: "A home scene." },
            { category: "nightwear", shot: shotOf(nightwear.capture), pose: nightwear.pose, place: nightwear.place, text: "A nightwear scene.", level: "bold", route: "seedream" },
          ],
        },
      ],
    });
    const set = (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    const [first, second] = set?.scenes ?? [];
    expect([first?.level, first?.route]).toEqual([undefined, undefined]);
    expect([second?.level, second?.route]).toEqual(["bold", "seedream"]);
  });
});
