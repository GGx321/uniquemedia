import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CLIP_BATCH_RULES,
  MAX_LISTED_BATCHES,
  clipBatchCostOf,
  clipBatchFields,
  type ClipBatchMemberSummary,
  type ClipBatchStop,
  type ClipBatchSummary,
  type ClipCancelDetail,
  type ClipCost,
  type ClipFailReason,
} from "../../shared/engine";
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
/** How many batch summaries an avatar keeps (any older one whose money is still open, or whose queue has not ended, is kept too). */
export const KEEP_BATCHES = MAX_LISTED_BATCHES;

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

// ---------- the pure rules ----------

/** A batch as it is created: every member queued under its first clip, free. */
export function startBatchFile(start: { batchId: string; avatarId: string; createdAt: string; clipIds: readonly string[] }): ClipBatchFile {
  return {
    schemaVersion: BATCH_SUMMARY_SCHEMA_VERSION,
    batchId: start.batchId,
    avatarId: start.avatarId,
    size: start.clipIds.length,
    createdAt: start.createdAt,
    members: start.clipIds.map((clipId, i) => ({ batchIndex: i + 1, outcome: "queued", costMicros: 0, costKind: "free", clipIds: [clipId] })),
  };
}

/** What happened to a batch, as the engine tells its summary. A member's change names the clip it is about: only the member's NEWEST clip moves it (a 429's first clip ends after its member was requeued). */
export type BatchChange =
  /** Its turn came. */
  | { readonly kind: "running"; readonly index: number; readonly clipId: string }
  /** A 429 at its submit: it waits again, as a new clip. */
  | { readonly kind: "requeued"; readonly index: number; readonly clipId: string }
  /** Its clip job ended: made, refused, or failed (`outcomeOfRecord`; a job that ended with no record failed). A failed member whose clip is made after all (a download fetched again) becomes ready. */
  | { readonly kind: "ended"; readonly index: number; readonly clipId: string; readonly outcome: "ready" | "refused" | "failed" }
  /** It never ran, for this reason. */
  | { readonly kind: "cancelled"; readonly index: number; readonly clipId: string; readonly detail: ClipCancelDetail }
  /** It never ran: the engine stopped. */
  | { readonly kind: "dropped"; readonly index: number; readonly clipId: string }
  /** A stop cancelled every member still queued (told after their cancels, and only when it cancelled one). */
  | { readonly kind: "stop"; readonly detail: ClipBatchStop }
  /** The queue ended: nothing is queued and the last member's money closed. */
  | { readonly kind: "over"; readonly at: string };

type Outcome = ClipBatchMemberSummary["outcome"];

/** Where each change may move a member from. A member made, refused, cancelled or dropped never moves again (a word that comes late about it is ignored). */
const FROM: Readonly<Record<"running" | "requeued" | "ended" | "cancelled" | "dropped", readonly Outcome[]>> = {
  running: ["queued"],
  requeued: ["queued", "running"],
  ended: ["queued", "running", "failed"],
  cancelled: ["queued", "running"],
  dropped: ["queued", "running"],
};

function moveMember(member: ClipBatchMemberSummary, change: Extract<BatchChange, { index: number }>): ClipBatchMemberSummary {
  if (!FROM[change.kind].includes(member.outcome)) return member;
  const { detail: _detail, ...rest } = member;
  if (change.kind === "requeued") return member.clipIds.includes(change.clipId) ? member : { ...rest, outcome: "queued", clipIds: [...member.clipIds, change.clipId] };
  if (member.clipIds.at(-1) !== change.clipId) return member;
  switch (change.kind) {
    case "running":
      return { ...rest, outcome: "running" };
    case "ended":
      // Only a clip that was made lifts a failed member (a download fetched again, a recovery's record): a failed member never turns refused or failed again.
      if (member.outcome === "failed" && change.outcome !== "ready") return member;
      return { ...rest, outcome: change.outcome };
    case "cancelled":
      return { ...rest, outcome: "cancelled", detail: change.detail };
    case "dropped":
      return { ...rest, outcome: "dropped" };
  }
}

/** The summary after one change. Pure; a change that does not apply (another place, an older clip, a member that cannot move from where it stands) leaves the file as it was. */
export function applyBatchChange(file: ClipBatchFile, change: BatchChange): ClipBatchFile {
  switch (change.kind) {
    case "stop":
      return file.stop === undefined ? { ...file, stop: change.detail } : file;
    case "over":
      if (file.endedAt !== undefined) return file;
      // A member still queued when the queue ended will never run (the engine stopped it without a word): dropped.
      return { ...file, endedAt: change.at, members: file.members.map((m) => (m.outcome === "queued" ? { ...m, outcome: "dropped" } : m)) };
    default:
      return { ...file, members: file.members.map((m) => (m.batchIndex === change.index ? moveMember(m, change) : m)) };
  }
}

const FREE: ClipCost = { micros: 0, kind: "free" };

/** A member's money: the ledger's cost of each of its clips (`clipCostsOf`), added up by the one rule (`clipBatchCostOf`). A clip that reserved nothing is free. */
export function memberCostOf(costs: ReadonlyMap<string, ClipCost>, clipIds: readonly string[]): Pick<ClipBatchMemberSummary, "costMicros" | "costKind"> {
  const total = clipBatchCostOf(clipIds.map((clipId) => costs.get(clipId) ?? FREE).map((cost) => ({ costMicros: cost.micros, costKind: cost.kind })));
  return { costMicros: total.micros, costKind: total.kind };
}

/** The file with each member's money as the ledger has it now. */
export function withCosts(file: ClipBatchFile, costs: ReadonlyMap<string, ClipCost>): ClipBatchFile {
  return { ...file, members: file.members.map((m) => ({ ...m, ...memberCostOf(costs, m.clipIds) })) };
}

/** The summary `clips.list` answers: the members with the ledger's money NOW, and the batch's one total. */
export function summaryOf(file: ClipBatchFile, costs: ReadonlyMap<string, ClipCost>): ClipBatchSummary {
  const { schemaVersion: _version, ...fields } = withCosts(file, costs);
  return { ...fields, cost: clipBatchCostOf(fields.members) };
}

/** The content refusals of a clip (Kling's, and Grok's behind it, and Grok with no room behind a free one). */
const REFUSED: ReadonlySet<ClipFailReason> = new Set<ClipFailReason>(["refused-free", "refused-both", "refused-paid", "refused-unknown", "grok-no-room"]);

/** How a member ended, by its clip's record: made, refused for its content, or failed for any other reason. */
export function outcomeOfRecord(record: Pick<ClipRecord, "outcome">): "ready" | "refused" | "failed" {
  if (record.outcome.status === "ready") return "ready";
  return REFUSED.has(record.outcome.reason) ? "refused" : "failed";
}

/**
 * What a restart finds of a member's newest clip, read in this order: its journal (a recovery owns it and will tell its end), its record, a reserve of it in the ledger (money moved and nothing says how it
 * ended), or nothing (it was only in memory).
 */
export type MemberLook = { readonly kind: "journal" } | { readonly kind: "record"; readonly outcome: "ready" | "refused" | "failed" } | { readonly kind: "reserved" } | { readonly kind: "nothing" };

/** The newest clip of each member at work: what a restart looks up. */
export function runningClipIds(file: ClipBatchFile): string[] {
  return file.members.flatMap((m) => (m.outcome === "running" ? (m.clipIds.slice(-1) as string[]) : []));
}

/**
 * The summary of a batch the process was running when it stopped (I5.63): no batch resumes after a restart, so its queue is over now. A queued member is dropped (memory-only, free). A member at work stays at
 * work while its journal waits for the recovery; otherwise it ends as its record says, failed when only the ledger says it moved money, dropped when nothing of it is anywhere. A batch that ended is left as it is.
 */
export function afterRestart(file: ClipBatchFile, looks: ReadonlyMap<string, MemberLook>, at: string): ClipBatchFile {
  const members = file.members.map((m): ClipBatchMemberSummary => {
    if (m.outcome === "queued") return { ...m, outcome: "dropped" };
    if (m.outcome !== "running") return m;
    const look = looks.get(m.clipIds.at(-1) ?? "") ?? { kind: "nothing" };
    switch (look.kind) {
      case "journal":
        return m;
      case "record":
        return { ...m, outcome: look.outcome };
      case "reserved":
        return { ...m, outcome: "failed" };
      case "nothing":
        return { ...m, outcome: "dropped" };
    }
  });
  return { ...file, members, endedAt: file.endedAt ?? at };
}

/** The batches of one avatar to forget: past the newest `keep` (by when they were made), those whose queue ended and whose money is closed. */
export function toForget(files: readonly ClipBatchFile[], open: (file: ClipBatchFile) => boolean, keep: number = KEEP_BATCHES): string[] {
  return newestFirst(files)
    .slice(keep)
    .flatMap((file) => (file.endedAt === undefined || open(file) ? [] : [file.batchId]));
}

/** Newest first: by when the batch was made, then by its id. */
export function newestFirst(files: readonly ClipBatchFile[]): ClipBatchFile[] {
  return [...files].sort((a, b) => (a.createdAt === b.createdAt ? (a.batchId < b.batchId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
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
