// S5.R1 round 2: the floor pins measure a refusal at its longest, and a refusal tells its slot numbers with `slotList` (writer.ts): a run of consecutive numbers is one
// range, anything else is told number by number. So the longest list over a set of slot numbers is neither «all of them» (one range) nor «every other one»: a pair, a gap, a
// pair is dearer per slot. This finds the subset of `candidates` whose told list is the longest, exactly (a search over the choices, not a guess at a pattern).

const digits = (n: number): number => String(n).length;

/**
 * The subset of `candidates` (distinct, ascending) that `slotList` tells in the most characters, ascending. A choice is a single number or a run of consecutive numbers (told
 * as «a-b»); the number after a choice is never adjacent to it, or the two would be one run.
 */
export function worstSlotList(candidates: readonly number[]): number[] {
  const n = candidates.length;
  const at = (i: number): number => candidates[i] as number;
  /** The first candidate that may be chosen after one ending at `j`: not the next integer, or it would join `j`'s run. */
  const after = (j: number): number => (j + 1 < n && at(j + 1) === at(j) + 1 ? j + 2 : j + 1);
  const best: number[] = new Array<number>(n + 3).fill(0);
  const choice: Array<{ to: number } | null> = new Array<{ to: number } | null>(n + 3).fill(null);
  for (let i = n - 1; i >= 0; i--) {
    best[i] = best[i + 1] as number;
    choice[i] = null;
    let to = i;
    for (;;) {
      const told = to === i ? digits(at(i)) + 1 : digits(at(i)) + 1 + digits(at(to)) + 1;
      const value = told + (best[Math.min(after(to), n)] as number);
      if (value > (best[i] as number)) {
        best[i] = value;
        choice[i] = { to };
      }
      if (to + 1 < n && at(to + 1) === at(to) + 1) to++;
      else break;
    }
  }
  const chosen: number[] = [];
  for (let i = 0; i < n; ) {
    const pick = choice[i];
    if (pick === null) {
      i++;
      continue;
    }
    for (let k = i; k <= pick.to; k++) chosen.push(at(k));
    i = after(pick.to);
  }
  return chosen;
}
