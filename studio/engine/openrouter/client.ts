import { performance } from "node:perf_hooks";
import { REQUEST_TIMEOUT_MS } from "../money/budget";
import { OPENROUTER_API_BASE } from "../money/prices";
import { OpenRouterError } from "./errors";
import { chat } from "./chat";
import { fetchCredits } from "./credits";
import { generateImage } from "./image";
import { makeHeadRedactor, makeRedactor } from "./redact";
import { MAX_BODY_BYTES, type ClientContext } from "./transport";
import type { OpenRouterClient, OpenRouterClientOptions } from "./types";

/** Visible ASCII only: anything else would make `fetch` reject the header before sending. */
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

function checkedKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key === "") throw new OpenRouterError("NO_API_KEY", "no OpenRouter API key is set; nothing can be sent");
  if (!HEADER_SAFE_KEY.test(key)) {
    throw new OpenRouterError("INVALID_API_KEY", "the OpenRouter API key contains characters that cannot be sent in a header");
  }
  return key;
}

/**
 * Invariant 13: only the OpenRouter base, unless the build allows an
 * override; an override may point only at a loopback mock, so a typo cannot
 * send the key to a third party.
 */
function checkedBaseUrl(baseUrl: string, allowOverride: boolean): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base === OPENROUTER_API_BASE) return base;
  const refuse = (why: string): never => {
    throw new OpenRouterError("BASE_URL_NOT_ALLOWED", `base URL refused: ${why}`);
  };
  if (!allowOverride) refuse(`this build only talks to ${OPENROUTER_API_BASE}`);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return refuse("it does not parse as a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("only http and https are allowed");
  if (url.username !== "" || url.password !== "") refuse("it carries credentials");
  if (!LOOPBACK_HOSTS.has(url.hostname)) refuse("an override may only point at a loopback mock server");
  return base;
}

/**
 * An integer in [1, max]. The request timeout may not exceed the money core's
 * REQUEST_TIMEOUT_MS: its reconcile wait assumes no request runs longer.
 */
function checkedInt(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer in [1, ${max}], got ${value}`);
  return value;
}

export function createOpenRouterClient(options: OpenRouterClientOptions): OpenRouterClient {
  const key = checkedKey(options.apiKey);
  const ctx: ClientContext = {
    key,
    base: checkedBaseUrl(options.baseUrl, options.allowBaseUrlOverride),
    fetch: options.fetch,
    saveRaw: options.saveRaw,
    log: options.log ?? (() => {}),
    timeoutMs: checkedInt("timeoutMs", options.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
    maxBodyBytes: checkedInt("maxBodyBytes", options.maxBodyBytes ?? MAX_BODY_BYTES, Number.MAX_SAFE_INTEGER),
    sleep: options.sleep ?? sleep,
    random: options.random ?? Math.random,
    clock: options.clock ?? Date.now,
    monotonic: options.monotonic ?? (() => performance.now()),
    redact: makeRedactor(key),
    redactHead: makeHeadRedactor(key),
  };
  return {
    generateImage: (params) => generateImage(ctx, params),
    chat: (params) => chat(ctx, params),
    fetchCredits: () => fetchCredits(ctx),
  };
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
