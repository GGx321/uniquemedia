import { z } from "zod";

/**
 * How one attempt ended, as seen by the HTTP client after its transport
 * retries. Mapping for the client (T3):
 *
 * - `not-sent`: failed before `fetch` was called (building the body, reading a
 *   reference, no key). Provably never reached OpenRouter → release.
 * - `network-error`: `fetch` itself rejected with anything but our abort or
 *   timeout (DNS, ECONNRESET, TLS, socket closed). The request may have reached
 *   the server → leave open.
 * - `response`: a final HTTP status was received. A 2xx whose body could not
 *   be read or parsed is still a `response` with `body: undefined` (billed at
 *   worst, estimated); a non-2xx body read failure is still a non-2xx (0).
 * - `aborted`: our AbortSignal (cancel) fired → leave open.
 * - `timeout`: the 180 s request timeout fired → leave open.
 */
export type AttemptOutcome =
  | { kind: "not-sent"; reason: string }
  | { kind: "network-error"; message: string }
  /** The final response; `body` is the parsed JSON, or undefined if it could not be read or parsed. */
  | { kind: "response"; status: number; body: unknown }
  | { kind: "aborted" }
  | { kind: "timeout" };

export type SettleDecision =
  | { action: "settle"; costMicros: number; estimated: boolean }
  | { action: "release"; reason: string }
  /** Unknown whether it was billed: the reserve stays open and counts at worst until reconcile. */
  | { action: "leave-open" };

/** Only `usage.cost` matters here; every other field of the body is ignored. */
const CostProbe = z.object({
  usage: z.object({ cost: z.number().finite().nonnegative() }),
});

/** OpenRouter reports cost as float USD; this is the one place it becomes integer micro-dollars. */
export function costToMicros(costUsd: number): number {
  return Math.round(costUsd * 1e6);
}

/**
 * The money model's settle rule. OpenRouter bills a 2xx and nothing else, so:
 * a 2xx settles at its `usage.cost` (the worst case, marked estimated, when
 * the cost is missing or unreadable); any final non-2xx settles at zero; an
 * abort, a timeout or a network error leaves the reserve open: the request may have
 * been billed; a request that never reached `fetch` is released.
 */
export function settleRule(outcome: AttemptOutcome, worstMicros: number): SettleDecision {
  switch (outcome.kind) {
    case "not-sent":
      return { action: "release", reason: outcome.reason };
    case "network-error":
    case "aborted":
    case "timeout":
      return { action: "leave-open" };
    case "response": {
      if (outcome.status < 200 || outcome.status > 299) {
        return { action: "settle", costMicros: 0, estimated: false };
      }
      const probe = CostProbe.safeParse(outcome.body);
      return probe.success
        ? { action: "settle", costMicros: costToMicros(probe.data.usage.cost), estimated: false }
        : { action: "settle", costMicros: worstMicros, estimated: true };
    }
  }
}
