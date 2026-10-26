import { z } from "zod";
import { CLIP_UNSUITABLE_REASONS } from "./errors";
import { Estimate } from "./estimate";
import { MontageName } from "./montage";
import { Count, Id, Micros } from "./primitives";
import { FileState, RelativePath } from "./video";

// Stage 5, 5b.1 «Оживить» (plan s5b1 §5.2, S5.V1): the clip contract. One photo becomes one clip; the clip is a paid job of kind `clip`, reviewed on a sheet before any money moves.
// Pure: this module imports zod and `shared/engine/*` only (the mock cannot import `engine/`, which is why the two switches below live here and not in the engine).
// `state.ts` imports this file for the job ladder, so nothing here may import `state.ts` (`Estimate` has its own module for that reason).

const IsoDateTime = z.iso.datetime();

// ---------- the switches ----------

/**
 * I5.47: what happens when Kling refuses a clip for its content. `auto`: after a refusal proven free, Grok runs by itself (the sheet's worst is the dearer of the two). `offer`: no automatic
 * Grok; a refusal proven free by the strict proof offers «Снять на Grok» as a new click at its own price (the sheet's worst is Kling alone). The default flips to `offer` if any later
 * reading shows a Kling content refusal billed.
 */
export const GROK_FALLBACK: "auto" | "offer" = "auto";

/**
 * I5.57: frames of «Смелая» (a photo whose category is `nightwear` or `beach`, i.e. whose content level is bold; from 5a.4 (wired by S5.BA6) also any category's photo drawn on the Seedream route, `isBoldFrame`: I5.79, every «Смелая» frame is Kling-only).
 * `kling-only`: offered, run on Kling alone with fallback `none`,
 * never on Grok (worst is Kling's reserve). `with-fallback`: like any other frame (the code and the tests only; nothing sets it in 5b.1). `off`: not suitable, reason `bold-off`.
 * `kling-only` is FINAL: the owner's answer to Q-A (2026-10-13), confirmed by probe P-V (3 of 3 clips completed, "Норм видео").
 */
export type BoldClipsMode = "kling-only" | "with-fallback" | "off";
export const BOLD_CLIPS: BoldClipsMode = "kling-only";

/**
 * I5.55: how an export turns the providers' 24 fps into the 30 the owner asked for. `duplicate`: plain `fps=30`, which repeats every fourth frame; the default since canary C3, where
 * the owner saw no difference between the three in a blind A/B/C and it encodes about 3x faster (5 s against 15 s for a 5 s clip). `interpolate`: motion-interpolated
 * (`minterpolate`), slower. `native24`: the file stays at 24 fps (only the owner picks it).
 */
export const EXPORT_FPS: "interpolate" | "duplicate" | "native24" = "duplicate";

/** `clips.list` answers at most this many clips, newest first. */
export const MAX_LISTED_CLIPS = 500;

/** 5b.2 (S5.WB1; plan s5b2 §5.2.1): a batch «Оживить выбранные» holds one to this many clips. */
export const MAX_BATCH_CLIPS = 20;

/**
 * 5b.2 (S5.WB1; I5.61): how many Kling attempts a batch keeps between their reserve and their settle or abandon. 1 under B1 (Q-E = 1: one at a time). B2 (optional, only after probe P-N and the owner's OK) may raise it to
 * 3 in one reviewed follow-up commit; the type already allows 1, 2 or 3 so that commit changes this line alone. Grok attempts run one at a time in every mode.
 */
export const MAX_CLIPS_IN_FLIGHT: 1 | 2 | 3 = 1;

// ---------- the sheet's choices ----------

/** std = Kling 3.0 std 720p; pro = Kling 3.0 pro 1080p. */
export const ClipQuality = z.enum(["std", "pro"]);
export type ClipQuality = z.infer<typeof ClipQuality>;

export const ClipSeconds = z.union([z.literal(5), z.literal(10)]);
export type ClipSeconds = z.infer<typeof ClipSeconds>;

/** What the owner picks on the sheet. `grok` only in mode `offer`, on a photo that allows a fallback (I5.47); anywhere else `clips.create` refuses it `grok-not-offered`. */
export const ClipModelChoice = z.enum(["kling", "grok"]);
export type ClipModelChoice = z.infer<typeof ClipModelChoice>;

/** The model that made (or tried to make) a file. */
export const ClipModelUsed = z.enum(["kling-std", "kling-pro", "grok"]);
export type ClipModelUsed = z.infer<typeof ClipModelUsed>;

/** The provider behind one attempt. */
export const ClipAttemptModel = ClipModelChoice;
export type ClipAttemptModel = z.infer<typeof ClipAttemptModel>;

/**
 * A motion id on the wire: the photo's own scene motion (`scene`), a code motion (`g-<slug>`), and, since 5b.2 part C (S5.WC1), a motion the vision writer suggested (`v-<1..999>`) or one the owner's own idea made
 * (`o-<1..999>`). Never free text (I5.51, I5.67): the engine resolves a `v-` or `o-` id from the photo's motion store and checks it again.
 */
export const ClipMotionId = z.union([
  z.literal("scene"),
  z.string().max(40).regex(/^g-[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be `scene`, g-<slug>, v-<1..999> or o-<1..999>"),
  z.string().regex(/^[vo]-[1-9][0-9]{0,2}$/, "must be `scene`, g-<slug>, v-<1..999> or o-<1..999>"),
]);
export type ClipMotionId = z.infer<typeof ClipMotionId>;

/**
 * The highest `v-<n>` / `o-<n>` number (review round 2, L2). Ids are NEVER reused while a photo's motion store lives (`MotionStoreFile.next` keeps `max issued + 1` per source, even after FIFO trimming), because
 * a list the owner still has open must never resolve an `o-1` to a different text than the one he read (I5.67: the English is seen before any video money). Reusing the range after 99 was the alternative; 999 is
 * unreachable in practice (hundreds of paid calls for one photo) and a source that has issued its last id refuses with `motions-full` instead of reusing one.
 */
export const MOTION_ID_MAX = 999;

/** Where a motion comes from: the photo's scene, the code's bank, the vision writer's suggestions, or the owner's own idea (5b.2 part C). */
export const CLIP_MOTION_SOURCES = ["scene", "code", "vision", "own"] as const;
export const ClipMotionSource = z.enum(CLIP_MOTION_SOURCES);
export type ClipMotionSource = z.infer<typeof ClipMotionSource>;

/** The source an id's form belongs to: `scene`, `g-…` code, `v-…` vision, `o-…` own. The id and the source of a motion always agree. */
export function clipMotionIdSource(id: string): ClipMotionSource {
  if (id === "scene") return "scene";
  if (id.startsWith("v-")) return "vision";
  if (id.startsWith("o-")) return "own";
  return "code";
}

/** The most a label may hold (Russian, the owner's own words cut by `ownIdeaLabel` for an own idea), and the most an English text from a model or from the owner's idea may hold (I5.66). */
export const MOTION_LABEL_MAX = 40;
export const MOTION_TEXT_MAX = 60;

/** How many choices of each source a photo's list holds at most (plan s5b2 §5.3, L2): the scene's own, the code's bank, the newest suggestions and the newest own ideas that still pass their check. */
export const CLIP_CHOICES_MAX = { scene: 1, code: 3, vision: 3, own: 2 } as const satisfies Record<ClipMotionSource, number>;
/** Nine in all: 1 + 3 + 3 + 2. */
export const CLIP_MOTIONS_MAX = CLIP_CHOICES_MAX.scene + CLIP_CHOICES_MAX.code + CLIP_CHOICES_MAX.vision + CLIP_CHOICES_MAX.own;

/**
 * What a model's or an owner's text must be to reach a video provider (I5.67, review round 2, L8): the vocabulary of the shipped motions. The 271 bank motions and the 7 code motions use lowercase letters, a space and a
 * comma only (`engine/clips/motionCharset.test.ts` proves every one passes this); digits, `.`, `'` and `-` are allowed on top, and capitals. Nothing that could be markup, a template or an instruction to the provider.
 */
export const MOTION_ENGLISH = /^[A-Za-z0-9 ,.'-]+$/;

/** Whether a text a model or the owner's idea made is fit for a motion: at most `MOTION_TEXT_MAX` characters of `MOTION_ENGLISH`. */
function modelTextFits(text: string): boolean {
  return text.length <= MOTION_TEXT_MAX && MOTION_ENGLISH.test(text);
}

/**
 * One motion the sheet offers: the Russian label, the English text the prompt carries. The id's form belongs to the source (`scene`, `g-<slug>` code, `v-<n>` vision, `o-<n>` own). A text a model or the owner's
 * idea made (vision, own) is at most 60 characters of printable ASCII (I5.66, I5.67); a scene or code text keeps its 120.
 */
export const ClipMotionChoice = z
  .strictObject({
    id: ClipMotionId,
    source: ClipMotionSource,
    label: z.string().min(1).max(MOTION_LABEL_MAX),
    text: z.string().min(1).max(120),
  })
  .refine((m) => clipMotionIdSource(m.id) === m.source, { message: "the form of the id belongs to its source: `scene`, g-<slug> (code), v-<n> (vision), o-<n> (own)", path: ["id"] })
  .refine((m) => (m.source !== "vision" && m.source !== "own") || modelTextFits(m.text), {
    message: "a suggested or own text is at most 60 characters of letters, digits, spaces and , . ' -",
    path: ["text"],
  });
export type ClipMotionChoice = z.infer<typeof ClipMotionChoice>;

/**
 * FU-CLIP round 2 (MEDIUM-3): the motion a sheet or a batch row chooses before the owner does: the first vision suggestion when the photo has one (the model read the photo
 * itself, where «Как в сцене» and the code motions read only its plan), else the first listed. The list keeps the contract's order (scene, code, vision, own); only the
 * default reads it this way. The owner's own choice always wins over it.
 */
export function defaultMotionOf<M extends { readonly source: ClipMotionSource }>(motions: readonly M[]): M | undefined {
  return motions.find((motion) => motion.source === "vision") ?? motions[0];
}

const ClipMotionFields = z.strictObject({
  source: ClipMotionSource,
  label: z.string().min(1).max(MOTION_LABEL_MAX),
  text: z.string().min(1).max(120),
});

/** The motion a clip was made with, as a record, a journal line and a summary keep it. A vision or own text is held to the same 60 characters and charset as the choice it came from; code and scene keep their 120. */
export const ClipMotion = ClipMotionFields.refine((m) => (m.source !== "vision" && m.source !== "own") || modelTextFits(m.text), {
  message: "a suggested or own text is at most 60 characters of letters, digits, spaces and , . ' -",
  path: ["text"],
});
export type ClipMotion = z.infer<typeof ClipMotion>;

// ---------- the frame reading (5b.2 part C) ----------

/**
 * What the vision writer noticed about the frame, marks only: it never refuses, changes no price and no camera line (I5.68). It comes with a suggestion and is kept in the photo's motion store, so a reopened sheet
 * shows it again (`ClipOptions.reading`, mockup 62d).
 * - capture-differs: «Камера в кадре не такая, как в сцене».
 * - second-phone: «В кадре виден второй телефон — он может остаться в клипе».
 */
export const CLIP_FRAME_NOTES = ["capture-differs", "second-phone"] as const;
export const ClipFrameNote = z.enum(CLIP_FRAME_NOTES);
export type ClipFrameNote = z.infer<typeof ClipFrameNote>;

export const ClipFrameReading = z
  .strictObject({ notes: z.array(ClipFrameNote).max(CLIP_FRAME_NOTES.length) })
  .refine((r) => new Set(r.notes).size === r.notes.length, { message: "a note appears once", path: ["notes"] });
export type ClipFrameReading = z.infer<typeof ClipFrameReading>;

/** What the owner asked for. `fallback` is the sheet's choice: `auto` lets the engine's mode decide, `none` forbids a second model. */
export const ClipRequest = z.strictObject({
  model: ClipModelChoice,
  quality: ClipQuality,
  seconds: ClipSeconds,
  fallback: z.enum(["auto", "none"]),
});
export type ClipRequest = z.infer<typeof ClipRequest>;

// ---------- the price formula (one function for the engine, the mock and the tests) ----------

/** A model's price in micro-dollars: per output second, and per input image (the first frame). */
export interface ClipRates {
  readonly perSecondMicros: number;
  readonly perInputImageMicros: number;
}

/** The price book of one clip, read once at `clips.create` (I5.46). */
export interface ClipPrices {
  readonly std: ClipRates;
  readonly pro: ClipRates;
  readonly grok: ClipRates;
}

export interface ClipPriceParts {
  /** The model that runs first. */
  readonly model: ClipModelChoice;
  readonly quality: ClipQuality;
  readonly seconds: ClipSeconds;
  /** The engine's mode (`GROK_FALLBACK`). */
  readonly mode: "auto" | "offer";
  /** The sheet's choice. */
  readonly fallback: "auto" | "none";
  /** A frame of «Смелая» (I5.57). */
  readonly bold?: boolean;
  /** Defaults to `BOLD_CLIPS`; a parameter so every value can be tested. */
  readonly boldClips?: BoldClipsMode;
  readonly prices: ClipPrices;
}

function checkedRates(rates: ClipRates): void {
  if (!Number.isSafeInteger(rates.perSecondMicros) || rates.perSecondMicros < 0 || !Number.isSafeInteger(rates.perInputImageMicros) || rates.perInputImageMicros < 0) {
    throw new RangeError("a clip price must be a non-negative whole number of micro-dollars");
  }
}

function checkedFigure(micros: number): number {
  if (!Number.isSafeInteger(micros)) throw new RangeError("a clip figure must be a whole number of micro-dollars within the safe range");
  return micros;
}

/** What one attempt reserves right before its POST: (requested seconds + 1) x the per-second price + the input image (I5.46). Prices are whole micro-dollars, so the figure is too: a price that is not is refused, never rounded. */
export function clipReserveMicros(rates: ClipRates, seconds: number): number {
  checkedRates(rates);
  return checkedFigure((seconds + 1) * rates.perSecondMicros + rates.perInputImageMicros);
}

/** What one attempt bills when it completes: the requested seconds x the per-second price + the input image. Refuses a price that is not a whole number of micro-dollars. */
export function clipBilledMicros(rates: ClipRates, seconds: number): number {
  checkedRates(rates);
  return checkedFigure(seconds * rates.perSecondMicros + rates.perInputImageMicros);
}

/**
 * Whether Grok may run by itself after a content refusal proven free: mode `auto`, the sheet did not forbid it, and the frame is not one of «Смелая» kept to Kling (`kling-only`,
 * and `off`, which sends nothing at all). A `model: "grok"` clip never falls back (it is the fallback).
 */
export function clipAllowsAutoGrok(parts: Pick<ClipPriceParts, "model" | "mode" | "fallback" | "bold" | "boldClips">): boolean {
  if (parts.model === "grok" || parts.mode !== "auto" || parts.fallback !== "auto") return false;
  return !(parts.bold === true && (parts.boldClips ?? BOLD_CLIPS) !== "with-fallback");
}

function firstRates(parts: ClipPriceParts): ClipRates {
  return parts.model === "grok" ? parts.prices.grok : parts.prices[parts.quality];
}

/**
 * The clip's worst case: the figure the owner accepts and the cap of its scope (I5.46, §5.9). The dearest branch that can run, not the sum: Kling's reserve stays open at worst until
 * the proof window closes, and Grok reserves only after Kling settled 0.
 */
export function clipWorstMicros(parts: ClipPriceParts): number {
  const first = clipReserveMicros(firstRates(parts), parts.seconds);
  return clipAllowsAutoGrok(parts) ? Math.max(first, clipReserveMicros(parts.prices.grok, parts.seconds)) : first;
}

/** What the clip is expected to bill: the model that runs first, completed. */
export function clipExpectedMicros(parts: ClipPriceParts): number {
  return clipBilledMicros(firstRates(parts), parts.seconds);
}

/**
 * What a batch shares (5b.2, S5.WB1): the quality, length, fallback choice and price book are the batch's, the engine's mode is the engine's. A member differs only by its frame (`bold`): a batch never holds
 * a Grok-first clip (`model: "grok"` never enters a batch), so the model is Kling for every member.
 */
export type ClipBatchParts = Omit<ClipPriceParts, "model" | "bold">;
/** One member as the formula sees it: only whether its frame is one of «Смелая» (Kling alone, I5.57). */
export interface ClipBatchMember {
  readonly bold: boolean;
}

function checkedMembers(members: readonly ClipBatchMember[]): void {
  if (members.length < 1 || members.length > MAX_BATCH_CLIPS) throw new RangeError(`a batch holds 1 to ${MAX_BATCH_CLIPS} clips`);
}

/**
 * The batch's worst case (I5.62): the sum of every member's `clipWorstMicros` under the batch's price book, Kling first. It is the figure the owner accepts for the whole batch (`acceptedWorstMicros`), the sum the
 * engine checks (`PRICE_CHANGED`), and the sum of the member caps. Whole micro-dollars; a sum outside the safe integers, or a price that is not whole, is refused.
 */
export function clipBatchWorstMicros(members: readonly ClipBatchMember[], parts: ClipBatchParts): number {
  checkedMembers(members);
  let total = 0;
  for (const member of members) total = checkedFigure(total + clipWorstMicros({ ...parts, model: "kling", bold: member.bold }));
  return total;
}

/** What the batch is expected to bill: every member's Kling clip, completed. */
export function clipBatchExpectedMicros(members: readonly ClipBatchMember[], parts: ClipBatchParts): number {
  checkedMembers(members);
  let total = 0;
  for (const member of members) total = checkedFigure(total + clipExpectedMicros({ ...parts, model: "kling", bold: member.bold }));
  return total;
}

// ---------- clips.options ----------

/** The four Kling options of the sheet (quality x length), the keys of `noFallbackPrices` and `monthFits`. */
export const CLIP_OPTION_KEYS = ["std5", "pro5", "std10", "pro10"] as const;
export type ClipOptionKey = (typeof CLIP_OPTION_KEYS)[number];

export function clipOptionKey(quality: ClipQuality, seconds: ClipSeconds): ClipOptionKey {
  return `${quality}${seconds}`;
}

/** Whether the month's room takes the option with Grok's reserve behind it, without it, or not at all (the engine's figure, the same one `clips.create` checks). */
export const ClipMonthFit = z.enum(["with-fallback", "without-fallback", "none"]);
export type ClipMonthFit = z.infer<typeof ClipMonthFit>;

export const ClipUnsuitableReason = z.enum(CLIP_UNSUITABLE_REASONS);
export type ClipUnsuitableReason = z.infer<typeof ClipUnsuitableReason>;

const KlingPrices = z.strictObject({ std5: Estimate, pro5: Estimate, std10: Estimate, pro10: Estimate });
const MonthFits = z.strictObject({ std5: ClipMonthFit, pro5: ClipMonthFit, std10: ClipMonthFit, pro10: ClipMonthFit });

/** Under `kling-only` and `off` a frame of «Смелая» never has a fallback; under `with-fallback` it is a frame like any other. */
function boldKeepsKlingAlone(mode: BoldClipsMode): boolean {
  return mode !== "with-fallback";
}

/** Whether a list of motions comes in the order scene, code, vision, own (the order of `CLIP_MOTION_SOURCES`). */
function motionsInSourceOrder(motions: readonly { readonly source: ClipMotionSource }[]): boolean {
  const ranks = motions.map((m) => CLIP_MOTION_SOURCES.indexOf(m.source));
  return ranks.every((rank, i) => i === 0 || (ranks[i - 1] ?? 0) <= rank);
}

export const ClipOptions = z.discriminatedUnion("suitable", [
  z
    .strictObject({
      suitable: z.literal(true),
      photoId: Id,
      /**
       * One to nine, the default first, in the order scene, code, vision, own (5b.2 part C: scene 1 + code up to 3 + the newest suggestions up to 3 + the newest own ideas up to 2, `CLIP_CHOICES_MAX`).
       * Suggestions and ideas are the photo's stored ones, checked again by the engine at this call.
       */
      motions: z.array(ClipMotionChoice).min(1).max(CLIP_MOTIONS_MAX),
      /** 5b.2 part C (review round 2, L5): the photo's last stored frame reading, so a reopened sheet shows its notes (mockup 62d). Absent when no suggestion was ever made for this photo's current file. */
      reading: ClipFrameReading.optional(),
      prices: KlingPrices.extend({ grok5: Estimate, grok10: Estimate }),
      /** The engine's mode, or `none`: this photo never falls back («Смелая» under `kling-only`). */
      fallback: z.enum(["auto", "offer", "none"]),
      /** A frame of «Смелая» (I5.57): the sheet says there is no fallback model for it. */
      bold: z.boolean(),
      /** Kling alone: what the sheet shows for «Оживить без запасной модели». */
      noFallbackPrices: KlingPrices,
      monthFits: MonthFits,
    })
    .refine((o) => new Set(o.motions.map((m) => m.id)).size === o.motions.length, { message: "a motion id must not repeat", path: ["motions"] })
    .refine((o) => CLIP_MOTION_SOURCES.every((source) => o.motions.filter((m) => m.source === source).length <= CLIP_CHOICES_MAX[source]), {
      message: "a photo lists at most 1 scene motion, 3 code motions, 3 suggested motions and 2 own ideas",
      path: ["motions"],
    })
    .refine((o) => motionsInSourceOrder(o.motions), {
      message: "the motions come in the order scene, code, suggested, own",
      path: ["motions"],
    })
    .refine((o) => o.fallback === "auto" || Object.values(o.monthFits).every((fit) => fit !== "with-fallback"), {
      message: "only mode auto has a Grok reserve to fit the month with: neither `offer` nor `none` fits it with a fallback",
      path: ["monthFits"],
    })
    .refine((o) => !o.bold || !boldKeepsKlingAlone(BOLD_CLIPS) || o.fallback === "none", {
      message: "a frame of «Смелая» has no fallback while BOLD_CLIPS keeps it to Kling",
      path: ["fallback"],
    }),
  z.strictObject({ suitable: z.literal(false), photoId: Id, reason: ClipUnsuitableReason }),
]);
export type ClipOptions = z.infer<typeof ClipOptions>;

// ---------- the batch commands (5b.2, S5.WB1) ----------

/** One member of a batch as the sheet sends it: the photo and the motion id the owner picked for it (an id, never text: I5.51). The model never travels: a batch is Kling's. */
export const ClipBatchItem = z.strictObject({ photoId: Id, motionId: ClipMotionId });
export type ClipBatchItem = z.infer<typeof ClipBatchItem>;

/** Whether the photos in a list are all different. */
export function photoIdsUnique(photoIds: readonly string[]): boolean {
  return new Set(photoIds).size === photoIds.length;
}

/** One option's three figures over the batch: expected (all Kling, completed), worst with the fallback the engine allows, worst without it. */
const ClipBatchSum = z
  .strictObject({ expected: Micros, worst: Micros, worstNoFallback: Micros })
  .refine((s) => s.expected <= s.worstNoFallback && s.worstNoFallback <= s.worst, {
    message: "expected <= worstNoFallback <= worst: a reserve is above what a clip bills, and a fallback only adds",
  });

/**
 * What `clips.batchOptions` answers (free): each photo's own `ClipOptions` in the order asked, the four sums over the photos that can be made (`clipBatchWorstMicros` and `clipBatchExpectedMicros`, the one formula),
 * the month's room and, per option, whether the month takes the whole batch with the fallback behind it, without it, or not at all. The engine's figure, the same one `clips.createBatch` checks.
 *
 * `monthRoomMicros` = max(0, monthlyBudget - (spent + open + held)): the `#monthFits` / `tryHold` model that `clips.createBatch` holds against, NOT `Engine.monthRoom()` (the autopilot's caps).
 * `monthFits[option]`: `with-fallback` when the option's `worst` is within the room; `without-fallback` when only `worstNoFallback` is; `none` otherwise. A batch where no suitable member allows Grok (each has
 * `fallback` other than `auto`) cannot say `with-fallback`: its two worst cases are equal, so it reports `without-fallback`, like the single clip, and the sheet shows no second button at the same price.
 */
export const ClipBatchOptions = z
  .strictObject({
    items: z.array(ClipOptions).min(1).max(MAX_BATCH_CLIPS),
    sums: z.strictObject({ std5: ClipBatchSum, pro5: ClipBatchSum, std10: ClipBatchSum, pro10: ClipBatchSum }),
    monthRoomMicros: Micros,
    monthFits: MonthFits,
  })
  .refine((o) => photoIdsUnique(o.items.map((item) => item.photoId)), { message: "a photo appears once", path: ["items"] })
  .refine((o) => CLIP_OPTION_KEYS.every((key) => o.monthFits[key] !== "with-fallback" || o.sums[key].worst <= o.monthRoomMicros), {
    message: "an option fits the month with its fallback only if its worst case is within the room",
    path: ["monthFits"],
  })
  .refine((o) => CLIP_OPTION_KEYS.every((key) => o.monthFits[key] !== "without-fallback" || o.sums[key].worstNoFallback <= o.monthRoomMicros), {
    message: "an option fits the month without its fallback only if the Kling-alone worst case is within the room",
    path: ["monthFits"],
  })
  .refine((o) => o.items.some((item) => item.suitable && item.fallback === "auto") || CLIP_OPTION_KEYS.every((key) => o.monthFits[key] !== "with-fallback"), {
    message: "a batch where no member allows a fallback model never fits the month with one",
    path: ["monthFits"],
  });
export type ClipBatchOptions = z.infer<typeof ClipBatchOptions>;

/**
 * Why a batch member did not run, told on its `job.cancelled` and in its `JobState` (plan s5b2 §5.2.1; texts: `clipCancelDetailRu`). Every one is free: nothing was reserved.
 * - photo-gone: the photo was removed from the gallery before the member's turn; the batch goes on.
 * - photo-unreadable: the photo is still in the gallery but its file is missing or damaged at the member's turn; the batch goes on.
 * - price-changed: the price re-read at the turn put the member's worst above its share; it and the queue end.
 * - price-unavailable: the price could not be read at the turn (r2.1 N7); it and the queue end.
 * - ledger-stopped: a reserve was refused by the ledger (halted, a reconcile is needed, torn) or a settle came above its worst.
 * - money-uncertain: a member ended `submit-uncertain`, `late` or `lost`; the queue is not spent blind.
 * - cancelled: the owner cancelled (`clips.cancelBatch`, or `avatars.cancel` on one queued member).
 */
export const CLIP_CANCEL_DETAILS = ["photo-gone", "photo-unreadable", "price-changed", "price-unavailable", "ledger-stopped", "money-uncertain", "cancelled"] as const;
export const ClipCancelDetail = z.enum(CLIP_CANCEL_DETAILS);
export type ClipCancelDetail = z.infer<typeof ClipCancelDetail>;

// ---------- the record as the windows see it ----------

/** What a clip's money came to: `open` (a reserve still waits for the reconcile, counted at its worst), `estimated` (settled at a figure the money did not prove), `billed` (settled exact), `free` (nothing owed). */
export const ClipCostKind = z.enum(["billed", "estimated", "open", "free"]);
export type ClipCostKind = z.infer<typeof ClipCostKind>;

/** A clip's cost, built at list time from the ledger (I5.49), never stored. `free` is only ever 0. */
export const ClipCost = z
  .strictObject({ micros: Micros, kind: ClipCostKind })
  .refine((c) => c.kind !== "free" || c.micros === 0, { message: "a free clip cost nothing", path: ["micros"] });
export type ClipCost = z.infer<typeof ClipCost>;

// ---------- the batch's own summary (5b.2, S5.WB2c) ----------

/** `clips.list` answers at most this many batch summaries of an avatar, newest first. The engine keeps this many per avatar on disk, and any older one whose money is still open. */
export const MAX_LISTED_BATCHES = 20;

/**
 * Where a member of a batch stands, as the ENGINE wrote it at each of its transitions (never derived from the records, so a clip the owner deleted stays what it was):
 * - queued: waits for its turn (memory-only in the engine; a restart looks at its clip, and with nothing of it anywhere turns it `dropped`);
 * - running: its turn came (from `preparing` to its record, a recovery after a restart included);
 * - ready: its clip was made;
 * - refused: the provider refused its content (`refused-*`, or Grok had no room behind a free Kling refusal);
 * - failed: it ended without a clip for any other reason (a failed download, a 429 for the second time, a key refused, a ledger that refused its reserve, a restart that found only its reserve, …);
 * - cancelled: it never ran, and `detail` says why (`ClipCancelDetail`);
 * - dropped: the engine stopped before it was made (a quit, a restart) and nothing of its clip was found.
 * An outcome NEVER tells money: a member's money is its `costMicros` and `costKind` and the batch's is its `cost`, the ledger's, whatever the outcome (round 2: a member a restart dropped may still have a reserve
 * open). The window says «бесплатно» only from a `free` cost.
 */
export const CLIP_BATCH_OUTCOMES = ["queued", "running", "ready", "refused", "failed", "cancelled", "dropped"] as const;
export const ClipBatchOutcome = z.enum(CLIP_BATCH_OUTCOMES);
export type ClipBatchOutcome = z.infer<typeof ClipBatchOutcome>;

/** The details that stop a batch (I5.62, I5.63): each cancels every member still queued. A photo gone or unreadable is the member's own and stops nothing. */
export const CLIP_BATCH_STOPS = ["price-changed", "price-unavailable", "ledger-stopped", "money-uncertain", "cancelled"] as const satisfies readonly ClipCancelDetail[];
export const ClipBatchStop = z.enum(CLIP_BATCH_STOPS);
export type ClipBatchStop = z.infer<typeof ClipBatchStop>;

/**
 * One member of a batch: its place, where it stands, why it was cancelled (`detail`, only and always on `cancelled`), what its money came to and the clips it was made as (its first, and the one a 429 requeued it
 * as). The cost is the ledger's figure for those clip ids (`clipCostsOf`, I5.49): the same figure the clips' tiles say, and still the same once a clip is deleted, since the ledger keeps its lines.
 */
export const ClipBatchMemberSummary = z
  .strictObject({
    batchIndex: z.number().int().min(1).max(MAX_BATCH_CLIPS),
    outcome: ClipBatchOutcome,
    detail: ClipCancelDetail.optional(),
    costMicros: Micros,
    costKind: ClipCostKind,
    clipIds: z.array(Id).min(1).max(2),
  })
  .refine((m) => (m.outcome === "cancelled") === (m.detail !== undefined), { message: "a cancelled member says why, and only a cancelled one does", path: ["detail"] })
  .refine((m) => m.costKind !== "free" || m.costMicros === 0, { message: "a free member cost nothing", path: ["costMicros"] })
  .refine((m) => new Set(m.clipIds).size === m.clipIds.length, { message: "a member names each of its clips once", path: ["clipIds"] });
export type ClipBatchMemberSummary = z.infer<typeof ClipBatchMemberSummary>;

/**
 * The batch's money, the ENGINE's one figure (the window adds nothing): the sum of its members' costs, `open` when any is still open, `free` at zero, `estimated` when any member was settled at a figure the
 * money did not prove, else `billed`. The same rule `ClipCost` follows for one clip's attempts. Refuses a sum outside the safe integers.
 */
export function clipBatchCostOf(members: readonly Pick<ClipBatchMemberSummary, "costMicros" | "costKind">[]): ClipCost {
  let micros = 0;
  for (const member of members) micros = checkedFigure(micros + member.costMicros);
  if (members.some((member) => member.costKind === "open")) return { micros, kind: "open" };
  if (micros === 0) return { micros: 0, kind: "free" };
  return { micros, kind: members.some((member) => member.costKind === "estimated") ? "estimated" : "billed" };
}

/** The fields a batch summary has on the wire and on disk (the engine's file adds its `schemaVersion`, the wire its total `cost`). */
export const clipBatchFields = {
  batchId: Id,
  avatarId: Id,
  size: z.number().int().min(1).max(MAX_BATCH_CLIPS),
  createdAt: IsoDateTime,
  members: z.array(ClipBatchMemberSummary).min(1).max(MAX_BATCH_CLIPS),
  /** The queue ended: nothing is queued and the last member's money closed (a member may still be downloading), or a restart ended it. */
  endedAt: IsoDateTime.optional(),
  /** The stop that cancelled the members still queued (I5.62; the owner's `clips.cancelBatch` is `cancelled`): told only when it cancelled at least one. */
  stop: ClipBatchStop.optional(),
};

type ClipBatchShape = { size: number; members: readonly ClipBatchMemberSummary[]; endedAt?: string | undefined; stop?: ClipBatchStop | undefined };

/** The rules a batch summary keeps on the wire and on disk alike. */
export const CLIP_BATCH_RULES: readonly { check: (s: ClipBatchShape) => boolean; message: string; path: string[] }[] = [
  { check: (s) => s.members.length === s.size && s.members.every((m, i) => m.batchIndex === i + 1), message: "a batch has one member per place, in order from 1 to its size", path: ["members"] },
  { check: (s) => new Set(s.members.flatMap((m) => m.clipIds)).size === s.members.reduce((n, m) => n + m.clipIds.length, 0), message: "a clip is one member's", path: ["members"] },
  { check: (s) => s.endedAt === undefined || s.members.every((m) => m.outcome !== "queued"), message: "a batch that ended has nothing queued", path: ["endedAt"] },
  {
    check: (s) => s.stop === undefined || (s.members.some((m) => m.outcome === "cancelled" && m.detail === s.stop) && s.members.every((m) => m.outcome !== "queued")),
    message: "a stop cancelled every member still queued, at least one, with its own detail",
    path: ["stop"],
  },
];

/**
 * A batch «Оживить выбранные» as `clips.list` tells it (newest first, at most `MAX_LISTED_BATCHES`): the engine's own record of each member, written at every transition and never derived from the clip
 * records, and the batch's total money (`clipBatchCostOf`). A deleted clip leaves its member as it was, its cost included.
 */
export const ClipBatchSummary = CLIP_BATCH_RULES.reduce(
  (schema, rule) => schema.refine(rule.check, { message: rule.message, path: rule.path }),
  z.strictObject({ ...clipBatchFields, cost: ClipCost }).refine(
    (s) => {
      const total = clipBatchCostOf(s.members);
      return s.cost.micros === total.micros && s.cost.kind === total.kind;
    },
    { message: "the batch's cost is the sum of its members' costs (clipBatchCostOf)", path: ["cost"] },
  ),
);
export type ClipBatchSummary = z.infer<typeof ClipBatchSummary>;

/** The list of an avatar's batches: each once, newest first. */
export const ClipBatchSummaries = z
  .array(ClipBatchSummary)
  .min(1)
  .max(MAX_LISTED_BATCHES)
  .refine((list) => new Set(list.map((s) => s.batchId)).size === list.length, { message: "a batch is listed once" })
  .refine((list) => list.every((s, i) => i === 0 || (list[i - 1]?.createdAt ?? "") >= s.createdAt), { message: "the batches come newest first" });

/** The face check marks, never decides (I5.52). `why` explains a skipped check; `p75` is the similarity of the 75th percentile of the frames with one face. */
export const ClipFace = z
  .strictObject({
    verdict: z.enum(["match", "mismatch", "skipped"]),
    p75: z.number().min(-1).max(1).optional(),
    frames: Count.max(200),
    why: z.enum(["hidden", "profile", "few-faces", "worker"]).optional(),
  })
  .refine((f) => f.why === undefined || f.verdict === "skipped", { message: "`why` belongs to a skipped check only", path: ["why"] })
  .refine((f) => (f.verdict === "skipped") === (f.p75 === undefined), { message: "a p75 comes with a match or a mismatch, and with nothing else", path: ["p75"] });
export type ClipFace = z.infer<typeof ClipFace>;

export const ClipFailReason = z.enum([
  "refused-free",
  "refused-both",
  "refused-paid",
  "refused-unknown",
  "provider-error",
  "grok-no-room",
  "bad-request",
  "submit-uncertain",
  "late",
  "lost",
  "download-failed",
  "invalid-file",
  "disk-full",
  "no-credits",
  "key-invalid",
  "rate-limited",
  "download-expired",
]);
export type ClipFailReason = z.infer<typeof ClipFailReason>;

/** The paid failures whose file is still at the provider, so a free `retryDownload` can fetch it (I5.53): the only ones that carry `retryDownloadUntil`. */
export const CLIP_RETRYABLE_FAILURES: readonly ClipFailReason[] = ["download-failed", "invalid-file", "disk-full"];

/** Which fps mode made an exported file (I5.55): interpolated 30, duplicated 30, or native 24. */
export const ClipExportProfile = z.enum(["1080p30-interp", "1080p30-dup", "1080p24"]);
export type ClipExportProfile = z.infer<typeof ClipExportProfile>;

/** The 64 lowercase hex characters of a sha256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

/** What the record keeps of an export: where the copy went (the export root's identity and a path relative to it), how it was made, and its size and hash. */
export const ClipExportLine = z.strictObject({
  rootId: Id,
  relPath: RelativePath,
  profile: ClipExportProfile,
  at: IsoDateTime,
  bytes: z.number().int().positive(),
  sha256: Sha256Hex,
});
export type ClipExportLine = z.infer<typeof ClipExportLine>;

/** An export as `clips.get` and `clips.list` show it: the line, and the file's state looked at now (the shared `FileState`, `changed` included), never stored. */
export const ClipExport = ClipExportLine.extend({ fileState: FileState.optional() });
export type ClipExport = z.infer<typeof ClipExport>;

/**
 * What uses a ready clip (5b.2, S5.WA1; `ClipSummary.use`): at least one key, so "not used" is the absence of `use`. `MontageName` is the montage draft's own, already bounded name type
 * (1 to 80 characters, no control characters), so no new bound is added; a draft with no name has `name: null`.
 */
export const ClipUse = z
  .strictObject({
    inVideo: z.enum(["clip", "photo"]).optional(),
    inDrafts: z
      .strictObject({
        count: z.number().int().positive(),
        first: z.strictObject({ name: MontageName.nullable(), frame: z.number().int().positive() }).optional(),
      })
      .optional(),
  })
  .refine((use) => use.inVideo !== undefined || use.inDrafts !== undefined, { message: "use must say something; an unused clip has no `use`" })
  // 5b.2, S5.WB1 (a WA1 review carry-over): the dialog names a draft only when exactly one holds the copy, so `first` beside a count above 1 is a contradiction.
  .refine((use) => use.inDrafts?.first === undefined || use.inDrafts.count === 1, { message: "`first` names the one draft there is: it comes only with a count of 1", path: ["inDrafts", "first"] });
export type ClipUse = z.infer<typeof ClipUse>;

const clipSummaryCommon = {
  clipId: Id,
  avatarId: Id,
  photoId: Id,
  createdAt: IsoDateTime,
  seen: z.boolean(),
  motion: ClipMotion,
  request: ClipRequest,
  /** The model that made the file, or that tried last. */
  model: ClipModelUsed,
  /** Grok ran as the automatic fallback. */
  fallback: z.boolean(),
  /** A recovery job found it after a restart. */
  recovered: z.boolean(),
  cost: ClipCost,
  /** The provider's own number, for information; the ledger's is `cost`. */
  providerCostMicros: Micros.optional(),
  exports: z.array(ClipExport).max(200),
  /**
   * 5b.2 (additive, S5.WB1; plan I5.63, L9): the batch this clip was made in, its 1-based place and the batch's size, all three or none (`clipBatchFieldsTogether`), so the «Клипы» tab's batch header survives
   * `KEEP_FINISHED` and a restart. The window counts members by DISTINCT `batchIndex` (a 429 requeue gives two records for one photo) and says «не снимались N» as `batchSize` minus the members that have a record.
   * Absent for a single clip.
   */
  batchId: Id.optional(),
  batchIndex: z.number().int().min(1).max(MAX_BATCH_CLIPS).optional(),
  batchSize: z.number().int().min(1).max(MAX_BATCH_CLIPS).optional(),
};

export const ClipSummary = z.discriminatedUnion("status", [
  z.strictObject({
    ...clipSummaryCommon,
    status: z.literal("ready"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    face: ClipFace,
    /**
     * 5b.2 (additive, S5.WA1; Q-F = 1): present when this clip's frame is in a finished video, absent otherwise (as `notListedTotal` is). `inVideo` says how:
     * - `"clip"`: a finished video's `clipFrames` name THIS clip;
     * - `"photo"`: the frame is used through the photo itself or a sibling clip of it.
     * The «Клипы» tab dims the clip in both cases (57b, 41e), but 44b's «Клип есть в готовом видео — видео не изменится.» applies only to `"clip"`. `inDrafts` is for the delete dialog on a screen with no draft
     * loaded: how many drafts hold the clip's copy, and, for the one-draft line, that draft's name and the frame (1-based) the copy stands at (`first`, the first draft the engine found; the dialog reads it
     * when `count` is 1). A clip a render holds is told by the delete's IN_FLIGHT `in-use`, not by `use`. Only a ready clip is ever used.
     */
    use: ClipUse.optional(),
  })
  .refine((c) => clipBatchFieldsTogether(c), { message: "a clip tells its batch id, its place and the batch's size together, or none of them, with the place within the size", path: ["batchId"] }),
  z.strictObject({
    ...clipSummaryCommon,
    status: z.literal("failed"),
    /** `grokOffer` is the mode-`offer` tile's «Снять на Grok · до $0.85»: a price, computed at list time. */
    failure: z.strictObject({ reason: ClipFailReason, grokOffer: Estimate.optional() }),
    /** A paid failure of the download can be retried free until this time. */
    retryDownloadUntil: IsoDateTime.optional(),
  })
  .refine((c) => c.retryDownloadUntil === undefined || CLIP_RETRYABLE_FAILURES.includes(c.failure.reason), {
    message: "only a failed download can be retried",
    path: ["retryDownloadUntil"],
  })
  .refine((c) => clipBatchFieldsTogether(c), { message: "a clip tells its batch id, its place and the batch's size together, or none of them, with the place within the size", path: ["batchId"] }),
]);
export type ClipSummary = z.infer<typeof ClipSummary>;

// ---------- the job ----------

/**
 * The phases of a clip job (§5.1). `late` comes after the lifetime, `recovering` after a restart, `exporting` is the export job's only phase.
 * `queued` (5b.2, S5.WB1; I5.61) is a batch member waiting for its turn: memory-only, no reserve, nothing in the journal. It is the first phase, before `preparing`.
 */
export const CLIP_PHASES = ["queued", "preparing", "submitting", "rendering", "proving", "downloading", "checking", "saving", "late", "recovering", "exporting"] as const;
export const ClipPhase = z.enum(CLIP_PHASES);
export type ClipPhase = z.infer<typeof ClipPhase>;

/** `done / total` of a create job count its steps: video, download, check, save. An export counts encoded frames of all frames. */
export const CLIP_JOB_STEPS = 4;

/** A clip job's identity, in every event it sends. The clip's id is the job's id's twin: the journal, the record, the ledger ids and the job agree on it. */
export const clipJobRef = { kind: z.literal("clip"), jobId: Id, avatarId: Id, clipId: Id };

/** The motion a clip job shows on its tile: the source and the Russian label. The English prompt text is the engine's, never the window's. */
export const ClipJobMotion = ClipMotionFields.pick({ source: true, label: true });
export type ClipJobMotion = z.infer<typeof ClipJobMotion>;

/**
 * What a running clip job adds to its identity: the phase, and in `rendering` the model and the submit time, in `proving` the end of the proof window.
 * (S5.V8b) A create job also carries the facts its tile shows, taken from the journal's `requested` line: the photo, the request, the motion's label and the worst case the owner accepted,
 * so a window that first sees the job (after a restart, or a reload) draws it whole. An export job carries none of them; an older engine's job carries none either.
 */
export const clipJobFields = {
  phase: ClipPhase,
  model: ClipAttemptModel.optional(),
  submittedAt: IsoDateTime.optional(),
  proveUntil: IsoDateTime.optional(),
  photoId: Id.optional(),
  request: ClipRequest.optional(),
  motion: ClipJobMotion.optional(),
  /** What the owner accepted for THIS clip. A batch member's is its own share (its worst case under the batch's price book), never the batch's sum. */
  acceptedWorstMicros: Micros.optional(),
  /**
   * What the ledger can still charge for this clip: the sum of its reserves that are open (unsettled), as the engine holds them. Told in every phase where one is open, and absent where none is.
   * Independent of the four facts above. A tile in `late` or `recovering` says it as «спишется при сверке»; the cap the sheet promised is `acceptedWorstMicros`.
   */
  openReserveMicros: Micros.optional(),
  /**
   * 5b.2 (additive, S5.WB1; plan s5b2 §5.2.1): the member of a batch. `batchId`, `batchIndex` (1-based, the pick order) and `batchSize` come all or none; a single clip and an export carry none.
   * `waitReason` says what a `queued` or `proving` job waits for: its `turn`, the money to be `alone`, the 60 s pause after a 429 (`rate-limit`), or the strict `proof`. No other phase has one.
   */
  batchId: Id.optional(),
  batchIndex: z.number().int().min(1).max(MAX_BATCH_CLIPS).optional(),
  batchSize: z.number().int().min(1).max(MAX_BATCH_CLIPS).optional(),
  waitReason: z.enum(["turn", "alone", "rate-limit", "proof"]).optional(),
};

/** The three batch fields of a clip job are all told or none of them, and the position is within the size. */
export function clipBatchFieldsTogether(job: { batchId?: unknown; batchIndex?: number; batchSize?: number }): boolean {
  const told = [job.batchId, job.batchIndex, job.batchSize].filter((field) => field !== undefined).length;
  if (told === 0) return true;
  return told === 3 && (job.batchIndex ?? 0) <= (job.batchSize ?? 0);
}
export const CLIP_BATCH_FIELDS_TOGETHER = { message: "a clip job tells its batch id, its place and the batch's size together, or none of them, with the place within the size" };

/**
 * A `queued` job is a batch member that has done nothing yet (I5.61): the whole batch trio, no progress, no model, no submit time, no proof window and no open reserve. (The proof window is also refused
 * outside `proving`.) Any other phase passes.
 */
export function clipQueuedShape(job: { phase: ClipPhase; done: number; batchId?: unknown; model?: unknown; submittedAt?: unknown; proveUntil?: unknown; openReserveMicros?: unknown }): boolean {
  if (job.phase !== "queued") return true;
  return job.batchId !== undefined && job.done === 0 && job.model === undefined && job.submittedAt === undefined && job.proveUntil === undefined && job.openReserveMicros === undefined;
}
export const CLIP_QUEUED_SHAPE = { message: "a queued clip job is a batch member at zero: the batch trio, and no model, submit time, proof window or open reserve" };

/** A wait reason belongs to a `queued` or a `proving` job. */
export function clipWaitReasonPlaced(job: { phase: ClipPhase; waitReason?: unknown }): boolean {
  return job.waitReason === undefined || job.phase === "queued" || job.phase === "proving";
}
export const CLIP_WAIT_REASON_PLACED = { message: "a wait reason belongs to the queued and proving phases" };

/** The four create facts of a clip job are all told or none of them. */
export function clipFactsTogether(job: { photoId?: unknown; request?: unknown; motion?: unknown; acceptedWorstMicros?: unknown }): boolean {
  const told = [job.photoId, job.request, job.motion, job.acceptedWorstMicros].filter((fact) => fact !== undefined).length;
  return told === 0 || told === 4;
}
export const CLIP_FACTS_TOGETHER = { message: "a clip job tells its photo, request, motion and accepted worst case together, or none of them" };

/** A finished clip job. An export job's result also names where the copy went. The renderer takes the job's avatar from `avatarId`. */
export const ClipJobResult = z.strictObject({
  kind: z.literal("clip"),
  avatarId: Id,
  clipId: Id,
  exported: z.strictObject({ relPath: RelativePath }).optional(),
});
export type ClipJobResult = z.infer<typeof ClipJobResult>;
