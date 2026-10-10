import type { AutoRefresh } from "../engine/autopilot";
import { MUSIC_QUOTA_LIMIT, MUSIC_QUOTA_WINDOW_DAYS, type MusicQuotaLog } from "../engine/state";

// The auto-refresh rule (Stage 4, S4.5d; plan §7 and invariant A11). A refresh of the trends may leave WITHOUT a click only when all of these hold:
//
//   - a music key is stored (and the server has not rejected it);
//   - no refresh is running;
//   - this launch has not refreshed yet (one automatic refresh per launch);
//   - the current list is 72 h old or older, or there are fewer than 10 candidate tracks (a fresh, full list needs nothing);
//   - no automatic refresh in the last 72 h;
//   - automatic sends in the rolling 31 days so far: at most 9 (the one asked for is at most the 10th);
//   - sends in all in the rolling 31 days so far: at most 19 (so at least 10 of the 30 stay for the owner);
//   - the server's `remaining`, when known, is at least 11.
//
// Pure: every fact is data, the clock included. The send path that applies it is `MusicService.autoRefresh`; the count of automatic sends is the log in `autoSends.ts`.
// A boundary is the first value the rule turns a refresh away at: 10 automatic sends, 20 in all, a server `remaining` of 10, a list or an automatic send 71 h old.

/** The rolling window both counts use: the quota ledger's own 31 days. */
export const AUTO_REFRESH_WINDOW_MS = MUSIC_QUOTA_WINDOW_DAYS * 24 * 3600 * 1000;
/** A list this old (or older) is stale. */
export const AUTO_REFRESH_STALE_MS = 72 * 3600 * 1000;
/** Two automatic refreshes are at least this far apart. */
export const AUTO_REFRESH_SPACING_MS = 72 * 3600 * 1000;
/** Fewer candidate tracks than this ask for a refresh even when the list is fresh. */
export const AUTO_REFRESH_MIN_CANDIDATES = 10;
/** Automatic sends in the window at which the rule closes: at most 10 in any 31 days, so the 10th is the last. */
export const AUTO_REFRESH_MAX_AUTO_SENDS = 10;
/** Sends in all in the window at which the rule closes: with 20 made, an automatic one would leave fewer than 10 of the 30. */
export const AUTO_REFRESH_MAX_TOTAL_SENDS = MUSIC_QUOTA_LIMIT - 10;
/** The server's `remaining` below which the rule closes: after the send at least 10 must stay. */
export const AUTO_REFRESH_MIN_SERVER_REMAINING = 11;

export type AutoRefreshRefusal =
  | "no-key"
  | "key-rejected"
  | "refresh-running"
  | "launch-already-refreshed"
  | "auto-log-damaged"
  | "list-fresh"
  | "recent-auto"
  | "auto-quota"
  | "total-quota"
  | "server-remaining";

export interface AutoRefreshFacts {
  /** Epoch ms. */
  readonly now: number;
  readonly hasKey: boolean;
  /** The server rejected the stored key on an earlier request. */
  readonly keyRejected: boolean;
  readonly refreshRunning: boolean;
  /** When the current list was fetched (epoch ms); null with no list. */
  readonly listFetchedAt: number | null;
  /** Tracks the autopilot could choose from now (trends not explicit, own tracks flagged). */
  readonly candidateCount: number;
  /** Automatic sends in the rolling window, a damaged log read as the limit (`autoSends.ts`). */
  readonly autoSendsInWindow: number;
  /** The automatic sends file has a line that cannot be read (a torn tail is not that: it is healed and the whole lines counted). Its count is not to be trusted. */
  readonly autoLogDamaged: boolean;
  /** The time of the latest automatic send in the log (epoch ms); null with none. */
  readonly lastAutoSendAt: number | null;
  /** Sends in the rolling window, automatic or not, a send with no result included (the quota ledger's own count). */
  readonly totalSendsInWindow: number;
  /** The server's own `remaining` from its last answer, when known. */
  readonly serverRemaining: number | null;
  /** This launch has already had its one automatic refresh. */
  readonly launchRefreshed: boolean;
}

export type AutoRefreshVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: AutoRefreshRefusal };

const refuse = (reason: AutoRefreshRefusal): AutoRefreshVerdict => ({ ok: false, reason });

/** Whether a refresh may leave now without a click, or the first condition that says no. */
export function decideAutoRefresh(facts: AutoRefreshFacts): AutoRefreshVerdict {
  if (!facts.hasKey) return refuse("no-key");
  if (facts.keyRejected) return refuse("key-rejected");
  if (facts.refreshRunning) return refuse("refresh-running");
  if (facts.launchRefreshed) return refuse("launch-already-refreshed");
  if (facts.autoLogDamaged) return refuse("auto-log-damaged");
  // Stale: no list, or one 72 h old or older. A list dated in the future (a clock that stepped back) is fresh.
  const stale = facts.listFetchedAt === null || facts.now - facts.listFetchedAt >= AUTO_REFRESH_STALE_MS;
  if (!stale && facts.candidateCount >= AUTO_REFRESH_MIN_CANDIDATES) return refuse("list-fresh");
  // Within 72 h of the last automatic one while `now < at + 72 h`; an automatic send dated in the future counts as recent.
  if (facts.lastAutoSendAt !== null && facts.now - facts.lastAutoSendAt < AUTO_REFRESH_SPACING_MS) return refuse("recent-auto");
  if (facts.autoSendsInWindow >= AUTO_REFRESH_MAX_AUTO_SENDS) return refuse("auto-quota");
  if (facts.totalSendsInWindow >= AUTO_REFRESH_MAX_TOTAL_SENDS) return refuse("total-quota");
  if (facts.serverRemaining !== null && facts.serverRemaining < AUTO_REFRESH_MIN_SERVER_REMAINING) return refuse("server-remaining");
  return { ok: true };
}

// ---------- the plan card's word on it (S4.10 fix B) ----------

/** The card's four words, as the contract has them. */
export type AutoRefreshWord = AutoRefresh;

/**
 * The plan card's word for «will the trends refresh by themselves at the start?», from the very rule the send path applies (`decideAutoRefresh`). The engine answers it from a dry run over
 * its own files and the mock from its stored figures; neither adds a rule of its own.
 *
 *   will        the rule lets a refresh leave now;
 *   not-needed  the list is fresh and full, or a refresh is running already: nothing to send;
 *   no-key      no music key is stored, or the server rejected it;
 *   no-quota    a refresh is wanted and the rule keeps it back to spare the owner's requests (the caps, the 72 h spacing, the server's count, a log that cannot be trusted).
 *
 * A launch that has refreshed already never meets this: the card is drawn before the launch exists.
 */
export function autoRefreshOf(facts: AutoRefreshFacts): AutoRefreshWord {
  const verdict = decideAutoRefresh(facts);
  if (verdict.ok) return "will";
  switch (verdict.reason) {
    case "no-key":
    case "key-rejected":
      return "no-key";
    case "list-fresh":
    case "refresh-running":
    case "launch-already-refreshed":
      return "not-needed";
    case "recent-auto":
    case "auto-quota":
    case "total-quota":
    case "server-remaining":
    case "auto-log-damaged":
      return "no-quota";
  }
}

/** Requests left of the 30 in the rolling 31 days; null when the log cannot be read (corrupt, unreadable, missing). Lines that are only held count: they were sent. */
export function quotaRemainingOf(quota: { readonly quotaLog: MusicQuotaLog; readonly sentLast31d: number }): number | null {
  if (quota.quotaLog !== "ok" && quota.quotaLog !== "held") return null;
  return Math.max(0, MUSIC_QUOTA_LIMIT - quota.sentLast31d);
}
