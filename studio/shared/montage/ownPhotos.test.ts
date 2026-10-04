import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../engine/montage";
import { ownPhotoCells, ownPhotoIssues } from "./ownPhotos";

// An own photo in a cell (3f.2): where they are in a spec, and the ONE function that says which of them are not available, used by the
// engine (`videos.render`, `montages.get`) and by the renderer's mock so that they cannot say it differently.

type Clip = MontageDraft["clips"][number];
type Cell = Extract<Clip, { kind: "photo" }>["cell"];

const scene = (n: number): Cell => ({ photo: { source: "scene", photoId: `photo-${n}` }, focus: null });
const own = (n: number): Cell => ({ photo: { source: "own", mediaId: `media-${n}` }, focus: null });
const empty: Cell = { photo: null, focus: null };
const photoClip = (n: number, cell: Cell): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "photo", cell, motion: "static" });
const collage = (n: number, cells: Cell[]): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "collage", layout: "collage3", cells, stagger: false, motion: "static" });
const videoClip = (n: number): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "video", mediaId: "media-9", trimStartMs: 0, focus: null });

describe("ownPhotoCells", () => {
  test("lists the own photos of photo clips and collage cells, in order, with their paths", () => {
    const clips = [photoClip(1, own(1)), collage(2, [scene(1), own(2), own(3)]), photoClip(3, scene(2))];
    expect(ownPhotoCells({ clips })).toEqual([
      { mediaId: "media-1", path: ["clips", 0, "cell"] },
      { mediaId: "media-2", path: ["clips", 1, "cells", 1] },
      { mediaId: "media-3", path: ["clips", 1, "cells", 2] },
    ]);
  });

  test("lists nothing for scene photos, empty cells and video clips", () => {
    expect(ownPhotoCells({ clips: [photoClip(1, scene(1)), photoClip(2, empty), videoClip(3)] })).toEqual([]);
  });

  test("lists the same media twice when two cells use it", () => {
    expect(ownPhotoCells({ clips: [photoClip(1, own(1)), photoClip(2, own(1))] }).map((c) => c.mediaId)).toEqual(["media-1", "media-1"]);
  });

  test("lists nothing for no clips", () => {
    expect(ownPhotoCells({ clips: [] })).toEqual([]);
  });
});

describe("ownPhotoIssues", () => {
  const spec = { clips: [photoClip(1, own(1)), collage(2, [scene(1), own(2), own(3)])] };

  test("is nothing when every own photo is available", () => {
    expect(ownPhotoIssues(spec, () => true)).toEqual([]);
  });

  test("is media-unavailable at the cell of each photo that is not", () => {
    expect(ownPhotoIssues(spec, (mediaId) => mediaId === "media-2")).toEqual([
      { code: "media-unavailable", path: ["clips", 0, "cell"] },
      { code: "media-unavailable", path: ["clips", 1, "cells", 2] },
    ]);
  });

  test("is one issue per cell: two cells that use a missing media are both marked", () => {
    expect(ownPhotoIssues({ clips: [photoClip(1, own(1)), photoClip(2, own(1))] }, () => false)).toEqual([
      { code: "media-unavailable", path: ["clips", 0, "cell"] },
      { code: "media-unavailable", path: ["clips", 1, "cell"] },
    ]);
  });

  test("says nothing about scene photos, empty cells or video clips", () => {
    expect(ownPhotoIssues({ clips: [photoClip(1, scene(1)), photoClip(2, empty), videoClip(3)] }, () => false)).toEqual([]);
  });
});
