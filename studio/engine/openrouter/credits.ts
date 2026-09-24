import { OpenRouterError } from "./errors";
import { clean, errorDetail, finalKind, safeJson, sendOnce, type ClientContext } from "./transport";
import type { OpenRouterRequestInit } from "./types";

/** A free GET; it should answer quickly. */
export const CREDITS_TIMEOUT_MS = 20_000;

/**
 * `GET /credits` (free): the parsed JSON body, which the money core's
 * reconcile validates. Every failure throws an OpenRouterError.
 */
export async function fetchCredits(ctx: ClientContext): Promise<unknown> {
  const init: Omit<OpenRouterRequestInit, "signal" | "redirect"> = { method: "GET", headers: { Authorization: `Bearer ${ctx.key}` } };
  const exchange = await sendOnce(ctx, `${ctx.base}/credits`, init, new AbortController().signal, CREDITS_TIMEOUT_MS);
  if (exchange.kind === "no-response") {
    if (exchange.stoppedBy === "timeout") throw new OpenRouterError("TIMEOUT", `GET /credits: no response within ${CREDITS_TIMEOUT_MS} ms`);
    throw new OpenRouterError("NETWORK", clean(ctx, `GET /credits: ${exchange.message}`));
  }
  const { status, text } = exchange;
  if (status < 200 || status > 299) {
    throw new OpenRouterError(finalKind(status), clean(ctx, `GET /credits: HTTP ${status}: ${errorDetail(text ?? "")}`), { httpStatus: status });
  }
  const body = text === null || exchange.truncated ? undefined : safeJson(text);
  if (body === undefined) {
    const why =
      text === null ? `the body could not be read: ${exchange.bodyError}` : exchange.truncated ? `the body exceeded ${ctx.maxBodyBytes} bytes` : "the body is not JSON";
    throw new OpenRouterError("HTTP_ERROR", clean(ctx, `GET /credits: HTTP ${status}, ${why}`), { httpStatus: status });
  }
  return body;
}
