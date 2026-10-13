import { describe, expect, test } from "bun:test";
import { createClipHolds, holdsAfterRestart, holdUntilForReserve, holdUntilForSubmitted, holdUntilForTerminal, holdUntilForUncertain, type HoldTimers } from "./holds";
import type { ClipJournalLine } from "./schemas";
import { REAL_CLIP_TIMINGS, SHORT_CLIP_TIMINGS } from "./timings";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5b.1, S5.V3b (plan s5b1 I5.48, critic M2, r2.2 #6): the hold registry `{attemptId → until}`, pure over an injected clock and injected timers, apart from every job. A clip's job may end
// long before its hold does: an uncertain submit ends the clip at once, but that attempt may still bill for 20 min.

const T = REAL_CLIP_TIMINGS;
const MIN = 60_000;
const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Timers that fire only when the test moves the clock, in the order of their due times. */
class FakeTimers implements HoldTimers {
  now = T0;
  private nextId = 1;
  private readonly pending = new Map<number, { due: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { due: this.now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.pending.delete(handle);
  }

  get count(): number {
    return this.pending.size;
  }

  advanceTo(ms: number): void {
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.due <= ms).sort((a, b) => a[1].due - b[1].due)[0];
      if (due === undefined) break;
      this.now = due[1].due;
      this.pending.delete(due[0]);
      due[1].fn();
    }
    this.now = ms;
  }
}

function rig() {
  const timers = new FakeTimers();
  let changes = 0;
  const holds = createClipHolds({ now: () => timers.now, timers, onChange: () => void changes++ });
  return { timers, holds, changes: () => changes };
}

describe("the rows of I5.48's table", () => {
  test("a ledger reserve with no submitted line is held 20 min from the reserve line's `at`", () => {
    expect(holdUntilForReserve(T0, T)).toBe(T0 + 20 * MIN);
  });

  test("an uncertain submit is held 20 min from the moment the POST left", () => {
    expect(holdUntilForUncertain(T0, T)).toBe(T0 + 20 * MIN);
  });

  test("a submitted job with no terminal status is held 60 min from the submit", () => {
    expect(holdUntilForSubmitted(T0, T)).toBe(T0 + 60 * MIN);
  });

  test("a terminal status is held 2 min from the status", () => {
    expect(holdUntilForTerminal(T0, T)).toBe(T0 + 2 * MIN);
  });

  test("the short set keeps the same order of holds", () => {
    expect(holdUntilForTerminal(T0, SHORT_CLIP_TIMINGS)).toBeLessThan(holdUntilForUncertain(T0, SHORT_CLIP_TIMINGS));
    expect(holdUntilForUncertain(T0, SHORT_CLIP_TIMINGS)).toBeLessThan(holdUntilForSubmitted(T0, SHORT_CLIP_TIMINGS));
  });
});

describe("the registry", () => {
  test("holds an attempt until the time it was given and says so once", () => {
    const { holds, changes } = rig();
    holds.hold("clip-1:video#1", T0 + 20 * MIN);
    expect(holds.untilOf("clip-1:video#1")).toBe(T0 + 20 * MIN);
    expect(holds.latestUntil()).toBe(T0 + 20 * MIN);
    expect(changes()).toBe(1);
  });

  test("holds nothing when it is empty", () => {
    const { holds } = rig();
    expect(holds.latestUntil()).toBeNull();
    expect(holds.waitMs()).toBe(0);
    expect(holds.entries().size).toBe(0);
  });

  test("a terminal status replaces the 60 min entry with terminal + 2 min and says so once", () => {
    const { holds, changes, timers } = rig();
    holds.hold("a", T0 + 60 * MIN);
    holds.hold("a", T0 + 5 * MIN + 2 * MIN);
    expect(holds.untilOf("a")).toBe(T0 + 7 * MIN);
    expect(changes()).toBe(2);
    expect(timers.count).toBe(1);
  });

  test("an entry that expires leaves the registry and says so once", () => {
    const { holds, changes, timers } = rig();
    holds.hold("a", T0 + 2 * MIN);
    timers.advanceTo(T0 + 2 * MIN);
    expect(holds.untilOf("a")).toBeUndefined();
    expect(holds.latestUntil()).toBeNull();
    expect(changes()).toBe(2);
  });

  test("an entry is still held one millisecond before its time", () => {
    const { holds, timers } = rig();
    holds.hold("a", T0 + 2 * MIN);
    timers.advanceTo(T0 + 2 * MIN - 1);
    expect(holds.untilOf("a")).toBe(T0 + 2 * MIN);
  });

  test("giving the same time again changes nothing and says nothing", () => {
    const { holds, changes, timers } = rig();
    holds.hold("a", T0 + 2 * MIN);
    holds.hold("a", T0 + 2 * MIN);
    expect(changes()).toBe(1);
    expect(timers.count).toBe(1);
  });

  test("a replaced entry's old timer never fires", () => {
    const { holds, changes, timers } = rig();
    holds.hold("a", T0 + 2 * MIN);
    holds.hold("a", T0 + 10 * MIN);
    timers.advanceTo(T0 + 3 * MIN);
    expect(holds.untilOf("a")).toBe(T0 + 10 * MIN);
    expect(changes()).toBe(2);
  });

  test("a time already past is not a hold, and ends the attempt's earlier hold", () => {
    const { holds, changes } = rig();
    holds.hold("a", T0 - 1);
    expect(holds.entries().size).toBe(0);
    expect(changes()).toBe(0);
    holds.hold("a", T0 + MIN);
    holds.hold("a", T0);
    expect(holds.untilOf("a")).toBeUndefined();
    expect(changes()).toBe(2);
  });

  test("releasing an attempt removes it and says so once", () => {
    const { holds, changes, timers } = rig();
    holds.hold("a", T0 + 20 * MIN);
    holds.release("a");
    expect(holds.untilOf("a")).toBeUndefined();
    expect(changes()).toBe(2);
    expect(timers.count).toBe(0);
  });

  test("releasing an attempt that is not held says nothing", () => {
    const { holds, changes } = rig();
    holds.release("never-held");
    expect(changes()).toBe(0);
  });

  test("the latest time of all the attempts is what the reconcile waits for", () => {
    const { holds } = rig();
    holds.hold("kling", T0 + 2 * MIN);
    holds.hold("grok", T0 + 20 * MIN);
    expect(holds.latestUntil()).toBe(T0 + 20 * MIN);
    expect(holds.waitMs()).toBe(20 * MIN);
  });

  test("waitMs counts down with the clock", () => {
    const { holds, timers } = rig();
    holds.hold("a", T0 + 20 * MIN);
    timers.now = T0 + 5 * MIN;
    expect(holds.waitMs()).toBe(15 * MIN);
  });

  test("is per attempt: Kling's terminal hold expires while Grok's longer one stays", () => {
    const { holds, timers } = rig();
    holds.hold("clip-1:video#1", T0 + 2 * MIN);
    holds.hold("clip-1:video#2", T0 + 20 * MIN);
    timers.advanceTo(T0 + 2 * MIN);
    expect(holds.untilOf("clip-1:video#1")).toBeUndefined();
    expect(holds.untilOf("clip-1:video#2")).toBe(T0 + 20 * MIN);
    expect(holds.waitMs()).toBe(18 * MIN);
  });

  test("the entries are a copy: changing it changes nothing in the registry", () => {
    const { holds } = rig();
    holds.hold("a", T0 + MIN);
    const copy = new Map(holds.entries());
    copy.clear();
    expect(holds.untilOf("a")).toBe(T0 + MIN);
  });

  test("clearing it (shutdown) cancels every timer and drops every entry", () => {
    const { holds, timers } = rig();
    holds.hold("a", T0 + MIN);
    holds.hold("b", T0 + 2 * MIN);
    holds.clear();
    expect(timers.count).toBe(0);
    expect(holds.entries().size).toBe(0);
  });

  test("says nothing after it was cleared, however far the clock goes", () => {
    const { holds, changes, timers } = rig();
    holds.hold("a", T0 + MIN);
    const before = changes();
    holds.clear();
    timers.advanceTo(T0 + 60 * MIN);
    expect(changes()).toBe(before);
  });

  test("ignores a hold given after it was cleared: no entry, no timer, no emit", () => {
    const { holds, changes, timers } = rig();
    holds.clear();
    holds.hold("late", T0 + MIN);
    holds.release("late");
    expect(holds.entries().size).toBe(0);
    expect(timers.count).toBe(0);
    expect(changes()).toBe(0);
  });

  test("works with the real timers when none are injected", async () => {
    let changes = 0;
    const holds = createClipHolds({ now: () => Date.now(), onChange: () => void changes++ });
    holds.hold("a", Date.now() + 30);
    expect(holds.untilOf("a")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(holds.untilOf("a")).toBeUndefined();
    expect(changes).toBe(2);
    holds.clear();
  });
});

describe("«the job ended, the hold is still on»", () => {
  test("an uncertain submit: nothing but the registry holds the reconcile for 20 min", () => {
    const { holds, timers } = rig();
    holds.hold("clip-1:video#1", holdUntilForUncertain(timers.now, T));
    // The job is over here: nothing of it is passed to the registry, which keeps answering.
    timers.advanceTo(T0 + 19 * MIN + 59_000);
    expect(holds.waitMs()).toBe(1_000);
    timers.advanceTo(T0 + 20 * MIN);
    expect(holds.waitMs()).toBe(0);
  });

  test("a refusal: the hold lasts 2 min after the terminal status, not a millisecond less", () => {
    const { holds, timers } = rig();
    holds.hold("clip-1:video#1", holdUntilForTerminal(timers.now, T));
    timers.advanceTo(T0 + 2 * MIN - 1);
    expect(holds.waitMs()).toBe(1);
    timers.advanceTo(T0 + 2 * MIN);
    expect(holds.waitMs()).toBe(0);
  });
});

describe("after a restart, from the journal and the ledger", () => {
  const reserveAt = T0;
  const submitted = (attemptId: string, atMs: number): ClipJournalLine => ({ type: "submitted", attemptId, model: "kling", providerJobId: `job-${attemptId}`, at: iso(atMs) });
  const ended = (attemptId: string, atMs: number): ClipJournalLine => ({ type: "ended", attemptId, status: "refused", costSource: "proof", at: iso(atMs) });
  const restart = (reserves: { attemptId: string; at: string }[], journal: ClipJournalLine[], nowMs: number): Map<string, number> => holdsAfterRestart({ reserves, journal, nowMs, timings: T });

  test("holds a reserve with no submitted line 20 min from the reserve's `at`", () => {
    const held = restart([{ attemptId: "c:video#1", at: iso(reserveAt) }], [], reserveAt + 5 * MIN);
    expect(held.get("c:video#1")).toBe(reserveAt + 20 * MIN);
  });

  test("holds a submitted attempt with no ended line 60 min from the submit", () => {
    const held = restart([{ attemptId: "c:video#1", at: iso(reserveAt) }], [submitted("c:video#1", reserveAt + 1_000)], reserveAt + 5 * MIN);
    expect(held.get("c:video#1")).toBe(reserveAt + 1_000 + 60 * MIN);
  });

  test("holds an ended attempt 2 min from its ended line, whatever the reserve says", () => {
    const journal = [submitted("c:video#1", reserveAt + 1_000), ended("c:video#1", reserveAt + 90_000)];
    const held = restart([{ attemptId: "c:video#1", at: iso(reserveAt) }], journal, reserveAt + 100_000);
    expect(held.get("c:video#1")).toBe(reserveAt + 90_000 + 2 * MIN);
  });

  test("holds Kling by its ended line and Grok by its reserve, each its own", () => {
    const journal = [submitted("c:video#1", reserveAt + 1_000), ended("c:video#1", reserveAt + 90_000)];
    const reserves = [
      { attemptId: "c:video#1", at: iso(reserveAt) },
      { attemptId: "c:video#2", at: iso(reserveAt + 200_000) },
    ];
    const held = restart(reserves, journal, reserveAt + 205_000);
    expect(held.get("c:video#1")).toBe(reserveAt + 90_000 + 2 * MIN);
    expect(held.get("c:video#2")).toBe(reserveAt + 200_000 + 20 * MIN);
  });

  test("holds a journaled attempt even when the ledger has no line for it", () => {
    const held = restart([], [submitted("c:video#1", reserveAt)], reserveAt + MIN);
    expect(held.get("c:video#1")).toBe(reserveAt + 60 * MIN);
  });

  test("leaves out an attempt whose time has passed", () => {
    const held = restart([{ attemptId: "c:video#1", at: iso(reserveAt) }], [], reserveAt + 20 * MIN);
    expect(held.size).toBe(0);
  });

  test("keeps an attempt one millisecond before its time", () => {
    const held = restart([{ attemptId: "c:video#1", at: iso(reserveAt) }], [], reserveAt + 20 * MIN - 1);
    expect(held.get("c:video#1")).toBe(reserveAt + 20 * MIN);
  });

  test("holds nothing for a journal with no attempt at all (a `requested` line only)", () => {
    const requested: ClipJournalLine = {
      type: "requested",
      clipId: "c",
      photoId: "p",
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Улыбка", text: "she smiles slowly" },
      acceptedWorstMicros: 850_000,
      at: iso(reserveAt),
    };
    expect(restart([], [requested], reserveAt + MIN).size).toBe(0);
  });
});
