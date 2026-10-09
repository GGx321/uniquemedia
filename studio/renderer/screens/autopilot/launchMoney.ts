import { formatUsdTiered } from "../../lib/money";

// S4.9d: the one rule every screen of a launch says its money by — the live card, the folded line at 1200, «Остановить запуск?», the history, a launch's page
// and «Последний запуск» (S4.9c review N2: it was written out three times). Only formatting: the figures are the engine's (`spentMicros`, W′ =
// `plannedWorstMicros`), never computed here.

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
