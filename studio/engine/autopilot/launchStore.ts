import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { LogLine, type UnreadableLaunch } from "../../shared/engine/autopilot";
import { LaunchId } from "../../shared/engine/primitives";
import { appendJsonLine, fsyncDir, hasErrorCode, isTempName, readRecordFile, writeFileAtomic, writeJsonAtomic } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";
import { isFromNewerVersion } from "../library/layout";
import { Quarantine, QuarantineNotFlushed } from "../library/quarantine";
import { isEnded, LAUNCH_FILE_SCHEMA_VERSION, LaunchFile } from "./launchFile";

// Stage 4 (plan §3.3, §3.6, §9, §19): the launch store, `<library>/autopilot/`. One file per launch, `<launchId>.json`, rewritten whole (temp, fsync, rename) with a growing
// revision; beside it an append-only `<launchId>.log.jsonl` for the «Журнал», bounded. Reads are strict: a file that is not a launch of this build is an UNREADABLE ENTRY,
// named by an opaque id of its file name (`entryIdOf`), listed, kept as it is, and counted as an unfinished launch by the lookup (fail closed: it may describe an active one)
// until the owner moves it to the quarantine (`removeUnreadable`). Every write and read of one library goes through one queue, so a scan never sweeps a temp file a write
// is still renaming, and a read sees every write that was asked for before it.

export const AUTOPILOT_DIR = "autopilot";
/** The «Журнал» file is cut back to its newest `LOG_KEEP_LINES` once it passes `LOG_MAX_LINES` (plan §3.3). */
export const LOG_MAX_LINES = 5_000;
export const LOG_KEEP_LINES = 4_000;

/** The quarantine's own name rule (`music/quotaLedger.ts` `QuarantineName`): a plain file name, never a path. */
const QUARANTINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LAUNCH_FILE_NAME = /^launch-[a-z0-9][a-z0-9-]{7,56}\.json$/;

export type UnreadableEntry = UnreadableLaunch & { name: string };

export interface StoreScan {
  /** Newest first. */
  launches: LaunchFile[];
  unreadable: UnreadableEntry[];
  /** The folder itself could not be listed: it is one unreadable entry, and every launch id reads as unfinished. */
  folderUnreadable: boolean;
}

export type ReadLaunch = { ok: true; file: LaunchFile } | { ok: false; reason: "missing" | "unreadable" | "io-error" };

export class LaunchStoreError extends Error {
  constructor(
    readonly code: "missing" | "unreadable" | "exists" | "invalid" | "io",
    message: string,
  ) {
    super(message);
    this.name = "LaunchStoreError";
  }
}

export interface LaunchStoreDeps {
  now?: () => Date;
  /** Test seams, as the scene set store's: they run around the rename of every rewrite. */
  beforeRename?: (finalPath: string) => void | Promise<void>;
  afterRename?: (finalPath: string) => void | Promise<void>;
  logMaxLines?: number;
  logKeepLines?: number;
  /** Test seam: how the library root is flushed after the `autopilot/` folder is made (durableFs.fsyncDir). */
  fsyncDir?: (dir: string) => Promise<void>;
}

/** 16 hex characters of the sha256 of a file name: what the renderer is given and sends back instead of a name or a path. */
export function entryIdOf(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

type Parsed = { kind: "ok"; file: LaunchFile } | { kind: "bad"; reason: UnreadableEntry["reason"] } | { kind: "gone" };

export class LaunchStore {
  readonly dir: string;
  readonly #now: () => Date;
  readonly #deps: LaunchStoreDeps;
  readonly #queue: string;
  /** The index the lookup reads synchronously: as of the last scan or write of this store. */
  #statuses = new Map<string, LaunchFile["status"]>();
  #unreadable: UnreadableEntry[] = [];
  #folderUnreadable = false;
  readonly #logCounts = new Map<string, number>();

  constructor(
    readonly root: string,
    deps: LaunchStoreDeps = {},
  ) {
    this.dir = join(root, AUTOPILOT_DIR);
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#queue = `launch-store:${root}`;
  }

  #pathOf(launchId: string): string {
    if (!LaunchId.safeParse(launchId).success) throw new LaunchStoreError("invalid", "a launch id is launch- and a plain name");
    return join(this.dir, `${launchId}.json`);
  }

  #logPathOf(launchId: string): string {
    this.#pathOf(launchId);
    return join(this.dir, `${launchId}.log.jsonl`);
  }

  /** Makes `autopilot/` and, when it is new, flushes the library root so the new entry survives a crash (the file's own flush covers the folder). */
  async #ensureDir(): Promise<void> {
    const made = await mkdir(this.dir, { recursive: true });
    if (made !== undefined) await (this.#deps.fsyncDir ?? fsyncDir)(this.root);
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    return runExclusive(this.#queue, work);
  }

  // ---------- reads ----------

  /** Reads every entry of the folder afresh, sweeps the temp files a crash left, and replaces the index. Never throws. */
  scan(): Promise<StoreScan> {
    return this.#run(() => this.#scan());
  }

  async #scan(): Promise<StoreScan> {
    let names: { name: string; isFile: boolean }[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        this.#adopt([], [], false);
        return { launches: [], unreadable: [], folderUnreadable: false };
      }
      const folder: UnreadableEntry = { entryId: entryIdOf(AUTOPILOT_DIR), name: AUTOPILOT_DIR, reason: "io-error", scope: "folder" };
      this.#adopt([], [folder], true);
      return { launches: [], unreadable: [folder], folderUnreadable: true };
    }
    // A temp file is the remains of a write that was cut: nothing was renamed to it. Writes of this store are in the same queue, so none is in progress.
    for (const { name } of names.filter((n) => isTempName(n.name))) await rm(join(this.dir, name), { force: true }).catch(() => undefined);
    const launches: LaunchFile[] = [];
    const unreadable: UnreadableEntry[] = [];
    for (const { name } of names.filter((n) => n.isFile && !isTempName(n.name) && n.name.endsWith(".json")).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const parsed = await this.#parse(name);
      if (parsed.kind === "ok") launches.push(parsed.file);
      else if (parsed.kind === "bad") unreadable.push({ entryId: entryIdOf(name), name, reason: parsed.reason, ...(parsed.reason === "io-error" ? { scope: "file" as const } : {}) });
    }
    launches.sort((a, b) => (a.createdAt === b.createdAt ? (a.launchId < b.launchId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    this.#adopt(launches, unreadable, false);
    return { launches, unreadable, folderUnreadable: false };
  }

  async #parse(name: string): Promise<Parsed> {
    const read = await readRecordFile(join(this.dir, name));
    if (!read.ok) return read.reason === "missing" ? { kind: "gone" } : { kind: "bad", reason: read.reason === "io" ? "io-error" : "invalid" };
    if (isFromNewerVersion(read.value, LAUNCH_FILE_SCHEMA_VERSION)) return { kind: "bad", reason: "too-new" };
    const parsed = LaunchFile.safeParse(read.value);
    // The name is the launch's id: a file filed under another name is not trusted for its place.
    if (!parsed.success || `${parsed.data.launchId}.json` !== name || !LAUNCH_FILE_NAME.test(name)) return { kind: "bad", reason: "invalid" };
    return { kind: "ok", file: parsed.data };
  }

  #adopt(launches: readonly LaunchFile[], unreadable: readonly UnreadableEntry[], folderUnreadable: boolean): void {
    this.#statuses = new Map(launches.map((l) => [l.launchId, l.status]));
    this.#unreadable = [...unreadable];
    this.#folderUnreadable = folderUnreadable;
  }

  async read(launchId: string): Promise<ReadLaunch> {
    this.#pathOf(launchId);
    return this.#run(async () => {
      const parsed = await this.#parse(`${launchId}.json`);
      if (parsed.kind === "ok") return { ok: true, file: parsed.file } as const;
      if (parsed.kind === "gone") return { ok: false, reason: "missing" } as const;
      return { ok: false, reason: parsed.reason === "io-error" ? "io-error" : "unreadable" } as const;
    });
  }

  // ---------- writes ----------

  #write(file: LaunchFile): Promise<void> {
    return writeJsonAtomic(this.#pathOf(file.launchId), file, {
      ...(this.#deps.beforeRename === undefined ? {} : { beforeRename: this.#deps.beforeRename }),
      ...(this.#deps.afterRename === undefined ? {} : { afterRename: this.#deps.afterRename }),
    });
  }

  /** Writes a launch at revision 1. `exists` for an id that has a file (it is left as it is). */
  async create(file: Omit<LaunchFile, "schemaVersion" | "revision" | "updatedAt">): Promise<LaunchFile> {
    const path = this.#pathOf(file.launchId);
    return this.#run(async () => {
      const found = await lstat(path).then(
        () => true,
        (error: unknown) => {
          if (hasErrorCode(error, "ENOENT")) return false;
          throw new LaunchStoreError("io", "the launch file could not be looked at");
        },
      );
      if (found) throw new LaunchStoreError("exists", `launch ${file.launchId} already has a file`);
      const parsed = LaunchFile.safeParse({ ...file, schemaVersion: LAUNCH_FILE_SCHEMA_VERSION, revision: 1, updatedAt: file.createdAt });
      if (!parsed.success) throw new LaunchStoreError("invalid", `the launch does not fit its schema: ${parsed.error.message}`);
      await this.#ensureDir();
      await this.#write(parsed.data);
      this.#statuses.set(parsed.data.launchId, parsed.data.status);
      return parsed.data;
    });
  }

  /**
   * Under the queue: reads the launch, hands it to `change`, and writes what comes back whole at the next revision (a write time that never goes before the file's own).
   * `null` writes nothing. The launch's id and creation time cannot be changed. `missing` / `unreadable` / `io` when the file cannot be the base of a rewrite; `invalid`
   * when the result breaks the schema (the file keeps what it had).
   */
  async update(launchId: string, change: (current: LaunchFile) => LaunchFile | null): Promise<LaunchFile> {
    this.#pathOf(launchId);
    return this.#run(async () => {
      const parsed = await this.#parse(`${launchId}.json`);
      if (parsed.kind === "gone") throw new LaunchStoreError("missing", `launch ${launchId} has no file`);
      if (parsed.kind === "bad") throw new LaunchStoreError(parsed.reason === "io-error" ? "io" : "unreadable", `launch ${launchId}'s file cannot be read`);
      const current = parsed.file;
      const next = change(current);
      if (next === null) return current;
      const now = this.#now().toISOString();
      const stamped = LaunchFile.safeParse({
        ...next,
        launchId: current.launchId,
        createdAt: current.createdAt,
        schemaVersion: LAUNCH_FILE_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: now > current.updatedAt ? now : current.updatedAt,
      });
      if (!stamped.success) throw new LaunchStoreError("invalid", `the rewrite of launch ${launchId} does not fit its schema: ${stamped.error.message}`);
      await this.#write(stamped.data);
      this.#statuses.set(launchId, stamped.data.status);
      return stamped.data;
    });
  }

  // ---------- the log ----------

  async appendLog(launchId: string, line: LogLine): Promise<void> {
    const path = this.#logPathOf(launchId);
    const parsed = LogLine.safeParse(line);
    if (!parsed.success) throw new LaunchStoreError("invalid", "the log line does not fit the contract");
    return this.#run(async () => {
      await this.#ensureDir();
      await appendJsonLine(path, parsed.data);
      const max = this.#deps.logMaxLines ?? LOG_MAX_LINES;
      const keep = this.#deps.logKeepLines ?? LOG_KEEP_LINES;
      const known = this.#logCounts.get(launchId);
      const count = known === undefined ? (await readLines(path)).length : known + 1;
      this.#logCounts.set(launchId, count);
      if (count <= max) return;
      const kept = (await readLines(path)).slice(-keep);
      await writeFileAtomic(path, `${kept.join("\n")}\n`);
      this.#logCounts.set(launchId, kept.length);
    });
  }

  /** The newest `limit` lines that fit the contract, oldest first; a line that does not is left out. A launch with no log reads as empty. */
  async readLog(launchId: string, limit: number): Promise<LogLine[]> {
    const path = this.#logPathOf(launchId);
    return this.#run(async () => {
      const lines: LogLine[] = [];
      for (const text of await readLines(path)) {
        try {
          const parsed = LogLine.safeParse(JSON.parse(text));
          if (parsed.success) lines.push(parsed.data);
        } catch {
          // A torn or foreign line: left out.
        }
      }
      return limit <= 0 ? [] : lines.slice(-limit);
    });
  }

  // ---------- unreadable entries ----------

  /**
   * Moves the unreadable entry named by `entryId` to the library's quarantine (nothing is deleted). Re-lists the folder itself: the id must match a plain file directly
   * in it whose name is a plain name, and that file must STILL not read as a launch; anything else moves nothing and answers false.
   */
  removeUnreadable(entryId: string): Promise<boolean> {
    return this.#run(async () => {
      const scan = await this.#scan();
      const entry = scan.unreadable.find((e) => e.entryId === entryId);
      if (entry === undefined || scan.folderUnreadable || !QUARANTINE_NAME.test(entry.name)) return false;
      const path = join(this.dir, entry.name);
      const stat = await lstat(path).catch(() => null);
      if (stat === null || !stat.isFile()) return false;
      if ((await this.#parse(entry.name)).kind === "ok") return false;
      try {
        await new Quarantine(this.root, this.#now).move(path, "invalid-launch-file", `launch entry (${entry.reason})`);
      } catch (error) {
        // The file WAS moved and only a folder flush failed.
        if (!(error instanceof QuarantineNotFlushed)) throw error;
      }
      await this.#scan();
      return true;
    });
  }

  // ---------- the index (synchronous, as of the last scan or write) ----------

  /** True for a launch whose file says it is not over, for one whose file cannot be read (it may describe an active launch), and for every id when the folder cannot be listed. */
  isUnfinished(launchId: string): boolean {
    if (this.#folderUnreadable) return true;
    if (this.#unreadable.some((e) => e.name === `${launchId}.json`)) return true;
    const status = this.#statuses.get(launchId);
    return status !== undefined && !isEnded(status);
  }

  hasUnfinishedOrUnreadable(): boolean {
    return this.#folderUnreadable || this.#unreadable.length > 0 || [...this.#statuses.values()].some((status) => !isEnded(status));
  }
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}
