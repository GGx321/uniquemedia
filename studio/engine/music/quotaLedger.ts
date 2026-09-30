import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { Count, MUSIC_QUOTA_LIMIT, MUSIC_QUOTA_WINDOW_DAYS } from "../../shared/engine";
import { appendJsonLine, fsyncDir, readJsonl } from "../library/durableFs";
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

export const QUOTA_LIMIT = MUSIC_QUOTA_LIMIT;
export const QUOTA_WINDOW_MS = MUSIC_QUOTA_WINDOW_DAYS * 24 * 3600 * 1000;

const KEY_TAG = /^[\x21-\x7e]{4}$/;
const KeyTag = z.string().regex(KEY_TAG);
const LineId = z.string().min(1).max(64);
/**
 * A time on a line: epoch ms between 2000 and 2100. A wild one (1970, or past what a `Date` holds) would make a status
 * conversion throw and a window count nonsense, so such a line is corruption and is never written either.
 */
const EpochMs = Count.min(946_684_800_000).max(4_102_444_800_000);

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

export type Admission = { ok: true; summary: QuotaSummary } | { ok: false; refusal: "quota" | "floor"; summary: QuotaSummary };

export interface QuotaLedgerOptions {
  clock: () => number;
  /** Test seam: syncs a folder after it gained an entry; `fsyncDir` (a no-op on Windows) by default. */
  syncDir?: (dir: string) => Promise<void>;
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

  constructor(path: string, options: QuotaLedgerOptions) {
    this.#path = path;
    this.#clock = options.clock;
    this.#syncDir = options.syncDir ?? fsyncDir;
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

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    return runExclusive(`quota:${this.#path}`, task);
  }

  /** What the log says now. Throws `QuotaLogError` when it cannot be read or trusted. */
  summary(): Promise<QuotaSummary> {
    return this.#exclusive(async () => summarize(await this.#load(), this.#clock()));
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
      return { ok: true, summary: summarize([...lines, line], now) };
    });
  }

  /** What came back for `id`: its outcome, status and the server's own figures. Never a body. */
  async recordResult(input: { id: string; key: string; outcome: QuotaOutcome; status?: number; remaining?: number | null; limit?: number | null; serverAt?: number; at?: number }): Promise<void> {
    assertKeyTag(input.key);
    return await this.#exclusive(() =>
      this.#append({
        v: 1,
        kind: "result",
        id: input.id,
        // A held line (see the service) keeps the moment its answer came, so the floor's 31 days count from then.
        at: input.at ?? this.#clock(),
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
    return await this.#exclusive(() => this.#append({ v: 1, kind: "key", at: at ?? this.#clock(), key }));
  }
}
