import { rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CLIP_RETRYABLE_FAILURES,
  MAX_LISTED_CLIPS,
  PROTOCOL_VERSION,
  type ClipCost,
  type ClipExport,
  type ClipExportLine,
  type ClipFace,
  type ClipSummary,
  type ClipUse,
  type CommandPayload,
  type EngineError,
  type FileState,
} from "../../shared/engine";
import type { Estimate } from "../../shared/engine/estimate";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { EngineFailure } from "../engineFailure";
import { FileStateChecker, newHashBudget, type HashBudget } from "../videos/fileState";
import type { ExportRootRef } from "../videos/recovery";
import type { ClipJobEnd, ClipPhaseUpdate, JobRegistry } from "../jobs";
import { fsyncDir, readFolderNames } from "../library/durableFs";
import type { Ledger } from "../money/ledger";
import type { OpenRouterClient } from "../openrouter/types";
import type { DraftUse } from "./copies";
import { downloadClip, type ClipDownload, type DownloadClipOptions } from "./download";
import type { CheckClipFaceOptions } from "./faceCheck";
import { makePoster, type MakePosterOptions } from "./frames";
import { clipJournalPath, parseClipAttemptId } from "./journal";
import { drawPoster, readyOutcomeOf } from "./ready";
import type { ClipRecord } from "./schemas";
import { clipFilePath, clipRecordPath, posterPath, readClipRecord, removeJournal, writeClipRecord } from "./store";

export type ClipRewrite = "seen" | "export" | "retried" | "expired";

/**
 * What a clip cost, read from the ledger at list time (I5.49), never from the record. `open`: a reserve still waits for the reconcile (counted at its worst). `estimated`: an attempt
 * was settled at a figure the money did not prove (the worst, in process or by the reconcile). `billed`: every attempt settled exact. `free`: nothing is owed.
 */
export function clipCostOf(ledger: Pick<Ledger, "lines" | "closeOf">, clipId: string): ClipCost {
  return clipCostsOf(ledger).get(clipId) ?? FREE;
}

const FREE: ClipCost = { micros: 0, kind: "free" };

/** The cost of every job that reserved anything, in ONE pass over the ledger's lines (a list of hundreds of clips reads the ledger once). A job with no reserve is absent: it cost nothing. */
export function clipCostsOf(ledger: Pick<Ledger, "lines" | "closeOf">): Map<string, ClipCost> {
  const sums = new Map<string, { total: number; open: number; estimated: boolean }>();
  for (const line of ledger.lines) {
    if (line.type !== "reserve") continue;
    const sum = sums.get(line.jobId) ?? { total: 0, open: 0, estimated: false };
    sums.set(line.jobId, sum);
    const close = ledger.closeOf(line.attemptId);
    if (close === undefined) {
      sum.total += line.worstMicros;
      sum.open += line.worstMicros;
    } else if (close.type === "settle") {
      sum.total += close.costMicros;
      if (close.estimated && close.costMicros > 0) sum.estimated = true;
    }
  }
  const costs = new Map<string, ClipCost>();
  for (const [jobId, sum] of sums) {
    costs.set(jobId, sum.open > 0 ? { micros: sum.total, kind: "open" } : sum.total === 0 ? FREE : { micros: sum.total, kind: sum.estimated ? "estimated" : "billed" });
  }
  return costs;
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

/**
 * The record as the windows see it. The cost comes in from the ledger; `exports` default to the record's lines (no `fileState`). `grokOffer` is the mode-`offer` tile's Grok price, which the clip
 * service computes at list time (§5.2): it goes into a failed clip's `failure`, and a ready clip has none.
 */
export function clipSummaryOf(record: ClipRecord, cost: ClipCost, exports: readonly ClipExport[] = record.exports, grokOffer?: Estimate, use?: ClipUse): ClipSummary {
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
    // 5b.2 (L9): a batch member tells its trio, all three or none (the record's own refine), so the header survives `KEEP_FINISHED` and a restart.
    ...(record.batchId === undefined || record.batchIndex === undefined || record.batchSize === undefined ? {} : { batchId: record.batchId, batchIndex: record.batchIndex, batchSize: record.batchSize }),
  };
  const { outcome } = record;
  if (outcome.status === "ready") return { ...common, status: "ready", width: outcome.width, height: outcome.height, durationMs: outcome.durationMs, face: outcome.face, ...(use === undefined ? {} : { use }) };
  const failure = { reason: outcome.reason, ...(grokOffer === undefined ? {} : { grokOffer }) };
  return { ...common, status: "failed", failure, ...(outcome.retryDownloadUntil === undefined ? {} : { retryDownloadUntil: outcome.retryDownloadUntil }) };
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
  /** Test seam: removes a file, and not finding it is fine (`rm` with `force` by default). Only the delete's files go through it. */
  remove?: (path: string) => Promise<void>;
  /**
   * 5b.2 (S5.WA2, I5.59): the clip's montage copy. A delete removes it FIRST, under the clip's lock; it throws what refuses the delete (IN_FLIGHT `in-use` while a render holds the copy, INTERNAL when the
   * disk fails) and then nothing of the clip is removed. Absent: a service built without the media service, which has no copies.
   */
  copies?: { removeOf: (avatarId: string, clipId: string) => Promise<unknown> };
  /**
   * 5b.2 (S5.WA2, Q-F = 1): what uses a ready clip, for `ClipSummary.use`. `videoUse` is the used index's answer for a clip and the photo it was made from; `draftsOf` is how many saved drafts of the
   * avatar hold each clip's copy, read once for a whole list. A reader that fails leaves its part out (logged): `use` is a help for the dialog, not a gate. Absent: no clip has a `use`.
   */
  uses?: {
    videoUse: (avatarId: string, clipId: string, photoId: string) => "clip" | "photo" | undefined;
    draftsOf: (avatarId: string) => Promise<ReadonlyMap<string, DraftUse>>;
  };
}

type Payload<T extends "clips.list" | "clips.get" | "clips.markSeen" | "clips.delete" | "clips.retryDownload"> = CommandPayload<T>;

/** What `clips.list` takes from the clip service. */
export interface ClipListOptions {
  /** The mode-`offer` Grok price of each listed clip that is offered one, by clip id (§5.2: computed at list time from the live price book). A clip it leaves out has no offer. */
  readonly grokOffers?: (records: readonly ClipRecord[]) => Promise<ReadonlyMap<string, Estimate>>;
}

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

  /**
   * The clip's folder and committed record as a command that works on one clip reads them (S5.WA2's `media.importClip`): LIBRARY_UNAVAILABLE with no library, NOT_FOUND for an avatar that is not in it
   * or is being deleted, and for a clip the avatar does not have. A read; the caller takes the clip's lock if it decides anything from it.
   */
  async locate(avatarId: string, clipId: string): Promise<{ clipsDir: string; record: ClipRecord }> {
    const clipsDir = this.#dirOf(avatarId);
    return { clipsDir, record: await this.#recordOf(clipsDir, clipId) };
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

  async list(payload: Payload<"clips.list">, options: ClipListOptions = {}): Promise<{ clips: ClipSummary[]; notListedTotal?: number }> {
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
    const costs = ledger === null ? new Map<string, ClipCost>() : clipCostsOf(ledger);
    const offers = records.length === 0 || options.grokOffers === undefined ? new Map<string, Estimate>() : await options.grokOffers(records);
    const uses = await this.#usesOf(payload.avatarId, records);
    const clips = records.map((record) => clipSummaryOf(record, costs.get(record.id) ?? FREE, record.exports, offers.get(record.id), uses.get(record.id)));
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

  /** The same Grok offer the list carries (`options.grokOffers`, asked for this one record), so a tile refreshed through `clips.get` keeps its «Снять на Grok». */
  async get(payload: Payload<"clips.get">, options: ClipListOptions = {}): Promise<{ clip: ClipSummary }> {
    const clipsDir = this.#dirOf(payload.avatarId);
    const record = await this.#recordOf(clipsDir, payload.clipId);
    const cost = clipCostOf(this.#ledger(), record.id);
    const offer = options.grokOffers === undefined ? undefined : (await options.grokOffers([record])).get(record.id);
    const use = (await this.#usesOf(payload.avatarId, [record])).get(record.id);
    return { clip: clipSummaryOf(record, cost, await this.#exportsOf(record), offer, use) };
  }

  /**
   * `ClipSummary.use` of each READY record (5b.2, S5.WA2): how a finished video uses its frame, and how many saved drafts hold its copy. Only a ready clip is ever used; a clip nothing uses has no entry.
   * A reader that fails leaves its part out and is logged. The drafts are read once, and only when a ready clip is asked about.
   */
  async #usesOf(avatarId: string, records: readonly ClipRecord[]): Promise<Map<string, ClipUse>> {
    const readers = this.#deps.uses;
    const uses = new Map<string, ClipUse>();
    const ready = records.filter((record) => record.outcome.status === "ready");
    if (readers === undefined || ready.length === 0) return uses;
    let drafts: ReadonlyMap<string, DraftUse> = new Map();
    try {
      drafts = await readers.draftsOf(avatarId);
    } catch (error) {
      this.#deps.log(`[clip] the drafts that hold clip copies could not be read (${errorName(error)}); the clips are listed without them`);
    }
    for (const record of ready) {
      let inVideo: "clip" | "photo" | undefined;
      try {
        inVideo = readers.videoUse(avatarId, record.id, record.sourcePhotoId);
      } catch (error) {
        this.#deps.log(`[clip] ${record.id}: the used index could not be read (${errorName(error)}); the clip is listed without it`);
      }
      const inDrafts = drafts.get(record.id);
      if (inVideo === undefined && inDrafts === undefined) continue;
      uses.set(record.id, { ...(inVideo === undefined ? {} : { inVideo }), ...(inDrafts === undefined ? {} : { inDrafts }) });
    }
    return uses;
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
   * The journal first (beside a live record it is stale by definition), a flush, then the record (the commit, I5.53), a flush, then the media. A journal with no record is recovered by the
   * restart as a running clip, so it must never outlive the record: if either removal fails the delete fails with the record still in place and nothing resurrected. Media that will not go is
   * logged and left to the recovery sweep (no record and no journal), since the clip is already gone. The mp4 of a failed record goes too (a `download-failed` record may have left one).
   * An exported copy is not the clip's to remove. The clip's MONTAGE copy (5b.2, an own video of the editor) is: it goes FIRST, under the lock, and a render that holds it refuses the whole delete
   * (IN_FLIGHT `in-use`) with nothing removed.
   */
  async delete(payload: Payload<"clips.delete">): Promise<{ clipId: string }> {
    const { clipId } = payload;
    const clipsDir = this.#dirOf(payload.avatarId);
    await this.withClipLock(clipId, async () => {
      if (this.#deps.host.busy(clipId)) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
      await this.#recordOf(clipsDir, clipId);
      // The copy goes first (a render that holds it refuses the whole delete, with nothing removed); then the clip, so no copy outlives its clip.
      await this.#deps.copies?.removeOf(payload.avatarId, clipId);
      const remove = this.#deps.remove ?? ((path: string) => rm(path, { force: true }));
      await remove(clipJournalPath(clipsDir, clipId));
      await fsyncDir(clipsDir);
      await remove(clipRecordPath(clipsDir, clipId));
      await fsyncDir(clipsDir);
      for (const path of [clipFilePath(clipsDir, clipId), posterPath(clipsDir, clipId)]) {
        await remove(path).catch((error: unknown) => this.#deps.log(`[clip] ${clipId}: ${basename(path)} could not be removed (${errorName(error)}); the next sweep will`));
      }
      await fsyncDir(clipsDir).catch(() => undefined);
    });
    return { clipId };
  }

  // ---------- clips.retryDownload ----------

  /**
   * A failed download of a paid clip, fetched again for free (I5.53): refused unless the record is `download-failed`, `invalid-file` or `disk-full`, and no job works on it. Past
   * `retryDownloadUntil` the record turns `download-expired` and the call is refused; a record with no window has passed none, so it is retried, and only /content saying the file is gone
   * expires it. Otherwise a registered `clip` job re-runs V4b's download and validation and rewrites the record; it never writes the ledger. All of this is decided under the clip's lock, so a
   * delete cannot slip in between the check and the job.
   */
  async retryDownload(payload: Payload<"clips.retryDownload">): Promise<{ jobId: string }> {
    const { avatarId, clipId } = payload;
    const clipsDir = this.#dirOf(avatarId);
    const deps = this.#deps;
    const started = await this.withClipLock(clipId, async () => {
      if (deps.host.busy(clipId)) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
      const record = await this.#recordOf(clipsDir, clipId);
      const { outcome } = record;
      if (outcome.status !== "failed") throw new EngineFailure({ code: "VALIDATION", detail: "only a clip whose download failed can be fetched again" });
      if (outcome.reason === "download-expired") throw new EngineFailure({ code: "VALIDATION", clipReason: "download-expired", detail: "the file is no longer at the provider" });
      if (!CLIP_RETRYABLE_FAILURES.includes(outcome.reason)) throw new EngineFailure({ code: "VALIDATION", detail: `a clip that ended ${outcome.reason} has no file to fetch again` });
      // I5.53 turns a failed download into `download-expired` when the window PASSED or /content says gone: a record with no window has not passed one.
      const until = outcome.retryDownloadUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(outcome.retryDownloadUntil);
      if (!(deps.clock() <= until)) {
        await this.#rewriteLocked(clipsDir, clipId, expiredBy);
        throw new EngineFailure({ code: "VALIDATION", clipReason: "download-expired", detail: "the file is no longer at the provider" });
      }
      const providerJobId = record.provider.attempts.findLast((attempt) => attempt.outcome === "completed" && attempt.providerJobId !== undefined)?.providerJobId;
      if (providerJobId === undefined) throw new EngineFailure({ code: "VALIDATION", detail: "the record names no finished attempt to fetch" });
      const key = deps.usableKey("fetch a finished clip again");
      // Nothing awaited from here to the job's start: an avatar delete prepared meanwhile, or a library switched away, wins (I5.50, as in create). A switch to a copy of the library holds the
      // same avatar, so the folder itself must still be the one the record was read from.
      if (this.#dirOf(avatarId) !== clipsDir) throw notFound(`avatar ${avatarId} is no longer in the library its clip was read from`);
      const jobId = deps.newId();
      const stop = deps.jobs.startClip(jobId, { avatarId, clipId }, "downloading");
      return { jobId, stop, end: deps.host.begin(clipId), key, providerJobId, until, record };
    });
    void this.#runRetry({ avatarId, clipId, clipsDir, ...started });
    return { jobId: started.jobId };
  }

  async #runRetry(job: RetryJob): Promise<void> {
    const deps = this.#deps;
    const ref = { kind: "clip" as const, jobId: job.jobId, avatarId: job.avatarId, clipId: job.clipId };
    let end: ClipJobEnd;
    try {
      end = await this.#retry(job, AbortSignal.any([job.stop, deps.host.stop]));
    } catch (error) {
      deps.log(`[clip] ${job.clipId}: the retry failed (${errorName(error)})`);
      end = { status: "failed", error: error instanceof EngineFailure ? error.error : { code: "INTERNAL", detail: "the download could not be retried" } };
    } finally {
      job.end();
    }
    try {
      const state = deps.jobs.finishClip(job.jobId, end);
      const v = PROTOCOL_VERSION;
      if (state?.status === "done" && state.result !== undefined) deps.emit({ v, id: deps.newId(), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: state.result } });
      else if (end.status === "failed") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      else if (end.status === "cancelled") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
    } catch (error) {
      deps.log(`[clip] the end of job ${job.jobId} could not be announced (${errorName(error)})`);
    }
  }

  async #retry(job: RetryJob, signal: AbortSignal): Promise<ClipJobEnd> {
    const deps = this.#deps;
    const { clipId, clipsDir, record } = job;
    const media = { ...REAL_MEDIA, ...deps.media };
    const model = record.provider.model === "grok" ? "grok" : "kling";
    const phase = (update: ClipPhaseUpdate): void => {
      const progress = deps.jobs.clipPhase(job.jobId, update);
      if (progress !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload: progress });
    };
    phase({ phase: "downloading", model, done: 1 });
    let download: ClipDownload;
    try {
      download = await media.downloadClip({ client: deps.openRouter(job.key), providerJobId: job.providerJobId, clipId, clipsDir, requestedSeconds: record.request.seconds, signal });
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      deps.log(`[clip] ${clipId}: the download could not be stored (${errorName(error)})`);
      download = { kind: "failed", reason: "download-failed", detail: "the file could not be stored" };
    }
    if (signal.aborted) return { status: "cancelled" };
    if (download.kind === "failed") {
      deps.log(`[clip] ${clipId}: the retry's download failed (${download.reason})`);
      // The file is gone at the provider, or the window ended while we tried: the record says so (I5.53). Anything else is a failure to try again later.
      if (download.reason === "download-expired" || !(deps.clock() <= job.until)) {
        await this.rewrite(job.avatarId, clipId, expiredBy);
        return { status: "done" };
      }
      return { status: "failed", error: failureOf(download) };
    }

    phase({ phase: "checking", model, done: 2 });
    const poster = await this.#poster(media, download, clipsDir, clipId, signal);
    // A stop during the poster (it may be what killed ffmpeg) never ends `ready`, and never judges the file (job.ts does the same).
    if (signal.aborted) return { status: "cancelled" };
    if (poster === "undecodable") {
      await rm(download.path, { force: true });
      return { status: "failed", error: { code: "VALIDATION", detail: "the file cannot be decoded" } };
    }
    let face: ClipFace;
    try {
      face = await deps.faceOf({ record, clipPath: download.path, colour: download.clip.colour, durationMs: download.clip.durationMs, scratchDir: clipsDir, signal });
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      deps.log(`[clip] ${clipId}: the face check could not run (${errorName(error)}); the clip is kept unchecked`);
      face = { verdict: "skipped", frames: 0, why: "worker" };
    }
    // A stop while the face was read (the check may answer after it) never ends `ready` either.
    if (signal.aborted) return { status: "cancelled" };

    phase({ phase: "saving", model, done: 3 });
    const ready = readyOutcomeOf(clipId, download, face);
    await this.rewrite(job.avatarId, clipId, (current) => (current.outcome.status === "failed" && CLIP_RETRYABLE_FAILURES.includes(current.outcome.reason) ? { ...current, outcome: ready } : null));
    return { status: "done" };
  }

  /** The poster (`drawPoster`). `missing` keeps the clip (V6 repaints, V8 shows a placeholder); `undecodable` is ffmpeg's proof. */
  async #poster(media: ClipRecordsMedia, download: Extract<ClipDownload, { kind: "saved" }>, clipsDir: string, clipId: string, signal: AbortSignal): Promise<"drawn" | "missing" | "undecodable"> {
    const drawn = await drawPoster({ makePoster: (options) => media.makePoster(options), clipPath: download.path, colour: download.clip.colour, clipsDir, clipId, signal, log: this.#deps.log });
    if (drawn.drawn) return "drawn";
    const kind = drawn.undecodable ? "undecodable" : "missing";
    this.#deps.log(`[clip] ${clipId}: the poster could not be drawn (${errorName(drawn.error)}); ${kind === "missing" ? "the clip is kept without one" : "the file is not kept"}`);
    return kind;
  }
}

/** What the retry hands its job: the clip, the signal that cancels it, and the pieces decided under the lock. */
interface RetryJob {
  readonly jobId: string;
  readonly avatarId: string;
  readonly clipId: string;
  readonly clipsDir: string;
  readonly stop: AbortSignal;
  /** Gives the clip back to its other commands. */
  readonly end: () => void;
  readonly key: string;
  readonly providerJobId: string;
  /** The end of the retry window, epoch ms. */
  readonly until: number;
  readonly record: ClipRecord;
}

const REAL_MEDIA: ClipRecordsMedia = { downloadClip, makePoster };

/** A failed download becoming `download-expired` (I5.53): the retry window goes with it. */
const expiredBy = (current: ClipRecord): ClipRecord | null =>
  current.outcome.status === "failed" && CLIP_RETRYABLE_FAILURES.includes(current.outcome.reason) ? { ...current, outcome: { status: "failed", reason: "download-expired" } } : null;

/** Why a retry's download failed, as the job's error. */
function failureOf(download: Extract<ClipDownload, { kind: "failed" }>): EngineError {
  switch (download.reason) {
    case "download-failed":
      return { code: "NETWORK", detail: download.detail };
    case "invalid-file":
      return { code: "VALIDATION", detail: download.detail };
    case "disk-full":
    case "download-expired":
      return { code: "INTERNAL", detail: download.detail };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
