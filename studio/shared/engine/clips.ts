import { z } from "zod";
import { CLIP_UNSUITABLE_REASONS } from "./errors";
import { Estimate } from "./estimate";
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
 * I5.57: frames of «Смелая» (a photo whose category is `nightwear` or `beach`, i.e. whose content level is bold). `kling-only`: offered, run on Kling alone with fallback `none`,
 * never on Grok (worst is Kling's reserve). `with-fallback`: like any other frame (the code and the tests only; nothing sets it in 5b.1). `off`: not suitable, reason `bold-off`.
 * `kling-only` is FINAL: the owner's answer to Q-A (2026-10-13), confirmed by probe P-V (3 of 3 clips completed, "Норм видео").
 */
export type BoldClipsMode = "kling-only" | "with-fallback" | "off";
export const BOLD_CLIPS: BoldClipsMode = "kling-only";

/**
 * I5.55: how an export turns the providers' 24 fps into the 30 the owner asked for. `interpolate`: motion-interpolated (`minterpolate`), the default until the owner's eye picks at canary
 * C3. `duplicate`: plain `fps=30`, which repeats every fourth frame. `native24`: the file stays at 24 fps (only the owner picks it).
 */
export const EXPORT_FPS: "interpolate" | "duplicate" | "native24" = "interpolate";

/** `clips.list` answers at most this many clips, newest first. */
export const MAX_LISTED_CLIPS = 500;

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

/** A motion id on the wire: the photo's own scene motion, or a code motion `g-<slug>`. Never free text (I5.51). */
export const ClipMotionId = z.union([z.literal("scene"), z.string().max(40).regex(/^g-[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be `scene` or g-<slug>")]);
export type ClipMotionId = z.infer<typeof ClipMotionId>;

/** One motion the sheet offers: the Russian label, the English text the prompt carries. The id `scene` is the photo's own scene motion and nothing else. */
export const ClipMotionChoice = z
  .strictObject({
    id: ClipMotionId,
    source: z.enum(["scene", "code"]),
    label: z.string().min(1).max(40),
    text: z.string().min(1).max(120),
  })
  .refine((m) => (m.id === "scene") === (m.source === "scene"), { message: "the id `scene` belongs to the source `scene` only", path: ["id"] });
export type ClipMotionChoice = z.infer<typeof ClipMotionChoice>;

/** The motion a clip was made with, as a record and a summary keep it. */
export const ClipMotion = z.strictObject({
  source: z.enum(["scene", "code"]),
  label: z.string().min(1).max(40),
  text: z.string().min(1).max(120),
});
export type ClipMotion = z.infer<typeof ClipMotion>;

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

export const ClipOptions = z.discriminatedUnion("suitable", [
  z
    .strictObject({
      suitable: z.literal(true),
      photoId: Id,
      /** One to four, the default first. */
      motions: z.array(ClipMotionChoice).min(1).max(4),
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

// ---------- the record as the windows see it ----------

/** A clip's cost, built at list time from the ledger (I5.49), never stored. `free` is only ever 0. */
export const ClipCost = z
  .strictObject({ micros: Micros, kind: z.enum(["billed", "estimated", "open", "free"]) })
  .refine((c) => c.kind !== "free" || c.micros === 0, { message: "a free clip cost nothing", path: ["micros"] });
export type ClipCost = z.infer<typeof ClipCost>;

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
};

export const ClipSummary = z.discriminatedUnion("status", [
  z.strictObject({
    ...clipSummaryCommon,
    status: z.literal("ready"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    face: ClipFace,
  }),
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
  }),
]);
export type ClipSummary = z.infer<typeof ClipSummary>;

// ---------- the job ----------

/** The phases of a clip job (§5.1). `late` comes after the lifetime, `recovering` after a restart, `exporting` is the export job's only phase. */
export const CLIP_PHASES = ["preparing", "submitting", "rendering", "proving", "downloading", "checking", "saving", "late", "recovering", "exporting"] as const;
export const ClipPhase = z.enum(CLIP_PHASES);
export type ClipPhase = z.infer<typeof ClipPhase>;

/** `done / total` of a create job count its steps: video, download, check, save. An export counts encoded frames of all frames. */
export const CLIP_JOB_STEPS = 4;

/** A clip job's identity, in every event it sends. The clip's id is the job's id's twin: the journal, the record, the ledger ids and the job agree on it. */
export const clipJobRef = { kind: z.literal("clip"), jobId: Id, avatarId: Id, clipId: Id };

/** What a running clip job adds to its identity: the phase, and in `rendering` the model and the submit time, in `proving` the end of the proof window. */
export const clipJobFields = {
  phase: ClipPhase,
  model: ClipAttemptModel.optional(),
  submittedAt: IsoDateTime.optional(),
  proveUntil: IsoDateTime.optional(),
};

/** A finished clip job. An export job's result also names where the copy went. The renderer takes the job's avatar from `avatarId`. */
export const ClipJobResult = z.strictObject({
  kind: z.literal("clip"),
  avatarId: Id,
  clipId: Id,
  exported: z.strictObject({ relPath: RelativePath }).optional(),
});
export type ClipJobResult = z.infer<typeof ClipJobResult>;
