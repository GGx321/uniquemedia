import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { DraftFolderError } from "../montages/store";
import { readDraftHolds, type DraftHoldsReader } from "./draftHolds";
import { planLaunch } from "./planner";
import { avatar, distinctPhotos, input } from "./testing/planFixtures";
useNativeGlobals();

// S4.6c1 (plan §5.1, §19, A7): ONE definition of «photos held by a saved montage draft», shared by the estimate, the start and the free steps. It is the union over the launch's avatars of
// `DraftStore.photoIdsInDrafts`, and it fails closed PER AVATAR: an avatar whose drafts cannot be listed in full has no library photo in this launch, the others are unaffected.

const reader = (answers: Record<string, { photoIds: string[]; complete: boolean } | Error>): DraftHoldsReader => async (avatarId) => {
  const answer = answers[avatarId];
  if (answer === undefined) return { photoIds: new Set(), complete: true };
  if (answer instanceof Error) throw answer;
  return { photoIds: new Set(answer.photoIds), complete: answer.complete };
};

describe("readDraftHolds", () => {
  test("the held photos of every avatar are united", async () => {
    const holds = await readDraftHolds(["a", "b"], reader({ a: { photoIds: ["p1", "p2"], complete: true }, b: { photoIds: ["p3"], complete: true } }));
    expect([...holds.held].sort()).toEqual(["p1", "p2", "p3"]);
    expect([...holds.unknown]).toEqual([]);
  });

  test("an avatar whose listing is not complete is unknown, and what it did name is still held", async () => {
    const holds = await readDraftHolds(["a", "b"], reader({ a: { photoIds: ["p1"], complete: false }, b: { photoIds: ["p3"], complete: true } }));
    expect([...holds.unknown]).toEqual(["a"]);
    expect([...holds.held].sort()).toEqual(["p1", "p3"]);
  });

  test("a drafts folder that cannot be listed makes that avatar unknown and no other", async () => {
    const holds = await readDraftHolds(["a", "b"], reader({ a: new DraftFolderError("EACCES"), b: { photoIds: ["p3"], complete: true } }));
    expect([...holds.unknown]).toEqual(["a"]);
    expect([...holds.held]).toEqual(["p3"]);
  });

  test("any other failure of the reader also fails closed for that avatar", async () => {
    const holds = await readDraftHolds(["a"], reader({ a: new Error("boom") }));
    expect([...holds.unknown]).toEqual(["a"]);
  });

  test("no avatars hold nothing and know everything", async () => {
    const holds = await readDraftHolds([], reader({}));
    expect(holds.held.size).toBe(0);
    expect(holds.unknown.size).toBe(0);
  });
});

describe("the planner and an avatar whose drafts are unknown (draftsKnown: false)", () => {
  const only = <T>(items: readonly T[]): T => {
    const first = items[0];
    if (first === undefined) throw new Error("expected one item");
    return first;
  };

  test("none of its library photos is taken, though they are free", () => {
    const photos = distinctPhotos(12);
    const plan = planLaunch(input({ avatars: [avatar(photos, { draftsKnown: false })], draft: { videosPerAvatar: 4, mix: { single: 100, collage: 0, slides: 0 }, generate: true } }));
    const mia = only(plan.avatars);
    expect(mia.fromLibrary).toBe(0);
    expect(mia.free).toBe(0);
    expect(mia.toGenerate).toBe(4);
  });

  test("it is not a reason to refuse the launch: the avatar is not blocked", () => {
    const plan = planLaunch(input({ avatars: [avatar(distinctPhotos(6), { draftsKnown: false })], draft: { videosPerAvatar: 2 } }));
    expect(only(plan.avatars).blocked).toBeNull();
  });

  test("another avatar of the same launch, whose drafts are known, still fills from its library", () => {
    const plan = planLaunch(
      input({
        avatars: [avatar(distinctPhotos(6, { avatarId: "a" }), { avatarId: "a", draftsKnown: false }), avatar(distinctPhotos(6, { avatarId: "b" }, 11), { avatarId: "b", draftsKnown: true })],
        draft: { videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } },
      }),
    );
    expect(plan.avatars.map((a) => a.fromLibrary)).toEqual([0, 2]);
  });

  test("with the drafts known the same photos are used (the flag changes nothing else)", () => {
    const photos = distinctPhotos(6);
    const base = { videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } } as const;
    expect(only(planLaunch(input({ avatars: [avatar(photos, { draftsKnown: true })], draft: base })).avatars).fromLibrary).toBe(2);
    // The shared fixtures default to known.
    expect(only(planLaunch(input({ avatars: [avatar(photos)], draft: base })).avatars).fromLibrary).toBe(2);
  });
});
