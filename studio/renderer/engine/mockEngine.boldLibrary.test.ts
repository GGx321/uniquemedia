import { describe, expect, test } from "bun:test";
import type { LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import { makeMock, MIA, scenePhoto, unwrap } from "./mockEngine.testkit";

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

});

// 5a.4 (S5.BA7, plan s5a4 r2.2 D2, §5.11 story 8): the launch itself takes them so. A «Смелая» launch's library video is made of routed photos only, even when the unrouted ones come first
// in the gallery (the engine's `poolOf` keeps only routed photos for a library pick); below «Смелая» it takes them in the gallery's order, as before.

