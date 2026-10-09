import { describe, expect, test } from "bun:test";
import { hammingDistance } from "../../../src/core/pdq/hamming";
import { shapeSizeFits } from "../../shared/engine/autopilot";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assignArrived, assignLibrary, repick, takenPhotos, type AvatarFacts } from "./freeAssign";
import type { FileVideo, LaunchFile } from "./launchFile";
import type { PlanPhoto } from "./planner";
import { A, B, stampedFile } from "./testing/launchFixtures";
import { distinctPhotos, flipBits, photo, randomPdq, rng } from "./testing/planFixtures";
useNativeGlobals();

// S4.6c1 (plan §5.3, §5.4, §6.4, A7): the pure half of the free path. Given the launch file and a FRESH snapshot of each avatar's photos, which photos go into which videos. Nothing here reads a
// library or writes a file; the steps feed it fresh snapshots and apply what it answers.

const facts = (avatarId: string, photos: readonly PlanPhoto[], ready = true): AvatarFacts => ({ avatarId, ready, photos });
const none: ReadonlySet<string> = new Set();
const mine = (n: number, extra: Partial<PlanPhoto> = {}, seed = 3): PlanPhoto[] => distinctPhotos(n, { avatarId: A, ...extra }, seed);

/** A launch file planned against `photos` with the library on: its library videos exist, with no photos in the file yet (they are assigned later, from fresh snapshots). */
const libraryFile = (photos: readonly PlanPhoto[], draft: Partial<Parameters<typeof stampedFile>[0]> = {}): LaunchFile => {
  const base = { library: true, generate: true, videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 } } as const;
  return stampedFile({ ...base, ...draft }, {}, { [A]: photos });
};
const videosOf = (file: LaunchFile, avatarId = A): FileVideo[] => file.avatars.find((a) => a.avatarId === avatarId)?.videos ?? [];
const withVideos = (file: LaunchFile, change: (v: FileVideo) => FileVideo): LaunchFile => ({ ...file, avatars: file.avatars.map((a) => ({ ...a, videos: a.videos.map(change) })) });
const outcomeOf = (result: ReturnType<typeof assignLibrary>, avatarId = A) => {
  const outcome = result.byAvatar.get(avatarId);
  if (outcome === undefined) throw new Error(`no outcome for ${avatarId}`);
  return outcome;
};

describe("assignLibrary: the library videos of the plan get their photos from a fresh snapshot", () => {
  test("each library video gets a free photo of the chosen category and none is shared", () => {
    const photos = mine(5);
    const file = libraryFile(photos);
    const result = assignLibrary(file, new Map([[A, facts(A, photos)]]), none);
    const picks = outcomeOf(result).picks;
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => p.shape === "single" && p.size === 1 && p.photoIds.length === 1)).toBe(true);
    const ids = picks.flatMap((p) => p.photoIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the answer is the planner's own for the same photos (a start and its first assignment agree)", () => {
    const photos = mine(12);
    const file = libraryFile(photos, { videosPerAvatar: 4, mix: { single: 50, collage: 50, slides: 0 } });
    const picks = outcomeOf(assignLibrary(file, new Map([[A, facts(A, photos)]]), none)).picks;
    expect(picks.map((p) => p.key)).toEqual(videosOf(file).map((v) => v.key));
    for (const p of picks) expect(shapeSizeFits(p.shape, p.size)).toBe(true);
  });

  test("a photo used, rejected, reserved or held by a draft is not taken, though the plan counted it", () => {
    const photos = mine(8);
    const file = libraryFile(photos);
    const [used, rejected, reserved, held] = photos;
    const fresh = photos.map((p) => {
      if (p.id === used?.id) return { ...p, usedIn: ["video-00000001"] };
      if (p.id === rejected?.id) return { ...p, rejected: true };
      if (p.id === reserved?.id) return { ...p, reserved: true };
      return p;
    });
    const picked = outcomeOf(assignLibrary(file, new Map([[A, facts(A, fresh)]]), new Set(held === undefined ? [] : [held.id]))).picks.flatMap((p) => p.photoIds);
    for (const bad of [used, rejected, reserved, held]) expect(picked).not.toContain(bad?.id);
    expect(picked).toHaveLength(3);
  });

  test("a photo another video of the launch already holds is not taken again", () => {
    const photos = mine(4);
    const file = libraryFile(photos);
    const [first, ...rest] = videosOf(file);
    const holding = withVideos(file, (v) => (v.key === first?.key ? { ...v, state: "assigned", photoIds: [photos[0]?.id ?? ""] } : v));
    const picks = outcomeOf(assignLibrary(holding, new Map([[A, facts(A, photos)]]), none)).picks;
    expect(picks.map((p) => p.key)).toEqual(rest.map((v) => v.key));
    expect(picks.flatMap((p) => p.photoIds)).not.toContain(photos[0]?.id);
  });

  test("a video the library can no longer fill is dropped for not enough photos, and the missing photos are counted", () => {
    const photos = mine(3);
    const file = libraryFile(photos);
    const fresh = photos.slice(0, 1);
    const outcome = outcomeOf(assignLibrary(file, new Map([[A, facts(A, fresh)]]), none));
    expect(outcome.picks).toHaveLength(1);
    expect(outcome.dropped).toHaveLength(2);
    expect(outcome.missingPhotos).toBe(2);
  });

  test("an avatar whose usage or drafts are not known waits: nothing is picked, nothing is dropped", () => {
    const photos = mine(3);
    const file = libraryFile(photos);
    const result = assignLibrary(file, new Map([[A, facts(A, photos, false)]]), none);
    expect(result.waiting.has(A)).toBe(true);
    expect(result.byAvatar.has(A)).toBe(false);
  });

  test("an avatar with no snapshot at all waits as well", () => {
    const file = libraryFile(mine(3));
    expect(assignLibrary(file, new Map(), none).waiting.has(A)).toBe(true);
  });

  test("only videos still planned are assigned: an assigned, rendering or dropped one is left alone", () => {
    const photos = mine(6);
    const file = libraryFile(photos);
    const states = ["assigned", "rendering", "dropped"] as const;
    const mixed = withVideos(file, (v) => {
      const at = Number(v.key.split("-")[1]) - 1;
      const state = states[at];
      if (state === undefined) return v;
      return state === "dropped" ? { ...v, state, dropReason: "not-enough-photos" as const } : { ...v, state, photoIds: [photos[at]?.id ?? ""] };
    });
    expect(assignLibrary(mixed, new Map([[A, facts(A, photos)]]), none).byAvatar.size).toBe(0);
  });

  test("two avatars never share a photo (the pool is per avatar)", () => {
    const aPhotos = mine(4);
    const bPhotos = distinctPhotos(4, { avatarId: B }, 9);
    const base = { library: true, generate: false, avatarIds: [A, B], videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } };
    const file = stampedFile(base, {}, { [A]: aPhotos, [B]: bPhotos });
    const result = assignLibrary(
      file,
      new Map([
        [A, facts(A, aPhotos)],
        [B, facts(B, bPhotos)],
      ]),
      none,
    );
    const aIds = new Set(outcomeOf(result, A).picks.flatMap((p) => p.photoIds));
    const bIds = new Set(outcomeOf(result, B).picks.flatMap((p) => p.photoIds));
    expect(aIds.size).toBe(2);
    expect(bIds.size).toBe(2);
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
  });

  test("near-duplicates stay apart inside one collage (pdq distance above 20)", () => {
    const next = rng(5);
    const base = randomPdq(next);
    const near = flipBits(base, 5);
    const far = flipBits(base, 60);
    const photos = [photo({ avatarId: A, pdq: base }), photo({ avatarId: A, pdq: near }), photo({ avatarId: A, pdq: far })];
    const file = libraryFile(photos, { videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 } });
    const picks = outcomeOf(assignLibrary(file, new Map([[A, facts(A, photos)]]), none)).picks;
    const chosen = picks.flatMap((p) => p.photoIds).map((id) => photos.find((p) => p.id === id));
    for (const x of chosen) for (const y of chosen) if (x !== y && x?.pdq !== undefined && y?.pdq !== undefined) expect(hammingDistance(Buffer.from(x.pdq, "hex"), Buffer.from(y.pdq, "hex"))).toBeGreaterThan(20);
  });
});

describe("assignArrived: generated photos are assigned as slices arrive", () => {
  const generatedFile = (draft: Partial<Parameters<typeof stampedFile>[0]> = {}): LaunchFile => stampedFile({ library: false, generate: true, videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 }, ...draft });
  const arrived = (photos: readonly PlanPhoto[]): ReadonlySet<string> => new Set(photos.map((p) => p.id));

  test("a photo that arrived goes to the lowest key of its category", () => {
    const file = generatedFile();
    const photos = mine(1);
    const out = assignArrived(file, A, facts(A, photos), none, arrived(photos), false);
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0]?.key).toBe(videosOf(file)[0]?.key);
    expect(out.picks[0]?.photoIds).toEqual([photos[0]?.id ?? ""]);
  });

  test("a photo that did NOT arrive in a slice is not taken, though it is a free library photo", () => {
    const file = generatedFile();
    const stranger = mine(2);
    const out = assignArrived(file, A, facts(A, stranger), none, new Set(), false);
    expect(out.picks).toHaveLength(0);
  });

  test("while the draw goes on, a video the arrived photos cannot fill in full is NOT degraded: it waits", () => {
    const file = generatedFile({ videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 } });
    const photos = mine(2);
    const out = assignArrived(file, A, facts(A, photos), none, arrived(photos), false);
    expect(out.picks).toHaveLength(0);
    expect(out.dropped).toHaveLength(0);
  });

  test("once the draw is over, the same shortage becomes a collage of two (a degrade, §6.4)", () => {
    const file = generatedFile({ videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 } });
    const photos = mine(2);
    const out = assignArrived(file, A, facts(A, photos), none, arrived(photos), true);
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0]).toMatchObject({ shape: "collage", size: 2 });
    expect(out.missingPhotos).toBe(1);
  });

  test("once the draw is over, a video that cannot get even two photos is dropped", () => {
    const file = generatedFile({ videosPerAvatar: 1, mix: { single: 0, collage: 100, slides: 0 } });
    const photos = mine(1);
    const out = assignArrived(file, A, facts(A, photos), none, arrived(photos), true);
    expect(out.dropped).toEqual([videosOf(file)[0]?.key ?? ""]);
    expect(out.picks).toHaveLength(0);
  });

  test("the shortage lands on the highest keys when the draw is over", () => {
    const file = generatedFile({ videosPerAvatar: 3 });
    const photos = mine(2);
    const out = assignArrived(file, A, facts(A, photos), none, arrived(photos), true);
    const keys = videosOf(file).map((v) => v.key);
    expect(out.picks.map((p) => p.key)).toEqual(keys.slice(0, 2));
    expect(out.dropped).toEqual(keys.slice(2));
  });

  test("while the draw goes on, only the videos before the first one that is not full are taken", () => {
    const file = generatedFile({ videosPerAvatar: 3 });
    const photos = mine(2);
    const out = assignArrived(file, A, facts(A, photos), none, arrived(photos), false);
    expect(out.picks.map((p) => p.key)).toEqual(videosOf(file).map((v) => v.key).slice(0, 2));
    expect(out.dropped).toEqual([]);
  });

  test("a photo the owner rejected, used or reserved since it arrived is never put in", () => {
    const file = generatedFile();
    const photos = mine(4);
    const fresh = photos.map((p, i) => (i === 0 ? { ...p, rejected: true } : i === 1 ? { ...p, usedIn: ["video-00000001"] } : i === 2 ? { ...p, reserved: true } : p));
    const out = assignArrived(file, A, facts(A, fresh), none, arrived(photos), true);
    expect(out.picks.flatMap((p) => p.photoIds)).toEqual([photos[3]?.id ?? ""]);
  });

  test("a photo held by a saved draft is not put in", () => {
    const file = generatedFile();
    const photos = mine(2);
    const out = assignArrived(file, A, facts(A, photos), new Set([photos[0]?.id ?? ""]), arrived(photos), true);
    expect(out.picks.flatMap((p) => p.photoIds)).toEqual([photos[1]?.id ?? ""]);
  });

  test("a photo another video of the launch holds is not put in a second video", () => {
    const file = generatedFile();
    const photos = mine(2);
    const [first] = videosOf(file);
    const holding = withVideos(file, (v) => (v.key === first?.key ? { ...v, state: "assigned", photoIds: [photos[0]?.id ?? ""] } : v));
    const out = assignArrived(holding, A, facts(A, photos), none, arrived(photos), true);
    expect(out.picks.flatMap((p) => p.photoIds)).toEqual([photos[1]?.id ?? ""]);
  });

  test("an avatar that is not ready (usage or drafts unknown) gets nothing assigned", () => {
    const file = generatedFile();
    const photos = mine(2);
    const out = assignArrived(file, A, facts(A, photos, false), none, arrived(photos), true);
    expect(out).toEqual({ picks: [], dropped: [], missingPhotos: 0 });
  });
});

describe("repick: a video whose photo was taken meanwhile", () => {
  test("takes another free photo of the same category, leaving the video's key and shape", () => {
    const photos = mine(4);
    const file = libraryFile(photos, { videosPerAvatar: 1 });
    const [video] = videosOf(file);
    const taken = withVideos(file, (v) => ({ ...v, state: "rendering", photoIds: [photos[0]?.id ?? ""] }));
    const fresh = photos.map((p, i) => (i === 0 ? { ...p, usedIn: ["video-00000001"] } : p));
    const out = repick(taken, A, video?.key ?? "", facts(A, fresh), none);
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0]?.key).toBe(video?.key);
    expect(out.picks[0]?.photoIds).not.toContain(photos[0]?.id);
  });

  test("never takes a photo another video of the launch holds", () => {
    const photos = mine(2);
    const file = libraryFile(photos, { videosPerAvatar: 2 });
    const [one, two] = videosOf(file);
    const state = withVideos(file, (v) => (v.key === one?.key ? { ...v, state: "rendering", photoIds: [photos[0]?.id ?? ""] } : { ...v, state: "assigned", photoIds: [photos[1]?.id ?? ""] }));
    const fresh = photos.map((p, i) => (i === 0 ? { ...p, usedIn: ["video-00000001"] } : p));
    const out = repick(state, A, one?.key ?? "", facts(A, fresh), none);
    expect(out.picks).toHaveLength(0);
    expect(out.dropped).toEqual([one?.key ?? ""]);
    expect(two?.key).toBeDefined();
  });

  test("keeps a photo of its own that is still free (its own photos are not «taken by another video»)", () => {
    const photos = mine(1);
    const file = libraryFile(photos, { videosPerAvatar: 1 });
    const [video] = videosOf(file);
    const own = withVideos(file, (v) => ({ ...v, state: "rendering", photoIds: [photos[0]?.id ?? ""] }));
    const out = repick(own, A, video?.key ?? "", facts(A, photos), none);
    expect(out.picks[0]?.photoIds).toEqual([photos[0]?.id ?? ""]);
  });

  test("with no free photo left the video is dropped", () => {
    const photos = mine(1);
    const file = libraryFile(photos, { videosPerAvatar: 1 });
    const [video] = videosOf(file);
    const taken = withVideos(file, (v) => ({ ...v, state: "rendering", photoIds: [photos[0]?.id ?? ""] }));
    const out = repick(taken, A, video?.key ?? "", facts(A, photos.map((p) => ({ ...p, usedIn: ["video-00000001"] }))), none);
    expect(out.dropped).toEqual([video?.key ?? ""]);
  });
});

describe("takenPhotos", () => {
  test("lists the photos of the videos that hold them, not a dropped video's", () => {
    const photos = mine(3);
    const file = libraryFile(photos);
    const [a, b, c] = videosOf(file);
    const state = withVideos(file, (v) => {
      if (v.key === a?.key) return { ...v, state: "assigned", photoIds: ["photo-aaaaaaaa"] };
      if (v.key === b?.key) return { ...v, state: "dropped", dropReason: "render-failed", photoIds: ["photo-bbbbbbbb"] };
      return v;
    });
    expect([...takenPhotos(videosOf(state))]).toEqual(["photo-aaaaaaaa"]);
    expect(c?.key).toBeDefined();
  });

  test("leaves out the video it is asked to leave out", () => {
    const file = libraryFile(mine(1), { videosPerAvatar: 1 });
    const [only] = videosOf(file);
    const state = withVideos(file, (v) => ({ ...v, state: "assigned", photoIds: ["photo-aaaaaaaa"] }));
    expect(takenPhotos(videosOf(state), only?.key).size).toBe(0);
  });
});
