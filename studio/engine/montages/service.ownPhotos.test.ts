import { describe, expect, test } from "bun:test";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { useWorld } from "../videos/testing/kit";
import { montageRig, scriptedFocus, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Own photos in drafts (3f.2): `montages.get` and `list` judge each own photo cell against the media the library holds (`media-unavailable`),
// and `montages.focus` answers the focus of an own photo the owner has just placed (the face detector's, or none).

const world = useWorld();

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const own = (mediaId: string) => ({ source: "own" as const, mediaId });

/** A draft whose first clip is the scene photo `a` and whose later clips are own photos. */
function draftWithOwn(avatarId: string, montageId: string, scenePhoto: string, mediaIds: string[]): Montage {
  const base = defaultSpec(avatarId, [scenePhoto], 3);
  const [first] = base.clips;
  if (first === undefined) throw new Error("expected a clip");
  const clips = [first, ...mediaIds.map((mediaId, i) => ({ clipId: `clip-9000${i}`, kind: "photo" as const, cell: { photo: own(mediaId), focus: null }, motion: "static" as const, durationMs: 2_000, transitionIn: "cut" as const }))];
  const spec: MontageDraft = { ...base, clips };
  return Montage.parse({ montageId, name: null, spec, updatedAt: "2026-09-30T10:00:00.000Z" });
}

/** The media ids the library "holds", as the engine's media store answers them; every call is recorded. */
function holding(...held: string[]): { calls: string[][]; ownPhotos: (ids: readonly string[]) => Promise<ReadonlySet<string>> } {
  const calls: string[][] = [];
  return {
    calls,
    ownPhotos: async (ids) => {
      calls.push([...ids]);
      return new Set(ids.filter((id) => held.includes(id)));
    },
  };
}

describe("montages.get: own photos", () => {
  test("an own photo the library holds is no issue", async () => {
    const w = world();
    const media = holding("media-0000001");
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithOwn(w.avatar.id, "montage-0000001", a, ["media-0000001"]));

    expect((await r.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("an own photo the library no longer holds is media-unavailable at its cell, and the draft is still answered", async () => {
    const w = world();
    const media = holding();
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });
    const [a = ""] = worldPhotoIds(w);
    const stored = draftWithOwn(w.avatar.id, "montage-0000001", a, ["media-0000001"]);
    await r.store.write(w.library, stored);

    const answer = await r.service.get("montage-0000001");

    expect(answer.montage).toEqual(stored);
    expect(answer.issues).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("asks the media store once, with the own photos of the draft only", async () => {
    const w = world();
    const media = holding("media-0000002");
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithOwn(w.avatar.id, "montage-0000001", a, ["media-0000001", "media-0000002"]));

    const answer = await r.service.get("montage-0000001");

    expect(media.calls).toEqual([["media-0000001", "media-0000002"]]);
    expect(answer.issues).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("a draft with no own photo does not ask the media store", async () => {
    const w = world();
    const media = holding();
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.get("montage-0000001");

    expect(media.calls).toEqual([]);
  });

  test("with no media store wired, an own photo is media-unavailable", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithOwn(w.avatar.id, "montage-0000001", a, ["media-0000001"]));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });
});

describe("montages.list: own photos", () => {
  test("judges every draft against one answer of the media store", async () => {
    const w = world();
    const media = holding("media-0000001");
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithOwn(w.avatar.id, "montage-0000001", a, ["media-0000001"]));
    await r.store.write(w.library, draftWithOwn(w.avatar.id, "montage-0000002", b, ["media-0000002", "media-0000001"]));

    const listed = await r.service.list(undefined);

    expect(media.calls).toHaveLength(1);
    const byId = new Map(listed.items.map((item) => [item.montage.montageId, item.issues]));
    expect(byId.get("montage-0000001")).toEqual([]);
    expect(byId.get("montage-0000002")).toEqual([{ code: "media-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("lists drafts with no own photo without asking the media store", async () => {
    const w = world();
    const media = holding();
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.list(undefined);

    expect(media.calls).toEqual([]);
  });
});

describe("montages.focus: an own photo", () => {
  const photo = { source: "own" as const, mediaId: "media-0000001" };

  test("answers the focus the face detector found on the stored photo", async () => {
    const w = world();
    const focus = scriptedFocus(() => ({ resolved: { x: 0.31, y: 0.22 } }));
    const r = montageRig(w, { focus, deps: { ownPhotos: holding("media-0000001").ownPhotos } });

    expect(await r.service.focus({ avatarId: w.avatar.id, photo })).toEqual({ focus: { x: 0.31, y: 0.22 } });
    expect(focus.ownStarted).toEqual(["media-0000001"]);
    expect(focus.started).toEqual([]);
  });

  test("answers no focus when nothing was judged: the draft stores null and a render tries again", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => "unresolved"), deps: { ownPhotos: holding("media-0000001").ownPhotos } });

    expect(await r.service.focus({ avatarId: w.avatar.id, photo })).toEqual({ focus: null });
  });

  test("answers no focus, and does not fail, when the detector throws", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => "throws"), deps: { ownPhotos: holding("media-0000001").ownPhotos } });

    expect(await r.service.focus({ avatarId: w.avatar.id, photo })).toEqual({ focus: null });
  });

  test("a media the library does not hold is NOT_FOUND, and the detector is never asked", async () => {
    const w = world();
    const focus = scriptedFocus(() => ({ resolved: { x: 0.3, y: 0.3 } }));
    const r = montageRig(w, { focus, deps: { ownPhotos: holding().ownPhotos } });

    expect(await failureOf(r.service.focus({ avatarId: w.avatar.id, photo }))).toMatchObject({ code: "NOT_FOUND" });
    expect(focus.ownStarted).toEqual([]);
  });

  test("with no media store wired, an own photo is NOT_FOUND", async () => {
    const w = world();
    const r = montageRig(w);

    expect(await failureOf(r.service.focus({ avatarId: w.avatar.id, photo }))).toMatchObject({ code: "NOT_FOUND" });
  });

  test("an avatar that is not active is NOT_FOUND before the media is looked at", async () => {
    const w = world();
    const media = holding("media-0000001");
    const r = montageRig(w, { deps: { ownPhotos: media.ownPhotos } });

    expect((await failureOf(r.service.focus({ avatarId: "avatar-nobody-1", photo }))).code).toBe("NOT_FOUND");
    expect(media.calls).toEqual([]);
  });
});
