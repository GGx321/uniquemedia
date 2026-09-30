import { MUSIC_QUOTA_LIMIT, type EngineError, type MusicStatus, type TrackSummary } from "../../shared/engine";
import { createFlashapiClient, FlashapiConfigError, FlashapiError, type FlashapiFetch, type FlashapiResponseInfo } from "./client";
import type { ListParse, MusicTrack } from "./listSchema";
import { CLOCK_MIN_MS, clockInRange, QuotaLedger, QuotaLogError, type QuotaLine, type QuotaOutcome, type QuotaSummary } from "./quotaLedger";
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
};

const MAX_DETAIL = 400;
const last4 = (key: string): string => key.slice(-4);

/** The kind of an error for a log line: the ledger's code, else the error's own name (`TypeError`), never its text. */
function errorKind(error: unknown): string {
  if (error instanceof QuotaLogError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}

function fail(code: EngineError["code"], detail: string): { ok: false; error: EngineError } {
  return { ok: false, error: { code, detail: detail.slice(0, MAX_DETAIL) } };
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
  /** Refreshes that are still inside admission (before their request is started), so `stop()` can wait for them. */
  readonly #admissions = new Set<Promise<unknown>>();

  constructor(deps: MusicServiceDeps) {
    this.#deps = deps;
    this.#ledger = deps.quotaPath === null ? null : new QuotaLedger(deps.quotaPath, { clock: deps.clock });
    this.#sink = deps.sink ?? new MemoryListSink();
  }

  /**
   * The status: the list the sink holds, the ledger's count and the refresh state. A log that cannot be read fails
   * CLOSED (the count reads as the limit), so the card never shows room the ledger cannot vouch for.
   */
  async status(): Promise<MusicStatus> {
    let summary: QuotaSummary | null = null;
    let unreadable = false;
    if (this.#ledger !== null) {
      try {
        summary = await this.#summaryNow();
      } catch {
        unreadable = true;
      }
    }
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
          this.#say(`studio engine: ${what} (${errorKind(error)})`);
          return false;
        }
        this.#say(`studio engine: ${what}: the line was not valid and was dropped (${errorKind(error)})`);
      }
      this.#pending.shift();
    }
    return true;
  }

  /**
   * One manual refresh. Refuses at no cost (no request, no ledger line) with MUSIC_KEY_MISSING, MUSIC_KEY_REJECTED,
   * MUSIC_QUOTA_EXHAUSTED, IN_FLIGHT or MUSIC_UNAVAILABLE; otherwise answers AT ONCE with the status running, and the
   * request, the parse and the sink go on in the background, reporting through `emit`.
   */
  refresh(): Promise<RefreshAnswer> {
    const admission = this.#admit();
    this.#admissions.add(admission);
    void admission.then(
      () => this.#admissions.delete(admission),
      () => this.#admissions.delete(admission),
    );
    return admission;
  }

  async #admit(): Promise<RefreshAnswer> {
    if (this.#closing) return fail("MUSIC_UNAVAILABLE", "the engine is shutting down, so nothing was sent");
    // Before anything else and at no cost: a list that would be lost at the next restart is not worth one of the 30.
    if (!this.#sink.persistent) return fail("MUSIC_UNAVAILABLE", "the music list is not available yet, so nothing was sent");
    if (this.#busy) return fail("IN_FLIGHT", "a music refresh is already running");
    this.#busy = true;
    let admitted = false;
    try {
      const key = this.#deps.key();
      if (key === null) return fail("MUSIC_KEY_MISSING", "no RapidAPI key is stored");
      if (this.#deps.keyRejected()) return fail("MUSIC_KEY_REJECTED", "the stored RapidAPI key was rejected; replace it");
      if (this.#ledger === null) return fail("MUSIC_UNAVAILABLE", "the music folder is not available, so nothing was sent");
      // A clock that is not a real date cannot date a send line (the ledger refuses one, and a window counted from 1970
      // is nonsense): nothing leaves until it is set right, and the owner is told why.
      const clockNow = this.#deps.clock();
      if (!clockInRange(clockNow)) {
        return fail("MUSIC_UNAVAILABLE", `the system clock reads ${describeClock(clockNow)}, which is not a real date, so nothing was sent; set the date and time and try again`);
      }
      // What an earlier failed write held goes to the log FIRST: a 401 or a 0 that was never recorded must count before
      // this request is admitted. If it still cannot be written, nothing is sent.
      if (!(await this.#flush())) {
        return fail("MUSIC_UNAVAILABLE", "the quota log could not be written (a result or key change is still held), so nothing was sent; try again later");
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
        return fail("MUSIC_UNAVAILABLE", error instanceof FlashapiConfigError ? error.message : "the music client could not be set up");
      }
      let before: QuotaSummary;
      try {
        before = await this.#ledger.summary();
      } catch (error) {
        return fail("MUSIC_UNAVAILABLE", error instanceof QuotaLogError ? `${error.message}; nothing was sent` : "the quota log could not be read; nothing was sent");
      }
      if (before.rejectedKey === last4(key)) {
        // The engine must show the key as rejected too, so the settings say so without another request.
        this.#deps.markKeyRejected(key);
        return fail("MUSIC_KEY_REJECTED", "flashapi rejected this key on an earlier refresh; replace it");
      }
      const id = this.#deps.newId();
      let admission;
      try {
        admission = await this.#ledger.reserve({ id, key: last4(key) });
      } catch (error) {
        return fail("MUSIC_UNAVAILABLE", error instanceof QuotaLogError ? `${error.message}; nothing was sent` : "the quota log could not be written; nothing was sent");
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
      if (this.#closing) return fail("MUSIC_UNAVAILABLE", "the engine is shutting down, so nothing was sent");
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
          failure = fail(
            error.kind === "rejected" ? "MUSIC_KEY_REJECTED" : "MUSIC_UNAVAILABLE",
            error.detail,
          );
          if (error.retryAfterMs !== null) failure.error.retryAfterMs = error.retryAfterMs;
        } else {
          await record({ id, key, outcome: "network-error" });
          failure = fail("MUSIC_UNAVAILABLE", redact(error instanceof Error ? error.message : "the request failed"));
        }
      }
      if (failure === null && response !== null && list !== null) {
        await record({ id, key, outcome: "ok", status: response.status, ...this.#figures(response) });
        if (list.tracks.length === 0) {
          failure = fail("MUSIC_UNAVAILABLE", `flashapi returned no usable track (${list.observed.itemCount} items, ${list.dropped.length} dropped)`);
        }
      }
      await this.#logFirst(job, response, list);
      if (failure === null && list !== null) {
        try {
          await this.#sink.accept({ fetchedAt: this.#deps.clock(), tracks: list.tracks }, (done, total) => this.#progress(done, total), job.signal);
        } catch (error) {
          failure = fail("MUSIC_UNAVAILABLE", redact(`the list could not be stored (${error instanceof Error ? error.message : "unknown error"})`));
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
        failure = fail("MUSIC_UNAVAILABLE", `the downloads could not be finished (${error instanceof Error ? error.message : "unknown error"})`);
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
