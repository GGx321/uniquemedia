import { describe, expect, test } from "bun:test";
import type { LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import { makeMock, MIA, scenePhoto, unwrap } from "./mockEngine.testkit";
import { runWorld, startRun, toDone } from "./mockLaunchRun.testkit";

// 5a.4 (S5.BA5, plan s5a4 r2.2 D2; the minimal mirror the controller allowed outside S5.BA7): the mock's launch takes the library as the engine's does. At «Смелая» only the free
// photos drawn on the Seedream route are the avatar's free photos (engine/autopilot/planner.ts `poolOf`); below it every free photo of the chosen categories is, as before.

const ROUTED = 4;
const PLAIN = 8;

function world() {
  const photos: PhotoSummary[] = [
    ...Array.from({ length: ROUTED }, (_, i) => scenePhoto(i + 1, { route: "seedream" })),
    ...Array.from({ length: PLAIN }, (_, i) => scenePhoto(ROUTED + i + 1)),
  ];
  return makeMock({ avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos });
}

const draft = (level: LaunchDraftInput["level"]): LaunchDraftInput => ({
  avatarIds: [MIA.avatarId],
  videosPerAvatar: 2,
  mix: { single: 0, collage: 0, slides: 100 },
  categories: ["home"],
  library: true,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...(level === undefined ? {} : { level }),
});

describe("the mock's library of a «Смелая» launch (r2.2 D2)", () => {
  test("at «Смелая» only the routed photos are free", async () => {
    const preview = (await unwrap(world().client.request("autopilot.estimate", { draft: draft("bold") }))).preview;
    expect(preview.avatars[0]?.free).toBe(ROUTED);
  });

  test("below «Смелая» every free photo of the categories is, routed or not", async () => {
    for (const level of [undefined, "ordinary", "flirty"] as const) {
      const preview = (await unwrap(world().client.request("autopilot.estimate", { draft: draft(level) }))).preview;
      expect({ level, free: preview.avatars[0]?.free }).toEqual({ level, free: ROUTED + PLAIN });
    }
  });
});

// 5a.4 (S5.BA7, plan s5a4 r2.2 D2, §5.11 story 8): the launch itself takes them so. A «Смелая» launch's library video is made of routed photos only, even when the unrouted ones come first
// in the gallery (the engine's `poolOf` keeps only routed photos for a library pick); below «Смелая» it takes them in the gallery's order, as before.
describe("the mock's «Смелая» launch draws its library videos from routed photos only (r2.2 D2)", () => {
  function launchWorld() {
    // The unrouted photos are older, so the gallery's order offers them first.
    const photos: PhotoSummary[] = [...Array.from({ length: PLAIN }, (_, i) => scenePhoto(i + 1)), ...Array.from({ length: 5 }, (_, i) => scenePhoto(PLAIN + i + 1, { route: "seedream" }))];
    return runWorld({ avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos });
  }
  const libraryOnly = (level: LaunchDraftInput["level"]): Partial<LaunchDraftInput> => ({ videosPerAvatar: 1, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], library: true, generate: false, ...(level === undefined ? {} : { level }) });

  test("at «Смелая» every photo the library video took carries the route", async () => {
    const mock = launchWorld();
    const started = await startRun(mock, libraryOnly("bold"));
    const done = await toDone(mock, started.launchId);
    expect(done.status).toBe("done");
    const used = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.used);
    expect(used).toHaveLength(5);
    expect(used.every((p) => p.route === "seedream")).toBe(true);
  });

  test("at «Кокетливая» it takes the gallery's first free photos, routed or not", async () => {
    const mock = launchWorld();
    const started = await startRun(mock, libraryOnly("flirty"));
    await toDone(mock, started.launchId);
    const used = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.used);
    expect(used).toHaveLength(5);
    expect(used.some((p) => !("route" in p))).toBe(true);
  });
});
