import { describe, expect, test } from "bun:test";
import type { VideoShape } from "../../shared/engine/autopilot";
import type { CategoryRef } from "../../shared/engine/categories";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assignGenerated, type PlannedVideo } from "./planner";
import { distinctPhotos, flipBits, photo, randomPdq, rng } from "./testing/planFixtures";
useNativeGlobals();

// S4.3 (plan §5.4, §6.4): the photos of a slice arrive, and the avatar's generated videos take them by category and key; where there are too few the video
// degrades (slides 5 to collage 4, collage 3 to 2), a single without a photo is dropped, and the highest keys go first.

const SIZES: Record<VideoShape, number> = { single: 1, collage: 3, slides: 5 };
const video = (key: string, shape: VideoShape, category: CategoryRef = "home", size: number = SIZES[shape]): PlannedVideo => ({ key, shape, size, source: "generated", category, photoIds: [] });
const byKey = (videos: readonly PlannedVideo[], key: string): PlannedVideo => {
  const found = videos.find((v) => v.key === key);
  if (found === undefined) throw new Error(`no video ${key}`);
  return found;
};

describe("assignGenerated: enough photos", () => {
  test("every video gets exactly its size, in key order, with nothing degraded", () => {
    const photos = distinctPhotos(9);
    const out = assignGenerated([video("0-1", "slides"), video("0-2", "collage"), video("0-3", "single")], photos);
    expect(out.videos.map((v) => v.photoIds.length)).toEqual([5, 3, 1]);
    expect(out.changes).toEqual([]);
    expect(out.dropped).toEqual([]);
    expect(out.missingPhotos).toBe(0);
  });

  test("videos are filled in key order, not the order they are given", () => {
    const photos = distinctPhotos(2);
    const out = assignGenerated([video("0-10", "single"), video("0-2", "single")], photos);
    expect(byKey(out.videos, "0-2").photoIds).toHaveLength(1);
    expect(byKey(out.videos, "0-10").photoIds).toHaveLength(1);
    expect(out.videos.map((v) => v.key)).toEqual(["0-2", "0-10"]);
  });

  test("leftover photos are not assigned", () => {
    const out = assignGenerated([video("0-1", "single")], distinctPhotos(4));
    expect(out.videos[0]?.photoIds).toHaveLength(1);
  });

  test("no photo goes into two videos", () => {
    const out = assignGenerated([video("0-1", "slides"), video("0-2", "slides"), video("0-3", "collage")], distinctPhotos(13));
    const ids = out.videos.flatMap((v) => v.photoIds);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("assignGenerated: categories", () => {
  test("a video takes only photos of its own category", () => {
    const home = distinctPhotos(5, { category: "home" }, 1);
    const travel = distinctPhotos(3, { category: "travel" }, 2);
    const out = assignGenerated([video("0-1", "slides", "home"), video("0-2", "collage", "travel")], [...home, ...travel]);
    expect(new Set(byKey(out.videos, "0-1").photoIds)).toEqual(new Set(home.map((p) => p.id)));
    expect(new Set(byKey(out.videos, "0-2").photoIds)).toEqual(new Set(travel.map((p) => p.id)));
  });

  test("a category short of photos does not borrow from another", () => {
    const out = assignGenerated([video("0-1", "collage", "home")], distinctPhotos(6, { category: "travel" }));
    expect(out.videos).toEqual([]);
    expect(out.dropped.map((d) => d.key)).toEqual(["0-1"]);
  });

  test("a photo of another avatar's category-less import is never taken", () => {
    const out = assignGenerated([video("0-1", "single")], [photo({ category: undefined })]);
    expect(out.dropped).toHaveLength(1);
  });
});

describe("assignGenerated: the degrade table (§6.4)", () => {
  test("slides of 5 with 4 photos become a collage of 4", () => {
    const out = assignGenerated([video("0-1", "slides")], distinctPhotos(4));
    expect(out.videos[0]).toMatchObject({ key: "0-1", shape: "collage", size: 4 });
    expect(out.videos[0]?.photoIds).toHaveLength(4);
    expect(out.changes).toEqual([{ key: "0-1", from: { shape: "slides", size: 5 }, to: { shape: "collage", size: 4 } }]);
    expect(out.missingPhotos).toBe(1);
  });

  test("slides of 5 with 3 photos become a collage of 3", () => {
    const out = assignGenerated([video("0-1", "slides")], distinctPhotos(3));
    expect(out.videos[0]).toMatchObject({ shape: "collage", size: 3 });
  });

  test("slides of 5 with 2 photos become a collage of 2", () => {
    const out = assignGenerated([video("0-1", "slides")], distinctPhotos(2));
    expect(out.videos[0]).toMatchObject({ shape: "collage", size: 2 });
    expect(out.missingPhotos).toBe(3);
  });

  test("slides of 5 with 1 photo are dropped and the photo stays free", () => {
    const out = assignGenerated([video("0-1", "slides")], distinctPhotos(1));
    expect(out.videos).toEqual([]);
    expect(out.dropped).toEqual([{ key: "0-1", shape: "slides", reason: "not-enough-photos" }]);
    expect(out.missingPhotos).toBe(5);
  });

  test("a collage of 3 with 2 photos becomes a collage of 2", () => {
    const out = assignGenerated([video("0-1", "collage")], distinctPhotos(2));
    expect(out.videos[0]).toMatchObject({ shape: "collage", size: 2 });
    expect(out.changes).toEqual([{ key: "0-1", from: { shape: "collage", size: 3 }, to: { shape: "collage", size: 2 } }]);
    expect(out.missingPhotos).toBe(1);
  });

  test("a collage of 3 with 1 photo is dropped", () => {
    const out = assignGenerated([video("0-1", "collage")], distinctPhotos(1));
    expect(out.dropped.map((d) => d.key)).toEqual(["0-1"]);
  });

  test("a single with no photo is dropped", () => {
    const out = assignGenerated([video("0-1", "single")], []);
    expect(out.dropped).toEqual([{ key: "0-1", shape: "single", reason: "not-enough-photos" }]);
    expect(out.missingPhotos).toBe(1);
  });

  test("when photos run out across videos the highest keys are shrunk or dropped, never the lowest", () => {
    const out = assignGenerated([video("0-1", "single"), video("0-2", "single"), video("0-3", "single"), video("0-4", "single")], distinctPhotos(2));
    expect(out.videos.map((v) => v.key)).toEqual(["0-1", "0-2"]);
    expect(out.dropped.map((d) => d.key)).toEqual(["0-3", "0-4"]);
  });

  test("the lowest key keeps its full size and the next one takes what is left", () => {
    const out = assignGenerated([video("0-1", "slides"), video("0-2", "slides")], distinctPhotos(8));
    expect(byKey(out.videos, "0-1")).toMatchObject({ shape: "slides", size: 5 });
    expect(byKey(out.videos, "0-2")).toMatchObject({ shape: "collage", size: 3 });
  });

  test("the keys 0-2 and 0-10 are ordered as numbers, so 0-10 degrades before 0-2", () => {
    const out = assignGenerated([video("0-10", "single"), video("0-2", "single")], distinctPhotos(1));
    expect(out.videos.map((v) => v.key)).toEqual(["0-2"]);
    expect(out.dropped.map((d) => d.key)).toEqual(["0-10"]);
  });

  test("a degraded video keeps its source, category and key", () => {
    const out = assignGenerated([video("0-1", "slides", "glam")], distinctPhotos(4, { category: "glam" }));
    expect(out.videos[0]).toMatchObject({ key: "0-1", source: "generated", category: "glam" });
  });

  test("no videos and no photos give an empty result", () => {
    expect(assignGenerated([], [])).toEqual({ videos: [], dropped: [], changes: [], missingPhotos: 0 });
  });
});

describe("assignGenerated: PDQ and faces", () => {
  const base = randomPdq(rng(5));

  test("a near-duplicate pair counts once, so 5 photos with one pair make slides of 5 impossible", () => {
    const four = distinctPhotos(4, {}, 71);
    const dup = photo({ pdq: flipBits(four[0]?.pdq ?? base, 4) });
    const out = assignGenerated([video("0-1", "slides")], [...four, dup]);
    expect(out.videos[0]).toMatchObject({ shape: "collage", size: 4 });
  });

  test("photos at distance 21 are distinct and both fit one collage", () => {
    const out = assignGenerated([video("0-1", "collage", "home", 2)], [photo({ pdq: base }), photo({ pdq: flipBits(base, 21) })]);
    expect(out.videos[0]?.photoIds).toHaveLength(2);
  });

  test("photos at distance 20 are near-duplicates and cannot share a collage", () => {
    const out = assignGenerated([video("0-1", "collage", "home", 2)], [photo({ pdq: base }), photo({ pdq: flipBits(base, 20) })]);
    expect(out.dropped.map((d) => d.key)).toEqual(["0-1"]);
  });

  test("a near-duplicate left out of one video may go into another", () => {
    const a = photo({ pdq: base });
    const b = photo({ pdq: flipBits(base, 2) });
    const out = assignGenerated([video("0-1", "single"), video("0-2", "single")], [a, b]);
    expect(out.videos).toHaveLength(2);
  });

  test("singles take the highest stored face match first", () => {
    const low = photo({ faceCos: 0.3 });
    const high = photo({ faceCos: 0.9 });
    const none = photo();
    const out = assignGenerated([video("0-1", "single")], [none, low, high]);
    expect(out.videos[0]?.photoIds).toEqual([high.id]);
  });

  test("the same input gives the same assignment", () => {
    const photos = distinctPhotos(11);
    const videos = [video("0-1", "slides"), video("0-2", "collage"), video("0-3", "single"), video("0-4", "slides")];
    expect(assignGenerated(videos, photos)).toEqual(assignGenerated(videos, [...photos].reverse()));
  });
});

describe("assignGenerated: the state of the arrived photos (A7, after review removals)", () => {
  test("a rejected photo is never put into a video", () => {
    const out = assignGenerated([video("0-1", "single")], [photo({ rejected: true })]);
    expect(out.videos).toEqual([]);
    expect(out.dropped.map((d) => d.key)).toEqual(["0-1"]);
  });

  test("a photo the library no longer calls eligible is never put into a video", () => {
    const out = assignGenerated([video("0-1", "single")], [photo({ eligible: false })]);
    expect(out.videos).toEqual([]);
  });

  test("a photo already used in a video record is never put into a video", () => {
    const out = assignGenerated([video("0-1", "single")], [photo({ usedIn: ["video-00000001"] })]);
    expect(out.videos).toEqual([]);
  });

  test("a reserved photo is still used: the launch's own photos can be reserved by its renders", () => {
    const own = photo({ reserved: true });
    const out = assignGenerated([video("0-1", "single")], [own]);
    expect(out.videos[0]?.photoIds).toEqual([own.id]);
  });

  test("the rest of the list is used when the owner rejected one of the arrived photos", () => {
    const all = distinctPhotos(5);
    const first = all[0];
    if (first === undefined) throw new Error("no photo");
    const rejected = { ...first, rejected: true };
    const out = assignGenerated([video("0-1", "slides")], [rejected, ...all.slice(1)]);
    expect(out.videos[0]).toMatchObject({ shape: "collage", size: 4 });
    expect(out.videos[0]?.photoIds).not.toContain(rejected.id);
  });

  test("over 200 random lists, no rejected, ineligible or used photo is picked, and none is picked twice", () => {
    let picked = 0;
    const shapes: VideoShape[] = ["single", "collage", "slides"];
    const cats: CategoryRef[] = ["home", "travel"];
    for (let round = 1; round <= 200; round++) {
      const next = rng(round * 104729);
      const photos = Array.from({ length: Math.floor(next() * 25) }, () =>
        photo({
          category: next() < 0.1 ? "glam" : next() < 0.5 ? "home" : "travel",
          pdq: next() < 0.2 ? undefined : randomPdq(next),
          faceCos: next() < 0.5 ? undefined : next(),
          eligible: next() > 0.15,
          rejected: next() < 0.15,
          reserved: next() < 0.3,
          usedIn: next() < 0.15 ? ["video-1"] : [],
        }),
      );
      const videos = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, i) => video(`0-${i + 1}`, shapes[Math.floor(next() * 3)] ?? "single", cats[Math.floor(next() * 2)]));
      const out = assignGenerated(videos, photos);
      const byId = new Map(photos.map((p) => [p.id, p]));
      const seen = new Set<string>();
      for (const v of out.videos) {
        for (const id of v.photoIds) {
          const p = byId.get(id);
          if (p === undefined) throw new Error(`round ${round}: unknown photo ${id}`);
          expect(seen.has(id)).toBe(false);
          seen.add(id);
          picked += 1;
          expect(p.rejected).toBe(false);
          expect(p.eligible).toBe(true);
          expect(p.usedIn).toEqual([]);
          expect(p.category).toBe(v.category);
        }
      }
    }
    expect(picked).toBeGreaterThan(300);
  });
});
