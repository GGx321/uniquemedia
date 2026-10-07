import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { REVIEW_WRITE_IDS } from "../library/sceneSets";
import { WRITER_CALL } from "../money/estimate";
import { attemptPaid, type LedgerView } from "../runs/journal";

// CS.4b: the review-time writes of a set (a rewrite, an idea write) and what each may still do. Like a compose chunk (chunks.ts), a write's attempts are
// counted from the LEDGER across every job and every restart, never per job:
//
//   answered     = ids the ledger holds as paid (`attemptPaid`: a settled cost, an open reserve and a reconcile's estimated settle count; a free settle of a
//                  final 429/5xx and a release do not)
//   unused       = ids the ledger holds no reserve for (an id that was reserved is never sent again)
//   attemptsLeft = min(2 − answered, unused), and 0 for a write that is resolved
//
// THE ATTEMPT INVARIANT holds for a write as for a chunk: answered attempts are at most WRITER_CALL.maxAttempts whatever the jobs and crashes in between.

/** A write's ids, `${sceneSetId}:write-${k}#n`. The number `k` is the set's own counter and never repeats, so no id of a write is ever another write's. */
export function writeAttemptIds(sceneSetId: string, k: number): string[] {
  return Array.from({ length: REVIEW_WRITE_IDS }, (_, i) => `${sceneSetId}:write-${k}#${i + 1}`);
}

export interface ReviewWriteState {
  answered: number;
  unused: number;
  attemptsLeft: number;
}

/** The ledger's side of a write's attempts, as it stands now. With no ledger to read the write looks untouched (every paid command refuses without one anyway). */
export function reviewWriteState(record: ReviewWriteRecord, ledger: LedgerView | null): ReviewWriteState {
  const answered = ledger === null ? 0 : record.attemptIds.filter((attemptId) => attemptPaid(ledger, attemptId)).length;
  const unused = ledger === null ? record.attemptIds.length : record.attemptIds.filter((attemptId) => ledger.reserveOf(attemptId) === undefined).length;
  const attemptsLeft = record.closed ? 0 : Math.max(0, Math.min(WRITER_CALL.maxAttempts - answered, unused));
  return { answered, unused, attemptsLeft };
}

/** The set's review writes, in the order they began. */
export function reviewWritesOf(set: StoredSceneSet): readonly ReviewWriteRecord[] {
  return set.reviewWrites ?? [];
}

/**
 * The id the next scene of the set takes: one past the highest id the set has EVER used, a removed scene's and every id an idea write reserved (resolved
 * or dismissed ones too) included, so an id is never reused and two writes never meet.
 */
export function nextSceneId(set: StoredSceneSet): number {
  const used = [...set.scenes.map((s) => s.sceneId), ...reviewWritesOf(set).flatMap((w) => (w.kind === "idea" ? w.scenes.map((s) => s.sceneId) : []))];
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

/** How many scenes the unresolved idea writes will add: they count against the set's room. */
export function reservedIdeaScenes(set: StoredSceneSet): number {
  return reviewWritesOf(set).reduce((sum, w) => sum + (w.kind === "idea" && !w.closed ? w.scenes.length : 0), 0);
}

/**
 * The writes a card flags «замена прервана» / the set lists as an interrupted idea: unresolved, not the one a job runs now (`liveK`), and with an attempt
 * left. A write with none left can never be resumed, so it is not offered; it stays in the file for what it spent and can still be dismissed.
 */
export function interruptedWrites(set: StoredSceneSet, ledger: LedgerView | null, liveK: number | null): ReviewWriteRecord[] {
  return reviewWritesOf(set).filter((record) => !record.closed && record.k !== liveK && reviewWriteState(record, ledger).attemptsLeft > 0);
}
