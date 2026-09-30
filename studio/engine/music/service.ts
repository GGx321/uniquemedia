import { MUSIC_QUOTA_LIMIT, type EngineError, type MusicStatus } from "../../shared/engine";
import { createFlashapiClient, FlashapiConfigError, FlashapiError, type FlashapiFetch, type FlashapiResponseInfo } from "./client";
import type { ListParse, MusicTrack } from "./listSchema";
import { QuotaLedger, QuotaLogError, type QuotaOutcome, type QuotaSummary } from "./quotaLedger";
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

/** A line the ledger could not take yet: its own time kept, so a held floor still counts its 31 days from the answer. */
type PendingLine =
  | { kind: "result"; input: Parameters<QuotaLedger["recordResult"]>[0] & { at: number } }
  | { kind: "key"; key: string | null; at: number };

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
        summary = await this.#ledger.summary();
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

  /** Whether the ledger says the key with these last four chars was rejected (kept across restarts, without the key). */
  async keyRejected(key4: string | null): Promise<boolean> {
    if (this.#ledger === null || key4 === null) return false;
    try {
      return (await this.#ledger.summary()).rejectedKey === key4;
    } catch {
      return false;
    }
  }

  /**
   * The owner stored (`last4`) or cleared (null) the key: an earlier 401 no longer applies. The line goes BEHIND any
   * line still held from an earlier failed write, so a 401 or a 0 that was not recorded is not lifted by it. A log
   * that cannot be written keeps the change held (and logs its kind); the next refresh writes it or answers UNAVAILABLE.
   */
  async noteKeyChange(key4: string | null): Promise<void> {
    if (this.#ledger === null) return;
    this.#pending.push({ kind: "key", key: key4, at: this.#deps.clock() });
    await this.#flush();
  }

  /** Writes what is held, in order. Resolves true when nothing is left; on a failure the rest stays held and the kind is logged. */
  #flush(): Promise<boolean> {
    const run = this.#flushing.then(() => this.#flushNow());
    this.#flushing = run;
    return run;
  }

  async #flushNow(): Promise<boolean> {
    const ledger = this.#ledger;
    if (ledger === null) return true;
    for (let next = this.#pending[0]; next !== undefined; next = this.#pending[0]) {
      try {
        if (next.kind === "result") await ledger.recordResult(next.input);
        else await ledger.recordKeyChange(next.key, next.at);
      } catch (error) {
        const what = next.kind === "result" ? "a flashapi result could not be written to the quota log" : "a music key change could not be noted in the quota log";
        this.#deps.log(`studio engine: ${what} (${errorKind(error)})`);
        return false;
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
      this.#task = this.#run({ client, key, id, hadOk: before.hadOkResult, sent: admission.summary.sentInWindow, signal: controller.signal });
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

  async #run(job: { client: ReturnType<typeof createFlashapiClient>; key: string; id: string; hadOk: boolean; sent: number; signal: AbortSignal }): Promise<void> {
    const { key, id } = job;
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
          await this.#record({ id, key, outcome: outcomeOf(error), ...(error.status === null ? {} : { status: error.status }), ...this.#figures(error.response) });
          if (error.kind === "rejected") this.#deps.markKeyRejected(key);
          failure = fail(
            error.kind === "rejected" ? "MUSIC_KEY_REJECTED" : "MUSIC_UNAVAILABLE",
            error.detail,
          );
          if (error.retryAfterMs !== null) failure.error.retryAfterMs = error.retryAfterMs;
        } else {
          await this.#record({ id, key, outcome: "network-error" });
          failure = fail("MUSIC_UNAVAILABLE", redact(error instanceof Error ? error.message : "the request failed"));
        }
      }
      if (failure === null && response !== null && list !== null) {
        await this.#record({ id, key, outcome: "ok", status: response.status, ...this.#figures(response) });
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
  async #record(input: Parameters<QuotaLedger["recordResult"]>[0]): Promise<void> {
    if (this.#ledger === null) return;
    this.#pending.push({ kind: "result", input: { ...input, key: last4(input.key), at: this.#deps.clock() } });
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
