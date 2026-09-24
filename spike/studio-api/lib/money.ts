import { z } from "zod";
import { P } from "./config";
import { appendJsonl, readJsonl } from "./files";

/** Integer micro-dollars -> "$1.2345" using integer arithmetic only. */
export function usd(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0").slice(0, 4);
  return `${sign}$${whole}.${frac}`;
}

/** "7", "7.5", "7.00" -> integer micro-dollars, without going through a float. */
export function parseUsdToMicros(input: string): number {
  const m = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid USD amount "${input}" (expected e.g. 7 or 7.00)`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000 + frac;
}

/** The API reports cost as a float in USD; it is converted once, here. */
export function costToMicros(cost: number): number {
  return Math.round(cost * 1e6);
}

export const LedgerLine = z.object({
  jobId: z.string(),
  model: z.string(),
  costMicros: z.number().int().nonnegative(),
  at: z.string(),
  estimated: z.literal(true).optional(),
});
export type LedgerLine = z.infer<typeof LedgerLine>;

/** A malformed line throws: an unreadable ledger must stop spending. */
export function readLedger(): Promise<LedgerLine[]> {
  return readJsonl(P.ledger, LedgerLine);
}

/** Job ids that already produced a billed response; such a job is never requested again. */
export async function billedJobIds(): Promise<Set<string>> {
  return new Set((await readLedger()).map((l) => l.jobId));
}

/** Sum of every billed response so far. */
export async function ledgerSpentMicros(): Promise<number> {
  const lines = await readLedger();
  let sum = 0;
  for (const l of lines) sum += l.costMicros;
  if (!Number.isSafeInteger(sum)) throw new Error("Ledger sum overflowed");
  return sum;
}

/**
 * Cap enforcement for one process. `spent` starts from the ledger; every paid
 * request reserves its worst case before it starts and settles to the billed
 * amount (or releases) when it ends. JS is single-threaded, so check-and-reserve
 * in `tryReserve` cannot interleave with another request's reservation.
 */
export class Budget {
  private spent: number;
  private reserved = 0;
  capHit = false;

  constructor(readonly capMicros: number, spentMicros: number) {
    this.spent = spentMicros;
  }

  get spentMicros(): number {
    return this.spent;
  }

  /** True when the request may start; false marks the cap as hit. */
  tryReserve(worstMicros: number): boolean {
    if (this.spent + this.reserved + worstMicros > this.capMicros) {
      this.capHit = true;
      return false;
    }
    this.reserved += worstMicros;
    return true;
  }

  /** Called exactly once per successful reservation. `billedMicros` is 0 for unbilled outcomes. */
  settle(worstMicros: number, billedMicros: number): void {
    this.reserved -= worstMicros;
    this.spent += billedMicros;
  }
}

export async function appendLedger(line: LedgerLine): Promise<void> {
  await appendJsonl(P.ledger, line);
}
