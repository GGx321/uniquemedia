/** What a `Range` request header asks for, against a file of a known size. */
export type RangeDecision =
  | { readonly kind: "whole" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const UNSATISFIABLE: RangeDecision = { kind: "unsatisfiable" };

// One `bytes` range, digits only. At most 15 digits per number: every value then fits a double exactly,
// and a longer one (which no file of ours reaches) is refused instead of being rounded.
const SINGLE_RANGE = /^bytes=(\d{0,15})-(\d{0,15})$/;

/**
 * Decides what a `Range` header asks for against a file of `size` bytes (RFC 9110, section 14, narrowed):
 * - no header: the whole file;
 * - one `bytes` range, `a-b`, `a-` or `-n`: those bytes, `b` clamped to the last byte, `-n` longer than the file all of it;
 * - everything else is `unsatisfiable`, which the handler answers with 416: a start at or past EOF, `-0`, an end before
 *   the start, any range on an empty file, a malformed header, another unit, and several ranges.
 *
 * DELIBERATE departures from RFC 9110 section 14.2, which says a server MUST ignore a Range header in a unit it does not
 * understand (and MAY ignore a malformed one or answer several ranges in a multipart body): here all of those are 416.
 * The only client is our own renderer's media elements, which send one `bytes` range; anything else is not a player, and
 * answering it with nothing is safer than streaming a whole file to a request that meant something we did not parse.
 */
export function decideRange(header: string | null, size: number): RangeDecision {
  if (header === null) return { kind: "whole" };
  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null || size <= 0) return UNSATISFIABLE;
  const [, first = "", last = ""] = match;
  if (first === "") {
    // A suffix: the last `n` bytes.
    if (last === "") return UNSATISFIABLE;
    const suffix = Number(last);
    if (suffix === 0) return UNSATISFIABLE;
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return UNSATISFIABLE;
  if (last === "") return { kind: "partial", start, end: size - 1 };
  const end = Number(last);
  if (end < start) return UNSATISFIABLE;
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}
