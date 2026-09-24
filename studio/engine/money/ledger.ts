import { access, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { MoneyError } from "./errors";

/** Epoch milliseconds. Injected so tests control time. */
export type Clock = () => number;

/** Integer micro-dollars: 1 USD = 1_000_000. */
export const MicrosSchema = z.int().nonnegative();

/**
 * An id the contract can carry (T0 `AttemptId`: 1-128 visible ASCII chars).
 * Attempt ids end up in the money status and the reconcile result, so one the
 * contract refuses would break every snapshot; the money core may not import
 * the contract, and budget.test.ts pins that both accept the same ids. Every
 * id in a ledger line (attempt, job, scope, model) follows it.
 */
const ATTEMPT_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

export function isAttemptId(id: string): boolean {
  return ATTEMPT_ID_PATTERN.test(id);
}

const IdSchema = z.string().regex(ATTEMPT_ID_PATTERN, "must be 1-128 visible ASCII chars, as the contract carries it");
const AtSchema = z.iso.datetime();

/** Which cap an attempt counts against: a photo run or an avatar job. */
export const ScopeSchema = z.union([
  z.strictObject({ runId: IdSchema }),
  z.strictObject({ avatarJobId: IdSchema }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

// Key order here is the key order on disk.
const ReserveSchema = z.object({
  type: z.literal("reserve"),
  attemptId: IdSchema,
  jobId: IdSchema,
  scope: ScopeSchema,
  model: IdSchema,
  worstMicros: MicrosSchema,
  at: AtSchema,
});
const SettleSchema = z.object({
  type: z.literal("settle"),
  attemptId: IdSchema,
  costMicros: MicrosSchema,
  estimated: z.boolean(),
  at: AtSchema,
});
const ReleaseSchema = z.object({
  type: z.literal("release"),
  attemptId: IdSchema,
  reason: z.string(),
  at: AtSchema,
});
const ReconcileSchema = z.object({
  type: z.literal("reconcile"),
  creditsUsageMicros: MicrosSchema,
  ledgerTotalMicros: MicrosSchema,
  /** Attempts billed above their worst case in the window this marker closes; acknowledged by this reconcile. */
  aboveWorstAttempts: z.array(IdSchema),
  at: AtSchema,
});
const LineSchema = z.discriminatedUnion("type", [ReserveSchema, SettleSchema, ReleaseSchema, ReconcileSchema]);

export type ReserveLine = z.infer<typeof ReserveSchema>;
export type SettleLine = z.infer<typeof SettleSchema>;
export type ReleaseLine = z.infer<typeof ReleaseSchema>;
export type ReconcileLine = z.infer<typeof ReconcileSchema>;
export type LedgerLine = z.infer<typeof LineSchema>;

export interface TornTail {
  /** Byte offset where the torn line starts; repair truncates the ledger to this length. */
  offset: number;
  byteLength: number;
}

/** "r" is used only to open a directory for fsync. */
export type OpenFile = (path: string, flags: "a" | "r+" | "r") => Promise<FileHandle>;

export interface LedgerDeps {
  /** Seam for tests that spy on the FileHandle (write, sync, close). */
  openFile?: OpenFile;
  /** Directory fsync is skipped on win32, where a directory cannot be opened for it. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

const defaultOpenFile: OpenFile = (path, flags) => open(path, flags);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    offset += bytesWritten;
  }
}

/** Appends `data` and fsyncs it before the returned promise resolves. */
async function appendDurably(openFile: OpenFile, path: string, data: Buffer): Promise<void> {
  const handle = await openFile(path, "a");
  try {
    await writeAll(handle, data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Runs async tasks one at a time, in call order. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * The append-only money ledger (JSONL, one line per event, fsynced).
 *
 * The file is the source of truth. Appends are serialized, validated against
 * the lines already present (one reserve per attempt id, at most one close per
 * reserve) and resolve only after `fsync`, so a `reserve` is on disk before
 * its request can leave. A torn last line blocks every append until
 * `moveTornTail` (reconcile) moves it away; a failed write blocks every later
 * append for the life of this object, because the file state is then unknown.
 */
export class Ledger {
  readonly path: string;
  private readonly openFile: OpenFile;
  private readonly queue = new SerialQueue();
  private readonly all: LedgerLine[] = [];
  private readonly reserves = new Map<string, ReserveLine>();
  private readonly closes = new Map<string, SettleLine | ReleaseLine>();
  private tornTail: TornTail | null = null;
  private lastAt: number | null = null;
  private readonly platform: NodeJS.Platform;
  private writeFailed = false;
  private dirReady = false;
  /** False until the file is known to exist; the append that creates it also fsyncs the directory. */
  private fileExists: boolean;

  private constructor(path: string, deps: LedgerDeps, fileExists: boolean) {
    this.path = path;
    this.openFile = deps.openFile ?? defaultOpenFile;
    this.platform = deps.platform ?? process.platform;
    this.fileExists = fileExists;
  }

  /** Loads the ledger. A missing file is an empty ledger; corruption before the last line throws LEDGER_CORRUPT. */
  static async open(path: string, deps: LedgerDeps = {}): Promise<Ledger> {
    let bytes: Buffer | null;
    try {
      bytes = await readFile(path);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      bytes = null;
    }
    const ledger = new Ledger(path, deps, bytes !== null);
    ledger.load(bytes ?? Buffer.alloc(0));
    return ledger;
  }

  get lines(): readonly LedgerLine[] {
    return this.all;
  }

  get torn(): TornTail | null {
    return this.tornTail;
  }

  /** True after a failed write: the file state is unknown and nothing more will be written. */
  get failed(): boolean {
    return this.writeFailed;
  }

  reserveOf(attemptId: string): ReserveLine | undefined {
    return this.reserves.get(attemptId);
  }

  closeOf(attemptId: string): SettleLine | ReleaseLine | undefined {
    return this.closes.get(attemptId);
  }

  /** Reserves with neither a settle nor a release, in ledger order. */
  openReserves(): ReserveLine[] {
    return [...this.reserves.values()].filter((r) => !this.closes.has(r.attemptId));
  }

  /** The latest `at` of any valid line, in epoch ms; null for an empty ledger. */
  lastWriteAt(): number | null {
    return this.lastAt;
  }

  append(line: LedgerLine): Promise<void> {
    return this.queue.run(async () => {
      this.assertWritable();
      const parsed = LineSchema.safeParse(line);
      if (!parsed.success) {
        throw new TypeError(`Invalid ledger line: ${z.prettifyError(parsed.error)}`);
      }
      const violation = this.violationOf(parsed.data);
      if (violation) throw violation;
      await this.guardWrite(async () => {
        await this.ensureDir();
        await appendDurably(this.openFile, this.path, Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8"));
        if (!this.fileExists) {
          await this.syncDir();
          this.fileExists = true;
        }
      });
      this.apply(parsed.data);
    });
  }

  /**
   * Appends the torn last line to `<ledger>.torn` (fsynced), then truncates it
   * from the ledger (fsynced). Returns false when there is nothing to move.
   * The `.torn` copy is written first, so a crash in between duplicates the
   * bytes rather than losing them.
   */
  moveTornTail(): Promise<boolean> {
    return this.queue.run(async () => {
      if (this.writeFailed) throw this.writeFailedError();
      const torn = this.tornTail;
      if (!torn) return false;
      const bytes = await readFile(this.path);
      if (bytes.length !== torn.offset + torn.byteLength) {
        throw new MoneyError("LEDGER_CORRUPT", `${this.path} changed on disk since it was loaded; restart before reconciling`);
      }
      const tail = bytes.subarray(torn.offset);
      const record = tail[tail.length - 1] === 0x0a ? tail : Buffer.concat([tail, Buffer.from("\n")]);
      await this.guardWrite(async () => {
        const tornPath = `${this.path}.torn`;
        const tornExisted = await exists(tornPath);
        await appendDurably(this.openFile, tornPath, record);
        if (!tornExisted) await this.syncDir();
        const handle = await this.openFile(this.path, "r+");
        try {
          await handle.truncate(torn.offset);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
      this.tornTail = null;
      return true;
    });
  }

  private load(bytes: Buffer): void {
    let start = 0;
    let lineNo = 0;
    while (start < bytes.length) {
      lineNo++;
      const newline = bytes.indexOf(0x0a, start);
      const terminated = newline !== -1;
      const end = terminated ? newline : bytes.length;
      const isLast = !terminated || end + 1 >= bytes.length;
      const json = parseJson(bytes.subarray(start, end).toString("utf8"));
      if (!terminated || (!json.ok && isLast)) {
        this.tornTail = { offset: start, byteLength: bytes.length - start };
        return;
      }
      if (!json.ok) throw this.corrupt(lineNo, "is not valid JSON");
      const parsed = LineSchema.safeParse(json.value);
      if (!parsed.success) throw this.corrupt(lineNo, `failed validation: ${z.prettifyError(parsed.error)}`);
      const violation = this.violationOf(parsed.data);
      if (violation) throw this.corrupt(lineNo, violation.message);
      this.apply(parsed.data);
      start = end + 1;
    }
  }

  private violationOf(line: LedgerLine): MoneyError | null {
    if (line.type === "reconcile") return null;
    const { attemptId } = line;
    if (line.type === "reserve") {
      return this.reserves.has(attemptId)
        ? new MoneyError("ATTEMPT_ID_REUSED", `attempt ${attemptId} already has a reserve`)
        : null;
    }
    if (!this.reserves.has(attemptId)) {
      return new MoneyError("UNKNOWN_ATTEMPT", `${line.type} for attempt ${attemptId}, which has no reserve`);
    }
    const closed = this.closes.get(attemptId);
    return closed
      ? new MoneyError("ATTEMPT_CLOSED", `attempt ${attemptId} was already closed by a ${closed.type} at ${closed.at}`)
      : null;
  }

  private apply(line: LedgerLine): void {
    this.all.push(line);
    if (line.type === "reserve") this.reserves.set(line.attemptId, line);
    else if (line.type === "settle" || line.type === "release") this.closes.set(line.attemptId, line);
    const at = Date.parse(line.at);
    if (this.lastAt === null || at > this.lastAt) this.lastAt = at;
  }

  private assertWritable(): void {
    if (this.writeFailed) throw this.writeFailedError();
    if (this.tornTail) {
      throw new MoneyError("LEDGER_TORN", `${this.path} ends with a torn line; reconcile before any paid call`);
    }
  }

  private async guardWrite(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      this.writeFailed = true;
      throw err;
    }
  }

  /** Makes a newly created file's directory entry durable; a no-op on win32. */
  private async syncDir(): Promise<void> {
    if (this.platform === "win32") return;
    const handle = await this.openFile(dirname(this.path), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.dirReady = true;
  }

  private writeFailedError(): MoneyError {
    return new MoneyError("LEDGER_WRITE_FAILED", `an earlier write to ${this.path} failed; restart the app`, { fatal: true });
  }

  private corrupt(lineNo: number, why: string): MoneyError {
    return new MoneyError("LEDGER_CORRUPT", `${this.path}:${lineNo} ${why}`, { fatal: true });
  }
}
