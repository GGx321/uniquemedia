import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CLIP_BATCH_RULES, clipBatchFields, type ClipBatchSummary, type ClipCost } from "../../shared/engine";
import { batchSummaryOf, clipBatchOutcomeOf, startBatchState } from "../../shared/engine/clipBatchSummary";
import { fsyncDir, isTempName, readFolderNames, readRecordFile, writeJsonAtomic } from "../library/durableFs";
import { isLibraryId } from "../library/ids";
import type { ClipRecord } from "./schemas";

// Stage 5, 5b.2, S5.WB2c (plan s5b2 §5.2, I5.62, I5.63): the batch's OWN summary, so the «Клипы» header never derives a money sentence from the clip records. A record says what one clip is now; a batch member is
// what the engine did with one photo of the batch, and that stays true when the owner deletes the clip. The engine writes the summary at every member transition:
//
//   `<library>/avatars/<avatarId>/clips/batches/<batchId>.json`   strict, `schemaVersion` 1, written atomically (a temp sibling, an fsync, a rename, a folder flush), one change at a time per batch.
//
// A member's money is never decided here: it is the ledger's figure for the member's clip ids (`clipCostsOf`, I5.49), read again whenever the summary is written or listed, so an open reserve that the reconcile
// settles later shows as settled without a rewrite. A clip delete never touches the summary. A restart ends a batch that was running: its queued members are dropped (I5.63, memory-only, free), and a member that was
// sent ends as its record says, or stays at work while its journal waits for the recovery, which tells its end.

export const BATCHES_DIR = "batches";
export const BATCH_SUMMARY_SCHEMA_VERSION = 1;
/** The summary as the engine keeps it on disk: the wire's fields and rules, with no total (the list adds it from the members) and a schema version. */
export const ClipBatchFile = CLIP_BATCH_RULES.reduce(
  (schema, rule) => schema.refine(rule.check, { message: rule.message, path: rule.path }),
  z.strictObject({ schemaVersion: z.literal(BATCH_SUMMARY_SCHEMA_VERSION), ...clipBatchFields }),
);
export type ClipBatchFile = z.infer<typeof ClipBatchFile>;

export function batchesDirOf(clipsDir: string): string {
  return join(clipsDir, BATCHES_DIR);
}

export function batchSummaryPath(clipsDir: string, batchId: string): string {
  return join(batchesDirOf(clipsDir), `${batchId}.json`);
}

const SUMMARY_NAME = /^(.+)\.json$/;

// ---------- the pure rules (shared/engine/clipBatchSummary.ts, so the mock reads the same) ----------

export { KEEP_BATCHES, afterRestart, applyBatchChange, memberCostOf, moneyOpen, newestFirst, runningClipIds, toForget, withCosts, type BatchChange, type MemberLook } from "../../shared/engine/clipBatchSummary";

/** A batch as it is created, as the engine's file: every member queued under its first clip, free. */
export function startBatchFile(start: { batchId: string; avatarId: string; createdAt: string; clipIds: readonly string[] }): ClipBatchFile {
  const state = startBatchState(start);
  return { schemaVersion: BATCH_SUMMARY_SCHEMA_VERSION, ...state, members: [...state.members] };
}

/** The summary `clips.list` answers: the members with the ledger's money NOW, and the batch's one total. */
export function summaryOf(file: ClipBatchFile, costs: ReadonlyMap<string, ClipCost>): ClipBatchSummary {
  return batchSummaryOf(file, costs);
}

/** How a member ended, by its clip's record: made, refused for its content, or failed for any other reason. */
export function outcomeOfRecord(record: Pick<ClipRecord, "outcome">): "ready" | "refused" | "failed" {
  return clipBatchOutcomeOf(record.outcome);
}

// ---------- the store ----------

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The batch summaries on disk. Every change of one batch's file runs after the one before it (read, change, check, write atomically), so the file always holds the latest of a sequence of whole summaries.
 * A change never rejects: a failure is logged, and the next change writes the whole summary again from what it reads. `settled()` waits for every change and tracked piece of work that is under way, so
 * a read after an event the engine announced sees the summary that event's transition wrote.
 */
export class BatchSummaryStore {
  readonly #log: (line: string) => void;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(deps: { log: (line: string) => void }) {
    this.#log = deps.log;
  }

  /** Runs `work` after every earlier piece of work on this batch's file. */
  #serial(clipsDir: string, batchId: string, work: () => Promise<void>): Promise<void> {
    const path = batchSummaryPath(clipsDir, batchId);
    const before = this.#tails.get(path) ?? Promise.resolve();
    const run = before.then(work).catch((error: unknown) => this.#log(`[clip] batch ${batchId}: its summary could not be written (${errorName(error)}); the next change writes it whole again`));
    this.#tails.set(path, run);
    this.track(run);
    void run.finally(() => {
      if (this.#tails.get(path) === run) this.#tails.delete(path);
    });
    return run;
  }

  /** Changes a batch's summary: `build` gets the file as it is on disk now (null when there is none or it does not read) and returns the file it should become, or null for «nothing to write». */
  change(clipsDir: string, batchId: string, build: (current: ClipBatchFile | null) => ClipBatchFile | null | Promise<ClipBatchFile | null>): Promise<void> {
    return this.#serial(clipsDir, batchId, async () => {
      const current = await this.#readOne(clipsDir, batchId);
      const next = await build(current);
      if (next === null) return;
      const checked = ClipBatchFile.safeParse(next);
      if (!checked.success) {
        this.#log(`[clip] batch ${batchId}: a change of its summary breaks the schema and is not written (${checked.error.issues[0]?.message ?? "invalid"})`);
        return;
      }
      await this.#write(clipsDir, checked.data);
    });
  }

  /** Removes a batch's summary (retention), after every earlier change of it. */
  forget(clipsDir: string, batchId: string): Promise<void> {
    return this.#serial(clipsDir, batchId, async () => {
      await rm(batchSummaryPath(clipsDir, batchId), { force: true });
      await fsyncDir(batchesDirOf(clipsDir));
    });
  }

  /** A piece of work `settled()` waits for (the restart's pass over the summaries). */
  track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined);
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /** Resolves once nothing is under way, work tracked meanwhile included. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  /** Every summary of the avatar's clips folder that reads, in no order. A damaged file, a temp file and a name that is not a batch id are left out (a damaged one is logged). */
  async read(clipsDir: string): Promise<ClipBatchFile[]> {
    const listed = await readFolderNames(batchesDirOf(clipsDir));
    if (!listed.ok) {
      this.#log(`[clip] the batch summaries of ${dirname(clipsDir)} could not be listed (${errorName(listed.error)}); they are left out`);
      return [];
    }
    const ids = listed.names.flatMap((name) => {
      if (isTempName(name)) return [];
      const id = SUMMARY_NAME.exec(name)?.[1];
      return id !== undefined && isLibraryId(id) ? [id] : [];
    });
    const files: ClipBatchFile[] = [];
    for (const id of ids) {
      const file = await this.#readOne(clipsDir, id);
      if (file !== null) files.push(file);
    }
    return files;
  }

  async #readOne(clipsDir: string, batchId: string): Promise<ClipBatchFile | null> {
    const read = await readRecordFile(batchSummaryPath(clipsDir, batchId));
    if (!read.ok) {
      if (read.reason !== "missing") this.#log(`[clip] batch ${batchId}: its summary does not read (${read.reason === "io" ? errorName(read.error) : read.reason}); it is left out`);
      return null;
    }
    const parsed = ClipBatchFile.safeParse(read.value);
    if (!parsed.success || parsed.data.batchId !== batchId) {
      this.#log(`[clip] batch ${batchId}: its summary breaks the schema; it is left out`);
      return null;
    }
    return parsed.data;
  }

  async #write(clipsDir: string, file: ClipBatchFile): Promise<void> {
    const dir = batchesDirOf(clipsDir);
    const made = await mkdir(dir, { recursive: true });
    // A folder made now (the batches folder, and the clips folder of an avatar that never had a clip) is flushed into its parent before the file is written into it.
    if (made !== undefined) {
      await fsyncDir(dirname(made));
      if (made !== dir) await fsyncDir(clipsDir);
    }
    await writeJsonAtomic(batchSummaryPath(clipsDir, file.batchId), file);
  }
}
