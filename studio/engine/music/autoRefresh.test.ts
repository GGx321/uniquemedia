import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MUSIC_QUOTA_LIMIT } from "../../shared/engine";
import {
  AUTO_REFRESH_MAX_AUTO_SENDS,
  AUTO_REFRESH_MAX_TOTAL_SENDS,
  AUTO_REFRESH_MIN_CANDIDATES,
  AUTO_REFRESH_MIN_SERVER_REMAINING,
  decideAutoRefresh,
  type AutoRefreshFacts,
} from "./autoRefresh";
useNativeGlobals();

// The auto-refresh rule (Stage 4, S4.5d; plan §7 and invariant A11): a refresh may leave without a click only when ALL hold. Pure: every fact comes in as data.

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 3600 * 1000;

/** Facts under which a refresh is allowed: a key, nothing running, a stale list, plenty of room. Each test moves ONE fact. */
const ALLOWED: AutoRefreshFacts = {
  now: NOW,
  hasKey: true,
  keyRejected: false,
  refreshRunning: false,
  listFetchedAt: NOW - 100 * HOUR,
  candidateCount: 50,
  autoSendsInWindow: 0,
  autoLogDamaged: false,
  lastAutoSendAt: null,
  totalSendsInWindow: 0,
  serverRemaining: null,
  launchRefreshed: false,
};
const decide = (over: Partial<AutoRefreshFacts>) => decideAutoRefresh({ ...ALLOWED, ...over });
const refusedFor = (over: Partial<AutoRefreshFacts>): string => {
  const verdict = decide(over);
  return verdict.ok ? "allowed" : verdict.reason;
};

describe("the constants", () => {
  test("keep at least 10 of the 30 requests for the owner: at most 20 sends in all after an automatic one, at most 10 of them automatic", () => {
    expect(MUSIC_QUOTA_LIMIT - AUTO_REFRESH_MAX_TOTAL_SENDS).toBe(10);
    expect(AUTO_REFRESH_MAX_AUTO_SENDS).toBe(10);
    expect(AUTO_REFRESH_MIN_SERVER_REMAINING).toBe(11);
    expect(AUTO_REFRESH_MIN_CANDIDATES).toBe(10);
  });
});

describe("the allowed case", () => {
  test("a key, nothing running, a stale list, room in every count: allowed", () => {
    expect(decide({})).toEqual({ ok: true });
  });
});

describe("the key", () => {
  test("no key: refused", () => {
    expect(refusedFor({ hasKey: false })).toBe("no-key");
  });

  test("a key the server rejected: refused", () => {
    expect(refusedFor({ keyRejected: true })).toBe("key-rejected");
  });
});

describe("one at a time, one per launch", () => {
  test("a refresh already running: refused", () => {
    expect(refusedFor({ refreshRunning: true })).toBe("refresh-running");
  });

  test("a second automatic refresh in the same launch: refused", () => {
    expect(refusedFor({ launchRefreshed: true })).toBe("launch-already-refreshed");
  });
});

describe("the list's age (72 h)", () => {
  test("a list 71 h old with 50 candidates is fresh enough: refused", () => {
    expect(refusedFor({ listFetchedAt: NOW - 71 * HOUR })).toBe("list-fresh");
  });

  test("a list 72 h old is stale: allowed", () => {
    expect(refusedFor({ listFetchedAt: NOW - 72 * HOUR })).toBe("allowed");
  });

  test("no list at all is stale: allowed", () => {
    expect(refusedFor({ listFetchedAt: null })).toBe("allowed");
  });

  test("a list fetched in the future (a clock that stepped back) is fresh: refused", () => {
    expect(refusedFor({ listFetchedAt: NOW + HOUR })).toBe("list-fresh");
  });
});

describe("the candidates (10)", () => {
  test("a fresh list with 10 candidates: refused", () => {
    expect(refusedFor({ listFetchedAt: NOW - HOUR, candidateCount: 10 })).toBe("list-fresh");
  });

  test("a fresh list with 9 candidates: allowed", () => {
    expect(refusedFor({ listFetchedAt: NOW - HOUR, candidateCount: 9 })).toBe("allowed");
  });
});

describe("automatic sends in the rolling 31 days (A11: at most 10)", () => {
  test("9 automatic sends so far: the 10th is allowed", () => {
    expect(refusedFor({ autoSendsInWindow: 9 })).toBe("allowed");
  });

  test("10 automatic sends so far: refused", () => {
    expect(refusedFor({ autoSendsInWindow: 10 })).toBe("auto-quota");
  });
});

describe("the automatic sends file", () => {
  test("a damaged file is its own refusal, not the quota's: auto-log-damaged", () => {
    expect(refusedFor({ autoLogDamaged: true, autoSendsInWindow: 10 })).toBe("auto-log-damaged");
    expect(refusedFor({ autoLogDamaged: true, autoSendsInWindow: 0 })).toBe("auto-log-damaged");
  });
});

describe("all sends in the rolling 31 days (A11: at least 10 of 30 stay)", () => {
  test("19 sends in all: allowed (it leaves 10)", () => {
    expect(refusedFor({ totalSendsInWindow: 19 })).toBe("allowed");
  });

  test("20 sends in all: refused (it would leave 9)", () => {
    expect(refusedFor({ totalSendsInWindow: 20 })).toBe("total-quota");
  });
});

describe("the server's own count", () => {
  test("remaining 11: allowed", () => {
    expect(refusedFor({ serverRemaining: 11 })).toBe("allowed");
  });

  test("remaining 10: refused", () => {
    expect(refusedFor({ serverRemaining: 10 })).toBe("server-remaining");
  });

  test("remaining 0: refused", () => {
    expect(refusedFor({ serverRemaining: 0 })).toBe("server-remaining");
  });

  test("remaining unknown: allowed, the local counts decide", () => {
    expect(refusedFor({ serverRemaining: null })).toBe("allowed");
  });
});

describe("the spacing between automatic refreshes (72 h)", () => {
  test("the last automatic send 71 h ago: refused", () => {
    expect(refusedFor({ lastAutoSendAt: NOW - 71 * HOUR })).toBe("recent-auto");
  });

  test("the last automatic send 72 h ago: allowed", () => {
    expect(refusedFor({ lastAutoSendAt: NOW - 72 * HOUR })).toBe("allowed");
  });

  test("an automatic send dated in the future (a clock that stepped back) still counts as recent: refused", () => {
    expect(refusedFor({ lastAutoSendAt: NOW + HOUR })).toBe("recent-auto");
  });
});
