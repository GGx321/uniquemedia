import { LAUNCH_SLICE_MAX_PHOTOS, type BudgetHoldKind, type MonthFit } from "../engine/autopilot";

// Stage 4 (plan §4.3, §4.4, §18; invariants A2, A21): the launch's money arithmetic as pure functions over whole micro-dollars. The engine feeds them its ledger
// and caps (`engine/autopilot/room.ts`), the orchestrator (S4.6) feeds them the set files' slices; none of them reads a clock, a file or a price.

function checkMicros(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative whole number of micro-dollars, got ${value}`);
}

function checkCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative whole number, got ${value}`);
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("launch money is out of range");
  return value;
}

// ---------- the month's room ----------

/** A scope that may still spend: its cap and what it has committed so far (settled, open at worst and held). */
export interface LiveScopeMoney {
  capMicros: number;
  committedMicros: number;
}

export interface MonthRoom {
  budgetMicros: number;
  /** Spent + open + held + the unspent cap of every live scope. */
  committedMicros: number;
  /** The budget less `committedMicros`, never below zero. */
  freeMicros: number;
}

/**
 * The month's room with live caps (plan §4.4, A21): `budget − (spent + open + held + Σ over live scopes of max(0, cap − committed))`. The unspent rest of a
 * running job's cap is not free: the job may still reserve it, so a slice sized to the room never meets BUDGET_EXCEEDED mid-run from a job that was already
 * running when it was sized.
 */
export function monthRoomMicros(input: { budgetMicros: number; spentMicros: number; openMicros: number; heldMicros: number; liveScopes: readonly LiveScopeMoney[] }): MonthRoom {
  checkMicros("budgetMicros", input.budgetMicros);
  checkMicros("spentMicros", input.spentMicros);
  checkMicros("openMicros", input.openMicros);
  checkMicros("heldMicros", input.heldMicros);
  let unspent = 0;
  for (const scope of input.liveScopes) {
    checkMicros("capMicros", scope.capMicros);
    checkMicros("committedMicros", scope.committedMicros);
    unspent += Math.max(0, scope.capMicros - scope.committedMicros);
  }
  const committedMicros = safe(input.spentMicros + input.openMicros + input.heldMicros + unspent);
  return { budgetMicros: input.budgetMicros, committedMicros, freeMicros: Math.max(0, input.budgetMicros - committedMicros) };
}

/**
 * Whether the month holds the launch (plan §4.4): `fits` when the room R covers the worst case W, `fits-expected` when it covers the expected cost E only,
 * `short` when it does not even cover E. One function for the preview and for `autopilot.start`.
 */
export function monthFit(freeMicros: number, expectedMicros: number, worstMicros: number): MonthFit {
  checkMicros("freeMicros", freeMicros);
  checkMicros("expectedMicros", expectedMicros);
  checkMicros("worstMicros", worstMicros);
  if (expectedMicros > worstMicros) throw new RangeError(`the expected cost ${expectedMicros} is above the worst case ${worstMicros}`);
  if (freeMicros >= worstMicros) return "fits";
  return freeMicros >= expectedMicros ? "fits-expected" : "short";
}

// ---------- the launch's own scopes ----------

/** A scope the launch created: a finished one has spent what it committed, a live one may still spend up to its cap. */
export type LaunchScopeMoney = { state: "finished"; committedMicros: number } | { state: "live"; capMicros: number };

/** A2's quantity: Σ over the launch's scopes of (committed for a finished scope, cap for a live one). Σ of caps alone is not the right quantity. */
export function launchCommittedMicros(scopes: readonly LaunchScopeMoney[]): number {
  let sum = 0;
  for (const scope of scopes) {
    const micros = scope.state === "finished" ? scope.committedMicros : scope.capMicros;
    checkMicros(scope.state === "finished" ? "committedMicros" : "capMicros", micros);
    sum += micros;
  }
  return safe(sum);
}

/** A2: the launch's sum stays within its recomputed worst case W′ (≤ accepted). */
export function withinLaunchCeiling(scopes: readonly LaunchScopeMoney[], plannedWorstMicros: number): boolean {
  checkMicros("plannedWorstMicros", plannedWorstMicros);
  return launchCommittedMicros(scopes) <= plannedWorstMicros;
}

/**
 * The draw allocation left (plan §4.3 item 4): `drawMicros − Σ committed(finished slices) − Σ cap(live slices)`, never below zero. A finished slice spent less
 * than its cap, and the slack is allocated again; a live slice (running, or resumable) still holds its whole cap.
 */
export function drawAllocationLeft(drawMicros: number, slices: readonly LaunchScopeMoney[]): number {
  checkMicros("drawMicros", drawMicros);
  return Math.max(0, drawMicros - launchCommittedMicros(slices));
}

// ---------- slice sizing ----------

export interface SliceSize {
  photos: number;
  /** The slice run's cap: its worst case at today's price, `photos × photoWorst`. */
  capMicros: number;
  /**
   * Why the slice is empty. `nothing-left`: no scene is left to draw. `allocation`: the draw allocation left is below one photo (the price rose, §4.3).
   * `room`: the month has too little room (§4.4). Null for a slice with photos. The allocation is named first when both are short.
   */
  blockedBy: null | "nothing-left" | "allocation" | "room";
}

/**
 * A slice's size (plan §4.4): `min(25, scenes left, ⌊draw allocation left / photoWorst⌋, ⌊room / photoWorst⌋)`. 25 bounds the held worst case and keeps «Пауза»
 * responsive. A free photo (price 0) is limited by the scenes and 25 only.
 */
export function sliceSize(input: { scenesLeft: number; drawLeftMicros: number; roomMicros: number; photoWorstMicros: number }): SliceSize {
  checkCount("scenesLeft", input.scenesLeft);
  checkMicros("drawLeftMicros", input.drawLeftMicros);
  checkMicros("roomMicros", input.roomMicros);
  checkMicros("photoWorstMicros", input.photoWorstMicros);
  if (input.scenesLeft === 0) return { photos: 0, capMicros: 0, blockedBy: "nothing-left" };
  const price = input.photoWorstMicros;
  const byAllocation = price === 0 ? Number.POSITIVE_INFINITY : Math.floor(input.drawLeftMicros / price);
  const byRoom = price === 0 ? Number.POSITIVE_INFINITY : Math.floor(input.roomMicros / price);
  const photos = Math.min(LAUNCH_SLICE_MAX_PHOTOS, input.scenesLeft, byAllocation, byRoom);
  if (photos === 0) return { photos: 0, capMicros: 0, blockedBy: byAllocation === 0 ? "allocation" : "room" };
  return { photos, capMicros: safe(photos * price), blockedBy: null };
}

// ---------- the budget hold ----------

export interface BudgetHoldDetail {
  freeMicros: number;
  needMicros: number;
  kind: BudgetHoldKind;
}

/**
 * The budget hold's one threshold, `needMicros` (plan §18): a new slice needs the room for one photo's worst case; a resumed slice needs the room for the rest of
 * the slice already started (`runs.resume` asks for it): `#remaining`'s worst case, NOT `cap − committed`. The hold is the contract's `paidHold.detail` for `budget`.
 *
 * `freeMicros` of a `resume-slice` hold is the room WITHOUT the slice itself (`monthRoom`'s `exclude`, `Engine.resumeSliceHold`): the room with live caps already
 * subtracts the slice's unspent cap, which is the very amount `needMicros` asks for, so comparing the two would count the remainder twice.
 */
export function budgetHoldDetail(input: { kind: BudgetHoldKind; freeMicros: number; photoWorstMicros: number; resumeRemainingWorstMicros?: number }): BudgetHoldDetail {
  checkMicros("freeMicros", input.freeMicros);
  if (input.kind === "new-slice") {
    checkMicros("photoWorstMicros", input.photoWorstMicros);
    return { kind: "new-slice", freeMicros: input.freeMicros, needMicros: input.photoWorstMicros };
  }
  if (input.resumeRemainingWorstMicros === undefined) throw new TypeError("a resumed slice's hold needs the remaining worst case of the slice");
  checkMicros("resumeRemainingWorstMicros", input.resumeRemainingWorstMicros);
  return { kind: "resume-slice", freeMicros: input.freeMicros, needMicros: input.resumeRemainingWorstMicros };
}

/** The admission rule for a budget hold (plan §18): the hold is gone when the room is at least `needMicros`. */
export function budgetHoldCleared(detail: BudgetHoldDetail, freeMicros: number): boolean {
  checkMicros("freeMicros", freeMicros);
  return freeMicros >= detail.needMicros;
}
