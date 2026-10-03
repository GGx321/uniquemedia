import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { Count, MUSIC_QUOTA_LIMIT, MUSIC_QUOTA_WINDOW_DAYS } from "../../shared/engine";
import { appendJsonLine, fsyncDir, isTempName, readJsonl, tempSiblingPath, writeFileDurable } from "../library/durableFs";
import { LibraryError } from "../library/errors";
import { runExclusive } from "../library/keyedMutex";
import { errorCode, renameWithRetry } from "../library/renameRetry";

// The flashapi quota ledger (invariant 30): an append-only JSONL file in `userData/music/`. A request costs one of 30
// per rolling 31 days on the owner's RapidAPI account, so the count is kept on disk, ahead of the request:
//
// - `send`: written and fsynced BEFORE the request leaves. A crash after it, before the answer, leaves a send with no
//   result, and it counts (the request may have left).
// - `result`: what came back (outcome, HTTP status, the server's own `remaining` and `limit`), never a body.
// - `key`: the owner stored or cleared the key. Written by the engine on a user's set or clear.
//
// The file holds no key and no hash of one: each line tags the key by its LAST FOUR chars, the very four the status
// already shows. That tag is what lets a 401 outlive a restart (`rejectedKey`) without a secret at rest. A last-four
// collision between an old and a new key is between 1 in 65 536 (a key that ends in hex, 16^4) and about 1 in 14.8
// million (an alphanumeric one, 62^4). The consequence is fail-closed only: a fresh key that shares its last four chars
// with a revoked one reads as rejected until the owner stores it again, which clears the mark.
//
// A torn last line (no newline) is a crash inside the append, before the request could leave: it is not a send. It is
// moved aside to `<file>.torn` by the next append (`appendJsonLine`). A complete line that does not parse is not the
// result of a crash, so the ledger refuses to guess the count and the refresh does not leave.
//
// The way out of such a log (3c.6, `recover`, behind the owner's confirmation): the damaged file is copied aside to
// `<file>.corrupt-<time>` and a new log replaces it whose only line, `recovered`, counts as 30 sends made at that moment.
// The quota is therefore closed for exactly 31 days, the reading of a count nobody can trust that can never be too low.
// Each step fails closed: the copy is made first, and the new log replaces the old one in one atomic rename, so a crash
// leaves either the damaged log (still closed) or the new one (closed for 31 days), never an empty one.
//
// A deleted log (review round 1). The log sits in `userData/music/` beside ~100 MB of tracks, so deleting that folder is
// a plausible way to free space, and it would reset the local count. So the first line that counts a request (a `send`,
// a `result`, a `recovered` log) also leaves a marker OUTSIDE `music/` (`quotaMarkerPath`, `userData/.music-quota-started`),
// after the line; a log from an older Studio gets it when read. Key lines alone leave none: nothing to undercount.
// While the marker is there, a log that is gone or holds no complete line is `missing`: it fails closed like a corrupt one,
// no write starts a new log behind the owner's back, and `recover` is the same way out (30 sends at now, 31 days closed).
// Only with no marker (a real first start) does no log read as an empty one.
//
// What deleting the marker as well still costs: the local count starts again from 0, and the only guard left is the
// server's floor. That floor is set ONLY by an answer whose `x-ratelimit-requests-remaining` says 0 (a negative counts as 0);
// a 429 without that header sets none. So with the header the loss is at most one request beyond what the account allows,
// per deletion; without it, nothing local bounds it. On a plan with overage such a request may be billed.

export const QUOTA_LIMIT = MUSIC_QUOTA_LIMIT;
export const QUOTA_WINDOW_MS = MUSIC_QUOTA_WINDOW_DAYS * 24 * 3600 * 1000;

const KEY_TAG = /^[\x21-\x7e]{4}$/;
const KeyTag = z.string().regex(KEY_TAG);
const LineId = z.string().min(1).max(64);
/** A plain file name in the log's own folder (the damaged log's copy): no separator, no path. */
const QuarantineName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
/**
 * A time on a line: epoch ms between 2000 and 2100. A wild one (1970, or past what a `Date` holds) would make a status
 * conversion throw and a window count nonsense, so such a line is corruption and is never written either.
 */
export const CLOCK_MIN_MS = 946_684_800_000;
export const CLOCK_MAX_MS = 4_102_444_800_000;
const EpochMs = Count.min(CLOCK_MIN_MS).max(CLOCK_MAX_MS);

/**
 * The marker that the quota log has existed (review round 1): `userData/.music-quota-started`, OUTSIDE `music/`, so deleting
 * the music folder (100 MB of tracks, a plausible thing to free) does not also forget that requests were sent.
 */
export function quotaMarkerPath(quotaPath: string): string {
  return join(dirname(dirname(quotaPath)), ".music-quota-started");
}

/** Whether a clock reading is a real date the ledger can write (2000 to 2100). NaN, 1970 (a dead RTC battery) and 2101 are not. */
export function clockInRange(at: number): boolean {
  return Number.isFinite(at) && at >= CLOCK_MIN_MS && at <= CLOCK_MAX_MS;
}

export const QUOTA_OUTCOMES = ["ok", "rejected", "http-error", "network-error", "timeout", "too-large", "invalid"] as const;
export type QuotaOutcome = (typeof QUOTA_OUTCOMES)[number];

const QuotaLineSchema = z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("send"), id: LineId, at: EpochMs, key: KeyTag }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("result"),
    id: LineId,
    at: EpochMs,
    key: KeyTag,
    outcome: z.enum(QUOTA_OUTCOMES),
    status: Count.optional(),
    remaining: Count.nullable().optional(),
    limit: Count.nullable().optional(),
    /** The server's own clock (its `Date` header, epoch ms), for clock-skew forensics: a wrong local clock moves the window. */
    serverAt: EpochMs.optional(),
  }),
  z.strictObject({ v: z.literal(1), kind: z.literal("key"), at: EpochMs, key: KeyTag.nullable() }),
  // 3c.6: the first line of a log that replaced a damaged one: `sends` sends made at `at` (the limit, so the quota is
  // closed for 31 days), the name the damaged file was copied to, and the key the engine knew to be rejected then.
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("recovered"),
    at: EpochMs,
    sends: Count.min(1).max(1000),
    // Null when there was no file to put aside (a log that is missing, review round 1).
    quarantined: QuarantineName.nullable(),
    rejectedKey: KeyTag.nullable(),
  }),
]);
export type QuotaLine = z.infer<typeof QuotaLineSchema>;

export interface QuotaSummary {
  /** Sends in the window, a send with no result included. Not clamped: the status clamps it. */
  readonly sentInWindow: number;
  /** When a refused request may leave, else when the oldest send leaves the window; null with nothing in the window. Epoch ms. */
  readonly nextFreeAt: number | null;
  /** The server's own `remaining` from its last answer that carried one, while that answer is inside the window. */
  readonly serverRemaining: number | null;
  /** Why a request is refused now: the local count reached the limit, or the server's last figure was 0. */
  readonly refusal: "quota" | "floor" | null;
  /** The last four chars of the key the last 401 was for, unless a key change or a good answer came after it. Never expires. */
  readonly rejectedKey: string | null;
  /** Any `ok` result was ever recorded: false until the first real refresh has succeeded. */
  readonly hadOkResult: boolean;
}

/**
 * The ledger cannot be read, trusted or written, so no request may leave. `code` never carries a key. `missing`: the log
 * is gone (or holds no complete line) although its marker says Studio wrote it before (review round 1).
 */
export class QuotaLogError extends Error {
  readonly code: "unreadable" | "corrupt" | "unwritable" | "missing";
  constructor(code: QuotaLogError["code"], message: string) {
    super(message);
    this.name = "QuotaLogError";
    this.code = code;
  }
}

/** What the log says at `now`. Pure. A send is in the window while `now < at + 31 days`. */
export function summarize(lines: readonly QuotaLine[], now: number): QuotaSummary {
  const windowStart = now - QUOTA_WINDOW_MS;
  const sendTimes: number[] = [];
  let lastRemaining: { at: number; value: number } | null = null;
  let rejectedKey: string | null = null;
  let hadOkResult = false;
  for (const line of lines) {
    if (line.kind === "send") {
      if (line.at > windowStart) sendTimes.push(line.at);
    } else if (line.kind === "result") {
      if (typeof line.remaining === "number") lastRemaining = { at: line.at, value: line.remaining };
      if (line.outcome === "rejected") rejectedKey = line.key;
      if (line.outcome === "ok") {
        hadOkResult = true;
        if (rejectedKey === line.key) rejectedKey = null;
      }
    } else if (line.kind === "recovered") {
      // A fresh start after a damaged log: its sends, all made at its time, and nothing the damaged log said.
      if (line.at > windowStart) for (let i = 0; i < line.sends; i++) sendTimes.push(line.at);
      lastRemaining = null;
      rejectedKey = line.rejectedKey;
    } else {
      rejectedKey = null;
    }
  }
  sendTimes.sort((a, b) => a - b);
  const sentInWindow = sendTimes.length;
  const floorLiftsAt = lastRemaining !== null && lastRemaining.value === 0 ? lastRemaining.at + QUOTA_WINDOW_MS : null;
  const floorActive = floorLiftsAt !== null && now < floorLiftsAt;
  const countBlocked = sentInWindow >= QUOTA_LIMIT;
  // When the count is at or over the limit, a slot opens once enough of the oldest sends have left: with exactly 30 it
  // is the oldest, with 31 the second oldest.
  const countLiftsAt = countBlocked ? (sendTimes[sentInWindow - QUOTA_LIMIT] ?? 0) + QUOTA_WINDOW_MS : null;
  const blockedUntil = [countBlocked ? countLiftsAt : null, floorActive ? floorLiftsAt : null].filter((t): t is number => t !== null);
  const oldest = sendTimes[0];
  const nextFreeAt = blockedUntil.length > 0 ? Math.max(...blockedUntil) : oldest === undefined ? null : oldest + QUOTA_WINDOW_MS;
  return {
    sentInWindow,
    nextFreeAt,
    serverRemaining: lastRemaining !== null && lastRemaining.at > windowStart ? lastRemaining.value : null,
    refusal: countBlocked ? "quota" : floorActive ? "floor" : null,
    rejectedKey,
    hadOkResult,
  };
}

/** `at` on an admitted request is the moment its `send` line was written. */
export type Admission = { ok: true; summary: QuotaSummary; at: number } | { ok: false; refusal: "quota" | "floor"; summary: QuotaSummary };

/**
 * What `recover` did: the damaged log was put aside (`quarantined`, a name in the log's folder; null for a missing log with
 * no file to keep) and the new one counts as the limit spent now; or why nothing changed: the log is sound (or a fresh,
 * absent one), cannot be read at all, or the clock is not a real date the new log could be dated with.
 */
export type Recovery = { ok: true; summary: QuotaSummary; quarantined: string | null } | { ok: false; refusal: "not-corrupt" | "unreadable" | "clock" };

/**
 * Whether a line counts a request (round-2 verify): a `send`, the `result` that always follows one, or a `recovered` log's
 * closed quota. Only such a line leaves the marker: a log of key lines alone cannot undercount anything, so losing it
 * must not cost a 31-day lockout.
 */
function countsRequests(line: QuotaLine): boolean {
  return line.kind === "send" || line.kind === "result" || line.kind === "recovered";
}

/** A crash in the swap leaves the new log's temp beside it (`.quota.jsonl.<hex>.tmp`, durableFs `tempSiblingPath`). */
function isLogTemp(name: string, log: string): boolean {
  return name.startsWith(`.${log}.`) && isTempName(name);
}

/** What a damaged log's readable lines still say: the last 401's key tag, and its latest time (a clock that stepped back). */
function stillReadable(bytes: Uint8Array, now: number): { rejectedKey: string | null; latestAt: number | null } {
  const lines: QuotaLine[] = [];
  const complete = new TextDecoder().decode(bytes).split("\n").slice(0, -1);
  for (const raw of complete) {
    try {
      const parsed = QuotaLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
    } catch {
      // A line that does not parse says nothing.
    }
  }
  const latestAt = lines.reduce<number | null>((latest, line) => (latest === null || line.at > latest ? line.at : latest), null);
  return { rejectedKey: summarize(lines, now).rejectedKey, latestAt };
}

export interface QuotaLedgerOptions {
  clock: () => number;
  /** Test seam: syncs a folder after it gained an entry; `fsyncDir` (a no-op on Windows) by default. */
  syncDir?: (dir: string) => Promise<void>;
  /** Test seam: runs in `recover` after the damaged log was copied aside and before the new log replaces it. Throw to play a crash there. */
  beforeReplace?: () => Promise<void>;
}

/** How many copies of a damaged log one second may hold before `recover` gives up on a free name. */
const MAX_QUARANTINE_TRIES = 100;

/** `20261003T101500Z`: a moment as a file name can carry it, to the second, in UTC. */
function fileStamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * Windows' `mkdir` answers a folder it made as `\\?\C:\...`, or `\\?\UNC\server\share\...` for a network share; the
 * folder to sync is named without that prefix (a UNC one back as `\\server\share\...`, never as a relative path).
 */
export function withoutLongPathPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function assertKeyTag(key: string | null): void {
  if (key !== null && !KEY_TAG.test(key)) throw new TypeError("the quota log takes the last four chars of a key, never the key");
}

export class QuotaLedger {
  readonly #path: string;
  readonly #marker: string;
  readonly #clock: () => number;
  readonly #syncDir: (dir: string) => Promise<void>;
  readonly #beforeReplace: (() => Promise<void>) | undefined;
  /** The marker is known to be on disk: it is never removed by Studio, so it is not looked for again. */
  #markerSeen = false;
  /** The temps a crashed swap left were swept (once, at the first read). */
  #swept = false;

  constructor(path: string, options: QuotaLedgerOptions) {
    this.#path = path;
    this.#marker = quotaMarkerPath(path);
    this.#clock = options.clock;
    this.#syncDir = options.syncDir ?? fsyncDir;
    this.#beforeReplace = options.beforeReplace;
  }

  /** Whether the marker says the log existed. A marker that cannot be looked at counts as there: the money side fails closed. */
  async #markerExists(): Promise<boolean> {
    if (this.#markerSeen) return true;
    try {
      await stat(this.#marker);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
    }
    this.#markerSeen = true;
    return true;
  }

  /** Leaves the marker once a log line is on disk (or a log from an older Studio was read). Best effort: a failure only weakens the check. */
  async #ensureMarker(): Promise<void> {
    if (this.#markerSeen) return;
    try {
      await writeFileDurable(this.#marker, `${JSON.stringify({ v: 1, since: new Date(this.#clock()).toISOString() })}\n`);
      // Not through the `syncDir` seam: that one is the log's own folders, and the marker is best effort anyway.
      await fsyncDir(dirname(this.#marker)).catch(() => undefined);
      this.#markerSeen = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") this.#markerSeen = true;
    }
  }

  /** Removes the temps a crash in `recover`'s swap left beside the log (only the log's own: `.quota.jsonl.<hex>.tmp`). Best effort. */
  async #sweepTemps(): Promise<void> {
    if (this.#swept) return;
    this.#swept = true;
    const folder = dirname(this.#path);
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) if (isLogTemp(name, basename(this.#path))) await rm(join(folder, name), { force: true }).catch(() => undefined);
  }

  async #load(): Promise<QuotaLine[]> {
    await this.#sweepTemps();
    let entries: QuotaLine[];
    try {
      entries = (await readJsonl(this.#path, QuotaLineSchema)).entries;
    } catch (error) {
      if (error instanceof LibraryError) throw new QuotaLogError("corrupt", "the quota log has a line that cannot be read, so the request count cannot be trusted");
      throw new QuotaLogError("unreadable", `the quota log could not be read (${errorCode(error) ?? "unknown"})`);
    }
    if (entries.length === 0) {
      // No line, and yet the marker says Studio wrote one: the log (or the music folder) was deleted or emptied, and its
      // count with it. Never read as a fresh start.
      if (await this.#markerExists()) throw new QuotaLogError("missing", "the quota log is gone although requests were sent before, so the request count cannot be trusted");
      return entries;
    }
    // A log from an older Studio gets its marker here, once it holds a line that counts a request.
    if (entries.some(countsRequests)) await this.#ensureMarker();
    return entries;
  }

  /** Makes the log's folder (and every level it had to create) durable in its parent. A folder that cannot be synced only weakens this. */
  async #makeFolder(): Promise<void> {
    const folder = dirname(this.#path);
    const made = await mkdir(folder, { recursive: true });
    // Every folder this call created made its parent gain an entry: make each durable, or a power loss could take a
    // folder (and the send line inside it) although the file itself was fsynced. `made` is the FIRST one created, so
    // the levels are walked from `folder` up to it.
    if (made === undefined) return;
    const first = withoutLongPathPrefix(made);
    for (let level = folder; ; level = dirname(level)) {
      await this.#syncDir(dirname(level)).catch(() => undefined);
      if (level === first || dirname(level) === level) break;
    }
  }

  async #append(candidate: QuotaLine): Promise<void> {
    // Read back through the very schema the ledger loads with: a line this code could write but not read would close
    // the ledger for good (a complete unreadable line is corruption), so it is never written.
    const line = QuotaLineSchema.parse(candidate);
    // A log that is gone while its marker is there is not started again by a write (a re-entered key, a held result):
    // that would be a fresh count behind the owner's back. Only `recover` starts a new one.
    const text = await readFile(this.#path, "utf8").catch((error: unknown) => (errorCode(error) === "ENOENT" ? "" : null));
    if (text !== null && !text.includes("\n") && (await this.#markerExists())) {
      throw new QuotaLogError("missing", "the quota log is gone although requests were sent before; nothing was written");
    }
    try {
      await this.#makeFolder();
      await appendJsonLine(this.#path, line);
    } catch (error) {
      throw new QuotaLogError("unwritable", `the quota log could not be written (${errorCode(error) ?? "unknown"})`);
    }
    // The line first, then the marker, and only for a line that counts a request.
    if (countsRequests(line)) await this.#ensureMarker();
  }

  /**
   * A held line's own time, never after the ledger's clock: a floor only counts from a moment that has passed, and a
   * clock that stepped back between the caller's read and this one must not make the write throw and lose the line.
   */
  #clampAt(at: number | undefined): number {
    const now = this.#clock();
    return at === undefined ? now : Math.min(at, now);
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    return runExclusive(`quota:${this.#path}`, task);
  }

  /** What the log says now. Throws `QuotaLogError` when it cannot be read or trusted. */
  summary(): Promise<QuotaSummary> {
    return this.#exclusive(async () => summarize(await this.#load(), this.#clock()));
  }

  /**
   * What the log would say with `held` appended after it, in order: lines the service has not managed to write yet.
   * Writes nothing. The status and the rejected-key check use it, so a floor or a 401 that is only held still counts.
   */
  summaryWith(held: readonly QuotaLine[]): Promise<QuotaSummary> {
    return this.#exclusive(async () => summarize([...(await this.#load()), ...held], this.#clock()));
  }

  /**
   * Asks to send one request: counts what the log holds and, when the count and the server's floor allow it, appends
   * the `send` line (fsynced) BEFORE answering. The check and the append are one step, so two callers cannot both take
   * the last slot. A refusal writes nothing. `key` is the key's last four chars.
   */
  async reserve(input: { id: string; key: string }): Promise<Admission> {
    assertKeyTag(input.key);
    return this.#exclusive(async () => {
      const lines = await this.#load();
      const now = this.#clock();
      const before = summarize(lines, now);
      if (before.refusal !== null) return { ok: false, refusal: before.refusal, summary: before };
      const line: QuotaLine = { v: 1, kind: "send", id: input.id, at: now, key: input.key };
      await this.#append(line);
      return { ok: true, summary: summarize([...lines, line], now), at: now };
    });
  }

  /**
   * What came back for `id`: its outcome, status and the server's own figures. Never a body. `at` is for a line the
   * service held and writes later (the moment the answer came); it is clamped to the ledger's own clock, so no caller
   * can date a floor into the future.
   */
  async recordResult(input: { id: string; key: string; outcome: QuotaOutcome; status?: number; remaining?: number | null; limit?: number | null; serverAt?: number; at?: number }): Promise<void> {
    assertKeyTag(input.key);
    return await this.#exclusive(() =>
      this.#append({
        v: 1,
        kind: "result",
        id: input.id,
        // A held line (see the service) keeps the moment its answer came, so the floor's 31 days count from then.
        at: this.#clampAt(input.at),
        key: input.key,
        outcome: input.outcome,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.remaining === undefined ? {} : { remaining: input.remaining }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.serverAt === undefined ? {} : { serverAt: input.serverAt }),
      }),
    );
  }

  /** The owner stored (`last4`) or cleared (null) the key: an older 401 no longer applies to it. */
  async recordKeyChange(key: string | null, at?: number): Promise<void> {
    assertKeyTag(key);
    return await this.#exclusive(() => this.#append({ v: 1, kind: "key", at: this.#clampAt(at), key }));
  }

  /**
   * The way out of a damaged log (3c.6), for the owner's confirmed request only. When, and only when, the log holds a
   * complete line that cannot be read, or is `missing` (gone or empty while its marker says it existed, review round 1):
   * copies the file (if there is one) aside, byte for byte, to `<file>.corrupt-<time>` (fsynced, a name of its own), then
   * puts in its place, in one atomic rename, a new log whose only line counts as the limit spent at the later of now and
   * the latest time a readable line of the damaged log names (a clock that stepped back must not reopen early). The line
   * carries `rejectedKey` (the last four chars of a key the caller knows to be rejected), else the last 401 the readable
   * lines name: it can only add a refusal. A sound or fresh log, one that cannot be read at all, and a clock that is not a
   * real date change nothing. A write that fails before the rename throws `QuotaLogError("unwritable")` and leaves the
   * damaged log as the log (still closed); the folder's sync after the rename is best effort, like every folder sync here.
   */
  async recover(input: { rejectedKey: string | null }): Promise<Recovery> {
    assertKeyTag(input.rejectedKey);
    return this.#exclusive(async () => {
      try {
        await this.#load();
        return { ok: false, refusal: "not-corrupt" };
      } catch (error) {
        if (!(error instanceof QuotaLogError) || (error.code !== "corrupt" && error.code !== "missing")) return { ok: false, refusal: "unreadable" };
      }
      const now = this.#clock();
      if (!clockInRange(now)) return { ok: false, refusal: "clock" };
      let damaged: Buffer | null;
      try {
        damaged = await readFile(this.#path);
      } catch (error) {
        // A missing log may have no file at all (the music folder deleted): there is nothing to put aside.
        if (errorCode(error) !== "ENOENT") return { ok: false, refusal: "unreadable" };
        damaged = null;
      }
      const readable = damaged === null ? { rejectedKey: null, latestAt: null } : stillReadable(damaged, now);
      const at = Math.max(now, readable.latestAt ?? now);
      const folder = dirname(this.#path);
      const temp = tempSiblingPath(this.#path);
      let line: QuotaLine;
      try {
        await this.#makeFolder();
        const quarantined = damaged === null ? null : await this.#copyAside(damaged, now);
        line = QuotaLineSchema.parse({ v: 1, kind: "recovered", at, sends: QUOTA_LIMIT, quarantined, rejectedKey: input.rejectedKey ?? readable.rejectedKey });
        await this.#beforeReplace?.();
        await writeFileDurable(temp, `${JSON.stringify(line)}\n`);
        await renameWithRetry(temp, this.#path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new QuotaLogError("unwritable", `the quota log could not be recovered (${errorCode(error) ?? "unknown"})`);
      }
      // The new log IS the log from here on: the rename's entry is synced, and a folder that cannot be synced only weakens it.
      await this.#syncDir(folder).catch(() => undefined);
      await this.#ensureMarker();
      return { ok: true, quarantined: line.kind === "recovered" ? line.quarantined : null, summary: summarize([line], now) };
    });
  }

  /** Writes `bytes` to a new file beside the log, named for `at` (`-2`, `-3` ... when that second is taken), and makes it durable. */
  async #copyAside(bytes: Uint8Array, at: number): Promise<string> {
    const folder = dirname(this.#path);
    const base = `${basename(this.#path)}.corrupt-${fileStamp(at)}`;
    for (let n = 1; n <= MAX_QUARANTINE_TRIES; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      try {
        await writeFileDurable(join(folder, name), bytes);
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw error;
      }
      // The copy's entry in the folder: a folder that cannot be synced only weakens this, as for a new log's folder.
      await this.#syncDir(folder).catch(() => undefined);
      return name;
    }
    throw Object.assign(new Error("no free name for the damaged quota log"), { code: "EEXIST" });
  }
}
