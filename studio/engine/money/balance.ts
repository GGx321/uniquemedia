import { z } from "zod";
import type { Clock } from "./ledger";
import type { CreditsFetcher } from "./reconcile";

/** A read of `/credits` is reused for this long; the balance is a warning, not a gate, so a minute of lag is fine. */
export const BALANCE_CACHE_MS = 60_000;

/** How long `read()` waits for the request; the request itself keeps running and fills the cache. */
export const BALANCE_WAIT_MS = 2_000;

/** A TIMEOUT or NETWORK failure is remembered as "unknown" for this long, so a degraded OpenRouter is not asked on every refresh. */
export const BALANCE_FAILURE_MS = 30_000;

/** The OpenRouter balance as the launch preview shows it. */
export interface Balance {
  micros: number;
  /** When it was read (ISO). */
  asOf: string;
}

/** Lenient on purpose: anything but two non-negative finite numbers is "unknown", never an error. Reconcile has its own, stricter schema. */
const CreditsFigures = z.object({
  data: z.object({ total_credits: z.number().finite().nonnegative(), total_usage: z.number().finite().nonnegative() }),
});

/** Dollars to micros with the float noise of `x * 1e6` cut off (0.045 stays 45000). */
function exactMicros(usd: number): number {
  return Number((usd * 1e6).toFixed(6));
}

/**
 * `total_credits − total_usage` from a `/credits` body, in integer micros, rounded the safe way for a
 * warning: credits down, usage up, so the balance is never overstated. Overdrawn is 0. Null when either
 * figure is missing or unreadable, or when either is not a safe integer in micros.
 */
export function balanceMicrosOf(body: unknown): number | null {
  const parsed = CreditsFigures.safeParse(body);
  if (!parsed.success) return null;
  const credits = Math.floor(exactMicros(parsed.data.data.total_credits));
  const usage = Math.ceil(exactMicros(parsed.data.data.total_usage));
  if (!Number.isSafeInteger(credits) || !Number.isSafeInteger(usage)) return null;
  return Math.max(0, credits - usage);
}

/** The key in use, as an id that changes with it (never logged), and a fetcher built only when a request is actually sent. */
export interface BalanceSource {
  id: string;
  fetch: CreditsFetcher;
}

export interface BalanceProbeDeps {
  /** Wall clock, epoch ms: only for `asOf`. */
  clock: Clock;
  /** Monotonic ms: the age of the cache. */
  monotonic: Clock;
  /** The source for the key in use; null when there is no usable key, and then nothing is sent. May throw: that reads as null. */
  source: () => BalanceSource | null;
  /** Told about a failed read or a broken source (a 401 may mean the key is rejected); a throw from it is ignored. */
  onFailure?: (error: unknown) => void;
  /** How long `read()` waits for the request; BALANCE_WAIT_MS unless a test shortens it. */
  waitMs?: number;
}

export interface BalanceProbe {
  /** The balance, or null (no key, no `total_credits`, a failed or slow request). Never throws; waits at most `waitMs`. */
  read(): Promise<Balance | null>;
}

function isTransient(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "TIMEOUT" || error.code === "NETWORK");
}

/**
 * A cached, never-throwing, time-boxed reader of the balance. A request outlives the wait and still fills the cache.
 * Overlapping reads under one key share a request; a different key never joins, reuses or is overwritten by another key's.
 * A success is cached for BALANCE_CACHE_MS, a TIMEOUT or NETWORK failure (as "unknown") for BALANCE_FAILURE_MS.
 */
export function createBalanceProbe(deps: BalanceProbeDeps): BalanceProbe {
  const waitMs = deps.waitMs ?? BALANCE_WAIT_MS;
  let currentId: string | null = null;
  let cached: { balance: Balance; at: number } | null = null;
  let failedAt: number | null = null;
  let pending: Promise<Balance | null> | null = null;

  function report(error: unknown): void {
    try {
      deps.onFailure?.(error);
    } catch {
      // A broken hook must not turn a warning into an error.
    }
  }

  /** Within [0, window]: a monotonic clock that went backwards counts as stale. */
  function fresh(at: number, windowMs: number): boolean {
    const age = deps.monotonic() - at;
    return age >= 0 && age <= windowMs;
  }

  function reset(id: string | null): void {
    currentId = id;
    cached = null;
    failedAt = null;
    pending = null;
  }

  async function fetchOnce(source: BalanceSource): Promise<Balance | null> {
    try {
      const micros = balanceMicrosOf(await source.fetch());
      if (micros === null) return null;
      const balance: Balance = { micros, asOf: new Date(deps.clock()).toISOString() };
      if (currentId === source.id) cached = { balance, at: deps.monotonic() };
      return balance;
    } catch (error) {
      report(error);
      if (currentId === source.id && isTransient(error)) failedAt = deps.monotonic();
      return null;
    }
  }

  return {
    async read() {
      let source: BalanceSource | null;
      try {
        source = deps.source();
      } catch (error) {
        report(error);
        source = null;
      }
      if (source === null) {
        reset(null);
        return null;
      }
      if (currentId !== source.id) reset(source.id);
      if (cached !== null && fresh(cached.at, BALANCE_CACHE_MS)) return cached.balance;
      if (failedAt !== null && fresh(failedAt, BALANCE_FAILURE_MS)) return null;
      if (pending === null) {
        const request: Promise<Balance | null> = fetchOnce(source).finally(() => {
          if (pending === request) pending = null;
        });
        pending = request;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const patience = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      });
      try {
        return await Promise.race([pending, patience]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
