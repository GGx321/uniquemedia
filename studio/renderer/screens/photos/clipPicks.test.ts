import { describe, expect, test } from "bun:test";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { clipPickRefusal, montagePickRefusal } from "./photoState";
import { MontagePicks, usablePicks } from "./picks";

// 5b.2, S5.WB4 (plan s5b2 §5.2.1, Q-J = 1; mockup 58): the gallery's «Выбор: для монтажа · для клипов». Each mode has its own pick set, kept per avatar by the window, and its own predicate: a batch of clips
// refuses nothing a summary can tell (the sheet shows each photo's real unsuitability), so a photo already in a video, a rejected one, one a render holds or one a montage would not take is pickable for clips.

const used = scenePhoto(1, { used: true, usedIn: ["video-0000001"] });
const rejected = scenePhoto(2, { rejected: true, eligible: false });
const reserved = scenePhoto(3, { reserved: true });
const ineligible = scenePhoto(4, { eligible: false });
const free = scenePhoto(5);

describe("clipPickRefusal", () => {
  test("a photo a montage refuses can be picked for clips: in a video, rejected, held by a render, not fit for a video", () => {
    for (const photo of [used, rejected, reserved, ineligible]) {
      expect(montagePickRefusal(photo)).not.toBeNull();
      expect(clipPickRefusal(photo)).toBeNull();
    }
  });

  test("a free photo can be picked for clips too", () => {
    expect(clipPickRefusal(free)).toBeNull();
  });
});

describe("the two pick sets", () => {
  test("a pick for clips is not a pick for a montage, and the other way round: each mode keeps its own, in the order picked", () => {
    const picks = new MontagePicks();
    picks.set("avatar-a", new Set(["p1", "p2"]), "montage");
    picks.set("avatar-a", new Set(["p7", "p3", "p5"]), "clips");
    expect([...picks.get("avatar-a", "montage")]).toEqual(["p1", "p2"]);
    expect([...picks.get("avatar-a", "clips")]).toEqual(["p7", "p3", "p5"]);
    expect([...picks.get("avatar-a")]).toEqual(["p1", "p2"]);
  });

  test("emptying one mode's set leaves the other's", () => {
    const picks = new MontagePicks();
    picks.set("avatar-a", new Set(["p1"]), "montage");
    picks.set("avatar-a", new Set(["p7"]), "clips");
    picks.set("avatar-a", new Set(), "montage");
    expect(picks.get("avatar-a", "montage").size).toBe(0);
    expect([...picks.get("avatar-a", "clips")]).toEqual(["p7"]);
  });

  test("the mode is kept per avatar: a montage until switched", () => {
    const picks = new MontagePicks();
    expect(picks.mode("avatar-a")).toBe("montage");
    picks.setMode("avatar-a", "clips");
    expect(picks.mode("avatar-a")).toBe("clips");
    expect(picks.mode("avatar-b")).toBe("montage");
    picks.setMode("avatar-a", "montage");
    expect(picks.mode("avatar-a")).toBe("montage");
  });

  test("a library switch forgets both sets and the modes", () => {
    const picks = new MontagePicks();
    picks.set("avatar-a", new Set(["p1"]), "montage");
    picks.set("avatar-a", new Set(["p7"]), "clips");
    picks.setMode("avatar-a", "clips");
    picks.clear();
    expect(picks.get("avatar-a", "montage").size + picks.get("avatar-a", "clips").size).toBe(0);
    expect(picks.mode("avatar-a")).toBe("montage");
  });
});

describe("usablePicks for clips", () => {
  test("keeps a photo in a video and a rejected one by the clips' predicate; a photo gone from the gallery still goes", () => {
    const picked = new Set([used.photoId, "gone-photo", rejected.photoId, free.photoId]);
    expect([...usablePicks(picked, [used, rejected, free], false, clipPickRefusal)]).toEqual([used.photoId, rejected.photoId, free.photoId]);
  });

  test("the montage's predicate stays the default", () => {
    const picked = new Set([used.photoId, free.photoId]);
    expect([...usablePicks(picked, [used, free])]).toEqual([free.photoId]);
  });
});
