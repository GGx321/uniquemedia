import type { Ledger } from "../money/ledger";

// Stage 4, S4.6v (plan §4.8, §9): two sums of the launch card that the file cannot give, read off the ledger. Pure over the ledger's lines; the orchestrator hands them the ledger.

/** The mark of a review write's attempt id: `<setId>:write-<k>#<n>`. The launch's own compose and «Дописать» are `<setId>:writer-<chunk>#<n>` and never match. */
const REVIEW_WRITE_MARK = ":write-";

/**
 * What the owner's paid edits on the launch's scene sets (a rewrite, an idea write) committed: each attempt `<setId>:write-…` at its cost when settled, at its worst case while
 * it is open (a reconcile's estimated settle included), and nothing when it was released before it reached the network. These run under their own job's scope, outside the
 * launch's `Budget` group, so the sum is never part of `spentMicros` and never spends the limit (§4.8).
 */
export function reviewWritesMicrosOf(ledger: Pick<Ledger, "lines" | "closeOf">, setIds: readonly string[]): number {
  if (setIds.length === 0) return 0;
  const sets = new Set(setIds);
  let sum = 0;
  for (const line of ledger.lines) {
    if (line.type !== "reserve") continue;
    const mark = line.attemptId.indexOf(REVIEW_WRITE_MARK);
    if (mark <= 0 || !sets.has(line.attemptId.slice(0, mark))) continue;
    const close = ledger.closeOf(line.attemptId);
    sum += close === undefined ? line.worstMicros : close.type === "settle" ? close.costMicros : 0;
  }
  return sum;
}
