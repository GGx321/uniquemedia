import { clipAttemptId } from "./journal";

/** The part of the ledger the open reserve of a clip is read from: a clip's reserve lines and whether each is closed (a settle or a release). */
export interface ClipReserveLedger {
  reserveOf(attemptId: string): { readonly worstMicros: number } | undefined;
  closeOf(attemptId: string): unknown;
}

/**
 * What the ledger can still charge for a clip (S5.V8b): the sum of the reserves of its attempts (Kling's and Grok's) that have no settle and no release. Zero when none is open. The window never
 * adds this up: the engine says it, in each phase of the job where a reserve is open.
 */
export function openClipReserveMicros(ledger: ClipReserveLedger | null, clipId: string): number {
  if (ledger === null) return 0;
  return ([1, 2] as const).reduce((sum, n) => {
    const id = clipAttemptId(clipId, n);
    const reserve = ledger.reserveOf(id);
    return reserve === undefined || ledger.closeOf(id) !== undefined ? sum : sum + reserve.worstMicros;
  }, 0);
}
