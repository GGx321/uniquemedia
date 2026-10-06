import type { ReleaseLine, ReserveLine, SettleLine } from "../../money/ledger";
import type { LedgerView } from "../../runs/journal";

// A ledger as the scene sets read it (reserves and how they were closed), without a file: a test says what happened to each attempt id.

export type FakeClose = { type: "settle"; costMicros: number; estimated?: boolean } | { type: "release" };

export interface FakeAttempt {
  /** The reserve's worst case; 37_500 µ$ (one writer attempt at the fallback prices) unless a test says otherwise. */
  worst?: number;
  /** Absent: the reserve is still open (an interrupted request, or one in flight). */
  close?: FakeClose;
}

export const WRITER_ATTEMPT_WORST = 37_500;

const AT = "2026-10-07T12:00:00.000Z";

export function fakeLedger(attempts: Record<string, FakeAttempt>): LedgerView {
  return {
    reserveOf: (attemptId): ReserveLine | undefined => {
      const attempt = attempts[attemptId];
      if (attempt === undefined) return undefined;
      return { type: "reserve", attemptId, jobId: "job-aaaa-0001", scope: { avatarJobId: "job-aaaa-0001" }, model: "x-ai/grok-4.3", worstMicros: attempt.worst ?? WRITER_ATTEMPT_WORST, at: AT };
    },
    closeOf: (attemptId): SettleLine | ReleaseLine | undefined => {
      const close = attempts[attemptId]?.close;
      if (close === undefined) return undefined;
      return close.type === "release"
        ? { type: "release", attemptId, reason: "not sent", at: AT }
        : { type: "settle", attemptId, costMicros: close.costMicros, estimated: close.estimated ?? false, at: AT };
    },
  };
}
