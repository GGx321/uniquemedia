import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { Count, MUSIC_QUOTA_LIMIT, MUSIC_QUOTA_WINDOW_DAYS } from "../../shared/engine";
import { appendJsonLine, fsyncDir, readJsonl, writeFileAtomic, writeFileDurable } from "../library/durableFs";
import { LibraryError } from "../library/errors";
import { runExclusive } from "../library/keyedMutex";
import { errorCode } from "../library/renameRetry";

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
// Deleting the log by hand resets the local count to 0: the ledger cannot tell a deleted log from a first start. What
// still holds is the server's own count. The first request after a deletion leaves, and if flashapi answers that no
// requests remain (`remaining` 0, a 429 above all) the floor closes the next 31 days again. So a deletion costs at most
// one request beyond what the account allows, per deletion; on a plan with overage that one request may be billed.

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
    quarantined: QuarantineName,
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

/** The ledger cannot be read, trusted or written, so no request may leave. `code` never carries a key. */
export class QuotaLogError extends Error {
  readonly code: "unreadable" | "corrupt" | "unwritable";
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
 * What `recover` did: the damaged log was put aside (`quarantined`, a name in the log's folder) and the new one counts as
 * the limit spent now; or why nothing changed: the log is sound (or absent), cannot be read at all, or the clock is not
 * a real date the new log could be dated with.
 */
export type Recovery = { ok: true; summary: QuotaSummary; quarantined: string } | { ok: false; refusal: "not-corrupt" | "unreadable" | "clock" };

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
  readonly #clock: () => number;
  readonly #syncDir: (dir: string) => Promise<void>;
  readonly #beforeReplace: (() => Promise<void>) | undefined;

  constructor(path: string, options: QuotaLedgerOptions) {
    this.#path = path;
    this.#clock = options.clock;
    this.#syncDir = options.syncDir ?? fsyncDir;
    this.#beforeReplace = options.beforeReplace;
  }

  async #load(): Promise<QuotaLine[]> {
    try {
      return (await readJsonl(this.#path, QuotaLineSchema)).entries;
    } catch (error) {
      if (error instanceof LibraryError) throw new QuotaLogError("corrupt", "the quota log has a line that cannot be read, so the request count cannot be trusted");
      throw new QuotaLogError("unreadable", `the quota log could not be read (${errorCode(error) ?? "unknown"})`);
    }
  }

  async #append(candidate: QuotaLine): Promise<void> {
    // Read back through the very schema the ledger loads with: a line this code could write but not read would close
    // the ledger for good (a complete unreadable line is corruption), so it is never written.
    const line = QuotaLineSchema.parse(candidate);
    try {
      const folder = dirname(this.#path);
      const made = await mkdir(folder, { recursive: true });
      // Every folder this call created made its parent gain an entry: make each durable, or a power loss could take a
      // folder (and the send line inside it) although the file itself was fsynced. `made` is the FIRST one created, so
      // the levels are walked from `folder` up to it. A folder that cannot be synced only weakens this.
      if (made !== undefined) {
        const first = withoutLongPathPrefix(made);
        for (let level = folder; ; level = dirname(level)) {
          await this.#syncDir(dirname(level)).catch(() => undefined);
          if (level === first || dirname(level) === level) break;
        }
      }
      await appendJsonLine(this.#path, line);
    } catch (error) {
      throw new QuotaLogError("unwritable", `the quota log could not be written (${errorCode(error) ?? "unknown"})`);
    }
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
   * complete line that cannot be read: copies the file aside, byte for byte, to `<file>.corrupt-<time>` (fsynced, a name
   * of its own), then replaces the log in one atomic rename with a new one whose only line counts as the limit spent NOW,
   * carrying `rejectedKey` (the last four chars of a key the caller knows to be rejected, or null). A sound or absent log,
   * one that cannot be read at all, and a clock that is not a real date change nothing. A write that fails throws
   * `QuotaLogError("unwritable")` and leaves the damaged log as the log: still closed, and the copy may stay behind.
   */
  async recover(input: { rejectedKey: string | null }): Promise<Recovery> {
    assertKeyTag(input.rejectedKey);
    return this.#exclusive(async () => {
      try {
        await this.#load();
        return { ok: false, refusal: "not-corrupt" };
      } catch (error) {
        if (!(error instanceof QuotaLogError) || error.code !== "corrupt") return { ok: false, refusal: "unreadable" };
      }
      const now = this.#clock();
      if (!clockInRange(now)) return { ok: false, refusal: "clock" };
      let damaged: Buffer;
      try {
        damaged = await readFile(this.#path);
      } catch {
        return { ok: false, refusal: "unreadable" };
      }
      try {
        const quarantined = await this.#copyAside(damaged, now);
        const line = QuotaLineSchema.parse({ v: 1, kind: "recovered", at: now, sends: QUOTA_LIMIT, quarantined, rejectedKey: input.rejectedKey });
        await this.#beforeReplace?.();
        await writeFileAtomic(this.#path, `${JSON.stringify(line)}\n`);
        return { ok: true, quarantined, summary: summarize([line], now) };
      } catch (error) {
        throw new QuotaLogError("unwritable", `the quota log could not be recovered (${errorCode(error) ?? "unknown"})`);
      }
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
