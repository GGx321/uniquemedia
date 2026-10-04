import { describe, expect, test } from "bun:test";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import type { EngineClient } from "../engine/client";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { ManualScheduler } from "../engine/scheduler";
import { coverUrl, ownStickerUrl, ownTrackUrl, photoUrl, posterUrl, stickerUrl, trackCoverUrl, trackUrl, videoUrl } from "./media";

// 3d.3b: a built-in sticker's picture is asked for by id, never by a path (invariant 12): main's `studio-media://sticker/<id>`
// route serves the catalogue, the dev mock a stand-in of its own.

describe("stickerUrl", () => {
  const real = (kind: EngineClient["kind"]): Pick<EngineClient, "kind" | "stickerUrl"> => ({ kind });

  test("the real client asks main's media route by the sticker's id", () => {
    expect(stickerUrl(real("window"), "heart-pulse")).toBe("studio-media://sticker/heart-pulse");
  });

  test("an id that breaks the contract is never put into an address", () => {
    expect(stickerUrl(real("window"), "../photo")).toBe(null);
    expect(stickerUrl(real("window"), "HEART")).toBe(null);
  });

  test("the mock draws a stand-in for every sticker of the built-in set, and none for one it lacks", () => {
    // A manual clock: the test leaves nothing that could keep the process alive.
    const client = mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() }));
    for (const sticker of STICKER_MANIFEST) expect(stickerUrl(client, sticker.id)?.startsWith("data:image/png;base64,")).toBe(true);
    expect(stickerUrl(client, "sticker-nowhere")).toBe(null);
  });
});

// 3f.4: the preview plays an own track by its media id through main's `media` route, never by a path (invariant 12). Only the real client has such a
// route: the dev mock stores no audio, so its preview is silent, as it is for a trending track.

describe("ownTrackUrl", () => {
  const client = (kind: EngineClient["kind"]): Pick<EngineClient, "kind"> => ({ kind });

  test("the real client asks main's media route by the media id", () => {
    expect(ownTrackUrl(client("window"), "media-00000007")).toBe("studio-media://media/media-00000007");
  });

  test("the dev mock has no audio to play: no address", () => {
    expect(ownTrackUrl(client("mock"), "media-00000007")).toBeNull();
  });

  test("an id that is not one never becomes an address", () => {
    for (const bad of ["../x", "a/b", "", "C:\\x", "x y", "MEDIA-0001", "media-7", "media-00000007.m4a", `media-${"1".repeat(80)}`]) expect([bad, ownTrackUrl(client("window"), bad)]).toEqual([bad, null]);
  });

  test("a trending track's address is its own route, not this one", () => {
    expect(trackUrl(client("window"), "4199287736976977")).toBe("studio-media://track/4199287736976977");
    expect(ownTrackUrl(client("window"), "4199287736976977")).toBe("studio-media://media/4199287736976977");
  });
});

// The only way the UI addresses a library file (invariants 12 and 28): by ids, through main's `studio-media://` routes. An id
// that breaks the contract never becomes an address.

describe("media addresses by id", () => {
  test("a photo, a video, its poster and a track's cover each have their route", () => {
    expect(photoUrl("avatar-0001", "photo-0002")).toBe("studio-media://photo/avatar-0001/photo-0002");
    expect(videoUrl("avatar-0001", "video-00000001")).toBe("studio-media://video/avatar-0001/video-00000001");
    expect(posterUrl("avatar-0001", "video-00000001")).toBe("studio-media://poster/avatar-0001/video-00000001");
    expect(coverUrl("4199287736976977")).toBe("studio-media://cover/4199287736976977");
  });

  test("an id that is not one never becomes a path: null", () => {
    for (const bad of ["../x", "a/b", "", "C:\\x", "x y"]) {
      expect(videoUrl("avatar-0001", bad)).toBeNull();
      expect(videoUrl(bad, "video-00000001")).toBeNull();
      expect(posterUrl("avatar-0001", bad)).toBeNull();
      expect(coverUrl(bad)).toBeNull();
    }
  });
});

// 3d.5: a listed track's cover in the «Музыка» tab and the music card: the cover route, only when the store holds one and only
// on the real client (the mock stores no pictures).
describe("trackCoverUrl", () => {
  const track = (trackId: string, hasCover = true) => ({ trackId, hasCover });

  test("the real client asks main's cover route by the track's id", () => {
    expect(trackCoverUrl({ kind: "window" }, track("track-espresso-01"))).toBe("studio-media://cover/track-espresso-01");
  });

  test("no cover stored, no address: the window draws a placeholder", () => {
    expect(trackCoverUrl({ kind: "window" }, track("track-espresso-01", false))).toBe(null);
  });

  test("an id that breaks the contract is never put into an address", () => {
    expect(trackCoverUrl({ kind: "window" }, track("../covers/x"))).toBe(null);
    expect(trackCoverUrl({ kind: "window" }, track("Track"))).toBe(null);
  });

  test("the mock and a window with no engine have no pictures to serve", () => {
    expect(trackCoverUrl({ kind: "mock" }, track("demo-track-0001"))).toBe(null);
    expect(trackCoverUrl({ kind: "unavailable" }, track("demo-track-0001"))).toBe(null);
  });
});

// 3d.4: the preview plays the montage's music from main's track route, by the stored track's id. The dev mock stores no audio, so it
// has none and the preview stays silent there.
describe("trackUrl", () => {
  test("the real client asks main's track route by the track's id", () => {
    expect(trackUrl({ kind: "window" }, "track-espresso-01")).toBe("studio-media://track/track-espresso-01");
  });

  test("the mock and an unavailable engine have no audio", () => {
    expect(trackUrl({ kind: "mock" }, "track-espresso-01")).toBe(null);
    expect(trackUrl({ kind: "unavailable" }, "track-espresso-01")).toBe(null);
  });

  test("an id that breaks the contract never becomes an address", () => {
    for (const bad of ["../x", "a/b", "", "TRACK"]) expect(trackUrl({ kind: "window" }, bad) === null).toBe(true);
  });
});

// 3f.5: an own sticker's picture as an element shows it: the stored file by its media id, through the media RECORD main resolves it by.
describe("ownStickerUrl", () => {
  const real: Pick<EngineClient, "kind" | "ownStickerUrl"> = { kind: "window" };

  test("the real client's own stickers are studio-media://media/<mediaId>", () => {
    expect(ownStickerUrl(real, "media-0000001")).toBe("studio-media://media/media-0000001");
  });

  test("an id that breaks the contract has no address, and never one with a path in it", () => {
    expect(ownStickerUrl(real, "../photo")).toBe(null);
    expect(ownStickerUrl(real, "media-0000001.png")).toBe(null);
    expect(ownStickerUrl(real, "")).toBe(null);
  });

  test("the mock's own address for it wins, and may be null for a media it does not hold as a sticker", () => {
    expect(ownStickerUrl({ kind: "mock", ownStickerUrl: (mediaId) => `data:image/png;base64,${mediaId}` }, "media-0000001")).toBe("data:image/png;base64,media-0000001");
    expect(ownStickerUrl({ kind: "mock", ownStickerUrl: () => null }, "media-0000001")).toBe(null);
  });
});
