import { describe, expect, test } from "bun:test";
import { clipAlone, type AloneHolds, type AloneLedger } from "./clipAlone";

// 5b.2, S5.WB2 (plan s5b2 I5.65, L6): `clipAlone` is the as-built `moneyIsAlone` of `engine/clips/attempt.ts` (5b.1, VR item 1) as a pure function, so the engine's batch scheduler and the mock read
// one rule. The rows below pin every branch of it, and a differential test plays the OLD code (copied here verbatim) against it over thousands of seeded states.

const ME = "clip-0001:video#1";
const NOW = 1_000_000;

interface Close {
  type: "settle" | "release";
  estimated?: boolean;
}

function state(parts: { open?: string[]; closes?: Record<string, Close>; holds?: Record<string, number>; completed?: string[] }): { ledger: AloneLedger; holds: AloneHolds } {
  const closes = parts.closes ?? {};
  return {
    ledger: {
      openReserves: () => (parts.open ?? []).map((attemptId) => ({ attemptId })),
      closeOf: (id) => closes[id],
    },
    holds: {
      entries: () => new Map(Object.entries(parts.holds ?? {})),
      isCompleted: (id) => (parts.completed ?? []).includes(id),
    },
  };
}

const alone = (parts: Parameters<typeof state>[0], attemptId = ME): boolean => clipAlone({ ...state(parts), attemptId, nowMs: NOW });

describe("clipAlone: no foreign money can still move", () => {
  test("is true with an empty ledger and no holds", () => {
    expect(alone({})).toBe(true);
  });

  test("is false while another attempt has an open reserve", () => {
    expect(alone({ open: ["clip-0002:video#1"] })).toBe(false);
  });

  test("ignores the attempt's own open reserve", () => {
    expect(alone({ open: [ME] })).toBe(true);
  });

  test("is false while a foreign live hold belongs to an attempt that is not completed", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 }, closes: { "clip-0002:video#1": { type: "settle" } } })).toBe(false);
  });

  test("is false for a live hold of a refusal settled exactly but not completed (its temporary charge could be refunded inside the window)", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 }, closes: { "clip-0002:video#1": { type: "settle", estimated: false } } })).toBe(false);
  });

  test("is true for a live hold of a COMPLETED attempt settled exactly (its bill is known and cannot be refunded)", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 }, closes: { "clip-0002:video#1": { type: "settle", estimated: false } }, completed: ["clip-0002:video#1"] })).toBe(true);
  });

  test("is false for a completed attempt settled by an estimate", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 }, closes: { "clip-0002:video#1": { type: "settle", estimated: true } }, completed: ["clip-0002:video#1"] })).toBe(false);
  });

  test("is false for a completed attempt whose line is a release, not a settle", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 }, closes: { "clip-0002:video#1": { type: "release" } }, completed: ["clip-0002:video#1"] })).toBe(false);
  });

  test("is false for a completed attempt with no close line at all", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 }, completed: ["clip-0002:video#1"] })).toBe(false);
  });

  test("ignores a hold that ends exactly now, and one that ended before", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW, "clip-0003:video#1": NOW - 5 } })).toBe(true);
  });

  test("ignores the attempt's own hold", () => {
    expect(alone({ holds: { [ME]: NOW + 60_000 } })).toBe(true);
  });

  test("an attempt that has no hold or reserve yet (a batch member waiting for its turn) is judged against everything", () => {
    expect(alone({ holds: { "clip-0002:video#1": NOW + 1 } }, "clip-0009:video#1")).toBe(false);
  });
});

// ----- the differential: the 5b.1 code, verbatim, against the extracted function -----

interface OldDeps {
  ledger: AloneLedger;
  holds: AloneHolds;
  now: () => number;
}

/** `Attempt.moneyIsAlone` as 5b.1 shipped it (engine/clips/attempt.ts, S5.VR): copied, not imported, so the extraction is tested against the original text. */
function oldMoneyIsAlone(deps: OldDeps, attemptId: string): boolean {
  const ledger = deps.ledger;
  if (ledger.openReserves().some((reserve) => reserve.attemptId !== attemptId)) return false;
  const nowMs = deps.now();
  for (const [heldId, untilMs] of deps.holds.entries()) {
    if (heldId === attemptId || untilMs <= nowMs) continue;
    const close = ledger.closeOf(heldId);
    const exactAndCompleted = close?.type === "settle" && !close.estimated && deps.holds.isCompleted(heldId);
    if (!exactAndCompleted) return false;
  }
  return true;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("clipAlone equals the 5b.1 moneyIsAlone", () => {
  test("on 5000 seeded states of the ledger and the hold registry", () => {
    const rand = seeded(20261015);
    const ids = ["clip-0001:video#1", "clip-0001:video#2", "clip-0002:video#1", "clip-0003:video#1", "clip-0004:video#1"];
    let trues = 0;
    for (let n = 0; n < 5000; n++) {
      const open = ids.filter(() => rand() < 0.08);
      const closes: Record<string, Close> = {};
      const holds: Record<string, number> = {};
      const completed: string[] = [];
      for (const id of ids) {
        if (rand() < 0.5) closes[id] = rand() < 0.7 ? { type: "settle", estimated: rand() < 0.3 } : { type: "release" };
        if (rand() < 0.35) holds[id] = NOW + Math.floor((rand() - 0.4) * 1000);
        if (rand() < 0.5) completed.push(id);
      }
      const { ledger, holds: registry } = state({ open, closes, holds, completed });
      const me = ids[Math.floor(rand() * ids.length)] ?? ME;
      const expected = oldMoneyIsAlone({ ledger, holds: registry, now: () => NOW }, me);
      if (expected) trues++;
      expect(clipAlone({ ledger, holds: registry, attemptId: me, nowMs: NOW })).toBe(expected);
    }
    // The states are not all one answer: the property is not vacuous.
    expect(trues).toBeGreaterThan(100);
    expect(trues).toBeLessThan(4900);
  });
});
