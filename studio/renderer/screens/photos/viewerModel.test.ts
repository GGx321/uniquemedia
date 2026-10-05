import { describe, expect, test } from "bun:test";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { viewerPhotos, viewerPlace, viewerStep } from "./viewerModel";

// The photo viewer on the Photos screen's «Фото» tab: where the photo on screen stands in the gallery's current list (by id,
// never by index), which photos its arrows step through, and which keys step.

const [p1, p2, p3, p4] = [scenePhoto(1), scenePhoto(2), scenePhoto(3), scenePhoto(4)];
const ids = (list: readonly { photoId: string }[]): string[] => list.map((p) => p.photoId);

describe("viewerPlace: the photo's place in the list, by id", () => {
  test("in the middle: its number from one, the count, and the photos on either side", () => {
    expect(viewerPlace([p1, p2, p3], p2.photoId)).toEqual({ photo: p2, index: 1, total: 3, prevId: p1.photoId, nextId: p3.photoId });
  });

  test("the first photo has nothing before it, the last nothing after it: the ends do not wrap", () => {
    expect(viewerPlace([p1, p2, p3], p1.photoId)).toMatchObject({ index: 0, prevId: null, nextId: p2.photoId });
    expect(viewerPlace([p1, p2, p3], p3.photoId)).toMatchObject({ index: 2, prevId: p2.photoId, nextId: null });
  });

  test("a single photo has neither", () => {
    expect(viewerPlace([p1], p1.photoId)).toEqual({ photo: p1, index: 0, total: 1, prevId: null, nextId: null });
  });

  test("a newer photo arriving in front keeps the same photo, one place further on", () => {
    expect(viewerPlace([p4, p1, p2], p1.photoId)).toMatchObject({ photo: p1, index: 1, total: 3, prevId: p4.photoId, nextId: p2.photoId });
  });

  test("the photo is the list's own: a mark set since is seen at once", () => {
    const rejected = scenePhoto(2, { rejected: true, eligible: false });
    expect(viewerPlace([p1, rejected, p3], p2.photoId)?.photo.rejected).toBe(true);
  });

  test("a photo no longer in the list has no place (the viewer closes), nor has any photo in an empty list", () => {
    expect(viewerPlace([p1, p3], p2.photoId)).toBeNull();
    expect(viewerPlace([], p2.photoId)).toBeNull();
  });
});

describe("viewerPhotos: what the arrows step through", () => {
  test("nothing open: the gallery's own list under its filter, as it is", () => {
    const shown = [p1, p3];
    expect(viewerPhotos([p1, p2, p3], shown, null)).toBe(shown);
  });

  test("the open photo still under the filter: the same list", () => {
    const shown = [p1, p3];
    expect(viewerPhotos([p1, p2, p3], shown, p3.photoId)).toBe(shown);
  });

  test("the open photo an action of the viewer moved out of the filter stays in its gallery place until the owner steps away", () => {
    // «Неиспользованные»: the second photo was just rejected in the viewer, so the filter no longer shows it.
    const all = [p1, scenePhoto(2, { rejected: true, eligible: false }), p3, p4];
    expect(ids(viewerPhotos(all, [p1, p3, p4], p2.photoId))).toEqual(ids([p1, p2, p3, p4]));
    expect(viewerPhotos(all, [p1, p3, p4], p2.photoId)[1]?.rejected).toBe(true);
  });

  test("a photo gone from the gallery is not brought back", () => {
    expect(ids(viewerPhotos([p1, p3], [p1, p3], p2.photoId))).toEqual(ids([p1, p3]));
  });
});

describe("viewerStep: the keys that step", () => {
  const key = (name: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
    key: name,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });

  test("← steps back, → forward", () => {
    expect(viewerStep(key("ArrowLeft"))).toBe("prev");
    expect(viewerStep(key("ArrowRight"))).toBe("next");
  });

  test("any other key, or an arrow with a modifier held, does not step", () => {
    for (const other of ["ArrowUp", "ArrowDown", "Escape", "Enter", " ", "Home", "a"]) expect(viewerStep(key(other))).toBeNull();
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(viewerStep(key("ArrowLeft", { [mod]: true }))).toBeNull();
      expect(viewerStep(key("ArrowRight", { [mod]: true }))).toBeNull();
    }
  });
});
