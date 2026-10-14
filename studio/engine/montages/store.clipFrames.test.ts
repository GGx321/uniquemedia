import { describe, expect, test } from "bun:test";
import { Montage } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { readDraftHolds } from "../autopilot/draftHolds";
import { openLibrary, type Library } from "../library";
import { SAMPLE_AVATAR, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { DraftStore } from "./store";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, r2.1 N1): a draft that holds a clip's copy holds the clip's photo, for the autopilot's picks (`photoIdsInDrafts`). A draft has no snapshot, so the copy's origin is read from the
// media list. A COPY WHOSE SUMMARY IS MISSING holds no frame, and the answer stays complete (such a draft cannot render that copy, and media ids are never reused): one ordinary delete must not blind the
// autopilot for the whole avatar. `complete: false` is for a media list that cannot be read, because `readDraftHolds` fails closed per avatar.

const root = useTempDir("studio-draft-clip-frames-");
const store = (): DraftStore => new DraftStore({ log: () => undefined });
const P_CLIP = "photo-0000009";

async function open(): Promise<{ library: Library; avatarId: string }> {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  return { library, avatarId: (await library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" })).id };
}

/** A draft of scene photos and then one video clip per media id. */
function draftWith(avatarId: string, montageId: string, photoIds: readonly string[], mediaIds: readonly string[]): Montage {
  const base = defaultSpec(avatarId, photoIds, 7);
  const videos = mediaIds.map((mediaId, i) => ({ clipId: `clip-9000000${i}`, kind: "video" as const, mediaId, trimStartMs: 0, focus: null, durationMs: 2000, transitionIn: "cut" as const }));
  return Montage.parse({ montageId, name: null, spec: { ...base, clips: [...base.clips, ...videos] }, updatedAt: "2026-10-09T10:00:00.000Z" });
}

type Read = NonNullable<Parameters<DraftStore["photoIdsInDrafts"]>[2]>;
const copies = (origins: Record<string, string>, readable = true): Read => async () => ({ readable, origins: new Map(Object.entries(origins).map(([mediaId, photoId]) => [mediaId, { clipId: "clip-0000001", photoId }])) });

describe("photoIdsInDrafts with a draft that holds a clip's copy", () => {
  test("holds the clip's photo with the scene photos, and the answer is complete", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001"]));

    const answer = await s.photoIdsInDrafts(library, avatarId, copies({ "media-copy-0001": P_CLIP }));

    expect([...answer.photoIds].sort()).toEqual(["photo-0000001", P_CLIP].sort());
    expect(answer.complete).toBe(true);
  });

  test("a draft with a deleted copy holds no frame for it: the photo is free, and the answer is still complete (r2.1 N1)", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001"]));

    const answer = await s.photoIdsInDrafts(library, avatarId, copies({}));

    expect([...answer.photoIds]).toEqual(["photo-0000001"]);
    expect(answer.complete).toBe(true);
  });

  test("so the autopilot's reader does not put the avatar in unknown", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001"]));

    const holds = await readDraftHolds([avatarId], (id) => s.photoIdsInDrafts(library, id, copies({})));

    expect([...holds.unknown]).toEqual([]);
    expect(holds.held.has(P_CLIP)).toBe(false);
    expect(holds.held.has("photo-0000001")).toBe(true);
  });

  test("and a draft whose copy is there keeps the clip's photo out of a launch", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001"]));

    const holds = await readDraftHolds([avatarId], (id) => s.photoIdsInDrafts(library, id, copies({ "media-copy-0001": P_CLIP })));

    expect(holds.held.has(P_CLIP)).toBe(true);
    expect([...holds.unknown]).toEqual([]);
  });

  test("a media list that cannot be read answers complete: false, so the avatar is unknown to the autopilot", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001"]));

    const unreadable = await s.photoIdsInDrafts(library, avatarId, copies({}, false));
    const failing = await s.photoIdsInDrafts(library, avatarId, async () => {
      throw new Error("the library is not available");
    });

    expect(unreadable.complete).toBe(false);
    expect(failing.complete).toBe(false);
    expect([...unreadable.photoIds]).toEqual(["photo-0000001"]);
    const holds = await readDraftHolds([avatarId], (id) => s.photoIdsInDrafts(library, id, copies({}, false)));
    expect([...holds.unknown]).toEqual([avatarId]);
  });

  test("the media list is not asked for when no draft has a video clip", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], []));
    let asked = 0;

    const answer = await s.photoIdsInDrafts(library, avatarId, async () => {
      asked++;
      throw new Error("must not be asked");
    });

    expect(asked).toBe(0);
    expect(answer.complete).toBe(true);
  });

  test("a clip copy two drafts share is in the answer once, and an own video that is no copy adds nothing", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001", "media-own-0001"]));
    await s.write(library, draftWith(avatarId, "montage-0000002", ["photo-0000002"], ["media-copy-0001"]));

    const answer = await s.photoIdsInDrafts(library, avatarId, copies({ "media-copy-0001": P_CLIP }));

    expect([...answer.photoIds].sort()).toEqual(["photo-0000001", "photo-0000002", P_CLIP].sort());
  });

  test("with no media reader at all it is as it always was", async () => {
    const { library, avatarId } = await open();
    const s = store();
    await s.write(library, draftWith(avatarId, "montage-0000001", ["photo-0000001"], ["media-copy-0001"]));
    const answer = await s.photoIdsInDrafts(library, avatarId);
    expect([...answer.photoIds]).toEqual(["photo-0000001"]);
    expect(answer.complete).toBe(true);
  });
});
