import { describe, expect, test } from "bun:test";
import { mockFitted } from "./mockClipCopies";
import { create, runUntilEnd, unwrap } from "./mockEngine.clips.testkit";
import {
  AVATAR,
  CLIP_PHOTOS,
  copyOfNewClip,
  errorOf,
  eventsOfType,
  importReply,
  makeCopyMock,
  mediaOf,
  photoClip,
  readyClip,
  specOf,
  startImport,
  useOf,
  videoClip,
} from "./mockEngine.clipCopies.testkit";

// Stage 5, 5b.2, S5.WA3 (round 2): the corners of the mirror: the importer's fit, the library under a switch or gone, and the avatar delete's words for a clip job.

describe("the copy's size: the importer's fit", () => {
  test("a picture bigger than the frame is scaled inside it and rounded to the nearest even side", () => {
    expect(mockFitted(1280, 720)).toEqual({ width: 1080, height: 608 });
    expect(mockFitted(2000, 4000)).toEqual({ width: 960, height: 1920 });
  });

  test("a picture inside the frame is never scaled, and an odd side is floored to even", () => {
    expect(mockFitted(721, 1281)).toEqual({ width: 720, height: 1280 });
    expect(mockFitted(720, 1280)).toEqual({ width: 720, height: 1280 });
  });
});

describe("the library under a switch or gone", () => {
  test("a library switch under way refuses the import IN_FLIGHT, after `not-ready` is told", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.scriptNextClip("refused-free");
    const { jobId: failed } = await unwrap(create(m, { fallback: "none", acceptedWorstMicros: 504_000 }));
    runUntilEnd(m, failed);
    m.engine.setLibrarySwitching(true);
    expect((await errorOf(importReply(m, failed))).clipReason).toBe("not-ready");
    expect((await errorOf(importReply(m, clipId))).code).toBe("IN_FLIGHT");
  });

  test("a library switch under way withholds `inDrafts`", async () => {
    const m = makeCopyMock();
    const { clipId, mediaId } = await copyOfNewClip(m);
    const draft = (await unwrap(m.client.request("montages.create", { avatarId: AVATAR, photoIds: [] }))).montage;
    await unwrap(m.client.request("montages.save", { montageId: draft.montageId, spec: specOf([photoClip(1, CLIP_PHOTOS.unknown.photoId), videoClip(2, mediaId)]), name: "Лето" }));
    expect(await useOf(m, clipId)).toMatchObject({ inDrafts: { count: 1 } });
    m.engine.setLibrarySwitching(true);
    expect(await useOf(m, clipId)).toBeUndefined();
  });

  test("a library that goes while the copy is made cancels the import: no record is written", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    m.engine.setLibraryAvailable(false);
    runUntilEnd(m, jobId);
    m.engine.setLibraryAvailable(true);
    expect(eventsOfType(m.events, "job.cancelled").some((e) => e.payload.jobId === jobId)).toBe(true);
    expect(await mediaOf(m)).toEqual([]);
  });
});

describe("the avatar delete, while a clip is made", () => {
  test("a clip job of the avatar is told in its own words", async () => {
    const m = makeCopyMock();
    await unwrap(create(m));
    expect(await errorOf(m.client.request("avatars.deletePreview", { avatarId: AVATAR }))).toMatchObject({ code: "IN_FLIGHT", detail: "a clip of this avatar is being made; delete the avatar when it ends" });
  });
});
