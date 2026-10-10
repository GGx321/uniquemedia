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

// The one rule every place says a launch's money by (S4.9d; S4.10 fix C moved it here from the window so main's notification of a launch's end says what the
// card says): the live card, the folded line at 1200, «Остановить запуск?», the history, a launch's page, «Последний запуск» and the notification. Only
// formatting: the figures are the engine's (`spentMicros`, W′ = `plannedWorstMicros`), never computed here.

/**
 * A launch that paid for nothing AND spent nothing: «бесплатно» in place of «Потрачено $S из $W′». One with a W′ of 0 that still spent (an A2 breach, the
 * orchestrator's own `paidHold { internal }`) is never called free: it shows the engine's figures, «$0.30 из $0».
 */
export function isFree(spentMicros: number, plannedWorstMicros: number): boolean {
  return plannedWorstMicros === 0 && spentMicros === 0;
}

/**
 * W′ after «из»: «$4.14», «$0.090», rounded up like every limit. A limit of 0 reads «$0» (S4.9c review N3): «из $0.000» would print three decimals of a
 * sum that has none, which is what an A2 breach of a launch planned free shows.
 */
export function limitUsd(plannedWorstMicros: number): string {
  return plannedWorstMicros === 0 ? "$0" : formatUsdTiered(plannedWorstMicros, "up");
}
