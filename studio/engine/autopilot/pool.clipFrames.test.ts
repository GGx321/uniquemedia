import { describe, expect, test } from "bun:test";
import { Montage } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { DraftStore } from "../montages/store";
import { writeVideoRecord, sceneSpec } from "../library/testing/videoRecords";
import { useWorld, type World } from "../videos/testing/kit";
import { readDraftHolds } from "./draftHolds";
import { planAvatarInput } from "./libraryInput";
import { poolOf } from "./planner";
import { draft } from "./testing/planFixtures";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, Q-F = 1): a photo whose clip is in a finished video or in a saved draft is not free for the autopilot's picks. The pool is one definition (`poolOf`): eligible, not rejected, not
// used, not reserved, not held by a draft. The library's used index (frames) and `photoIdsInDrafts` feed it, so the autopilot needs no rule of its own.

const world = useWorld();
const launch = draft({ categories: ["home", "travel", "fit"] });
const photoOf = (w: World, i: number): string => w.photos[i]?.id ?? "";

/** The world's third photo is in a category that is no category of a launch: it is read as «fit» so that all three can be in the pool. */
function inputOf(w: World, library: Parameters<typeof planAvatarInput>[0] = w.library, draftsKnown = true) {
  const avatar = planAvatarInput(library, w.avatar.id, false, draftsKnown);
  return { ...avatar, photos: avatar.photos.map((p) => (p.id === photoOf(w, 2) ? { ...p, category: "fit" } : p)) };
}

function poolIds(w: World, held: ReadonlySet<string> = new Set(), draftsKnown = true): string[] {
  return poolOf(inputOf(w, w.library, draftsKnown), { draft: launch, draftHeldPhotoIds: held }).map((p) => p.id).sort();
}

describe("the autopilot's pool and a clip's photo", () => {
  test("a photo whose clip is in a finished video is not free", async () => {
    const w = world();
    expect(poolIds(w)).toEqual([photoOf(w, 0), photoOf(w, 1), photoOf(w, 2)].sort());

    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [{ mediaId: "media-copy-0001", clipId: "clip-0000001", photoId: photoOf(w, 1) }] });
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(poolIds(w)).toEqual([photoOf(w, 2)]);
  });

  test("and it stays not free when the clip, its copy and its avatar's copies are long gone (the record has the frame)", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [{ mediaId: "media-copy-0001", clipId: "clip-0000001", photoId: photoOf(w, 1) }] });
    const reopened = await w.reopen();
    expect(poolOf(inputOf(w, reopened), { draft: launch, draftHeldPhotoIds: new Set() }).map((p) => p.id)).toEqual([photoOf(w, 2)]);
  });

  test("a photo whose clip a saved draft holds is not free, and a draft with a deleted copy frees it with the avatar still known", async () => {
    const w = world();
    const store = new DraftStore({ log: () => undefined });
    const base = defaultSpec(w.avatar.id, [photoOf(w, 0)], 7);
    const video = { clipId: "clip-90000000", kind: "video" as const, mediaId: "media-copy-0001", trimStartMs: 0, focus: null, durationMs: 2000, transitionIn: "cut" as const };
    await store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: { ...base, clips: [...base.clips, video] }, updatedAt: "2026-10-09T10:00:00.000Z" }));
    const present = async () => ({ readable: true, origins: new Map([["media-copy-0001", { clipId: "clip-0000001", photoId: photoOf(w, 1) }]]) });
    const deleted = async () => ({ readable: true, origins: new Map<string, { clipId: string; photoId: string }>() });

    const holding = await readDraftHolds([w.avatar.id], (id) => store.photoIdsInDrafts(w.library, id, present));
    expect(poolIds(w, holding.held)).toEqual([photoOf(w, 2)]);

    const freed = await readDraftHolds([w.avatar.id], (id) => store.photoIdsInDrafts(w.library, id, deleted));
    expect([...freed.unknown]).toEqual([]);
    expect(poolIds(w, freed.held)).toEqual([photoOf(w, 1), photoOf(w, 2)].sort());
  });

  test("an avatar whose media list cannot be read has no library photo in a launch (fails closed per avatar)", async () => {
    const w = world();
    const store = new DraftStore({ log: () => undefined });
    const base = defaultSpec(w.avatar.id, [photoOf(w, 0)], 7);
    const video = { clipId: "clip-90000000", kind: "video" as const, mediaId: "media-copy-0001", trimStartMs: 0, focus: null, durationMs: 2000, transitionIn: "cut" as const };
    await store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: { ...base, clips: [...base.clips, video] }, updatedAt: "2026-10-09T10:00:00.000Z" }));

    const holds = await readDraftHolds([w.avatar.id], (id) => store.photoIdsInDrafts(w.library, id, async () => ({ readable: false, origins: new Map() })));

    expect([...holds.unknown]).toEqual([w.avatar.id]);
    expect(poolIds(w, holds.held, !holds.unknown.has(w.avatar.id))).toEqual([]);
  });
});
