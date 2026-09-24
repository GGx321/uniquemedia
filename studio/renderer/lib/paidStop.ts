import { ERROR_MESSAGES_RU, type EngineError, type MoneyStatus } from "../../shared/engine";

/**
 * Why paid calls are stopped, as the UI must tell it:
 * - `reconcile`: open reserves, a torn ledger line or a settle above its worst
 *   case — a reconcile lifts it;
 * - `restart`: a ledger that could not be read (LEDGER_CORRUPT,
 *   LEDGER_UNREADABLE) or a ledger write that failed (LEDGER_WRITE_FAILED) —
 *   a reconcile cannot help; the file needs attention and the app a restart.
 */
export type PaidStop = { kind: "reconcile" } | { kind: "restart"; code: "LEDGER_WRITE_FAILED" | "LEDGER_CORRUPT" | "LEDGER_UNREADABLE" };

/**
 * The one rule every paid action, the account banner and the reconcile block
 * follow. The engine refuses paid calls on its own either way; this keeps the
 * UI from offering what the engine will refuse. Null while nothing stops them
 * (or the money status is not known yet).
 */
export function paidStop(view: { money: MoneyStatus | null; engineError: EngineError | null }): PaidStop | null {
  const { money, engineError } = view;
  if (money?.ledger === "unavailable") return { kind: "restart", code: money.halt.cause };
  if (money?.halt?.cause === "LEDGER_WRITE_FAILED") return { kind: "restart", code: "LEDGER_WRITE_FAILED" };
  if (money?.halt?.cause === "SETTLE_ABOVE_WORST" || money?.reconcileNeeded === true || engineError?.code === "SETTLE_ABOVE_WORST") {
    return { kind: "reconcile" };
  }
  return null;
}

/** The short line that says why paid calls wait for a restart; the Russian texts are the error codes' own. */
export function restartStopText(code: Extract<PaidStop, { kind: "restart" }>["code"]): string {
  return code === "LEDGER_WRITE_FAILED" ? `${ERROR_MESSAGES_RU.LEDGER_WRITE_FAILED} Перезапустите Studio.` : ERROR_MESSAGES_RU[code];
}
