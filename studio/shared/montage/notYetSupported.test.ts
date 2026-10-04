import { describe, expect, test } from "bun:test";
import type { MontageDraft } from "../engine/montage";
import { notYetSupportedIssues } from "./notYetSupported";

// N9: the parts of a montage whose slice has not landed are REFUSED, never rendered without them. 3f.2 lifts it for exactly one thing: an
// own photo in a photo or collage cell (`source: "own"`). An own video, an own sticker and an own track stay refused until their slices.

type Clip = MontageDraft["clips"][number];
type Cell = Extract<Clip, { kind: "photo" }>["cell"];

const scene = (n: number): Cell => ({ photo: { source: "scene", photoId: `photo-${n}` }, focus: null });
const own = (n: number): Cell => ({ photo: { source: "own", mediaId: `media-${n}` }, focus: null });
const empty: Cell = { photo: null, focus: null };
const photoClip = (n: number, cell: Cell): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "photo", cell, motion: "static" });
const collage = (n: number, cells: Cell[]): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "collage", layout: "collage2", cells, stagger: false, motion: "static" });
const videoClip = (n: number): Clip => ({ clipId: `clip-${n}`, durationMs: 2000, transitionIn: "cut", kind: "video", mediaId: "media-9", trimStartMs: 0, focus: null });

const spec = (clips: Clip[], extra: Partial<Pick<MontageDraft, "layers" | "music">> = {}): Pick<MontageDraft, "clips" | "layers" | "music"> => ({ clips, layers: [], music: null, ...extra });

describe("notYetSupportedIssues: own photos are supported (3f.2)", () => {
  test("an own photo in a photo clip is no issue", () => {
    expect(notYetSupportedIssues(spec([photoClip(1, own(1))]))).toEqual([]);
  });

  test("own photos in every cell of a collage are no issue", () => {
    expect(notYetSupportedIssues(spec([collage(1, [own(1), own(2)])]))).toEqual([]);
  });

  test("an own photo next to a scene photo in one collage is no issue", () => {
    expect(notYetSupportedIssues(spec([collage(1, [scene(1), own(2)])]))).toEqual([]);
  });

  test("a scene photo and an empty cell are no issue", () => {
    expect(notYetSupportedIssues(spec([photoClip(1, scene(1)), photoClip(2, empty)]))).toEqual([]);
  });
});

describe("notYetSupportedIssues: the rest of own media stays refused", () => {
  test("an own video clip is refused where it is, even next to an own photo", () => {
    expect(notYetSupportedIssues(spec([photoClip(1, own(1)), videoClip(2)]))).toEqual([{ code: "not-yet-supported", path: ["clips", 1] }]);
  });

  test("an own sticker layer is refused where it is", () => {
    const layers: MontageDraft["layers"] = [
      { kind: "sticker", layerId: "layer-1", startMs: 0, endMs: 1000, x: 0.5, y: 0.5, size: 0.3, sticker: { source: "own", mediaId: "media-3" } },
    ];
    expect(notYetSupportedIssues(spec([photoClip(1, own(1))], { layers }))).toEqual([{ code: "not-yet-supported", path: ["layers", 0] }]);
  });

  test("an own track is refused where it is", () => {
    expect(notYetSupportedIssues(spec([photoClip(1, own(1))], { music: { source: "own", mediaId: "media-4", startMs: 0 } }))).toEqual([{ code: "not-yet-supported", path: ["music"] }]);
  });
});
