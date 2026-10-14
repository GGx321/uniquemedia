// 5b.2 (S5.WB2, plan s5b2 I5.65, L6): the clip money path's «alone» rule as a pure function. It is the as-built `moneyIsAlone` of 5b.1 (engine/clips/attempt.ts, S5.VR item 1), extracted with
// IDENTICAL behaviour so the engine's single clip, the batch scheduler's alone-wait and the mock all read one rule. Nothing here imports the engine: the ledger and the hold registry come in
// as the two small views below.

/** The part of the ledger the rule reads. */
export interface AloneLedger {
  /** Reserves with neither a settle nor a release. */
  openReserves(): readonly { readonly attemptId: string }[];
  /** How an attempt was closed, or undefined while it is open (or unknown). */
  closeOf(attemptId: string): { readonly type: string; readonly estimated?: boolean } | undefined;
}

/** The part of the clip hold registry the rule reads: attempt id to the epoch ms its hold lasts until, and whether a completed job's bill is known. */
export interface AloneHolds {
  entries(): ReadonlyMap<string, number>;
  isCompleted(attemptId: string): boolean;
}

export interface AloneParts {
  readonly ledger: AloneLedger;
  readonly holds: AloneHolds;
  /** The attempt the question is for: its own reserve and its own hold are not foreign money. An attempt that does not exist yet (a batch member waiting for its turn) excludes nothing. */
  readonly attemptId: string;
  /** Epoch ms. */
  readonly nowMs: number;
}

/**
 * No foreign money can still MOVE on `/credits` during this attempt's window (5b.1, VR item 1). A foreign attempt blocks the check when it has an open reserve, or a live hold that is not the
 * hold of a COMPLETED attempt settled exactly (a delivered video billed by a cost the provider gave: its bill is known and cannot be refunded). Every other live hold blocks: an abandoned submit,
 * an estimate, and also an exactly settled REFUSAL, whose temporary charge could be refunded inside this window and mask this attempt's own (a proven-free refusal's hold ends at its close
 * anyway). A refund of a foreign charge would cancel this attempt's own charge in the account-wide counter.
 */
export function clipAlone(parts: AloneParts): boolean {
  const { ledger, holds, attemptId, nowMs } = parts;
  if (ledger.openReserves().some((reserve) => reserve.attemptId !== attemptId)) return false;
  for (const [heldId, untilMs] of holds.entries()) {
    if (heldId === attemptId || untilMs <= nowMs) continue;
    const close = ledger.closeOf(heldId);
    const exactAndCompleted = close?.type === "settle" && !close.estimated && holds.isCompleted(heldId);
    if (!exactAndCompleted) return false;
  }
  return true;
}
