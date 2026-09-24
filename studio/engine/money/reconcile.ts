import { z } from "zod";
import type { Budget } from "./budget";
import type { Clock, Ledger, LedgerLine } from "./ledger";
import { costToMicros } from "./settleRule";

/** `/credits` usage lags; reconcile waits this long after the last activity. */
export const RECONCILE_QUIET_MS = 120_000;

/** `/credits` is account-wide: a difference above $0.01 from the ledger is flagged as a mismatch. */
export const RECONCILE_TOLERANCE_MICROS = 10_000;

/** Returns the parsed JSON body of `GET /api/v1/credits`; the body is validated here. */
export type CreditsFetcher = () => Promise<unknown>;

/** CLOCK_SKEW: the ledger holds a time later than the wall clock now; the wait was measured on the monotonic clock. */
export type ReconcileWarning = "CLOCK_SKEW";

export type ReconcileResult =
  | {
      ok: true;
      /** `total_usage` from /credits now. */
      creditsUsageMicros: number;
      /** Usage since the previous reconcile marker; null when `deltaUnavailable` says why. */
      creditsDeltaMicros: number | null;
      /** NO_BASELINE: the first reconcile. NEGATIVE_DELTA: usage went down (account-wide counter, or another key's reset). */
      deltaUnavailable: "NO_BASELINE" | "NEGATIVE_DELTA" | null;
      /** Ledger total for the same window, open reserves counted at their worst case. */
      ledgerTotalMicros: number;
      /** |delta − ledger| above RECONCILE_TOLERANCE_MICROS (other spending on the account, or a ledger gap); null without a delta. */
      mismatch: boolean | null;
      closedAttempts: string[];
      /** Attempts billed above their worst case in this window, now acknowledged; the halt they caused is lifted. */
      aboveWorstAttempts: string[];
      tornMoved: boolean;
      warnings: ReconcileWarning[];
    }
  | { ok: false; reason: "TOO_SOON"; retryAfterMs: number; warnings: ReconcileWarning[] }
  | { ok: false; reason: "IN_FLIGHT"; inFlight: number };

const CreditsBody = z.object({
  data: z.object({ total_usage: z.number().finite().nonnegative() }),
});

/** What `Budget.reconcile` hands to `reconcileLedger`, under its mutex. */
export interface ReconcileContext {
  ledger: Ledger;
  clock: Clock;
  inFlight: number;
  quiet: { quietMs: number; clockSkew: boolean };
  aboveWorstAttempts: string[];
  /** The Budget's own writer: appends and records the activity time. */
  write: (line: LedgerLine) => Promise<void>;
}

/** The user's reconcile action; see `reconcileLedger`. */
export function reconcile(budget: Budget, opts: { fetchCredits: CreditsFetcher }): Promise<ReconcileResult> {
  return budget.reconcile(opts);
}

/**
 * Reconcile, run by `Budget.reconcile` under its mutex (no reserve can
 * interleave): refuses while this process has an attempt in flight, or until
 * the ledger has been quiet for 2 minutes (see `Budget.quiet`); reads
 * `/credits`; computes the ledger total since the previous `reconcile` marker
 * (settles in file order after it, plus open reserves at their worst case);
 * moves a torn last line to `<ledger>.torn`; settles every open reserve at its
 * worst case with `estimated: true`; appends the new marker, which records any
 * attempt billed above its worst case and so lifts the halt it caused.
 * Nothing is written when the fetch fails or its body is unexpected.
 */
export async function reconcileLedger(ctx: ReconcileContext, opts: { fetchCredits: CreditsFetcher }): Promise<ReconcileResult> {
  const { ledger, inFlight } = ctx;
  if (inFlight > 0) return { ok: false, reason: "IN_FLIGHT", inFlight };

  const { quietMs, clockSkew } = ctx.quiet;
  const warnings: ReconcileWarning[] = clockSkew ? ["CLOCK_SKEW"] : [];
  if (quietMs < RECONCILE_QUIET_MS) {
    return { ok: false, reason: "TOO_SOON", retryAfterMs: Math.ceil(RECONCILE_QUIET_MS - quietMs), warnings };
  }

  const body = CreditsBody.safeParse(await opts.fetchCredits());
  if (!body.success) throw new Error(`Unexpected /credits body: ${z.prettifyError(body.error)}`);
  const creditsUsageMicros = costToMicros(body.data.data.total_usage);

  const previousMarkerAt = ledger.lines.findLastIndex((line) => line.type === "reconcile");
  const previous = previousMarkerAt >= 0 ? ledger.lines[previousMarkerAt] : undefined;
  const rawDelta = previous?.type === "reconcile" ? creditsUsageMicros - previous.creditsUsageMicros : null;
  const creditsDeltaMicros = rawDelta !== null && rawDelta >= 0 ? rawDelta : null;
  const deltaUnavailable = rawDelta === null ? "NO_BASELINE" : rawDelta < 0 ? "NEGATIVE_DELTA" : null;

  const open = ledger.openReserves();
  let ledgerTotalMicros = 0;
  for (const line of ledger.lines.slice(previousMarkerAt + 1)) {
    if (line.type === "settle") ledgerTotalMicros += line.costMicros;
  }
  for (const reserve of open) ledgerTotalMicros += reserve.worstMicros;
  const mismatch = creditsDeltaMicros === null ? null : Math.abs(creditsDeltaMicros - ledgerTotalMicros) > RECONCILE_TOLERANCE_MICROS;
  const { aboveWorstAttempts } = ctx;

  const tornMoved = await ledger.moveTornTail();
  const at = new Date(ctx.clock()).toISOString();
  for (const reserve of open) {
    await ctx.write({ type: "settle", attemptId: reserve.attemptId, costMicros: reserve.worstMicros, estimated: true, at });
  }
  await ctx.write({ type: "reconcile", creditsUsageMicros, ledgerTotalMicros, aboveWorstAttempts, at });

  return {
    ok: true,
    creditsUsageMicros,
    creditsDeltaMicros,
    deltaUnavailable,
    ledgerTotalMicros,
    mismatch,
    closedAttempts: open.map((r) => r.attemptId),
    aboveWorstAttempts,
    tornMoved,
    warnings,
  };
}
