import { describe, expect, test } from "bun:test";
import type { LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import { makeMock, MIA, scenePhoto, unwrap } from "./mockEngine.testkit";
import { runWorld, startRun, toDone } from "./mockLaunchRun.testkit";

// 5a.4 (S5.BA5, plan s5a4 r2.2 D2; the minimal mirror the controller allowed outside S5.BA7): the mock's launch takes the library as the engine's does. At «Смелая» only the free
// photos drawn on the Seedream route are the avatar's free photos (engine/autopilot/planner.ts `poolOf`).
// 2026-11-04 (the owner's answer after S5.BAR, item 3): below «Смелая» none of them is, as the engine's `poolOf` (`libraryPhotoFitsLevel`): a launch at «Обычная» or «Кокетливая»
// never takes a photo drawn at «Смелая».

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

  test("below «Смелая» no photo on the route is free", async () => {
    for (const level of [undefined, "ordinary", "flirty"] as const) {
      const preview = (await unwrap(world().client.request("autopilot.estimate", { draft: draft(level) }))).preview;
      expect({ level, free: preview.avatars[0]?.free }).toEqual({ level, free: PLAIN });
    }
  });
});

// The launch itself takes them so (`claimPhotos`, the engine's library pick through `poolOf`): a launch below «Смелая» leaves the routed photos where they are, even when the gallery
// offers them first.
describe("the mock's launch below «Смелая» takes no «Смелая» photo (the owner's answer of 2026-11-04)", () => {
  test("at «Кокетливая» its library video takes only photos off the route, though the gallery offers the routed ones first", async () => {
    const photos: PhotoSummary[] = [...Array.from({ length: 5 }, (_, i) => scenePhoto(i + 1, { route: "seedream" })), ...Array.from({ length: PLAIN }, (_, i) => scenePhoto(5 + i + 1))];
    const mock = runWorld({ avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos });
    const started = await startRun(mock, { videosPerAvatar: 1, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], library: true, generate: false, level: "flirty" });
    expect((await toDone(mock, started.launchId)).status).toBe("done");
    const used = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.used);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((p) => p.route === "seedream").map((p) => p.photoId)).toEqual([]);
  });
});
