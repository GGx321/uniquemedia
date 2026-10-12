export type MoneyErrorCode =
  /** The ledger file has a malformed line before its last one, or lines that contradict each other. */
  | "LEDGER_CORRUPT"
  /** The ledger ends with a torn line; nothing may be appended until reconcile moves it away. */
  | "LEDGER_TORN"
  /** An earlier append failed, so the file state is unknown; the process must stop writing. */
  | "LEDGER_WRITE_FAILED"
  /** A bill above the reserved worst case: the price table is wrong and every paid call must stop. */
  | "SETTLE_ABOVE_WORST"
  /** The attempt was already settled, released or abandoned. */
  | "ATTEMPT_CLOSED"
  /** The attempt id already has a reserve in the ledger; it is never sent twice. */
  | "ATTEMPT_ID_REUSED"
  /** A settle or release for an attempt that has no reserve, or a handle from another Budget. */
  | "UNKNOWN_ATTEMPT"
  /** Neither the live price nor the fallback table knows the model. */
  | "PRICE_UNAVAILABLE";

/** Every failure of the money core is one of these, so callers can switch on `code`. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  /** True when every paid call in this process must stop. */
  readonly fatal: boolean;
  /** 5a.3 (S5.9d, gap D): "bold" on a PRICE_UNAVAILABLE for the «Смелая» route's 2K tier alone, so the card can say the rest still works. Absent for every other price failure. */
  readonly scope?: "bold";

  constructor(code: MoneyErrorCode, message: string, options: { fatal?: boolean; scope?: "bold" } = {}) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
    this.fatal = options.fatal ?? false;
    if (options.scope !== undefined) this.scope = options.scope;
  }
}
