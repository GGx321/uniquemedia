import {
  ENGINE_GONE_DETAIL,
  type ApiKeyStatus,
  type AvatarSummary,
  type Draft,
  type EngineError,
  type EngineNotice,
  type EventMessage,
  type JobResult,
  type JobState,
  type MoneyStatus,
  type Settings,
  type Snapshot,
  type UnreadableAvatar,
} from "../../shared/engine";
import type { EngineClient } from "./client";

export type JobStatus = JobState["status"];

/** A job as the UI sees it. Events can arrive before the command that started the job answers, so kind and avatar may be unknown for a moment. */
export interface JobView {
  readonly jobId: string;
  readonly kind: JobState["kind"] | null;
  readonly avatarId: string | null;
  readonly status: JobStatus;
  readonly done: number;
  readonly total: number;
  readonly result: JobResult | null;
  readonly error: EngineError | null;
}

export type SyncPhase = "connecting" | "ready" | "offline";

export interface EngineView {
  readonly phase: SyncPhase;
  /** Why the last snapshot request failed (phase `offline`). */
  readonly failure: EngineError | null;
  readonly bootId: string | null;
  readonly lastSeq: number;
  readonly settings: Settings | null;
  readonly money: MoneyStatus | null;
  readonly avatars: readonly AvatarSummary[];
  readonly drafts: readonly Draft[];
  /** Avatar records the engine could not read into the lists (from the snapshot and avatars.list); UI shows their count via `.length`. */
  readonly unreadableAvatars: readonly UnreadableAvatar[];
  /** How many there really are; can exceed `unreadableAvatars.length` when the list was cut at its bound (L1). */
  readonly unreadableTotal: number;
  readonly jobs: readonly JobView[];
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
}

const INITIAL: EngineView = {
  phase: "connecting",
  failure: null,
  bootId: null,
  lastSeq: 0,
  settings: null,
  money: null,
  avatars: [],
  drafts: [],
  unreadableAvatars: [],
  unreadableTotal: 0,
  jobs: [],
  engineError: null,
  notices: [],
  cancellingJobs: new Set(),
};

export function isActiveJob(job: JobView): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Cancelled, done and failed are final: a late `job.progress` must not bring the job back. */
function isFinished(job: JobView): boolean {
  return job.status === "cancelled" || job.status === "done" || job.status === "failed";
}

function jobFromState(j: JobState): JobView {
  return {
    jobId: j.jobId,
    kind: j.kind,
    avatarId: j.kind === "avatar.candidates" ? j.avatarId : null,
    status: j.status,
    done: j.done,
    total: j.total,
    result: j.result ?? null,
    error: j.error ?? null,
  };
}

function emptyJob(jobId: string): JobView {
  return { jobId, kind: null, avatarId: null, status: "queued", done: 0, total: 0, result: null, error: null };
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
    this.patchJob(jobId, (job) => ({ ...job, kind: "avatar.candidates", avatarId }));
  }

  markJobCancelled(jobId: string): void {
    this.patchJob(jobId, (job) => (isActiveJob(job) ? { ...job, status: "cancelled" } : job));
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

  async refreshAvatars(): Promise<void> {
    const reply = await this.client.request("avatars.list", {});
    if (reply.ok) this.update({ avatars: reply.result.avatars, unreadableAvatars: reply.result.unreadableAvatars, unreadableTotal: reply.result.unreadableTotal });
  }

  async refreshMoney(): Promise<void> {
    const reply = await this.client.request("money.status", {});
    if (reply.ok) this.setMoney(reply.result);
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
      jobs: goneForGood ? this.view.jobs.map((job) => (isActiveJob(job) ? { ...job, status: "failed", error: failure } : job)) : this.view.jobs,
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
    this.listsLibraryGeneration = s.librarySwitchGeneration;
    this.update({
      phase: "ready",
      failure: null,
      bootId: s.bootId,
      lastSeq: s.lastSeq,
      settings: s.settings,
      money: s.money,
      avatars: s.avatars,
      drafts: s.drafts,
      unreadableAvatars: s.unreadableAvatars,
      unreadableTotal: s.unreadableTotal,
      jobs: s.jobs.map(jobFromState),
      engineError: null,
      notices: s.notices.reduce(mergeNotice, [] as readonly EngineNotice[]),
    });
  }

  private apply(event: EventMessage): void {
    const lastSeq = event.seq;
    switch (event.type) {
      case "job.progress": {
        const { jobId, done, total } = event.payload;
        this.patchJob(jobId, (job) => (isFinished(job) ? job : { ...job, status: "running", done, total }), lastSeq);
        return;
      }
      case "job.done": {
        const { jobId, result } = event.payload;
        this.patchJob(
          jobId,
          (job) => ({
            ...job,
            kind: result.kind,
            avatarId: result.kind === "avatar.candidates" ? result.avatarId : job.avatarId,
            status: "done",
            done: Math.max(job.done, job.total),
            result,
            error: null,
          }),
          lastSeq,
        );
        if (result.kind === "avatar.candidates") {
          this.update({ drafts: this.view.drafts.map((d) => mergeCandidates(d, result)) });
        }
        return;
      }
      case "job.failed": {
        const { jobId, error } = event.payload;
        this.patchJob(jobId, (job) => ({ ...job, status: "failed", error }), lastSeq);
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
        this.patchJob(event.payload.jobId, (job) => (isActiveJob(job) ? { ...job, status: "cancelled" } : job), lastSeq);
        return;
      case "settings.changed": {
        const { settings, librarySwitchGeneration } = event.payload;
        this.update({ settings, lastSeq });
        // A genuine library switch: the avatars and drafts listed belong to
        // the old folder (and studio-media:// already serves the new root).
        // Compared by generation, not the path string, since this window's
        // command answer may have updated the settings before the event came.
        if (this.listsLibraryGeneration !== null && librarySwitchGeneration !== this.listsLibraryGeneration) {
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
      case "engine.notice":
        this.update({ notices: mergeNotice(this.view.notices, event.payload.notice), lastSeq });
        return;
    }
  }

  private patchJob(jobId: string, patch: (job: JobView) => JobView, lastSeq?: number): void {
    const existing = this.view.jobs.find((j) => j.jobId === jobId);
    const next = patch(existing ?? emptyJob(jobId));
    const jobs = existing ? this.view.jobs.map((j) => (j === existing ? next : j)) : [...this.view.jobs, next];
    this.update(lastSeq === undefined ? { jobs } : { jobs, lastSeq });
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
    this.view = { ...this.view, ...patch, jobs, cancellingJobs };
    for (const listener of [...this.listeners]) listener();
  }
}
