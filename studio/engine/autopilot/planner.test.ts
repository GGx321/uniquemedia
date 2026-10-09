import { describe, expect, test } from "bun:test";
import { hammingDistance } from "../../../src/core/pdq/hamming";
import { shapeSizeFits, type VideoShape } from "../../shared/engine/autopilot";
import type { CategoryRef } from "../../shared/engine/categories";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { mixCounts, planLaunch, type AvatarPlan, type PlanAvatarInput, type PlanPhoto, type PlannedVideo } from "./planner";
import { avatar, distinctPhotos, draft, flipBits, hexToBytes, input, photo, randomPdq, rng } from "./testing/planFixtures";
useNativeGlobals();

// S4.3 (plan §5, §6.2, §10 A7, A17): the launch planner. Every test builds the input by hand; nothing reads a library.

const only = (plan: ReturnType<typeof planLaunch>): AvatarPlan => {
  const first = plan.avatars[0];
  if (first === undefined) throw new Error("the plan has no avatar");
  return first;
};
const shapesOf = (videos: readonly PlannedVideo[]): Record<VideoShape, number> => ({
  single: videos.filter((v) => v.shape === "single").length,
  collage: videos.filter((v) => v.shape === "collage").length,
  slides: videos.filter((v) => v.shape === "slides").length,
});
const SHAPES: readonly VideoShape[] = ["single", "collage", "slides"];

describe("mixCounts: the mix applied by largest remainder, ties to single, collage, slides", () => {
  const cases: [number, [number, number, number], [number, number, number]][] = [
    [1, [70, 20, 10], [1, 0, 0]],
    [2, [70, 20, 10], [2, 0, 0]],
    [3, [70, 20, 10], [2, 1, 0]],
    [10, [70, 20, 10], [7, 2, 1]],
    [50, [70, 20, 10], [35, 10, 5]],
    [7, [100, 0, 0], [7, 0, 0]],
    [7, [0, 0, 100], [0, 0, 7]],
    [7, [0, 100, 0], [0, 7, 0]],
    [1, [34, 33, 33], [1, 0, 0]],
    [2, [34, 33, 33], [1, 1, 0]],
    [1, [0, 50, 50], [0, 1, 0]],
  ];
  for (const [videos, [single, collage, slides], expected] of cases) {
    test(`${videos} videos at ${single}/${collage}/${slides} give ${expected.join("/")}`, () => {
      const counts = mixCounts(videos, { single, collage, slides });
      expect([counts.single, counts.collage, counts.slides]).toEqual(expected);
    });
  }

  test("the counts always add up to the videos, for every n from 1 to 50 and several mixes", () => {
    for (const mix of [
      { single: 70, collage: 20, slides: 10 },
      { single: 33, collage: 33, slides: 34 },
      { single: 1, collage: 1, slides: 98 },
      { single: 50, collage: 0, slides: 50 },
    ]) {
      for (let n = 1; n <= 50; n++) {
        const c = mixCounts(n, mix);
        expect(c.single + c.collage + c.slides).toBe(n);
      }
    }
  });
});

describe("planLaunch: the pool and the shapes", () => {
  test("with no free photo every video is generated and the need is 1, 3 and 5 photos per shape (7/2/1 gives 18)", () => {
    const plan = planLaunch(input({ avatars: [avatar([])] }));
    const mia = only(plan);
    expect(mia.videos.every((v) => v.source === "generated")).toBe(true);
    expect(mia.shapes).toEqual({ single: 7, collage: 2, slides: 1 });
    expect(mia.toGenerate).toBe(18);
    expect(mia.fromLibrary).toBe(0);
    expect(mia.blocked).toBeNull();
  });

  test("with no free photo and «Догенерировать» off the videos are dropped and no photo is asked for", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { generate: false } })));
    expect(mia.videos).toEqual([]);
    expect(mia.dropped).toHaveLength(10);
    expect(mia.dropped.every((d) => d.reason === "not-enough-photos")).toBe(true);
    expect(mia.toGenerate).toBe(0);
  });

  test("with «Сначала свободные фото» off every video is generated although photos are free, and `free` still counts them", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(30))], draft: { library: false } })));
    expect(mia.fromLibrary).toBe(0);
    expect(mia.free).toBe(30);
    expect(mia.videos.every((v) => v.source === "generated")).toBe(true);
  });

  test("both toggles off plans no video at all", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(30))], draft: { library: false, generate: false } })));
    expect(mia.videos).toEqual([]);
  });

  test("exactly enough photos for singles take them all from the library and generate nothing", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(4))], draft: { videosPerAvatar: 4, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.fromLibrary).toBe(4);
    expect(mia.toGenerate).toBe(0);
    expect(mia.videos.every((v) => v.source === "library")).toBe(true);
  });

  test("one photo short for singles generates exactly one photo for the last video", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(3))], draft: { videosPerAvatar: 4, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.fromLibrary).toBe(3);
    expect(mia.toGenerate).toBe(1);
    expect(mia.generate).toEqual([{ category: "home", count: 1, poses: ["front", "three-quarter"] }]);
  });

  test("slides with exactly 5 distinct photos are filled from the library", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(5))], draft: { videosPerAvatar: 1, mix: { single: 0, collage: 0, slides: 100 } } })));
    const video = mia.videos[0];
    expect(video?.source).toBe("library");
    expect(video?.size).toBe(5);
    expect(video?.photoIds).toHaveLength(5);
  });

  test("slides with 4 photos cannot be filled and become a generated slides video of 5 new photos", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(4))], draft: { videosPerAvatar: 1, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.videos[0]).toMatchObject({ shape: "slides", size: 5, source: "generated" });
    expect(mia.toGenerate).toBe(5);
    expect(mia.fromLibrary).toBe(0);
  });

  test("a library collage takes the largest size it can fill when the category has fewer photos than the draw asked for", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(2))], draft: { videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 }, planSeed: seed } })));
      expect(mia.videos[0]).toMatchObject({ shape: "collage", size: 2, source: "library" });
    }
  });

  test("a library video never has more photos than its shape allows, for 40 seeds with 40 free photos", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(40, {}, seed))], draft: { videosPerAvatar: 10, planSeed: seed } })));
      for (const video of mia.videos) expect(shapeSizeFits(video.shape, video.size)).toBe(true);
    }
  });

  test("a library video has as many photo ids as its size", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(40))], draft: { videosPerAvatar: 10 } })));
    for (const video of mia.videos.filter((v) => v.source === "library")) expect(video.photoIds).toHaveLength(video.size);
  });

  test("50 videos at 70/20/10 plan 35 singles, 10 collages and 5 slides with unique keys 0-1 to 0-50", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 50 } })));
    expect(mia.shapes).toEqual({ single: 35, collage: 10, slides: 5 });
    expect(mia.videos).toHaveLength(50);
    expect(new Set(mia.videos.map((v) => v.key))).toEqual(new Set(Array.from({ length: 50 }, (_, i) => `0-${i + 1}`)));
    expect(mia.toGenerate).toBe(35 + 30 + 25);
  });

  test("a key names the avatar's position in the draft", () => {
    const plan = planLaunch(input({ avatars: [avatar([], { avatarId: "a" }), avatar([], { avatarId: "b" })], draft: { videosPerAvatar: 2 } }));
    expect(plan.avatars[1]?.videos.map((v) => v.key).sort()).toEqual(["1-1", "1-2"]);
  });

  test("the shapes reported are the shapes of the planned videos", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(12))], draft: { videosPerAvatar: 10 } })));
    expect(mia.shapes).toEqual(shapesOf(mia.videos));
  });
});

describe("planLaunch: same-category groups and the generated split", () => {
  test("a collage or slides video draws all its photos from one category", () => {
    const home = distinctPhotos(6, { category: "home" }, 11);
    const travel = distinctPhotos(6, { category: "travel" }, 12);
    for (let seed = 1; seed <= 30; seed++) {
      const mia = only(
        planLaunch(input({ avatars: [avatar([...home, ...travel])], draft: { categories: ["home", "travel"], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, planSeed: seed } })),
      );
      const byId = new Map([...home, ...travel].map((p) => [p.id, p.category]));
      for (const video of mia.videos.filter((v) => v.source === "library")) {
        expect(new Set(video.photoIds.map((id) => byId.get(id))).size).toBe(1);
        expect(byId.get(video.photoIds[0] ?? "")).toBe(video.category);
      }
    }
  });

  test("a category with too few photos does not borrow from another to fill a slides video", () => {
    const mia = only(
      planLaunch(
        input({
          avatars: [avatar([...distinctPhotos(3, { category: "home" }, 21), ...distinctPhotos(3, { category: "travel" }, 22)])],
          draft: { categories: ["home", "travel"], videosPerAvatar: 1, mix: { single: 0, collage: 0, slides: 100 } },
        }),
      ),
    );
    expect(mia.videos[0]?.source).toBe("generated");
  });

  test("the generated need is exact per category: it adds up to the generated videos' sizes", () => {
    const categories: CategoryRef[] = ["home", "travel", "glam"];
    for (let seed = 1; seed <= 25; seed++) {
      const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { categories, videosPerAvatar: 13, planSeed: seed } })));
      for (const category of categories) {
        const need = mia.videos.filter((v) => v.category === category).reduce((sum, v) => sum + v.size, 0);
        expect(mia.generate.find((g) => g.category === category)?.count ?? 0).toBe(need);
      }
      expect(mia.generate.reduce((sum, g) => sum + g.count, 0)).toBe(mia.toGenerate);
    }
  });

  test("the generated videos go round the chosen categories, so no category gets more than one video above another", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { categories: ["home", "travel", "glam"], videosPerAvatar: 10, mix: { single: 100, collage: 0, slides: 0 } } })));
    const counts = ["home", "travel", "glam"].map((c) => mia.videos.filter((v) => v.category === c).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test("a generated category appears in `generate` only with a positive count", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { categories: ["home", "travel", "glam", "fit"], videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.generate.every((g) => g.count > 0)).toBe(true);
    expect(mia.generate).toHaveLength(2);
  });
});

describe("planLaunch: custom categories and angles (CS.8)", () => {
  const custom: CategoryRef = "cat-sunsets-on-roofs";

  test("a custom category's photos are pooled and used when it is chosen", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(3, { category: custom }))], draft: { categories: [custom], videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.free).toBe(3);
    expect(mia.fromLibrary).toBe(3);
  });

  test("a custom category's photos are not taken when it is not chosen", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(3, { category: custom }))], draft: { categories: ["home"], videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.free).toBe(0);
    expect(mia.fromLibrary).toBe(0);
  });

  test("a custom category with its own angles asks for those, whatever the toggles say", () => {
    const mia = only(
      planLaunch(
        input({
          avatars: [avatar([])],
          draft: { categories: [custom], videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 }, poses: { profile: true, back: true } },
          customPoses: new Map([[custom, ["back"]]]),
        }),
      ),
    );
    expect(mia.generate[0]?.poses).toEqual(["back"]);
  });

  test("a built-in category uses the toggles: front and three-quarter always, profile and back when on", () => {
    const off = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 1 } })));
    const on = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 1, poses: { profile: true, back: true } } })));
    expect(off.generate[0]?.poses).toEqual(["front", "three-quarter"]);
    expect(on.generate[0]?.poses).toEqual(["front", "three-quarter", "profile", "back"]);
  });

  test("a custom category without its own angles uses the toggles", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { categories: [custom], videosPerAvatar: 1, poses: { profile: true, back: false } } })));
    expect(mia.generate[0]?.poses).toEqual(["front", "three-quarter", "profile"]);
  });
});

describe("planLaunch: PDQ near-duplicates", () => {
  const base = randomPdq(rng(99));
  const collageOnly = { videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 } } as const;

  test("two photos at distance 20 are near-duplicates, so a collage cannot be built from them", () => {
    const pair = [photo({ pdq: base }), photo({ pdq: flipBits(base, 20) })];
    const mia = only(planLaunch(input({ avatars: [avatar(pair)], draft: collageOnly })));
    expect(mia.videos[0]?.source).toBe("generated");
  });

  test("two photos at distance 21 are distinct, so a collage of 2 is built from them", () => {
    const pair = [photo({ pdq: base }), photo({ pdq: flipBits(base, 21) })];
    const mia = only(planLaunch(input({ avatars: [avatar(pair)], draft: collageOnly })));
    expect(mia.videos[0]).toMatchObject({ source: "library", size: 2 });
  });

  test("a near-duplicate is left out and the collage is filled from the others", () => {
    const far = distinctPhotos(2, {}, 31);
    const dupA = photo({ pdq: base });
    const dupB = photo({ pdq: flipBits(base, 3) });
    const mia = only(planLaunch(input({ avatars: [avatar([dupA, dupB, ...far])], draft: collageOnly })));
    const ids = mia.videos[0]?.photoIds ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.filter((id) => id === dupA.id || id === dupB.id).length).toBeLessThanOrEqual(1);
  });

  test("5 photos with one near-duplicate pair leave 4 distinct, which is too few for slides", () => {
    const four = distinctPhotos(4, {}, 41);
    const dup = photo({ pdq: flipBits(four[0]?.pdq ?? base, 5) });
    const mia = only(planLaunch(input({ avatars: [avatar([...four, dup])], draft: { videosPerAvatar: 1, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.videos[0]?.source).toBe("generated");
  });

  test("photos without a stored hash count as distinct", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([photo(), photo(), photo()])], draft: collageOnly })));
    expect(mia.videos[0]).toMatchObject({ source: "library" });
  });

  test("two singles may be near-duplicates of each other: the rule is inside one video", () => {
    const pair = [photo({ pdq: base }), photo({ pdq: flipBits(base, 2) })];
    const mia = only(planLaunch(input({ avatars: [avatar(pair)], draft: { videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.fromLibrary).toBe(2);
  });
});

describe("planLaunch: faces for singles", () => {
  test("singles take the photos with the highest stored face match first", () => {
    const low = photo({ faceCos: 0.5 });
    const high = photo({ faceCos: 0.95 });
    const mid = photo({ faceCos: 0.8 });
    const none = [photo(), photo()];
    const mia = only(planLaunch(input({ avatars: [avatar([low, none[0] as PlanPhoto, high, mid, none[1] as PlanPhoto])], draft: { videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(new Set(mia.videos.flatMap((v) => v.photoIds))).toEqual(new Set([high.id, mid.id]));
  });

  test("a single prefers a verified photo over an unverified one even when the unverified is older", () => {
    const unverified = photo();
    const verified = photo({ faceCos: 0.4 });
    const mia = only(planLaunch(input({ avatars: [avatar([unverified, verified])], draft: { videosPerAvatar: 1, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.videos[0]?.photoIds).toEqual([verified.id]);
  });

  test("a collage takes the photos without a stored face match before the verified ones", () => {
    const unverified = [photo({ pdq: randomPdq(rng(1)) }), photo({ pdq: randomPdq(rng(2)) })];
    const verified = [0.9, 0.8, 0.7].map((faceCos, i) => photo({ faceCos, pdq: randomPdq(rng(10 + i)) }));
    for (let seed = 1; seed <= 20; seed++) {
      const mia = only(planLaunch(input({ avatars: [avatar([...verified, ...unverified])], draft: { videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 }, planSeed: seed } })));
      const ids = mia.videos[0]?.photoIds ?? [];
      for (const u of unverified) expect(ids).toContain(u.id);
    }
  });
});

describe("planLaunch: blocked avatars and the 100-photo limit (A17)", () => {
  test("usage that cannot be trusted gives 0 library photos and blocks the avatar", () => {
    const mia = only(
      planLaunch(input({ avatars: [avatar(distinctPhotos(30), { usage: { state: "unknown", reasons: ["index-stale"] } })] })),
    );
    expect(mia.free).toBe(0);
    expect(mia.fromLibrary).toBe(0);
    expect(mia.blocked).toBe("usage-unknown");
    expect(mia.usage).toEqual({ state: "unknown", reasons: ["index-stale"] });
  });

  test("unreadable usage does not matter while the library is off: nothing is read from it", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([], { usage: { state: "unknown", reasons: ["index-stale"] } })], draft: { library: false } })));
    expect(mia.blocked).toBeNull();
  });

  test("a blocked avatar is left out of the totals", () => {
    const plan = planLaunch(
      input({ avatars: [avatar([], { avatarId: "a" }), avatar([], { avatarId: "b", usage: { state: "unknown", reasons: ["rejects-unreadable"] } })], draft: { videosPerAvatar: 3 } }),
    );
    expect(plan.totals.videos).toBe(3);
    expect(plan.totals.toGenerate).toBe(plan.avatars[0]?.toGenerate ?? -1);
  });

  test("totals add up the avatars that are not blocked, and photosNeeded is the library's and the new ones", () => {
    const plan = planLaunch(input({ avatars: [avatar(distinctPhotos(6), { avatarId: "a" }), avatar([], { avatarId: "b" })], draft: { videosPerAvatar: 4 } }));
    expect(plan.totals.photosNeeded).toBe(plan.totals.fromLibrary + plan.totals.toGenerate);
    expect(plan.totals.videos).toBe(8);
  });

  test("an open set blocks an avatar whose plan needs new photos", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([], { hasOpenSet: true })] })));
    expect(mia.blocked).toBe("open-set");
  });

  test("an open set does not block an avatar whose plan needs no new photo", () => {
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(3), { hasOpenSet: true })], draft: { videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.blocked).toBeNull();
  });

  test("a plan that needs exactly 100 new photos is not blocked", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 20, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.toGenerate).toBe(100);
    expect(mia.blocked).toBeNull();
  });

  test("a plan that needs 101 or more new photos is blocked as too-many-photos", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 21, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.toGenerate).toBe(105);
    expect(mia.blocked).toBe("too-many-photos");
  });

  test("a plan that needs exactly 101 new photos (20 slides and 1 single) is blocked as too-many-photos", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 21, mix: { single: 5, collage: 0, slides: 95 } } })));
    expect(mia.shapes).toEqual({ single: 1, collage: 0, slides: 20 });
    expect(mia.toGenerate).toBe(101);
    expect(mia.blocked).toBe("too-many-photos");
  });

  test("with an open set and more than 100 new photos needed, the limit is the reported reason", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([], { hasOpenSet: true })], draft: { videosPerAvatar: 21, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.blocked).toBe("too-many-photos");
  });

  test("with unreadable usage and more than 100 new photos needed, the usage is the reported reason", () => {
    const usage: PlanAvatarInput["usage"] = { state: "unknown", reasons: ["index-stale"] };
    const mia = only(planLaunch(input({ avatars: [avatar([], { usage, hasOpenSet: true })], draft: { videosPerAvatar: 21, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.toGenerate).toBeGreaterThan(100);
    expect(mia.blocked).toBe("usage-unknown");
  });

  test("a library that covers part of the need brings the plan under 100", () => {
    // 40 photos fill at least 5 of the 21 slides videos (at most 7 each), so at most 16 videos of 5 new photos are left.
    const mia = only(planLaunch(input({ avatars: [avatar(distinctPhotos(40))], draft: { videosPerAvatar: 21, mix: { single: 0, collage: 0, slides: 100 } } })));
    expect(mia.fromLibrary).toBeGreaterThanOrEqual(25);
    expect(mia.toGenerate).toBe(5 * mia.videos.filter((v) => v.source === "generated").length);
    expect(mia.toGenerate).toBeLessThanOrEqual(80);
    expect(mia.blocked).toBeNull();
  });
});

describe("planLaunch: determinism", () => {
  const photos = [...distinctPhotos(25, { category: "home" }, 51), ...distinctPhotos(25, { category: "travel" }, 52)];
  const run = (seed: number) => planLaunch(input({ avatars: [avatar(photos)], draft: { categories: ["home", "travel"], videosPerAvatar: 12, planSeed: seed } }));

  test("the same input and seed give the same plan", () => {
    expect(run(42)).toEqual(run(42));
  });

  test("the same input and seed give the same plan on a second call with the photos listed in another order", () => {
    const reversed = planLaunch(input({ avatars: [avatar([...photos].reverse())], draft: { categories: ["home", "travel"], videosPerAvatar: 12, planSeed: 42 } }));
    expect(reversed).toEqual(run(42));
  });

  test("other seeds draw other videos", () => {
    const plans = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(run(i + 1))));
    expect(plans.size).toBeGreaterThan(6);
  });
});

describe("planLaunch: A7, no photo is picked that the launch must not touch (property)", () => {
  const CHOSEN: CategoryRef[] = ["home", "travel", "cat-sunsets-on-roofs"];
  const POOL_CATEGORIES: (string | undefined)[] = [...CHOSEN, "glam", "fit", "own", "cat-deleted-category", undefined];

  test("over 250 random libraries, no picked photo is rejected, used, reserved, held by a draft, of another avatar, outside the categories or in two videos", () => {
    let pickedInTotal = 0;
    for (let round = 1; round <= 250; round++) {
      const next = rng(round * 7919);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      const avatarIds = ["a", "b", "c"].slice(0, 1 + Math.floor(next() * 3));
      const held = new Set<string>();
      const all = new Map<string, { photo: PlanPhoto; owner: string }>();
      const avatars: PlanAvatarInput[] = avatarIds.map((avatarId) => {
        const photos = Array.from({ length: Math.floor(next() * 30) }, () => {
          const misfiled = next() < 0.1;
          const p = photo({
            avatarId: misfiled ? "elsewhere" : avatarId,
            category: pick(POOL_CATEGORIES),
            pdq: next() < 0.2 ? undefined : randomPdq(next),
            faceCos: next() < 0.5 ? undefined : next(),
            eligible: next() > 0.12,
            rejected: next() < 0.12,
            reserved: next() < 0.12,
            usedIn: next() < 0.12 ? ["video-1"] : [],
          });
          if (next() < 0.12) held.add(p.id);
          all.set(p.id, { photo: p, owner: avatarId });
          return p;
        });
        return avatar(photos, { avatarId });
      });
      const mixRoll = pick([{ single: 70, collage: 20, slides: 10 }, { single: 0, collage: 50, slides: 50 }, { single: 100, collage: 0, slides: 0 }, { single: 10, collage: 10, slides: 80 }]);
      const categories = CHOSEN.slice(0, 1 + Math.floor(next() * 3));
      const plan = planLaunch(input({ avatars, held: [...held], draft: { categories, videosPerAvatar: 1 + Math.floor(next() * 14), mix: mixRoll, planSeed: round } }));
      const taken = new Set<string>();
      for (const avatarPlan of plan.avatars) {
        for (const video of avatarPlan.videos.filter((v) => v.source === "library")) {
          for (const id of video.photoIds) {
            const entry = all.get(id);
            if (entry === undefined) throw new Error(`round ${round}: picked a photo that does not exist: ${id}`);
            const { photo: p, owner } = entry;
            expect(taken.has(id)).toBe(false);
            taken.add(id);
            pickedInTotal += 1;
            expect(owner).toBe(avatarPlan.avatarId);
            expect(p.avatarId).toBe(avatarPlan.avatarId);
            expect(p.eligible).toBe(true);
            expect(p.rejected).toBe(false);
            expect(p.reserved).toBe(false);
            expect(p.usedIn).toEqual([]);
            expect(held.has(id)).toBe(false);
            expect(p.category).toBe(video.category);
            expect(categories).toContain(video.category);
          }
          const hashes = video.photoIds.map((id) => all.get(id)?.photo.pdq).filter((h): h is string => h !== undefined);
          for (let i = 0; i < hashes.length; i++) for (let j = i + 1; j < hashes.length; j++) expect(hammingDistance(hexToBytes(hashes[i] ?? ""), hexToBytes(hashes[j] ?? ""))).toBeGreaterThan(20);
        }
      }
    }
    // The property is not vacuous: the random libraries do give the planner photos to pick.
    expect(pickedInTotal).toBeGreaterThan(500);
  });

  test("a library video's category is one the draft chose", () => {
    const photos = [...distinctPhotos(10, { category: "glam" }, 61), ...distinctPhotos(10, { category: "home" }, 62)];
    const mia = only(planLaunch(input({ avatars: [avatar(photos)], draft: { categories: ["home"], videosPerAvatar: 5, mix: { single: 100, collage: 0, slides: 0 } } })));
    const glam = new Set(photos.filter((p) => p.category === "glam").map((p) => p.id));
    expect(mia.videos.flatMap((v) => v.photoIds).some((id) => glam.has(id))).toBe(false);
  });

  test("each filter alone removes its photo: rejected, used, reserved, ineligible, draft-held, misfiled, imported", () => {
    const good = photo();
    const bad = [
      photo({ rejected: true }),
      photo({ usedIn: ["v1"] }),
      photo({ reserved: true }),
      photo({ eligible: false }),
      photo({ avatarId: "someone-else" }),
      photo({ category: undefined }),
      photo({ category: "own" }),
      photo({ category: "glam" }),
    ];
    const held = photo();
    const mia = only(planLaunch(input({ avatars: [avatar([good, held, ...bad])], held: [held.id], draft: { videosPerAvatar: 9, mix: { single: 100, collage: 0, slides: 0 } } })));
    expect(mia.free).toBe(1);
    expect(mia.videos.filter((v) => v.source === "library").flatMap((v) => v.photoIds)).toEqual([good.id]);
  });
});

describe("planLaunch: input faults", () => {
  test("a draft avatar with no input throws, so a missing avatar can never plan from nothing", () => {
    const base = input({ avatars: [avatar([])] });
    expect(() => planLaunch({ ...base, draft: draft({ avatarIds: ["mia", "ghost"] }) })).toThrow(/ghost/);
  });

  test("the plan keeps the draft's avatar order", () => {
    const plan = planLaunch(input({ avatars: [avatar([], { avatarId: "z" }), avatar([], { avatarId: "a" })] }));
    expect(plan.avatars.map((a) => a.avatarId)).toEqual(["z", "a"]);
  });

  test("every shape name is planned for with a size inside its range", () => {
    const mia = only(planLaunch(input({ avatars: [avatar([])], draft: { videosPerAvatar: 50, mix: { single: 34, collage: 33, slides: 33 } } })));
    for (const shape of SHAPES) expect(mia.videos.filter((v) => v.shape === shape).every((v) => shapeSizeFits(v.shape, v.size))).toBe(true);
  });
});
