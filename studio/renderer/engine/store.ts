import {
  ENGINE_GONE_DETAIL,
  type ApiKeyStatus,
  type AvatarSummary,
  type Draft,
  type EngineError,
  type EngineNotice,
  type EventMessage,
  type ExportStatus,
  type JobResult,
  type JobState,
  type MoneyStatus,
  type MusicKeyStatus,
  type MusicStatus,
  type Settings,
  type Snapshot,
  type UnreadableAvatar,
} from "../../shared/engine";
import type { EngineClient } from "./client";
import {
  applyCancelAsks,
  applyImportCancelled,
  applyImportDone,
  applyImportFailed,
  applyImportProgress,
  failActiveImports,
  importsFromSnapshot,
  type ImportView,
  isActiveImport,
  markImportCancelling,
  unmarkImportCancelling,
} from "./importJobs";
import { applyVideoChanged, nextRenderBatch } from "./renderJobs";

export type JobStatus = JobState["status"];

/**
 * A job as the UI sees it. Whose job it is — kind, avatar and, for a run, the
 * runId — is known from the first thing this window ever hears of it: a
 * snapshot's `JobState`, any job event (each carries all three), or the
 * command reply that started it. Nothing is guessed.
 */
export interface JobView {
  readonly jobId: string;
  /** An own-media import (3f.1b) is not an avatar's job: the store keeps it out of this list, in `EngineView.imports` (3f.6). */
  readonly kind: Exclude<JobState["kind"], "import">;
  readonly avatarId: string;
  /** A run job's own run; null exactly for a candidates job. */
  readonly runId: string | null;
  /**
   * The montage draft a render job came from: the drafts screen's «Рендер 42 %» and the editor's button find it by
   * this. Null for every other kind, for a headless render, and for a render this window first heard of at its
   * `job.done` (the result names no draft).
   */
  readonly montageId: string | null;
  /** The video a render job makes (every `job.*` event of a render names it); null for every other kind. */
  readonly videoId: string | null;
  readonly status: JobStatus;
  /**
   * A render past the point of no return (the commit has claimed the video's name): a cancel is ignored from here and
   * the job ends `done` (or `failed` if saving then fails). False for every other kind and before that point.
   */
  readonly saving: boolean;
  readonly done: number;
  readonly total: number;
  readonly result: JobResult | null;
  readonly error: EngineError | null;
}

export type SyncPhase = "connecting" | "ready" | "offline";

/** What a confirmed music command came to: done (the store shows the status it answered), or the engine's refusal. */
export type MusicCommandReply = { ok: true } | { ok: false; error: EngineError };

export interface EngineView {
  readonly phase: SyncPhase;
  /** Why the last snapshot request failed (phase `offline`). */
  readonly failure: EngineError | null;
  readonly bootId: string | null;
  readonly lastSeq: number;
  readonly settings: Settings | null;
  readonly money: MoneyStatus | null;
  /** The export folder's status: from the snapshot, then `export.status`; null before the first snapshot. */
  readonly exportStatus: ExportStatus | null;
  /**
   * The music list and the flashapi quota (3c.6, K24): null until a screen asks for it (`refreshMusic`; the snapshot does
   * not carry it), then moved by `music.changed` and by the answers of the confirmed music commands.
   */
  readonly music: MusicStatus | null;
  readonly avatars: readonly AvatarSummary[];
  readonly drafts: readonly Draft[];
  /** Avatar records the engine could not read into the lists (from the snapshot and avatars.list); UI shows their count via `.length`. */
  readonly unreadableAvatars: readonly UnreadableAvatar[];
  /** How many there really are; can exceed `unreadableAvatars.length` when the list was cut at its bound (L1). */
  readonly unreadableTotal: number;
  readonly jobs: readonly JobView[];
  /**
   * The own-media imports (3f.6, the «Мои» tab's tiles and status card), in the order this window first heard of them: from the snapshot,
   * then the `job.*` events of kind `import` (importJobs.ts). The finished ones stay (the newest few) until the owner dismisses them.
   */
  readonly imports: readonly ImportView[];
  /**
   * The renders the sidebar's «Рендер a / b» counts: those submitted since the queue was last empty (AM4). Empty while no render is
   * queued or running. Kept by `update()` from the jobs (`nextRenderBatch`).
   */
  readonly renderBatch: ReadonlySet<string>;
  /** The last `engine.error` event, e.g. a SETTLE_ABOVE_WORST halt. Cleared by a fresh snapshot. */
  readonly engineError: EngineError | null;
  /** The engine's pending notices (a restart, a settings reset), oldest first: from the snapshot, then `engine.notice`. */
  readonly notices: readonly EngineNotice[];
  /**
   * jobIds this window asked to cancel but has no real end for yet
   * (optimistic cancel, M-optimistic-cancel): the engine's own `avatars.cancel`
   * answers before the job actually ends (engine.ts's #runCandidates settles
   * later), so accepting the command must not by itself call the job
   * cancelled. Always a subset of the active jobs — `update()` prunes it to
   * that on every change, so a real end (an event, a fresh snapshot that no
   * longer lists the job as active, a restart, or M5's dead-engine failure)
   * clears it for free, without each of those needing to know this set exists.
   */
  readonly cancellingJobs: ReadonlySet<string>;
  /**
   * avatarIds with a paid runs.start or runs.resume in flight (T8b's L5,
   * moved here from AvatarPhotos's own component state for LOW-3): a
   * component-local flag is lost on every remount, so a screen left mid-send
   * and come back to (or reopened by the sidebar) could send a second paid
   * command the first one's own lock was supposed to prevent. Window-wide
   * like every other in-flight tracking here, and keyed by avatarId (not a
   * single flag) since a paid command is always scoped to one avatar.
   */
  readonly paidInFlightAvatars: ReadonlySet<string>;
  /**
   * What the owner is told after an avatar was deleted («Удалить аватар»): window-wide, so a notice about video files that stayed behind is still there
   * when the Avatars screen is left and opened again, until the owner dismisses it. Null when there is nothing to say.
   */
  readonly avatarDeleteNotice: AvatarDeleteNotice | null;
}

/** What is said once an avatar is gone: its name (a draft has none), how many video files stayed behind or were not checked, and the export subfolder they are in. */
export interface AvatarDeleteNotice {
  readonly draft: boolean;
  readonly name: string;
  readonly kept: number;
  readonly unchecked: number;
  readonly folder: string | null;
}

const INITIAL: EngineView = {
  phase: "connecting",
  failure: null,
  bootId: null,
  lastSeq: 0,
  settings: null,
  money: null,
  exportStatus: null,
  music: null,
  avatars: [],
  drafts: [],
  unreadableAvatars: [],
  unreadableTotal: 0,
  jobs: [],
  imports: [],
  renderBatch: new Set(),
  engineError: null,
  notices: [],
  cancellingJobs: new Set(),
  paidInFlightAvatars: new Set(),
  avatarDeleteNotice: null,
};

export function isActiveJob(job: JobView): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Cancelled, done and failed are final: a late `job.progress` must not bring the job back. */
function isFinished(job: JobView): boolean {
  return job.status === "cancelled" || job.status === "done" || job.status === "failed";
}

export function jobFromState(j: Exclude<JobState, { kind: "import" }>): JobView {
  // Both JobState branches carry their own avatarId (T6: a run's does too,
  // not only avatar.candidates') — read straight off the state, never
  // guessed, matching job.progress's own avatarId (below).
  return {
    jobId: j.jobId,
    kind: j.kind,
    avatarId: j.avatarId,
    runId: j.kind === "run" ? j.runId : null,
    montageId: j.kind === "render" ? j.montageId : null,
    videoId: j.kind === "render" ? j.videoId : null,
    status: j.status,
    saving: j.kind === "render" && j.saving === true && j.status === "running",
    done: j.done,
    total: j.total,
    result: j.result ?? null,
    error: j.error ?? null,
  };
}

/** The identity every job event carries: enough to create the job's view when it is the first this window hears of it. */
type JobRef = { readonly jobId: string; readonly avatarId: string } & (
  | { readonly kind: "avatar.candidates" }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "render"; readonly montageId: string | null; readonly videoId: string | null }
);

function newJob(ref: JobRef): JobView {
  return {
    jobId: ref.jobId,
    kind: ref.kind,
    avatarId: ref.avatarId,
    runId: ref.kind === "run" ? ref.runId : null,
    montageId: ref.kind === "render" ? ref.montageId : null,
    videoId: ref.kind === "render" ? ref.videoId : null,
    status: "queued",
    saving: false,
    done: 0,
    total: 0,
    result: null,
    error: null,
  };
}

/** What `montage.changed` carries: a draft created or saved, or removed. */
export type MontageChange = Extract<EventMessage, { type: "montage.changed" }>["payload"];

/**
 * What the montage listeners hear: each `montage.changed`, and `resynced` when the store had to take a snapshot
 * again (a seq gap, a restarted engine, a retry). Drafts are not in the snapshot, so any `montage.changed` in the
 * gap is lost: a listener re-reads what it shows.
 */
export type MontageSignal = MontageChange | { readonly change: "resynced" };

/** What `video.changed` carries: a record upserted, or removed (3e.2: the Photos «Видео» tab). */
export type VideoChange = Extract<EventMessage, { type: "video.changed" }>["payload"];

/** What the video listeners hear: each `video.changed`, and `resynced` after a snapshot taken again (the records are listed on demand). */
export type VideoSignal = VideoChange | { readonly change: "resynced" };

/** What `media.changed` carries: an own-media record stored, or removed (3f.6). */
export type MediaStoreChange = Extract<EventMessage, { type: "media.changed" }>["payload"];

/** What the media listeners hear (3f.6): each `media.changed`, and `resynced` after a snapshot taken again (the records are listed on demand). */
export type MediaSignal = MediaStoreChange | { readonly change: "resynced" };

/** Dismissed imports, and imports this window asked to cancel, remembered at most (so a snapshot does not undo them); the oldest go first. */
const MAX_DISMISSED_IMPORTS = 200;

/** Adds `id` to an insertion-ordered set capped at `MAX_DISMISSED_IMPORTS`, forgetting the oldest. */
function rememberCapped(set: Set<string>, id: string): void {
  set.add(id);
  for (const old of set) {
    if (set.size <= MAX_DISMISSED_IMPORTS) break;
    set.delete(old);
  }
}

/**
 * Adds `notice` to `notices`, deduped by `noticeId` (an exact repeat delivery
 * changes nothing) and by `code` (only one of each kind is shown, so e.g. two
 * `engine-restarted` notices show once). Which one of a same-code pair is
 * kept is decided by `count` (the larger, i.e. the one that happened more
 * times this session) and, tied, by the newer `at` — never by which simply
 * arrived last: a snapshot's own notices and a live `engine.notice` can
 * interleave out of order (a resync's held events replayed after a fresher
 * snapshot, say), and a stale duplicate must not make the shown notice regress.
 */
function mergeNotice(notices: readonly EngineNotice[], notice: EngineNotice): readonly EngineNotice[] {
  if (notices.some((n) => n.noticeId === notice.noticeId)) return notices;
  const bySameCode = notices.findIndex((n) => n.code === notice.code);
  if (bySameCode === -1) return [...notices, notice];
  const existing = notices[bySameCode];
  if (existing === undefined) return [...notices, notice];
  const isNewer = notice.count > existing.count || (notice.count === existing.count && notice.at >= existing.at);
  if (!isNewer) return notices;
  return notices.map((n, i) => (i === bySameCode ? notice : n));
}

function mergeCandidates(draft: Draft, result: JobResult): Draft {
  if (result.kind !== "avatar.candidates" || result.avatarId !== draft.avatarId) return draft;
  const known = new Set(draft.candidates.map((c) => c.photoId));
  const added = result.candidates.filter((c) => !known.has(c.photoId));
  return added.length === 0 ? draft : { ...draft, candidates: [...draft.candidates, ...added] };
}

type Classified = "apply" | "skip" | "hole" | "reboot";

/** Catching up by `engine.events` is tried this many times in a row before falling back to a snapshot. */
const MAX_CATCH_UPS = 3;

/**
 * Snapshots the store may take on its own (for a seq gap or a new bootId)
 * within the window, across all resyncs. More means the host is misbehaving,
 * not late: the store goes offline and waits for the user's retry. The first
 * load and a user's retry are not counted.
 */
const MAX_AUTO_SNAPSHOTS = 3;
const AUTO_SNAPSHOT_WINDOW_MS = 10_000;

const BROKEN_STREAM: EngineError = { code: "INTERNAL", detail: "the engine event stream keeps breaking; resync stopped" };

/** Stale bootIds remembered at most; the oldest is forgotten first (a forgotten one costs one more snapshot, not a loop). */
const MAX_STALE_BOOTS = 64;

/** `user`: the first load or a retry, whose first snapshot is not counted against the automatic budget. */
type SyncOrigin = "user" | "auto";

/** A window that comes back to the front asks the engine to check the export folder at most this often (3e.3). */
export const EXPORT_RECHECK_MIN_MS = 5_000;

export interface EngineStoreOptions {
  /** A monotonic clock in ms for the automatic-snapshot budget (default `performance.now`); tests may pass their own. */
  now?: () => number;
}

/**
 * The renderer's copy of engine state. It loads `engine.snapshot`, then applies
 * events in `seq` order. Events that arrive while a resync is in flight are
 * held and replayed after it. A seq hole asks `engine.events {afterSeq, bootId}`
 * for the missed events; an answer of `gap`, or an event from another `bootId`
 * (the engine restarted), refetches the snapshot.
 */
export class EngineStore {
  private view: EngineView = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly montageListeners = new Set<(signal: MontageSignal) => void>();
  private readonly videoListeners = new Set<(signal: VideoSignal) => void>();
  private readonly mediaListeners = new Set<(signal: MediaSignal) => void>();
  private readonly avatarRemovedListeners = new Set<(avatarId: string) => void>();
  /** The imports the owner dismissed (3f.6): a snapshot that still lists one does not bring it back. Insertion-ordered, capped. */
  private readonly dismissedImports = new Set<string>();
  /**
   * The imports this window asked to cancel (round 1, L1), marked BEFORE `media.cancelImport` goes: its `job.cancelled` may land before the answer,
   * and a snapshot or a tab opened later must still read it as the owner's own cancel. Taken back when the engine refuses. Insertion-ordered, capped.
   */
  private readonly cancelAsked = new Set<string>();
  private held: EventMessage[] = [];
  private syncing = false;
  private queuedSnapshot = false;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  /** When the store took its recent automatic snapshots. */
  private autoSnapshots: number[] = [];
  /** bootIds whose events asked for a snapshot that the snapshot did not confirm: ignored from then on. */
  private readonly staleBoots = new Set<string>();
  /** bootIds of foreign events waiting for the next snapshot to confirm or refute them. */
  private readonly unconfirmedBoots = new Set<string>();
  /** The bootIds the last snapshot refuted: stale whatever the cap evicted, so one batch cannot re-trigger itself. */
  private lastRefuted = new Set<string>();
  private readonly now: () => number;
  /** The export check this window is waiting for, and when it asked last (`recheckExport`). */
  private exportCheck: Promise<void> | null = null;
  private lastExportCheck: number | null = null;
  /** How many `export.status` events came: an answer to a check that began before one is older than it. */
  private exportStatusEvents = 0;
  /** How many `music.changed` events came: an answer to an ask or a command that began before one is older than it (3c.6). */
  private musicEvents = 0;
  /** The confirmed music commands on their way, by type: asked again meanwhile, they are not sent again (a double click). */
  private readonly musicSending = new Map<"music.refresh" | "music.recoverQuotaLog", Promise<MusicCommandReply>>();
  /**
   * The library-switch generation the avatar and draft lists came from (the
   * last snapshot's). Compared instead of the path string: two spellings of
   * one folder (a Windows network share reached by two names) must not
   * trigger a resync, and a folder that stops resolving while the path is
   * unchanged still needs a compare the string alone could miss.
   */
  private listsLibraryGeneration: number | null = null;

  constructor(
    private readonly client: EngineClient,
    options: EngineStoreOptions = {},
  ) {
    // Monotonic: a wall clock set back would leave budget entries "in the future" and block recovery.
    this.now = options.now ?? (() => performance.now());
  }

  // ---------- React glue (useSyncExternalStore) ----------

  readonly getView = (): EngineView => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * `montage.changed` as the store applies it: in seq order, once each, never from a stale engine or a replayed
   * duplicate. The drafts are not kept in the view (they are listed on demand); the editor and the drafts screen
   * listen here instead of on the raw event stream.
   */
  readonly subscribeMontages = (listener: (signal: MontageSignal) => void): (() => void) => {
    this.montageListeners.add(listener);
    return () => {
      this.montageListeners.delete(listener);
    };
  };

  /**
   * `video.changed` as the store applies it (3e.2), the drafts' way: in seq order, once each, AFTER the view took it (a record
   * that lands after its render's `job.failed` has already made that job done), and `resynced` after a snapshot taken again.
   * The records are not kept in the view: the Photos «Видео» tab lists them on demand and listens here.
   */
  readonly subscribeVideos = (listener: (signal: VideoSignal) => void): (() => void) => {
    this.videoListeners.add(listener);
    return () => {
      this.videoListeners.delete(listener);
    };
  };

  /**
   * `media.changed` as the store applies it (3f.6), the videos' way: in seq order, once each, and `resynced` after a snapshot taken
   * again (any change in the gap is lost). The records are not kept in the view: the «Мои» tab lists them on demand and listens here.
   */
  readonly subscribeMedia = (listener: (signal: MediaSignal) => void): (() => void) => {
    this.mediaListeners.add(listener);
    return () => {
      this.mediaListeners.delete(listener);
    };
  };

  /**
   * `avatar.removed` as the store applies it (an avatar was deleted: «Удалить аватар»), in seq order, once each, AFTER the view dropped the avatar:
   * the editor open on one of the avatar's drafts closes with a notice. Not replayed after a snapshot: a screen reads the avatar list from the view.
   */
  readonly subscribeAvatarRemoved = (listener: (avatarId: string) => void): (() => void) => {
    this.avatarRemovedListeners.add(listener);
    return () => {
      this.avatarRemovedListeners.delete(listener);
    };
  };

  // ---------- lifecycle ----------

  /** Subscribes to events and loads the snapshot; returns `stop`. Safe to call again after `stop` (StrictMode). */
  start(): () => void {
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = this.client.subscribe((event) => this.receive(event, generation));
    this.syncing = false;
    this.held = [];
    void this.resync("snapshot", generation, "user");
    return () => {
      if (this.generation !== generation) return;
      this.generation += 1;
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  /**
   * Catches up after the window was hidden or the connection flapped: by
   * events when the state is sound, by a snapshot when there is none yet or
   * the store is offline (offline dropped events, so only a snapshot is safe).
   */
  reconnect(): void {
    const mode = this.view.bootId === null || this.view.phase === "offline" ? "snapshot" : "events";
    void this.resync(mode, this.generation, "auto");
  }

  /** Refetches the snapshot: the user's retry, which also resets the automatic budget. */
  reload(): void {
    this.autoSnapshots = [];
    this.staleBoots.clear();
    this.lastRefuted = new Set();
    this.update({ phase: this.view.bootId === null ? "connecting" : this.view.phase, failure: null });
    void this.resync("snapshot", this.generation, "user");
  }

  // ---------- local updates from command results ----------

  setSettings(settings: Settings): void {
    this.update({ settings });
  }

  setApiKey(apiKey: ApiKeyStatus): void {
    if (this.view.settings) this.update({ settings: { ...this.view.settings, apiKey } });
  }

  setMusicKey(musicKey: MusicKeyStatus): void {
    if (this.view.settings) this.update({ settings: { ...this.view.settings, musicKey } });
  }

  setMoney(money: MoneyStatus): void {
    this.update({ money });
  }

  setAvatars(avatars: readonly AvatarSummary[]): void {
    this.update({ avatars });
  }

  /** A saved avatar replaces its draft. */
  saveAvatar(avatar: AvatarSummary): void {
    this.update(this.savedAvatarPatch(avatar));
  }

  upsertDraft(draft: Draft): void {
    this.update(this.draftPatch(draft));
  }

  /** Records a job this window just started; merges with any events that beat the reply. */
  trackCandidatesJob(jobId: string, avatarId: string): void {
    this.patchJob({ kind: "avatar.candidates", jobId, avatarId }, (job) => job);
  }

  /**
   * T8b: records a photo run's job this window just started or resumed, with
   * its slot count as the total and, for a resume, the slots that already
   * ended as done, until the first job.progress says otherwise (so the
   * sidebar queue never shows a batch's "|| 4" for a run, nor a resume
   * starting over from zero); merges with any events that beat the reply.
   * `runId` comes straight off the same command reply.
   */
  trackRunJob(jobId: string, runId: string, avatarId: string, total: number, ended = 0): void {
    this.patchJob({ kind: "run", jobId, runId, avatarId }, (job) => {
      const size = job.total || total;
      // A job that already ended before this reply is at least this resume's
      // own baseline (L9): "done" means every slot, including the newly
      // resumed ones, finished (size); a job.cancelled or job.failed that
      // beat the reply (a fast cancel, say) still keeps the slots this
      // resume started from — never drops back to 0 of them.
      const done = isFinished(job) ? Math.max(job.done, job.status === "done" ? size : ended) : job.done || ended;
      return { ...job, total: size, done };
    });
  }

  /** 3f.6 (round 1, L1): this window is about to ask the engine to cancel the import `jobId`: marked now, before the command goes, for good. */
  askImportCancel(jobId: string): void {
    rememberCapped(this.cancelAsked, jobId);
    const imports = markImportCancelling(this.view.imports, jobId);
    if (imports !== this.view.imports) this.update({ imports });
  }

  /** 3f.6: the engine refused that cancel: the import goes on, and an end the engine makes later is its own. */
  cancelRefused(jobId: string): void {
    this.cancelAsked.delete(jobId);
    const imports = unmarkImportCancelling(this.view.imports, jobId);
    if (imports !== this.view.imports) this.update({ imports });
  }

  /** 3f.6: the owner closed an import's outcome (a refusal, say): it leaves the view, and a later snapshot does not bring it back. */
  dismissImport(jobId: string): void {
    rememberCapped(this.dismissedImports, jobId);
    if (this.view.imports.some((i) => i.jobId === jobId)) this.update({ imports: this.view.imports.filter((i) => i.jobId !== jobId) });
  }

  /** The imports after an event: this window's cancel asks put back on any import first heard of here. */
  private withAsks(imports: readonly ImportView[]): readonly ImportView[] {
    return applyCancelAsks(imports, this.cancelAsked);
  }

  markJobCancelled(jobId: string): void {
    const job = this.view.jobs.find((j) => j.jobId === jobId);
    if (job !== undefined && isActiveJob(job)) this.replaceJob({ ...job, status: "cancelled", saving: false });
  }

  /**
   * Optimistic cancel, done right: records that this window is waiting for
   * jobId's real end, without claiming it has already happened. A no-op for
   * a job that is not active — there is nothing to wait for (it may already
   * be done, failed, or itself gone offline-failed by M5). `update()` keeps
   * this set pruned to active jobs on every change, so the real end, by
   * whatever path it comes, clears it without this method's help.
   */
  markCancelling(jobId: string): void {
    const job = this.view.jobs.find((j) => j.jobId === jobId);
    if (job === undefined || !isActiveJob(job)) return;
    this.update({ cancellingJobs: new Set([...this.view.cancellingJobs, jobId]) });
  }

  /**
   * Records whether a paid runs.start or runs.resume is in flight for
   * `avatarId` (T8b's L5/LOW-3), window-wide so a remount mid-send (the
   * sidebar reopening the Photos screen, say) still sees it and cannot send
   * a second one the first send's own lock was meant to prevent.
   */
  setPaidInFlight(avatarId: string, inFlight: boolean): void {
    if (this.view.paidInFlightAvatars.has(avatarId) === inFlight) return;
    const paidInFlightAvatars = new Set(this.view.paidInFlightAvatars);
    if (inFlight) paidInFlightAvatars.add(avatarId);
    else paidInFlightAvatars.delete(avatarId);
    this.update({ paidInFlightAvatars });
  }

  /** An avatar was deleted: what is said about it, window-wide (see `EngineView.avatarDeleteNotice`). Replaces the one before. */
  noteAvatarDeleted(notice: AvatarDeleteNotice): void {
    this.update({ avatarDeleteNotice: notice });
  }

  /** The owner has read it. */
  dismissAvatarDeleted(): void {
    if (this.view.avatarDeleteNotice !== null) this.update({ avatarDeleteNotice: null });
  }

  async refreshAvatars(): Promise<void> {
    const reply = await this.client.request("avatars.list", {});
    if (reply.ok) this.update({ avatars: reply.result.avatars, unreadableAvatars: reply.result.unreadableAvatars, unreadableTotal: reply.result.unreadableTotal });
  }

  async refreshMoney(): Promise<void> {
    const reply = await this.client.request("money.status", {});
    if (reply.ok) this.setMoney(reply.result);
  }

  /**
   * Asks the engine for a fresh look at the export folder (`export.check`), so an unplugged or replugged disk shows up without a
   * render attempt: `export.status` follows checks only (K9). Called when the window comes back to the front, so it is throttled
   * (`EXPORT_RECHECK_MIN_MS`, unless `force`: the owner asked), joins an ask that is still waiting, and never throws: a failed
   * ask changes nothing (and still counts toward the interval, so a broken engine is not asked again and again). Not before the
   * first snapshot, and the answer is dropped when an `export.status` arrived meanwhile: that event is newer.
   */
  recheckExport(options: { force?: boolean } = {}): Promise<void> {
    if (this.view.phase !== "ready") return Promise.resolve();
    if (this.exportCheck !== null) return this.exportCheck;
    const now = this.now();
    if (options.force !== true && this.lastExportCheck !== null && now - this.lastExportCheck < EXPORT_RECHECK_MIN_MS) return Promise.resolve();
    this.lastExportCheck = now;
    const generation = this.generation;
    const eventsBefore = this.exportStatusEvents;
    const check = (async (): Promise<void> => {
      try {
        const reply = await this.client.request("export.check", {});
        if (reply.ok && generation === this.generation && eventsBefore === this.exportStatusEvents) this.update({ exportStatus: reply.result.exportStatus });
      } catch {
        // The ask failed before it could be answered: nothing to show.
      } finally {
        this.exportCheck = null;
      }
    })();
    this.exportCheck = check;
    return check;
  }

  /**
   * Asks the engine for the music status (`music.status`, free: it reads the quota log and the list on disk). Never throws: a
   * failed ask changes nothing. An answer is dropped when a `music.changed` arrived after the ask began: that event is newer.
   */
  async refreshMusic(): Promise<void> {
    const generation = this.generation;
    const eventsBefore = this.musicEvents;
    // The client answers every failure (a broken bridge included) as an error: a failed ask leaves what is shown.
    const reply = await this.client.request("music.status", {});
    if (reply.ok && generation === this.generation && eventsBefore === this.musicEvents) this.update({ music: reply.result });
  }

  /**
   * Sends `music.refresh {confirm: true}`: one of the 30 requests per 31 days. Only the owner's confirmation in the window
   * calls this. Asked again while it is on its way, it is not sent again: the same answer comes back.
   */
  confirmMusicRefresh(): Promise<MusicCommandReply> {
    return this.sendMusic("music.refresh");
  }

  /** Sends `music.recoverQuotaLog {confirm: true}`, which closes the quota for 31 days; the owner confirmed it. Sent once, like a refresh. */
  confirmQuotaLogRecovery(): Promise<MusicCommandReply> {
    return this.sendMusic("music.recoverQuotaLog");
  }

  private sendMusic(type: "music.refresh" | "music.recoverQuotaLog"): Promise<MusicCommandReply> {
    const sending = this.musicSending.get(type);
    if (sending !== undefined) return sending;
    const generation = this.generation;
    const eventsBefore = this.musicEvents;
    const sent = (async (): Promise<MusicCommandReply> => {
      try {
        const reply = await this.client.request(type, { confirm: true });
        if (!reply.ok) return { ok: false, error: reply.error };
        // The answer's status is the one at its start; a `music.changed` that came meanwhile (a fast refresh's progress) is newer.
        if (generation === this.generation && eventsBefore === this.musicEvents) this.update({ music: reply.result.status });
        return { ok: true };
      } finally {
        this.musicSending.delete(type);
      }
    })();
    this.musicSending.set(type, sent);
    return sent;
  }

  async refreshSettings(): Promise<void> {
    const reply = await this.client.request("settings.get", {});
    if (reply.ok) this.setSettings(reply.result);
  }

  /**
   * `unreadableAvatars` and `unreadableTotal` with `avatarId` dropped: an
   * avatar the store can list normally is readable by definition, whether it
   * just arrived that way or a rewrite just recovered it — otherwise it
   * would sit in both lists until the next snapshot, its stale count
   * included, and a second rewrite would answer VALIDATION (nothing to fix).
   */
  private droppedFromUnreadable(avatarId: string): Pick<EngineView, "unreadableAvatars" | "unreadableTotal"> {
    const wasListed = this.view.unreadableAvatars.some((u) => u.avatarId === avatarId);
    return {
      unreadableAvatars: this.view.unreadableAvatars.filter((u) => u.avatarId !== avatarId),
      unreadableTotal: wasListed ? Math.max(0, this.view.unreadableTotal - 1) : this.view.unreadableTotal,
    };
  }

  /** The avatar added, or replaced where it is listed; the draft it came from is gone. Also drops it from `unreadableAvatars` (see `droppedFromUnreadable`). */
  private savedAvatarPatch(avatar: AvatarSummary): Pick<EngineView, "avatars" | "drafts" | "unreadableAvatars" | "unreadableTotal"> {
    const listed = this.view.avatars.some((a) => a.avatarId === avatar.avatarId);
    return {
      avatars: listed ? this.view.avatars.map((a) => (a.avatarId === avatar.avatarId ? avatar : a)) : [...this.view.avatars, avatar],
      drafts: this.view.drafts.filter((d) => d.avatarId !== avatar.avatarId),
      ...this.droppedFromUnreadable(avatar.avatarId),
    };
  }

  /** Same drop from `unreadableAvatars`/`unreadableTotal` as `savedAvatarPatch`, for a draft. */
  private draftPatch(draft: Draft): Pick<EngineView, "drafts" | "unreadableAvatars" | "unreadableTotal"> {
    const exists = this.view.drafts.some((d) => d.avatarId === draft.avatarId);
    return {
      drafts: exists ? this.view.drafts.map((d) => (d.avatarId === draft.avatarId ? draft : d)) : [...this.view.drafts, draft],
      ...this.droppedFromUnreadable(draft.avatarId),
    };
  }

  /** A 401 changes the key's status in main, which no event carries: read it again. */
  private afterError(error: EngineError): void {
    if (error.code === "AUTH_INVALID") void this.refreshSettings();
  }

  // ---------- sync ----------

  private receive(event: EventMessage, generation: number): void {
    if (generation !== this.generation) return;
    // Offline waits for the user's retry (`reload`); events cannot be trusted until then.
    if (this.view.phase === "offline") return;
    if (this.syncing) {
      this.held.push(event);
      return;
    }
    switch (this.classify(event)) {
      case "apply":
        this.apply(event);
        return;
      case "skip":
        return;
      case "hole":
        this.held.push(event);
        void this.resync("events", generation, "auto");
        return;
      case "reboot":
        // Held: once the snapshot confirms the new engine, its event may still be newer than the snapshot.
        this.held.push(event);
        this.unconfirmedBoots.add(event.bootId);
        void this.resync("snapshot", generation, "auto");
        return;
    }
  }

  private classify(event: EventMessage): Classified {
    if (this.view.bootId === null) return "skip";
    if (this.staleBoots.has(event.bootId) || this.lastRefuted.has(event.bootId)) return "skip";
    if (event.bootId !== this.view.bootId) return "reboot";
    if (event.seq <= this.view.lastSeq) return "skip";
    if (event.seq === this.view.lastSeq + 1) return "apply";
    return "hole";
  }

  /** True when another automatic snapshot fits the budget (and records it). */
  private takeAutoSnapshot(): boolean {
    const now = this.now();
    // Entries from "the future" (an injected clock that went back) are dropped too.
    this.autoSnapshots = this.autoSnapshots.filter((at) => at <= now && now - at < AUTO_SNAPSHOT_WINDOW_MS);
    if (this.autoSnapshots.length >= MAX_AUTO_SNAPSHOTS) return false;
    this.autoSnapshots.push(now);
    return true;
  }

  /**
   * M5: nothing polls on its own, so once the engine is dead for good a job
   * left `queued`/`running` would look alive forever — no event will ever
   * arrive to say otherwise, and this may be the last check for a long
   * while. Every active job is failed with the same reason right here, not
   * only the top-level `phase`; a finished job (done/cancelled/failed
   * already) is untouched, matching `isFinished`'s own rule elsewhere.
   *
   * This only applies when `failure.detail` is `ENGINE_GONE_DETAIL` — main's
   * `EngineHost` stamps every answer with it once it has given up restarting
   * the engine. Every other offline cause (a broken event stream, a plain
   * failed snapshot fetch, a network hiccup) leaves job statuses alone: the
   * engine and the job may well still be alive, and the next successful
   * snapshot or event is what actually knows — failing them here would be a
   * guess the store cannot back up, and a real progress event landing right
   * after would have nothing to correct.
   */
  private goOffline(failure: EngineError): void {
    const goneForGood = failure.detail === ENGINE_GONE_DETAIL;
    this.update({
      phase: "offline",
      failure,
      jobs: goneForGood ? this.view.jobs.map((job) => (isActiveJob(job) ? { ...job, status: "failed", saving: false, error: failure } : job)) : this.view.jobs,
      imports: goneForGood ? failActiveImports(this.view.imports, failure) : this.view.imports,
    });
    this.held = [];
    this.unconfirmedBoots.clear();
  }

  private async resync(mode: "snapshot" | "events", generation: number, origin: SyncOrigin): Promise<void> {
    if (this.syncing) {
      if (mode === "snapshot") this.queuedSnapshot = true;
      return;
    }
    this.syncing = true;
    let next: "snapshot" | "events" | null = mode;
    let catchUps = 0;
    let free = origin === "user";
    try {
      while (next !== null) {
        if (next === "events" && this.view.bootId !== null && catchUps < MAX_CATCH_UPS) {
          catchUps += 1;
          const reply = await this.client.request("engine.events", { afterSeq: this.view.lastSeq, bootId: this.view.bootId });
          if (generation !== this.generation) return;
          if (!reply.ok || reply.result.gap || !this.applyRun(reply.result.events)) {
            next = "snapshot";
            continue;
          }
        } else {
          if (!free && !this.takeAutoSnapshot()) {
            this.goOffline(BROKEN_STREAM);
            return;
          }
          free = false;
          const reply = await this.client.request("engine.snapshot", {});
          if (generation !== this.generation) return;
          if (!reply.ok) {
            this.goOffline(reply.error);
            return;
          }
          this.applySnapshot(reply.result);
        }

        if (this.queuedSnapshot) {
          this.queuedSnapshot = false;
          next = "snapshot";
          continue;
        }
        next = this.drainHeld();
      }
    } finally {
      if (generation === this.generation) this.syncing = false;
    }
  }

  /** Replays held events in seq order; says what kind of resync is still needed, if any. */
  private drainHeld(): "snapshot" | "events" | null {
    const held = [...this.held].sort((a, b) => a.seq - b.seq);
    this.held = [];
    for (const [i, event] of held.entries()) {
      const kind = this.classify(event);
      if (kind === "apply") this.apply(event);
      else if (kind === "reboot") {
        // One snapshot confirms or refutes every foreign bootId still held, not just this one.
        for (const later of held.slice(i)) if (this.classify(later) === "reboot") this.unconfirmedBoots.add(later.bootId);
        this.held = held.slice(i);
        return "snapshot";
      } else if (kind === "hole") {
        this.held = held.slice(i);
        return "events";
      }
    }
    return null;
  }

  /** Applies a run from `engine.events`; false when it does not continue from `lastSeq` without holes. */
  private applyRun(events: readonly EventMessage[]): boolean {
    for (const event of events) {
      const kind = this.classify(event);
      if (kind === "apply") this.apply(event);
      else if (kind !== "skip") return false;
    }
    return true;
  }

  /** Remembers a stale bootId, forgetting the oldest beyond MAX_STALE_BOOTS (a Set keeps insertion order). */
  private markStale(boot: string): void {
    this.staleBoots.delete(boot);
    this.staleBoots.add(boot);
    for (const oldest of this.staleBoots) {
      if (this.staleBoots.size <= MAX_STALE_BOOTS) break;
      this.staleBoots.delete(oldest);
    }
  }

  private applySnapshot(s: Snapshot): void {
    // A bootId that asked for this snapshot but is not the snapshot's own is not a live engine.
    this.lastRefuted = new Set([...this.unconfirmedBoots].filter((boot) => boot !== s.bootId));
    for (const boot of this.lastRefuted) this.markStale(boot);
    this.unconfirmedBoots.clear();
    // The engine that was replaced may still have events in flight.
    if (this.view.bootId !== null && this.view.bootId !== s.bootId) this.markStale(this.view.bootId);
    this.staleBoots.delete(s.bootId);
    const again = this.view.bootId !== null;
    this.listsLibraryGeneration = s.librarySwitchGeneration;
    this.update({
      phase: "ready",
      failure: null,
      bootId: s.bootId,
      lastSeq: s.lastSeq,
      settings: s.settings,
      money: s.money,
      exportStatus: s.exportStatus,
      avatars: s.avatars,
      drafts: s.drafts,
      unreadableAvatars: s.unreadableAvatars,
      unreadableTotal: s.unreadableTotal,
      jobs: s.jobs.flatMap((j) => (j.kind === "import" ? [] : [jobFromState(j)])),
      imports: importsFromSnapshot(
        s.jobs.flatMap((j) => (j.kind === "import" ? [j] : [])),
        this.dismissedImports,
        this.cancelAsked,
      ),
      engineError: null,
      notices: s.notices.reduce(mergeNotice, [] as readonly EngineNotice[]),
    });
    // Not for the first load: nothing was shown, so nothing was missed.
    if (again) for (const listener of [...this.montageListeners]) listener({ change: "resynced" });
    if (again) for (const listener of [...this.videoListeners]) listener({ change: "resynced" });
    if (again) for (const listener of [...this.mediaListeners]) listener({ change: "resynced" });
    // The snapshot carries no music status: one that was shown may have missed its events, or describe a refresh of an engine
    // that has since restarted (no event will ever end it), so it is asked again.
    if (again && this.view.music !== null) void this.refreshMusic();
  }

  private apply(event: EventMessage): void {
    const lastSeq = event.seq;
    switch (event.type) {
      case "job.progress": {
        // An import (3f.1b) is no avatar's job: it has no row in `jobs`, its own in `imports` (3f.6).
        if (event.payload.kind === "import") {
          this.update({ lastSeq, imports: this.withAsks(applyImportProgress(this.view.imports, event.payload)) });
          return;
        }
        const { done, total } = event.payload;
        // The event names its job (kind, avatar, runId): a window that never
        // started it, or hears of it first here, still knows exactly whose it is.
        const saving = event.payload.kind === "render" && event.payload.saving === true;
        // A render announced `queued` is waiting for a slot (the same announcement at zero otherwise means it started); a job that
        // already runs is never taken back.
        const queued = event.payload.kind === "render" && event.payload.queued === true;
        this.patchJob(
          event.payload,
          (job) => (isFinished(job) ? job : { ...job, status: queued && job.status !== "running" ? "queued" : "running", done, total, saving: job.saving || saving }),
          lastSeq,
        );
        return;
      }
      case "job.done": {
        const { jobId, result } = event.payload;
        if (result.kind === "import") {
          this.update({ lastSeq, imports: this.withAsks(applyImportDone(this.view.imports, jobId, result)) });
          return;
        }
        // L9: total from the result itself when nothing (no job.progress,
        // no trackRunJob/trackCandidatesJob) told the store one yet —
        // otherwise a job whose first-ever event is its own job.done would
        // read "0 of 0" instead of complete. `job.total` (already known) is
        // always preferred when it is set.
        // A render counts frames: 30 fps, so 3 frames per 100 ms of the finished video.
        const resultTotal =
          result.kind === "run"
            ? result.photoIds.length + result.failedSlots
            : result.kind === "render"
              ? Math.round((result.durationMs * 3) / 100)
              : result.candidates.length + result.failedSlots.length;
        const ref: JobRef =
          result.kind === "run"
            ? { kind: "run", jobId, runId: result.runId, avatarId: result.avatarId }
            : result.kind === "render"
              ? // The result names no draft: a render first heard of here keeps none (one already known keeps its own).
                { kind: "render", jobId, avatarId: result.avatarId, montageId: null, videoId: result.videoId }
              : { kind: "avatar.candidates", jobId, avatarId: result.avatarId };
        this.patchJob(
          ref,
          (job) => {
            const total = job.total || resultTotal;
            return {
              ...job,
              status: "done",
              saving: false,
              total,
              done: Math.max(job.done, total),
              result,
              error: null,
            };
          },
          lastSeq,
        );
        if (result.kind === "avatar.candidates") {
          this.update({ drafts: this.view.drafts.map((d) => mergeCandidates(d, result)) });
        }
        return;
      }
      case "job.failed": {
        const { error } = event.payload;
        if (event.payload.kind === "import") {
          this.update({ lastSeq, imports: this.withAsks(applyImportFailed(this.view.imports, event.payload)) });
          return;
        }
        this.patchJob(event.payload, (job) => ({ ...job, status: "failed", saving: false, error }), lastSeq);
        this.afterError(error);
        return;
      }
      case "money.changed":
        this.update({ money: event.payload.status, lastSeq });
        return;
      case "money.reconcileNeeded": {
        const { reasons, unsettledMicros } = event.payload;
        const money = this.view.money;
        this.update({
          lastSeq,
          money: money?.ledger === "open" ? { ...money, reconcileNeeded: true, reconcileReasons: reasons, unsettledMicros } : money,
        });
        // The event carries the amount but not the count of open reserves: read the whole status.
        void this.refreshMoney();
        return;
      }
      case "engine.error":
        this.update({ engineError: event.payload.error, lastSeq });
        this.afterError(event.payload.error);
        return;
      case "job.cancelled":
        if (event.payload.kind === "import") {
          this.update({ lastSeq, imports: this.withAsks(applyImportCancelled(this.view.imports, event.payload)) });
          return;
        }
        this.patchJob(event.payload, (job) => (isActiveJob(job) ? { ...job, status: "cancelled", saving: false } : job), lastSeq);
        return;
      case "settings.changed": {
        const { settings, librarySwitchGeneration } = event.payload;
        this.update({ settings, lastSeq });
        // A genuine library switch: the avatars and drafts listed belong to
        // the old folder (and studio-media:// already serves the new root).
        // Compared by generation, not the path string, since this window's
        // command answer may have updated the settings before the event came.
        if (this.listsLibraryGeneration !== null && librarySwitchGeneration !== this.listsLibraryGeneration) {
          // 3f.6 (round 1, L7): the finished imports' cards were about the old library: dismissed, so the snapshot does not bring them back.
          const finished = this.view.imports.filter((i) => !isActiveImport(i));
          for (const done of finished) rememberCapped(this.dismissedImports, done.jobId);
          if (finished.length > 0) this.update({ imports: this.view.imports.filter(isActiveImport) });
          void this.resync("snapshot", this.generation, "user");
        }
        return;
      }
      case "avatar.changed":
        this.update({ ...this.savedAvatarPatch(event.payload.avatar), lastSeq });
        return;
      case "draft.changed":
        this.update({ ...this.draftPatch(event.payload.draft), lastSeq });
        return;
      case "avatar.removed": {
        // Deleted for good (its folder is in the system Trash): the avatar, a draft with its id and every job of it leave the view. Its photos, videos and
        // drafts are listed on demand, so their listeners are told to read again (the avatar-specific reads now answer NOT_FOUND, the global ones lose its rows).
        const { avatarId } = event.payload;
        const paidInFlightAvatars = new Set(this.view.paidInFlightAvatars);
        paidInFlightAvatars.delete(avatarId);
        this.update({
          avatars: this.view.avatars.filter((a) => a.avatarId !== avatarId),
          drafts: this.view.drafts.filter((d) => d.avatarId !== avatarId),
          jobs: this.view.jobs.filter((j) => j.avatarId !== avatarId),
          paidInFlightAvatars,
          lastSeq,
        });
        for (const listener of [...this.avatarRemovedListeners]) listener(avatarId);
        for (const listener of [...this.montageListeners]) listener({ change: "resynced" });
        for (const listener of [...this.videoListeners]) listener({ change: "resynced" });
        return;
      }
      case "engine.notice":
        this.update({ notices: mergeNotice(this.view.notices, event.payload.notice), lastSeq });
        return;
      case "video.changed":
        // Video records are listed on demand (videos.list, the Photos «Видео» tab). The event keeps the seq moving, and a record that
        // lands after its render's `job.failed` makes that job done (the video exists).
        this.update(event.payload.change === "upserted" ? { lastSeq, jobs: applyVideoChanged(this.view.jobs, event.payload.video) } : { lastSeq });
        for (const listener of [...this.videoListeners]) listener(event.payload);
        return;
      case "media.changed":
        // Own media are listed on demand (`media.list`, 3f.6's «Мои» tab): the view keeps only the seq, and the listeners hear the change.
        this.update({ lastSeq });
        for (const listener of [...this.mediaListeners]) listener(event.payload);
        return;
      case "montage.changed":
        // Drafts are listed on demand (montages.list): the view keeps only the seq, and the listeners hear the change.
        this.update({ lastSeq });
        for (const listener of [...this.montageListeners]) listener(event.payload);
        return;
      case "export.status":
        this.exportStatusEvents += 1;
        this.update({ exportStatus: event.payload.exportStatus, lastSeq });
        return;
      case "music.changed":
        // 3c.6: the status is kept whole, for the Settings «Музыка» card (and 3d.5's music tab).
        this.musicEvents += 1;
        this.update({ music: event.payload.status, lastSeq });
        return;
      default: {
        // A new event type without a branch above is a compile error here, not a silent gap in `lastSeq`.
        const unhandled: never = event;
        throw new Error(`unhandled engine event ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** Patches the job `ref` names, creating it (from the identity alone) when this is the first this window hears of it. */
  private patchJob(ref: JobRef, patch: (job: JobView) => JobView, lastSeq?: number): void {
    const existing = this.view.jobs.find((j) => j.jobId === ref.jobId);
    const next = patch(existing ?? newJob(ref));
    const jobs = existing ? this.view.jobs.map((j) => (j === existing ? next : j)) : [...this.view.jobs, next];
    this.update(lastSeq === undefined ? { jobs } : { jobs, lastSeq });
  }

  private replaceJob(next: JobView): void {
    this.update({ jobs: this.view.jobs.map((j) => (j.jobId === next.jobId ? next : j)) });
  }

  /**
   * `cancellingJobs` is kept pruned to jobIds still active in `jobs` (patched
   * or not) on every update: whatever ended the job — an event, a fresh
   * snapshot, a restart, or M5's dead-engine failure — ends the cancelling
   * wait for free, with no need for each of those call sites to know this
   * set exists.
   */
  private update(patch: Partial<EngineView>): void {
    const jobs = patch.jobs ?? this.view.jobs;
    const requested = patch.cancellingJobs ?? this.view.cancellingJobs;
    const active = new Set(jobs.filter(isActiveJob).map((j) => j.jobId));
    const cancellingJobs = [...requested].every((id) => active.has(id)) ? requested : new Set([...requested].filter((id) => active.has(id)));
    const batch = nextRenderBatch(patch.renderBatch ?? this.view.renderBatch, jobs);
    const renderBatch = batch.size === this.view.renderBatch.size && [...batch].every((id) => this.view.renderBatch.has(id)) ? this.view.renderBatch : batch;
    this.view = { ...this.view, ...patch, jobs, cancellingJobs, renderBatch };
    for (const listener of [...this.listeners]) listener();
  }
}
