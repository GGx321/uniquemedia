// Money in the UI stays in integer micro-dollars ($1 = 1_000_000) end to end.
// Formatting and parsing work on integers and digit strings only: no float
// arithmetic and no parseFloat anywhere on a money value.


import { formatUsd, MICROS_PER_DOLLAR, THIN_SPACE } from "../../shared/engine/usd";

export { formatUsd, formatUsdTiered, MICROS_PER_DOLLAR, type Rounding } from "../../shared/engine/usd";

/**
 * "$0.01–0.04": an expected price to its worst case, sharing one "$" — or
 * just "$0.01" when the two round to the same string (a swing too small to
 * show). Never prefix a lone worst case with "≈": that overstates the
 * approximate cost, sometimes by several times over. The expected bound
 * rounds to the nearest; the worst bound rounds up, like every other worst
 * case and limit in the app — «не больше» must never understate it.
 */
export function formatUsdRange(expectedMicros: number, worstMicros: number, decimals: 2 | 3 | 4 = 2): string {
  const expected = formatUsd(expectedMicros, decimals, "nearest");
  const worst = formatUsd(worstMicros, decimals, "up");
  return expected === worst ? expected : `${expected}–${worst.slice(1)}`;
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
