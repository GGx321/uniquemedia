import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import {
  AvatarDescriptor,
  Id,
  AvatarTraits,
  errorResponseFor,
  EventLog,
  parseEngineCommand,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type MusicKeyStatus,
  type AvatarSummary,
  type CommandPayload,
  type Draft,
  type EngineCommandMessage,
  type EngineError,
  type EngineNotice,
  type ExportStatus,
  type Estimate,
  type EventMessage,
  type ImageAgeCheck,
  type LedgerUnavailable,
  type MoneyHalt,
  type MoneyStatus,
  type PhotoSummary,
  type ReconcileReason,
  type ReconcileResult,
  type ReconcileWarning,
  type ResponseMessage,
  type RunSummary,
  type Settings,
  type Snapshot,
  type UnreadableAvatar,
  type UnsequencedEvent,
  UNREADABLE_REASON_DETAIL,
  OWN_MUSIC_NOT_FOUND_DETAIL,
  MAX_LISTED_PHOTOS,
  MAX_LISTED_RUNS,
} from "../shared/engine";
import { downscaleToJpeg, MAX_SOURCE_PIXELS, preflightDownscale } from "../node/downscale";
import { windowPeaks } from "../shared/music/trackShape";
import { timeoutSignal, untilAborted } from "./money/timeoutSignal";
import { AGE_CHECK_MAX_SIDE, passesAgeThreshold } from "./avatars/ageCheck";
import { candidateJobEnd, runCandidateJob, type SlotOutcome } from "./avatars/candidateJob";
import { runDescriptorJob } from "./avatars/descriptorJob";
import { runImportJob, type ImportJobResult } from "./avatars/importJob";
import { checkImportPhoto, IMPORT_DESCRIBE_MAX_SIDE } from "./avatars/importStaging";
import {
  avatarJobEstimate,
  avatarPriceModels,
  CANDIDATES_PER_BATCH,
  descriptorJobCap,
  importJobEstimate,
  importPriceModels,
  type AvatarModels,
} from "./avatars/plan";
import { promptSubject, PromptSubjectError } from "./avatars/prompts";
import { avatarCounts, avatarSummaryFrom, combineUnreadable, draftFrom, isRewritable, libraryView, manifestTraits, unreadableFromQuarantine } from "./avatars/records";
import { EngineFailure } from "./engineFailure";
import { JobRegistry, type CandidatesJobEnd } from "./jobs";
import { CaseSensitivityProbe } from "./exportCase";
import { checkExportRoot, exportStatusOf, NODE_EXPORT_ROOT_FS, type ExportRootCheck, type ExportRootFs } from "./exportRoot";
import { folderIdentity, NODE_FOLDER_FS, type FolderFs } from "./folderIdentity";
import { EngineReply, HostCall, HostControl, isControlMessage, MEDIA_IMPORT_ENGINE_DEADLINE_MS, type EngineInit, type EngineSettings } from "./control";
import { LIBRARY_FILE, LibraryError, LibraryFileSchema, openLibrary, type AvatarManifest, type Library, type LogIssue } from "./library";
import type { ImageMediaType } from "./library/media";
import { finalizePhotoList, looksLikeRunPhoto, photoSummaryFrom } from "./library/photoRecords";
import { STUDIO_E2E } from "./buildFlags";
import { Budget, scopeKey, type BudgetStatus } from "./money/budget";
import { MoneyError } from "./money/errors";
import { Ledger, type Scope } from "./money/ledger";
import { PriceCache, type PricedBook } from "./money/priceCache";
import type { PriceBook } from "./money/prices";
import { loadPriceBook, OPENROUTER_API_BASE } from "./money/prices";
import type { ReconcileResult as LedgerReconcileResult, ReconcileWarning as LedgerReconcileWarning } from "./money/reconcile";
import { createOpenRouterClient, fromOpenRouterError, OpenRouterError, type OpenRouterClient, type OpenRouterFetch } from "./openrouter";
import { priceFetchFrom } from "./openrouter/priceFetch";
import { rawFileName, saveRawBody } from "./rawStore";
import { foldRun, RunEventSchema, type LedgerView, type RunState } from "./runs/journal";
import { buildRunPlan, RunPlanSchema, runEstimate, runPriceModels, sceneCategory, type RunPlan } from "./runs/plan";
import { CpuPool, NetworkPool } from "./runs/pools";
import { FACE_GATE_NAME } from "./runs/faceGate";
import { AGE_GATE_NAME, type QaGate } from "./runs/qa";
import { capFundsResume, remainingPlan, scopeCommitted } from "./runs/remaining";
import { preflightMaster, reportingTo, runPhotoRun, type RunJobEnd } from "./runs/runJob";
import { plan as planScenes } from "./scenes";
import { configureFfmpegEnv } from "../node/ffmpegEnv";
import { RenderQueue } from "./renderQueue/queue";
import { renderPoolSize } from "./renderQueue/pool";
import { maskHome } from "./renderQueue/scrubber";
import { createFocusResolver, type FocusFaceGate, type FocusResolver } from "./focus/focusResolver";
import { CommitTracker } from "./videos/live";
import { FileStateChecker } from "./videos/fileState";
import type { MediaImporters } from "./media/imports";
import { MediaService } from "./media/service";
import { MediaDiskError } from "./library/mediaRecords";
import type { MediaStagingOptions } from "./media/staging";
import { countRecordsByRoot, libraryHasVideoRecords } from "./videos/rootCounts";
import { ownPhotoSourceOf, readVerifiedOwnPhoto } from "./videos/ownPhotos";
import { ownTrackFactsOf } from "./videos/ownTrack";
import { ownVideoFactsOf } from "./videos/ownVideos";
import { VideoService, type VideoServiceDeps } from "./videos/service";
import { createStickerAssets, StickerAssetError, type StickerAssets } from "./videos/stickerAssets";
import { MontageService, type MontageServiceDeps } from "./montages/service";
import { DraftStore, type DraftStoreDeps } from "./montages/store";
import { FLASHAPI_BASE, type FlashapiFetch } from "./music/client";
import type { RenderTrackSource } from "./music/renderTrack";
import { MusicService, type MusicListSink } from "./music/service";
import { createTextPreviewService, TEXT_PREVIEW_DIR, type PreviewGate, type TextPreviewService } from "./text/preview";
import { RasterError } from "./text/rasterTypes";

/** Events kept for `engine.events` catch-up; an older `afterSeq` gets `gap` and refetches the snapshot. */
export const EVENT_LOG_CAPACITY = 1000;

/** What an engine without a text runtime draws text through: a refusal, so `montages.textPreview` says so instead of pretending. */
const NO_TEXT_GATE: PreviewGate = {
  caption: () => Promise.reject(new RasterError("WORKER_FAILED", "no text worker is wired into this engine")),
};

/** What an engine given no sticker folder reads stickers from: a refusal that names no path, so a render with a sticker fails its job instead of dropping it. */
const NO_STICKERS: StickerAssets = {
  read: () => Promise.reject(new StickerAssetError("unreadable", "this engine was given no sticker folder")),
};

/** `detail` travels as T0 `SafeText`, which allows at most 500 chars. */
const MAX_DETAIL = 500;

export interface EngineDeps {
  /** A fresh random id per engine start; events and snapshots carry it. */
  bootId: string;
  /** Wall clock, epoch ms. */
  clock: () => number;
  /** Monotonic ms, for the Budget's reconcile wait. */
  monotonic: () => number;
  newId: () => string;
  /** Test knob: the window within which swallowed-rejection notices are coalesced; `INTERNAL_NOTICE_WINDOW_MS` (5 s) when absent. */
  internalNoticeWindowMs?: number;
  /** Every response, every sequenced event and every reply to main leaves through here (the MessagePort). */
  post: (message: ResponseMessage | EventMessage | EngineReply) => void;
  /** The fetch every OpenRouter request goes through: the runtime's own in the utilityProcess, a fake in tests. */
  fetch: OpenRouterFetch;
  /**
   * The fetch the flashapi client uses (3c.3): the runtime's own by default. A test passes one that answers the REAL
   * base URL from a loopback mock, so the real host is never contacted and the URL the engine asks for is still checked.
   */
  musicFetch?: FlashapiFetch;
  /**
   * Where a fetched list goes (3c.4's track store). Absent: `MemoryListSink`, which does not persist, so
   * `music.refresh` is refused as not available yet. 3c.4 passes its persisting sink here (`main.ts`), which is the one
   * switch that turns the refresh on.
   */
  musicSink?: MusicListSink;
  /**
   * The track store as the render's source of a track's file (3c.5, invariant 31): `videos.render` and `montages.get` judge a
   * montage's trending track against its record, and a render job opens the file through it, after the store has checked it
   * again. `main.ts` passes the same `TrackStore` as `musicSink`. Absent: no track is held, and a spec with music is refused
   * as `track-unavailable`.
   */
  musicTracks?: RenderTrackSource;
  /**
   * The importers of own media, by kind (3f.1, 3f.1b): each takes the STAGED copy of a picked file, inside the import job, and answers what
   * it learned of it (and the file it made, if it made one), or turns the file away. The job stores the file and writes the record.
   * 3f.2 to 3f.5 pass theirs. A kind with none is refused as `not-yet-supported`, before its file is copied.
   */
  mediaImporters?: MediaImporters;
  /**
   * Whether a queued or running render uses an own media (3f.1b review M-3): `media.delete` is refused with IN_FLIGHT while it does. Absent,
   * the engine's own render queue provides it, as it does `reservedPhotos` (3f.2 wired it for photos; 3f.3b video, 3f.4 music and 3f.5
   * stickers add their media to the same set). A test passes its own.
   */
  reservedMedia?: (mediaId: string) => boolean;
  /** Test knob: the disk calls, `O_NOFOLLOW`, chunk size and caps of the staging copy. */
  mediaStaging?: Pick<MediaStagingOptions, "ops" | "noFollow" | "chunkBytes" | "caps" | "freeBytes" | "freeMarginBytes" | "fs" | "warn">;
  /** Test knob: how long the engine lets one `media.import` call take to open the file (the job's copy is not bound by it); `MEDIA_IMPORT_ENGINE_DEADLINE_MS` unless a test says otherwise. */
  mediaImportDeadlineMs?: number;
  /** Where library folders' identities are read; the real filesystem unless a test plays another volume. */
  folderFs?: FolderFs;
  /** The disk the export folder's check runs on; the real one unless a test plays a failing one. */
  exportRootFs?: ExportRootFs;
  /** Bounds each export folder check; EXPORT_CHECK_TIMEOUT_MS unless a test says otherwise. A function is asked at the start of each check (a test gives a hung check a short bound and the real check after it one that cannot race). */
  exportCheckTimeoutMs?: number | (() => number);
  /**
   * Whether the export folder's VOLUME folds letter case, asked per folder (3a.8b.1): a probe file and its case-flipped
   * name, not the platform's guess (APFS can be case-sensitive). The real probe unless a test plays a volume.
   */
  caseProbe?: { isCaseInsensitive(root: string): Promise<boolean> };
  /**
   * The scene photos of `avatarId` that queued or running renders hold (S16),
   * asked afresh each time; the library keeps them out of `eligibleUnusedPhotos`
   * and marks them `reserved`. Absent, the engine's own render queue provides it
   * (queued and running specs); tests inject a stub to try the library's rule alone.
   */
  reservedPhotos?: (avatarId: string) => ReadonlySet<string>;
  /**
   * Downscales a tiny built-in image through the same ffmpeg path a real
   * slot's image would take (M8's `generateCandidates` preflight). Defaults
   * to `studio/node/downscale.ts`'s real one; tests inject a hanging or
   * failing fake here instead of a broken ffmpeg path or a shell stub (which
   * would not run the same way on Windows).
   */
  preflightDownscale?: (signal: AbortSignal) => Promise<void>;
  /** Bounds the preflight above; PREFLIGHT_TIMEOUT_MS unless a test says otherwise. */
  preflightTimeoutMs?: number;
  /** Bounds #liveLibrary's identity re-check; LIVE_LIBRARY_IDENTITY_TIMEOUT_MS unless a test says otherwise. */
  liveLibraryIdentityTimeoutMs?: number;
  /**
   * T6c: downscales a staged import photo's raw bytes to the JPEG its one
   * paid call (the describe call) attaches, at `maxSide`.
   * Defaults to `studio/node/downscale.ts`'s real one (the same ffmpeg path
   * every candidate portrait's own downscale takes, and the one that really
   * kills ffmpeg on `signal`'s own abort); tests inject a failing fake here
   * instead of constructing a genuinely oversized image, or one that ignores
   * `signal` entirely to exercise the M4 timeout below on its own.
   */
  downscaleImportPhoto?: (bytes: Uint8Array, maxSide: number, signal: AbortSignal) => Promise<Uint8Array>;
  /** M4: bounds the import's downscale to the describe call's size; IMPORT_DOWNSCALE_TIMEOUT_MS unless a test says otherwise. */
  importDownscaleTimeoutMs?: number;
  /**
   * T6: the QA gates every photo run's paid images pass through, in order
   * (runs/qa.ts). None by default: T7a (PDQ, the optional age check) and T7b
   * (the face gate) wire theirs in here.
   */
  qaGates?: readonly QaGate[];
  /** T6: local work in flight at once (the QA gates); `defaultCpuPoolSize()` unless a test says otherwise. */
  cpuPoolSize?: number;
  /**
   * Money review M3: when `studio/engine/main.ts` could not load the face
   * gate (missing/corrupt models, a WASM codec failure, or its own load
   * timed out — never a hung ORT init left the engine unresponsive), this
   * carries WHY, so `#assertFaceGate()`'s `FACE_GATE_UNAVAILABLE` detail
   * says more than a generic "no face gate is wired" — useful in a support
   * report even though the app's own UI still shows the same fixed Russian
   * message either way (errorMessagesRu.ts).
   */
  faceGateLoadError?: string;
  /**
   * The text worker's gate (3b.2), owned by the engine from 3b.4b: `montages.textPreview` draws through it. The gate is
   * created synchronously by `engine/main.ts` and is live before its worker has loaded (it spawns one on the first call, and
   * after a failed load the next call retries), so it is handed over even when the start-up did not wait for the load.
   * `loadError` reads how the LOAD ended, if it ended in an error, and is read only when a command fails because the worker
   * itself failed (`WORKER_FAILED`), for the `RENDER_FAILED` detail as `faceGateLoadError` does for the face gate. It is not cleared
   * when a later call succeeds (the gate retries), so it says why the load failed, never that the worker is down now.
   * Absent (a test, a build without the text runtime): every text command answers `RENDER_FAILED`.
   */
  text?: { gate: PreviewGate; loadError?: () => string | undefined };
  /**
   * The face worker's gate as the focus resolver uses it (`videos.render` fills every missing focus point, S8). Absent
   * or null: every cell takes the stand-in point, and the render goes on (a focus never blocks a render).
   */
  faceGate?: FocusFaceGate | null;
  /** Test seams of the video pipeline: the focus resolver, ffmpeg and the commit's steps, recovery, the stale-index retry. */
  videos?: Partial<Pick<VideoServiceDeps, "fs" | "focus" | "renderOverrides" | "recover" | "staleRetryDelaysMs">> & {
    /** How long `videos.render` may spend on the focus of its photos; `RENDER_FOCUS_BUDGET_MS` unless a test says otherwise. */
    focusBudgetMs?: number;
  };
  /** Test seams of the montage drafts: the focus resolver, the budget, the seed of a new draft, the draft write's crash point. */
  montages?: Partial<Pick<MontageServiceDeps, "focus" | "focusBudgetMs" | "randomSeed" | "commandDeadlineMs" | "commandMarginMs">> & Partial<Pick<DraftStoreDeps, "beforeRename">>;
}

/** How long one `videos.render` may spend filling the focus of its photos. Under main's 30 s command deadline, so the answer (or the refusal) always arrives before main gives up. */
export const RENDER_FOCUS_BUDGET_MS = 15_000;

/** How long the engine waits, when it is told to stop, for renders to end (a commit past its claim finishes in a few flushes). Under main's own bound on that wait. */
export const SHUTDOWN_RENDER_WAIT_MS = 5_000;

/** Local work in flight at once: the cores but one for the engine's own event loop, at most 4, at least 1. */
export function defaultCpuPoolSize(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** The avatar's recent scene history the planner steers away from (location + outfit pairs), about two runs' worth. */
export const RECENT_PAIRS = 40;

/** A run's planner seed: fixed by its id, so the plan is reproducible from the run alone. */
function seedOf(runId: string): number {
  return Number.parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 8), 16);
}

/**
 * A message as an error's `detail`: the user's home folder is masked as `~` (an fs error names the owner's library
 * path, and `detail` reaches the renderer), then the text is cut to `MAX_DETAIL`. Masked first, so a path split by the
 * cut cannot escape.
 */
function detailOf(message: string): string {
  const masked = maskHome(message);
  return masked.length <= MAX_DETAIL ? masked : `${masked.slice(0, MAX_DETAIL - 1)}…`;
}

function messageOf(error: unknown, fallback: string): string {
  return detailOf(error instanceof Error ? error.message : fallback);
}

/**
 * Where an E2E build points a client whose mock was not asked for: a loopback port nothing listens on, so a request is refused
 * at once. An E2E build has shortened money timings (a 15 s request timeout, a 5 s reconcile wait: money/budget.ts) and must
 * never spend the owner's real key on the real API, which is what falling back to the real base would do (someone builds the
 * E2E package and opens it). Fail closed: no mock, no traffic.
 */
export const E2E_UNROUTABLE_ORIGIN = "http://127.0.0.1:1";

/**
 * The OpenRouter API base the client (T3) must use: the real one, unless this
 * is an E2E build (invariant 13): then the mock main asked for, and with none asked for a base that goes nowhere
 * (`E2E_UNROUTABLE_ORIGIN`), never the real one. `e2e` is the build flag; it is a parameter so both branches can be tested.
 */
export function resolveOpenRouterBaseUrl(requested: string | undefined, e2e: boolean): string {
  if (!e2e) return OPENROUTER_API_BASE;
  return requested ?? `${E2E_UNROUTABLE_ORIGIN}/api/v1`;
}

/**
 * The flashapi base the music client must use: the real one, unless this is an E2E build (the same rule as OpenRouter's,
 * invariant 13): then the mock main asked for, and with none asked for a base that goes nowhere (`E2E_UNROUTABLE_ORIGIN`),
 * never the real one. A production build has `STUDIO_E2E` false, so the override is inert there whatever main sends.
 * `e2e` is a parameter so both branches can be tested.
 */
export function resolveMusicBaseUrl(requested: string | undefined, e2e: boolean): string {
  if (!e2e) return FLASHAPI_BASE;
  return requested ?? E2E_UNROUTABLE_ORIGIN;
}

/**
 * Hands one message from main to the engine once it has started. A message
 * the engine fails on is logged by the error's kind only (its text may carry
 * a key or a path) and never left as an unhandled rejection. A message for an
 * engine that did not start is dropped: `exitIfStartFails` reports that once
 * and ends the process. Never rejects.
 */
export function deliver(ready: Promise<Pick<Engine, "receive">>, message: unknown, log: (line: string) => void = console.error): Promise<void> {
  return ready.then(
    (engine) =>
      engine.receive(message).catch((error: unknown) => {
        log(`studio engine: a message from main could not be handled (${errorKind(error)})`);
      }),
    () => undefined,
  );
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * For the utilityProcess entry: an engine that failed to start logs the
 * error's kind only (its text may carry a key or a path) and ends the process
 * with 1, so main restarts it and tells the windows, instead of leaving a
 * process that never answers.
 */
export function exitIfStartFails(ready: Promise<unknown>, exit: (code: number) => void, log: (line: string) => void = console.error): void {
  ready.catch((error: unknown) => {
    log(`studio engine: the engine could not start (${errorKind(error)})`);
    exit(1);
  });
}

/** Maps a thrown error to the T0 error set; money codes keep their own code. */
export function engineErrorFrom(error: unknown): EngineError {
  if (error instanceof EngineFailure) return error.error;
  if (error instanceof MoneyError) {
    const detail = detailOf(error.message);
    switch (error.code) {
      case "LEDGER_CORRUPT":
      case "LEDGER_WRITE_FAILED":
      case "SETTLE_ABOVE_WORST":
      case "PRICE_UNAVAILABLE":
        return { code: error.code, detail };
      case "LEDGER_TORN":
        return { code: "RECONCILE_REQUIRED", detail };
      default:
        return { code: "INTERNAL", detail };
    }
  }
  return { code: "INTERNAL", detail: messageOf(error, "unexpected engine error") };
}

/** A file name as a log line may carry it: anything outside a plain path alphabet becomes `?`, so a name cannot forge a line or move the cursor. */
function loggable(name: string): string {
  return name.replace(/[^A-Za-z0-9._/-]/g, "?");
}

/**
 * The open-time lines for records and logs that could not be read (one per
 * issue, plus one for an avatar a misfiled record names): the avatar, the file
 * relative to its folder and the reason class, never an absolute path or content.
 */
export function logIssueLines(issues: readonly LogIssue[]): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const what = issue.reason === "too-new" ? "update the app to use it" : "its photos are held back until it is repaired";
    lines.push(`studio engine: avatar ${issue.avatarId}: ${loggable(issue.file)} is ${issue.reason}; ${what}`);
    if (issue.otherAvatarId !== undefined) {
      lines.push(`studio engine: avatar ${issue.otherAvatarId}: a record filed under avatar ${issue.avatarId} names it; its photos are held back until that is repaired`);
    }
  }
  return lines;
}

/** Why the ledger could not be opened: broken content, or a file that could not be read. */
function ledgerUnavailable(error: unknown): LedgerUnavailable {
  if (error instanceof MoneyError && error.code === "LEDGER_CORRUPT") return { cause: "LEDGER_CORRUPT", detail: detailOf(error.message) };
  return { cause: "LEDGER_UNREADABLE", detail: messageOf(error, "the ledger could not be read") };
}

/** T2's reconcile vocabulary in the contract's; `satisfies` makes a new T2 value without a mapping a compile error. */
const WARNING_OF = { CLOCK_SKEW: "clock-skew" } as const satisfies Record<LedgerReconcileWarning, ReconcileWarning>;
const DELTA_UNAVAILABLE_OF = { NO_BASELINE: "no-baseline", NEGATIVE_DELTA: "negative-delta" } as const satisfies Record<
  NonNullable<Extract<LedgerReconcileResult, { ok: true }>["deltaUnavailable"]>,
  NonNullable<Extract<ReconcileResult, { status: "done" }>["deltaUnavailable"]>
>;

/** T2's answer in the contract's shape: `done`, or `too-early` with the wait. */
function reconcileResultOf(result: Exclude<LedgerReconcileResult, { reason: "IN_FLIGHT" }>): ReconcileResult {
  if (!result.ok) return { status: "too-early", retryAfterMs: result.retryAfterMs, warnings: result.warnings.map((w) => WARNING_OF[w]) };
  return {
    status: "done",
    creditsDeltaMicros: result.creditsDeltaMicros,
    deltaUnavailable: result.deltaUnavailable === null ? null : DELTA_UNAVAILABLE_OF[result.deltaUnavailable],
    ledgerDeltaMicros: result.ledgerTotalMicros,
    mismatch: result.mismatch,
    closedReserves: result.closedAttempts.length,
    aboveWorstAttempts: result.aboveWorstAttempts,
    tornLineMoved: result.tornMoved,
    warnings: result.warnings.map((w) => WARNING_OF[w]),
  };
}

type Money = { ok: true; budget: Budget } | { ok: false; unavailable: LedgerUnavailable };

/** The manifest needs a name; a draft gets the user's name only when a candidate is picked. */
const DRAFT_NAME = "Draft";

/** How long generateCandidates' ffmpeg preflight (M8) may take before it answers a clear error and spends nothing. */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

/** How long #liveLibrary's identity re-check (one stat, one realpath) may take before it is read as "cannot be identified right now" (review LOW 15). */
export const LIVE_LIBRARY_IDENTITY_TIMEOUT_MS = 5_000;
/** How long after an ok `export.choose` renders wait for the `settings.update` that follows (main's own deadline for a call). */
const EXPORT_SWITCH_WAIT_MS = 30_000;

/** Bounds one export folder check (start, a settings update, a render attempt): a stale network share must not block any of them. */
export const EXPORT_CHECK_TIMEOUT_MS = 5_000;

/**
 * T6c review round 2, M4: how long import.stagePhoto's one downscale (the
 * describe call's size; the age check's second one left with the import's age
 * check, 2026-10-05) may take before it answers a clear error and stages
 * nothing. The worst case (10 s) stays well under main's own
 * REQUEST_TIMEOUT_MS (30 s, engineHost.ts) for this same control call.
 */
export const IMPORT_DOWNSCALE_TIMEOUT_MS = 10_000;

/** A candidate job while it runs: what it was started with, and how many slots are done. */
interface RunningCandidates {
  jobId: string;
  scope: Scope;
  avatarId: string;
  descriptor: AvatarDescriptor;
  /** The key the job was started with: a 401 marks this key rejected, not one stored since. */
  key: string;
  budget: Budget;
  /** The library the draft is in; a library switch is refused while the job runs. */
  library: Library;
  priceBook: PriceBook;
  imageModel: string;
  concurrency: number;
  /** Captured at #generateCandidates: a mid-flight settings.setImageAgeCheck must not affect this running job. */
  imageAgeCheck: ImageAgeCheck;
  signal: AbortSignal;
  done: number;
}

/** A job of a photo run while it runs: its persisted plan and what it was started or resumed with. */
interface RunningRun {
  jobId: string;
  plan: RunPlan;
  descriptor: AvatarDescriptor;
  /** The key the job was started with: a 401 marks this key rejected, not one stored since. */
  key: string;
  budget: Budget;
  /** The library the run lives in; a library switch is refused while the job runs. */
  library: Library;
  priceBook: PriceBook;
  signal: AbortSignal;
}

/** A library, the identity of its folder, and the whole avatar folders quarantined (bounded) when it was opened. */
interface OpenedLibrary {
  library: Library;
  identity: string;
  unreadable: UnreadableAvatar[];
}

/**
 * The engine's state and command dispatcher. Every message from main is
 * parsed here: control messages (the API key, settings) against
 * `HostControl`, everything else with T0 `parseEngineCommand`, so a main-only
 * key command can never be executed by the engine. Commands without a
 * handler yet answer INTERNAL with a "not implemented" detail.
 */
export class Engine {
  readonly #deps: EngineDeps;
  /** Free writes into the live library that are running (a reject mark): a library switch waits for them like for a paid write, but they do not block an avatar's job. */
  #librarySmallWrites = 0;
  readonly #folderFs: FolderFs;
  readonly #exportRootFs: ExportRootFs;
  readonly #caseProbe: { isCaseInsensitive(root: string): Promise<boolean> };
  /** `init.defaultExportPath`: the one export folder that is created on first use. */
  readonly #defaultExportPath: string | null;
  /** `userData/render-tmp`, swept at every start: the export folder may be neither inside it nor hold it. */
  readonly #renderTmpDir: string | null;
  /**
   * Set when an `export.choose` was answered ok, until the `settings.update` that follows it arrives (or this much time passes, if
   * main never sends it): a render submitted in that window would commit into the folder the owner was just told is empty.
   */
  #exportSwitchUntil: number | null = null;
  /** The export folder's status as of the last check (start, a settings update, a render attempt), for the snapshot. */
  #exportStatus: ExportStatus = { status: "ok" };
  /** Whether the start's own check has set the status: it is the baseline, so it is not announced (a window learns it from the snapshot). */
  #exportStatusKnown = false;
  /** The export checks run one at a time in the order asked (a fresh folder's marker is written by one of them, never raced), so a slow older one cannot overwrite a newer one. */
  #exportChain: Promise<unknown> = Promise.resolve();
  /** The latest queued check that has not started yet, with the size estimate it carries (or none); a later caller asking for exactly the same joins it. */
  #queuedExport: { readonly run: Promise<ExportRootCheck>; readonly requiredBytes: number | undefined } | null = null;
  readonly #exportCheckTimeoutMs: () => number;
  readonly #preflight: (signal: AbortSignal) => Promise<void>;
  readonly #preflightTimeoutMs: number;
  readonly #liveLibraryIdentityTimeoutMs: number;
  readonly #downscaleImportPhoto: (bytes: Uint8Array, maxSide: number, signal: AbortSignal) => Promise<Uint8Array>;
  readonly #importDownscaleTimeoutMs: number;
  readonly #events: EventLog;
  readonly #encryptionAvailable: boolean;
  readonly #openRouterBaseUrl: string;
  /** The flashapi list and its quota (3c.3). */
  readonly #music: MusicService;
  /** Own media (3f.1, 3f.1b): the import job (copy, importer, record), the records and their commands. */
  readonly #media: MediaService;
  /** Aborted by `shutdown`, so a copy in flight stops with the engine. */
  readonly #mediaAbort = new AbortController();
  /** The `media.import` calls running, by `callId`: main's `media.abortImport` stops one. */
  readonly #mediaCalls = new Map<string, AbortController>();
  #settings: EngineSettings;
  readonly #money: Money;
  #apiKey: string | null = null;
  /** The library of the saved settings; null when it could not be opened. */
  #live: OpenedLibrary | null = null;
  /** Bumped by one every time `#live`'s folder identity actually changes (invariant: every open window resyncs after a switch). */
  #librarySwitchGeneration = 0;
  /**
   * Folders main had the engine open that no confirm has switched to yet, by
   * the exact path string `library.open` staged them under (never a
   * resolved identity: `library.confirm` looks one up by that same string,
   * with no survey of its own — see `#answer`'s `library.confirm` case).
   */
  #staged = new Map<string, OpenedLibrary>();
  /**
   * The `libraryPath` of the most recent `#applySettings` call, whether or
   * not it has committed yet. Not `#settings.libraryPath`, which only moves
   * once a switch actually lands: this field alone detects a later
   * `settings.update` racing in during an earlier one's awaits, so the
   * earlier one's stale result is discarded instead of half-applied.
   */
  #pendingLibraryPath: string;
  /**
   * Non-zero while `#applySettings` surveys a folder it is not yet sure is
   * a genuine switch (between its own busy check and the switch actually
   * landing): `#liveLibrary()` refuses IN_FLIGHT then, so a paid command,
   * pick or archive starting during the survey cannot write through the
   * library instance that is about to be replaced. Not part of `#busy()`
   * itself: `#applySettings` also reads `#busy()` to detect new work that
   * started during that same survey, and folding this counter into it would
   * make that recheck see its own switch as "busy" and refuse itself.
   */
  #switching = 0;
  /** Opens in progress, by folder identity: two surveys of one folder would race their quarantine moves. */
  readonly #opening = new Map<string, Promise<{ library: Library; unreadable: UnreadableAvatar[] }>>();
  /** Set by a 401 with the current key; a new key clears it. */
  #keyRejected = false;
  /** The RapidAPI key, in memory only (invariant 29); main hands it over on every start and on a set. */
  #musicKey: string | null = null;
  /** Set by a 401 with the current music key (3c.3's client); a new key clears it. */
  #musicKeyRejected = false;
  /** Main's notices, oldest first; pending for this engine's life. */
  readonly #notices: EngineNotice[] = [];
  /** Avatar records already reported as not fitting the contract, so each is logged once. */
  readonly #reportedSkips = new Set<string>();
  /** Each running paid job's cap by scope (`scopeKey`), shared with the Budget; a scope without one can reserve nothing. */
  readonly #caps: Map<string, number>;
  /** Prices for the engine's life, fetched (free, no key) through the injected fetch. */
  readonly #prices: PriceCache;
  readonly #rawDir: string;
  /** Paid commands running now (createDraft): the library they write to must not change under them. */
  #paidCommands = 0;
  /** One createDraft at a time: a second click (the wizard left and opened again) must not buy a second descriptor. */
  #creatingDraft = false;
  /**
   * T6c: the one photo staged for import (`avatars.pickImportPhoto` →
   * `import.stagePhoto`), replaced whenever a later stage lands. Single-use:
   * `avatars.importAvatar` clears it as soon as it is accepted, whatever
   * happens next — a failed import needs a fresh pick, never a silent retry
   * of the same bytes.
   */
  #importStaging: {
    stagingId: string;
    mediaType: ImageMediaType;
    width: number;
    height: number;
    rawBytes: Uint8Array;
    /** Downscaled once at stage time, to the describe call's own size (importStaging.ts's IMPORT_DESCRIBE_MAX_SIDE). */
    describeJpeg: Uint8Array;
  } | null = null;
  /** One avatars.importAvatar at a time, like #creatingDraft. */
  #importing = false;
  /** The avatar jobs of this engine's life, as `Snapshot.jobs` lists them. */
  readonly #jobs = new JobRegistry();
  /**
   * The render queue (3a.6): a pool over `#jobs`, sized from the settings.
   * `videos.render` submits to it through `#videos`.
   */
  readonly #renders: RenderQueue;
  /** The montage draft files (3d.1a), shared by the draft commands and the video service (a render reads its draft here). */
  readonly #drafts: DraftStore;
  /** The draft commands: `montages.create`, `get`, `list`, `save`, `delete` and `focus`. */
  readonly #montages: MontageService;
  readonly #textPreview: TextPreviewService;
  /** The video commands, the queue's events as `job.*` and `video.changed`, recovery and the stop (3a.8b.2). */
  readonly #videos: VideoService;
  /** The renders' commits in flight: shared by every render's `execute` and by recovery, so recovery never touches a live commit. */
  readonly #commits = new CommitTracker();
  readonly #focusResolvers = new WeakMap<Library, FocusResolver>();
  /**
   * Avatars a running job or command is changing: a candidate job holds its
   * draft until it ends, pick and archive while they write. Anything else
   * that would change one of them is refused with IN_FLIGHT.
   */
  readonly #busyAvatars = new Set<string>();
  /** T6: paid requests of every photo run in flight at once (the settings' network concurrency); shrinks on a 429. */
  readonly #networkPool: NetworkPool;
  /** T6: local work of every photo run (the QA gates). */
  readonly #cpuPool: CpuPool;
  /** T6: the QA gates of every photo run; none until T7a/T7b wire theirs. */
  readonly #qaGates: readonly QaGate[];
  /** M3: why the face gate could not be loaded, when `deps.faceGateLoadError` said — `#assertFaceGate()`'s own detail. */
  readonly #faceGateLoadError: string | undefined;

  private constructor(init: EngineInit, money: Money, caps: Map<string, number>, deps: EngineDeps) {
    this.#deps = deps;
    this.#folderFs = deps.folderFs ?? NODE_FOLDER_FS;
    this.#exportRootFs = deps.exportRootFs ?? NODE_EXPORT_ROOT_FS;
    const checkTimeout = deps.exportCheckTimeoutMs ?? EXPORT_CHECK_TIMEOUT_MS;
    this.#exportCheckTimeoutMs = typeof checkTimeout === "function" ? checkTimeout : () => checkTimeout;
    this.#caseProbe = deps.caseProbe ?? new CaseSensitivityProbe();
    this.#defaultExportPath = init.defaultExportPath ?? null;
    this.#renderTmpDir = init.renderTmpDir ?? null;
    this.#preflight = deps.preflightDownscale ?? preflightDownscale;
    this.#downscaleImportPhoto = deps.downscaleImportPhoto ?? ((bytes, maxSide, signal) => downscaleToJpeg(bytes, { maxSide, signal }));
    this.#importDownscaleTimeoutMs = deps.importDownscaleTimeoutMs ?? IMPORT_DOWNSCALE_TIMEOUT_MS;
    this.#preflightTimeoutMs = deps.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS;
    this.#liveLibraryIdentityTimeoutMs = deps.liveLibraryIdentityTimeoutMs ?? LIVE_LIBRARY_IDENTITY_TIMEOUT_MS;
    this.#events = new EventLog(EVENT_LOG_CAPACITY, deps.bootId);
    this.#media = new MediaService({
      jobs: this.#jobs,
      emit: (event) => this.#emit(event),
      withLibrary: (work) => this.#withLiveLibrary(work),
      newId: deps.newId,
      now: () => new Date(deps.clock()),
      importers: deps.mediaImporters,
      // The render queue's reserved set, as photos have (3f.2); a test may pass its own.
      reservedMedia: (mediaId) => (deps.reservedMedia ?? ((id: string) => this.#renders.reservesMedia(id)))(mediaId),
      staging: deps.mediaStaging,
      log: (line) => console.warn(`studio engine: ${line}`),
    });
    this.#settings = init.settings;
    this.#renders = new RenderQueue({
      jobs: this.#jobs,
      // Read at every start, so a settings change applies to the next job.
      size: () => renderPoolSize(this.#settings.renderConcurrency, { cores: availableParallelism(), totalMem: totalmem() }),
      // Events carry a job's state and result, never the error's `cause` (raw, with the owner's paths).
      onEvent: (event) => this.#videos.onQueueEvent(event),
      onListenerError: (error) => this.#videos.onListenerError(error),
    });
    this.#drafts = new DraftStore({
      log: (line) => console.warn(`studio engine: ${line}`),
      ...(deps.montages?.beforeRename === undefined ? {} : { beforeRename: deps.montages.beforeRename }),
    });
    this.#videos = new VideoService({
      drafts: this.#drafts,
      queue: this.#renders,
      tracker: this.#commits,
      checker: new FileStateChecker(),
      withLibrary: (work) => this.#withLiveLibrary(work),
      openLibrary: () => this.library,
      checkExport: (requiredBytes) => this.#refreshExportStatus(requiredBytes),
      exportSwitch: { pending: () => this.#exportSwitchPending(), currentPath: () => this.#settings.exportPath },
      caseProbe: this.#caseProbe,
      focus: deps.videos?.focus ?? ((library) => this.#focusOf(library)),
      // 3f.2: the render looks each own photo up as a photo and holds it on the queue in the same step (MediaService.lookup's onFound).
      media: { lookup: (mediaId, kind, onFound) => this.#media.lookup(mediaId, kind, onFound) },
      renderTmpDir: init.renderTmpDir,
      // The layers of a spec (3b.6): the same text gate `montages.textPreview` draws through, and the verified built-in sticker set.
      layers: {
        gate: deps.text?.gate ?? NO_TEXT_GATE,
        stickers: init.stickerDir === undefined ? NO_STICKERS : createStickerAssets(init.stickerDir),
        ...(deps.text?.loadError === undefined ? {} : { loadError: deps.text.loadError }),
      },
      ...(deps.musicTracks === undefined ? {} : { tracks: deps.musicTracks }),
      newId: deps.newId,
      now: () => new Date(deps.clock()),
      emit: (event) => this.#emit(event),
      announceAvatar: (library, avatarId) => this.#announceAvatarOrLog(library, avatarId),
      log: (line) => console.warn(`studio engine: ${line}`),
      ...(deps.videos?.fs === undefined ? {} : { fs: deps.videos.fs }),
      ...(deps.videos?.renderOverrides === undefined ? {} : { renderOverrides: deps.videos.renderOverrides }),
      ...(deps.videos?.recover === undefined ? {} : { recover: deps.videos.recover }),
      ...(deps.videos?.staleRetryDelaysMs === undefined ? {} : { staleRetryDelaysMs: deps.videos.staleRetryDelaysMs }),
    });
    this.#textPreview = createTextPreviewService({
      gate: deps.text?.gate ?? NO_TEXT_GATE,
      dir: () => (init.renderTmpDir === undefined ? null : join(init.renderTmpDir, TEXT_PREVIEW_DIR)),
      newId: deps.newId,
      log: (line) => console.warn(`studio engine: ${line}`),
      ...(deps.text?.loadError === undefined ? {} : { loadError: deps.text.loadError }),
    });
    this.#montages = new MontageService({
      store: this.#drafts,
      withLibrary: (work) => this.#withLiveLibrary(work),
      openLibrary: () => this.library,
      focus: deps.montages?.focus ?? ((library) => this.#focusOf(library)),
      ownPhotos: (mediaIds) => this.#media.holding(mediaIds, "photo"),
      // 3f.4: the own tracks a draft names, with their decoded lengths: what `ownTrackFactsOf` says a render could read (audio, with a length, stored as M4A).
      ownTracks: async (mediaIds) => {
        const held = new Map<string, { readonly durationMs: number }>();
        for (const mediaId of mediaIds) {
          const found = await this.#media.lookup(mediaId, "audio");
          const facts = found === undefined ? null : ownTrackFactsOf(found);
          if (facts !== null) held.set(mediaId, facts);
        }
        return held;
      },
      // 3f.3b: the own videos a draft names, with their stored lengths: what `ownVideoFactsOf` says a render could read (kind video, stored as the importer's MP4, with a size and a
      // length, and within the stored-video cap the render's copy holds it to).
      ownVideos: async (mediaIds) => {
        const held = new Map<string, { readonly durationMs: number }>();
        for (const mediaId of mediaIds) {
          const found = await this.#media.lookup(mediaId, "video");
          const facts = found === undefined ? null : ownVideoFactsOf(found);
          if (facts !== null) held.set(mediaId, { durationMs: facts.durationMs });
        }
        return held;
      },
      ownStickers: (mediaIds) => this.#media.holding(mediaIds, "sticker"),
      ...(deps.musicTracks === undefined ? {} : { tracks: deps.musicTracks }),
      newId: deps.newId,
      now: () => new Date(deps.clock()),
      emit: (event) => this.#emit(event),
      log: (line) => console.warn(`studio engine: ${line}`),
      ...(deps.montages?.focusBudgetMs === undefined ? {} : { focusBudgetMs: deps.montages.focusBudgetMs }),
      ...(deps.montages?.randomSeed === undefined ? {} : { randomSeed: deps.montages.randomSeed }),
      ...(deps.montages?.commandDeadlineMs === undefined ? {} : { commandDeadlineMs: deps.montages.commandDeadlineMs }),
      ...(deps.montages?.commandMarginMs === undefined ? {} : { commandMarginMs: deps.montages.commandMarginMs }),
    });
    this.#pendingLibraryPath = init.settings.libraryPath;
    this.#encryptionAvailable = init.encryptionAvailable;
    this.#openRouterBaseUrl = resolveOpenRouterBaseUrl(init.openRouterBaseUrl, STUDIO_E2E);
    this.#money = money;
    this.#caps = caps;
    this.#rawDir = init.rawDir;
    this.#networkPool = new NetworkPool({ max: init.settings.concurrency.network });
    this.#cpuPool = new CpuPool(deps.cpuPoolSize ?? defaultCpuPoolSize());
    this.#qaGates = deps.qaGates ?? [];
    this.#faceGateLoadError = deps.faceGateLoadError;
    this.#music = new MusicService({
      quotaPath: init.musicDir === undefined ? null : join(init.musicDir, "quota.jsonl"),
      baseUrl: resolveMusicBaseUrl(init.musicBaseUrl, STUDIO_E2E),
      allowBaseUrlOverride: STUDIO_E2E,
      fetch: deps.musicFetch ?? ((url, request) => fetch(url, request)),
      ...(deps.musicSink === undefined ? {} : { sink: deps.musicSink }),
      clock: deps.clock,
      newId: deps.newId,
      key: () => this.#musicKey,
      keyRejected: () => this.#musicKeyRejected,
      markKeyRejected: (key) => this.markMusicKeyRejected(key),
      emit: (status) => this.#emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "music.changed", payload: { status } }),
      log: (line) => console.warn(line),
    });
    const priceFetch = priceFetchFrom(deps.fetch);
    this.#prices = new PriceCache({
      load: (models) => loadPriceBook({ fetch: priceFetch, baseUrl: this.#openRouterBaseUrl, ...models }),
      clock: deps.clock,
      monotonic: deps.monotonic,
    });
  }

  /**
   * Opens the ledger (`userData/ledger.jsonl`, passed in by main) under a
   * Budget and the library the settings name, then emits main's notices. A
   * ledger that cannot be read does not stop the engine: the money status
   * says why and money commands answer with the ledger's error. A library
   * that cannot be opened leaves the engine without one.
   */
  static async start(init: EngineInit, deps: EngineDeps): Promise<Engine> {
    let money: Money;
    const caps = new Map<string, number>();
    try {
      const ledger = await Ledger.open(init.ledgerPath);
      // The engine's one Budget over the ledger, for its whole life: a new
      // monthly budget is set on it, never by building another (that would
      // forget which open reserves are this process's own and put a second
      // mutex on the ledger). Each paid job registers its cap (its own worst
      // case) before its first reserve; a scope without a cap can reserve nothing.
      const budget = new Budget(ledger, {
        runCapMicros: (scope) => caps.get(scopeKey(scope)) ?? 0,
        monthlyBudgetMicros: init.settings.monthlyBudgetMicros,
        clock: deps.clock,
        monotonic: deps.monotonic,
      });
      money = { ok: true, budget };
    } catch (error) {
      money = { ok: false, unavailable: ledgerUnavailable(error) };
    }
    const engine = new Engine(init, money, caps, deps);
    if (init.ffmpegEnv !== undefined) configureFfmpegEnv(init.ffmpegEnv);
    // First run: the default folder does not exist yet. Only the default is
    // created; a folder the user chose may be a volume that is not mounted.
    if (init.settings.libraryPath === init.defaultLibraryPath) {
      await mkdir(init.defaultLibraryPath, { recursive: true }).catch((error: unknown) => {
        console.warn(`studio engine: the default library folder could not be created (${messageOf(error, "unknown error")})`);
      });
    }
    engine.#live = await engine.#openOrNull(init.settings.libraryPath);
    if (engine.#live !== null) engine.#sweepMediaStaging(engine.#live.library);
    const exportCheck = await engine.#refreshExportStatus();
    for (const notice of init.notices) engine.#addNotice(notice);
    // In the BACKGROUND, never awaited (main's start deadline is 30 s, a locked leftover costs a second and a hung export
    // drive costs as long as it likes): the render-tmp sweep (which leaves the folder of a job that is running) and
    // the recovery of the crash windows of the open library. A render started meanwhile is safe: it registers in the same
    // tracker recovery reads, and recovery holds the export root's lock a commit needs.
    engine.#videos.startup(engine.#live?.library ?? null, exportCheck);
    return engine;
  }

  /** Resolves once the background work of the start and of library switches is done (recovery, the render-tmp sweep). Tests wait on it; nothing else does. */
  settled(): Promise<void> {
    return this.#videos.settled();
  }

  /**
   * Stops the engine's work before its process ends (the app quits, main's `engine.shutdown` call): no render is
   * accepted, every queued and running render is cancelled, and a bounded wait lets a commit that is past its claim
   * finish, so its file, record and used mark are complete and nothing is left for the next start to settle.
   */
  async shutdown(waitMs: number = SHUTDOWN_RENDER_WAIT_MS): Promise<{ idle: boolean }> {
    // The held-back notice announcement is for windows of a running engine: it is dropped, not posted into a stopping one.
    this.#stopping = true;
    this.#mediaAbort.abort();
    if (this.#internalNoticeTimer !== null) clearTimeout(this.#internalNoticeTimer);
    this.#internalNoticeTimer = null;
    // A music request in flight is aborted (its send stays counted); the renders get their bounded wait.
    // Imports are cancelled and have cleaned up (their staged copies and work files) when `stop` returns.
    const [, renders] = await Promise.all([this.#music.stop(), this.#videos.shutdown(waitMs), this.#media.stop()]);
    return renders;
  }

  /** Resolves once the open library's own-media recovery and every running import (with its cleanup) are done. Tests wait on it; nothing else does. */
  mediaSettled(): Promise<void> {
    return this.#media.settled();
  }

  /** After start: finishes the music downloads a stopped or crashed refresh left pending (no quota, no request to flashapi). Never rejects. */
  resumeMusic(): Promise<void> {
    return this.#music.resumePending();
  }

  /** Resolves once a running music refresh and every status it announced are done. Tests wait on it; nothing else does. */
  musicSettled(): Promise<void> {
    return this.#music.settled();
  }

  /**
   * For the OpenRouter client and the jobs on a 401 with `rejectedKey`, the
   * key that request carried: the key is marked rejected in the settings and
   * the snapshot, and `settings.changed` is emitted once; a new key clears it.
   * A 401 for a key the user has replaced meanwhile (a request can take
   * minutes) changes nothing. The caller stops the run and never retries.
   */
  markKeyRejected(rejectedKey: string): void {
    if (this.#apiKey === null || this.#apiKey !== rejectedKey || this.#keyRejected) return;
    this.#keyRejected = true;
    this.#emitSettings();
  }

  /**
   * For the flashapi client (3c.3) on a 401 with `rejectedKey`, the key that request carried: the music key is
   * marked rejected until it is replaced or cleared, and `settings.changed` is emitted once. Like
   * `markKeyRejected`, a 401 for a key the user has replaced meanwhile changes nothing.
   */
  markMusicKeyRejected(rejectedKey: string): void {
    if (this.#musicKey === null || this.#musicKey !== rejectedKey || this.#musicKeyRejected) return;
    this.#musicKeyRejected = true;
    this.#emitSettings();
  }

  /** The RapidAPI key the flashapi client will use; never sent anywhere but flashapi. */
  get musicKey(): string | null {
    return this.#musicKey;
  }

  /** The OpenRouter API base for the client: always the real one outside an E2E build. */
  get openRouterBaseUrl(): string {
    return this.#openRouterBaseUrl;
  }

  get bootId(): string {
    return this.#events.bootId;
  }

  /** The key OpenRouter calls will use; never sent anywhere but OpenRouter. */
  get apiKey(): string | null {
    return this.#apiKey;
  }

  /** The render queue. Task 3a.8b's `videos.render` submits to it; the engine's tests do until then. */
  get renders(): RenderQueue {
    return this.#renders;
  }

  /** The library of the saved settings, if it is open. */
  get library(): Library | null {
    return this.#live?.library ?? null;
  }

  /** The one Budget over the ledger, for the paid jobs; null when the ledger could not be read. */
  get budget(): Budget | null {
    return this.#money.ok ? this.#money.budget : null;
  }

  /** Handles one message from main: a control message is applied, a call or a command is answered through `post`. */
  async receive(message: unknown): Promise<void> {
    if (isControlMessage(message)) {
      const call = HostCall.safeParse(message);
      if (call.success) {
        this.#deps.post(await this.#answer(call.data));
        return;
      }
      // A call that breaks the contract is ANSWERED when its callId can be read: silence would leave main waiting out its whole deadline.
      const callId = isControlMessage(message) && typeof message === "object" && message !== null && !HostControl.safeParse(message).success ? Reflect.get(message, "callId") : undefined;
      if (Id.safeParse(callId).success && typeof callId === "string") {
        this.#deps.post({ kind: "control", type: "reply", callId, error: { code: "VALIDATION", detail: "the call does not match the contract" } });
        return;
      }
      await this.applyControl(message);
      return;
    }
    this.#deps.post(await this.handle(message));
  }

  async #answer(call: HostCall): Promise<EngineReply> {
    switch (call.type) {
      case "library.open": {
        const identity = await folderIdentity(call.path, this.#folderFs);
        // The live library's folder, however it is spelled: opening it again
        // would survey (and quarantine) it under the writes of the one in
        // use. Staged under this spelling too, not just answered ok: a
        // later confirm of this exact string (main's normal open-then-
        // confirm sequence) must find something to adopt, not VALIDATION
        // forever — adopting #live as-is, no re-survey, is always correct
        // here, since it is already the live instance.
        if (identity !== null && identity === this.#live?.identity) {
          if (this.#live !== null) this.#staged.set(call.path, this.#live);
          return { kind: "control", type: "reply", callId: call.callId };
        }
        if (this.#busy()) return { kind: "control", type: "reply", callId: call.callId, error: this.#inFlightRefusal() };
        try {
          const opened = await this.#open(call.path, identity);
          // Staged under the exact string main sent, not the resolved
          // identity: `library.confirm` looks it up the same way, with no
          // survey of its own (the TOCTOU this closes; see its case below).
          this.#staged.set(call.path, opened);
          return { kind: "control", type: "reply", callId: call.callId };
        } catch (error) {
          const code = error instanceof LibraryError ? "VALIDATION" : "INTERNAL";
          return { kind: "control", type: "reply", callId: call.callId, error: { code, detail: messageOf(error, "the library could not be opened") } };
        }
      }
      case "library.confirm": {
        // Requires a folder `library.open` staged under this exact path
        // string. Never surveyed fresh here: doing that after the busy check
        // below would reopen the TOCTOU window this call exists to close (a
        // paid command starting during the survey would write into the old
        // library while this call answers ok). Main must send library.open
        // again for a folder nothing is staged for (a dropped confirm, a
        // restart): see control.ts's doc comment on this call.
        const staged = this.#staged.get(call.path);
        // Already the live (and saved) folder, by the exact path string,
        // with no staging lookup and no survey — UNLESS something is staged
        // under this same path with a DIFFERENT identity (review LOW 8: a
        // remount at the exact same path). That is not a no-op: #live would
        // otherwise keep naming a folder no longer really there. Falls
        // through to the ordinary staged-adopt path below, busy check first.
        if (call.path === this.#settings.libraryPath && this.#live !== null && (staged === undefined || staged.identity === this.#live.identity)) {
          return { kind: "control", type: "reply", callId: call.callId };
        }
        if (staged === undefined) {
          const detail = "the folder is not staged; open it again";
          return { kind: "control", type: "reply", callId: call.callId, error: { code: "VALIDATION", detail } };
        }
        if (this.#busy()) {
          // Dropped rather than left lingering: main always opens a folder
          // again before confirming it, so a retry re-stages it fresh
          // instead of ever adopting this now-stale entry later.
          this.#staged.delete(call.path);
          return { kind: "control", type: "reply", callId: call.callId, error: this.#inFlightRefusal() };
        }
        // No await between the check above and here: the switch is atomic
        // with the busy check just made, so nothing can start writing into
        // the old library between "not busy" and "switched".
        const beforeIdentity = this.#live?.identity ?? null;
        if (staged.identity !== beforeIdentity) this.#librarySwitchGeneration++;
        this.#live = staged;
        // A different library is live: settle its crash windows in the background (never awaited here).
        if (staged.identity !== beforeIdentity) {
          this.#videos.libraryOpened(staged.library);
          this.#sweepMediaStaging(staged.library);
        }
        this.#settings = { ...this.#settings, libraryPath: call.path };
        this.#pendingLibraryPath = call.path;
        // Every other folder still staged (candidates main gave up on) is
        // stale the moment the live folder changes underneath it.
        this.#staged = new Map();
        // L5: a photo staged for import belongs to the library that was live
        // when it was picked; once a different one is live, importing it
        // there without a fresh pick would be surprising, not a convenience.
        this.#importStaging = null;
        this.#emitSettings();
        return { kind: "control", type: "reply", callId: call.callId };
      }
      case "engine.shutdown": {
        await this.shutdown();
        return { kind: "control", type: "reply", callId: call.callId };
      }
      case "export.choose":
        return { kind: "control", type: "reply", callId: call.callId, ...(await this.#chooseExportFolder(call.path)) };
      case "media.import":
        return { kind: "control", type: "reply", callId: call.callId, ...(await this.#importMedia(call)) };
      case "import.stagePhoto": {
        // Free (design constraint 2): media checks, not animated, a readable
        // size — before anything is downscaled or paid for. A rejection here
        // never touches #importStaging: an earlier stage (if any) stays live
        // until a photo that actually validates replaces it.
        const checked = checkImportPhoto(call.bytes);
        if (!checked.ok) {
          const detail =
            checked.reason === "not-an-image"
              ? "the file is not a supported image (PNG, JPEG or WebP)"
              : checked.reason === "animated"
                ? "an animated image cannot be imported"
                : checked.reason === "too-many-pixels"
                  ? `the image is larger than ${MAX_SOURCE_PIXELS} pixels; choose a smaller photo`
                  : "the image's size could not be read";
          return { kind: "control", type: "reply", callId: call.callId, error: { code: "VALIDATION", detail } };
        }
        let describeJpeg: Uint8Array;
        try {
          describeJpeg = await this.#boundedImportDownscale(call.bytes, IMPORT_DESCRIBE_MAX_SIDE);
        } catch (error) {
          // L4: messageOf() already truncates the error's own message, but
          // this prefix is added AFTER that — the concatenation itself must
          // stay under SafeText's 500-char cap too, or this reply would fail
          // to leave the engine at all.
          const detail = detailOf(`the photo could not be prepared (it may be too large or an unsupported variant): ${messageOf(error, "unknown error")}`);
          return { kind: "control", type: "reply", callId: call.callId, error: { code: "VALIDATION", detail } };
        }
        const stagingId = this.#deps.newId();
        this.#importStaging = { stagingId, mediaType: checked.info.mediaType, width: checked.info.width, height: checked.info.height, rawBytes: call.bytes, describeJpeg };
        return { kind: "control", type: "reply", callId: call.callId, stage: { stagingId, width: checked.info.width, height: checked.info.height } };
      }
    }
  }

  /**
   * `media.import` (3f.1, invariant 34; 3f.1b): opens the file main's dialog picked (identity, size, the kind its bytes name, the kind's
   * cap, an importer for the kind) and STARTS ITS JOB; the answer is the job's id. The copy, the importer and the record run inside the
   * job, with progress and a cancel (`media.cancelImport`). This call is short and is counted as a small write of the live library only
   * while it opens the file; the job holds the library on its own (`#busy()`). A refusal carries its reason and no path.
   */
  async #importMedia(call: Extract<HostCall, { type: "media.import" }>): Promise<Pick<EngineReply, "error" | "mediaJobId" | "mediaReason">> {
    // Opening the file ends on main's `media.abortImport`, on the engine's own deadline (a little shorter than main's: a hung open of a
    // dead network drive must not hold the library) and on shutdown. The job that follows is stopped by `media.cancelImport`, not by these.
    const stop = new AbortController();
    this.#mediaCalls.set(call.callId, stop);
    const deadline = AbortSignal.timeout(this.#deps.mediaImportDeadlineMs ?? MEDIA_IMPORT_ENGINE_DEADLINE_MS);
    const signal = AbortSignal.any([stop.signal, this.#mediaAbort.signal, deadline]);
    try {
      const result = await this.#media.import(call, signal);
      if (result.ok) return { mediaJobId: result.jobId };
      if (result.reason === "cancelled") return { error: { code: deadline.aborted ? "TIMEOUT" : "INTERNAL", detail: deadline.aborted ? "the file took too long to open" : result.detail }, mediaReason: "cancelled" };
      if (result.reason === "failed") return { error: { code: "INTERNAL", detail: result.detail }, mediaReason: "failed" };
      return { error: { code: "VALIDATION", detail: result.detail }, mediaReason: result.reason };
    } catch (error) {
      if (error instanceof EngineFailure) return { error: error.error };
      return { error: { code: "INTERNAL", detail: "the file could not be imported" } };
    } finally {
      this.#mediaCalls.delete(call.callId);
    }
  }

  /** Removes what a crash left in the staging folder of a library that has just become the live one. In the background; never rejects. */
  #sweepMediaStaging(library: Library): void {
    this.#media.libraryOpened(library);
  }

  /** True while a job or paid command writes into the live library, a pick/archive is running, a reject mark is being written, an own-media import is running, or a render is queued or running (invariant 25): a library switch must be refused. */
  #busy(): boolean {
    return this.#paidCommands > 0 || this.#busyAvatars.size > 0 || this.#librarySmallWrites > 0 || this.#renders.active() > 0 || this.#jobs.activeImports() > 0 || this.#videos.preparing > 0 || (this.#money.ok && this.#money.budget.inFlightCount() > 0);
  }

  #inFlightRefusal(): EngineError {
    return { code: "IN_FLIGHT", detail: "paid requests, a pick or archive, a reject mark, an own-media import, a video render or delete are in flight; change the library folder when they end" };
  }

  /**
   * Applies a control message from main; resolves once it is fully applied
   * (a settings update may switch the library). Key changes apply before the
   * first await. Invalid control messages are dropped without echoing their
   * content.
   */
  async applyControl(message: unknown): Promise<void> {
    const parsed = HostControl.safeParse(message);
    if (!parsed.success) {
      console.error("studio engine: ignored an invalid control message");
      return;
    }
    const control = parsed.data;
    switch (control.type) {
      case "apiKey.set":
        this.#apiKey = control.key;
        this.#keyRejected = false;
        this.#emitSettings();
        return;
      case "apiKey.clear":
        this.#apiKey = null;
        this.#keyRejected = false;
        this.#emitSettings();
        return;
      case "musicKey.set": {
        const { key } = control;
        this.#musicKey = key;
        this.#musicKeyRejected = false;
        this.#emitSettings();
        await this.#afterMusicKeySet(key, control.origin ?? "user");
        return;
      }
      case "musicKey.clear":
        this.#musicKey = null;
        this.#musicKeyRejected = false;
        this.#emitSettings();
        await this.#music.noteKeyChange(null);
        return;
      case "media.abortImport":
        this.#mediaCalls.get(control.callId)?.abort();
        return;
      case "settings.update": {
        const refusal = await this.#applySettings(control.settings);
        // settings.update has no reply main waits on: the engine's actual
        // libraryPath is already visible through the settings.changed
        // #applySettings emits unconditionally, so main can reconcile
        // settings.json to it (see main's onEvent); this is only so the
        // refusal itself is not silent.
        if (refusal !== null) console.warn(`studio engine: a settings.update's library switch was refused (${refusal.code}): ${refusal.detail ?? ""}`);
        return;
      }
    }
  }

  /**
   * What follows a music key hand-over. The OWNER's set or clear is written to the quota log, so an earlier 401 no
   * longer applies to a key stored again. Main's hand-over at (re)start instead READS the log: if the last answer for
   * a key with these last four chars was a 401 and nothing changed since, the key reads as rejected again, so a revoked
   * key does not look fine after a restart and the next «Обновить» does not spend one of the 30 to learn it. The log
   * holds the last four chars only, never the key or a hash of it.
   */
  async #afterMusicKeySet(key: string, origin: "user" | "start"): Promise<void> {
    const last4 = key.slice(-4);
    if (origin === "user") {
      await this.#music.noteKeyChange(last4);
      return;
    }
    if (!(await this.#music.keyRejected(last4))) return;
    // The key may have been replaced or already marked while the log was read.
    if (this.#musicKey !== key || this.#musicKeyRejected) return;
    this.#musicKeyRejected = true;
    this.#emitSettings();
  }

  /** Parses and answers one command. Never throws. */
  async handle(raw: unknown): Promise<ResponseMessage> {
    const parsed = parseEngineCommand(raw);
    if (!parsed.ok) return errorResponseFor(raw, { code: "VALIDATION", detail: parsed.reason });
    try {
      return await this.#dispatch(parsed.command);
    } catch (error) {
      return errorResponseFor(parsed.command, engineErrorFrom(error));
    }
  }

  async #dispatch(command: EngineCommandMessage): Promise<ResponseMessage> {
    const v = PROTOCOL_VERSION;
    switch (command.type) {
      case "engine.snapshot":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#snapshot() };
      case "engine.events": {
        const result = this.#events.since(command.payload.afterSeq, command.payload.bootId);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "settings.get":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#currentSettings() };
      case "money.status":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#moneyStatus() };
      case "money.reconcile":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#reconcile() };
      case "avatars.list": {
        const view = this.#libraryView();
        const result = { avatars: view.avatars, unreadableAvatars: view.unreadable, unreadableTotal: view.unreadableTotal };
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimate": {
        // The traits do not change the price: the descriptor prompt is bounded by its ceiling.
        const models = this.#avatarModels();
        const imageAgeCheck = this.#settings.imageAgeCheck;
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models, "new-avatar", imageAgeCheck)), models, "new-avatar", imageAgeCheck);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimateCandidates": {
        // Same order as generateCandidates: NOT_FOUND for an unknown or non-draft
        // id, DESCRIPTOR_INVALID (never INTERNAL) for a stored descriptor that
        // fails today's rules, before the price fetch below spends anything on it.
        const { avatarId } = command.payload;
        const manifest = this.library?.getAvatar(avatarId);
        if (manifest === undefined || manifest.status !== "draft") {
          throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${avatarId} in the open library` });
        }
        this.#assertDescriptorReadable(manifest);
        if (this.#draft(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `the draft ${avatarId} does not fit the contract` });
        const models = this.#avatarModels();
        const imageAgeCheck = this.#settings.imageAgeCheck;
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models, "next-batch", imageAgeCheck)), models, "next-batch", imageAgeCheck);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.estimateRewriteDescriptor": {
        // Free, so no #switching gating: LIBRARY_UNAVAILABLE without a
        // library (matching avatars.rewriteDescriptor's own #liveLibrary()),
        // NOT_FOUND for an unknown id, VALIDATION when there is nothing to
        // fix or the record is not rewritable at all.
        const library = this.library;
        if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
        const manifest = this.#manifestOrNotFound(library, command.payload.avatarId);
        this.#assertRewritable(command.payload.avatarId, manifest);
        const models = this.#avatarModels();
        // rewrite-descriptor never touches candidates or age checks, whatever
        // the toggle; the mode is still passed through for the (required)
        // parameter's own sake, and to price the same models either way.
        const imageAgeCheck = this.#settings.imageAgeCheck;
        const result = avatarJobEstimate(await this.#prices.get(avatarPriceModels(models, "rewrite-descriptor", imageAgeCheck)), models, "rewrite-descriptor", imageAgeCheck);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.createDraft": {
        if (this.#creatingDraft) {
          throw new EngineFailure({ code: "IN_FLIGHT", detail: "a new avatar's descriptor is already being written; wait for it to finish" });
        }
        this.#creatingDraft = true;
        this.#paidCommands++;
        try {
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#createDraft(command.payload) };
        } finally {
          this.#paidCommands--;
          this.#creatingDraft = false;
        }
      }
      case "avatars.generateCandidates": {
        const { avatarId } = command.payload;
        this.#claimAvatar(avatarId, "a batch of candidates is already being made for this draft; wait for it to finish");
        this.#paidCommands++;
        let started = false;
        try {
          const result = await this.#generateCandidates(command.payload);
          started = true;
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
        } finally {
          // A started job holds both until it ends.
          if (!started) {
            this.#paidCommands--;
            this.#busyAvatars.delete(avatarId);
          }
        }
      }
      case "avatars.cancel": {
        const { jobId } = command.payload;
        // A render is not an avatar's job: it is stopped through the render queue, and here it is as good as unknown.
        if (this.#jobs.stateOf(jobId)?.kind === "render" || this.#jobs.stateOf(jobId)?.kind === "import" || !this.#jobs.cancel(jobId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no job ${jobId} in this engine` });
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { jobId } };
      }
      case "avatars.pick":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#pick(command.payload) };
      case "avatars.archive":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#archive(command.payload) };
      case "avatars.rewriteDescriptor": {
        const { avatarId } = command.payload;
        this.#claimAvatar(avatarId, "a job or command is already changing this avatar; wait for it to finish");
        this.#paidCommands++;
        try {
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#rewriteDescriptor(command.payload) };
        } finally {
          this.#paidCommands--;
          this.#busyAvatars.delete(avatarId);
        }
      }
      case "avatars.estimateImport": {
        // Free: only checks that the named staged photo still exists (a
        // fresh pick, or main gave up on the dialog and never staged one).
        if (this.#importStaging?.stagingId !== command.payload.stagingId) {
          throw new EngineFailure({ code: "NOT_FOUND", detail: "no staged photo with this id; pick one again" });
        }
        const models = this.#avatarModels();
        const result = importJobEstimate(await this.#prices.get(importPriceModels(models)), models);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
      }
      case "avatars.importAvatar": {
        if (this.#importing) {
          throw new EngineFailure({ code: "IN_FLIGHT", detail: "an import is already being written; wait for it to finish" });
        }
        this.#importing = true;
        this.#paidCommands++;
        try {
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#importAvatar(command.payload) };
        } finally {
          this.#paidCommands--;
          this.#importing = false;
        }
      }
      case "runs.estimate": {
        // Free: NOT_FOUND for an avatar that cannot get photos, DESCRIPTOR_INVALID before any price is fetched for it.
        this.#runnableAvatar(this.library, command.payload.avatarId);
        const models = this.#avatarModels();
        const imageAgeCheck = this.#settings.imageAgeCheck;
        const estimate = runEstimate(await this.#prices.get(runPriceModels(models, imageAgeCheck)), models, command.payload, imageAgeCheck);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { estimate } };
      }
      case "runs.start": {
        const { avatarId } = command.payload;
        // Claimed before the first await, like generateCandidates: the library switch's race check relies on it.
        this.#claimAvatar(avatarId, "a photo run or another job is already changing this avatar; wait for it to finish");
        this.#paidCommands++;
        let launched = false;
        try {
          const result = await this.#startRun(command.payload);
          launched = true;
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
        } finally {
          // A launched run holds both until its job ends.
          if (!launched) {
            this.#paidCommands--;
            this.#busyAvatars.delete(avatarId);
          }
        }
      }
      case "runs.cancel": {
        const { runId } = command.payload;
        const jobId = this.#jobs.runningJobOf(runId);
        if (jobId !== null) this.#jobs.cancel(jobId);
        else await this.#readRunPlan(this.library, runId);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { runId } };
      }
      case "runs.estimateResume": {
        // Free: what a resume could still spend, at today's prices, within the cap the run has left.
        const library = this.library;
        const plan = await this.#readRunPlan(library, command.payload.runId);
        const { estimate } = await this.#remaining(library, plan);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { estimate } };
      }
      case "runs.resume": {
        const { runId } = command.payload;
        if (this.#jobs.runningJobOf(runId) !== null) throw new EngineFailure({ code: "IN_FLIGHT", detail: `run ${runId} is already running` });
        // Counted before the first await (the run's avatar is only known once its plan is read): a library switch is refused from here on.
        this.#paidCommands++;
        let launched = false;
        try {
          const result = await this.#resumeRun(command.payload);
          launched = true;
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result };
        } finally {
          if (!launched) this.#paidCommands--;
        }
      }
      case "runs.list":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { runs: await this.#listRuns() } };
      case "photos.list": {
        // T8b's gallery. Free, read-only — unlike #runnableAvatar (runs.estimate/
        // start), which reserves NOT_FOUND for "this avatar cannot run a photo
        // job right now": here NOT_FOUND means only "the library has no avatar
        // with this id at all". A draft, an active avatar and an archived one
        // all get their (possibly empty) photo list, the same as avatars.list
        // already lists archived avatars normally (AvatarSummary excludes only
        // "draft"). `library?.` also makes "no library open" answer NOT_FOUND
        // here, like #runnableAvatar: there is nothing to find either way.
        const { avatarId } = command.payload;
        const library = this.library;
        if (library?.getAvatar(avatarId) === undefined) {
          throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
        }
        const { photos, skippedTotal } = this.#photosFor(library, avatarId);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { photos, skippedTotal } };
      }
      case "photos.setRejected":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#setRejected(command.payload) };
      case "photos.rebuildRejected": {
        // 3e.2 «Восстановить отметки»: the log is copied aside, then rebuilt from the lines that read (library.ts).
        const { avatarId } = command.payload;
        const outcome = await this.#usageRecovery(avatarId, "the reject marks could not be rebuilt", async (library) => ({ result: await library.rebuildRejectLog(avatarId), avatarIds: [avatarId] }));
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { avatarId, ...outcome } };
      }
      case "videos.quarantineRecords": {
        // 3e.2 «Убрать повреждённую запись»: broken record files are MOVED to the library's quarantine (library.ts).
        const { avatarId } = command.payload;
        const outcome = await this.#usageRecovery(avatarId, "the broken video records could not be moved aside", async (library) => {
          const { quarantined, avatarIds } = await library.quarantineBrokenRecords(avatarId);
          return { result: { quarantined }, avatarIds };
        });
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { avatarId, ...outcome } };
      }
      case "media.list":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#media.list(command.payload.kind, command.payload.mediaIds) };
      case "media.delete": {
        const { mediaId } = command.payload;
        let removed: "deleted" | "not-found" | "in-use";
        try {
          removed = await this.#media.delete(mediaId);
        } catch (error) {
          if (error instanceof MediaDiskError) throw new EngineFailure({ code: "INTERNAL", detail: error.message });
          throw error;
        }
        if (removed === "in-use") throw new EngineFailure({ code: "IN_FLIGHT", detail: "a queued or running render uses this media; delete it when the render ends" });
        if (removed === "not-found") throw new EngineFailure({ code: "NOT_FOUND", detail: `no own media ${mediaId} in the open library` });
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { mediaId } };
      }
      case "media.cancelImport": {
        const { jobId } = command.payload;
        if (!this.#media.cancel(jobId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no import job ${jobId} in this engine` });
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { jobId } };
      }
      case "videos.get":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { video: await this.#videos.get(command.payload.videoId) } };
      case "videos.render":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#videos.render(command.payload) };
      case "videos.cancel":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: this.#videos.cancel(command.payload.jobId) };
      case "videos.list":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { videos: await this.#videos.list(command.payload.avatarId) } };
      case "videos.delete":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#videos.delete(command.payload.videoId, command.payload.mode) };
      case "montages.create":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#montages.create(command.payload) };
      case "montages.get":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#montages.get(command.payload.montageId) };
      case "montages.list":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#montages.list(command.payload.avatarId) };
      case "montages.save":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#montages.save(command.payload) };
      case "montages.delete":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#montages.delete(command.payload.montageId) };
      case "montages.focus":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#montages.focus(command.payload) };
      case "montages.textPreview":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#textPreview.preview(command.payload.layer) };
      case "export.check": {
        // A fresh look at the current folder: `export.status` follows when it changed (a window asks on focus).
        const check = await this.#refreshExportStatus();
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { exportStatus: exportStatusOf(check) } };
      }
      case "music.status":
        // The window's ask writes a held quota-log line first (free, no request): the owner's way out once the disk is fixed.
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: await this.#music.status({ writeHeld: true }) };
      case "music.refresh": {
        const answer = await this.#music.refresh();
        if (!answer.ok) return errorResponseFor(command, answer.error);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { status: answer.status } };
      }
      case "music.recoverQuotaLog": {
        // 3c.6: the owner confirmed it in the window (the payload's `confirm: true`). Sends nothing.
        const answer = await this.#music.recoverQuotaLog();
        if (!answer.ok) return errorResponseFor(command, answer.error);
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { status: answer.status } };
      }
      case "music.list":
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { tracks: this.#music.list() } };
      case "music.peaks": {
        const { track, startMs, durationMs, bars } = command.payload;
        // An own track (3f.4): the waveform its record keeps (the 50 ms envelope the importer found), windowed by the same function as a trending track's. A media
        // the library does not hold, one that is not a track, one whose waveform cannot be trusted, and no open library all answer NOT_FOUND, with the detail the
        // answer had before own music existed (the parity golden names it).
        if (track.source === "own") {
          let waveform: number[] | undefined;
          try {
            waveform = await this.#media.waveform(track.mediaId);
          } catch {
            waveform = undefined;
          }
          if (waveform === undefined) return errorResponseFor(command, { code: "NOT_FOUND", detail: OWN_MUSIC_NOT_FOUND_DETAIL });
          return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { peaks: windowPeaks({ stepMs: 50, peaks: waveform }, startMs, durationMs, bars) } };
        }
        const peaks = await this.#music.peaks(track.trackId, startMs, durationMs, bars);
        if (peaks === null) return errorResponseFor(command, { code: "NOT_FOUND", detail: `track ${track.trackId} is not stored` });
        return { v, id: command.id, kind: "response", type: command.type, ok: true, result: { peaks } };
      }
      default:
        return errorResponseFor(command, { code: "INTERNAL", detail: `${command.type} is not implemented yet` });
    }
  }

  /**
   * Runs `work` with the live library, counted as a small write like `#setRejected`: a library switch waits for it, so
   * the library a render's checks ran against is the one the render is queued in. Refuses like every write does
   * (LIBRARY_UNAVAILABLE, IN_FLIGHT during a switch).
   */
  async #withLiveLibrary<T>(work: (library: Library) => Promise<T>): Promise<T> {
    // Counted before the first await, so a library switch cannot slip in while the library is being re-verified.
    this.#librarySmallWrites++;
    try {
      return await work(await this.#liveLibrary());
    } finally {
      this.#librarySmallWrites--;
    }
  }

  /** The focus resolver of a library, kept for its life (it holds the in-flight computations and the cache), with a fill budget that fits main's command deadline. */
  #focusOf(library: Library): Pick<FocusResolver, "fillMissingFocus" | "focusFor" | "focusForOwn"> {
    let resolver = this.#focusResolvers.get(library);
    if (resolver === undefined) {
      resolver = createFocusResolver({
        library,
        faceGate: this.#deps.faceGate ?? null,
        fillBudgetMs: this.#deps.videos?.focusBudgetMs ?? RENDER_FOCUS_BUDGET_MS,
        // 3f.2: an own photo is judged from the stored file's VERIFIED bytes (size and hash against its record), the same bytes a render copies.
        ownMedia: {
          read: async (mediaId, signal) => {
            const found = await this.#media.lookup(mediaId, "photo");
            const source = found === undefined ? null : ownPhotoSourceOf(found);
            if (source === null) return undefined;
            return { bytes: await readVerifiedOwnPhoto(source, signal), width: source.width, height: source.height };
          },
        },
      });
      this.#focusResolvers.set(library, resolver);
    }
    return resolver;
  }

  /**
   * One of the two recoveries of an avatar whose usage is unknown (3e.2, K16), as a small write on the live library (a library
   * switch waits for it). `work` answers its result and the avatars whose usage it may have moved; each of those whose summary
   * did move is announced (`avatar.changed`), so a repeat that changes nothing announces nothing. NOT_FOUND for an avatar the
   * library does not have; any other failure is INTERNAL with `what` and the disk's code only (the library's path never travels).
   */
  async #usageRecovery<R extends object>(avatarId: string, what: string, work: (library: Library) => Promise<{ result: R; avatarIds: readonly string[] }>): Promise<R> {
    return this.#withLiveLibrary(async (library) => {
      if (library.getAvatar(avatarId) === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
      const summaryOf = (id: string): string => {
        const manifest = library.getAvatar(id);
        return manifest === undefined ? "" : JSON.stringify(avatarSummaryFrom(manifest, avatarCounts(library, id)));
      };
      const before = new Map(library.listAvatars().map((manifest) => [manifest.id, summaryOf(manifest.id)]));
      let outcome: { result: R; avatarIds: readonly string[] };
      try {
        outcome = await work(library);
      } catch (error) {
        if (error instanceof LibraryError && error.code === "avatar-not-found") throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : errorKind(error);
        console.error(`studio engine: ${what} for avatar ${avatarId} (${code})`);
        throw new EngineFailure({ code: "INTERNAL", detail: `${what} (${code})` });
      }
      for (const id of outcome.avatarIds) {
        const manifest = library.getAvatar(id);
        if (manifest !== undefined && manifest.status !== "draft" && before.get(id) !== summaryOf(id)) this.#announceAvatarOrLog(library, id);
      }
      return outcome.result;
    });
  }

  /**
   * The owner's «do not use» mark on a scene photo, or its restore. Free and
   * idempotent. Announces the avatar, since its `eligibleUnusedCount` moved,
   * and answers the photo as it now stands.
   */
  async #setRejected(payload: CommandPayload<"photos.setRejected">): Promise<{ photo: PhotoSummary }> {
    const { avatarId, photoId, rejected } = payload;
    // Counted before the first await, so a library switch cannot slip in while the write is being verified or done.
    this.#librarySmallWrites++;
    let library: Library;
    try {
      library = await this.#liveLibrary();
      const changed = await library.setRejected(avatarId, photoId, rejected);
      if (changed) this.#announceAvatarOrLog(library, avatarId);
    } catch (error) {
      if (error instanceof LibraryError && (error.code === "avatar-not-found" || error.code === "photo-not-found")) {
        throw new EngineFailure({ code: "NOT_FOUND", detail: `no scene photo ${photoId} of avatar ${avatarId} in the open library` });
      }
      throw error;
    } finally {
      this.#librarySmallWrites--;
    }
    const photo = this.#photoSummaries(library, avatarId).photos.find((p) => p.photoId === photoId);
    if (photo === undefined) throw new EngineFailure({ code: "INTERNAL", detail: `photo ${photoId} was marked but does not fit the contract` });
    return { photo };
  }

  /**
   * An avatar's stored run photos (T8b), newest first, bounded at
   * MAX_LISTED_PHOTOS (no cursor yet — see that constant's own comment).
   * Candidates, master portraits and imports are not gallery photos and are
   * left out without comment (photoSummaryFrom, library/photoRecords.ts,
   * only reports a photo as a problem when it looks like a run photo, i.e.
   * carries a scene category); a run photo whose sidecar cannot be read into
   * the contract's shape is skipped, logged (the way the library logs other
   * unreadable records, #libraryView) and counted in `skippedTotal` — the
   * same precedent as avatars.list's own unreadableTotal, so a photo lost to
   * a contract mismatch is never silently invisible in the packaged app,
   * even though (unlike unreadableAvatars) there is no per-item list to show
   * for it. `skippedTotal` is never itself bounded: it counts every skip,
   * not only those among the returned (and possibly capped) photos.
   */
  #photosFor(library: Library, avatarId: string): { photos: PhotoSummary[]; skippedTotal: number } {
    const { photos, skippedTotal } = this.#photoSummaries(library, avatarId);
    return { photos: finalizePhotoList(photos, MAX_LISTED_PHOTOS), skippedTotal };
  }

  /**
   * Every gallery photo of the avatar as the contract shows it, unordered and
   * unbounded, with the library's own answer for each (`Library.photoStates`:
   * the one eligibility rule, used, rejected, reserved), asked once.
   */
  #photoSummaries(library: Library, avatarId: string): { photos: PhotoSummary[]; skippedTotal: number } {
    const states = library.photoStates(avatarId);
    const photos: PhotoSummary[] = [];
    let skippedTotal = 0;
    for (const sidecar of library.photosByAvatar(avatarId)) {
      const state = states.get(sidecar.id);
      const summary = state === undefined ? null : photoSummaryFrom(sidecar, state);
      if (summary !== null) photos.push(summary);
      else if (looksLikeRunPhoto(sidecar)) {
        skippedTotal++;
        console.warn(`studio engine: photo ${sidecar.id} of avatar ${avatarId} does not fit the contract and is not listed in its gallery`);
      }
    }
    return { photos, skippedTotal };
  }

  // ---------- photo runs (T6) ----------

  /**
   * The manifest of an avatar a run may make photos of: a saved, active
   * avatar whose stored descriptor today's rules still accept. NOT_FOUND for
   * an unknown id, a draft (no master yet) or an archived avatar;
   * DESCRIPTOR_INVALID for a descriptor that has to be rewritten first.
   */
  #runnableAvatar(library: Library | null, avatarId: string): AvatarManifest {
    const manifest = library?.getAvatar(avatarId);
    if (manifest === undefined || manifest.status !== "active") throw new EngineFailure({ code: "NOT_FOUND", detail: `no saved, active avatar ${avatarId} in the open library` });
    this.#assertDescriptorReadable(manifest);
    return manifest;
  }

  /**
   * Invariant 8 (review M2): with the image age check on, every photo must
   * pass it before it enters the library — a run cannot start, or resume,
   * without the age gate among its QA gates. `imageAgeCheck` is the run's
   * own mode (the settings' at start, the plan's on a resume).
   */
  #assertAgeGate(imageAgeCheck: ImageAgeCheck): void {
    if (imageAgeCheck === "on" && !this.#qaGates.some((gate) => gate.name === AGE_GATE_NAME)) {
      throw new EngineFailure({ code: "AGE_GATE_UNAVAILABLE", detail: "the image age check is on, but this build has no age gate among the engine's QA gates (a wiring defect, not fixed by a restart); turn the check off in Settings to run" });
    }
  }

  /**
   * T7b: unlike the age gate, the face gate is never a Settings toggle — it
   * is always required, so a run cannot start, or resume, without it among
   * its QA gates. Its only real absence is a startup-time failure (the face
   * models or onnxruntime-web could not be loaded, studio/engine/main.ts's
   * own wiring) — this refuses the run for free rather than silently storing
   * photos no identity check has ever seen.
   */
  #assertFaceGate(): void {
    const face = this.#qaGates.find((gate) => gate.name === FACE_GATE_NAME);
    if (face === undefined) {
      const base = "no face gate is wired into photo runs; restart Studio, or reinstall it if this persists";
      throw new EngineFailure({ code: "FACE_GATE_UNAVAILABLE", detail: this.#faceGateLoadError === undefined ? base : `${base} (${this.#faceGateLoadError})` });
    }
    // A gate that broke after startup (its worker could not be terminated) fails every check: refuse the run free,
    // not after a wave of images was paid for (a cached master embedding would let `prepare()` pass).
    if (face.available?.() === false) {
      throw new EngineFailure({ code: "FACE_GATE_UNAVAILABLE", detail: "the face gate broke (its worker could not be stopped) and stays unusable until Studio restarts; restart Studio" });
    }
  }

  /** The ledger's record of attempt ids, for a run's fold (the one Budget's ledger). */
  #ledgerView(budget: Budget): LedgerView {
    return { reserveOf: (attemptId) => budget.ledger.reserveOf(attemptId), closeOf: (attemptId) => budget.ledger.closeOf(attemptId) };
  }

  /**
   * A run's state as a resume would continue it, and what that resume could
   * still spend (runs/remaining.ts): today's prices for its own models and
   * age-check mode, never more than its cap leaves after what it committed.
   * VALIDATION when every slot already ended.
   */
  async #remaining(library: Library | null, plan: RunPlan): Promise<{ state: RunState; estimate: Estimate; priced: PricedBook; budget: Budget }> {
    const money = this.#money;
    if (!money.ok) throw new EngineFailure({ code: money.unavailable.cause, detail: money.unavailable.detail });
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    const { budget } = money;
    const { events } = await library.readJournal(plan.runId, RunEventSchema);
    const ledger = this.#ledgerView(budget);
    const state = foldRun(plan, { events, ...ledger, photos: library.photosByAvatar(plan.avatarId) });
    if (state.slots.every((s) => s.end !== null)) throw new EngineFailure({ code: "VALIDATION", detail: `run ${plan.runId} has nothing left to resume: every slot already ended` });
    const priced = await this.#prices.get(runPriceModels({ imageModel: plan.models.image, textModel: plan.models.text }, plan.imageAgeCheck));
    const committed = scopeCommitted(budget.ledger, { runId: plan.runId });
    const { estimate, minToProgressMicros } = remainingPlan(priced, plan, state, committed, ledger);
    // A cap that cannot fund one more attempt has ended the run: refused free, before anything is claimed or accepted.
    // Not while the run's own open reserves wait for a reconcile: they count at their worst case until then, so the room is not final.
    if (!budget.scopeNeedsReconcile({ runId: plan.runId }) && !capFundsResume(plan, committed, minToProgressMicros)) {
      throw new EngineFailure({ code: "RUN_CAP_EXCEEDED", detail: `run ${plan.runId}'s cap leaves ${Math.max(0, plan.capMicros - committed)} micro-dollars, less than the ${minToProgressMicros ?? 0} its next attempt could cost: it has ended` });
    }
    return { state, estimate, priced, budget };
  }

  /**
   * Every run of the open library, newest first (review M4): found on disk,
   * so a window opened after a restart can offer a stopped run for a resume.
   * A run whose plan or journal no longer reads is left out (and logged);
   * its remaining worst case is null when prices cannot be loaded now.
   * Everything is read at once, and prices load once per model set, all sets
   * at once (review round 3, L-d): offline, the whole list takes one price
   * load's timeout, never one per model set.
   */
  async #listRuns(): Promise<RunSummary[]> {
    const library = this.library;
    const money = this.#money;
    if (library === null || !money.ok) return [];
    const ledger = this.#ledgerView(money.budget);
    const read = await Promise.all(
      (await library.listRuns()).map(async (runId) => {
        try {
          const plan = await library.readRun(runId, RunPlanSchema);
          const { events } = await library.readJournal(runId, RunEventSchema);
          const state = foldRun(plan, { events, ...ledger, photos: library.photosByAvatar(plan.avatarId) });
          return { runId, plan, state, models: runPriceModels({ imageModel: plan.models.image, textModel: plan.models.text }, plan.imageAgeCheck) };
        } catch (error) {
          console.warn(`studio engine: run ${runId} could not be read for the list (${messageOf(error, "unknown error")})`);
          return null;
        }
      }),
    );
    const found = read.flatMap((run) => (run === null ? [] : [run]));
    const modelSets = new Map(found.map((run) => [JSON.stringify(run.models), run.models]));
    const priced = new Map(
      await Promise.all(
        [...modelSets].map(async ([key, models]) => [key, await this.#prices.get(models).catch(() => null)] as const),
      ),
    );
    const runs = found.map(({ runId, plan, state, models }): RunSummary => {
      const committed = scopeCommitted(money.budget.ledger, { runId });
      const done = state.slots.filter((s) => s.end?.status === "done").length;
      const failed = state.slots.filter((s) => s.end?.status === "failed").length;
      const open = state.slots.length - done - failed;
      const running = this.#jobs.runningJobOf(runId) !== null;
      const book = priced.get(JSON.stringify(models)) ?? null;
      // Ended by its cap only when prices are known: unpriced, the engine cannot tell and leaves the run resumable.
      const remaining = open === 0 || book === null ? null : remainingPlan(book, plan, state, committed, ledger);
      const capExhausted = !running && open > 0 && remaining !== null && !money.budget.scopeNeedsReconcile({ runId }) && !capFundsResume(plan, committed, remaining.minToProgressMicros);
      return {
        runId,
        avatarId: plan.avatarId,
        createdAt: plan.createdAt,
        total: state.slots.length,
        done,
        failed,
        open,
        capMicros: plan.capMicros,
        committedMicros: committed,
        running,
        resumable: !running && open > 0 && !capExhausted,
        capExhausted,
        remainingWorstMicros: open === 0 ? 0 : remaining === null ? null : remaining.estimate.worstMicros,
      };
    });
    runs.sort((a, b) => (a.createdAt === b.createdAt ? (a.runId < b.runId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    return runs.slice(0, MAX_LISTED_RUNS);
  }

  /** A run's persisted plan; NOT_FOUND for a run the library does not have. */
  async #readRunPlan(library: Library | null, runId: string): Promise<RunPlan> {
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    try {
      return await library.readRun(runId, RunPlanSchema);
    } catch (error) {
      if (error instanceof LibraryError && (error.code === "run-not-found" || error.code === "invalid-id")) throw new EngineFailure({ code: "NOT_FOUND", detail: `no run ${runId} in the open library` });
      throw error;
    }
  }

  /**
   * A new photo run. Checked before anything is spent, in createDraft's
   * order: a usable key, a ledger that allows paid calls, an open library, an
   * avatar that can get photos (active, a master to use as the face
   * reference, a descriptor today's rules accept), the worst case the user
   * accepted (PRICE_CHANGED, `>` like every paid command) and room in the
   * month. Then the scenes are planned — steered away from the avatar's
   * recent location + outfit pairs — and persisted with every attempt id
   * pre-allocated as runs/<runId>/plan.json before the writer's first call
   * (invariant 6). The run's cap is that accepted worst case, for its whole
   * life. The job runs on after the answer.
   */
  async #startRun(payload: CommandPayload<"runs.start">): Promise<{ runId: string; jobId: string }> {
    const key = this.#usableKey("start a photo run");
    const budget = this.#paidBudget();
    const library = await this.#liveLibrary();
    const { avatarId, count, categories, poses } = payload;
    const manifest = this.#runnableAvatar(library, avatarId);
    if (library.referencePhoto(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} has no usable master photo to use as the face reference` });
    // Captured once, here: a mid-flight settings change must not affect this run, whose cap is fixed now.
    const imageAgeCheck = this.#settings.imageAgeCheck;
    this.#assertAgeGate(imageAgeCheck);
    this.#assertFaceGate();
    const models = this.#avatarModels();
    const priced = await this.#prices.get(runPriceModels(models, imageAgeCheck));
    const estimate = runEstimate(priced, models, payload, imageAgeCheck);
    Engine.#checkAccepted(estimate.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, estimate.worstMicros);

    // The gates' own look at the master (a face gate finds a master with no usable face here), free and
    // before a run exists: a refused start leaves no plan.json, reserve or run folder behind. The job
    // still prepares them itself (a resume needs that too; cached embeddings make it cheap).
    const gates = this.#gatesFor(imageAgeCheck);
    const preflight = await preflightMaster({ library, gates }, avatarId, new AbortController().signal);
    if (!preflight.ok) {
      if (preflight.end.status === "failed") throw new EngineFailure(preflight.end.error);
      throw new EngineFailure({ code: "INTERNAL", detail: "the master photo could not be checked before the run" });
    }

    const runId = this.#deps.newId();
    const jobId = this.#deps.newId();
    const recent = await library.recentPairs(avatarId, RECENT_PAIRS).catch((error: unknown) => {
      // A hint for the planner, never a reason to refuse a run: plan without it, and say so.
      console.warn(`studio engine: avatar ${avatarId}'s scene history could not be read; planning without it (${messageOf(error, "unknown error")})`);
      return [];
    });
    const scenes = planScenes({
      seed: seedOf(runId),
      count,
      categories: categories.map(sceneCategory),
      excludePairs: recent.map(({ location, outfit }) => ({ location, outfit })),
      // Profile and back only when the run allows them (T5c, owner decision); selfie and mirror stay front or three-quarter.
      poses,
    });
    const plan = buildRunPlan({
      runId,
      avatarId,
      createdAt: new Date(this.#deps.clock()).toISOString(),
      request: { avatarId, count, categories, poses },
      imageAgeCheck,
      models,
      capMicros: estimate.worstMicros,
      plannedWorstMicros: estimate.worstMicros,
      scenes,
    });
    await library.createRun(runId, plan, RunPlanSchema);
    this.#launchRun({ jobId, plan, descriptor: { age: manifest.age, text: manifest.descriptor }, key, budget, library, priceBook: priced.book }, 0);
    return { runId, jobId };
  }

  /**
   * Resumes a stopped run (a cancel, a failure, or a crash of an earlier
   * engine) from its persisted state: its plan.json, never re-planned, with
   * its own cap, models and age-check mode; its journal; the ledger's
   * reserves; and the photos already committed. Checked like a start, with
   * the owner's consent to what it could still spend (review M3): the
   * remaining worst case at today's prices, within what the cap leaves
   * (PRICE_CHANGED when it rose above the accepted one), and room in the
   * month for it. The cap itself is never raised. After a crash, the
   * ledger's open reserves refuse this with RECONCILE_REQUIRED until the user
   * reconciles (invariant 4). VALIDATION when every slot already ended.
   */
  async #resumeRun(payload: CommandPayload<"runs.resume">): Promise<{ runId: string; jobId: string }> {
    const { runId } = payload;
    const key = this.#usableKey("resume a photo run");
    this.#paidBudget();
    const library = await this.#liveLibrary();
    const plan = await this.#readRunPlan(library, runId);
    this.#claimAvatar(plan.avatarId, "a photo run or another job is already changing this avatar; wait for it to finish");
    let launched = false;
    try {
      const manifest = this.#runnableAvatar(library, plan.avatarId);
      this.#assertAgeGate(plan.imageAgeCheck);
      this.#assertFaceGate();
      const { state, estimate, priced, budget } = await this.#remaining(library, plan);
      Engine.#checkAccepted(estimate.worstMicros, payload.acceptedWorstMicros);
      // A free resume (nothing left it could send: it only closes slots) spends nothing, so a month already over budget cannot refuse it.
      if (estimate.worstMicros > 0) Engine.#checkMonthlyRoom(budget, estimate.worstMicros);
      const done =state.slots.filter((s) => s.end !== null).length;
      const jobId = this.#deps.newId();
      this.#launchRun({ jobId, plan, descriptor: { age: manifest.age, text: manifest.descriptor }, key, budget, library, priceBook: priced.book }, done);
      launched = true;
      return { runId, jobId };
    } finally {
      if (!launched) this.#busyAvatars.delete(plan.avatarId);
    }
  }

  /**
   * A run's QA gates. T7a: a wired age gate is only ever run for a run that
   * was itself started (or resumed) with the image age check on — its own
   * mode, captured once at plan time (a mid-flight toggle change never
   * affects a job already running). With the toggle off the age gate is
   * dropped from the list entirely: no call, no reserve, whatever
   * `deps.qaGates` (main.ts's wiring) contains.
   */
  #gatesFor(imageAgeCheck: ImageAgeCheck): readonly QaGate[] {
    return imageAgeCheck === "on" ? this.#qaGates : this.#qaGates.filter((gate) => gate.name !== AGE_GATE_NAME);
  }

  /** Registers the run's job under its own scope, capped by its plan, and runs it on after the answer. */
  #launchRun(run: Omit<RunningRun, "signal">, done: number): void {
    const { plan } = run;
    const signal = this.#jobs.startRun(run.jobId, { runId: plan.runId, avatarId: plan.avatarId, total: plan.scenes.slots.length, done });
    this.#caps.set(scopeKey({ runId: plan.runId }), plan.capMicros);
    // Announced now, not at the first slot's end: the writer phase can take a while, and another window can only see
    // (and cancel) a run it has been told about.
    try {
      const progress = this.#jobs.progress(run.jobId, done);
      if (progress !== null) this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.progress", payload: progress });
    } catch (error) {
      console.error(`studio engine: the launch of run job ${run.jobId} could not be announced (${errorKind(error)})`);
    }
    void this.#runPhotos({ ...run, signal });
  }

  /**
   * Runs a registered run job to its end and announces it: money.changed,
   * then job.done, job.failed or job.cancelled. Its cap, its avatar and the
   * library switch are released first. Never rejects.
   */
  async #runPhotos(run: RunningRun): Promise<void> {
    const { plan } = run;
    let end: RunJobEnd;
    try {
      const client = this.#openRouter(run.key, reportingTo(this.#networkPool, this.#deps.fetch));
      end = await runPhotoRun(
        {
          generateImage: (params) => client.generateImage(params),
          chat: (params) => client.chat(params),
          budget: run.budget,
          priceBook: run.priceBook,
          library: run.library,
          pool: this.#networkPool,
          cpu: this.#cpuPool,
          // T7a: a wired age gate is only ever run for a run that was itself
          // started (or resumed) with the image age check on — its own mode,
          // captured once at plan time (invariant: a mid-flight toggle change
          // never affects a job already running). With the toggle off, the
          // age gate is dropped from the list entirely: no call, no reserve,
          // whatever `deps.qaGates` (main.ts's wiring) contains.
          gates: this.#gatesFor(plan.imageAgeCheck),
          now: () => new Date(this.#deps.clock()),
          errorOf: engineErrorFrom,
          onSlot: (progress) => this.#runSlotDone(run, progress),
          warn: (line) => console.warn(line),
        },
        { plan, jobId: run.jobId, descriptor: run.descriptor, signal: run.signal },
      );
    } catch (error) {
      end = { status: "failed", error: engineErrorFrom(error) };
    }
    this.#caps.delete(scopeKey({ runId: plan.runId }));
    this.#paidCommands--;
    this.#busyAvatars.delete(plan.avatarId);
    try {
      if (end.status === "failed" && end.error.code === "AUTH_INVALID") this.markKeyRejected(run.key);
      this.#emitMoney();
      const state = this.#jobs.finishRun(run.jobId, end);
      const v = PROTOCOL_VERSION;
      // The job's identity is the run's own, never read back from the registry: it must name the job even when the registry no longer knows it.
      const ref = { kind: "run" as const, jobId: run.jobId, runId: plan.runId, avatarId: plan.avatarId };
      if (state?.status === "done" && state.result !== undefined) {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.done", payload: { jobId: run.jobId, result: state.result } });
      } else if (end.status === "failed") {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      } else if (end.status === "cancelled") {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
      }
    } catch (error) {
      console.error(`studio engine: the end of run job ${run.jobId} could not be announced (${errorKind(error)})`);
    }
  }

  /** A slot that ended: the progress moves on, and a stored photo changes its avatar's photo count. */
  #runSlotDone(run: RunningRun, progress: { done: number; photoId: string | null }): void {
    try {
      if (progress.photoId !== null) this.#announceAvatarOrLog(run.library, run.plan.avatarId);
      const payload = this.#jobs.progress(run.jobId, progress.done);
      if (payload !== null) this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.progress", payload });
    } catch (error) {
      // The slot's money and photo are already recorded; only its announcement failed.
      console.error(`studio engine: a slot of run job ${run.jobId} could not be announced (${errorKind(error)})`);
    }
  }

  #snapshot(): Snapshot {
    const view = this.#libraryView();
    const nextBatch = this.#nextBatchAtKnownPrices();
    return {
      bootId: this.#events.bootId,
      lastSeq: this.#events.lastSeq,
      settings: this.#currentSettings(),
      money: this.#moneyStatus(),
      avatars: view.avatars,
      drafts: view.drafts.map((draft) => ({ ...draft, estimate: nextBatch })),
      unreadableAvatars: view.unreadable,
      unreadableTotal: view.unreadableTotal,
      // Avatar and photo run jobs of this engine's life.
      jobs: this.#jobs.states(),
      librarySwitchGeneration: this.#librarySwitchGeneration,
      // As of the last check: start, a settings update, or a render attempt (`#refreshExportStatus`).
      exportStatus: this.#exportStatus,
      notices: [...this.#notices],
    };
  }

  /**
   * Checks the export folder against the current settings and keeps the result
   * as the snapshot's `exportStatus` (invariant 35). The default folder is
   * created on first use; a folder the owner chose is not. Checks are queued
   * one behind another. `requiredBytes` is the render's estimate, when there is
   * one. A refusal is a result; a disk error the check cannot classify, or a
   * volume that does not answer within the timeout (a stale network share), is
   * logged and read as not writable, so neither start nor a render can hang on it.
   */
  #refreshExportStatus(requiredBytes?: number): Promise<ExportRootCheck> {
    // A check still waiting its turn reads the settings only when it starts, so a caller that wants exactly what it
    // wants (the same size estimate, or none) can share it: N attempts on a mute volume cost one timeout and one hung
    // call, not N. A different estimate is a different question (free space), so it never joins.
    const queued = this.#queuedExport;
    if (queued !== null && queued.requiredBytes === requiredBytes) return queued.run;
    const run: Promise<ExportRootCheck> = this.#exportChain.then(() => {
      if (this.#queuedExport?.run === run) this.#queuedExport = null;
      return this.#checkExportOnce(requiredBytes);
    });
    // Whatever `run` does, the chain goes on: one failure must not wedge every later check.
    this.#exportChain = run.catch(() => undefined);
    this.#queuedExport = { run, requiredBytes };
    return run;
  }

  /** One bounded check of the current export folder, whose result is the status every window shows; never rejects. */
  async #checkExportOnce(requiredBytes: number | undefined): Promise<ExportRootCheck> {
    const exportPath = this.#settings.exportPath;
    const check = await this.#boundedExportCheck(exportPath, { mayCreate: exportPath === this.#defaultExportPath, probeCase: true, requiredBytes });
    // "Not enough room" answers a question about THIS render's size (`requiredBytes`), not about the folder: a 4 s spec may fit
    // where a 15 s one does not, so it is a refusal for that render and never the status every window shows.
    if (requiredBytes === undefined || check.ok || check.reason !== "not-enough-space") this.#setExportStatus(exportStatusOf(check));
    return check;
  }

  /**
   * The export check of `exportPath` (any folder: the current one, or one the owner is about to pick), bounded, and never
   * rejecting: a disk error the check cannot classify, or a volume that does not answer, reads as not writable. It moves no
   * status. `probeCase` also asks the volume whether it folds letter case, which leaves a probe file behind for a moment, so a
   * folder that is only being looked at is not probed.
   */
  async #boundedExportCheck(exportPath: string, options: { mayCreate: boolean; probeCase: boolean; requiredBytes?: number | undefined }): Promise<ExportRootCheck> {
    const timeout = timeoutSignal(this.#exportCheckTimeoutMs());
    let check: ExportRootCheck;
    try {
      check = await untilAborted(
        // The overlap check comes FIRST and assumes the volume folds case (the cautious guess: it can only find MORE overlaps), so nothing
        // is written into the folder until it is known not to be the library or inside it. The volume is probed only once the check has
        // passed, and inside the same bounded call: a disk that hangs on the probe must not outlast the timeout.
        checkExportRoot({
          fs: this.#exportRootFs,
          exportPath,
          libraryPath: this.#settings.libraryPath,
          mayCreate: options.mayCreate,
          newId: this.#deps.newId,
          now: () => new Date(this.#deps.clock()),
          caseInsensitive: true,
          // A damaged marker in a library that already holds videos gets the text that never advises deleting it (3e.3). A library
          // that cannot be looked in (closed, or an avatar nobody could read) may hold them: the question then answers yes.
          recordsExist: () => this.#recordsMayExist(),
          workPaths: this.#renderTmpDir === null ? [] : [this.#renderTmpDir],
          ...(options.requiredBytes === undefined ? {} : { requiredBytes: options.requiredBytes }),
        }).then(async (checked) => {
          if (checked.ok && options.probeCase) await this.#caseProbe.isCaseInsensitive(exportPath);
          return checked;
        }),
        timeout.signal,
      );
    } catch (error) {
      console.error(`studio engine: the export folder could not be checked (${errorKind(error)})`);
      check = { ok: false, reason: "not-writable" };
    } finally {
      timeout.clear();
    }
    if (!check.ok) console.warn(`studio engine: the export folder check refused it (${check.reason})`); // the reason only: a CI log or a support report can say which step
    return check;
  }

  #exportSwitchPending(): boolean {
    return this.#exportSwitchUntil !== null && this.#deps.monotonic() < this.#exportSwitchUntil;
  }

  /** Whether the library may hold video records: it cannot be looked in (closed), an avatar of it could not be read, or a record file is there. */
  async #recordsMayExist(): Promise<boolean> {
    if (this.#live === null || this.#libraryView().unreadableTotal > 0) return true;
    return libraryHasVideoRecords(this.#live.library);
  }

  /**
   * `export.choose`: what the folder the owner picked is, and how many records resolve in it. Nothing is adopted and no status
   * moves: main persists the path and sends `settings.update`, and that is what makes it the export folder.
   */
  async #chooseExportFolder(path: string): Promise<Pick<EngineReply, "error" | "exportFolder">> {
    // A render commits into the folder it was planned for, and its record would be left behind by a switch under it. One that is
    // still being prepared counts: its plan already names the folder, and nothing is queued for `active()` to see.
    const inFlight = (): boolean => this.#renders.active() > 0 || this.#videos.preparing > 0;
    const refuseInFlight = { error: { code: "IN_FLIGHT", detail: "a video render is queued or running; change the export folder when it ends" } } as const;
    if (inFlight()) return refuseInFlight;
    // Never created: the dialog makes folders, and a path that is not there is a drive that is not plugged in.
    const check = await this.#boundedExportCheck(path, { mayCreate: false, probeCase: false });
    if (!check.ok) return { error: { code: "EXPORT_UNAVAILABLE", exportReason: check.reason, detail: `the folder cannot be the export folder (${check.reason})` } };
    try {
      const counts = this.#live === null ? { resolved: 0, elsewhere: 0, unreadable: 0, truncated: false } : await countRecordsByRoot(this.#live.library, check.rootId);
      // From now until the settings arrive, no render may be submitted: the owner is about to be told what the folder holds.
      if (inFlight()) return refuseInFlight;
      this.#exportSwitchUntil = this.#deps.monotonic() + EXPORT_SWITCH_WAIT_MS;
      return { exportFolder: { rootId: check.rootId, resolved: counts.resolved, elsewhere: counts.elsewhere, incomplete: counts.unreadable > 0 || counts.truncated } };
    } catch (error) {
      // The raw error names the library's own path: only its kind is told.
      console.error(`studio engine: the video records could not be counted for the export folder (${errorKind(error)})`);
      return { error: { code: "INTERNAL", detail: "the video records could not be read, so the folder was not changed" } };
    }
  }

  /**
   * Keeps the folder's status and, when it CHANGED, tells the windows (`export.status`): the Render button follows the disk
   * live, without a window asking again. A check that finds the same status says nothing, and so does the first one of an
   * engine's life: it is the baseline the snapshot carries (a window of an earlier engine resyncs on the new `bootId`).
   */
  #setExportStatus(next: ExportStatus): void {
    const before = this.#exportStatus;
    const known = this.#exportStatusKnown;
    this.#exportStatus = next;
    this.#exportStatusKnown = true;
    const same = before.status === next.status && (before.status === "ok" || (next.status === "unavailable" && before.reason === next.reason));
    if (!known || same) return;
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "export.status", payload: { exportStatus: next } });
  }

  /**
   * Saved avatars and drafts of the live library, plus every avatar record it
   * could not list normally: a whole manifest quarantined at open (this
   * library's own, fixed for its life) and every record `libraryView` had to
   * skip (drafts and saved avatars alike, re-checked on every call — a
   * descriptor that fails today's rules only after a rule tightened is caught
   * here, not only at open). Bounded at MAX_UNREADABLE_AVATARS, a rewritable
   * (descriptor-invalid) entry first (records.ts's `combineUnreadable`, L2):
   * a library with many quarantined or otherwise unreadable folders must
   * never push a fixable one off the list.
   */
  #libraryView(): { avatars: AvatarSummary[]; drafts: Draft[]; unreadable: UnreadableAvatar[]; unreadableTotal: number } {
    if (this.#live === null) return { avatars: [], drafts: [], unreadable: [], unreadableTotal: 0 };
    const view = libraryView(this.#live.library);
    const fresh = view.skipped.filter((s) => !this.#reportedSkips.has(s.avatarId));
    if (fresh.length > 0) {
      for (const s of fresh) this.#reportedSkips.add(s.avatarId);
      console.warn(`studio engine: avatar records that do not fit the contract are not listed: ${fresh.map((s) => s.avatarId).join(", ")}`);
    }
    const fromSkipped: UnreadableAvatar[] = view.skipped.map((s) => ({ avatarId: s.avatarId, name: s.name, reason: s.reason, detail: UNREADABLE_REASON_DETAIL[s.reason] }));
    // The true count, before the bound: the list a window shows can be cut, this count never is (L1).
    const unreadableTotal = fromSkipped.length + this.#live.unreadable.length;
    const unreadable = combineUnreadable(fromSkipped, this.#live.unreadable);
    return { avatars: view.avatars, drafts: view.drafts, unreadable, unreadableTotal };
  }

  // ---------- avatars ----------

  #avatarModels(): AvatarModels {
    return { imageModel: this.#settings.imageModel, textModel: this.#settings.textModel };
  }

  /** A draft of the open library as the contract lists it; null for anything else. */
  #draft(avatarId: string): Draft | null {
    const library = this.library;
    const manifest = library?.getAvatar(avatarId);
    if (library === null || manifest === undefined) return null;
    return draftFrom(manifest, library.photosByAvatar(avatarId));
  }

  /**
   * A draft's next batch at the prices the engine already has (the contract's
   * `Draft.estimate`); null before any estimate loaded them. Never fetches:
   * a snapshot must not wait on the network.
   */
  #nextBatchAtKnownPrices(): Estimate | null {
    const models = this.#avatarModels();
    const imageAgeCheck = this.#settings.imageAgeCheck;
    const priced = this.#prices.peek(avatarPriceModels(models, "next-batch", imageAgeCheck));
    return priced === null ? null : avatarJobEstimate(priced, models, "next-batch", imageAgeCheck);
  }

  /**
   * Re-broadcasts every open draft with its estimate repriced in the current
   * mode, whenever settings.imageAgeCheck itself changed (whole-slice review,
   * MEDIUM #5): a draft's own `estimate` is a snapshot taken when it was last
   * priced (createDraft, or a prior batch) and never updates itself, so it
   * would otherwise disagree with the wizard's caption, which reads the
   * setting live — the renderer applies `draft.changed` like any other event,
   * so this is enough; no renderer change is needed. A snapshot (or the next
   * `avatars.estimateCandidates`) already re-prices on demand — this only
   * covers a draft a window may already be showing. Never fetches (like
   * `#nextBatchAtKnownPrices` itself): a settings.update has no reply main
   * waits on, so this must not hold it up on the network.
   */
  #rebroadcastDraftEstimates(): void {
    if (this.#live === null) return;
    const nextBatch = this.#nextBatchAtKnownPrices();
    for (const manifest of this.#live.library.listAvatars()) {
      if (manifest.status !== "draft") continue;
      const draft = draftFrom(manifest, this.#live.library.photosByAvatar(manifest.id));
      if (draft === null) continue;
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "draft.changed", payload: { draft: { ...draft, estimate: nextBatch } } });
    }
  }

  /** The stored manifest for `avatarId` in `library` (any status), whether or not it fits the contract; NOT_FOUND when there is none. */
  #manifestOrNotFound(library: Library | null, avatarId: string): AvatarManifest {
    const manifest = library?.getAvatar(avatarId);
    if (manifest === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    return manifest;
  }

  /**
   * DESCRIPTOR_INVALID (never INTERNAL) when `manifest`'s stored descriptor
   * fails today's rules: shared by every command that touches an existing
   * record's descriptor (the estimate and candidate commands, pick, archive)
   * so a tightened rule always answers the same way, never a generic
   * NOT_FOUND that hides the real, recoverable cause.
   */
  #assertDescriptorReadable(manifest: AvatarManifest): void {
    try {
      promptSubject({ age: manifest.age, text: manifest.descriptor });
    } catch (error) {
      if (!(error instanceof PromptSubjectError)) throw error;
      throw new EngineFailure({ code: "DESCRIPTOR_INVALID", detail: messageOf(error, "the stored descriptor fails today's rules") });
    }
  }

  /**
   * VALIDATION, before any spend, when there is nothing `avatars.rewriteDescriptor`
   * could do for `manifest`: its descriptor already fits today's rules
   * (nothing to fix), or it is not rewritable at all (records.ts's
   * `isRewritable`: untyped traits, a vibe that no longer parses, a name
   * over 60 chars, ...) — rewriting the descriptor alone would not recover
   * such a record, so estimating or paying for it would be a dead end.
   */
  #assertRewritable(avatarId: string, manifest: AvatarManifest): void {
    if (AvatarDescriptor.safeParse({ age: manifest.age, text: manifest.descriptor }).success) {
      throw new EngineFailure({ code: "VALIDATION", detail: `avatar ${avatarId}'s descriptor already fits today's rules; nothing to rewrite` });
    }
    if (!isRewritable(manifest)) {
      throw new EngineFailure({ code: "VALIDATION", detail: `avatar ${avatarId} cannot be rewritten: its record does not fit the contract beyond the descriptor` });
    }
  }

  /**
   * The paid recovery for `avatarId`'s stored descriptor: the same descriptor
   * job as createDraft, from its stored typed traits alone (manifest schema
   * version 2 only), under exactly createDraft's guard order — a usable key,
   * a ledger that allows paid calls, an open library, the id, whether there is
   * anything to fix, the accepted worst case and room in the month — then the
   * library's atomic manifest write. Its master photo, candidates and name
   * are never touched: only `descriptor` is patched.
   */
  async #rewriteDescriptor(payload: CommandPayload<"avatars.rewriteDescriptor">): Promise<{ avatarId: string }> {
    const key = this.#usableKey("rewrite an avatar's descriptor");
    const budget = this.#paidBudget();
    const library = await this.#liveLibrary();
    const { avatarId } = payload;
    const manifest = this.#manifestOrNotFound(library, avatarId);
    this.#assertRewritable(avatarId, manifest);
    // isRewritable (inside #assertRewritable) already proved this parses; re-parsed here only to get its typed data.
    const traits = AvatarTraits.safeParse({ ...manifest.traits, age: manifest.age });
    if (!traits.success) throw new Error(`unreachable: isRewritable said avatar ${avatarId}'s traits parse`);
    const models = this.#avatarModels();
    // rewrite-descriptor never touches candidates or age checks either way (see the estimate command's own comment above).
    const imageAgeCheck = this.#settings.imageAgeCheck;
    const priced = await this.#prices.get(avatarPriceModels(models, "rewrite-descriptor", imageAgeCheck));
    const job = avatarJobEstimate(priced, models, "rewrite-descriptor", imageAgeCheck);
    Engine.#checkAccepted(job.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, job.worstMicros);

    const jobId = this.#deps.newId();
    const scope: Scope = { avatarJobId: jobId };
    // The scope only ever sends descriptor attempts: its cap is theirs, just like createDraft's.
    this.#caps.set(scopeKey(scope), descriptorJobCap(priced, models));
    const client = this.#openRouter(key);
    const linesBefore = budget.ledger.lines.length;
    let result: Awaited<ReturnType<typeof runDescriptorJob>>;
    try {
      result = await runDescriptorJob(
        { chat: (params) => client.chat(params), budget, priceBook: priced.book },
        { jobId, scope, traits: traits.data, textModel: models.textModel },
      );
    } finally {
      this.#caps.delete(scopeKey(scope));
      if (budget.ledger.lines.length !== linesBefore || budget.ledger.failed) this.#emitMoney();
    }
    if (!result.ok) {
      if (result.error.code === "AUTH_INVALID") this.markKeyRejected(key);
      throw new EngineFailure(result.error);
    }

    const { descriptor } = result;
    const updated = await library.updateAvatar(avatarId, { descriptor: descriptor.text }).catch(async (error: unknown) => {
      // The descriptor is paid for: keep it where the owner can find it, and say where.
      const kept = `${jobId}:rewrite`;
      const where = await saveRawBody(this.#rawDir, kept, JSON.stringify({ avatarId, descriptor })).then(
        () => `the paid descriptor is kept in raw/${rawFileName(kept)} next to the ledger`,
        (saveError: unknown) => `the paid descriptor could not be kept either (${messageOf(saveError, "unknown error")})`,
      );
      // Where it is kept comes first, so the 500-char cut of `detail` cannot drop it.
      throw new EngineFailure({ code: "INTERNAL", detail: detailOf(`${where}: the descriptor could not be written (${messageOf(error, "unknown error")})`) });
    });
    // The write already committed: isRewritable proved the record would fit
    // with a valid descriptor, and the one just written is valid (the
    // descriptor job never returns anything else), so this cannot fail in
    // normal operation. Defensively, though, a paid write that already
    // committed must never turn into INTERNAL over its own announcement.
    if (updated.status === "draft") this.#emitDraft(library, avatarId);
    else this.#announceAvatarOrLog(library, avatarId);
    return { avatarId };
  }

  /**
   * A new avatar's draft: the paid descriptor call, then the draft in the
   * library. Checked before anything is spent, in the order the UI expects
   * (the renderer's mock engine): a usable key, a ledger that allows paid
   * calls, an open library, the worst case the user accepted (PRICE_CHANGED)
   * and room in the month, both for the whole new-avatar job. The command's
   * own scope is capped at what it sends (every descriptor attempt at its
   * ceiling); the Budget checks every attempt against it and the global budget.
   */
  async #createDraft(payload: CommandPayload<"avatars.createDraft">): Promise<{ draft: Draft }> {
    const key = this.#usableKey("create an avatar");
    const budget = this.#paidBudget();
    const library = await this.#liveLibrary();
    const models = this.#avatarModels();
    // Captured once, here: a mid-flight settings.setImageAgeCheck must not
    // affect this command's own job, and a mode changed since the estimate
    // the user accepted must PRICE_CHANGED, not silently spend at the new mode.
    const imageAgeCheck = this.#settings.imageAgeCheck;
    const priced = await this.#prices.get(avatarPriceModels(models, "new-avatar", imageAgeCheck));
    const job = avatarJobEstimate(priced, models, "new-avatar", imageAgeCheck);
    Engine.#checkAccepted(job.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, job.worstMicros);

    const jobId = this.#deps.newId();
    const scope: Scope = { avatarJobId: jobId };
    // The scope only ever sends descriptor attempts: its cap is theirs, and it goes when the command ends.
    this.#caps.set(scopeKey(scope), descriptorJobCap(priced, models));
    const client = this.#openRouter(key);
    const linesBefore = budget.ledger.lines.length;
    let result: Awaited<ReturnType<typeof runDescriptorJob>>;
    try {
      result = await runDescriptorJob(
        { chat: (params) => client.chat(params), budget, priceBook: priced.book },
        { jobId, scope, traits: payload.traits, textModel: models.textModel },
      );
    } finally {
      this.#caps.delete(scopeKey(scope));
      if (budget.ledger.lines.length !== linesBefore || budget.ledger.failed) this.#emitMoney();
    }
    if (!result.ok) {
      if (result.error.code === "AUTH_INVALID") this.markKeyRejected(key);
      throw new EngineFailure(result.error);
    }

    const { descriptor } = result;
    const manifest = await library
      .createAvatar({ name: DRAFT_NAME, age: payload.traits.age, traits: manifestTraits(payload.traits), descriptor: descriptor.text })
      .catch(async (error: unknown) => {
        // The descriptor is paid for: keep it where the owner can find it, and say where.
        const kept = `${jobId}:descriptor`;
        const where = await saveRawBody(this.#rawDir, kept, JSON.stringify({ traits: payload.traits, descriptor })).then(
          () => `the paid descriptor is kept in raw/${rawFileName(kept)} next to the ledger`,
          (saveError: unknown) => `the paid descriptor could not be kept either (${messageOf(saveError, "unknown error")})`,
        );
        // Where it is kept comes first, so the 500-char cut of `detail` cannot drop it.
        throw new EngineFailure({ code: "INTERNAL", detail: detailOf(`${where}: the draft could not be written (${messageOf(error, "unknown error")})`) });
      });
    const stored = draftFrom(manifest, []);
    if (stored === null) throw new Error(`the new draft ${manifest.id} does not fit the contract`);
    const draft: Draft = { ...stored, estimate: avatarJobEstimate(priced, models, "next-batch", imageAgeCheck) };
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "draft.changed", payload: { draft } });
    return { draft };
  }

  /**
   * T6c: imports an existing avatar from one photo the owner already has,
   * instead of generating one. Checked before anything is spent, in
   * createDraft's order: a usable key, a ledger that allows paid calls, an
   * open library, the staged photo (NOT_FOUND when it is missing — never
   * staged, already consumed, or replaced by a later stage), the worst case
   * the user accepted (PRICE_CHANGED) and room in the month, all for the
   * whole import job. The staged photo is single-use: consumed the moment
   * those checks pass, so a second click can never reuse it.
   *
   * Then, in one scope, the vision describe job for her typed traits and
   * descriptor — the only paid call. A failure stores nothing; every attempt
   * made is still settled by the client's own settle rule. Owner decision
   * 2026-10-05 (personal-use app): an import makes no age check and asks for
   * no AI-persona confirmation.
   */
  async #importAvatar(payload: CommandPayload<"avatars.importAvatar">): Promise<{ avatar: AvatarSummary }> {
    const key = this.#usableKey("import an avatar");
    const budget = this.#paidBudget();
    const library = await this.#liveLibrary();
    const staged = this.#importStaging;
    if (staged === null || staged.stagingId !== payload.stagingId) {
      throw new EngineFailure({ code: "NOT_FOUND", detail: "no staged photo with this id; pick one again" });
    }
    const models = this.#avatarModels();
    const priced = await this.#prices.get(importPriceModels(models));
    const job = importJobEstimate(priced, models);
    Engine.#checkAccepted(job.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, job.worstMicros);

    // Single-use, consumed now: a failed import below needs a fresh pick, never a silent retry of the same bytes.
    // L1: only clear the slot if it still holds this same staged photo — a
    // concurrent stage that replaced it during the awaits above must survive.
    if (this.#importStaging?.stagingId === staged.stagingId) this.#importStaging = null;

    const importId = this.#deps.newId();
    const scope: Scope = { avatarJobId: importId };
    // The scope only ever sends up to two describe attempts — exactly this job's own worst case.
    this.#caps.set(scopeKey(scope), job.worstMicros);
    const client = this.#openRouter(key);
    const linesBefore = budget.ledger.lines.length;
    let outcome: ImportJobResult;
    try {
      outcome = await runImportJob(
        { chat: (params) => client.chat(params), budget, priceBook: priced.book },
        { jobId: importId, scope, textModel: models.textModel, describeJpeg: staged.describeJpeg },
      );
    } finally {
      this.#caps.delete(scopeKey(scope));
      if (budget.ledger.lines.length !== linesBefore || budget.ledger.failed) this.#emitMoney();
    }
    if (!outcome.ok) {
      if (outcome.authInvalid) this.markKeyRejected(key);
      throw new EngineFailure(outcome.error);
    }
    const { traits, descriptor } = outcome;

    // M3: the manifest (status "active", her master already set), the photo
    // file and its sidecar all publish in ONE rename — no dangling avatar,
    // no half-written manifest, if the write fails or the process is killed
    // partway (Library.createImportedAvatar's own doc comment).
    const written = await library
      .createImportedAvatar({
        name: payload.name,
        age: traits.age,
        traits: manifestTraits(traits),
        descriptor: descriptor.text,
        photoBytes: staged.rawBytes,
        photoMeta: {
          mediaType: staged.mediaType,
          width: staged.width,
          height: staged.height,
          source: { kind: "imported", importedAt: new Date(this.#deps.clock()).toISOString() },
          qa: {},
        },
      })
      .catch(async (error: unknown) => {
        // Paid for: keep it where the owner can find it, and say where.
        const kept = `${importId}:import`;
        const where = await saveRawBody(this.#rawDir, kept, JSON.stringify({ traits, descriptor })).then(
          () => `the paid description is kept in raw/${rawFileName(kept)} next to the ledger`,
          (saveError: unknown) => `the paid description could not be kept either (${messageOf(saveError, "unknown error")})`,
        );
        throw new EngineFailure({ code: "INTERNAL", detail: detailOf(`${where}: the imported avatar could not be written (${messageOf(error, "unknown error")})`) });
      });
    return { avatar: this.#announceAvatar(library, written.avatar.id) };
  }

  /**
   * Another batch of candidate portraits for a draft (the first one too:
   * createDraft buys only the descriptor). Checked before anything is spent,
   * in createDraft's order: a usable key, a ledger that allows paid calls, an
   * open library, a draft whose stored descriptor today's rules still accept
   * (DESCRIPTOR_INVALID otherwise), the worst case the user accepted and room
   * in the month, both for the batch. Then the job is registered under its own
   * scope, capped at the batch's worst case, and runs on after the answer.
   */
  async #generateCandidates(payload: CommandPayload<"avatars.generateCandidates">): Promise<{ jobId: string }> {
    const key = this.#usableKey("generate candidate portraits");
    const budget = this.#paidBudget();
    const library = await this.#liveLibrary();
    const { avatarId } = payload;
    const manifest = library.getAvatar(avatarId);
    if (manifest === undefined || manifest.status !== "draft") throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${avatarId} in the open library` });
    this.#assertDescriptorReadable(manifest);
    const descriptor: AvatarDescriptor = { age: manifest.age, text: manifest.descriptor };
    if (this.#draft(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `the draft ${avatarId} does not fit the contract` });
    // Captured once, here: a mid-flight settings.setImageAgeCheck must not
    // affect this batch, whose reserves and money are fixed at this mode.
    const imageAgeCheck = this.#settings.imageAgeCheck;
    // M8: every candidate needed a downscale for its age check, so a broken
    // or missing ffmpeg would otherwise be discovered only mid-batch — one
    // paid image at a time, all of them thrown away. A tiny built-in image
    // through the exact same path catches that here, for free, before the
    // price fetch, #checkAccepted, the reserve, or any request. Skipped when
    // the check is off: candidateJob.ts never downscales in that mode, so a
    // broken ffmpeg would not affect this batch at all — the preflight would
    // only be a false blocker.
    if (imageAgeCheck === "on") await this.#preflightDownscale();
    const models = this.#avatarModels();
    const priced = await this.#prices.get(avatarPriceModels(models, "next-batch", imageAgeCheck));
    const batch = avatarJobEstimate(priced, models, "next-batch", imageAgeCheck);
    Engine.#checkAccepted(batch.worstMicros, payload.acceptedWorstMicros);
    Engine.#checkMonthlyRoom(budget, batch.worstMicros);

    const jobId = this.#deps.newId();
    const scope: Scope = { avatarJobId: jobId };
    const signal = this.#jobs.startCandidates(jobId, avatarId, CANDIDATES_PER_BATCH);
    // The scope sends exactly the batch's calls: its cap is their worst case, and it goes when the job ends.
    this.#caps.set(scopeKey(scope), batch.worstMicros);
    void this.#runCandidates({
      jobId,
      scope,
      avatarId,
      descriptor,
      key,
      budget,
      library,
      priceBook: priced.book,
      imageModel: models.imageModel,
      concurrency: this.#settings.concurrency.network,
      imageAgeCheck,
      signal,
      done: 0,
    });
    return { jobId };
  }

  /**
   * Runs a registered candidate job to its end and announces it: money.changed,
   * then job.done, job.failed or job.cancelled. Its cap, its draft and the
   * library switch are released first, so a pick sent on job.done is taken.
   * Never rejects.
   */
  async #runCandidates(job: RunningCandidates): Promise<void> {
    let end: CandidatesJobEnd;
    try {
      const client = this.#openRouter(job.key);
      const outcomes = await runCandidateJob(
        {
          generateImage: (params) => client.generateImage(params),
          chat: (params) => client.chat(params),
          budget: job.budget,
          priceBook: job.priceBook,
          downscale: (bytes, signal) => downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal }),
          store: (bytes, meta) => job.library.addPhoto(job.avatarId, bytes, meta),
          errorOf: engineErrorFrom,
          onSlot: (outcome) => this.#candidateSlotDone(job, outcome),
        },
        {
          jobId: job.jobId,
          scope: job.scope,
          imageModel: job.imageModel,
          descriptor: job.descriptor,
          concurrency: job.concurrency,
          imageAgeCheck: job.imageAgeCheck,
          signal: job.signal,
        },
      );
      end = candidateJobEnd(outcomes, job.signal.aborted);
    } catch (error) {
      end = { status: "failed", error: engineErrorFrom(error) };
    }
    this.#caps.delete(scopeKey(job.scope));
    this.#paidCommands--;
    this.#busyAvatars.delete(job.avatarId);
    try {
      this.#emitMoney();
      const state = this.#jobs.finish(job.jobId, end);
      const v = PROTOCOL_VERSION;
      const ref = { kind: "avatar.candidates" as const, jobId: job.jobId, avatarId: job.avatarId };
      if (state?.status === "done" && state.result !== undefined) {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: state.result } });
      } else if (end.status === "failed") {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      } else if (end.status === "cancelled") {
        this.#emit({ v, id: this.#deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
      }
    } catch (error) {
      console.error(`studio engine: the end of job ${job.jobId} could not be announced (${errorKind(error)})`);
    }
  }

  /** A slot that finished: a stored candidate changes the draft; every one moves the progress on. */
  #candidateSlotDone(job: RunningCandidates, outcome: SlotOutcome): void {
    try {
      if (outcome.kind === "failed" && outcome.error.code === "AUTH_INVALID") this.markKeyRejected(job.key);
      if (outcome.kind === "passed") this.#emitDraft(job.library, job.avatarId);
      const progress = this.#jobs.progress(job.jobId, ++job.done);
      if (progress !== null) this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.progress", payload: progress });
    } catch (error) {
      // The slot's money and photo are already recorded; only its announcement failed.
      console.error(`studio engine: a slot of job ${job.jobId} could not be announced (${errorKind(error)})`);
    }
  }

  #emitDraft(library: Library, avatarId: string): void {
    const manifest = library.getAvatar(avatarId);
    const stored = manifest === undefined ? null : draftFrom(manifest, library.photosByAvatar(avatarId));
    if (stored === null) return;
    const draft: Draft = { ...stored, estimate: this.#nextBatchAtKnownPrices() };
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "draft.changed", payload: { draft } });
  }

  /**
   * The user's pick: the draft becomes an active avatar with the candidate as
   * her master and the given name. The other candidates are other people from
   * the same descriptor, so they are deleted before the new manifest commits:
   * they must never become photos or references of her (invariant 9). A
   * manifest that cannot be written is found before any of them is gone; a
   * crash in between leaves a draft with fewer candidates, which can be
   * picked again. Only a candidate that passed the age check can be picked;
   * refused while a job runs for the draft.
   */
  async #pick(payload: CommandPayload<"avatars.pick">): Promise<{ avatar: AvatarSummary }> {
    const { avatarId, photoId } = payload;
    // Claimed before the (now async) #liveLibrary() re-verification below, so
    // this still marks the avatar busy synchronously, before this method's
    // first await — library.confirm's own race check relies on that.
    this.#claimAvatar(avatarId, "a batch of candidates is being made for this draft; pick when it ends");
    try {
      const library = await this.#liveLibrary();
      const manifest = library.getAvatar(avatarId);
      if (manifest === undefined || manifest.status !== "draft") throw new EngineFailure({ code: "NOT_FOUND", detail: `no draft ${avatarId} in the open library` });
      this.#assertDescriptorReadable(manifest);
      if (this.#draft(avatarId) === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `the draft ${avatarId} does not fit the contract` });
      const photo = library.getPhoto(photoId);
      if (photo === undefined || photo.avatarId !== avatarId) {
        throw new EngineFailure({ code: "NOT_FOUND", detail: `draft ${avatarId} has no candidate ${photoId}` });
      }
      // The stored verdict is only the answer its own age check gave;
      // today's threshold (passesAgeThreshold, ageCheck.ts) is re-applied
      // here, against the threshold in force right now — not the one that
      // may have been in force when the candidate was checked. A later
      // calibration can only raise it, never lower an already-picked
      // master's standing, so an older candidate cannot become a master on
      // the strength of a threshold that no longer holds. draftFrom
      // (records.ts) already keeps such a candidate off the list the UI
      // shows, so this is never a "the UI showed something pick refuses":
      // it just has to say the same thing again, honestly.
      if (!passesAgeThreshold(photo.qa.age)) {
        throw new EngineFailure({ code: "NOT_FOUND", detail: `candidate ${photoId} no longer passes today's age-check threshold` });
      }
      // The new manifest is written (not yet committed) before the other candidates go; see Library.promoteDraft.
      await library.promoteDraft(avatarId, { masterPhotoId: photo.id, name: payload.name.trim() });
      return { avatar: this.#announceAvatar(library, avatarId) };
    } finally {
      this.#busyAvatars.delete(avatarId);
    }
  }

  /** A saved avatar archived; one already archived is answered as it is. Refused while a job runs for it. */
  async #archive(payload: CommandPayload<"avatars.archive">): Promise<{ avatar: AvatarSummary }> {
    const { avatarId } = payload;
    // Claimed before the (now async) #liveLibrary() re-verification below, so
    // this still marks the avatar busy synchronously, before this method's
    // first await — library.confirm's own race check relies on that.
    this.#claimAvatar(avatarId, "a job is changing this avatar; archive it when the job ends");
    try {
      const library = await this.#liveLibrary();
      const manifest = library.getAvatar(avatarId);
      if (manifest === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no saved avatar ${avatarId} in the open library` });
      if (manifest.status !== "draft") this.#assertDescriptorReadable(manifest);
      const current = avatarSummaryFrom(manifest, avatarCounts(library, avatarId));
      if (current === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no saved avatar ${avatarId} in the open library` });
      if (current.status === "archived") return { avatar: current };
      await library.updateAvatar(avatarId, { status: "archived" });
      return { avatar: this.#announceAvatar(library, avatarId) };
    } finally {
      this.#busyAvatars.delete(avatarId);
    }
  }

  /** The saved avatar as the grid lists it, announced with avatar.changed. */
  #announceAvatar(library: Library, avatarId: string): AvatarSummary {
    const manifest = library.getAvatar(avatarId);
    const avatar = manifest === undefined ? null : avatarSummaryFrom(manifest, avatarCounts(library, avatarId));
    if (avatar === null) throw new Error(`the saved avatar ${avatarId} does not fit the contract`);
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "avatar.changed", payload: { avatar } });
    return avatar;
  }

  /**
   * `#announceAvatar`, but never throws: a write that already committed must
   * not turn into INTERNAL over its own announcement. A failure here is
   * logged (never by the record's content) and the caller answers ok
   * regardless — the write stands; only the live announce was missed, and
   * the next snapshot or avatars.list still shows the true state.
   */
  #announceAvatarOrLog(library: Library, avatarId: string): void {
    try {
      this.#announceAvatar(library, avatarId);
    } catch (error) {
      console.error(`studio engine: avatar ${avatarId} was written but could not be announced (${errorKind(error)})`);
    }
  }

  /** Marks an avatar as being changed; IN_FLIGHT when a job or command already is. */
  #claimAvatar(avatarId: string, detail: string): void {
    if (this.#busyAvatars.has(avatarId)) throw new EngineFailure({ code: "IN_FLIGHT", detail });
    this.#busyAvatars.add(avatarId);
  }

  /**
   * The live library, for a command that stores into it. Every write path
   * (createDraft, generateCandidates, pick, archive) reaches the library
   * only through here, so gating this one place is enough to refuse all of
   * them with IN_FLIGHT while a folder survey (`#switching`) could still
   * replace the instance they would write into.
   *
   * keepLive (`#applySettings`) deliberately keeps `#live` set even when its
   * folder cannot be identified right now, or is gone outright (ENOENT,
   * ENOTDIR) — a momentary hiccup during an unrelated settings.update must
   * not drop the library out from under a read. That leniency does not
   * belong here: before a write actually reaches the library, the live
   * folder is re-verified two ways — its identity (`folderIdentity`, one
   * stat and one realpath) against the identity it had when it was opened,
   * AND its own library.json `createdAt` against `live.library.createdAt`
   * (`Library.createdAt`'s own comment explains why identity alone is not
   * enough: canonical path plus dev:ino cannot tell a deleted-and-recreated
   * folder from the original on Linux, where a just-freed inode is
   * routinely reused for the very next directory created). A folder that
   * fails either check refuses LIBRARY_UNAVAILABLE and writes nothing,
   * rather than let a write (in slice 2b, a paid one, ~20x more expensive)
   * go through a stale instance or fail midway with a raw ENOENT.
   */
  async #liveLibrary(): Promise<Library> {
    if (this.#switching > 0) {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: "a library switch is being surveyed; write commands wait for it to finish" });
    }
    const live = this.#live;
    if (live === null) {
      throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    }
    // live.library.root, not #settings.libraryPath (review LOW 9): the two
    // can differ after an alias is confirmed (library.open's adopt-as-is
    // path keeps #live on the real instance while #settings.libraryPath
    // keeps the alias spelling main saved) — the Library instance itself
    // only ever reads and writes through its own .root, so that is what
    // must still be there. Bounded (review LOW 15): a hung stat/realpath/
    // read (a stalled network volume) must not hold this claim, and
    // #paidCommands with it, forever — a timeout here is read the same as
    // "cannot be confirmed right now", exactly like folderIdentity's own null.
    //
    // strict: true — a conservative choice for this specific, money-critical
    // re-check: folderIdentity's own resolve() fallback for a realpath that
    // cannot be trusted right now is right for library.open's survey and
    // keepLive (#applySettings) — both are read paths where guessing "same"
    // is cheap to undo — but there is no reason to accept that same guess
    // right before a write actually spends or writes, so this call insists
    // on a realpath that actually resolved. It is not, on its own, what
    // catches a deleted-and-recreated folder on Linux (a coincidentally
    // reused inode makes both stat AND realpath agree, strict or not) —
    // the library.json fingerprint below is what catches that.
    // timeoutSignal(), not AbortSignal.timeout(): the latter's own timer is
    // unref'd, which hung the Windows CI runs once M6 moved these tests onto
    // Bun's native AbortController/AbortSignal (timeoutSignal.ts's own doc
    // comment has the full story). Cleared in the finally below, whichever
    // way the check ends.
    const timeout = timeoutSignal(this.#liveLibraryIdentityTimeoutMs);
    let verified: boolean;
    try {
      verified = await untilAborted(
        folderIdentity(live.library.root, this.#folderFs, { strict: true }).then(
          async (identity) => identity === live.identity && (await this.#sameLibraryFile(live.library)),
        ),
        timeout.signal,
      ).catch(() => false);
    } finally {
      timeout.clear();
    }
    if (!verified) {
      // Review LOW 10: a transient stat, realpath or read failure (a
      // momentary network-volume hiccup) now reads the same as "gone",
      // deterministically (strict mode above no longer sometimes forgives a
      // realpath failure via resolve()) — worded so that is not read as
      // "this folder is gone, go pick another one".
      throw new EngineFailure({
        code: "LIBRARY_UNAVAILABLE",
        detail: "the live library's folder could not be confirmed just now (it may have moved, or this may be transient); try again, or choose one in Settings",
      });
    }
    return live.library;
  }

  /**
   * Whether `library`'s root still holds ITS library.json (review, real
   * bug: canary run 36272376999) — read fresh, never cached: a folder
   * deleted and recreated at the exact same path can share the original's
   * canonical path AND dev:ino on Linux (folderIdentity, however strict,
   * cannot tell them apart — a freed inode is routinely reused for the very
   * next directory created), but the recreated folder has no library.json
   * of its own at all, and an unrelated library's has a different
   * `createdAt`. One small read, the library's own schema (never changed
   * for this): false for anything else — unreadable, invalid JSON, a
   * mismatched schema, or a `createdAt` that does not match.
   */
  async #sameLibraryFile(library: Library): Promise<boolean> {
    let raw: unknown;
    try {
      const text = await readFile(join(library.root, LIBRARY_FILE), "utf8");
      raw = JSON.parse(text);
    } catch {
      return false;
    }
    const parsed = LibraryFileSchema.safeParse(raw);
    return parsed.success && parsed.data.createdAt === library.createdAt;
  }

  /**
   * M8: a cheap, free check that the image pipeline (ffmpeg) can actually
   * prepare an image for the age check, before anything is bought. Bounded
   * by `#preflightTimeoutMs` even when `#preflight` itself ignores its
   * signal (a hung native process, or a test double that does not bother):
   * `untilAborted` is what settles this call, not `#preflight`'s own
   * cooperation — a review fix (HIGH): an unbounded preflight used to hang
   * `generateCandidates` forever, leaving the paid-commands counter and the
   * draft's busy claim up until an engine restart.
   */
  async #preflightDownscale(): Promise<void> {
    // timeoutSignal(), not AbortSignal.timeout(): the latter's own timer is
    // unref'd, which hung this exact preflight on Windows CI once M6 moved
    // these tests onto Bun's native AbortController/AbortSignal
    // (timeoutSignal.ts's own doc comment has the full story).
    const timeout = timeoutSignal(this.#preflightTimeoutMs);
    try {
      await untilAborted(this.#preflight(timeout.signal), timeout.signal);
    } catch (error) {
      throw new EngineFailure({ code: "INTERNAL", detail: `the image pipeline (ffmpeg) cannot prepare images for the age check: ${messageOf(error, "unknown error")}` });
    } finally {
      timeout.clear();
    }
  }

  /**
   * T6c review round 2, M4: bounds the import's one downscale (the describe
   * call's own size) at #importDownscaleTimeoutMs.
   * timeoutSignal(), not AbortSignal.timeout() — the same reason as
   * #preflightDownscale's own doc comment just above. untilAborted is what
   * settles this call even if the injected downscaler ignores its own
   * signal, exactly like #preflightDownscale's own #preflight.
   */
  async #boundedImportDownscale(bytes: Uint8Array, maxSide: number): Promise<Uint8Array> {
    const timeout = timeoutSignal(this.#importDownscaleTimeoutMs);
    try {
      return await untilAborted(this.#downscaleImportPhoto(bytes, maxSide, timeout.signal), timeout.signal);
    } finally {
      timeout.clear();
    }
  }

  /**
   * PRICE_CHANGED when the worst case now is above the one the user accepted
   * (T0's own contract, errors.ts, commands.ts's `AcceptedWorst`) — never on a
   * drop. A drop is routine (a fresh price load, the fallback table's 60 s
   * TTL, or settings.setImageAgeCheck turned OFF since the estimate): the
   * command then spends less than the user agreed to and simply follows
   * whatever is cheaper right now, same as the mock (mockEngine.ts's
   * `priceGate`) already did. A toggle turned ON since the estimate still
   * raises the worst case, so that direction is still caught below.
   */
  static #checkAccepted(worstMicros: number, acceptedWorstMicros: number): void {
    if (worstMicros > acceptedWorstMicros) {
      throw new EngineFailure({ code: "PRICE_CHANGED", detail: `the worst case is now ${worstMicros} µ$, above the accepted ${acceptedWorstMicros} µ$` });
    }
  }

  /** BUDGET_EXCEEDED when the month has no room for the job's worst case on top of what is spent, reserved and held by running jobs. */
  static #checkMonthlyRoom(budget: Budget, worstMicros: number): void {
    const month = budget.status();
    const committed = month.spentThisMonthMicros + month.openReserveMicros + month.heldMicros;
    if (committed + worstMicros > month.monthlyBudgetMicros) {
      const detail = `committed ${committed} µ$ + this job's worst case ${worstMicros} µ$ > the monthly budget ${month.monthlyBudgetMicros} µ$`;
      throw new EngineFailure({ code: "BUDGET_EXCEEDED", detail });
    }
  }

  /** The key for a paid or keyed call: stored, and not rejected by OpenRouter. */
  #usableKey(purpose: string): string {
    const key = this.#apiKey;
    if (key === null) throw new EngineFailure({ code: "AUTH_INVALID", detail: `no OpenRouter API key is stored; add one in Settings to ${purpose}` });
    if (this.#keyRejected) throw new EngineFailure({ code: "AUTH_INVALID", detail: `OpenRouter rejected the stored API key (401); store a new key to ${purpose}` });
    return key;
  }

  /** The Budget, when the ledger allows paid calls now: readable, not halted, nothing to reconcile. */
  #paidBudget(): Budget {
    const money = this.#money;
    if (!money.ok) throw new EngineFailure({ code: money.unavailable.cause, detail: money.unavailable.detail });
    const status = money.budget.status();
    const halt = Engine.#haltOf(money.budget, status);
    if (halt !== null) throw new EngineFailure({ code: halt.cause, detail: halt.detail });
    if (status.state === "reconcile-required") {
      throw new EngineFailure({ code: "RECONCILE_REQUIRED", detail: `${status.openAttempts} open attempt(s)${status.torn ? ", torn ledger line" : ""}; reconcile before any paid call` });
    }
    return money.budget;
  }

  #musicKeyStatus(): MusicKeyStatus {
    const key = this.#musicKey;
    return { stored: key !== null, last4: key === null ? null : key.slice(-4), rejected: key !== null && this.#musicKeyRejected };
  }

  #apiKeyStatus(): ApiKeyStatus {
    const key = this.#apiKey;
    return {
      stored: key !== null,
      last4: key === null ? null : key.slice(-4),
      encryptionAvailable: this.#encryptionAvailable,
      rejected: key !== null && this.#keyRejected,
    };
  }

  /**
   * Main persisted new settings: they are made current and a new monthly
   * budget goes to the Budget — every field but `libraryPath`, applied
   * immediately (before any await), so they still land even when the switch
   * below is refused or superseded. The library follows the saved folder:
   * when it is not the live library's folder (or there is none), the engine
   * takes the one staged by `library.open` (by the exact path string) or,
   * failing that, opens it now — so a folder picked again after it was
   * missing at start is taken too, and a volume remounted under the same
   * path (a new folder identity) is surveyed fresh. Staged folders that no
   * update confirmed are dropped: main gave up on them.
   *
   * `libraryPath` itself is committed together with `#live`, only at the very
   * end, once every await below is done: until then `#settings.libraryPath`
   * (so `settings.get` and the snapshot) keeps naming the folder `#live`
   * actually is, never a folder its avatar and draft lists do not match yet.
   *
   * A genuine switch surveys the folder before committing (`#openOrNull`, or
   * a staged instance reused as-is): while that survey runs, `#switching` is
   * set, so `#liveLibrary()` refuses new paid work, pick and archive with
   * IN_FLIGHT — the very thing that used to be able to write through the
   * library instance this call is about to replace. The switch is still
   * refused with IN_FLIGHT when the engine was already busy before the
   * survey, or became busy during it in a way `#switching` cannot see (a
   * reserve made straight against the Budget, bypassing `#liveLibrary()`):
   * `libraryPath` then simply never advances, which is its own rollback, and
   * a freshly opened library is dropped rather than adopted. A later call to
   * this method that started after this one (two `settings.update`s racing;
   * `#pendingLibraryPath` set at the top of each tracks whichever started
   * last) also wins outright: this call's result — a switch or a
   * same-folder no-op — is discarded rather than half-applied on top of the
   * later call's. `library.confirm` never calls this method at all (it is
   * fully synchronous, staged-only), so it cannot be superseded this way.
   *
   * Returns an error when the switch (or the no-op commit) was not applied,
   * for any reason above, or null when everything applied, including any
   * switch.
   */
  async #applySettings(next: EngineSettings): Promise<EngineError | null> {
    const previous = this.#settings;
    // The settings main sends after an ok `export.choose` end the wait: from here the export folder is the one they name.
    this.#exportSwitchUntil = null;
    this.#pendingLibraryPath = next.libraryPath;
    this.#settings = { ...next, libraryPath: previous.libraryPath };
    // A larger render pool takes waiting jobs now, not when one happens to finish.
    this.#renders.poke();
    const staged = this.#staged;
    this.#staged = new Map();
    // Before any await, like every field but the library: a run's next request already waits on the new ceiling.
    if (next.concurrency.network !== previous.concurrency.network) this.#networkPool.setMax(next.concurrency.network);
    if (this.#money.ok && next.monthlyBudgetMicros !== previous.monthlyBudgetMicros) {
      await this.#money.budget.setMonthlyBudget(next.monthlyBudgetMicros);
    }
    const identity = await folderIdentity(next.libraryPath, this.#folderFs);
    // Nothing asked to move away from the folder already live (this update
    // names the same path as before): a folder that cannot be identified
    // right now is then a transient hiccup (a volume briefly unreadable), not
    // a request to drop the library. Keep it, rather than flipping to
    // LIBRARY_UNAVAILABLE and losing it over a momentary stat() failure.
    const keepLive = identity === null && this.#live !== null && next.libraryPath === previous.libraryPath;
    const sameLibrary = keepLive || (identity !== null && identity === this.#live?.identity);
    let refusal: EngineError | null = null;
    let live = this.#live;
    let switched = false;
    if (!sameLibrary) {
      if (this.#busy()) {
        refusal = this.#inFlightRefusal();
      } else {
        // #switching blocks new paid work, pick and archive (#liveLibrary())
        // for the whole survey below, not only the busy check just made:
        // #busy() alone cannot see work that starts during the await.
        this.#switching++;
        try {
          const kept = identity === null ? undefined : staged.get(next.libraryPath);
          const opened =
            kept !== undefined && identity !== null
              ? { library: kept.library, identity, unreadable: kept.unreadable }
              : await this.#openOrNull(next.libraryPath);
          // Re-checked: a reserve made straight against the Budget (e.g. a
          // job attempt already past its own #liveLibrary() call when the
          // survey started) is not stopped by #switching; #busy() still
          // catches it. The freshly opened library is dropped, not adopted.
          if (this.#busy()) {
            refusal = this.#inFlightRefusal();
          } else {
            live = opened;
            switched = true;
          }
        } finally {
          this.#switching--;
        }
      }
    }
    // A later call named another folder while this one awaited: that call's
    // result stands, whole; this one's is dropped, not layered on top of it.
    if (refusal === null && this.#pendingLibraryPath !== next.libraryPath) {
      refusal = { code: "INTERNAL", detail: "a later settings update named another library folder before this one could switch" };
    } else if (refusal === null) {
      if (switched) {
        // Every open window must resync on a genuine switch, folder-to-folder
        // or into/out of LIBRARY_UNAVAILABLE; a race that changes nothing
        // (kept the same folder after all) must not bump it.
        const beforeIdentity = this.#live?.identity ?? null;
        if ((live?.identity ?? null) !== beforeIdentity) this.#librarySwitchGeneration++;
        // L5: only once a DIFFERENT library is actually live — not on a
        // switch into LIBRARY_UNAVAILABLE, which never adopts anything and
        // must not spend a staged photo's one chance on a transient outage.
        if (live !== null) this.#importStaging = null;
        this.#live = live;
        // A different library is live: settle its crash windows in the background (never awaited here).
        if (live !== null && live.identity !== beforeIdentity) {
          this.#videos.libraryOpened(live.library);
          this.#sweepMediaStaging(live.library);
        }
      }
      this.#settings = { ...this.#settings, libraryPath: next.libraryPath };
    }
    if (previous.imageAgeCheck !== this.#settings.imageAgeCheck) this.#rebroadcastDraftEstimates();
    // The export folder or the library it must stay out of may have changed.
    await this.#refreshExportStatus();
    this.#emitSettings();
    return refusal;
  }

  /**
   * Opens the library at `path`, sharing an open of the same folder already
   * in progress. The folder is identified before it is touched: one that
   * cannot be identified is refused, never surveyed and then thrown away.
   * Never creates the folder.
   */
  async #open(path: string, knownIdentity: string | null): Promise<OpenedLibrary> {
    const identity = knownIdentity ?? (await folderIdentity(path, this.#folderFs));
    if (identity === null) throw new Error(`${path} is not a folder the engine can read`);
    const pending = this.#opening.get(identity);
    if (pending !== undefined) {
      const opened = await pending;
      return { library: opened.library, identity, unreadable: opened.unreadable };
    }
    const reservedPhotos = this.#deps.reservedPhotos ?? ((avatarId: string) => this.#renders.reservedPhotos(avatarId));
    const opening = openLibrary(path, { reservedPhotos }).then((opened) => {
      // Fail-closed records and logs: said once per open, by avatar, relative file and reason class only (no absolute path, no content).
      for (const line of logIssueLines(opened.report.logIssues)) console.warn(line);
      return { library: opened.library, unreadable: unreadableFromQuarantine(opened.report.quarantined) };
    });
    this.#opening.set(identity, opening);
    try {
      const opened = await opening;
      return { library: opened.library, identity, unreadable: opened.unreadable };
    } finally {
      if (this.#opening.get(identity) === opening) this.#opening.delete(identity);
    }
  }

  /** `#open`, or null (and a log line) when the folder cannot hold a library now. */
  async #openOrNull(path: string): Promise<OpenedLibrary | null> {
    try {
      return await this.#open(path, null);
    } catch (error) {
      console.warn(`studio engine: the library could not be opened (${messageOf(error, "unknown error")})`);
      return null;
    }
  }

  #currentSettings(): Settings {
    return { apiKey: this.#apiKeyStatus(), musicKey: this.#musicKeyStatus(), ...this.#settings };
  }

  #moneyStatus(): MoneyStatus {
    const month = new Date(this.#deps.clock()).toISOString().slice(0, 7);
    const money = this.#money;
    if (!money.ok) {
      return {
        ledger: "unavailable",
        month,
        monthlyBudgetMicros: this.#settings.monthlyBudgetMicros,
        reconcileNeeded: false,
        reconcileReasons: [],
        halt: money.unavailable,
      };
    }
    const { budget } = money;
    const status = budget.status();
    const reasons: ReconcileReason[] = [];
    // Open reserves other than this process's in-flight ones were left by a
    // crash, an abort or a timeout: they wait for a user reconcile.
    if (status.openAttempts - budget.inFlightCount() > 0) reasons.push("open-reserves");
    if (status.torn) reasons.push("torn-ledger-line");
    return {
      ledger: "open",
      month,
      spentMicros: status.spentThisMonthMicros,
      monthlyBudgetMicros: status.monthlyBudgetMicros,
      unsettledMicros: status.openReserveMicros,
      unsettledCount: status.openAttempts,
      reconcileNeeded: reasons.length > 0,
      reconcileReasons: reasons,
      halt: Engine.#haltOf(budget, status),
    };
  }

  static #haltOf(budget: Budget, status: BudgetStatus): MoneyHalt | null {
    switch (status.haltCause) {
      case null:
        return null;
      case "SETTLE_ABOVE_WORST":
        return {
          cause: "SETTLE_ABOVE_WORST",
          detail: "billed above the reserved worst case, so the price table is wrong; a reconcile acknowledges it",
          attemptIds: budget.aboveWorstAttempts(),
        };
      case "LEDGER_WRITE_FAILED":
        return { cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed, so nothing more is written; restart the app" };
    }
  }

  /**
   * The user's reconcile (T2) against `/credits` (T3). Needs a key OpenRouter
   * has not rejected; a 401 marks it rejected. Emits `money.changed` whenever
   * the ledger may have changed.
   */
  async #reconcile(): Promise<ReconcileResult> {
    const money = this.#money;
    // The cause is its own error code: LEDGER_CORRUPT or LEDGER_UNREADABLE.
    if (!money.ok) throw new EngineFailure({ code: money.unavailable.cause, detail: money.unavailable.detail });
    const key = this.#usableKey("reconcile");
    // A paid job between its requests has none in flight, but its next reserve would land in the window being reconciled.
    if (this.#paidCommands > 0) {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: `${this.#paidCommands} paid job(s) of this engine are running; reconcile when they end` });
    }
    let result: LedgerReconcileResult;
    try {
      const client = this.#openRouter(key);
      result = await money.budget.reconcile({ fetchCredits: () => client.fetchCredits() });
    } catch (error) {
      // /credits failed before anything was written.
      if (error instanceof OpenRouterError) {
        if (error.code === "AUTH_INVALID") this.markKeyRejected(key);
        throw new EngineFailure(fromOpenRouterError(error));
      }
      // Anything else may have happened between ledger writes: announce what the ledger says now.
      this.#emitMoney();
      if (money.budget.ledger.failed) throw new EngineFailure({ code: "LEDGER_WRITE_FAILED", detail: messageOf(error, "a ledger write failed") });
      throw error;
    }
    // IN_FLIGHT is the contract's error, not a result: this engine's own paid requests are still out.
    if (!result.ok && result.reason === "IN_FLIGHT") {
      throw new EngineFailure({ code: "IN_FLIGHT", detail: `${result.inFlight} paid request(s) of this engine are still in flight; reconcile when they end` });
    }
    const answer = reconcileResultOf(result);
    if (answer.status === "done") this.#emitMoney();
    return answer;
  }

  /** A client for the current key and base URL; the key goes to OpenRouter only. `fetch` wraps the engine's own (a run's reports every status to the network pool). */
  #openRouter(key: string, fetch: OpenRouterFetch = this.#deps.fetch): OpenRouterClient {
    return createOpenRouterClient({
      apiKey: key,
      baseUrl: this.#openRouterBaseUrl,
      allowBaseUrlOverride: STUDIO_E2E,
      fetch,
      // Only a paid 2xx that cannot be used is saved, already redacted: in
      // userData next to the ledger, so the evidence outlives a library move.
      saveRaw: (attemptId, text, keepBytes) => saveRawBody(this.#rawDir, attemptId, text, { keepBytes }),
      clock: this.#deps.clock,
      monotonic: this.#deps.monotonic,
    });
  }

  /** At most one `engine.notice` per this long for swallowed rejections; the pending notice's count still moves on every one. */
  static readonly #INTERNAL_NOTICE_WINDOW_MS = 5_000;
  #internalNoticeEmittedAt: number | null = null;
  #internalNoticeEmittedId: string | null = null;
  /** The trailing edge of a window in which notices were held back: one timer, so the windows end up seeing the real count. */
  #internalNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `shutdown()`: a rejection that arrives after it is still counted, but no trailing announcement is armed for a stopping engine. */
  #stopping = false;

  /**
   * A promise rejection nobody handled was logged and swallowed (processGuards.ts) and the engine goes on: the windows are told,
   * with a code and a count only (a notice never carries the error's text). One pending notice of this code, replaced and counted
   * like main's; a burst emits one event per window so it cannot flood the event log, and the last one of a burst is announced
   * when the window ends (one unref'd timer), so what the windows show is the real count, not the count at the burst's start.
   *
   * These notices are NOT part of main's `HostNotices` and so do not survive an engine restart: a restart is itself announced
   * (`engine-restarted`), and the swallowed rejections belonged to the engine that is gone.
   */
  noteUnhandledRejection(): void {
    const earlier = this.#notices.findIndex((n) => n.code === "engine-internal-error");
    const notice: EngineNotice = {
      noticeId: this.#deps.newId(),
      code: "engine-internal-error",
      at: new Date(this.#deps.clock()).toISOString(),
      count: (earlier === -1 ? 0 : (this.#notices[earlier]?.count ?? 0)) + 1,
    };
    if (earlier === -1) this.#notices.push(notice);
    else this.#notices[earlier] = notice;
    const window = this.#deps.internalNoticeWindowMs ?? Engine.#INTERNAL_NOTICE_WINDOW_MS;
    const now = this.#deps.monotonic();
    if (this.#internalNoticeEmittedAt !== null && now - this.#internalNoticeEmittedAt < window) {
      if (this.#internalNoticeTimer === null && !this.#stopping) {
        this.#internalNoticeTimer = setTimeout(() => {
          this.#internalNoticeTimer = null;
          const pending = this.#notices.find((n) => n.code === "engine-internal-error");
          if (pending === undefined || pending.noticeId === this.#internalNoticeEmittedId) return; // already announced by a later call
          this.#internalNoticeEmittedId = pending.noticeId;
          this.#internalNoticeEmittedAt = this.#deps.monotonic();
          try {
            this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "engine.notice", payload: { notice: pending } });
          } catch (error) {
            // A timer callback has no caller to throw to: an exception here would end the engine for a notice. The pending notice stays in the snapshot.
            console.error(`studio engine: the trailing engine-internal-error notice could not be announced (${errorKind(error)})`);
          }
        }, Math.max(0, window - (now - this.#internalNoticeEmittedAt)));
        this.#internalNoticeTimer.unref();
      }
      return;
    }
    this.#internalNoticeEmittedAt = now;
    this.#internalNoticeEmittedId = notice.noticeId;
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "engine.notice", payload: { notice } });
  }

  #addNotice(notice: EngineNotice): void {
    if (this.#notices.some((n) => n.noticeId === notice.noticeId)) return;
    this.#notices.push(notice);
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "engine.notice", payload: { notice } });
  }

  #emitSettings(): void {
    this.#emit({
      v: PROTOCOL_VERSION,
      id: this.#deps.newId(),
      kind: "event",
      type: "settings.changed",
      payload: { settings: this.#currentSettings(), librarySwitchGeneration: this.#librarySwitchGeneration },
    });
  }

  #emitMoney(): void {
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "money.changed", payload: { status: this.#moneyStatus() } });
  }

  /** Stamps an event with the next seq and this engine's bootId and sends it to main. */
  #emit(event: UnsequencedEvent): void {
    const seq = this.#events.append(event);
    const stamped = this.#events.since(seq - 1, this.#events.bootId);
    if (!stamped.gap) for (const e of stamped.events) this.#deps.post(e);
  }
}
