import { describe, expect, test } from "bun:test";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { listedPicks, MontagePicks, usablePicks } from "./picks";

// Slice review 5-L3 and review r1 LOW-6/7: the picks the window keeps per avatar are checked against the gallery once it answers (a photo that went
// into a video, a render, the reject list or out of the library meanwhile leaves them), and a library switch forgets them all.

describe("the picks kept by the window", () => {
  test("kept per avatar in the order picked; none picked is none kept", () => {
    const picks = new MontagePicks();
    picks.set("avatar-a", new Set(["p2", "p1"]));
    expect([...picks.get("avatar-a")]).toEqual(["p2", "p1"]);
    expect(picks.get("avatar-b").size).toBe(0);
    picks.set("avatar-a", new Set());
    expect(picks.get("avatar-a").size).toBe(0);
  });

  test("a library switch forgets them all", () => {
    const picks = new MontagePicks();
    picks.set("avatar-a", new Set(["p1"]));
    picks.set("avatar-b", new Set(["p9"]));
    picks.clear();
    expect(picks.get("avatar-a").size + picks.get("avatar-b").size).toBe(0);
  });
});

describe("usablePicks", () => {
  const free = scenePhoto(1);
  const other = scenePhoto(2);
  test("keeps what the gallery still offers, in the order picked; the same set when nothing goes", () => {
    const picked = new Set([other.photoId, free.photoId]);
    expect(usablePicks(picked, [free, other])).toBe(picked);
  });

  test("drops a photo that is gone, in a video, in a render, rejected or not eligible", () => {
    const photos = [free, scenePhoto(3, { used: true, usedIn: ["video-0000001"] }), scenePhoto(4, { reserved: true }), scenePhoto(5, { rejected: true, eligible: false }), scenePhoto(6, { eligible: false })];
    const picked = new Set(["gone-photo", ...photos.map((p) => p.photoId)]);
    expect([...usablePicks(picked, photos)]).toEqual([free.photoId]);
  });

  // S4.P2: past 500 photos the gallery answers a page at a time.
  test("against some pages only: a pick they do not list is kept for its own page, one they list unusable still goes", () => {
    const rejected = scenePhoto(5, { rejected: true, eligible: false });
    const picked = new Set(["photo-on-a-later-page", rejected.photoId, free.photoId]);
    expect([...usablePicks(picked, [free, rejected], true)]).toEqual(["photo-on-a-later-page", free.photoId]);
  });

  test("the whole gallery read: a pick on no page goes, and only that one (an unusable listed pick is the first check's to judge)", () => {
    const rejected = scenePhoto(5, { rejected: true, eligible: false });
    const picked = new Set([free.photoId, "photo-gone-meanwhile", rejected.photoId]);
    expect([...listedPicks(picked, [free, rejected])]).toEqual([free.photoId, rejected.photoId]);
    const kept = new Set([free.photoId]);
    expect(listedPicks(kept, [free])).toBe(kept);
  });

  test("against some pages only: the same set when nothing they list goes", () => {
    const picked = new Set(["photo-on-a-later-page", free.photoId]);
    expect(usablePicks(picked, [free, other], true)).toBe(picked);
  });
});
