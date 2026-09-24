import { Buffer } from "node:buffer";
import type { FetchLike } from "../money/prices";
import type { BodyReader, OpenRouterFetch } from "./types";

/** `/models` lists every model with its pricing: a few MB today. */
export const MAX_PRICE_BODY_BYTES = 16 * 1024 * 1024;

/** Reads a body up to `maxBytes`; a longer one is cancelled and refused. */
async function readText(body: { getReader(): BodyReader } | null, maxBytes: number): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Best effort: the stream may already be closed.
      await reader.cancel().catch(() => {});
      throw new Error(`the price body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The price loader's fetch (money/prices.ts) over the engine's injected fetch:
 * prices are public, so the GET carries no API key; redirects are refused and
 * the body is read up to a cap. The loader passes its own timeout signal.
 */
export function priceFetchFrom(fetch: OpenRouterFetch, maxBodyBytes = MAX_PRICE_BODY_BYTES): FetchLike {
  return async (url, init) => {
    const signal = init?.signal ?? new AbortController().signal;
    const res = await fetch(url, { method: "GET", headers: {}, redirect: "error", signal });
    return {
      ok: res.status >= 200 && res.status <= 299,
      status: res.status,
      json: async (): Promise<unknown> => JSON.parse(await readText(res.body, maxBodyBytes)),
    };
  };
}
