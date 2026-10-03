import type { BigIntStats } from "node:fs";
import type { PickedFileIdentity } from "../../shared/engine";

// The identity of a picked file: built by main (from the handle it opened) and by the engine (from the handle IT opened), with this one
// function, so the two spellings cannot drift.

type StatFields = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "birthtimeNs">;

/** A bigint stat of Node 24+ lives in a `BigInt64Array`: a 64-bit value with its top bit set arrives negative. Reinterpreted as unsigned. */
const unsigned = (value: bigint): string => String(BigInt.asUintN(64, value));

export function pickedIdentityOf(stats: StatFields): PickedFileIdentity {
  return { dev: unsigned(stats.dev), ino: unsigned(stats.ino), size: unsigned(stats.size), mtimeNs: unsigned(stats.mtimeNs), birthtimeNs: unsigned(stats.birthtimeNs) };
}

/** Whether two looks are of the same file in the same state. The size and the times matter on a file system with one inode for everything. */
export function sameIdentity(a: PickedFileIdentity, b: PickedFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.birthtimeNs === b.birthtimeNs;
}
