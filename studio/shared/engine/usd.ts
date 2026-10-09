// Money formatting on integers and digit strings only: no float arithmetic on an amount. Shared by the window and by main (a notification must say what the card says).

export const MICROS_PER_DOLLAR = 1_000_000;

/**
 * `nearest` for expected amounts; `up` for worst cases and limits, so "не
 * больше $0.23" is never an understatement; `down` for what is left.
 */
export type Rounding = "nearest" | "up" | "down";

export const THIN_SPACE = " ";

export function assertMicros(micros: number): void {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new RangeError("micros must be a non-negative safe integer");
}

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/** "$0.21" from 207_600. Totals use 2 decimals; per-item prices may use 3 or 4. */
export function formatUsd(micros: number, decimals: 2 | 3 | 4 = 2, rounding: Rounding = "nearest"): string {
  assertMicros(micros);
  const step = 10 ** (6 - decimals);
  const rest = micros % step;
  const floor = (micros - rest) / step;
  const units =
    rounding === "up" ? (rest > 0 ? floor + 1 : floor) : rounding === "down" ? floor : rest * 2 >= step ? floor + 1 : floor;
  const scale = 10 ** decimals;
  const fraction = units % scale;
  const whole = (units - fraction) / scale;
  return `$${groupThousands(whole)}.${String(fraction).padStart(decimals, "0")}`;
}

/** Below this an amount is shown with three decimals (the design's «Деньги на экране»): $0.045, not $0.05. */
const TIERED_THREE_DECIMALS_BELOW = 100_000;

/**
 * The small prices of custom categories and scene review (the CS.0 design's «Деньги на экране»): three decimals below $0.10,
 * two from there. `up` for a ceiling (after «до», a cap, an open reserve), `nearest` for an estimate after «≈» and for money
 * already spent, so the price line and the button never disagree («$0.045» on both, not «$0.05» on one); `down` for what is
 * left (the month's room, a balance), which is never overstated.
 */
export function formatUsdTiered(micros: number, rounding: Rounding): string {
  assertMicros(micros);
  return formatUsd(micros, micros < TIERED_THREE_DECIMALS_BELOW ? 3 : 2, rounding);
}
