import { monthRoomMicros, type MonthRoom } from "../../shared/autopilot/money";
import { scopeKey, type Budget } from "../money/budget";
import type { Scope } from "../money/ledger";

// Stage 4 (plan §4.4, invariant A21): the month's room with live caps. `Engine.#checkMonthlyRoom` counts spent + open + held, so the unspent rest of a running
// job's cap is invisible to it. A launch sizes its slices, and shows its fit, against this room instead: it subtracts every live scope's `max(0, cap − committed)`.

/** A scope that may still spend and is not in the engine's cap table: a launch's slice run that is not running now but can be resumed. */
export interface LiveScope {
  scope: Scope;
  capMicros: number;
}

/**
 * The room now: the live scopes are the caps registered for running jobs (`caps`, the table the Budget reads, set at a job's start and dropped at its end) and
 * `extraLive`, the launch's resumable slices (they will come back). A scope in both is counted once, at the running job's cap.
 *
 * `exclude` leaves one scope out of the live scopes. A `resume-slice` budget hold compares the slice's own remaining worst case with the room, so the room it
 * is compared with must not subtract that same slice's unspent cap a second time; with no other live scope it then clears exactly when `#checkMonthlyRoom`
 * would pass the resume.
 */
export function monthRoom(budget: Budget, caps: ReadonlyMap<string, number>, extraLive: readonly LiveScope[] = [], exclude?: Scope): MonthRoom {
  const status = budget.status();
  const committed = budget.committedByScope();
  const live = new Map<string, number>(caps);
  for (const { scope, capMicros } of extraLive) if (!live.has(scopeKey(scope))) live.set(scopeKey(scope), capMicros);
  if (exclude !== undefined) live.delete(scopeKey(exclude));
  return monthRoomMicros({
    budgetMicros: status.monthlyBudgetMicros,
    spentMicros: status.spentThisMonthMicros,
    openMicros: status.openReserveMicros,
    heldMicros: status.heldMicros,
    liveScopes: [...live].map(([key, capMicros]) => ({ capMicros, committedMicros: committed.get(key) ?? 0 })),
  });
}
