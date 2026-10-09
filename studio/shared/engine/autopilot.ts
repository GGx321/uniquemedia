import { z } from "zod";
import { CategoryRef, MAX_RUN_CATEGORIES } from "./categories";
import { ExportUnavailableReason } from "./errors";
import { Count, Id, LaunchId, LaunchVideoKey, Micros } from "./primitives";
import { SceneId } from "./scenes";
import { AvatarUsage, Estimate, MUSIC_QUOTA_LIMIT, RunPoses } from "./state";

// Stage 4 «Автопилот»: the contract of a batch launch (plan §9, amended by §18). A launch is chosen avatars times videos per avatar, made from free library
// photos first and generated photos for the rest, then montaged and rendered headless. Pure data: the engine's orchestrator builds these views from the launch
// file and the ledger, and the renderer only draws them. No word of text travels here: the engine sends types, codes and numbers, and the window words them
// (`LogLine`, the holds, the reasons).

const IsoDateTime = z.iso.datetime();
const MICROS_PER_DOLLAR = 1_000_000;
const unique = (items: readonly unknown[]): boolean => new Set(items).size === items.length;

// ---------- bounds ----------

/** A launch has at most this many avatars and each makes at most this many videos (the owner's numbers, decisions 1–10). */
export const MAX_LAUNCH_AVATARS = 50;
export const MAX_VIDEOS_PER_AVATAR = 50;
/** Every video of the autopilot is at most 10 s (owner decision; the engine refuses a longer spec, never clamps it). */
export const LAUNCH_MAX_VIDEO_MS = 10_000;
/** `autopilot.list` answers at most this many launches, newest first, and as many unreadable entries. */
export const MAX_LISTED_LAUNCHES = 200;
/** `autopilot.get` answers at most this many log lines (the newest), and a view's tail is at most `MAX_LAUNCH_LOG_TAIL`. */
export const MAX_LAUNCH_LOG_LINES = 500;
export const MAX_LAUNCH_LOG_TAIL = 20;
/** A launch draws an avatar's photos in slices of at most this many (plan D2): it bounds the worst case held at once and keeps «Пауза» responsive. */
export const LAUNCH_SLICE_MAX_PHOTOS = 25;
/** The most videos one launch can hold: every avatar at its most. */
export const MAX_LAUNCH_VIDEOS = MAX_LAUNCH_AVATARS * MAX_VIDEOS_PER_AVATAR;
/**
 * The most a forged amount may say in a launch command ($10 000): far above the dearest launch the limits allow (50 avatars of 100 new photos each is about
 * $1 100 at today's prices, so even a four-fold rise fits), and low enough that nothing absurd travels to the engine. Whole micro-dollars like every sum.
 */
export const LAUNCH_MAX_MICROS = 10_000_000_000;
/** An amount a launch command carries (the click's accepted worst case, the accepted remaining worst): whole micro-dollars within the launch bound. */
export const LaunchMicros = Micros.max(LAUNCH_MAX_MICROS);

// ---------- ids ----------

/**
 * An entry of the library's `autopilot/` folder that could not be read as a launch, named by 16 hex characters of the sha256 of its file name. The renderer
 * takes it from `autopilot.list` and sends it back; it never sends a name or a path (design constraint 1), and the engine finds the file by hashing the names it
 * lists itself.
 */
export const LaunchEntryId = z.string().regex(/^[0-9a-f]{16}$/, "must be 16 lowercase hex characters");

// ---------- the draft ----------

const Share = z.number().int().min(0).max(100);

/** The shape mix, in whole percent: how many of the videos are one photo, a collage of 2 to 4, or slides of 5 to 7. Always sums to 100. */
export const LaunchMix = z.strictObject({ single: Share, collage: Share, slides: Share }).refine((m) => m.single + m.collage + m.slides === 100, { message: "the mix must sum to 100", path: ["single"] });
export type LaunchMix = z.infer<typeof LaunchMix>;

export const PlanSeed = z.number().int().min(0).max(4_294_967_295);

/** What the owner chose, without the seed. The preview draws the seed. */
export const LaunchSettings = z.strictObject({
  avatarIds: z.array(Id).min(1).max(MAX_LAUNCH_AVATARS).refine(unique, "an avatar must not repeat"),
  videosPerAvatar: z.number().int().min(1).max(MAX_VIDEOS_PER_AVATAR),
  mix: LaunchMix,
  categories: z.array(CategoryRef).min(1).max(MAX_RUN_CATEGORIES).refine(unique, "a category must not repeat"),
  /** «Ракурсы»: the built-in categories' toggles (front and three-quarter are always on). A custom category with its own angles ignores them. */
  poses: RunPoses,
  /** «Сначала свободные фото из библиотеки». */
  library: z.boolean(),
  /** «Догенерировать недостающие». */
  generate: z.boolean(),
  /** «Сцены на проверку»: the owner reviews each avatar's scenes before they are drawn. */
  sceneReview: z.boolean(),
  /** Built-in stickers on the videos. */
  stickers: z.boolean(),
});

/** The settings a launch runs with, and the seed that makes the start plan the very videos the preview showed. */
export const LaunchDraft = LaunchSettings.extend({ planSeed: PlanSeed });
export type LaunchDraft = z.infer<typeof LaunchDraft>;

/** The estimate's draft: without a seed the preview draws one; with the seed of an earlier preview a refresh keeps its videos. */
export const LaunchDraftInput = LaunchSettings.extend({ planSeed: PlanSeed.optional() });
export type LaunchDraftInput = z.infer<typeof LaunchDraftInput>;

// ---------- vocabulary ----------

/** The three shapes of a video: one photo, a collage of 2 to 4, slides of 5 to 7. */
export const VideoShape = z.enum(["single", "collage", "slides"]);
export type VideoShape = z.infer<typeof VideoShape>;

/** How many photos a video of this shape has. */
export function shapeSizeFits(shape: VideoShape, size: number): boolean {
  if (shape === "single") return size === 1;
  if (shape === "collage") return size >= 2 && size <= 4;
  return size >= 5 && size <= 7;
}
const VideoSize = z.number().int().min(1).max(7);

/**
 * - running: the launch works.
 * - pausing: «Пауза» was clicked and the requests in flight are finishing (`inFlight`); a view state, not persisted (a quit now reads as paused).
 * - paused: nothing runs, paid or free (the owner's «Пауза», a quit, or an engine restart: `paused.cause`).
 * - stopping: «Стоп» was clicked and the requests in flight are finishing. Persisted in the launch file, so a quit during «Останавливаем…» finishes the Stop
 *   on the next start and never reads as a pause.
 * - done / stopped: the launch ended (every video is done or dropped / the owner stopped it).
 */
export const LAUNCH_STATUSES = ["running", "pausing", "paused", "stopping", "done", "stopped"] as const;
export const LaunchStatus = z.enum(LAUNCH_STATUSES);
export type LaunchStatus = z.infer<typeof LaunchStatus>;
const isEnded = (status: LaunchStatus): boolean => status === "done" || status === "stopped";

/** Why a launch is paused: the owner's click, the app was closed (`quit`), or the engine restarted (an automatic restart, or after a crash). */
export const PausedCause = z.enum(["owner", "quit", "engine-restart"]);
export type PausedCause = z.infer<typeof PausedCause>;

/** Why paid work of a running launch waits for a cause to be fixed (plan §4.6). Free work goes on through every one of them. */
export const PAID_HOLD_REASONS = ["budget", "credits", "key", "halt", "network", "price-unavailable", "price", "internal"] as const;
export const PaidHoldReason = z.enum(PAID_HOLD_REASONS);
export type PaidHoldReason = z.infer<typeof PaidHoldReason>;

export const BudgetHoldKind = z.enum(["new-slice", "resume-slice"]);
export type BudgetHoldKind = z.infer<typeof BudgetHoldKind>;

/** The two ways the money stops: a settle above its reserve's worst case, or a ledger line that could not be written. Only a reconcile clears either. */
export const HaltCode = z.enum(["SETTLE_ABOVE_WORST", "LEDGER_WRITE_FAILED"]);

/**
 * Why an `internal` hold stands: `allocation-exceeded` is the orchestrator's own check of the launch's allocation (no exit but «Стоп»); `job-failed` (S4.6r) is a paid job (a slice, a compose, a
 * «Дописать») that ended in a way the failure table has no row for (an INTERNAL, say a master photo that cannot be prepared): «Продолжить» runs the job again.
 */
export const InternalHoldKind = z.enum(["allocation-exceeded", "job-failed"]);
export type InternalHoldKind = z.infer<typeof InternalHoldKind>;

/**
 * The failed job's own words, `CODE: detail`, cut to a line. The engine's error details are what the window shows, but a job that wraps a foreign error can carry the owner's absolute path in
 * its detail: the steps replace every path in it with `<path>` before it is written (`scrubPaths`), and a foreign error is held by its name only.
 */
export const INTERNAL_HOLD_MESSAGE_MAX = 240;
const InternalHoldMessage = z.string().min(1).max(INTERNAL_HOLD_MESSAGE_MAX);

const HoldAt = { at: IsoDateTime };
const NoDetail = z.strictObject({});

/**
 * What a price hold says. At a slice the price rose and the slice no longer fits its allocation (`toPhotos` is how far it shrank, 0 for not at all). At the compose or the
 * launch's own «Дописать» (`rewrite`) there is no slice to shrink: the writer's cost at today's price (`needMicros`) is above what its allocation leaves (`leftMicros`).
 */
export const PriceHoldDetail = z.discriminatedUnion("stage", [
  z.strictObject({ stage: z.literal("slice"), fromPhotos: Count, toPhotos: Count }).refine((d) => d.toPhotos < d.fromPhotos, { message: "a price rise shrinks the slice", path: ["toPhotos"] }),
  z
    .strictObject({ stage: z.enum(["compose", "rewrite"]), needMicros: Micros, leftMicros: Micros })
    .refine((d) => d.leftMicros < d.needMicros, { message: "the allocation left is below what the step needs", path: ["leftMicros"] }),
]);

/**
 * The paid hold of a launch: a strict union by `reason`, each with the one detail that belongs to it (a wrong pairing is refused).
 * - budget: the month has too little room. `needMicros` is the one threshold: `new-slice` needs the room for one photo's worst, `resume-slice` the room for the
 *   rest of the slice already started (`runs.resume` asks for it).
 * - credits: OpenRouter answered 402. Admitted again always: a 402 returns the hold at no cost.
 * - key: OpenRouter rejected the key.
 * - halt: the money is stopped until a reconcile.
 * - network: requests got no answer. `drops` counts the drops of the job; while automatic continues remain (`attempt`, 1 or 2) `nextAt` says when the next one
 *   goes; at `nextAt: null` the launch waits for a reconcile and the owner's «Продолжить».
 * - price-unavailable: the price list did not load. `attempt` (1 to 3) is the retry at 5, 15 and 60 minutes; at `nextAt: null` retries are used up.
 * - price: the price rose and the next step no longer fits its allocation (`PriceHoldDetail`: a slice shrunk as far as it can, or a compose / «Дописать» above what is left).
 * Counters (`drops`, the price retries) live across a reconcile and a «Продолжить», so none has an upper bound here.
 * - internal: `allocation-exceeded`: the orchestrator's own check of the launch's allocation did not hold; its only exit is «Стоп». `job-failed` (S4.6r): a paid job ended in a way no row of the
 *   table covers; `message` is the job's own `CODE: detail`, and «Продолжить» runs the job again.
 */
export const PaidHold = z.discriminatedUnion("reason", [
  z.strictObject({ reason: z.literal("budget"), ...HoldAt, detail: z.strictObject({ freeMicros: Micros, needMicros: Micros, kind: BudgetHoldKind }) }),
  z.strictObject({ reason: z.literal("credits"), ...HoldAt, detail: NoDetail }),
  z.strictObject({ reason: z.literal("key"), ...HoldAt, detail: NoDetail }),
  z.strictObject({ reason: z.literal("halt"), ...HoldAt, detail: z.strictObject({ code: HaltCode }) }),
  z.strictObject({
    reason: z.literal("network"),
    ...HoldAt,
    detail: z
      .strictObject({ drops: z.number().int().min(1), attempt: z.number().int().min(0).max(2), nextAt: IsoDateTime.nullable() })
      .refine((d) => d.nextAt === null || d.attempt >= 1, { message: "a next retry is the number of a retry", path: ["nextAt"] }),
  }),
  z.strictObject({
    reason: z.literal("price-unavailable"),
    ...HoldAt,
    detail: z.strictObject({ attempt: z.number().int().min(1), nextAt: IsoDateTime.nullable() }),
  }),
  z.strictObject({ reason: z.literal("price"), ...HoldAt, detail: PriceHoldDetail }),
  z.strictObject({
    reason: z.literal("internal"),
    ...HoldAt,
    detail: z
      .strictObject({ kind: InternalHoldKind, message: InternalHoldMessage.optional() })
      .refine((d) => d.message === undefined || d.kind === "job-failed", { message: "only a failed job has words of its own", path: ["message"] }),
  }),
]);
export type PaidHold = z.infer<typeof PaidHold>;

/** Why free work waits (it never stops paid work): the «Готовые видео» folder cannot take a video. Cleared by itself on `export.status`. */
export const FreeHold = z.discriminatedUnion("reason", [
  z.strictObject({
    reason: z.literal("export"),
    ...HoldAt,
    detail: z
      .strictObject({
        exportReason: ExportUnavailableReason,
        /** For `not-enough-space`: what the next video needs and what the disk has (null when unknown). */
        neededBytes: Count.nullable(),
        freeBytes: Count.nullable(),
      })
      .refine((d) => (d.neededBytes === null && d.freeBytes === null) || d.exportReason === "not-enough-space", {
        message: "the bytes belong to not-enough-space only",
        path: ["exportReason"],
      }),
  }),
]);
export type FreeHold = z.infer<typeof FreeHold>;

/**
 * What stops «Продолжить · до $R» (the single admission rule, §3.7 and §18.7), or null when it is open: the ledger holds reserves of a previous process or a
 * torn line (`reconcile-required`), the money is halted (`halt`), the ledger cannot be read (`ledger`), the key is rejected (`key`), the month has less room
 * than `needMicros` (`budget`), requests got no answer and a reconcile has not settled them (`network`), or the launch's own check failed (`internal`, never).
 * A credits, price or price-unavailable hold never blocks the click: it is admitted and the answer decides.
 */
export const RESUME_BLOCKED_BY = ["reconcile-required", "halt", "ledger", "key", "budget", "network", "internal"] as const;
export const ResumeBlockedBy = z.enum(RESUME_BLOCKED_BY);
export type ResumeBlockedBy = z.infer<typeof ResumeBlockedBy>;

/**
 * Where an avatar stands in a launch: planned, composing its scenes, awaiting the owner's review, approved and waiting for «Продолжить» (the launch is
 * paused), drawing its photos, montaging, done; or waiting / skipped with a reason of its own.
 */
export const AVATAR_PHASES = ["planned", "composing", "awaiting-review", "approved-waiting", "drawing", "montage", "done", "waiting", "skipped"] as const;
export const AvatarPhase = z.enum(AVATAR_PHASES);
export type AvatarPhase = z.infer<typeof AvatarPhase>;

/**
 * Why an avatar waits: another job of its own holds it, the owner has an open scene set of their own for it, the launch's paid work is held, or the library cannot say
 * which of its photos are free (unknown usage or drafts, a record that does not read, recovery still running): nothing is picked or dropped until it can.
 */
export const WaitingReason = z.enum(["avatar-busy", "open-set", "paid-hold", "library-unknown"]);
export type WaitingReason = z.infer<typeof WaitingReason>;

/**
 * Why an avatar leaves the launch (its share of the limit is not spent, the others go on). A failure-rate skip counts the photos that failed the checks and
 * the slice's photos.
 */
export const SKIP_REASONS = ["archived", "master-unusable", "face-gate-unavailable", "descriptor-invalid", "failure-rate", "set-unreadable"] as const;
export const SkipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;
const SkippedWithoutCounts = SKIP_REASONS.filter((reason) => reason !== "failure-rate").map((reason) => z.strictObject({ reason: z.literal(reason) }));
const Skipped = z.discriminatedUnion("reason", [
  z
    .strictObject({ reason: z.literal("failure-rate"), failed: Count, total: Count })
    .refine((s) => s.failed <= s.total, { message: "the failed photos are part of the total", path: ["failed"] }),
  ...SkippedWithoutCounts,
]);

/** Why videos were dropped from a launch (`dropped { count, reason }` on an avatar, `dropReason` on a video). */
export const DROP_REASONS = ["not-enough-photos", "render-failed", "avatar-gone", "launch-stopped", "avatar-skipped"] as const;
export const DropReason = z.enum(DROP_REASONS);
export type DropReason = z.infer<typeof DropReason>;

// ---------- the live view ----------

const Progress = z.strictObject({ done: Count, total: Count }).refine((p) => p.done <= p.total, { message: "done cannot pass the total", path: ["done"] });

/** One avatar's row on the launch card. */
export const LaunchAvatarView = z
  .strictObject({
    avatarId: Id,
    phase: AvatarPhase,
    /** Present exactly in the `waiting` phase. */
    waiting: z.strictObject({ reason: WaitingReason }).nullable(),
    /** Present exactly in the `skipped` phase. */
    skipped: Skipped.nullable(),
    photos: Progress,
    montage: Progress,
    videos: Progress,
    /** The avatar's scene set in this launch and the revision the window shows (the button on the card carries them); null before the set exists. */
    sceneSetId: Id.nullable(),
    setRevision: z.number().int().min(1).nullable(),
    /** The set's active scenes, those without a text, and how many photos «Продолжить запуск» would draw; null with no set. */
    scenes: Count.nullable(),
    scenesWithoutText: Count.nullable(),
    continuePhotos: Count.nullable(),
    /** The slice being drawn (1-based) of the slices the avatar's draw has so far. */
    slice: z.strictObject({ index: z.number().int().min(1), total: z.number().int().min(1) }).nullable(),
    dropped: z.strictObject({ count: z.number().int().min(1), reason: DropReason }).nullable(),
    /** Videos waiting for a track. */
    waitingMusic: Count,
    /** For the «Стоп» dialog: scenes of the set that will not be drawn, and the slots a started slice could still draw. */
    undrawnScenes: Count,
    resumableSlots: Count,
    /** The avatar's draw allocation (§4.3), for «в пределах запуска · до $Y»; null while it has nothing to draw. */
    drawAllocationMicros: Micros.nullable(),
  })
  .superRefine((row, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if ((row.phase === "waiting") !== (row.waiting !== null)) fail("waiting", "waiting is present exactly in the waiting phase");
    if ((row.phase === "skipped") !== (row.skipped !== null)) fail("skipped", "skipped is present exactly in the skipped phase");
    if ((row.sceneSetId === null) !== (row.setRevision === null)) fail("setRevision", "a set is named with its revision, or with neither");
    if (row.sceneSetId === null && (row.scenes !== null || row.scenesWithoutText !== null || row.continuePhotos !== null)) fail("scenes", "scene counts need a set");
    if (row.scenes !== null && row.scenesWithoutText !== null && row.scenesWithoutText > row.scenes) fail("scenesWithoutText", "scenes without a text are among the scenes");
    if (row.scenes !== null && row.continuePhotos !== null && row.continuePhotos > row.scenes) fail("continuePhotos", "the photos to draw are among the scenes");
    if (row.slice !== null && row.slice.index > row.slice.total) fail("slice", "the slice is numbered inside the total");
  });
export type LaunchAvatarView = z.infer<typeof LaunchAvatarView>;

// ---------- the log ----------

/** The kinds of a log line: the 23 rows of the design's log sheet. The engine writes types and numbers; the window words each. */
const line = <const K extends string, F extends z.ZodRawShape>(kind: K, fields: F) => z.strictObject({ at: IsoDateTime, avatarId: Id.optional(), kind: z.literal(kind), ...fields });

const LogSkipped = line("skipped", { reason: SkipReason, failed: Count.optional(), total: Count.optional() }).refine(
  (l) => (l.reason === "failure-rate") === (l.failed !== undefined && l.total !== undefined) && (l.failed === undefined) === (l.total === undefined) && (l.failed ?? 0) <= (l.total ?? 0),
  { message: "only a failure-rate skip counts its photos, and the failed ones are part of the total", path: ["reason"] },
);

const LOG_LINES = [
  line("start", { acceptedMicros: Micros }),
  line("scenes-ready", { scenes: Count, withoutText: Count }),
  line("review-continued", { photos: Count, writtenByOwner: Count }),
  line("slice-start", { index: z.number().int().min(1), total: z.number().int().min(1), photos: z.number().int().min(1), capMicros: Micros }),
  line("photo", { done: z.number().int().min(1), total: z.number().int().min(1), faceCos: z.number().min(-1).max(1).optional() }),
  line("photo-retry", { sceneId: SceneId, attempt: z.number().int().min(2), attempts: z.number().int().min(2), viaFallback: z.boolean() }).refine((l) => l.attempt <= l.attempts, {
    message: "a retry is an attempt within the attempts",
    path: ["attempt"],
  }),
  line("photo-failed", { slot: z.number().int().min(1), attempts: z.number().int().min(1), cause: z.enum(["face", "duplicate", "age", "moderation", "provider", "limit", "no-answer"]), faceCos: z.number().min(-1).max(1).optional() }),
  line("video-done", { key: LaunchVideoKey, shape: VideoShape, size: VideoSize, durationMs: z.number().int().min(1).max(LAUNCH_MAX_VIDEO_MS), bytes: z.number().int().min(1) }).refine(
    (l) => shapeSizeFits(l.shape, l.size),
    { message: "a shape has its own sizes", path: ["size"] },
  ),
  // A degrade may lose no video (slides of 5 become a collage of 4, §6.4): `fewerVideos` is 0 then, and some photos are missing either way.
  line("degrade", { fewerVideos: Count, missingPhotos: z.number().int().min(1) }),
  line("price-shrink", { fromPhotos: Count, toPhotos: Count }).refine((l) => l.toPhotos < l.fromPhotos, { message: "a price rise shrinks the slice", path: ["toPhotos"] }),
  line("review-write", { write: z.enum(["redraw", "rewrite"]), micros: Micros }),
  line("pausing", { requests: Count, renders: Count }),
  line("paused", {}),
  line("resumed", { acceptedRemainingMicros: Micros }),
  line("host-quit", { requests: Count }),
  line("network-retry", { attempt: z.number().int().min(1), attempts: z.number().int().min(1), afterMs: Count }).refine((l) => l.attempt <= l.attempts, { message: "a retry is within the retries", path: ["attempt"] }),
  line("hold-budget", { holdKind: BudgetHoldKind, freeMicros: Micros, needMicros: Micros }),
  LogSkipped,
  line("waiting-music", { key: LaunchVideoKey, neededMs: Count }),
  line("review-approved-paused", { photos: Count }),
  line("music-refresh", { added: Count, remaining: Count }),
  line("stopped", { spentMicros: Micros }),
  line("done", { videosDone: Count, videosPlanned: Count }),
  // The kinds the artboards draw beyond the log sheet: the holds, a busy avatar, a restart, scenes being written, the month ending mid-slice, a dropped render.
  line("hold-network", { drops: z.number().int().min(1) }),
  line("avatar-busy", {}),
  // The library cannot tell which photos are free (S4.6c2): once per wait, not per look.
  line("library-unknown", {}),
  line("app-restarted", { cause: z.enum(["quit", "engine-restart"]), requests: Count }),
  line("scenes-writing", { scenes: Count }),
  line("budget-ended", { done: Count, total: Count }),
  line("hold-key", {}),
  line("hold-credits", {}),
  line("hold-halt", { code: HaltCode }),
  line("hold-price", { detail: PriceHoldDetail }),
  line("hold-price-unavailable", { attempt: z.number().int().min(1) }),
  line("hold-internal", { holdKind: InternalHoldKind, detail: InternalHoldMessage.optional() }),
  line("hold-export", { exportReason: ExportUnavailableReason }),
  line("render-dropped", { key: LaunchVideoKey }),
  // S4.6r: a render that failed is submitted once more, free (§4.6); the drop above comes after the second failure.
  line("render-retry", { key: LaunchVideoKey }),
] as const;

export const LogLine = z.discriminatedUnion("kind", LOG_LINES);
export type LogLine = z.infer<typeof LogLine>;
export type LogKind = LogLine["kind"];
export const LOG_KINDS: readonly LogKind[] = LOG_LINES.map((l) => l.shape.kind.value);

// ---------- the view ----------

const PlanTotals = z
  .strictObject({ videos: Count, photos: Count, fromLibrary: Count, toGenerate: Count })
  .refine((p) => p.fromLibrary + p.toGenerate === p.photos, { message: "the photos are the library's and the new ones", path: ["photos"] });

/**
 * A launch as the window draws it. `plannedWorstMicros` is W′ (the worst case the engine recomputed at the start, never above `acceptedMicros`): the «из» of
 * «Потрачено $S из $W′» on every screen. `remainingMicros` is R = W′ − spent, the sum «Продолжить · до $R» accepts.
 */
export const LaunchView = z
  .strictObject({
    launchId: LaunchId,
    createdAt: IsoDateTime,
    /** When the launch ended; null while it is not done or stopped. */
    endedAt: IsoDateTime.nullable(),
    /** How long the launch has worked (paused and stopped time excluded): «в работе 3:28». */
    activeMs: Count,
    status: LaunchStatus,
    /** Present exactly while the launch is paused. */
    paused: z.strictObject({ cause: PausedCause, at: IsoDateTime }).nullable(),
    paidHold: PaidHold.nullable(),
    freeHold: FreeHold.nullable(),
    /** The settings the launch runs with (read-only on the screen while it runs). */
    draft: LaunchDraft,
    acceptedMicros: Micros,
    plannedWorstMicros: Micros,
    plannedExpectedMicros: Micros,
    plan: PlanTotals,
    /** From the ledger: settled at cost, open reserves at worst. */
    spentMicros: Micros,
    remainingMicros: Micros,
    /** Paid edits made on «Фото» during the review (a redraw, a rewrite): their own sum, outside the limit. */
    reviewWritesMicros: Micros,
    /** Requests in flight now (this process has a request out for each) and what their reserves stand at. */
    inFlight: z.strictObject({ requests: Count, openMicros: Micros }),
    /**
     * S4.6v: the launch's open reserves that NO request of this process is out for: those of a previous process after a restart, and those a drop or a timeout left on a
     * paused or held launch. They count at their worst case, inside `spentMicros`, until a reconcile settles them. DISJOINT from `inFlight` (one open reserve is in exactly one
     * of the two), so the window may show either or both and never adds a reserve twice. 0 once the launch has ended (as `inFlight`). Optional for a view from before it; the engine always fills it.
     */
    unsettled: z.strictObject({ requests: Count, openMicros: Micros }).optional(),
    /** Videos waiting for a track, over all avatars. */
    waitingMusic: Count,
    resumeBlockedBy: ResumeBlockedBy.nullable(),
    avatars: z.array(LaunchAvatarView).max(MAX_LAUNCH_AVATARS),
    logTail: z.array(LogLine).max(MAX_LAUNCH_LOG_TAIL),
  })
  .superRefine((v, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if ((v.status === "paused") !== (v.paused !== null)) fail("paused", "a pause is present exactly while the launch is paused");
    if (isEnded(v.status) !== (v.endedAt !== null)) fail("endedAt", "a launch has ended exactly when it is done or stopped");
    if (v.plannedWorstMicros > v.acceptedMicros) fail("plannedWorstMicros", "the planned worst case never exceeds what the click accepted");
    if (v.plannedExpectedMicros > v.plannedWorstMicros) fail("plannedExpectedMicros", "the expected cost never exceeds the worst case");
    if (v.remainingMicros !== Math.max(0, v.plannedWorstMicros - v.spentMicros)) fail("remainingMicros", "the remaining worst case is the planned worst case less what was spent");
    if (v.unsettled !== undefined) {
      if (v.unsettled.requests === 0 && v.unsettled.openMicros > 0) fail("unsettled", "open money needs a request");
      // Both are open reserves, which `spentMicros` counts at their worst case: together they cannot pass it, so a reserve listed in both shows up as a sum above it.
      if (v.inFlight.openMicros + v.unsettled.openMicros > v.spentMicros) fail("unsettled", "the open reserves in flight and unsettled are part of what was spent, each reserve in one of them");
    }
    const rows = v.avatars.map((a) => a.avatarId);
    if (!unique(rows) || rows.length !== v.draft.avatarIds.length || !rows.every((id) => v.draft.avatarIds.includes(id))) fail("avatars", "the rows are the draft's avatars, each once");
  });
export type LaunchView = z.infer<typeof LaunchView>;

/** One row of «История запусков». */
export const LaunchSummary = z
  .strictObject({
    launchId: LaunchId,
    createdAt: IsoDateTime,
    endedAt: IsoDateTime.nullable(),
    status: LaunchStatus,
    avatarCount: z.number().int().min(1).max(MAX_LAUNCH_AVATARS),
    avatarIds: z.array(Id).min(1).max(MAX_LAUNCH_AVATARS),
    videosDone: Count,
    videosPlanned: Count,
    spentMicros: Micros,
    acceptedMicros: Micros,
    /** W′: the «из» of «Потрачено $S из $W′». */
    plannedWorstMicros: Micros,
  })
  .superRefine((s, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if (s.avatarCount !== s.avatarIds.length) fail("avatarCount", "the count is the avatars listed");
    if (s.videosDone > s.videosPlanned) fail("videosDone", "the videos done are part of the plan");
    if (s.plannedWorstMicros > s.acceptedMicros) fail("plannedWorstMicros", "the planned worst case never exceeds what the click accepted");
    if (isEnded(s.status) !== (s.endedAt !== null)) fail("endedAt", "a launch has ended exactly when it is done or stopped");
  });
export type LaunchSummary = z.infer<typeof LaunchSummary>;

/**
 * A file of the library's `autopilot/` folder that is not a launch this build can read; `invalid` (damaged or foreign), `too-new` (a newer Studio), `io-error`.
 * S4.6g (additive): an `io-error` says where the read failed: `folder` (the `autopilot/` folder itself could not be listed, so there is no file to move) or `file`
 * (one launch file could not be opened). Only an `io-error` has a scope; an engine from before S4.6g sends none, and the window then words the two alike.
 */
export const UnreadableLaunch = z
  .strictObject({ entryId: LaunchEntryId, reason: z.enum(["invalid", "too-new", "io-error"]), scope: z.enum(["folder", "file"]).optional() })
  .refine((u) => u.scope === undefined || u.reason === "io-error", { message: "only an entry that did not read from the disk has a scope", path: ["scope"] });
export type UnreadableLaunch = z.infer<typeof UnreadableLaunch>;

export const LAUNCH_VIDEO_STATES = ["done", "rendering", "waiting-music", "dropped"] as const;
export const LaunchVideoState = z.enum(LAUNCH_VIDEO_STATES);
export type LaunchVideoState = z.infer<typeof LaunchVideoState>;

/**
 * One video of a launch, for the results list. A finished video is whole (its file, length, size and track); a rendering one has its file id and no size yet;
 * one waiting for music has neither file nor track; a dropped one says why. Only a finished video can be marked published.
 */
export const LaunchVideo = z
  .strictObject({
    key: LaunchVideoKey,
    avatarId: Id,
    shape: VideoShape,
    size: VideoSize,
    durationMs: z.number().int().min(1).max(LAUNCH_MAX_VIDEO_MS).nullable(),
    bytes: z.number().int().min(1).nullable(),
    track: z
      .strictObject({
        source: z.enum(["trending", "own"]),
        title: z.string().min(1).max(120),
        artist: z.string().min(1).max(120).nullable(),
      })
      .nullable(),
    state: LaunchVideoState,
    dropReason: DropReason.nullable(),
    videoId: Id.nullable(),
    /** When the owner marked it «Опубликовано» (`published.jsonl`); null when it is not marked, and also when `publishedUnknown`. */
    publishedAt: IsoDateTime.nullable(),
    /**
     * S4.6g (additive): a finished video whose record has been deleted since (`videos.delete`, or its avatar was deleted): it is no longer a video of the library, so the
     * results list does not draw it and the launch's `videosDone` does not count it. Absent for a video whose record stands.
     */
    removed: z.literal(true).optional(),
    /** S4.6g (additive): the avatar's «Опубликовано» marks could not be read, so `publishedAt: null` is not a verdict (as `videos.list`'s `published: "unknown"`). Absent when the marks were read. */
    publishedUnknown: z.literal(true).optional(),
  })
  .superRefine((v, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if (!shapeSizeFits(v.shape, v.size)) fail("size", "a shape has its own sizes");
    if ((v.state === "dropped") !== (v.dropReason !== null)) fail("dropReason", "a dropped video says why, and only a dropped video does");
    if (v.state === "done" && (v.videoId === null || v.bytes === null || v.durationMs === null || v.track === null)) fail("state", "a finished video has its file, length, size and track");
    if (v.state === "rendering" && (v.videoId === null || v.bytes !== null)) fail("state", "a rendering video has its file id and no size yet");
    if (v.state === "waiting-music" && (v.videoId !== null || v.bytes !== null)) fail("state", "a video that waits for music has no file");
    if (v.state === "dropped" && v.bytes !== null) fail("state", "a dropped video has no size (it may have had a file id: its render was submitted)");
    if (v.state === "waiting-music" && v.track !== null) fail("track", "a video waiting for music has no track");
    if (v.state !== "done" && v.publishedAt !== null) fail("publishedAt", "only a finished video can be published");
    if (v.state !== "done" && v.removed !== undefined) fail("removed", "only a finished video has a record to lose");
    if (v.state !== "done" && v.publishedUnknown !== undefined) fail("publishedUnknown", "only a finished video has a mark");
    if (v.publishedUnknown !== undefined && v.publishedAt !== null) fail("publishedUnknown", "a mark that cannot be read has no time");
  });
export type LaunchVideo = z.infer<typeof LaunchVideo>;

// ---------- the preview ----------

export const MonthFit = z.enum(["fits", "fits-expected", "short"]);
export type MonthFit = z.infer<typeof MonthFit>;

export const AutoRefresh = z.enum(["will", "not-needed", "no-quota", "no-key"]);
export type AutoRefresh = z.infer<typeof AutoRefresh>;

/** What blocks one avatar (a subset of the VALIDATION reasons): its plan needs new photos and it has an open set, needs over 100, or its usage is unreadable. */
export const AVATAR_BLOCKER_CODES = ["open-set", "too-many-photos", "usage-unknown"] as const;
/** What blocks the whole launch before anything is written or spent. */
export const LAUNCH_BLOCKER_CODES = ["launch-active", "launch-unreadable", "no-key", "nothing-enabled", "reconcile-required", "halt", "ledger", "export-unavailable"] as const;
export const AvatarBlockerCode = z.enum(AVATAR_BLOCKER_CODES);
export const LaunchBlockerCode = z.enum(LAUNCH_BLOCKER_CODES);
export type AvatarBlockerCode = z.infer<typeof AvatarBlockerCode>;
export type LaunchBlockerCode = z.infer<typeof LaunchBlockerCode>;

/** A blocker names its avatar when it is an avatar's and names none when it is the launch's. */
export const LaunchBlocker = z.union([
  z.strictObject({ code: AvatarBlockerCode, avatarId: Id }),
  z.strictObject({ code: LaunchBlockerCode }),
]);
export type LaunchBlocker = z.infer<typeof LaunchBlocker>;

const PreviewShapes = z.strictObject({ single: Count, collage: Count, slides: Count });

/**
 * One avatar's part of the preview. `videos` is how many videos the plan makes for it, `fromLibrary` and `toGenerate` the photos it takes and the photos it
 * pays for, `free` the free photos in the chosen categories (not the same as `fromLibrary`), `busy` that another job of its own holds it now (information, not a
 * refusal: the launch waits). A blocked avatar's figures are informational: it counts for nothing in the totals, the estimate and the month's fit.
 */
export const LaunchPreviewAvatar = z
  .strictObject({
    avatarId: Id,
    videos: z.number().int().min(0).max(MAX_VIDEOS_PER_AVATAR),
    shapes: PreviewShapes,
    free: Count,
    fromLibrary: Count,
    toGenerate: Count,
    busy: z.boolean(),
    blocked: AvatarBlockerCode.nullable(),
    usage: AvatarUsage,
  })
  .refine((a) => a.shapes.single + a.shapes.collage + a.shapes.slides === a.videos, { message: "the shapes add up to the videos", path: ["shapes"] })
  .refine((a) => a.usage.state === "ok" || (a.free === 0 && a.fromLibrary === 0), { message: "an avatar whose usage cannot be trusted gives no library photos", path: ["usage"] });

export type LaunchPreviewAvatar = z.infer<typeof LaunchPreviewAvatar>;

/**
 * What `autopilot.estimate` answers: the plan, the engine's own estimate of it, the month's room, and everything the plan card shows. The renderer computes no
 * money: it draws these figures. `month.fit` follows from the numbers (`monthFit`, §4.4): `fits` when the room covers the worst case, `fits-expected` when it
 * covers the expected cost only, `short` when it does not.
 */
export const LaunchPreview = z
  .strictObject({
    planSeed: PlanSeed,
    avatars: z.array(LaunchPreviewAvatar).max(MAX_LAUNCH_AVATARS),
    /** Over the avatars that are not blocked. */
    totals: z.strictObject({ videos: Count, photosNeeded: Count, fromLibrary: Count, toGenerate: Count }),
    estimate: Estimate,
    /** What a video of each shape costs when its photos are new: 1, 3 and 5 times the expected price of a photo. */
    perShapeExpectedMicros: z.strictObject({ single: Micros, collage: Micros, slides: Micros }),
    month: z.strictObject({
      budgetMicros: Micros,
      committedMicros: Micros,
      freeMicros: Micros,
      fit: MonthFit,
      /**
       * «поднимите бюджет до $X» (§4.4, `$⌈W − R + B⌉`): the monthly budget, in whole dollars rounded up, at which the room covers the worst case — what is
       * committed plus W (`raiseBudgetToMicros`, shared/autopilot/money.ts). Null when the room already covers W. The window shows it as it comes.
       */
      raiseToMicros: Micros.nullable(),
    }),
    /** The OpenRouter balance (a warning only, never a gate); null without a key or when it could not be read. */
    balance: z.strictObject({ micros: Micros, asOf: IsoDateTime }).nullable(),
    music: z.strictObject({
      candidates: Count,
      ownFlagged: Count,
      explicitSkipped: Count,
      autoRefresh: AutoRefresh,
      /** Requests left of the 30 in the rolling 31 days; null when the quota log cannot be read. */
      quotaRemaining: Count.max(MUSIC_QUOTA_LIMIT).nullable(),
    }),
    disk: z.strictObject({ neededBytes: Count, freeBytes: Count.nullable() }),
    timeSeconds: Count,
    blockers: z.array(LaunchBlocker).max(MAX_LAUNCH_AVATARS + LAUNCH_BLOCKER_CODES.length),
  })
  .superRefine((p, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    const counted = p.avatars.filter((a) => a.blocked === null);
    const sum = (pick: (a: (typeof counted)[number]) => number): number => counted.reduce((total, a) => total + pick(a), 0);
    if (!unique(p.avatars.map((a) => a.avatarId))) fail("avatars", "an avatar must not repeat");
    if (p.totals.videos !== sum((a) => a.videos)) fail("totals", "the videos are the sum over the avatars that are not blocked");
    if (p.totals.fromLibrary !== sum((a) => a.fromLibrary)) fail("totals", "the library photos are the sum over the avatars that are not blocked");
    if (p.totals.toGenerate !== sum((a) => a.toGenerate)) fail("totals", "the new photos are the sum over the avatars that are not blocked");
    if (p.totals.photosNeeded !== p.totals.fromLibrary + p.totals.toGenerate) fail("totals", "the photos needed are the library's and the new ones");
    const { budgetMicros, committedMicros, freeMicros, fit } = p.month;
    if (freeMicros !== Math.max(0, budgetMicros - committedMicros)) fail("month", "the room is the budget less what is committed, never below zero");
    const expected = freeMicros >= p.estimate.expectedMicros;
    const worst = freeMicros >= p.estimate.worstMicros;
    if (fit !== (worst ? "fits" : expected ? "fits-expected" : "short")) fail("month", "the fit follows from the room, the expected cost and the worst case");
    const need = committedMicros + p.estimate.worstMicros;
    const raise = worst ? null : need % MICROS_PER_DOLLAR === 0 ? need : need - (need % MICROS_PER_DOLLAR) + MICROS_PER_DOLLAR;
    if (p.month.raiseToMicros !== raise) fail("month", "the raise is the budget in whole dollars that covers what is committed and the worst case, and none when the room covers it");
    for (const avatar of p.avatars) {
      if (avatar.blocked !== null && !p.blockers.some((b) => b.code === avatar.blocked && "avatarId" in b && b.avatarId === avatar.avatarId)) fail("blockers", "a blocked avatar has its blocker");
    }
  });
export type LaunchPreview = z.infer<typeof LaunchPreview>;

// ---------- results of the commands ----------

export const AutopilotEstimateResult = z.strictObject({ preview: LaunchPreview });
export const AutopilotLaunchResult = z.strictObject({ launch: LaunchView });

/** `autopilot.continueAfterReview`: whether the draw starts now, or the approval is only recorded because the launch is paused (the draw waits for «Продолжить»). */
export const AutopilotContinueResult = z.strictObject({ launch: LaunchView, draw: z.enum(["started", "waits-for-resume"]) });

export const AutopilotListResult = z.strictObject({
  launches: z.array(LaunchSummary).max(MAX_LISTED_LAUNCHES),
  unreadable: z.array(UnreadableLaunch).max(MAX_LISTED_LAUNCHES),
});

export const AutopilotGetResult = z
  .strictObject({
    launch: LaunchView,
    log: z.array(LogLine).max(MAX_LAUNCH_LOG_LINES),
    videos: z.array(LaunchVideo).max(MAX_LAUNCH_VIDEOS),
    /**
     * S4.6g (additive), as `videos.list`'s: whether the «Опубликовано» marks of the launch's avatars could be read. Absent while no avatar of the launch has a log of marks;
     * `unknown` when at least one avatar's log could not be read (its videos say `publishedUnknown`); `ok` otherwise.
     */
    published: z.enum(["ok", "unknown"]).optional(),
  })
  .refine((r) => unique(r.videos.map((v) => v.key)), { message: "a video key must not repeat", path: ["videos"] });
export type AutopilotGetResult = z.infer<typeof AutopilotGetResult>;
