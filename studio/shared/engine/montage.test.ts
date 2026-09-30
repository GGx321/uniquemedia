import { describe, expect, test } from "bun:test";
import {
  MAX_CLIPS,
  MAX_LAYERS,
  MAX_LISTED_MONTAGES,
  MAX_MONTAGE_ISSUES,
  MAX_STICKER_LAYERS,
  MAX_TEXT_LAYERS,
  Montage,
  MontageDraft,
  MontageIssue,
  MontageListItem,
  MontageShape,
  MontageSpec,
  montageIssues,
  MONTAGE_ISSUE_CODES,
  type MontageIssueCode,
} from "./montage";

// ---------- fixtures ----------

const AVATAR = "avatar-0001";

const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, "0")}`;

const cell = (n: number) => ({ photo: { source: "scene", photoId: id("photo", n) }, focus: { x: 0.5, y: 0.38 } });

const photoClip = (n: number, durationMs = 8_000) => ({
  clipId: id("clip", n),
  durationMs,
  transitionIn: "cut",
  kind: "photo",
  cell: cell(n),
  motion: "kenburns",
});

/** A collage clip whose photos are numbered from `first`; `layout` and the number of cells are independent on purpose. */
const collageClip = (n: number, layout: string, cells: number, first = n * 10, durationMs = 8_000) => ({
  clipId: id("clip", n),
  durationMs,
  transitionIn: "cut",
  kind: "collage",
  layout,
  cells: Array.from({ length: cells }, (_, k) => cell(first + k)),
  motion: "pan",
  stagger: true,
});

const videoClip = (n: number, durationMs = 5_000) => ({
  clipId: id("clip", n),
  durationMs,
  transitionIn: "cut",
  kind: "video",
  mediaId: id("media", n),
  trimStartMs: 1_200,
  focus: null,
});

const textLayer = (n: number, over: Record<string, unknown> = {}) => ({
  layerId: id("layer", n),
  startMs: 0,
  endMs: 3_000,
  kind: "text",
  value: "Coffee first",
  font: "manrope",
  style: "plaque",
  color: "#111111",
  x: 0.5,
  y: 0.195,
  scale: 1,
  ...over,
});

const stickerLayer = (n: number, over: Record<string, unknown> = {}) => ({
  layerId: id("layer", 100 + n),
  startMs: 1_000,
  endMs: 4_000,
  kind: "sticker",
  sticker: { source: "builtin", stickerId: id("sticker", n) },
  x: 0.741,
  y: 0.333,
  size: 0.203,
  ...over,
});

const spec = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  avatarId: AVATAR,
  clips: [photoClip(1, 8_000)],
  layers: [],
  music: null,
  seed: 7,
  ...over,
});

/** `n` photo clips of the same length, ids unique. */
const clips = (n: number, durationMs: number) => Array.from({ length: n }, (_, k) => photoClip(k + 1, durationMs));

const codes = (issues: readonly { code: string }[]): string[] => issues.map((i) => i.code);

const issuesOf = (value: unknown, mode: "draft" | "spec") => {
  return montageIssues(MontageShape.parse(value), mode);
};

// ---------- a complete spec ----------

describe("MontageSpec", () => {
  test("accepts one photo clip of 8 s", () => {
    expect(MontageSpec.safeParse(spec()).success).toBe(true);
  });

  test("accepts a full timeline: photo, collage and own video clips, text, sticker and own music", () => {
    const full = spec({
      clips: [photoClip(1, 4_000), collageClip(2, "collage3", 3, 20, 5_000), videoClip(3, 3_000)],
      layers: [textLayer(1), stickerLayer(1, { sticker: { source: "own", mediaId: "media-0009" } })],
      music: { source: "own", mediaId: "media-0010", startMs: 12_300 },
    });
    expect(MontageSpec.safeParse(full).success).toBe(true);
  });

  test("accepts a trending music track with a start offset", () => {
    const withMusic = spec({ music: { source: "trending", trackId: "4199287736976977", startMs: 1_500 } });
    expect(MontageSpec.safeParse(withMusic).success).toBe(true);
  });

  test("round trips through JSON unchanged", () => {
    const value = spec({ layers: [textLayer(1)] });
    const back: unknown = MontageSpec.parse(JSON.parse(JSON.stringify(value)));
    expect(back).toEqual(value);
  });

  test("rejects a schemaVersion other than 1", () => {
    expect(MontageSpec.safeParse(spec({ schemaVersion: 2 })).success).toBe(false);
  });

  test("rejects a missing schemaVersion", () => {
    const { schemaVersion: _v, ...without } = spec();
    expect(MontageSpec.safeParse(without).success).toBe(false);
  });

  test("rejects an avatarId that breaks the id pattern", () => {
    expect(MontageSpec.safeParse(spec({ avatarId: "../avatar" })).success).toBe(false);
  });
});

// ---------- total length ----------

describe("total length", () => {
  test("3.9 s is too short for a spec", () => {
    const value = spec({ clips: [photoClip(1, 3_900)] });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(codes(issuesOf(value, "spec"))).toEqual(["duration-too-short"]);
  });

  test("4.0 s is the shortest a spec may be", () => {
    const value = spec({ clips: [photoClip(1, 4_000)] });
    expect(MontageSpec.safeParse(value).success).toBe(true);
    expect(issuesOf(value, "spec")).toEqual([]);
  });

  test("15.0 s is the longest a spec may be", () => {
    const value = spec({ clips: [photoClip(1, 15_000)] });
    expect(MontageSpec.safeParse(value).success).toBe(true);
    expect(issuesOf(value, "spec")).toEqual([]);
  });

  test("15.1 s is too long for a spec", () => {
    const value = spec({ clips: [photoClip(1, 8_000), photoClip(2, 7_100)] });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(codes(issuesOf(value, "spec"))).toEqual(["duration-too-long"]);
  });

  test("the total is the sum of every clip", () => {
    const value = spec({ clips: [photoClip(1, 1_500), photoClip(2, 1_500), photoClip(3, 1_000)] });
    expect(issuesOf(value, "spec")).toEqual([]);
  });

  test("a draft is not held to 4-15 s: 1 s and 30 s are both fine", () => {
    const short = spec({ clips: [photoClip(1, 1_000)] });
    const long = spec({ clips: clips(20, 1_500) });
    expect(MontageDraft.safeParse(short).success).toBe(true);
    expect(MontageDraft.safeParse(long).success).toBe(true);
  });
});

// ---------- clips ----------

describe("clips", () => {
  test("a spec needs at least one clip", () => {
    const value = spec({ clips: [] });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(codes(issuesOf(value, "spec"))).toEqual(["no-clips"]);
  });

  test("a draft may have no clips at all", () => {
    expect(MontageDraft.safeParse(spec({ clips: [] })).success).toBe(true);
  });

  test("20 clips are allowed", () => {
    expect(MontageSpec.safeParse(spec({ clips: clips(MAX_CLIPS, 700) })).success).toBe(true);
    expect(MontageDraft.safeParse(spec({ clips: clips(MAX_CLIPS, 700) })).success).toBe(true);
  });

  test("21 clips are refused, by a spec and by a draft", () => {
    expect(MontageSpec.safeParse(spec({ clips: clips(MAX_CLIPS + 1, 700) })).success).toBe(false);
    expect(MontageDraft.safeParse(spec({ clips: clips(MAX_CLIPS + 1, 700) })).success).toBe(false);
  });

  test("a clip may be 500 ms", () => {
    expect(MontageDraft.safeParse(spec({ clips: [photoClip(1, 500)] })).success).toBe(true);
  });

  test("a clip shorter than 500 ms is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [photoClip(1, 400)] })).success).toBe(false);
  });

  test("a clip longer than 15 s is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [photoClip(1, 15_100)] })).success).toBe(false);
  });

  test("a clip duration that is not a multiple of 100 ms is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [photoClip(1, 4_050)] })).success).toBe(false);
  });

  test("a fractional clip duration is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [photoClip(1, 4_000.5)] })).success).toBe(false);
  });

  test("transitionIn only ever says cut", () => {
    const fade = { ...photoClip(1), transitionIn: "fade" };
    expect(MontageDraft.safeParse(spec({ clips: [fade] })).success).toBe(false);
  });

  test("a clip without transitionIn is refused: the literal is part of the shape", () => {
    const { transitionIn: _t, ...without } = photoClip(1);
    expect(MontageDraft.safeParse(spec({ clips: [without] })).success).toBe(false);
  });

  test("an unknown clip kind is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...photoClip(1), kind: "gif" }] })).success).toBe(false);
  });

  test("an unknown motion is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...photoClip(1), motion: "zoom" }] })).success).toBe(false);
  });

  test.each(["kenburns", "pan", "static"])("motion %s is accepted", (motion) => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...photoClip(1), motion }] })).success).toBe(true);
  });

  test("two clips with the same clipId are refused", () => {
    const value = spec({ clips: [photoClip(1, 4_000), { ...photoClip(2, 4_000), clipId: id("clip", 1) }] });
    expect(MontageDraft.safeParse(value).success).toBe(false);
    expect(codes(issuesOf(value, "draft"))).toEqual(["duplicate-clip-id"]);
  });

  test("an own video clip carries its media id, a trim start and a focus", () => {
    expect(MontageSpec.safeParse(spec({ clips: [videoClip(1, 4_000)] })).success).toBe(true);
  });

  test("an own video clip with a negative trim start is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...videoClip(1), trimStartMs: -100 }] })).success).toBe(false);
  });

  test("an own video clip with a fractional trim start is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...videoClip(1), trimStartMs: 10.5 }] })).success).toBe(false);
  });

  test("an own video clip has no motion: the field is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...videoClip(1), motion: "static" }] })).success).toBe(false);
  });

  test("a photo cell may be an own upload", () => {
    const own = { ...photoClip(1), cell: { photo: { source: "own", mediaId: "media-0001" }, focus: null } };
    expect(MontageSpec.safeParse(spec({ clips: [own] })).success).toBe(true);
  });

  test("a photo cell of an unknown source is refused", () => {
    const bad = { ...photoClip(1), cell: { photo: { source: "web", url: "https://example.com/a.jpg" }, focus: null } };
    expect(MontageDraft.safeParse(spec({ clips: [bad] })).success).toBe(false);
  });
});

// ---------- collages ----------

describe("collage clips", () => {
  test("collage2 with 2 cells is accepted", () => {
    expect(MontageSpec.safeParse(spec({ clips: [collageClip(1, "collage2", 2)] })).success).toBe(true);
  });

  test("collage3 with 3 cells is accepted", () => {
    expect(MontageSpec.safeParse(spec({ clips: [collageClip(1, "collage3", 3)] })).success).toBe(true);
  });

  test("collage4 with 4 cells is accepted", () => {
    expect(MontageSpec.safeParse(spec({ clips: [collageClip(1, "collage4", 4)] })).success).toBe(true);
  });

  test("a collage with 1 cell is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [collageClip(1, "collage2", 1)] })).success).toBe(false);
  });

  test("a collage with 5 cells is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [collageClip(1, "collage4", 5)] })).success).toBe(false);
  });

  test("collage3 with only 2 cells is refused: the layout names the cell count", () => {
    const value = spec({ clips: [collageClip(1, "collage3", 2)] });
    expect(MontageDraft.safeParse(value).success).toBe(false);
    expect(issuesOf(value, "draft")).toEqual([{ code: "cells-layout-mismatch", path: ["clips", 0, "cells"] }]);
  });

  test("collage2 with 4 cells is refused", () => {
    const value = spec({ clips: [collageClip(1, "collage2", 4)] });
    expect(codes(issuesOf(value, "draft"))).toEqual(["cells-layout-mismatch"]);
  });

  test("an unknown layout is refused", () => {
    expect(MontageDraft.safeParse(spec({ clips: [collageClip(1, "collage5", 4)] })).success).toBe(false);
  });

  test("a collage without the stagger flag is refused", () => {
    const { stagger: _s, ...without } = collageClip(1, "collage2", 2);
    expect(MontageDraft.safeParse(spec({ clips: [without] })).success).toBe(false);
  });

  test("every cell may carry its own focus, or none", () => {
    const value = collageClip(1, "collage2", 2);
    const mixed = { ...value, cells: [{ ...cell(1), focus: { x: 0, y: 1 } }, { ...cell(2), focus: null }] };
    expect(MontageSpec.safeParse(spec({ clips: [mixed] })).success).toBe(true);
  });
});

// ---------- empty cells (drafts) ----------

describe("empty cells", () => {
  const emptyCell = { photo: null, focus: null };

  test("a draft may have an empty cell in a collage: the owner picks a layout first and drops photos later", () => {
    const value = spec({ clips: [{ ...collageClip(1, "collage3", 3), cells: [cell(1), emptyCell, emptyCell] }] });
    expect(MontageDraft.safeParse(value).success).toBe(true);
    expect(issuesOf(value, "draft")).toEqual([]);
  });

  test("a draft may have an empty photo clip", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...photoClip(1), cell: emptyCell }] })).success).toBe(true);
  });

  test("a spec refuses an empty cell, naming it", () => {
    const value = spec({ clips: [{ ...collageClip(1, "collage3", 3), cells: [cell(1), emptyCell, emptyCell] }] });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(issuesOf(value, "spec")).toEqual([
      { code: "cell-empty", path: ["clips", 0, "cells", 1] },
      { code: "cell-empty", path: ["clips", 0, "cells", 2] },
    ]);
  });

  test("a spec names an empty single-photo cell", () => {
    const value = spec({ clips: [{ ...photoClip(1), cell: emptyCell }] });
    expect(issuesOf(value, "spec")).toEqual([{ code: "cell-empty", path: ["clips", 0, "cell"] }]);
  });

  test("the shape-only schema lets an empty cell through, so the engine can list it", () => {
    expect(MontageShape.safeParse(spec({ clips: [{ ...photoClip(1), cell: emptyCell }] })).success).toBe(true);
  });

  test("empty cells never count as the same photo twice", () => {
    const value = spec({ clips: [{ ...collageClip(1, "collage2", 2), cells: [emptyCell, emptyCell] }] });
    expect(issuesOf(value, "draft")).toEqual([]);
  });

  test("a cell without the photo key is refused: null is the only way to say empty", () => {
    expect(MontageDraft.safeParse(spec({ clips: [{ ...photoClip(1), cell: { focus: null } }] })).success).toBe(false);
  });
});

// ---------- focus ----------

describe("focus", () => {
  const withFocus = (focus: unknown) => spec({ clips: [{ ...photoClip(1), cell: { ...cell(1), focus } }] });

  test("the corners of the frame are valid focus points", () => {
    expect(MontageSpec.safeParse(withFocus({ x: 0, y: 0 })).success).toBe(true);
    expect(MontageSpec.safeParse(withFocus({ x: 1, y: 1 })).success).toBe(true);
  });

  test("a focus outside 0..1 is refused", () => {
    expect(MontageSpec.safeParse(withFocus({ x: 1.01, y: 0.5 })).success).toBe(false);
    expect(MontageSpec.safeParse(withFocus({ x: 0.5, y: -0.01 })).success).toBe(false);
  });

  test("a NaN focus is refused", () => {
    expect(MontageSpec.safeParse(withFocus({ x: Number.NaN, y: 0.5 })).success).toBe(false);
  });

  test("a focus with an extra key is refused", () => {
    expect(MontageSpec.safeParse(withFocus({ x: 0.5, y: 0.5, z: 1 })).success).toBe(false);
  });

  test("a headless spec may leave the focus null", () => {
    expect(MontageSpec.safeParse(withFocus(null)).success).toBe(true);
  });

  test("a missing focus is refused: null is the only way to say unresolved", () => {
    const { focus: _f, ...bare } = cell(1);
    expect(MontageSpec.safeParse(spec({ clips: [{ ...photoClip(1), cell: bare }] })).success).toBe(false);
  });
});

// ---------- one scene photo, once ----------

describe("a scene photo appears at most once", () => {
  test("the same scene photo in two clips is refused", () => {
    const second = { ...photoClip(2, 4_000), cell: cell(1) };
    const value = spec({ clips: [photoClip(1, 4_000), second] });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(issuesOf(value, "spec")).toEqual([{ code: "photo-repeated", path: ["clips", 1, "cell"] }]);
  });

  test("the same scene photo twice in one collage is refused", () => {
    const value = spec({ clips: [{ ...collageClip(1, "collage2", 2), cells: [cell(5), cell(5)] }] });
    expect(issuesOf(value, "spec")).toEqual([{ code: "photo-repeated", path: ["clips", 0, "cells", 1] }]);
  });

  test("a scene photo in a photo clip and in a collage is refused", () => {
    const value = spec({ clips: [photoClip(1, 4_000), { ...collageClip(2, "collage2", 2), cells: [cell(9), cell(1)] }] });
    expect(issuesOf(value, "spec")).toEqual([{ code: "photo-repeated", path: ["clips", 1, "cells", 1] }]);
  });

  test("the rule holds for a draft too", () => {
    const value = spec({ clips: [photoClip(1, 4_000), { ...photoClip(2, 4_000), cell: cell(1) }] });
    expect(MontageDraft.safeParse(value).success).toBe(false);
  });

  test("an own upload may repeat: only scene photos are counted", () => {
    const own = (n: number) => ({ ...photoClip(n, 4_000), cell: { photo: { source: "own", mediaId: "media-0001" }, focus: null } });
    expect(MontageSpec.safeParse(spec({ clips: [own(1), own(2)] })).success).toBe(true);
  });

  test("an own upload never collides with a scene photo of a similar id", () => {
    const sceneClip = { ...photoClip(1, 4_000), cell: { photo: { source: "scene", photoId: "same-id-0001" }, focus: null } };
    const ownClip = { ...photoClip(2, 4_000), cell: { photo: { source: "own", mediaId: "same-id-0001" }, focus: null } };
    expect(MontageSpec.safeParse(spec({ clips: [sceneClip, ownClip] })).success).toBe(true);
  });
});

// ---------- layers ----------

describe("layer counts", () => {
  const texts = (n: number) => Array.from({ length: n }, (_, k) => textLayer(k + 1));
  const stickers = (n: number) => Array.from({ length: n }, (_, k) => stickerLayer(k + 1));

  test("10 text layers are allowed", () => {
    expect(MontageSpec.safeParse(spec({ layers: texts(MAX_TEXT_LAYERS) })).success).toBe(true);
  });

  test("11 text layers are refused", () => {
    const value = spec({ layers: texts(MAX_TEXT_LAYERS + 1) });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(issuesOf(value, "spec")).toEqual([{ code: "too-many-text-layers", path: ["layers"] }]);
  });

  test("10 sticker layers are allowed", () => {
    expect(MontageSpec.safeParse(spec({ layers: stickers(MAX_STICKER_LAYERS) })).success).toBe(true);
  });

  test("11 sticker layers are refused", () => {
    const value = spec({ layers: stickers(MAX_STICKER_LAYERS + 1) });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(issuesOf(value, "spec")).toEqual([{ code: "too-many-sticker-layers", path: ["layers"] }]);
  });

  test("10 text and 10 sticker layers together are allowed", () => {
    const value = spec({ layers: [...texts(10), ...stickers(10)] });
    expect(value.layers.length).toBe(MAX_LAYERS);
    expect(MontageSpec.safeParse(value).success).toBe(true);
  });

  test("21 layers in all are refused whatever their kinds", () => {
    const value = spec({ layers: [...texts(10), ...stickers(10), textLayer(50)] });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(MontageDraft.safeParse(value).success).toBe(false);
  });

  test("the layer caps hold for a draft too", () => {
    expect(MontageDraft.safeParse(spec({ layers: texts(11) })).success).toBe(false);
    expect(MontageDraft.safeParse(spec({ layers: stickers(11) })).success).toBe(false);
  });

  test("two layers with the same layerId are refused", () => {
    const value = spec({ layers: [textLayer(1), textLayer(2, { layerId: id("layer", 1) })] });
    expect(issuesOf(value, "spec")).toEqual([{ code: "duplicate-layer-id", path: ["layers", 1, "layerId"] }]);
  });
});

describe("layer times", () => {
  const layered = (over: Record<string, unknown>, clipMs = 4_000) => spec({ clips: [photoClip(1, clipMs)], layers: [textLayer(1, over)] });

  test("a layer may run over the whole timeline", () => {
    expect(MontageSpec.safeParse(layered({ startMs: 0, endMs: 4_000 })).success).toBe(true);
  });

  test("a layer ending 100 ms after the timeline is refused in a spec", () => {
    const value = layered({ startMs: 1_000, endMs: 4_100 });
    expect(MontageSpec.safeParse(value).success).toBe(false);
    expect(issuesOf(value, "spec")).toEqual([{ code: "layer-outside-timeline", path: ["layers", 0, "endMs"] }]);
  });

  test("a layer past the timeline is only a draft's business: the draft keeps it until the clips settle", () => {
    expect(MontageDraft.safeParse(layered({ startMs: 1_000, endMs: 4_100 })).success).toBe(true);
  });

  test("a layer may not end after 15 s, even in a draft", () => {
    expect(MontageDraft.safeParse(layered({ startMs: 0, endMs: 15_100 })).success).toBe(false);
  });

  test("a layer of 300 ms is the shortest allowed", () => {
    expect(MontageSpec.safeParse(layered({ startMs: 1_000, endMs: 1_300 })).success).toBe(true);
  });

  test("a layer of 200 ms is too short", () => {
    const value = layered({ startMs: 1_000, endMs: 1_200 });
    expect(issuesOf(value, "spec")).toEqual([{ code: "layer-too-short", path: ["layers", 0] }]);
  });

  test("a layer that ends where it starts is too short", () => {
    expect(codes(issuesOf(layered({ startMs: 1_000, endMs: 1_000 }), "draft"))).toEqual(["layer-too-short"]);
  });

  test("a layer that ends before it starts is too short", () => {
    expect(codes(issuesOf(layered({ startMs: 2_000, endMs: 1_000 }), "draft"))).toEqual(["layer-too-short"]);
  });

  test("a layer start that is not a multiple of 100 ms is refused", () => {
    expect(MontageDraft.safeParse(layered({ startMs: 50 })).success).toBe(false);
  });

  test("a layer end that is not a multiple of 100 ms is refused", () => {
    expect(MontageDraft.safeParse(layered({ endMs: 3_050 })).success).toBe(false);
  });

  test("a negative layer start is refused", () => {
    expect(MontageDraft.safeParse(layered({ startMs: -100 })).success).toBe(false);
  });
});

// ---------- text layers ----------

describe("text layers", () => {
  const withText = (over: Record<string, unknown>) => spec({ layers: [textLayer(1, over)] });

  test("a caption of 60 characters is accepted", () => {
    expect(MontageSpec.safeParse(withText({ value: "a".repeat(60) })).success).toBe(true);
  });

  test("a caption of 61 characters is refused", () => {
    expect(MontageSpec.safeParse(withText({ value: "a".repeat(61) })).success).toBe(false);
  });

  test("an empty caption is refused", () => {
    expect(MontageSpec.safeParse(withText({ value: "" })).success).toBe(false);
  });

  test("a ZWJ family emoji counts as one character, not eleven code units", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    expect(MontageSpec.safeParse(withText({ value: family.repeat(60) })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ value: family.repeat(61) })).success).toBe(false);
  });

  test("a caption over 1024 UTF-16 units is refused, even one made of a single grapheme", () => {
    expect(MontageSpec.safeParse(withText({ value: `a${"\u0301".repeat(1_100)}` })).success).toBe(false);
  });

  test("60 of the longest emoji sequences (15 units each, 900 in all) fit under the unit bound", () => {
    // Two people with skin tones and a kiss mark: the longest RGI sequence, 15 UTF-16 units.
    const kiss = "\u{1F9D1}\u{1F3FB}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F9D1}\u{1F3FC}";
    expect(kiss).toHaveLength(15);
    expect(kiss.repeat(60)).toHaveLength(900);
    expect(MontageSpec.safeParse(withText({ value: kiss.repeat(60) })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ value: kiss.repeat(61) })).success).toBe(false);
  });

  test("a caption over the unit bound is refused without ever being segmented into graphemes", () => {
    const Original = Intl.Segmenter;
    let segmenters = 0;
    class Counting extends Original {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        segmenters++;
      }
    }
    Object.defineProperty(Intl, "Segmenter", { value: Counting, configurable: true, writable: true });
    try {
      expect(MontageSpec.safeParse(withText({ value: "a".repeat(100_000) })).success).toBe(false);
      expect(segmenters).toBe(0);
      expect(MontageSpec.safeParse(withText({ value: "a".repeat(60) })).success).toBe(true);
      expect(segmenters).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(Intl, "Segmenter", { value: Original, configurable: true, writable: true });
    }
  });

  test.each([
    ["a C0 control character", "a\u0001b"],
    ["a lone carriage return", "line one\rline two"],
    ["a carriage return that ends the text", "line one\r"],
    ["a line feed then a carriage return", "line one\n\rline two"],
    ["a vertical tab", "a\u000Bb"],
    ["a form feed", "a\u000Cb"],
    ["NEL", "a\u0085b"],
    ["a tab", "a\tb"],
    ["DEL", "a\u007fb"],
    ["a C1 control character", "a\u0085b"],
    ["a right-to-left override", "a\u202Eb"],
    ["a left-to-right embedding", "a\u202Ab"],
    ["a bidi isolate", "a\u2066b"],
    ["a pop directional isolate", "a\u2069b"],
    ["a lone high surrogate", "a\uD800b"],
    ["a lone low surrogate", "a\uDC00b"],
  ])("refuses %s: resvg would crash on it or the text would read otherwise than it shows", (_label, value) => {
    expect(MontageSpec.safeParse(withText({ value })).success).toBe(false);
  });

  test.each([
    ["a line feed", "line one\nline two"],
    ["a CRLF", "line one\r\nline two"],
    ["a trailing line feed", "line one\n"],
    ["three lines (the engine's caption rules count lines, not the schema)", "a\nb\nc"],
  ])("accepts %s: the only line breaks a caption may hold", (_label, value) => {
    expect(MontageSpec.safeParse(withText({ value })).success).toBe(true);
  });

  test("a line break is still one of the 60 characters", () => {
    expect(MontageSpec.safeParse(withText({ value: `${"a".repeat(30)}\r\n${"b".repeat(29)}` })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ value: `${"a".repeat(30)}\n${"b".repeat(30)}` })).success).toBe(false);
  });

  test("a well-formed surrogate pair is fine", () => {
    expect(MontageSpec.safeParse(withText({ value: "coffee \u{2615}" })).success).toBe(true);
  });

  test("a caption with a control character is refused in a draft too", () => {
    expect(MontageDraft.safeParse(withText({ value: "a\u0001b" })).success).toBe(false);
  });

  test("a colour is a lowercase #rrggbb: the text colour in every style", () => {
    expect(MontageSpec.safeParse(withText({ color: "#ffffff" })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ color: "#0a1b2c" })).success).toBe(true);
  });

  test.each(["#FFFFFF", "#fff", "#ggg000", "red", "rgb(0,0,0)", "ffffff", "#ffffff00", "url(x)", ""])("refuses the colour %p", (color) => {
    expect(MontageSpec.safeParse(withText({ color })).success).toBe(false);
  });

  test("a text layer without a colour is refused", () => {
    const { color: _c, ...bare } = textLayer(1);
    expect(MontageSpec.safeParse(spec({ layers: [bare] })).success).toBe(false);
  });

  test("the schema bounds length only: Cyrillic is left to the engine's caption rules", () => {
    expect(MontageSpec.safeParse(withText({ value: "Привет" })).success).toBe(true);
  });

  test("scale 0.5 and 2 are the limits", () => {
    expect(MontageSpec.safeParse(withText({ scale: 0.5 })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ scale: 2 })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ scale: 0.49 })).success).toBe(false);
    expect(MontageSpec.safeParse(withText({ scale: 2.01 })).success).toBe(false);
  });

  test("the position is a centre inside the frame", () => {
    expect(MontageSpec.safeParse(withText({ x: 0, y: 1 })).success).toBe(true);
    expect(MontageSpec.safeParse(withText({ x: -0.1 })).success).toBe(false);
    expect(MontageSpec.safeParse(withText({ y: 1.1 })).success).toBe(false);
  });

  test.each(["manrope", "playfair", "oswald", "ptmono", "caveat"])("font %s is accepted", (font) => {
    expect(MontageSpec.safeParse(withText({ font })).success).toBe(true);
  });

  test("a font outside the bundled five is refused", () => {
    expect(MontageSpec.safeParse(withText({ font: "comic-sans" })).success).toBe(false);
  });

  test.each(["none", "plaque", "outline"])("style %s is accepted", (style) => {
    expect(MontageSpec.safeParse(withText({ style })).success).toBe(true);
  });

  test("a style outside the three is refused", () => {
    expect(MontageSpec.safeParse(withText({ style: "shadow" })).success).toBe(false);
  });
});

// ---------- sticker layers ----------

describe("sticker layers", () => {
  const withSticker = (over: Record<string, unknown>) => spec({ layers: [stickerLayer(1, over)] });

  test("size 0.05 and 0.6 of the frame width are the limits", () => {
    expect(MontageSpec.safeParse(withSticker({ size: 0.05 })).success).toBe(true);
    expect(MontageSpec.safeParse(withSticker({ size: 0.6 })).success).toBe(true);
    expect(MontageSpec.safeParse(withSticker({ size: 0.04 })).success).toBe(false);
    expect(MontageSpec.safeParse(withSticker({ size: 0.61 })).success).toBe(false);
  });

  test("a built-in and an own sticker are both accepted", () => {
    expect(MontageSpec.safeParse(withSticker({ sticker: { source: "builtin", stickerId: "sticker-heart" } })).success).toBe(true);
    expect(MontageSpec.safeParse(withSticker({ sticker: { source: "own", mediaId: "media-0001" } })).success).toBe(true);
  });

  test("a sticker taken from a URL is refused", () => {
    expect(MontageSpec.safeParse(withSticker({ sticker: { source: "url", url: "https://example.com/a.gif" } })).success).toBe(false);
  });

  test("a sticker id with a path in it is refused", () => {
    expect(MontageSpec.safeParse(withSticker({ sticker: { source: "builtin", stickerId: "../../secret" } })).success).toBe(false);
  });

  test("the position is a centre inside the frame", () => {
    expect(MontageSpec.safeParse(withSticker({ x: 1.2 })).success).toBe(false);
  });
});

// ---------- music ----------

describe("music", () => {
  test("no music is null", () => {
    expect(MontageSpec.safeParse(spec({ music: null })).success).toBe(true);
  });

  test("a trending track starts at a whole millisecond offset", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "trending", trackId: "4199287736976977", startMs: 0 } })).success).toBe(true);
  });

  test("a negative start is refused", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "trending", trackId: "4199287736976977", startMs: -1 } })).success).toBe(false);
  });

  test("a fractional start is refused", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "trending", trackId: "4199287736976977", startMs: 0.5 } })).success).toBe(false);
  });

  test("an unknown source is refused", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "spotify", trackId: "4199287736976977", startMs: 0 } })).success).toBe(false);
  });

  test("a trending track needs its trackId and an own track its mediaId", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "trending", startMs: 0 } })).success).toBe(false);
    expect(MontageSpec.safeParse(spec({ music: { source: "own", trackId: "4199287736976977", startMs: 0 } })).success).toBe(false);
  });

  test("a track with a fade field is refused: the owner wants no fades", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "trending", trackId: "4199287736976977", startMs: 0, fadeMs: 500 } })).success).toBe(false);
  });
});

// ---------- seed ----------

describe("seed", () => {
  test("0 and the largest uint32 are accepted", () => {
    expect(MontageSpec.safeParse(spec({ seed: 0 })).success).toBe(true);
    expect(MontageSpec.safeParse(spec({ seed: 4_294_967_295 })).success).toBe(true);
  });

  test("one past uint32, a negative and a fraction are refused", () => {
    expect(MontageSpec.safeParse(spec({ seed: 4_294_967_296 })).success).toBe(false);
    expect(MontageSpec.safeParse(spec({ seed: -1 })).success).toBe(false);
    expect(MontageSpec.safeParse(spec({ seed: 1.5 })).success).toBe(false);
  });
});

// ---------- strictness ----------

describe("unknown keys", () => {
  test("the spec itself refuses one", () => {
    expect(MontageSpec.safeParse(spec({ title: "x" })).success).toBe(false);
    expect(MontageDraft.safeParse(spec({ title: "x" })).success).toBe(false);
  });

  test("a clip refuses one", () => {
    expect(MontageSpec.safeParse(spec({ clips: [{ ...photoClip(1), volume: 1 }] })).success).toBe(false);
  });

  test("a cell refuses one", () => {
    expect(MontageSpec.safeParse(spec({ clips: [{ ...photoClip(1), cell: { ...cell(1), path: "/etc/passwd" } }] })).success).toBe(false);
  });

  test("a photo reference refuses one", () => {
    const bad = { ...photoClip(1), cell: { photo: { source: "scene", photoId: id("photo", 1), path: "/x" }, focus: null } };
    expect(MontageSpec.safeParse(spec({ clips: [bad] })).success).toBe(false);
  });

  test("a layer refuses one", () => {
    expect(MontageSpec.safeParse(spec({ layers: [textLayer(1, { color: "#fff" })] })).success).toBe(false);
  });

  test("music refuses one", () => {
    expect(MontageSpec.safeParse(spec({ music: { source: "own", mediaId: "media-0001", startMs: 0, path: "/x" } })).success).toBe(false);
  });

  test("the shape-only schemas refuse them too", () => {
    expect(MontageShape.safeParse(spec({ title: "x" })).success).toBe(false);
  });
});

// ---------- draft versus spec ----------

describe("draft versus spec", () => {
  test("every valid spec is also a valid draft", () => {
    const value = spec({ clips: [collageClip(1, "collage2", 2, 10, 5_000), photoClip(2, 5_000)], layers: [textLayer(1)] });
    expect(MontageSpec.safeParse(value).success).toBe(true);
    expect(MontageDraft.safeParse(value).success).toBe(true);
  });

  test("an empty draft is not a spec", () => {
    const empty = spec({ clips: [] });
    expect(MontageDraft.safeParse(empty).success).toBe(true);
    expect(MontageSpec.safeParse(empty).success).toBe(false);
  });

  test("a draft's issue list still reports what a draft may not do, while a spec's adds its completeness rules", () => {
    const value = spec({ clips: [photoClip(1, 1_000)], layers: [textLayer(1, { endMs: 2_000 })] });
    expect(issuesOf(value, "draft")).toEqual([]);
    expect(issuesOf(value, "spec").map((i) => i.code)).toEqual(["layer-outside-timeline", "duration-too-short"]);
  });

  test("the shape-only schema lets a structurally invalid spec through, so the engine can list why", () => {
    const value = spec({ clips: [photoClip(1, 3_900)] });
    expect(MontageShape.safeParse(value).success).toBe(true);
    expect(MontageSpec.safeParse(value).success).toBe(false);
  });

  test("the shape-only schema lets an empty montage through: no-clips is an issue, not a shape error", () => {
    expect(MontageShape.safeParse(spec({ clips: [] })).success).toBe(true);
  });

  test("the shape-only schema still refuses a broken shape", () => {
    expect(MontageShape.safeParse(spec({ clips: clips(21, 700) })).success).toBe(false);
    expect(MontageShape.safeParse(spec({ clips: [{ ...photoClip(1), durationMs: 450 }] })).success).toBe(false);
  });
});

// ---------- the issue list ----------

describe("montageIssues", () => {
  test("is empty for a valid spec", () => {
    expect(issuesOf(spec(), "spec")).toEqual([]);
  });

  test("lists every problem, not only the first", () => {
    const value = spec({
      clips: [photoClip(1, 1_000), { ...photoClip(2, 1_000), clipId: id("clip", 1), cell: cell(1) }],
      layers: [textLayer(1, { startMs: 500, endMs: 600 })],
    });
    expect(new Set(codes(issuesOf(value, "spec")))).toEqual(
      new Set(["duplicate-clip-id", "photo-repeated", "layer-too-short", "duration-too-short"]),
    );
  });

  test("is bounded, so an error carrying it stays small", () => {
    const layers = Array.from({ length: 20 }, () => textLayer(1, { startMs: 0, endMs: 100 }));
    const value = spec({ layers, clips: clips(20, 500).map((c) => ({ ...c, clipId: id("clip", 1), cell: cell(1) })) });
    const issues = issuesOf(value, "draft");
    expect(issues.length).toBe(MAX_MONTAGE_ISSUES);
  });

  test("gives the same answer twice for the same input", () => {
    const value = spec({ clips: [photoClip(1, 3_000)] });
    expect(issuesOf(value, "spec")).toEqual(issuesOf(value, "spec"));
  });

  test("a failed parse names the codes and paths, never the submitted values", () => {
    const value = spec({ layers: [textLayer(1, { value: "secret caption", startMs: 1_000, endMs: 1_100 })] });
    const parsed = MontageSpec.safeParse(value);
    expect(parsed.success).toBe(false);
    const reason = JSON.stringify(parsed.error?.issues ?? []);
    expect(reason).toContain("layer-too-short");
    expect(reason).not.toContain("secret caption");
  });
});

describe("MontageIssue", () => {
  test("accepts a code with a path", () => {
    expect(MontageIssue.safeParse({ code: "layer-too-short", path: ["layers", 0] }).success).toBe(true);
  });

  test("rejects a code outside the closed set", () => {
    expect(MontageIssue.safeParse({ code: "looks-wrong", path: [] }).success).toBe(false);
  });

  test("rejects free text: the message lives in the Russian map", () => {
    expect(MontageIssue.safeParse({ code: "layer-too-short", path: [], message: "too short" }).success).toBe(false);
  });

  test("bounds the path", () => {
    expect(MontageIssue.safeParse({ code: "layer-too-short", path: Array.from({ length: 7 }, () => 0) }).success).toBe(false);
  });

  test("the closed set has no repeats", () => {
    const codesList: readonly MontageIssueCode[] = MONTAGE_ISSUE_CODES;
    expect(new Set(codesList).size).toBe(codesList.length);
  });
});

// ---------- the engine-only issue codes (K7) ----------

describe("the engine-only issue codes", () => {
  const ENGINE_ONLY = ["photo-unavailable", "not-yet-supported", "caption-invalid", "media-unavailable", "sticker-unavailable", "track-unavailable", "track-too-short"] as const;

  test.each([...ENGINE_ONLY])("%s is a known code", (code) => {
    expect(MontageIssue.safeParse({ code, path: [] }).success).toBe(true);
  });

  test.each(["caption-invalid", "media-unavailable", "sticker-unavailable", "track-unavailable", "track-too-short"] as const)("the shared checks never produce %s", (code) => {
    const busy = spec({
      clips: [photoClip(1, 8_000), videoClip(2, 5_000)],
      layers: [textLayer(1), stickerLayer(1)],
      music: { source: "own", mediaId: id("media", 9), startMs: 0 },
    });
    expect(codes(issuesOf(busy, "spec"))).not.toContain(code);
  });
});

// ---------- the saved draft (K1, K3) ----------

describe("Montage", () => {
  const stored = (over: Record<string, unknown> = {}) => ({ montageId: "montage-0001", name: null, spec: spec({ clips: [] }), updatedAt: "2026-09-30T10:00:00.000Z", ...over });

  test("a new draft has no name: null is the name montages.create stores", () => {
    expect(Montage.safeParse(stored()).success).toBe(true);
  });

  test("a named draft keeps its name", () => {
    expect(Montage.parse(stored({ name: "Кафе и город" })).name).toBe("Кафе и город");
  });

  test("an empty name is refused: null is the way to say unnamed", () => {
    expect(Montage.safeParse(stored({ name: "" })).success).toBe(false);
  });

  test("a missing name is refused", () => {
    const { name: _name, ...rest } = stored();
    expect(Montage.safeParse(rest).success).toBe(false);
  });

  test("the draft may have no clips at all", () => {
    expect(Montage.safeParse(stored({ spec: spec({ clips: [] }) })).success).toBe(true);
  });
});

describe("MontageListItem", () => {
  const item = (issueCount: number, over: Record<string, unknown> = {}) => ({
    montage: { montageId: "montage-0001", name: null, spec: spec({ clips: [] }), updatedAt: "2026-09-30T10:00:00.000Z" },
    issues: Array.from({ length: issueCount }, () => ({ code: "photo-unavailable", path: ["clips", 0, "cell"] })),
    videoCount: 0,
    ...over,
  });

  test("lists at most 200 drafts per answer", () => {
    expect(MAX_LISTED_MONTAGES).toBe(200);
  });

  test("64 issues are allowed", () => {
    expect(MontageListItem.safeParse(item(64)).success).toBe(true);
  });

  test("65 issues are refused", () => {
    expect(MontageListItem.safeParse(item(65)).success).toBe(false);
  });

  test("no issues is fine: the draft is ready", () => {
    expect(MontageListItem.safeParse(item(0)).success).toBe(true);
  });

  test("a negative video count is refused", () => {
    expect(MontageListItem.safeParse(item(0, { videoCount: -1 })).success).toBe(false);
  });

  test("an item without its video count is refused", () => {
    const { videoCount: _count, ...rest } = item(0);
    expect(MontageListItem.safeParse(rest).success).toBe(false);
  });
});
