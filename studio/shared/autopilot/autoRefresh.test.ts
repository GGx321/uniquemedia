import { describe, expect, test } from "bun:test";
import { AUTO_REFRESH_MAX_AUTO_SENDS, AUTO_REFRESH_MIN_CANDIDATES, autoRefreshOf, quotaRemainingOf, type AutoRefreshFacts } from "./autoRefresh";

// S4.10 fix B: ONE rule for the plan card's «will the trends refresh by themselves?». The engine's dry run and the mock both answer through `autoRefreshOf`, so a boundary moved here
// moves in both. The rule's own refusals are held by the engine's autoRefresh.test.ts; here is the card's word for each, and the boundaries the review found the mock on the wrong side of.

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

/** Facts under which a refresh WOULD leave: a key, a 100 h old list, 5 candidates, 5 sends, nothing recent. */
const open: AutoRefreshFacts = {
  now: NOW,
  hasKey: true,
  keyRejected: false,
  refreshRunning: false,
  listFetchedAt: NOW - 100 * HOUR,
  candidateCount: 5,
  autoSendsInWindow: 0,
  autoLogDamaged: false,
  lastAutoSendAt: null,
  totalSendsInWindow: 5,
  serverRemaining: null,
  launchRefreshed: false,
};
const withFacts = (over: Partial<AutoRefreshFacts>): AutoRefreshFacts => ({ ...open, ...over });
/** Facts with `left` of the 30 requests left in the window. */
const withLeft = (left: number): AutoRefreshFacts => withFacts({ totalSendsInWindow: 30 - left });

describe("autoRefreshOf: the key", () => {
  test("says will when everything allows a refresh", () => {
    expect(autoRefreshOf(open)).toBe("will");
  });

  test("says no-key when no music key is stored", () => {
    expect(autoRefreshOf(withFacts({ hasKey: false }))).toBe("no-key");
  });

  test("says no-key when the stored key was rejected", () => {
    expect(autoRefreshOf(withFacts({ keyRejected: true }))).toBe("no-key");
  });

  test("says no-key before it says anything about the quota", () => {
    expect(autoRefreshOf(withFacts({ hasKey: false, totalSendsInWindow: 30 }))).toBe("no-key");
  });
});

describe("autoRefreshOf: how many requests are left", () => {
  test("11 left is still will: after the send 10 stay for the owner", () => {
    expect(autoRefreshOf(withLeft(11))).toBe("will");
  });

  test("10 left is no-quota: the send would leave fewer than 10", () => {
    expect(autoRefreshOf(withLeft(10))).toBe("no-quota");
  });

  test("9 left is no-quota", () => {
    expect(autoRefreshOf(withLeft(9))).toBe("no-quota");
  });

  test("a server that says 10 remain is no-quota, 11 is will", () => {
    expect([autoRefreshOf(withFacts({ serverRemaining: 10 })), autoRefreshOf(withFacts({ serverRemaining: 11 }))]).toEqual(["no-quota", "will"]);
  });
});

describe("autoRefreshOf: the cap of automatic sends", () => {
  test("9 automatic sends in the window is still will", () => {
    expect(autoRefreshOf(withFacts({ autoSendsInWindow: AUTO_REFRESH_MAX_AUTO_SENDS - 1 }))).toBe("will");
  });

  test("10 automatic sends in the window is no-quota", () => {
    expect(autoRefreshOf(withFacts({ autoSendsInWindow: AUTO_REFRESH_MAX_AUTO_SENDS }))).toBe("no-quota");
  });

  test("a damaged automatic log is no-quota", () => {
    expect(autoRefreshOf(withFacts({ autoLogDamaged: true }))).toBe("no-quota");
  });
});

describe("autoRefreshOf: the 72 h rules", () => {
  test("an automatic send 71 h ago is no-quota", () => {
    expect(autoRefreshOf(withFacts({ lastAutoSendAt: NOW - 71 * HOUR }))).toBe("no-quota");
  });

  test("an automatic send 72 h ago is will", () => {
    expect(autoRefreshOf(withFacts({ lastAutoSendAt: NOW - 72 * HOUR }))).toBe("will");
  });

  test("a list 71 h old with enough candidates is not-needed", () => {
    expect(autoRefreshOf(withFacts({ listFetchedAt: NOW - 71 * HOUR, candidateCount: AUTO_REFRESH_MIN_CANDIDATES }))).toBe("not-needed");
  });

  test("a list 72 h old is stale: will, though the candidates are enough", () => {
    expect(autoRefreshOf(withFacts({ listFetchedAt: NOW - 72 * HOUR, candidateCount: 40 }))).toBe("will");
  });

  test("a fresh list with 9 candidates is will", () => {
    expect(autoRefreshOf(withFacts({ listFetchedAt: NOW - HOUR, candidateCount: AUTO_REFRESH_MIN_CANDIDATES - 1 }))).toBe("will");
  });

  test("a fresh list with 10 candidates is not-needed", () => {
    expect(autoRefreshOf(withFacts({ listFetchedAt: NOW - HOUR, candidateCount: AUTO_REFRESH_MIN_CANDIDATES }))).toBe("not-needed");
  });

  test("no list at all is stale: will", () => {
    expect(autoRefreshOf(withFacts({ listFetchedAt: null, candidateCount: 40 }))).toBe("will");
  });

  test("a refresh that is running now is not-needed: its tracks are on the way", () => {
    expect(autoRefreshOf(withFacts({ refreshRunning: true }))).toBe("not-needed");
  });
});

describe("quotaRemainingOf", () => {
  test("is the limit less the sends when the log reads", () => {
    expect(quotaRemainingOf({ quotaLog: "ok", sentLast31d: 9 })).toBe(21);
  });

  test("counts lines that are only held, they are sent already", () => {
    expect(quotaRemainingOf({ quotaLog: "held", sentLast31d: 29 })).toBe(1);
  });

  test.each(["corrupt", "unreadable", "missing"])("is null when the log is %s", (quotaLog) => {
    expect(quotaRemainingOf({ quotaLog, sentLast31d: 3 })).toBeNull();
  });

  test("never goes below zero", () => {
    expect(quotaRemainingOf({ quotaLog: "ok", sentLast31d: 99 })).toBe(0);
  });
});
