import { dirname, join } from "node:path";
import { MUSIC_QUOTA_LIMIT, redactSecrets, type EngineError, type MusicQuotaLog, type MusicStatus, type MusicUnavailableReason, type TrackSummary } from "../../shared/engine";
import { decideAutoRefresh, type AutoRefreshRefusal } from "./autoRefresh";
import { AUTO_SENDS_FILE, AutoSendsLog, AutoSendsLogError } from "./autoSends";
import { createFlashapiClient, FlashapiConfigError, FlashapiError, type FlashapiFetch, type FlashapiResponseInfo } from "./client";
import type { ListParse, MusicTrack } from "./listSchema";
import { CLOCK_MIN_MS, clockInRange, QuotaLedger, QuotaLogError, type QuotaLine, type QuotaOutcome, type QuotaSummary, type Recovery } from "./quotaLedger";
import { buildRefreshReport } from "./refreshReport";
import { redactKnown } from "./redactKnown";

// The music service (3c.3): the status of the list and the quota, and the manual refresh. A refresh is admitted only
// by the ledger (key present and not rejected, fewer than 30 sends in 31 days, the server's floor not 0), writes its
// `send` line BEFORE the one request leaves, records the result, and hands the parsed list to a `MusicListSink`.
//
// THE SEAM FOR 3c.4: the sink is where the list is persisted and every track and cover downloaded (invariant 31).
// Until 3c.4 lands, the sink is `MemoryListSink`, which keeps the parsed list in memory only and says
// `persistent: false`. `music.refresh` is reachable from the window (the bridge forwards it), and a refresh into
// memory would spend one of the 30 requests for a list that is gone at the next restart, so a service whose sink is
// not persistent REFUSES a refresh (MUSIC_UNAVAILABLE, "not available yet"). That is the one switch 3c.4 flips: it
// passes a sink with `persistent: true`. It MUST persist the list record before it starts downloading, since the
// request has been spent and the signed URLs expire 104 to 108 hours after it.

/** What the sink is given after one good request. The URLs in it are signed and live in memory only. */
export interface FetchedList {
  /** Epoch ms of the response. */
  fetchedAt: number;
  tracks: readonly MusicTrack[];
}

export interface MusicListSink {
  /**
   * Whether an accepted list survives a restart. False refuses `music.refresh` (see the header): a request must never
   * be spent on a list that will be lost.
   */
  readonly persistent: boolean;
  /**
   * Stores the list and downloads what it names, reporting `progress(done, total)` (the list request itself is the
   * first step, so a sink that counts a track and a cover each reports a total of about 61). Rejects when it cannot.
   */
  accept(list: FetchedList, progress: (done: number, total: number) => void, signal: AbortSignal): Promise<void>;
  /** What is held now, for the status. Epoch ms; 0 bytes when nothing is on disk. */
  summary(): { listFetchedAt: number | null; trackCount: number; bytesOnDisk: number };
  /** How many downloads an earlier, stopped refresh left to finish (from URLs that have not expired). Optional: a sink that cannot resume has none. */
  pendingCount?(): number;
  /** Finishes those downloads, reporting like `accept`. No request to flashapi is involved: the list was already fetched and stored. */
  resume?(progress: (done: number, total: number) => void, signal: AbortSignal): Promise<void>;
  /** The tracks of the current list that are stored, for `music.list` (K23): at most 100, no URL, path or hash. */
  list(): TrackSummary[];
  /** A window of a stored track's waveform (K26), or null when that track is not stored. */
  peaks(trackId: string, startMs: number, durationMs: number, bars: number): Promise<number[] | null>;
}

/**
 * An error a sink wrote to be SHOWN: its message names no path, URL or key. Anything else a sink throws (a filesystem
 * error carries the userData path in its text) is shown by its code or its kind alone (review F5). `reason` is the
 * one cause the window must tell apart (3c.6): `downloads-stopped`, the track store's breaker stopping a run with every
 * URL kept for the next start, which must not read as «список недоступен».
 */
export class SinkError extends Error {
  readonly reason: "downloads-stopped" | null;
  constructor(message: string, reason: "downloads-stopped" | null = null) {
    super(message);
    this.name = "SinkError";
    this.reason = reason;
  }
}

/** The cause of a sink's failure for MUSIC_UNAVAILABLE: the breaker's stop, else `fallback`. */
function sinkReason(error: unknown, fallback: "store-failed" | "downloads-failed"): MusicUnavailableReason {
  return error instanceof SinkError && error.reason !== null ? error.reason : fallback;
}

/** What a sink's failure may say in the status, the events and the log: its own message, else a code, else a kind. Never a path. */
function sinkErrorText(error: unknown): string {
  if (error instanceof SinkError) return error.message;
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return `error ${code}`;
  return error instanceof Error ? error.name : "unknown error";
}

/** The 3c.3 sink: the last parsed list, in memory only. */
export class MemoryListSink implements MusicListSink {
  readonly persistent = false;
  #held: FetchedList | null = null;

  accept(list: FetchedList, progress: (done: number, total: number) => void, _signal?: AbortSignal): Promise<void> {
    this.#held = list;
    progress(1, 1);
    return Promise.resolve();
  }

  summary(): { listFetchedAt: number | null; trackCount: number; bytesOnDisk: number } {
    return { listFetchedAt: this.#held?.fetchedAt ?? null, trackCount: this.#held?.tracks.length ?? 0, bytesOnDisk: 0 };
  }

  /** Nothing is stored, so nothing is offered. */
  list(): TrackSummary[] {
    return [];
  }

  peaks(): Promise<number[] | null> {
    return Promise.resolve(null);
  }
}

export interface MusicServiceDeps {
  /** `userData/music/quota.jsonl`; null when the engine was not given a music folder (every refresh is MUSIC_UNAVAILABLE). */
  quotaPath: string | null;
  baseUrl: string;
  /** True only in an E2E build. */
  allowBaseUrlOverride: boolean;
  fetch: FlashapiFetch;
  clock: () => number;
  newId: () => string;
  /** The music key as the engine holds it now. */
  key: () => string | null;
  /** The engine's in-memory rejected flag for the current key. */
  keyRejected: () => boolean;
  /** Tells the engine which key a 401 was for; the engine ignores a key that has since been replaced. */
  markKeyRejected: (key: string) => void;
  emit: (status: MusicStatus) => void;
  log: (line: string) => void;
  sink?: MusicListSink;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export type RefreshAnswer = { ok: true; status: MusicStatus } | { ok: false; error: EngineError };

/** What `autoRefresh` answers: the refresh started, the rule said no (nothing was sent, nothing written), or the refresh was admitted by the rule and refused by the ledger or the disk. */
export type AutoRefreshAnswer =
  | { kind: "started"; status: MusicStatus }
  | { kind: "declined"; reason: AutoRefreshRefusal }
  | { kind: "failed"; error: EngineError };

/** What the rule needs from the caller: the launch asking (one automatic refresh per launch) and how many tracks the autopilot could choose from now. */
export interface AutoRefreshRequest {
  readonly launchId: string;
  readonly candidateCount: number;
}

/** Thrown inside an admission that the rule turned away; `autoRefresh` turns it into a `declined` answer. The admission's `finally` has already let the service go. */
class AutoDeclined extends Error {
  readonly reason: AutoRefreshRefusal;
  constructor(reason: AutoRefreshRefusal) {
    super(`the automatic refresh was declined (${reason})`);
    this.name = "AutoDeclined";
    this.reason = reason;
  }
}

/**
 * A line the ledger could not take yet. `madeAt` is the moment it was made, so a held floor still counts its 31 days
 * from the answer; it is null when the clock was not a real date then (a dead RTC battery reads 1970), and the line's
 * time is then settled when it is written: no earlier than the send it answers and no later than now.
 */
type PendingLine =
  | { kind: "result"; input: Omit<Parameters<QuotaLedger["recordResult"]>[0], "at">; sentAt: number; madeAt: number | null }
  | { kind: "key"; key: string | null; madeAt: number | null };

/** The moment a held line is written at: the moment it was made, else now; a result never before its send, no line after now. */
function writeTimeOf(line: PendingLine, now: number): number {
  if (line.kind === "result") return Math.min(Math.max(line.madeAt ?? now, line.sentAt), now);
  return Math.min(line.madeAt ?? now, now);
}

/** What a held line reads as for a status: its own time, or the send's when the clock was wrong. A held line is a stand-in, never written from this. */
function heldAsLine(line: PendingLine): QuotaLine {
  if (line.kind === "key") return { v: 1, kind: "key", at: line.madeAt ?? CLOCK_MIN_MS, key: line.key };
  const { input } = line;
  return {
    v: 1,
    kind: "result",
    id: input.id,
    at: line.madeAt ?? line.sentAt,
    key: input.key,
    outcome: input.outcome,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.remaining === undefined ? {} : { remaining: input.remaining }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

/** How a clock reading is told to the owner: its year, or that it is not a time at all. */
function describeClock(at: number): string {
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? `year ${new Date(at).getUTCFullYear()}` : "no valid time";
}

/** What a status says before anything is known; a refresh's answer falls back to it when the real one cannot be built. */
const NEVER_REFRESHED: Omit<MusicStatus, "refresh"> = {
  listFetchedAt: null,
  trackCount: 0,
  bytesOnDisk: 0,
  sentLast31d: 0,
  limit: MUSIC_QUOTA_LIMIT,
  serverRemaining: null,
  nextFreeAt: null,
  quotaLog: "ok",
};

const MAX_DETAIL = 400;
const last4 = (key: string): string => key.slice(-4);

/** The kind of an error for a log line: the ledger's code, else the error's own name (`TypeError`), never its text. */
function errorKind(error: unknown): string {
  if (error instanceof QuotaLogError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}

function fail(code: Exclude<EngineError["code"], "MUSIC_UNAVAILABLE">, detail: string): { ok: false; error: EngineError } {
  return { ok: false, error: { code, detail: detail.slice(0, MAX_DETAIL) } };
}

/** MUSIC_UNAVAILABLE always says why (3c.6): the window picks its text by the cause, never by the detail. */
function unavailable(musicReason: MusicUnavailableReason, detail: string): { ok: false; error: EngineError } {
  return { ok: false, error: { code: "MUSIC_UNAVAILABLE", musicReason, detail: detail.slice(0, MAX_DETAIL) } };
}

/** The cause of a quota log that could not be read, trusted or written. */
function logReason(error: unknown, fallback: "log-unreadable" | "log-unwritable"): MusicUnavailableReason {
  if (!(error instanceof QuotaLogError)) return fallback;
  switch (error.code) {
    case "corrupt":
      return "log-corrupt";
    case "missing":
      return "log-missing";
    case "unreadable":
      return "log-unreadable";
    case "unwritable":
      return "log-unwritable";
  }
}

/** The cause of a request that left and did not end in a usable list; a 401 is MUSIC_KEY_REJECTED and never asks this. */
function requestReason(error: FlashapiError): MusicUnavailableReason {
  switch (error.kind) {
    case "network":
    case "timeout":
    case "aborted":
    case "rejected":
      return "network";
    case "forbidden":
      return "forbidden";
    case "rate-limited":
      return "rate-limited";
    case "http":
      return "server";
    case "too-large":
    case "invalid":
      return "bad-answer";
  }
}

function outcomeOf(error: FlashapiError): QuotaOutcome {
  switch (error.kind) {
    case "rejected":
      return "rejected";
    case "too-large":
      return "too-large";
    case "invalid":
      return "invalid";
    case "timeout":
      return "timeout";
    case "network":
    case "aborted":
      return "network-error";
    case "forbidden":
    case "rate-limited":
    case "http":
      return "http-error";
  }
}

export class MusicService {
  readonly #deps: MusicServiceDeps;
  readonly #ledger: QuotaLedger | null;
  readonly #sink: MusicListSink;
  /** `userData/music/auto-sends.jsonl`; null with no music folder. */
  readonly #autoSends: AutoSendsLog | null;
  /** Launches that have had their one automatic refresh (or the attempt at it) in this process; the 72 h spacing in the log covers a restart. */
  readonly #autoLaunches = new Set<string>();
  #refresh: MusicStatus["refresh"] = { state: "idle" };
  #busy = false;
  #task: Promise<void> = Promise.resolve();
  #emitting: Promise<void> = Promise.resolve();
  #abort: AbortController | null = null;
  /** `stop()` was called: the process is going away, so no refresh may start (a request must not be spent on a dying engine). */
  #closing = false;
  /**
   * Lines the ledger could not take (a `result` that carried a 401 or the server's 0, a key change), OLDEST FIRST and
   * kept whole, with the time each was made. They are written before anything else: at the start of the next refresh
   * and before a key change's own line, so the order on disk is the order it happened in and a re-entered key cannot
   * lift a floor or a 401 that was never recorded. Until they are written a refresh answers MUSIC_UNAVAILABLE.
   */
  readonly #pending: PendingLine[] = [];
  #flushing: Promise<unknown> = Promise.resolve();
  /** Why the last flush stopped (the ledger's own error), so a refusal can name it; cleared when one writes everything. */
  #flushFailure: QuotaLogError | null = null;
  /** Refreshes that are still inside admission (before their request is started), so `stop()` can wait for them. */
  readonly #admissions = new Set<Promise<unknown>>();

  constructor(deps: MusicServiceDeps) {
    this.#deps = deps;
    this.#ledger = deps.quotaPath === null ? null : new QuotaLedger(deps.quotaPath, { clock: deps.clock });
    this.#sink = deps.sink ?? new MemoryListSink();
    this.#autoSends = deps.quotaPath === null ? null : new AutoSendsLog(join(dirname(deps.quotaPath), AUTO_SENDS_FILE));
  }

  /**
   * The status: the list the sink holds, the ledger's count and the refresh state. A log that cannot be read fails
   * CLOSED (the count reads as the limit), so the card never shows room the ledger cannot vouch for.
   */
  async status(options: { writeHeld?: boolean } = {}): Promise<MusicStatus> {
    let summary: QuotaSummary | null = null;
    let quotaLog: MusicQuotaLog = "ok";
    // The window's own ask (`music.status`) first writes what is held (review round 1): the card closes «Обновить» while a
    // line is held, so this ask is the owner's way out once the disk is fixed. Free: nothing leaves. The statuses the
    // service builds for its own events do not write, so a broken disk is not retried on every progress step.
    if (options.writeHeld === true && this.#pending.length > 0) await this.#flush();
    if (this.#ledger !== null) {
      try {
        summary = await this.#summaryNow();
        // Lines still waiting to be written count already; no refresh leaves until they are on disk (3c.6).
        if (this.#pending.length > 0) quotaLog = "held";
      } catch (error) {
        quotaLog = error instanceof QuotaLogError && (error.code === "corrupt" || error.code === "missing") ? error.code : "unreadable";
      }
    }
    const unreadable = quotaLog === "corrupt" || quotaLog === "unreadable" || quotaLog === "missing";
    // A sink that cannot say what it holds must not take the status (and a refresh's answer) down with it.
    let list: ReturnType<MusicListSink["summary"]>;
    try {
      list = this.#sink.summary();
    } catch {
      list = { listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 };
    }
    const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());
    return {
      listFetchedAt: iso(list.listFetchedAt),
      trackCount: list.trackCount,
      bytesOnDisk: list.bytesOnDisk,
      sentLast31d: unreadable ? MUSIC_QUOTA_LIMIT : Math.min(MUSIC_QUOTA_LIMIT, summary?.sentInWindow ?? 0),
      limit: MUSIC_QUOTA_LIMIT,
      serverRemaining: summary?.serverRemaining ?? null,
      nextFreeAt: iso(summary?.nextFreeAt ?? null),
      refresh: this.#refresh,
      quotaLog,
    };
  }

  /** The tracks of the current list that are stored (`music.list`). Free: it reads what the sink holds. */
  list(): TrackSummary[] {
    try {
      return this.#sink.list();
    } catch {
      // A sink that cannot say what it holds offers nothing; it must not take the command down.
      return [];
    }
  }

  /** A window of a stored track's waveform (`music.peaks`), or null when it is not stored or cannot be read. */
  async peaks(trackId: string, startMs: number, durationMs: number, bars: number): Promise<number[] | null> {
    try {
      return await this.#sink.peaks(trackId, startMs, durationMs, bars);
    } catch {
      return null;
    }
  }

  /** Whether the ledger says the key with these last four chars was rejected (kept across restarts, without the key). */
  async keyRejected(key4: string | null): Promise<boolean> {
    if (this.#ledger === null || key4 === null) return false;
    try {
      return (await this.#summaryNow()).rejectedKey === key4;
    } catch {
      return false;
    }
  }

  /** What the ledger says, with the lines still held after what is on disk: a floor or a 401 that is only held counts. */
  #summaryNow(): Promise<QuotaSummary> {
    const ledger = this.#ledger;
    if (ledger === null) return Promise.reject(new QuotaLogError("unreadable", "there is no quota log"));
    return this.#pending.length === 0 ? ledger.summary() : ledger.summaryWith(this.#pending.map(heldAsLine));
  }

  /**
   * The owner stored (`last4`) or cleared (null) the key: an earlier 401 no longer applies. The line goes BEHIND any
   * line still held from an earlier failed write, so a 401 or a 0 that was not recorded is not lifted by it. A log
   * that cannot be written keeps the change held (and logs its kind); the next refresh writes it or answers UNAVAILABLE.
   */
  async noteKeyChange(key4: string | null): Promise<void> {
    if (this.#ledger === null) return;
    const now = this.#deps.clock();
    this.#pending.push({ kind: "key", key: key4, madeAt: clockInRange(now) ? now : null });
    await this.#flush();
  }

  /**
   * The way out of a damaged quota log (3c.6, `music.recoverQuotaLog`), which the window offers only behind the owner's
   * confirmation: the ledger puts the file aside and starts a new log that counts as the limit spent now, so the quota is
   * closed for exactly 31 days. Sends nothing. The key the engine holds as rejected is carried into the new log, so it
   * still reads as rejected after a restart. Announces the new status (`music.changed`) before it answers. Refuses a log
   * that is not damaged (VALIDATION) and anything that cannot be done (MUSIC_UNAVAILABLE, with its cause); a write that
   * fails leaves the damaged log as the log, still closed.
   */
  async recoverQuotaLog(): Promise<RefreshAnswer> {
    if (this.#closing) return unavailable("shutting-down", "the engine is shutting down, so the quota log was not changed");
    // A refresh or the downloads it left are running (review round 1): the log is not swapped under them.
    if (this.#busy) return fail("IN_FLIGHT", "a music refresh is running; recover the quota log once it has ended");
    const ledger = this.#ledger;
    if (ledger === null) return unavailable("no-music-folder", "the music folder is not available, so there is no quota log to recover");
    const key = this.#deps.key();
    const rejectedKey = key !== null && this.#deps.keyRejected() ? last4(key) : null;
    let recovery: Recovery;
    try {
      recovery = await ledger.recover({ rejectedKey });
    } catch (error) {
      return unavailable("log-unwritable", `${error instanceof QuotaLogError ? error.message : "the quota log could not be recovered"}; the damaged log is still the log`);
    }
    if (!recovery.ok) {
      switch (recovery.refusal) {
        case "not-corrupt":
          return fail("VALIDATION", "the quota log is not damaged, so nothing was changed");
        case "unreadable":
          return unavailable("log-unreadable", "the quota log could not be read, so nothing was changed");
        case "clock": {
          const now = this.#deps.clock();
          return unavailable("clock", `the system clock reads ${describeClock(now)}, which is not a real date, so nothing was changed; set the date and time and try again`);
        }
      }
    }
    this.#say(`studio engine: a damaged quota log was put aside as ${recovery.quarantined}; it counts as ${MUSIC_QUOTA_LIMIT} requests now, so the next may leave in 31 days`);
    // Lines held while the log was gone or damaged (a re-entered key, a late answer) can now be written, behind the new line.
    await this.#flush();
    this.#changed();
    await this.#emitting;
    return { ok: true, status: await this.status() };
  }

  /** The logger must never be what breaks the write path. */
  #say(line: string): void {
    try {
      this.#deps.log(line);
    } catch {
      // Nothing to do: the line is a diagnostic.
    }
  }

  /**
   * Writes what is held, in order. Resolves true when nothing is left; on a failure the rest stays held and the kind is
   * logged. The chain never stays rejected: whatever one flush ends in, the next one runs.
   */
  #flush(): Promise<boolean> {
    const run = this.#flushing
      .catch(() => undefined)
      .then(() => this.#flushNow())
      .catch(() => false);
    this.#flushing = run;
    return run;
  }

  async #flushNow(): Promise<boolean> {
    const ledger = this.#ledger;
    if (ledger === null) return true;
    const now = this.#deps.clock();
    // A line cannot be dated while the clock is not a real date: it stays held (and counted by the status) until it is.
    if (this.#pending.length > 0 && !clockInRange(now)) {
      this.#say(`studio engine: quota log lines stay held: the system clock reads ${describeClock(now)}, which is not a real date`);
      return false;
    }
    for (let next = this.#pending[0]; next !== undefined; next = this.#pending[0]) {
      const at = writeTimeOf(next, now);
      try {
        if (next.kind === "result") await ledger.recordResult({ ...next.input, at });
        else await ledger.recordKeyChange(next.key, at);
      } catch (error) {
        const what = next.kind === "result" ? "a flashapi result could not be written to the quota log" : "a music key change could not be noted in the quota log";
        // Only the log's own failure (I/O) is worth retrying. A line the schema or the tag rule refuses will be refused
        // again, and left in front it would block every line and refresh behind it for good, so it is dropped.
        if (error instanceof QuotaLogError) {
          this.#flushFailure = error;
          this.#say(`studio engine: ${what} (${errorKind(error)})`);
          return false;
        }
        this.#say(`studio engine: ${what}: the line was not valid and was dropped (${errorKind(error)})`);
      }
      this.#pending.shift();
    }
    this.#flushFailure = null;
    return true;
  }

  /**
   * One manual refresh. Refuses at no cost (no request, no ledger line) with MUSIC_KEY_MISSING, MUSIC_KEY_REJECTED,
   * MUSIC_QUOTA_EXHAUSTED, IN_FLIGHT or MUSIC_UNAVAILABLE; otherwise answers AT ONCE with the status running, and the
   * request, the parse and the sink go on in the background, reporting through `emit`.
   */
  refresh(): Promise<RefreshAnswer> {
    return this.#track(this.#admit(null));
  }

  /**
   * One AUTOMATIC refresh (Stage 4, S4.5d; a launch's, never the owner's click). It goes through the very admission of `refresh()`, with the rule of `autoRefresh.ts` added
   * after the ledger has been read: a key, nothing running, a stale list or too few candidates, at most 9 automatic sends so far in 31 days and 19 in all, the server's
   * `remaining` at least 11 when known, no automatic send in the last 72 h, and none yet for this launch. `declined` sends nothing and writes nothing. Otherwise the automatic
   * line `{ id, at }` is appended to `auto-sends.jsonl` (fsynced) FIRST, and then the same id goes through the ledger's reserve: the ledger's lines are what a manual refresh
   * writes. One attempt, never retried; a launch that has been given its one is not given another, whatever became of it. Never rejects for a decline.
   */
  async autoRefresh(request: AutoRefreshRequest): Promise<AutoRefreshAnswer> {
    try {
      const answer = await this.#track(this.#admit(request));
      return answer.ok ? { kind: "started", status: answer.status } : { kind: "failed", error: answer.error };
    } catch (error) {
      if (error instanceof AutoDeclined) return { kind: "declined", reason: error.reason };
      throw error;
    }
  }

  /**
   * A launch has closed (done or stopped): the service forgets that it refreshed, so the set does not grow with every launch of a long session. The launch's one automatic
   * refresh was spent when it was admitted; the 72 h spacing and the quota counts, which live on disk, are what hold the next launch back, not this memory.
   */
  releaseLaunch(launchId: string): void {
    this.#autoLaunches.delete(launchId);
  }

  /** Lets `stop()` wait for an admission that has not started its request yet. */
  #track<T>(admission: Promise<T>): Promise<T> {
    this.#admissions.add(admission);
    void admission.then(
      () => this.#admissions.delete(admission),
      () => this.#admissions.delete(admission),
    );
    return admission;
  }

  async #admit(auto: AutoRefreshRequest | null): Promise<RefreshAnswer> {
    if (this.#closing) return unavailable("shutting-down", "the engine is shutting down, so nothing was sent");
    // Before anything else and at no cost: a list that would be lost at the next restart is not worth one of the 30.
    if (!this.#sink.persistent) return unavailable("not-available", "the music list is not available yet, so nothing was sent");
    if (this.#busy) {
      if (auto !== null) throw new AutoDeclined("refresh-running");
      return fail("IN_FLIGHT", "a music refresh is already running");
    }
    this.#busy = true;
    let admitted = false;
    try {
      const key = this.#deps.key();
      if (key === null) {
        if (auto !== null) throw new AutoDeclined("no-key");
        return fail("MUSIC_KEY_MISSING", "no RapidAPI key is stored");
      }
      if (this.#deps.keyRejected()) {
        if (auto !== null) throw new AutoDeclined("key-rejected");
        return fail("MUSIC_KEY_REJECTED", "the stored RapidAPI key was rejected; replace it");
      }
      if (this.#ledger === null) return unavailable("no-music-folder", "the music folder is not available, so nothing was sent");
      // A clock that is not a real date cannot date a send line (the ledger refuses one, and a window counted from 1970
      // is nonsense): nothing leaves until it is set right, and the owner is told why.
      const clockNow = this.#deps.clock();
      if (!clockInRange(clockNow)) {
        return unavailable("clock", `the system clock reads ${describeClock(clockNow)}, which is not a real date, so nothing was sent; set the date and time and try again`);
      }
      // What an earlier failed write held goes to the log FIRST: a 401 or a 0 that was never recorded must count before
      // this request is admitted. If it still cannot be written, nothing is sent.
      if (!(await this.#flush())) {
        // A log that is gone takes no line until it is recovered: that, not a write that may work later, is why nothing left.
        if (this.#flushFailure?.code === "missing") return unavailable("log-missing", `${this.#flushFailure.message}; nothing was sent`);
        return unavailable("log-held", "the quota log could not be written (a result or key change is still held), so nothing was sent; try again later");
      }
      // Built before anything is written: a base URL or key the client refuses must never cost a send.
      let client;
      try {
        client = createFlashapiClient({
          key,
          baseUrl: this.#deps.baseUrl,
          allowBaseUrlOverride: this.#deps.allowBaseUrlOverride,
          fetch: this.#deps.fetch,
          ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
          ...(this.#deps.maxBodyBytes === undefined ? {} : { maxBodyBytes: this.#deps.maxBodyBytes }),
        });
      } catch (error) {
        return unavailable("config", error instanceof FlashapiConfigError ? error.message : "the music client could not be set up");
      }
      let before: QuotaSummary;
      try {
        before = await this.#ledger.summary();
      } catch (error) {
        return unavailable(logReason(error, "log-unreadable"), error instanceof QuotaLogError ? `${error.message}; nothing was sent` : "the quota log could not be read; nothing was sent");
      }
      if (before.rejectedKey === last4(key)) {
        // The engine must show the key as rejected too, so the settings say so without another request.
        this.#deps.markKeyRejected(key);
        if (auto !== null) throw new AutoDeclined("key-rejected");
        return fail("MUSIC_KEY_REJECTED", "flashapi rejected this key on an earlier refresh; replace it");
      }
      const id = this.#deps.newId();
      if (auto !== null) {
        const failure = await this.#admitAuto(auto, id, clockNow, before);
        if (failure !== null) return failure;
      }
      let admission;
      try {
        admission = await this.#ledger.reserve({ id, key: last4(key) });
      } catch (error) {
        return unavailable(logReason(error, "log-unwritable"), error instanceof QuotaLogError ? `${error.message}; nothing was sent` : "the quota log could not be written; nothing was sent");
      }
      if (!admission.ok) {
        const when = admission.summary.nextFreeAt === null ? "later" : new Date(admission.summary.nextFreeAt).toISOString();
        return fail(
          "MUSIC_QUOTA_EXHAUSTED",
          admission.refusal === "quota"
            ? `${admission.summary.sentInWindow} of ${MUSIC_QUOTA_LIMIT} requests were sent in the last 31 days; the next may leave at ${when}`
            : `flashapi's last answer said no requests remain; the next may leave at ${when}`,
        );
      }
      // `stop()` may have come while this refresh waited in the ledger: nothing may leave after it. The send line is
      // already on disk and stays counted (the conservative side: a request that never left costs a slot, not the reverse).
      if (this.#closing) return unavailable("shutting-down", "the engine is shutting down, so nothing was sent");
      admitted = true;
      const controller = new AbortController();
      this.#abort = controller;
      const running = { state: "running", done: 0, total: 1 } as const;
      this.#refresh = running;
      this.#changed();
      // The request goes first: nothing after the send may leave the service busy, whatever the status building does.
      this.#task = this.#run({ client, key, id, hadOk: before.hadOkResult, sent: admission.summary.sentInWindow, sentAt: admission.at, signal: controller.signal });
      let status: MusicStatus;
      try {
        status = { ...(await this.status()), refresh: running };
      } catch {
        status = { ...NEVER_REFRESHED, sentLast31d: Math.min(MUSIC_QUOTA_LIMIT, admission.summary.sentInWindow), refresh: running };
      }
      return { ok: true, status };
    } finally {
      if (!admitted) this.#busy = false;
    }
  }

  /**
   * The automatic refresh's own gate, inside the admission (the service is busy, the ledger has been read). Throws `AutoDeclined` when the rule says no. Otherwise writes the
   * automatic line (fsynced) and marks the launch as having had its one; a line that cannot be written is MUSIC_UNAVAILABLE and nothing is sent. The mark is made as soon as
   * the line is down, so a ledger that then refuses cannot be asked again by the same launch, one automatic line per ask.
   */
  async #admitAuto(auto: AutoRefreshRequest, id: string, now: number, before: QuotaSummary): Promise<{ ok: false; error: EngineError } | null> {
    const log = this.#autoSends;
    if (log === null) return unavailable("no-music-folder", "the music folder is not available, so nothing was sent");
    const sends = await log.summary(now);
    let listFetchedAt: number | null;
    try {
      listFetchedAt = this.#sink.summary().listFetchedAt;
    } catch {
      listFetchedAt = null;
    }
    const verdict = decideAutoRefresh({
      now,
      hasKey: true,
      keyRejected: false,
      refreshRunning: false,
      listFetchedAt,
      candidateCount: auto.candidateCount,
      autoSendsInWindow: sends.count,
      autoLogDamaged: sends.damaged,
      lastAutoSendAt: sends.lastAt,
      totalSendsInWindow: before.sentInWindow,
      serverRemaining: before.serverRemaining,
      launchRefreshed: this.#autoLaunches.has(auto.launchId),
    });
    if (!verdict.ok) throw new AutoDeclined(verdict.reason);
    try {
      await log.record(id, now);
    } catch (error) {
      return unavailable("log-unwritable", error instanceof AutoSendsLogError ? `${error.message}; nothing was sent` : "the automatic sends file could not be written; nothing was sent");
    }
    this.#autoLaunches.add(auto.launchId);
    return null;
  }

  async #run(job: { client: ReturnType<typeof createFlashapiClient>; key: string; id: string; hadOk: boolean; sent: number; sentAt: number; signal: AbortSignal }): Promise<void> {
    const { key, id } = job;
    const record = (input: Parameters<QuotaLedger["recordResult"]>[0]): Promise<void> => this.#record(input, job.sentAt);
    const redact = (text: string): string => redactKnown(text, key);
    let response: FlashapiResponseInfo | null = null;
    let list: Extract<ListParse, { ok: true }> | null = null;
    let failure: { ok: false; error: EngineError } | null = null;
    try {
      try {
        const answer = await job.client.fetchTrending(job.signal);
        response = answer.response;
        list = answer.list;
      } catch (error) {
        if (error instanceof FlashapiError) {
          response = error.response;
          await record({ id, key, outcome: outcomeOf(error), ...(error.status === null ? {} : { status: error.status }), ...this.#figures(error.response) });
          if (error.kind === "rejected") this.#deps.markKeyRejected(key);
          failure = error.kind === "rejected" ? fail("MUSIC_KEY_REJECTED", error.detail) : unavailable(requestReason(error), error.detail);
          if (error.retryAfterMs !== null) failure.error.retryAfterMs = error.retryAfterMs;
        } else {
          await record({ id, key, outcome: "network-error" });
          failure = unavailable("network", redact(error instanceof Error ? error.message : "the request failed"));
        }
      }
      if (failure === null && response !== null && list !== null) {
        await record({ id, key, outcome: "ok", status: response.status, ...this.#figures(response) });
        if (list.tracks.length === 0) {
          failure = unavailable("bad-answer", `flashapi returned no usable track (${list.observed.itemCount} items, ${list.dropped.length} dropped)`);
        }
      }
      await this.#logFirst(job, response, list);
      if (failure === null && list !== null) {
        try {
          await this.#sink.accept({ fetchedAt: this.#deps.clock(), tracks: list.tracks }, (done, total) => this.#progress(done, total), job.signal);
        } catch (error) {
          failure = unavailable(sinkReason(error, "store-failed"), redact(`the list could not be stored (${sinkErrorText(error)})`));
        }
      }
    } finally {
      this.#refresh = failure === null ? { state: "idle" } : { state: "failed", error: failure.error };
      this.#abort = null;
      this.#busy = false;
      this.#changed();
    }
  }

  /**
   * At engine start: finishes the downloads a stopped or crashed refresh left pending. The request for that list was
   * spent long ago, so this costs no quota and touches no ledger; it only continues with the URLs the record kept, until
   * they expire. It takes the same one-at-a-time slot as a refresh (a refresh asked meanwhile is IN_FLIGHT), reports
   * through the same status and events, and does nothing when nothing is pending, when the sink cannot resume, when a
   * refresh is running, or when the engine is shutting down. Never rejects.
   */
  async resumePending(): Promise<void> {
    const sink = this.#sink;
    if (this.#closing || this.#busy || sink.resume === undefined || sink.pendingCount === undefined) return;
    try {
      if (sink.pendingCount() === 0) return;
    } catch {
      return;
    }
    this.#busy = true;
    const controller = new AbortController();
    this.#abort = controller;
    this.#refresh = { state: "running", done: 0, total: 1 };
    this.#changed();
    const resume = sink.resume.bind(sink);
    this.#task = (async () => {
      let failure: { ok: false; error: EngineError } | null = null;
      try {
        await resume((done, total) => this.#progress(done, total), controller.signal);
      } catch (error) {
        // Redacted of the key like a refresh's, whatever the sink's own text says: the key may be in memory here too.
        const text = `the downloads could not be finished (${sinkErrorText(error)})`;
        const key = this.#deps.key();
        failure = unavailable(sinkReason(error, "downloads-failed"), redactSecrets(key === null ? text : redactKnown(text, key)));
      } finally {
        this.#refresh = failure === null ? { state: "idle" } : { state: "failed", error: failure.error };
        this.#abort = null;
        this.#busy = false;
        this.#changed();
      }
    })();
  }

  /** What an answer says that the ledger keeps: the server's figures and its own clock (validated by the client). */
  #figures(response: FlashapiResponseInfo | null): { remaining?: number | null; limit?: number | null; serverAt?: number } {
    if (response === null) return {};
    return { remaining: response.remaining, limit: response.limit, ...(response.serverDateMs === null ? {} : { serverAt: response.serverDateMs }) };
  }

  /**
   * Queues the result line with the moment it was made and writes what is held. The ledger takes the key's last four
   * chars and throws on anything longer, so a whole key can never reach the file. A line the log cannot take stays held
   * (see `#pending`): the send is on disk and counts, and the 401 or the server's 0 this result carried is not lost.
   */
  async #record(input: Parameters<QuotaLedger["recordResult"]>[0], sentAt: number): Promise<void> {
    if (this.#ledger === null) return;
    const now = this.#deps.clock();
    this.#pending.push({ kind: "result", input: { ...input, key: last4(input.key) }, sentAt, madeAt: clockInRange(now) ? now : null });
    await this.#flush();
  }

  /** The plan's first-real-refresh log, until one answer has been good: never the key, never a whole signed URL. */
  async #logFirst(job: { key: string; hadOk: boolean; sent: number }, response: FlashapiResponseInfo | null, list: Extract<ListParse, { ok: true }> | null): Promise<void> {
    if (job.hadOk) return;
    try {
      const report = buildRefreshReport({ response, list, localSentInWindow: job.sent, now: this.#deps.clock(), key: job.key });
      this.#deps.log(`studio engine: first flashapi refresh ${JSON.stringify(report)}`);
    } catch {
      this.#deps.log("studio engine: the first flashapi refresh report could not be built");
    }
  }

  #progress(done: number, total: number): void {
    const safeDone = Math.max(0, Math.floor(done));
    this.#refresh = { state: "running", done: safeDone, total: Math.max(1, Math.floor(total), safeDone) };
    this.#changed();
  }

  /** Emits the current status; emissions keep their order however long each status takes to build. */
  #changed(): void {
    // The refresh state is the one at THIS call: a burst of progress reports is emitted as the burst it was.
    const refresh = this.#refresh;
    this.#emitting = this.#emitting.then(async () => this.#deps.emit({ ...(await this.status()), refresh })).catch(() => undefined);
  }

  /** Resolves once the running refresh and every status it emitted are done. Tests wait on it; nothing else does. */
  async settled(): Promise<void> {
    await this.#task.catch(() => undefined);
    await this.#emitting;
  }

  /** Aborts a request in flight (the engine is shutting down) and waits for it to end. */
  async stop(): Promise<void> {
    this.#closing = true;
    // A refresh already inside admission (waiting in the ledger) gives up at its own re-check; wait for it, so that
    // nothing starts after this resolves. Its request, if it had started, is aborted below.
    await Promise.allSettled([...this.#admissions]);
    this.#abort?.abort();
    await this.settled();
  }
}
