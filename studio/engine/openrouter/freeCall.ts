import { clean, errorDetail, sendOnce, type ClientContext } from "./transport";
import type { FreeCallFault } from "./types";

/** A free GET (a poll, a `/generation` lookup) answers quickly; this is its own limit, not the paid request's. */
export const FREE_CALL_TIMEOUT_MS = 20_000;

/** The ids OpenRouter hands out (`gen-vid-<digits>-<letters>`); anything else is not put into a URL. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type FreeResponse =
  | { kind: "response"; status: number; text: string; truncated: boolean }
  | { kind: "fault"; fault: FreeCallFault };

/**
 * One free GET with the bearer key, no retry and no redirect. A failure to get an answer (timeout, abort, network, an unreadable body)
 * comes back as a fault; a status line, of any status, comes back as a response for the caller to read.
 */
export async function freeGet(ctx: ClientContext, url: string, label: string, signal: AbortSignal | undefined, timeoutMs = FREE_CALL_TIMEOUT_MS): Promise<FreeResponse> {
  const exchange = await sendOnce(ctx, url, { method: "GET", headers: { Authorization: `Bearer ${ctx.key}` } }, signal ?? new AbortController().signal, timeoutMs);
  if (exchange.kind === "no-response") {
    if (exchange.stoppedBy === "timeout") return fault(ctx, "timeout", null, `${label}: no response within ${timeoutMs} ms`);
    if (exchange.stoppedBy === "abort") return fault(ctx, "aborted", null, `${label}: aborted`);
    return fault(ctx, "network", null, `${label}: ${exchange.message}`);
  }
  if (exchange.text === null) {
    const cause = exchange.stoppedBy === "timeout" ? "timeout" : exchange.stoppedBy === "abort" ? "aborted" : "network";
    return fault(ctx, cause, exchange.status, `${label}: HTTP ${exchange.status}, the body could not be read: ${exchange.bodyError}`);
  }
  return { kind: "response", status: exchange.status, text: exchange.text, truncated: exchange.truncated };
}

export function faultOf(ctx: ClientContext, cause: FreeCallFault["cause"], httpStatus: number | null, detail: string): FreeCallFault {
  return { cause, httpStatus, detail: clean(ctx, detail) };
}

function fault(ctx: ClientContext, cause: FreeCallFault["cause"], httpStatus: number | null, detail: string): { kind: "fault"; fault: FreeCallFault } {
  return { kind: "fault", fault: faultOf(ctx, cause, httpStatus, detail) };
}

/** A non-2xx as a fault: 401 and 402 are told apart, because they stop all paid work; everything else is `http`. */
export function httpFault(ctx: ClientContext, label: string, status: number, text: string): FreeCallFault {
  const cause = status === 401 ? "auth" : status === 402 ? "credits" : "http";
  return { cause, httpStatus: status, detail: clean(ctx, `${label}: HTTP ${status}: ${errorDetail(text)}`) };
}

/**
 * Dollars to integer micro-dollars for a figure that decides whether something was billed: float noise is cut off (0.045 stays 45000),
 * then it rounds UP, so a positive cost never becomes 0 («free»).
 */
export function microsOf(usd: number): number {
  return Math.ceil(Number((usd * 1e6).toFixed(6)));
}
