import { describe, expect, test } from "bun:test";
import { refusal, unwrap, type ClipMock } from "./mockEngine.clips.testkit";
import {
  AVATAR,
  CLIP_PHOTOS,
  SOFIA,
  clipsOf,
  useOf,
  copyOfNewClip,
  errorOf,
  eventsOfType,
  makeCopyMock,
  mediaOf,
  photoClip,
  photoOf,
  readyClip,
  importCopy,
  renderSpec,
  settle,
  specOf,
  videoClip,
} from "./mockEngine.clipCopies.testkit";

// Stage 5, 5b.2, S5.WA3 (plan s5b2 I5.59, I5.60, Q-F = 1): the copy's lifetime, the frame rule and `ClipSummary.use` in the mock, as the engine has them (engine.clipCopies.test.ts,
// engine.clipFrames.test.ts, engine.clipUse.test.ts are the reference). A photo and every clip made from it are ONE frame.

const PLAIN = CLIP_PHOTOS.plain.photoId;
const FREE_SCENE = CLIP_PHOTOS.unknown.photoId;

/** A spec of a scene photo and the given copies: long enough to be a montage. */
const withScene = (...mediaIds: string[]) => specOf([photoClip(1, FREE_SCENE), ...mediaIds.map((mediaId, i) => videoClip(i + 2, mediaId))]);

async function renderedVideoId(m: ClipMock, spec: ReturnType<typeof specOf>): Promise<string> {
  const { videoId } = await unwrap(renderSpec(m, spec));
  settle(m);
  return videoId;
}

describe("the copy's lifetime", () => {
  test("a clip delete removes the clip's copy and announces it removed", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId }));
    expect(await mediaOf(m)).toEqual([]);
    expect(eventsOfType(m.events, "media.changed").some((e) => e.payload.change === "removed" && e.payload.mediaId === mediaId)).toBe(true);
    expect(await clipsOf(m)).toEqual([]);
  });

  test("a clip delete with no copy works as before", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId }));
    expect(await clipsOf(m)).toEqual([]);
  });

  test("a clip delete is IN_FLIGHT `in-use` while a render holds the copy, and removes nothing", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await unwrap(renderSpec(m, withScene(mediaId)));
    expect(await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "in-use" });
    expect((await mediaOf(m)).map((x) => x.mediaId)).toEqual([mediaId]);
    expect(await clipsOf(m)).toHaveLength(1);
  });

  test("once the render has ended the clip delete works and takes the copy with it", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(mediaId));
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId }));
    expect(await mediaOf(m)).toEqual([]);
  });

  test("an avatar delete removes every copy of its clips, after it announced the avatar removed", async () => {
    const m = makeCopyMock();
    await copyOfNewClip(m);
    await copyOfNewClip(m);
    await unwrap(m.client.request("avatars.delete", { avatarId: AVATAR }));
    expect(await mediaOf(m)).toEqual([]);
    const types = m.events.map((e) => (e.type === "media.changed" && e.payload.change === "removed" ? "copy-removed" : e.type));
    expect(types.indexOf("avatar.removed")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("copy-removed")).toBeGreaterThan(types.indexOf("avatar.removed"));
  });

  test("an avatar delete is refused while a render holds a copy of one of its clips", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    await unwrap(renderSpec(m, withScene(mediaId)));
    expect((await errorOf(m.client.request("avatars.delete", { avatarId: AVATAR }))).code).toBe("IN_FLIGHT");
    expect(await mediaOf(m)).toHaveLength(1);
  });

  test("a copy of another avatar's clip survives this avatar's delete", async () => {
    const m = makeCopyMock();
    m.engine.seedClips(SOFIA.avatarId, 1);
    const sofiaClip = (await clipsOf(m, SOFIA.avatarId))[0];
    if (sofiaClip === undefined) throw new Error("no seeded clip");
    const sofiaCopy = await importCopy(m, sofiaClip.clipId, SOFIA.avatarId);
    await copyOfNewClip(m);
    await unwrap(m.client.request("avatars.delete", { avatarId: AVATAR }));
    expect((await mediaOf(m)).map((x) => x.mediaId)).toEqual([sofiaCopy]);
  });
});

describe("the frame rule: a photo and its clips are one frame", () => {
  test("a render that holds a copy reserves the clip's photo, then uses it", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const { videoId } = await unwrap(renderSpec(m, withScene(mediaId)));
    expect(await photoOf(m, PLAIN)).toMatchObject({ reserved: true, used: false });
    settle(m);
    expect(await photoOf(m, PLAIN)).toMatchObject({ reserved: false, used: true, usedIn: [videoId] });
  });

  test("the video's photo count is the scene photos shown, not the clip frames", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(mediaId));
    const [video] = (await unwrap(m.client.request("videos.list", { avatarId: AVATAR }))).videos;
    expect(video?.photoCount).toBe(1);
  });

  test("a spec holding a photo and a clip of it is PHOTO_UNAVAILABLE `frame-repeated` at the clip's path", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const error = await errorOf(renderSpec(m, specOf([photoClip(1, PLAIN), videoClip(2, mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(error.photoReason).toBeUndefined();
  });

  test("the same copy twice in a spec is `frame-repeated` at its second place", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const error = await errorOf(renderSpec(m, specOf([videoClip(1, mediaId), videoClip(2, mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
  });

  test("two clips of one photo in a spec are `frame-repeated` at the second", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const b = await copyOfNewClip(m);
    const error = await errorOf(renderSpec(m, specOf([videoClip(1, a.mediaId), videoClip(2, b.mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
  });

  test("a copy of another avatar's clip is `frame-foreign` at the clip's path", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const error = await errorOf(renderSpec(m, specOf([videoClip(1, mediaId, 4_000)], SOFIA.avatarId)));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-foreign", issues: [{ code: "photo-unavailable", path: ["clips", 0] }] });
  });

  test("the frame offences are told before the export folder or the photos are looked at", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    m.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    expect((await errorOf(renderSpec(m, specOf([videoClip(1, mediaId), videoClip(2, mediaId)])))).code).toBe("PHOTO_UNAVAILABLE");
  });

  test("a frame used by a finished video refuses its other clip's copy at the clip's path, `in-video`", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const b = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(a.mediaId));
    const error = await errorOf(renderSpec(m, specOf([photoClip(1, CLIP_PHOTOS.hidden.photoId), videoClip(2, b.mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "in-video", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(error.issues).toHaveLength(1);
    expect(error.detail).toBeUndefined();
  });

  test("a photo whose clip is in a video is used for a new draft too", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(mediaId));
    const error = await errorOf(m.client.request("montages.create", { avatarId: AVATAR, photoIds: [PLAIN] }));
    expect(error.code).toBe("PHOTO_UNAVAILABLE");
  });

  test("a deleted clip, and a deleted copy, keep the frame used", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(mediaId));
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId }));
    expect(await photoOf(m, PLAIN)).toMatchObject({ used: true });
  });

  test("two queued renders, one holding a photo and one holding a copy of its clip, collide at the clip's path: `held-by-render`", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    await unwrap(renderSpec(m, specOf([photoClip(1, PLAIN), photoClip(2, FREE_SCENE)])));
    const error = await errorOf(renderSpec(m, specOf([photoClip(1, CLIP_PHOTOS.hidden.photoId), videoClip(2, mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
  });

  test("a copy whose photo is rejected is refused at the clip's path, with no reason and no detail, like a rejected scene photo", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    await unwrap(m.client.request("photos.setRejected", { avatarId: AVATAR, photoId: PLAIN, rejected: true }));
    const error = await errorOf(renderSpec(m, withScene(mediaId)));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(error.photoReason).toBeUndefined();
    expect(error.detail).toBeUndefined();
  });

  test("a failed render gives the frame back", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    m.engine.failNextRender({ code: "RENDER_FAILED", detail: "ffmpeg failed: boom" });
    await unwrap(renderSpec(m, withScene(mediaId)));
    settle(m);
    expect(await photoOf(m, PLAIN)).toMatchObject({ used: false, reserved: false });
  });

  test("delete-and-reject rejects the scene photos, then the photos of the clip copies", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const videoId = await renderedVideoId(m, withScene(mediaId));
    const deleted = await unwrap(m.client.request("videos.delete", { videoId, mode: "video", rejectPhotos: true }));
    expect(deleted.rejectedPhotoIds).toEqual([FREE_SCENE, PLAIN]);
    expect(await photoOf(m, PLAIN)).toMatchObject({ rejected: true, used: false });
  });

  test("deleting a video frees its frame", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const videoId = await renderedVideoId(m, withScene(mediaId));
    await unwrap(m.client.request("videos.delete", { videoId, mode: "video" }));
    expect(await photoOf(m, PLAIN)).toMatchObject({ used: false });
  });
});

describe("ClipSummary.use", () => {
  const draftOf = async (m: ClipMock, mediaIds: string[], name: string | null) => {
    const draft = (await unwrap(m.client.request("montages.create", { avatarId: AVATAR, photoIds: [] }))).montage;
    const spec = specOf([photoClip(1, FREE_SCENE), ...mediaIds.map((mediaId, i) => videoClip(i + 2, mediaId))]);
    await unwrap(m.client.request("montages.save", { montageId: draft.montageId, spec, name }));
    return draft.montageId;
  };

  test("a clip nothing uses has no `use`", async () => {
    const m = makeCopyMock();
    const { clipId } = await copyOfNewClip(m);
    expect((await useOf(m, clipId))).toBeUndefined();
  });

  test("a failed clip has no `use`", async () => {
    const m = makeCopyMock();
    m.engine.scriptNextClip("refused-free");
    const clipId = await readyClip(m, { fallback: "none", acceptedWorstMicros: 504_000 });
    expect((await useOf(m, clipId))).toBeUndefined();
  });

  test("a clip whose copy is in a finished video is used `inVideo: clip`", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(mediaId));
    expect((await useOf(m, clipId))).toEqual({ inVideo: "clip" });
  });

  test("a sibling clip of a used frame is used `inVideo: photo`", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const bId = await readyClip(m);
    await renderedVideoId(m, withScene(a.mediaId));
    expect((await useOf(m, bId))).toEqual({ inVideo: "photo" });
  });

  test("a clip whose photo is a scene photo of a finished video is used `inVideo: photo`", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    await renderedVideoId(m, specOf([photoClip(1, PLAIN), photoClip(2, FREE_SCENE)]));
    expect((await useOf(m, clipId))).toEqual({ inVideo: "photo" });
  });

  test("a clip whose copy one draft holds says how many drafts, and, for one draft, its name and the clip's place in it", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await draftOf(m, [mediaId], "Лето");
    expect((await useOf(m, clipId))).toEqual({ inDrafts: { count: 1, first: { name: "Лето", frame: 2 } } });
  });

  test("a draft with no name is told with a null name", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await draftOf(m, [mediaId], null);
    expect((await useOf(m, clipId))).toEqual({ inDrafts: { count: 1, first: { name: null, frame: 2 } } });
  });

  test("two drafts that hold the copy are a count of 2 and name neither", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await draftOf(m, [mediaId], "Один");
    await draftOf(m, [mediaId], "Два");
    expect((await useOf(m, clipId))).toEqual({ inDrafts: { count: 2 } });
  });

  test("a draft that holds the copy twice counts once, at the first place", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await draftOf(m, [mediaId, mediaId], "Дважды");
    expect((await useOf(m, clipId))).toEqual({ inDrafts: { count: 1, first: { name: "Дважды", frame: 2 } } });
  });

  test("a clip in a video and in a draft says both", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(mediaId));
    await draftOf(m, [mediaId], "Лето");
    expect((await useOf(m, clipId))).toEqual({ inVideo: "clip", inDrafts: { count: 1, first: { name: "Лето", frame: 2 } } });
  });

  test("a deleted draft no longer holds the copy", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    const montageId = await draftOf(m, [mediaId], "Лето");
    await unwrap(m.client.request("montages.delete", { montageId }));
    expect((await useOf(m, clipId))).toBeUndefined();
  });

  test("clips.list tells the same use as clips.get", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await draftOf(m, [mediaId], "Лето");
    const listed = (await clipsOf(m)).find((c) => c.clipId === clipId);
    expect(listed !== undefined && listed.status === "ready" ? listed.use : "not listed").toEqual(await useOf(m, clipId));
  });
});

describe("a draft's copy whose frame went into another draft's video (S5.WA5, M2)", () => {
  const savedDraft = async (m: ClipMock, spec: ReturnType<typeof specOf>) => {
    const draft = (await unwrap(m.client.request("montages.create", { avatarId: AVATAR, photoIds: [] }))).montage;
    await unwrap(m.client.request("montages.save", { montageId: draft.montageId, spec, name: null }));
    return draft.montageId;
  };

  test("montages.get tells photo-unavailable at the copy's clip, as the engine does", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const b = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(a.mediaId));
    const montageId = await savedDraft(m, specOf([photoClip(1, CLIP_PHOTOS.hidden.photoId), videoClip(2, b.mediaId)]));
    const { issues } = await unwrap(m.client.request("montages.get", { montageId }));
    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 1] }]);
  });

  test("montages.list tells it too, and a draft of a free frame has no issue", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const b = await copyOfNewClip(m);
    await renderedVideoId(m, withScene(a.mediaId));
    const montageId = await savedDraft(m, specOf([photoClip(1, CLIP_PHOTOS.hidden.photoId), videoClip(2, b.mediaId)]));
    const listed = await unwrap(m.client.request("montages.list", { avatarId: AVATAR }));
    expect(listed.items.find((item) => item.montage.montageId === montageId)?.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 1] }]);
  });

  test("a copy of a free frame is no issue", async () => {
    const m = makeCopyMock();
    const a = await copyOfNewClip(m);
    const montageId = await savedDraft(m, withScene(a.mediaId));
    const { issues } = await unwrap(m.client.request("montages.get", { montageId }));
    expect(issues).toEqual([]);
  });
});
