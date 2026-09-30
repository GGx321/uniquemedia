import { z } from "zod";
import { Count, Id } from "./primitives";

// The Stage 3 montage contract (plan: "Montage as data — MontageSpec v1").
//
// A montage is a timeline: clips played back to back (a photo, a collage of
// two to four photos, or one of the owner's own videos), overlay layers (text
// and stickers) with their own time ranges, and at most one music track. It
// is the only input a render takes, and the renderer, the engine and Stage
// 4's autopilot all produce and consume this one shape.
//
// Validation has two halves:
// - the SHAPE (`MontageShape`): field types, bounds,
//   array caps. A payload that breaks it is a VALIDATION error;
// - the STRUCTURE (`montageIssues`): rules that span fields (the total
//   length, layers against the timeline, a collage's cell count, repeated
//   photos). It answers a closed list of issue codes, which is what
//   MONTAGE_INVALID carries. `MontageSpec` and `MontageDraft` are the shape
//   plus that structure, so nothing stored or returned can be malformed.
//
// The referential half (is this photo eligible, does that media exist) needs
// the library and stays in the engine.

// ---------- limits ----------

/** A montage lasts 4.0 to 15.0 s. */
export const MIN_TOTAL_MS = 4_000;
export const MAX_TOTAL_MS = 15_000;
/** Every clip duration and layer time is a multiple of this: 3 frames at 30 fps, so frame counts are integers. */
export const TIME_STEP_MS = 100;
export const MIN_CLIP_MS = 500;
export const MAX_CLIPS = 20;
export const MIN_LAYER_MS = 300;
export const MAX_TEXT_LAYERS = 10;
export const MAX_STICKER_LAYERS = 10;
export const MAX_LAYERS = MAX_TEXT_LAYERS + MAX_STICKER_LAYERS;
/** A caption is 1 to 60 graphemes (the engine's caption rules add the charset and the line count). */
export const MAX_CAPTION_GRAPHEMES = 60;
/**
 * The longest caption in UTF-16 code units: a cheap bound that runs before the
 * text is segmented into graphemes, and stops the checks after it (`Caption`
 * aborts on it), so an enormous string never reaches the segmenter. Sixty of the
 * longest emoji sequences (15 units, 900 in all: two people with skin tones and
 * a kiss mark) always fit under it.
 */
export const MAX_CAPTION_UNITS = 1024;
/** The furthest into an own video or track a trim or a start may point: 10 minutes, the longest own music. */
export const MAX_SOURCE_OFFSET_MS = 600_000;
/** An issue list is cut at this many entries, so an error that carries it stays small. */
export const MAX_MONTAGE_ISSUES = 64;

// ---------- pieces ----------

/** A time on the timeline: a whole number of 100 ms steps, within the longest montage. */
const TimelineMs = z.number().int().min(0).max(MAX_TOTAL_MS).multipleOf(TIME_STEP_MS);

const ClipDurationMs = z.number().int().min(MIN_CLIP_MS).max(MAX_TOTAL_MS).multipleOf(TIME_STEP_MS);

/** A position inside a source photo, as fractions of its width and height; the crop keeps it in frame. */
export const Focus = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const Motion = z.enum(["kenburns", "pan", "static"]);

/**
 * A photo a cell shows: a generated scene photo of the montage's avatar
 * (`source: "scene"`), or one of the owner's own uploads (`source: "own"`,
 * slice 3f). Only scene photos take part in the used/unused accounting.
 */
export const PhotoRef = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("scene"), photoId: Id }),
  z.strictObject({ source: z.literal("own"), mediaId: Id }),
]);

/**
 * One photo in a clip. `photo` is null for an empty cell: the owner may pick a
 * collage layout first and drop photos later, so a draft can hold empty cells;
 * a spec cannot (`cell-empty`). `focus` is null only from headless callers that
 * leave it to the engine; the editor resolves it when a photo is placed and
 * always stores it.
 */
export const Cell = z.strictObject({ photo: PhotoRef.nullable(), focus: Focus.nullable() });

export const CollageLayout = z.enum(["collage2", "collage3", "collage4"]);

/** How many cells each collage layout has. */
export const COLLAGE_CELL_COUNT = { collage2: 2, collage3: 3, collage4: 4 } as const satisfies Record<z.infer<typeof CollageLayout>, number>;

const clipBase = {
  clipId: Id,
  durationMs: ClipDurationMs,
  /** Hard cuts only for now (V1); the literal stays so a crossfade can be added without breaking the shape. */
  transitionIn: z.literal("cut"),
};

export const PhotoClip = z.strictObject({ ...clipBase, kind: z.literal("photo"), cell: Cell, motion: Motion });

export const CollageClip = z.strictObject({
  ...clipBase,
  kind: z.literal("collage"),
  layout: CollageLayout,
  /** 2 to 4 cells; that the count matches `layout` is a structural rule (`cells-layout-mismatch`). */
  cells: z.array(Cell).min(2).max(4),
  motion: Motion,
  stagger: z.boolean(),
});

/** One of the owner's own videos (slice 3f). Static: it has no motion, and its audio is always dropped. */
export const VideoClip = z.strictObject({
  ...clipBase,
  kind: z.literal("video"),
  mediaId: Id,
  trimStartMs: z.number().int().min(0).max(MAX_SOURCE_OFFSET_MS),
  focus: Focus.nullable(),
});

export const Clip = z.discriminatedUnion("kind", [PhotoClip, CollageClip, VideoClip]);

/** The five bundled text fonts. */
export const TextFont = z.enum(["manrope", "playfair", "oswald", "ptmono", "caveat"]);
/** «Без фона» / «Плашка» / «Обводка». */
export const TextStyle = z.enum(["none", "plaque", "outline"]);

/** Characters as a person counts them (`Intl.Segmenter`): the one count the contract and the engine's caption rules share. */
export const graphemeCount = (text: string): number => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;

/**
 * Text no renderer should ever be handed: control characters (C0, DEL and C1;
 * resvg throws "non-XML character" on them, SP2) and the bidi overrides and
 * isolates that make text read otherwise than it is stored. The one exception
 * is the line break: LF and CRLF are how a caption gets its second line (the
 * engine's caption rules count the lines, at most two). A lone CR is refused.
 */
const UNSAFE_CHARS = /[^\P{Cc}\n\r]|\r(?!\n)|[\u202A-\u202E\u2066-\u2069]/u;
/** A surrogate half with no partner: not text at all. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * On-video text: 1 to 60 graphemes, at most `MAX_CAPTION_UNITS` code units
 * (checked first; a longer text fails there and nothing else runs on it), and
 * free of control characters, bidi overrides and lone surrogates. That much is
 * checked here, up front, because it is what could crash or mislead the
 * rasteriser. The charset itself (printable ASCII, a few typographic
 * marks, the emoji the bundled font covers) and the line count are the
 * engine's caption rules (slice 3b).
 */
export const Caption = z
  .string()
  .min(1)
  .max(MAX_CAPTION_UNITS, { abort: true })
  .refine((text) => !UNSAFE_CHARS.test(text), "must not contain control or bidi override characters")
  .refine((text) => !LONE_SURROGATE.test(text), "must be well-formed text")
  .refine((text) => graphemeCount(text) <= MAX_CAPTION_GRAPHEMES, `must be at most ${MAX_CAPTION_GRAPHEMES} characters`);

const layerBase = { layerId: Id, startMs: TimelineMs, endMs: TimelineMs };
const fraction = z.number().min(0).max(1);

/** A colour as lowercase `#rrggbb`. */
const HexColor = z.string().regex(/^#[0-9a-f]{6}$/, "must be #rrggbb in lowercase");

/**
 * A text box anchored at its centre. `color` is the TEXT colour in every
 * style; the style decides the rest: «Плашка» keeps its white plaque,
 * «Обводка» its black outline and «Без фона» its soft shadow. The editor's
 * default is the style's own default text colour.
 */
export const TextLayer = z.strictObject({
  ...layerBase,
  kind: z.literal("text"),
  value: Caption,
  font: TextFont,
  style: TextStyle,
  color: HexColor,
  x: fraction,
  y: fraction,
  scale: z.number().min(0.5).max(2),
});

/** A sticker anchored at its centre; `size` is a fraction of the frame width. */
export const StickerLayer = z.strictObject({
  ...layerBase,
  kind: z.literal("sticker"),
  sticker: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("builtin"), stickerId: Id }),
    z.strictObject({ source: z.literal("own"), mediaId: Id }),
  ]),
  x: fraction,
  y: fraction,
  size: z.number().min(0.05).max(0.6),
});

export const Layer = z.discriminatedUnion("kind", [TextLayer, StickerLayer]);

const sourceOffset = z.number().int().min(0).max(MAX_SOURCE_OFFSET_MS);

/** At most one track, baked in, with no fades. `trending` is a flashapi track; `own` is an upload (slice 3f). */
export const MontageMusic = z
  .discriminatedUnion("source", [
    z.strictObject({ source: z.literal("trending"), trackId: Id, startMs: sourceOffset }),
    z.strictObject({ source: z.literal("own"), mediaId: Id, startMs: sourceOffset }),
  ])
  .nullable();

// ---------- the shapes ----------

const common = {
  schemaVersion: z.literal(1),
  avatarId: Id,
  /** Layers in z-order, later on top. */
  layers: z.array(Layer).max(MAX_LAYERS),
  music: MontageMusic,
  /** Variety for the autopilot: the pan direction and Ken Burns in/out. */
  seed: z.number().int().min(0).max(4_294_967_295),
};

/**
 * The shape of every montage, spec or draft: 0 to 20 clips. Structure is
 * checked apart (`montageIssues`), so an empty or too-short montage is still
 * well formed here and gets the engine's issue list rather than a bare
 * VALIDATION error. `videos.render {spec}` takes this shape for that reason.
 */
export const MontageShape = z.strictObject({ ...common, clips: z.array(Clip).max(MAX_CLIPS) });

type Shape = z.infer<typeof MontageShape>;

// ---------- structure ----------

/**
 * Why a montage cannot be rendered (or saved). A closed set: the wording lives
 * in `MONTAGE_ISSUE_MESSAGES_RU` (errorMessagesRu.ts), never in the issue.
 *
 * - `no-clips`: a spec needs at least one clip;
 * - `duration-too-short` / `duration-too-long`: a spec's clips add up to less than 4.0 s or more than 15.0 s;
 * - `too-many-text-layers` / `too-many-sticker-layers`: more than 10 of a kind;
 * - `cells-layout-mismatch`: a collage's cell count is not its layout's;
 * - `cell-empty`: a spec's cell holds no photo (a draft may);
 * - `layer-too-short`: a layer is shorter than 300 ms (or ends before it starts);
 * - `layer-outside-timeline`: a spec's layer ends after its clips do;
 * - `duplicate-clip-id` / `duplicate-layer-id`: an id is used twice;
 * - `photo-repeated`: a scene photo appears more than once;
 * - `photo-unavailable`: the engine's answer for a cell whose scene photo is not eligible (PHOTO_UNAVAILABLE carries these); never produced here;
 * - `not-yet-supported`: the engine's own answer for a part whose slice has not landed (N9); never produced here.
 *
 * The last five are engine-only too (the referential half, never produced by `montageIssues`); `montages.get` and
 * `montages.list` report them next to the structural ones:
 * - `caption-invalid`: a text layer's caption breaks the engine's caption rules (`layers.i.value`);
 * - `media-unavailable`: an own media id is missing or of the wrong kind (`clips.i`, `clips.i.cells.j`, `music`, `layers.i.sticker`);
 * - `sticker-unavailable`: a sticker that is no longer available (`layers.i.sticker`);
 * - `track-unavailable`: the music track is gone (`music`);
 * - `track-too-short`: the track is shorter than its `startMs` plus the montage's total (`music`).
 */
export const MONTAGE_ISSUE_CODES = [
  "no-clips",
  "duration-too-short",
  "duration-too-long",
  "too-many-text-layers",
  "too-many-sticker-layers",
  "cells-layout-mismatch",
  "cell-empty",
  "layer-too-short",
  "layer-outside-timeline",
  "duplicate-clip-id",
  "duplicate-layer-id",
  "photo-repeated",
  "photo-unavailable",
  "not-yet-supported",
  "caption-invalid",
  "media-unavailable",
  "sticker-unavailable",
  "track-unavailable",
  "track-too-short",
] as const;

export const MontageIssueCode = z.enum(MONTAGE_ISSUE_CODES);
export type MontageIssueCode = z.infer<typeof MontageIssueCode>;

/** Where the issue is: `["clips", 2, "cells"]`. No values, so no text the owner typed can travel in it. */
const IssuePath = z.array(z.union([z.string().max(32), Count])).max(6);

export const MontageIssue = z.strictObject({ code: MontageIssueCode, path: IssuePath });
export type MontageIssue = z.infer<typeof MontageIssue>;

export type MontageMode = "draft" | "spec";

/**
 * Every structural problem of a montage, in a fixed order (clips, layers,
 * totals) and cut at `MAX_MONTAGE_ISSUES`.
 *
 * A draft may be incomplete: no clips, any total length, and layers not yet
 * fitted to the clips. Those four checks are a spec's alone; the rest hold for
 * both.
 */
export function montageIssues(montage: Shape, mode: MontageMode): MontageIssue[] {
  const issues: MontageIssue[] = [];
  const add = (code: MontageIssueCode, ...path: (string | number)[]) => {
    if (issues.length < MAX_MONTAGE_ISSUES) issues.push({ code, path });
  };

  const clipIds = new Set<string>();
  const scenePhotos = new Set<string>();
  const scenePhoto = (cellPhoto: z.infer<typeof PhotoRef> | null, ...path: (string | number)[]) => {
    if (cellPhoto === null) {
      if (mode === "spec") add("cell-empty", ...path);
      return;
    }
    if (cellPhoto.source !== "scene") return;
    if (scenePhotos.has(cellPhoto.photoId)) add("photo-repeated", ...path);
    scenePhotos.add(cellPhoto.photoId);
  };
  let totalMs = 0;
  montage.clips.forEach((clip, i) => {
    totalMs += clip.durationMs;
    if (clipIds.has(clip.clipId)) add("duplicate-clip-id", "clips", i, "clipId");
    clipIds.add(clip.clipId);
    if (clip.kind === "photo") scenePhoto(clip.cell.photo, "clips", i, "cell");
    if (clip.kind === "collage") {
      if (clip.cells.length !== COLLAGE_CELL_COUNT[clip.layout]) add("cells-layout-mismatch", "clips", i, "cells");
      clip.cells.forEach((cell, j) => scenePhoto(cell.photo, "clips", i, "cells", j));
    }
  });

  const layerIds = new Set<string>();
  montage.layers.forEach((layer, i) => {
    if (layerIds.has(layer.layerId)) add("duplicate-layer-id", "layers", i, "layerId");
    layerIds.add(layer.layerId);
    if (layer.endMs - layer.startMs < MIN_LAYER_MS) add("layer-too-short", "layers", i);
    else if (mode === "spec" && layer.endMs > totalMs) add("layer-outside-timeline", "layers", i, "endMs");
  });
  if (montage.layers.filter((l) => l.kind === "text").length > MAX_TEXT_LAYERS) add("too-many-text-layers", "layers");
  if (montage.layers.filter((l) => l.kind === "sticker").length > MAX_STICKER_LAYERS) add("too-many-sticker-layers", "layers");

  if (mode === "spec") {
    if (montage.clips.length === 0) add("no-clips", "clips");
    else if (totalMs < MIN_TOTAL_MS) add("duration-too-short", "clips");
    else if (totalMs > MAX_TOTAL_MS) add("duration-too-long", "clips");
  }
  return issues;
}

/** Turns the issue list into Zod issues, so a parse failure names the same codes and paths. */
function structural(mode: MontageMode) {
  return (montage: Shape, ctx: z.RefinementCtx) => {
    for (const issue of montageIssues(montage, mode)) ctx.addIssue({ code: "custom", message: issue.code, path: issue.path });
  };
}

/** A complete, renderable montage: the shape and every structural rule. Only `videos.render` needs one. */
export const MontageSpec = MontageShape.superRefine(structural("spec"));
export type MontageSpec = z.infer<typeof MontageSpec>;

/** A saved draft: the same shape, and the structure a draft can already satisfy. */
export const MontageDraft = MontageShape.superRefine(structural("draft"));
export type MontageDraft = z.infer<typeof MontageDraft>;

/** A saved montage's name as the owner sees it: 1 to 80 characters, no control characters. */
export const MontageName = z
  .string()
  .min(1)
  .max(80)
  .refine((name) => !/\p{Cc}/u.test(name), "must not contain control characters");

/**
 * A saved montage draft as the montage commands return it: the draft itself
 * (which may be incomplete: «Новый монтаж» starts with no clips) with its id,
 * its name and when it last changed. `name` is null until the owner names it
 * (`montages.create` stores null; the window shows «без названия»). The focus
 * of every placed photo is resolved by the time `montages.create` answers.
 */
export const Montage = z.strictObject({ montageId: Id, name: MontageName.nullable(), spec: MontageDraft, updatedAt: z.iso.datetime() });
export type Montage = z.infer<typeof Montage>;

/** `montages.list` answers at most this many drafts, newest `updatedAt` first: no cursor yet, like `MAX_LISTED_VIDEOS`. */
export const MAX_LISTED_MONTAGES = 200;

/** Everything wrong with a draft as the engine sees it now: the structural issues and the referential ones, bounded like an error's. */
export const MontageIssues = z.array(MontageIssue).max(MAX_MONTAGE_ISSUES);

/** A draft with the engine's verdict on it and how many videos were rendered from it (`montages.list`). */
export const MontageListItem = z.strictObject({ montage: Montage, issues: MontageIssues, videoCount: Count });
export type MontageListItem = z.infer<typeof MontageListItem>;

export type Clip = z.infer<typeof Clip>;
export type Layer = z.infer<typeof Layer>;
export type Cell = z.infer<typeof Cell>;
export type Focus = z.infer<typeof Focus>;
export type Motion = z.infer<typeof Motion>;
export type PhotoRef = z.infer<typeof PhotoRef>;
export type MontageMusic = z.infer<typeof MontageMusic>;
