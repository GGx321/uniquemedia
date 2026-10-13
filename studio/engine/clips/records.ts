import { rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLIP_RETRYABLE_FAILURES, MAX_LISTED_CLIPS, type ClipCost, type ClipExport, type ClipExportLine, type ClipFace, type ClipSummary, type CommandPayload, type FileState } from "../../shared/engine";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { EngineFailure } from "../engineFailure";
import { FileStateChecker, newHashBudget, type HashBudget } from "../videos/fileState";
import type { ExportRootRef } from "../videos/recovery";
import type { JobRegistry } from "../jobs";
import { fsyncDir, readFolderNames } from "../library/durableFs";
import { jobOpenReserveMicros, jobSpentMicros } from "../money/jobSpend";
import type { Ledger } from "../money/ledger";
import type { OpenRouterClient } from "../openrouter/types";
import type { CheckClipFaceOptions } from "./faceCheck";
import type { DownloadClipOptions, ClipDownload } from "./download";
import type { MakePosterOptions } from "./frames";
import { clipJournalPath, parseClipAttemptId } from "./journal";
import type { ClipRecord } from "./schemas";
import { clipFilePath, clipRecordPath, posterPath, readClipRecord, removeJournal, writeClipRecord } from "./store";

export type ClipRewrite = "seen" | "export" | "retried" | "expired";

/**
 * What a clip cost, read from the ledger at list time (I5.49), never from the record. `open`: a reserve still waits for the reconcile (counted at its worst). `estimated`: an attempt
 * was settled at a figure the money did not prove (the worst, in process or by the reconcile). `billed`: every attempt settled exact. `free`: nothing is owed.
 */
export function clipCostOf(ledger: Pick<Ledger, "lines" | "closeOf">, clipId: string): ClipCost {
  const micros = jobSpentMicros(ledger, clipId);
  if (jobOpenReserveMicros(ledger, clipId) > 0) return { micros, kind: "open" };
  if (micros === 0) return { micros: 0, kind: "free" };
  for (const line of ledger.lines) {
    if (line.type !== "reserve" || line.jobId !== clipId) continue;
    const close = ledger.closeOf(line.attemptId);
    if (close?.type === "settle" && close.estimated && close.costMicros > 0) return { micros, kind: "estimated" };
  }
  return { micros, kind: "billed" };
}

/** Whether the Grok attempt (the second in the clip's ledger ids) is among the record's: Grok ran behind a Kling that did not deliver. */
function grokFollowed(record: ClipRecord): boolean {
  return record.provider.attempts.some((attempt) => parseClipAttemptId(attempt.attemptId)?.n === 2);
}

/** The attempts' own figures added up, for information; absent when the provider gave none. */
function providerCostOf(record: ClipRecord): number | undefined {
  const figures = record.provider.attempts.flatMap((attempt) => (attempt.providerCostMicros === undefined ? [] : [attempt.providerCostMicros]));
  return figures.length === 0 ? undefined : figures.reduce((sum, micros) => sum + micros, 0);
}

/** The record as the windows see it. The cost comes in from the ledger; `exports` default to the record's lines (no `fileState`). */
export function clipSummaryOf(record: ClipRecord, cost: ClipCost, exports: readonly ClipExport[] = record.exports): ClipSummary {
  const providerCostMicros = providerCostOf(record);
  const common = {
    clipId: record.id,
    avatarId: record.avatarId,
    photoId: record.sourcePhotoId,
    createdAt: record.createdAt,
    seen: record.seen,
    motion: record.motion,
    request: record.request,
    model: record.provider.model,
    fallback: grokFollowed(record),
    recovered: record.recovered,
    cost,
    ...(providerCostMicros === undefined ? {} : { providerCostMicros }),
    exports: [...exports],
  };
  const { outcome } = record;
  if (outcome.status === "ready") return { ...common, status: "ready", width: outcome.width, height: outcome.height, durationMs: outcome.durationMs, face: outcome.face };
  return { ...common, status: "failed", failure: { reason: outcome.reason }, ...(outcome.retryDownloadUntil === undefined ? {} : { retryDownloadUntil: outcome.retryDownloadUntil }) };
}

/** Everything but the three things a rewrite may move, so two records can be told apart by what must stay. */
function fixedPartOf(record: ClipRecord): unknown {
  return { ...record, seen: false, exports: [], outcome: null };
}

/**
 * Which of I5.53's four rewrites turns `before` into `after`, or null when it is none of them: the `seen` flag going on, an appended export, a failed download becoming ready, or a failed
 * download becoming `download-expired`. Exactly one reason per rewrite, and nothing else may differ.
 */
export function clipRewriteOf(before: ClipRecord, after: ClipRecord): ClipRewrite | null {
  if (!isDeepStrictEqual(fixedPartOf(before), fixedPartOf(after))) return null;
  const seen = before.seen !== after.seen;
  const exported = !isDeepStrictEqual(before.exports, after.exports);
  const outcome = !isDeepStrictEqual(before.outcome, after.outcome);
  if (Number(seen) + Number(exported) + Number(outcome) !== 1) return null;
  if (seen) return !before.seen && after.seen ? "seen" : null;
  if (exported) {
    const appended = after.exports.length > before.exports.length && isDeepStrictEqual(after.exports.slice(0, before.exports.length), before.exports);
    return appended ? "export" : null;
  }
  if (before.outcome.status !== "failed" || !CLIP_RETRYABLE_FAILURES.includes(before.outcome.reason)) return null;
  if (after.outcome.status === "ready") return "retried";
  return after.outcome.reason === "download-expired" && after.outcome.retryDownloadUntil === undefined ? "expired" : null;
}

export interface ClipRecordsMedia {
  readonly downloadClip: (options: DownloadClipOptions) => Promise<ClipDownload>;
  readonly makePoster: (options: MakePosterOptions) => Promise<void>;
}

export interface ClipLibrary {
  /** The avatar is in the open library. */
  hasAvatar: (avatarId: string) => boolean;
  /** `<library>/avatars/<avatarId>/clips`. */
  clipsDirOf: (avatarId: string) => string;
}

export interface ClipRecordsDeps {
  newId: () => string;
  clock: () => number;
  /** The open library as far as the records need it, or null when none is open. */
  library: () => ClipLibrary | null;
  pendingDelete: (avatarId: string) => boolean;
  ledger: () => Pick<Ledger, "lines" | "closeOf"> | null;
  jobs: Pick<JobRegistry, "startClip" | "clipPhase" | "finishClip">;
  emit: (event: UnsequencedEvent) => void;
  usableKey: (purpose: string) => string;
  openRouter: (key: string) => Pick<OpenRouterClient, "downloadVideo">;
  exportRoot: () => Promise<ExportRootRef | null | "unanswered">;
  fileStates?: Pick<FileStateChecker, "check">;
  host: { busy: (clipId: string) => boolean; begin: (clipId: string) => () => void; stop: AbortSignal };
  faceOf: (input: Pick<CheckClipFaceOptions, "clipPath" | "colour" | "durationMs" | "scratchDir" | "signal"> & { record: ClipRecord }) => Promise<ClipFace>;
  media?: Partial<ClipRecordsMedia>;
  log: (line: string) => void;
}

type Payload<T extends "clips.list" | "clips.get" | "clips.markSeen" | "clips.delete" | "clips.retryDownload"> = CommandPayload<T>;

/** `<clipId>.json`: a record. Journals (`.journal.jsonl`), media and temp files do not match. */
const RECORD_NAME = /^([a-z0-9-]{8,64})\.json$/;
const JOURNAL_NAME = /^([a-z0-9-]{8,64})\.journal\.jsonl$/;
/** Records are read this many at a time, so a big folder does not open hundreds of files at once. */
const READ_BATCH = 32;

const notFound = (detail: string): EngineFailure => new EngineFailure({ code: "NOT_FOUND", detail });

/**
 * The clip records of one library (Stage 5, 5b.1, S5.V4a2; plan s5b1 §5.2, §5.3, I5.49, I5.53): list, get, mark seen, delete and the download retry. Every write of a committed record goes through
 * `rewrite`, which refuses anything but I5.53's four rewrites; every decision about one clip (a rewrite, a delete, the start of a retry) is taken inside that clip's own lock, so a `markSeen`
 * never undoes an appended export and a delete never meets a retry that has just begun.
 */
export class ClipRecords {
  readonly #deps: ClipRecordsDeps;
  readonly #checker: Pick<FileStateChecker, "check">;
  /** The tail of each clip's queue of decisions. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(deps: ClipRecordsDeps) {
    this.#deps = deps;
    this.#checker = deps.fileStates ?? new FileStateChecker();
  }

  /** Runs `work` after every earlier decision about this clip; a failure of one does not stop the next. */
  async withClipLock<T>(clipId: string, work: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(clipId) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.catch(() => undefined);
    this.#locks.set(clipId, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(clipId) === tail) this.#locks.delete(clipId);
    }
  }

  /** The avatar's clips folder: LIBRARY_UNAVAILABLE with no library, NOT_FOUND for an avatar that is not in it or is being deleted. */
  #dirOf(avatarId: string): string {
    const library = this.#deps.library();
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    if (!library.hasAvatar(avatarId) || this.#deps.pendingDelete(avatarId)) throw notFound(`no avatar ${avatarId} in the open library`);
    return library.clipsDirOf(avatarId);
  }

  async #recordOf(clipsDir: string, clipId: string): Promise<ClipRecord> {
    const read = await readClipRecord(clipsDir, clipId);
    if (read.kind !== "record" || read.record.id !== clipId) throw notFound(`no clip ${clipId} in this avatar's clips`);
    return read.record;
  }

  /** The ledger the costs are read from; a ledger that cannot be read leaves every cost unknown, and a cost is never guessed. */
  #ledger(): Pick<Ledger, "lines" | "closeOf"> {
    const ledger = this.#deps.ledger();
    if (ledger === null) throw new EngineFailure({ code: "LEDGER_UNREADABLE", detail: "the money ledger cannot be read, so the clips' costs are not known" });
    return ledger;
  }

  // ---------- clips.list ----------

  async list(payload: Payload<"clips.list">): Promise<{ clips: ClipSummary[]; notListedTotal?: number }> {
    const clipsDir = this.#dirOf(payload.avatarId);
    const listed = await readFolderNames(clipsDir);
    if (!listed.ok) throw listed.error;
    const journals = new Set(listed.names.flatMap((name) => JOURNAL_NAME.exec(name)?.[1] ?? []));
    let ids = listed.names.flatMap((name) => RECORD_NAME.exec(name)?.[1] ?? []);
    let notListedTotal = 0;
    if (ids.length > MAX_LISTED_CLIPS) {
      // Past the cap the newest are the ones a window wants, and reading every record to find them is what the cap is for: the file's own time stands in for the record's.
      const stamped = await Promise.all(ids.map(async (id) => ({ id, at: await stat(clipRecordPath(clipsDir, id)).then((s) => s.mtimeMs, () => 0) })));
      stamped.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
      ids = stamped.slice(0, MAX_LISTED_CLIPS).map((s) => s.id);
      notListedTotal = stamped.length - MAX_LISTED_CLIPS;
    }
    const records: ClipRecord[] = [];
    for (let at = 0; at < ids.length; at += READ_BATCH) {
      const batch = await Promise.all(ids.slice(at, at + READ_BATCH).map((id) => this.#readForList(clipsDir, id)));
      for (const record of batch) if (record !== null) records.push(record);
    }
    records.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const ledger = records.length === 0 ? null : this.#ledger();
    const clips = ledger === null ? [] : records.map((record) => clipSummaryOf(record, clipCostOf(ledger, record.id)));
    // A journal beside a committed record is a leftover of a clip that finished: removed unless a job still works on that clip.
    for (const record of records) {
      if (!journals.has(record.id) || this.#deps.host.busy(record.id)) continue;
      await removeJournal(clipsDir, record.id).catch((error: unknown) => this.#deps.log(`[clip] ${record.id}: a stale journal could not be removed (${errorName(error)})`));
    }
    return notListedTotal === 0 ? { clips } : { clips, notListedTotal };
  }

  async #readForList(clipsDir: string, clipId: string): Promise<ClipRecord | null> {
    try {
      const read = await readClipRecord(clipsDir, clipId);
      if (read.kind === "record" && read.record.id === clipId) return read.record;
      this.#deps.log(`[clip] ${clipId}: the record is ${read.kind === "record" ? "named for another clip" : read.kind}; it is left out of the list`);
    } catch (error) {
      this.#deps.log(`[clip] ${clipId}: the record could not be read (${errorName(error)}); it is left out of the list`);
    }
    return null;
  }

  // ---------- clips.get ----------

  async get(payload: Payload<"clips.get">): Promise<{ clip: ClipSummary }> {
    const clipsDir = this.#dirOf(payload.avatarId);
    const record = await this.#recordOf(clipsDir, payload.clipId);
    const cost = clipCostOf(this.#ledger(), record.id);
    return { clip: clipSummaryOf(record, cost, await this.#exportsOf(record)) };
  }

  /** Each export line with the state of its file in the current export folder (the shared `FileState`, `changed` included). Not asked at all for a clip with no export. */
  async #exportsOf(record: ClipRecord): Promise<ClipExport[]> {
    if (record.exports.length === 0) return [];
    const root = await this.#deps.exportRoot();
    const budget = newHashBudget();
    const out: ClipExport[] = [];
    for (const [index, line] of record.exports.entries()) {
      out.push({ ...line, fileState: await this.#fileStateOf(record.id, index + 1, line, root, budget) });
    }
    return out;
  }

  async #fileStateOf(clipId: string, n: number, line: ClipExportLine, root: ExportRootRef | null | "unanswered", budget: HashBudget): Promise<FileState> {
    if (root === "unanswered") return "unchecked";
    try {
      const file = { rootId: line.rootId, relPath: line.relPath, bytes: line.bytes, sha256: line.sha256 };
      return await this.#checker.check({ id: `${clipId}-export-${n}`, file }, root, { verify: "cheap", budget });
    } catch (error) {
      this.#deps.log(`[clip] ${clipId}: export ${n} could not be checked (${errorName(error)})`);
      return "unchecked";
    }
  }

  // ---------- the one gate for a committed record's rewrite (I5.53) ----------

  /**
   * Rewrites a committed record: `build` gets the record as it is on disk NOW (under the clip's lock) and returns the record it should become, or null for «nothing to do». Anything that is not one
   * of I5.53's four rewrites is a defect and throws before a byte is written. NOT_FOUND when the record is gone.
   */
  async rewrite(avatarId: string, clipId: string, build: (current: ClipRecord) => ClipRecord | null): Promise<{ record: ClipRecord; rewrite: ClipRewrite } | null> {
    const clipsDir = this.#dirOf(avatarId);
    return this.withClipLock(clipId, () => this.#rewriteLocked(clipsDir, clipId, build));
  }

  async #rewriteLocked(clipsDir: string, clipId: string, build: (current: ClipRecord) => ClipRecord | null): Promise<{ record: ClipRecord; rewrite: ClipRewrite } | null> {
    const current = await this.#recordOf(clipsDir, clipId);
    const next = build(current);
    if (next === null) return null;
    const reason = clipRewriteOf(current, next);
    if (reason === null) throw new Error(`the record of clip ${clipId} may not be rewritten that way (I5.53)`);
    await writeClipRecord(clipsDir, next);
    return { record: next, rewrite: reason };
  }

  // ---------- clips.markSeen ----------

  async markSeen(payload: Payload<"clips.markSeen">): Promise<{ clipId: string }> {
    await this.rewrite(payload.avatarId, payload.clipId, (current) => (current.seen ? null : { ...current, seen: true }));
    return { clipId: payload.clipId };
  }

  // ---------- clips.delete ----------

  /**
   * Removes the record first, then flushes the folder, then the files (I5.53): a crash between leaves files with no record and no journal, which the next recovery pass sweeps. The mp4 of a failed
   * record goes too (a `download-failed` record may have left one). An exported copy is not the clip's to remove, and the record that listed it goes with the clip. A file that will not go is
   * logged and left to that sweep, since the clip is already gone.
   */
  async delete(payload: Payload<"clips.delete">): Promise<{ clipId: string }> {
    const { clipId } = payload;
    const clipsDir = this.#dirOf(payload.avatarId);
    await this.withClipLock(clipId, async () => {
      if (this.#deps.host.busy(clipId)) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
      await this.#recordOf(clipsDir, clipId);
      await rm(clipRecordPath(clipsDir, clipId));
      await fsyncDir(clipsDir);
      for (const path of [clipFilePath(clipsDir, clipId), posterPath(clipsDir, clipId), clipJournalPath(clipsDir, clipId)]) {
        await rm(path, { force: true }).catch((error: unknown) => this.#deps.log(`[clip] ${clipId}: ${basename(path)} could not be removed (${errorName(error)}); the next sweep will`));
      }
      await fsyncDir(clipsDir).catch(() => undefined);
    });
    return { clipId };
  }

  // ---------- clips.retryDownload ----------

  async retryDownload(_payload: Payload<"clips.retryDownload">): Promise<{ jobId: string }> {
    throw new EngineFailure({ code: "NOT_FOUND", detail: "not built" });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
