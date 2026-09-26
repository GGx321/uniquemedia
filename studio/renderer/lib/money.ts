// Money in the UI stays in integer micro-dollars ($1 = 1_000_000) end to end.
// Formatting and parsing work on integers and digit strings only: no float
// arithmetic and no parseFloat anywhere on a money value.
import type { Estimate } from "../../shared/engine";

export const MICROS_PER_DOLLAR = 1_000_000;

/**
 * `nearest` for expected amounts; `up` for worst cases and limits, so "не
 * больше $0.23" is never an understatement; `down` for what is left.
 */
export type Rounding = "nearest" | "up" | "down";

const THIN_SPACE = " ";

function assertMicros(micros: number): void {
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

/** The plain number for an input field: "10.00" (no "$", no grouping). */
export function dollarsInputValue(micros: number): string {
  return formatUsd(micros, 2, "nearest").slice(1).replaceAll(THIN_SPACE, "");
}

export type DollarsParse =
  | { ok: true; micros: number }
  | { ok: false; reason: "empty" | "format" | "precision" | "zero" | "too-large" };

/**
 * Parses what a user typed as dollars ("10", "12.50", "$7,5", "1 000") into
 * integer micros. At most `maxDecimals` fraction digits (cents by default).
 */
export function parseDollars(input: string, opts: { maxDecimals?: number; maxMicros?: number } = {}): DollarsParse {
  const maxDecimals = opts.maxDecimals ?? 2;
  const maxMicros = opts.maxMicros ?? 10_000 * MICROS_PER_DOLLAR;
  const text = input
    .trim()
    .replace(/^\$/, "")
    .replace(/[\s  ]/g, "")
    .replace(",", ".");
  if (text === "") return { ok: false, reason: "empty" };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return { ok: false, reason: "format" };
  const whole = match[1] || "0";
  const fraction = match[2] ?? "";
  if (fraction.length > maxDecimals) return { ok: false, reason: "precision" };
  if (whole.replace(/^0+/, "").length > 9) return { ok: false, reason: "too-large" };
  const micros = Number(whole) * MICROS_PER_DOLLAR + Number(fraction.padEnd(6, "0"));
  if (micros === 0) return { ok: false, reason: "zero" };
  if (micros > maxMicros) return { ok: false, reason: "too-large" };
  return { ok: true, micros };
}

/**
 * "≈ $0.21, не больше $0.23": the expected cost rounded to the cent, the
 * worst case rounded up. Shared by every paid-confirmation UI (the wizard's
 * EstimateCard, the Avatars grid's rewrite-recovery tile) so the same price
 * reads the same way everywhere.
 */
export function estimateLine(estimate: Estimate): string {
  return `≈ ${formatUsd(estimate.expectedMicros)}, не больше ${formatUsd(estimate.worstMicros, 2, "up")}`;
}
