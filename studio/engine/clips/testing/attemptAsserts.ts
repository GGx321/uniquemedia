import { expect } from "bun:test";
import type { ClipRunResult } from "../attempt";
import type { Rig } from "./attemptRig";

// Test-only (S5.V3b): narrowing helpers and readable summaries, so each cell of the settle table asserts its ledger lines, its journal lines and its next step in a line or two.

export const KLING_RESERVE = 504_000;
export const GROK_RESERVE = 850_000;
export const KLING_BILLED = 420_000;
export const GROK_BILLED = 710_000;

type Kind<K extends ClipRunResult["kind"]> = Extract<ClipRunResult, { kind: K }>;

export function completed(result: ClipRunResult): Kind<"completed"> {
  if (result.kind !== "completed") throw new Error(`expected a completed clip, got ${describe(result)}`);
  return result;
}

export function failed(result: ClipRunResult): Kind<"failed"> {
  if (result.kind !== "failed") throw new Error(`expected a failed clip, got ${describe(result)}`);
  return result;
}

export function late(result: ClipRunResult): Kind<"late"> {
  if (result.kind !== "late") throw new Error(`expected a late clip, got ${describe(result)}`);
  return result;
}

function describe(result: ClipRunResult): string {
  return result.kind === "failed" ? `failed ${result.reason}` : result.kind;
}

/** The journal as `type` or `type:attemptId:status:costSource`, in file order. */
export function journalOf(rig: Rig): string[] {
  return rig.journalLines.map((l) => {
    if (l.type === "ended") return `ended:${l.attemptId}:${l.status}:${l.costSource}`;
    if (l.type === "submitted") return `submitted:${l.attemptId}`;
    return l.type;
  });
}

/** The index of an event in the trace; fails the test when it never happened. */
export function at(rig: Rig, event: string): number {
  const index = rig.trace.indexOf(event);
  if (index < 0) throw new Error(`the trace has no ${event}: ${rig.trace.join(" | ")}`);
  return index;
}

/** Whether an event starting with `prefix` is in the trace. */
export function has(rig: Rig, prefix: string): boolean {
  return rig.trace.some((e) => e.startsWith(prefix));
}

/** Nothing of Grok ran: no reserve, no POST, no journal line, no hold. */
export function expectNoGrok(rig: Rig, grokId: string): void {
  expect(rig.posts("grok")).toHaveLength(0);
  expect(rig.reserves().some((r) => r.attemptId === grokId)).toBe(false);
  expect(rig.journalLines.some((l) => (l.type === "submitted" || l.type === "ended") && l.attemptId === grokId)).toBe(false);
  expect(rig.holds.untilOf(grokId)).toBeUndefined();
}

/** The money of the clip's scope: settled plus open at worst. */
export function clipMoney(rig: Rig): number {
  const settled = rig.settles().reduce((sum, s) => sum + s.costMicros, 0);
  const open = rig.ledger.openReserves().reduce((sum, r) => sum + r.worstMicros, 0);
  return settled + open;
}
