import type { ClipJournalLine } from "./schemas";
import type { ClipTimings } from "./timings";

// Stage 5, 5b.1, S5.V3b (plan s5b1 I5.48, critic M2, r2.2 #6): the reconcile hold registry. A video bills when it completes, and probe P0 showed a charge refunded 10-25 s later, so the
// reconcile must wait while an attempt of this engine may still bill. The wait is a map `{attemptId → untilMs}`, kept APART FROM THE JOBS: a job may end long before its hold does (an uncertain
// submit ends the clip at once, but that attempt may still bill for 20 min). It is pure over an injected clock and injected timers; `ClipService` (V4a1) owns one at run time, and `#reconcile`,
// `#moneyStatus` read it (`waitMs`, `latestUntil`). It touches no ledger and no job.
//
// | Attempt state                                                  | Held until                      |
// | submitted, no terminal status yet                              | submit + 60 min                 |
// | uncertain submit (5xx, timeout, network at the POST)           | the reserve line's `at` + 20 min |
// | terminal status (completed, failed, cancelled, expired)        | terminal + 2 min                |
// | a ledger reserve with no `submitted` line (a throw, a crash)   | the reserve line's `at` + 20 min |

export interface HoldTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: HoldTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ClipHoldsDeps {
  /** Epoch ms. */
  readonly now: () => number;
  /** Defaults to the global timers; a test passes its own. */
  readonly timers?: HoldTimers;
  /** Called once when an entry is added, changed, released or expires: no ledger line marks these moments, so `money.changed` is driven by this. Never called after `clear()`. */
  readonly onChange: () => void;
}

export interface ClipHolds {
  /** Holds `attemptId` until `untilMs`, replacing its earlier entry. A time not after now holds nothing (and ends the attempt's earlier hold). */
  hold(attemptId: string, untilMs: number): void;
  /** Ends an attempt's hold at once (an attempt that provably never reached the provider). */
  release(attemptId: string): void;
  untilOf(attemptId: string): number | undefined;
  /** The latest `until` of all the entries, or null when nothing is held. */
  latestUntil(): number | null;
  /** How long the reconcile has to wait now: the latest `until` minus now, or 0. */
  waitMs(): number;
  /** A copy. */
  entries(): ReadonlyMap<string, number>;
  /** Shutdown: cancels every timer and drops every entry, and the registry says nothing more. */
  clear(): void;
}

export function createClipHolds(deps: ClipHoldsDeps): ClipHolds {
  const timers = deps.timers ?? realTimers;
  const held = new Map<string, { until: number; timer: unknown }>();
  let closed = false;

  function drop(attemptId: string): boolean {
    const entry = held.get(attemptId);
    if (entry === undefined) return false;
    timers.clear(entry.timer);
    held.delete(attemptId);
    return true;
  }

  return {
    hold(attemptId, untilMs) {
      if (closed) return;
      const ms = untilMs - deps.now();
      if (ms <= 0) {
        if (drop(attemptId)) deps.onChange();
        return;
      }
      if (held.get(attemptId)?.until === untilMs) return;
      drop(attemptId);
      const entry: { until: number; timer: unknown } = { until: untilMs, timer: null };
      entry.timer = timers.set(() => {
        // A timer that was replaced or cleared must not remove its successor.
        if (held.get(attemptId) !== entry) return;
        held.delete(attemptId);
        deps.onChange();
      }, ms);
      held.set(attemptId, entry);
      deps.onChange();
    },
    release(attemptId) {
      if (closed) return;
      if (drop(attemptId)) deps.onChange();
    },
    untilOf: (attemptId) => held.get(attemptId)?.until,
    latestUntil() {
      let latest: number | null = null;
      for (const { until } of held.values()) latest = latest === null ? until : Math.max(latest, until);
      return latest;
    },
    waitMs() {
      let latest: number | null = null;
      for (const { until } of held.values()) latest = latest === null ? until : Math.max(latest, until);
      return latest === null ? 0 : Math.max(0, latest - deps.now());
    },
    entries: () => new Map([...held].map(([id, entry]) => [id, entry.until])),
    clear() {
      closed = true;
      for (const { timer } of held.values()) timers.clear(timer);
      held.clear();
    },
  };
}

/** A ledger reserve with no `submitted` line, and an uncertain submit: the POST may have left (a throw, a crash, no answer). One base in this process and after a restart: the reserve line's `at`. */
export function holdUntilForReserve(reserveAtMs: number, t: ClipTimings): number {
  return reserveAtMs + t.holdUncertainMs;
}

/** A submitted job with no terminal status yet. */
export function holdUntilForSubmitted(submittedAtMs: number, t: ClipTimings): number {
  return submittedAtMs + t.holdSubmittedMs;
}

/** A terminal status (completed, failed, cancelled, expired), a refusal included. */
export function holdUntilForTerminal(terminalAtMs: number, t: ClipTimings): number {
  return terminalAtMs + t.holdTerminalMs;
}

export interface RestartHoldInput {
  /** The ledger's reserves of clip attempts (the caller keeps the ids that are clip attempts), with the reserve line's `at`. */
  readonly reserves: readonly { attemptId: string; at: string }[];
  /** The journal lines of every clip that has no record yet. */
  readonly journal: readonly ClipJournalLine[];
  readonly nowMs: number;
  readonly timings: ClipTimings;
}

/**
 * The holds an engine takes up after a restart, from what is on disk (I5.48's last rows). Per attempt, the latest fact wins: an `ended` line holds 2 min from its `at`; else a `submitted` line
 * holds 60 min from its `at`; else a reserve alone (a throw or a crash between the reserve and the `submitted` fsync) holds 20 min from the reserve line's `at`. An entry whose time has passed
 * is left out. The caller hands the result to `ClipHolds.hold` one by one.
 */
export function holdsAfterRestart(input: RestartHoldInput): Map<string, number> {
  const { timings: t } = input;
  const until = new Map<string, number>();
  const rank = new Map<string, number>();
  const put = (attemptId: string, level: number, untilMs: number): void => {
    if (Number.isNaN(untilMs) || (rank.get(attemptId) ?? 0) > level) return;
    rank.set(attemptId, level);
    until.set(attemptId, untilMs);
  };
  for (const reserve of input.reserves) put(reserve.attemptId, 1, holdUntilForReserve(Date.parse(reserve.at), t));
  for (const line of input.journal) {
    if (line.type === "submitted") put(line.attemptId, 2, holdUntilForSubmitted(Date.parse(line.at), t));
    else if (line.type === "ended") put(line.attemptId, 3, holdUntilForTerminal(Date.parse(line.at), t));
  }
  for (const [attemptId, untilMs] of until) if (untilMs <= input.nowMs) until.delete(attemptId);
  return until;
}
