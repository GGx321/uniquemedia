import type { Ledger } from "./ledger";

/**
 * What a job cost, as the ledger books it: each of its attempts' reserves at the cost it settled at (a reconcile's estimated settle
 * included), at its worst case while it is still open (a request that may have been billed, counted at its worst until the owner
 * reconciles), and at nothing when it was released (it never left). The ledger is the one truth: a failed category call's «потрачено»
 * and a category's total are read from here, not added up from what the client happened to return.
 */
export function jobSpentMicros(ledger: Pick<Ledger, "lines" | "closeOf">, jobId: string): number {
  let total = 0;
  for (const line of ledger.lines) {
    if (line.type !== "reserve" || line.jobId !== jobId) continue;
    const close = ledger.closeOf(line.attemptId);
    if (close === undefined) total += line.worstMicros;
    else if (close.type === "settle") total += close.costMicros;
  }
  return total;
}

/**
 * The part of `jobSpentMicros` that is a reserve still open: counted at its attempt's worst case until the owner reconciles. It is what
 * decides whether «учтён по худшей цене до сверки» is true of a job; a job whose attempts are all closed has none.
 */
export function jobOpenReserveMicros(ledger: Pick<Ledger, "lines" | "closeOf">, jobId: string): number {
  let total = 0;
  for (const line of ledger.lines) {
    if (line.type === "reserve" && line.jobId === jobId && ledger.closeOf(line.attemptId) === undefined) total += line.worstMicros;
  }
  return total;
}
