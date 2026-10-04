import { describe, expect, test } from "bun:test";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import type { EngineClient } from "../engine/client";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { ManualScheduler } from "../engine/scheduler";
import { coverUrl, photoUrl, posterUrl, stickerUrl, trackCoverUrl, videoUrl } from "./media";

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
