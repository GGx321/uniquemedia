import { describe, expect, test } from "bun:test";
import { coverUrl, photoUrl, posterUrl, videoUrl } from "./media";

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
