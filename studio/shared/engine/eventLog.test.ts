import { describe, expect, test } from "bun:test";
import { EventLog } from "./eventLog";
import type { UnsequencedEvent } from "./events";
import { parseMessage } from "./messages";

const BOOT = "boot-00000001";
const OLD_BOOT = "boot-00000000";

function progress(n: number): UnsequencedEvent {
  return {
    v: 1,
    id: `evt-${String(n).padStart(8, "0")}`,
    kind: "event",
    type: "job.progress",
    payload: { jobId: "job-00000001", done: n, total: 100 },
  };
}

/** Type-correct but breaks the contract's done <= total rule. */
function progressPastTotal(): UnsequencedEvent {
  return {
    v: 1,
    id: "evt-00000001",
    kind: "event",
    type: "job.progress",
    payload: { jobId: "job-00000001", done: 5, total: 4 },
  };
}

function logWith(capacity: number, count: number): EventLog {
  const log = new EventLog(capacity, BOOT);
  for (let n = 1; n <= count; n++) log.append(progress(n));
  return log;
}

function seqsAfter(log: EventLog, afterSeq: number, bootId: string = BOOT): number[] | "gap" {
  const r = log.since(afterSeq, bootId);
  return r.gap ? "gap" : r.events.map((e) => e.seq);
}

describe("append", () => {
  test("numbers the first event 1", () => {
    expect(new EventLog(3, BOOT).append(progress(1))).toBe(1);
  });

  test("numbers each next event one higher", () => {
    const log = new EventLog(3, BOOT);
    expect([log.append(progress(1)), log.append(progress(2)), log.append(progress(3))]).toEqual([1, 2, 3]);
  });

  test("keeps counting after older events are evicted", () => {
    const log = logWith(2, 4);
    expect(log.append(progress(5))).toBe(5);
  });

  test("does not add a seq or bootId to the caller's object", () => {
    const event = progress(1);
    new EventLog(3, BOOT).append(event);
    expect(event).toEqual(progress(1));
  });

  test("stamps every stored event with the log's bootId", () => {
    const r = logWith(3, 2).since(0, BOOT);
    const boots = r.gap ? [] : r.events.map((e) => e.bootId);
    expect(boots).toEqual([BOOT, BOOT]);
  });

  test("refuses an event that breaks the contract", () => {
    const broken = progressPastTotal();
    expect(() => new EventLog(3, BOOT).append(broken)).toThrow();
  });

  test("does not use up a seq on a refused event", () => {
    const log = new EventLog(3, BOOT);
    const broken = progressPastTotal();
    expect(() => log.append(broken)).toThrow();
    expect(log.append(progress(1))).toBe(1);
  });
});

describe("history cannot be rewritten", () => {
  test("changing the caller's nested payload after append leaves the stored event alone", () => {
    const log = new EventLog(3, BOOT);
    const event = progress(1);
    log.append(event);
    if (event.type === "job.progress") event.payload.done = 99;
    const r = log.since(0, BOOT);
    const done = r.gap ? [] : r.events.map((e) => (e.type === "job.progress" ? e.payload.done : -1));
    expect(done).toEqual([1]);
  });

  test("events read back are frozen, nested objects included", () => {
    const r = logWith(3, 1).since(0, BOOT);
    const frozen = r.gap ? [] : r.events.flatMap((e) => [Object.isFrozen(e), Object.isFrozen(e.payload)]);
    expect(frozen).toEqual([true, true]);
  });

  test("an attempt to change a read-back event throws", () => {
    const r = logWith(3, 1).since(0, BOOT);
    expect(() => {
      if (!r.gap) {
        const [first] = r.events;
        if (first?.type === "job.progress") first.payload.done = 99;
      }
    }).toThrow(TypeError);
  });
});

describe("lastSeq", () => {
  test("is 0 for an empty log", () => {
    expect(new EventLog(3, BOOT).lastSeq).toBe(0);
  });

  test("is the seq of the last appended event, eviction or not", () => {
    expect(logWith(3, 5).lastSeq).toBe(5);
  });
});

describe("since", () => {
  test("returns no events and no gap for an empty log from 0", () => {
    expect(new EventLog(3, BOOT).since(0, BOOT)).toEqual({ gap: false, events: [] });
  });

  test("returns every event from 0 while nothing was evicted", () => {
    expect(seqsAfter(logWith(3, 3), 0)).toEqual([1, 2, 3]);
  });

  test("returns the events with their original fields, their seq and the bootId", () => {
    expect(logWith(3, 2).since(1, BOOT)).toEqual({ gap: false, events: [{ ...progress(2), seq: 2, bootId: BOOT }] });
  });

  // Capacity 3 after 5 appends: seqs 1 and 2 are evicted, 3..5 are kept.
  test("returns nothing after the last seq", () => {
    expect(seqsAfter(logWith(3, 5), 5)).toEqual([]);
  });

  test("returns only the newest event after the one before it", () => {
    expect(seqsAfter(logWith(3, 5), 4)).toEqual([5]);
  });

  test("returns every kept event when the caller last saw the newest evicted one", () => {
    expect(seqsAfter(logWith(3, 5), 2)).toEqual([3, 4, 5]);
  });

  test("reports a gap when an event the caller missed was evicted", () => {
    expect(seqsAfter(logWith(3, 5), 1)).toBe("gap");
  });

  test("reports a gap from 0 once anything was evicted", () => {
    expect(seqsAfter(logWith(3, 5), 0)).toBe("gap");
  });

  test("reports a gap when the caller is ahead of the log", () => {
    expect(seqsAfter(logWith(3, 5), 6)).toBe("gap");
  });

  test("reports a gap when the caller's bootId is from an earlier engine, even for a seq the log holds", () => {
    expect(seqsAfter(logWith(3, 5), 4, OLD_BOOT)).toBe("gap");
  });

  test("reports a gap for an earlier engine's caller at seq 0 on an empty log", () => {
    expect(seqsAfter(new EventLog(3, BOOT), 0, OLD_BOOT)).toBe("gap");
  });

  test("works with a capacity of one", () => {
    const log = logWith(1, 2);
    expect([seqsAfter(log, 1), seqsAfter(log, 0)]).toEqual([[2], "gap"]);
  });

  test("keeps the order right after the ring wraps several times", () => {
    expect(seqsAfter(logWith(3, 10), 7)).toEqual([8, 9, 10]);
  });

  test("returns a fresh array the caller can change freely", () => {
    const log = logWith(3, 2);
    const first = log.since(0, BOOT);
    if (!first.gap) first.events.length = 0;
    expect(seqsAfter(log, 0)).toEqual([1, 2]);
  });

  test("answers in the engine.events result shape", () => {
    const result = logWith(3, 2).since(0, BOOT);
    const msg = { v: 1, id: "msg-00000001", kind: "response", type: "engine.events", ok: true, result };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test.each([-1, 1.5, Number.NaN])("throws RangeError for the seq %p", (seq) => {
    expect(() => logWith(3, 1).since(seq, BOOT)).toThrow(RangeError);
  });
});

describe("construction", () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects the capacity %p", (capacity) => {
    expect(() => new EventLog(capacity, BOOT)).toThrow(RangeError);
  });

  test.each(["", "BOOT-00000001", "../boot-0001", "boot"])("rejects the bootId %p", (bootId) => {
    expect(() => new EventLog(3, bootId)).toThrow(RangeError);
  });

  test("exposes its bootId", () => {
    expect(new EventLog(3, BOOT).bootId).toBe(BOOT);
  });

  test("two logs do not share events", () => {
    const a = logWith(3, 2);
    const b = new EventLog(3, BOOT);
    expect([a.lastSeq, b.lastSeq, seqsAfter(b, 0)]).toEqual([2, 0, []]);
  });
});
