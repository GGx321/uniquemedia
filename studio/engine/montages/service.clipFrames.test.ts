import { describe, expect, test } from "bun:test";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { useWorld } from "../videos/testing/kit";
import { montageRig, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// A clip copy in a draft (5b.2, I5.60, Q-F = 1): `montages.get` and `list` tell a copy whose frame is no longer free at the clip, so the editor shows the tag and Render is off before
// the engine refuses at render. The copy's photo comes from the media list's origins (`copyOrigins`), asked once per answer and only when a draft holds a video clip.

const world = useWorld();

const heldVideos = async (ids: readonly string[]): Promise<ReadonlyMap<string, { readonly durationMs: number }>> => new Map(ids.map((id) => [id, { durationMs: 60_000 }]));

function origins(map: Record<string, string>): { calls: number; copyOrigins: () => Promise<{ readable: boolean; origins: ReadonlyMap<string, { readonly photoId: string }> }> } {
  const state = { calls: 0, copyOrigins: async () => (state.calls++, { readable: true, origins: new Map(Object.entries(map).map(([id, photoId]) => [id, { photoId }])) }) };
  return state;
}

function draftWithCopy(avatarId: string, montageId: string, scenePhoto: string, mediaId: string): Montage {
  const base = defaultSpec(avatarId, [scenePhoto], 3);
  const video = { clipId: "clip-00000099", kind: "video" as const, mediaId, trimStartMs: 0, focus: null, durationMs: 2_000, transitionIn: "cut" as const };
  const spec: MontageDraft = { ...base, clips: [...base.clips, video] };
  return Montage.parse({ montageId, name: null, spec, updatedAt: "2026-09-30T10:00:00.000Z" });
}

describe("montages.get: a clip copy whose frame went into another draft's video", () => {
  test("is photo-unavailable at the copy's clip", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [b]));
    await w.library.reloadVideoRecords(w.avatar.id);
    const r = montageRig(w, { deps: { ownVideos: heldVideos, copyOrigins: origins({ "media-0000001": b }).copyOrigins } });
    await r.store.write(w.library, draftWithCopy(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "photo-unavailable", path: ["clips", 1] }]);
  });

  test("is no issue while the frame is free", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    const r = montageRig(w, { deps: { ownVideos: heldVideos, copyOrigins: origins({ "media-0000001": b }).copyOrigins } });
    await r.store.write(w.library, draftWithCopy(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("a media list that cannot be read is not guessed at: the draft is answered with no frame issue", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [b]));
    await w.library.reloadVideoRecords(w.avatar.id);
    const r = montageRig(w, { deps: { ownVideos: heldVideos, copyOrigins: async () => ({ readable: false, origins: new Map() }) } });
    await r.store.write(w.library, draftWithCopy(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("a draft with no video clip does not ask for the copies' origins", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const asked = origins({});
    const r = montageRig(w, { deps: { copyOrigins: asked.copyOrigins } });
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.get("montage-0000001");

    expect(asked.calls).toBe(0);
  });
});

describe("montages.list: a clip copy whose frame went into another draft's video", () => {
  test("tells the copy's draft and leaves a draft of free frames alone, from one question for the list", async () => {
    const w = world();
    const [a = "", b = "", c = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [b]));
    await w.library.reloadVideoRecords(w.avatar.id);
    const asked = origins({ "media-0000001": b, "media-0000002": c });
    const r = montageRig(w, { deps: { ownVideos: heldVideos, copyOrigins: asked.copyOrigins } });
    await r.store.write(w.library, draftWithCopy(w.avatar.id, "montage-0000001", a, "media-0000001"));
    await r.store.write(w.library, draftWithCopy(w.avatar.id, "montage-0000002", a, "media-0000002"));

    const listed = await r.service.list(undefined);

    const byId = new Map(listed.items.map((item) => [item.montage.montageId, item.issues]));
    expect(byId.get("montage-0000001")).toEqual([{ code: "photo-unavailable", path: ["clips", 1] }]);
    expect(byId.get("montage-0000002")).toEqual([]);
    expect(asked.calls).toBe(1);
  });
});
