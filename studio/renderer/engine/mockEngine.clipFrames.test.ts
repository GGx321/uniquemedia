import { describe, expect, test } from "bun:test";
import { refusal, unwrap } from "./mockEngine.clips.testkit";
import {
  AVATAR,
  CLIP_PHOTOS,
  clipsOf,
  copyOfNewClip,
  errorOf,
  eventsOfType,
  makeCopyMock,
  mediaOf,
  photoClip,
  renderSpec,
  specOf,
  videoClip,
} from "./mockEngine.clipCopies.testkit";

// Stage 5, 5b.2, S5.WA3 (plan s5b2 I5.59, I5.60, Q-F = 1): the copy's lifetime, the frame rule and `ClipSummary.use` in the mock, as the engine has them (engine.clipCopies.test.ts,
// engine.clipFrames.test.ts, engine.clipUse.test.ts are the reference). A photo and every clip made from it are ONE frame.

const PLAIN = CLIP_PHOTOS.plain.photoId;
const FREE_SCENE = CLIP_PHOTOS.unknown.photoId;

/** A spec of a scene photo and the given copies: long enough to be a montage. */
const withScene = (...mediaIds: string[]) => specOf([photoClip(1, FREE_SCENE), ...mediaIds.map((mediaId, i) => videoClip(i + 2, mediaId))]);


describe("the copy's lifetime", () => {
  test("a clip delete removes the clip's copy and announces it removed", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId }));
    expect(await mediaOf(m)).toEqual([]);
    expect(eventsOfType(m.events, "media.changed").some((e) => e.payload.change === "removed" && e.payload.mediaId === mediaId)).toBe(true);
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

});

describe("the frame rule: a photo and its clips are one frame", () => {

  test("a spec holding a photo and a clip of it is PHOTO_UNAVAILABLE `frame-repeated` at the clip's path", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    const error = await errorOf(renderSpec(m, specOf([photoClip(1, PLAIN), videoClip(2, mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", detail: "frame-repeated", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
    expect(error.photoReason).toBeUndefined();
  });

  test("two queued renders, one holding a photo and one holding a copy of its clip, collide at the clip's path: `held-by-render`", async () => {
    const m = makeCopyMock();
    const { mediaId } = await copyOfNewClip(m);
    await unwrap(renderSpec(m, specOf([photoClip(1, PLAIN), photoClip(2, FREE_SCENE)])));
    const error = await errorOf(renderSpec(m, specOf([photoClip(1, CLIP_PHOTOS.hidden.photoId), videoClip(2, mediaId)])));
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render", issues: [{ code: "photo-unavailable", path: ["clips", 1] }] });
  });

});

