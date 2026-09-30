import { parseFlashapiList, type ListParse } from "./listSchema";
import { redactKnown } from "./redactKnown";

// The flashapi client (3c.3): ONE request for the trending list, no retry, no pagination. It takes the key and the base
// URL as parameters and never reads either from anywhere; the quota (`quotaLedger.ts`) and the decision to send belong
// to the caller. Rules held here:
// - the key travels ONLY in the `x-rapidapi-key` header: never in the URL, the query or a body;
// - every text derived from a response or an error goes through `redactKnown(text, key)` before it is kept: a fetch
//   error's message, an error body's snippet, a header's value;
// - a redirect is not followed (a custom header would go along to the other host): it is an HTTP failure;
// - the answer is read up to a byte cap, so a hostile or broken server cannot fill memory;
// - the base URL is the real host, unless the build allows an override, and an override may point only at a loopback
//   mock (the same rule as OpenRouter's, invariant 13). A production build compiles the override out.

export const FLASHAPI_HOST = "flashapi1.p.rapidapi.com";
export const FLASHAPI_BASE = `https://${FLASHAPI_HOST}`;
export const TRENDING_PATH = "/ig/music_trending/";
/** A real list is about 190 KB; a megabyte is room to spare and still bounded. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** The list request alone; the downloads of 3c.4 have their own bounds. */
export const REQUEST_TIMEOUT_MS = 25_000;
/** How much of an error body is read to say what went wrong. */
const ERROR_BODY_BYTES = 4096;
const DETAIL_SNIPPET_CHARS = 200;
const MAX_HEADER_NAMES = 64;
const MAX_HEADER_VALUE_CHARS = 64;

const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Header names whose VALUES are kept: the rate-limit family and Retry-After. Every other header keeps only its name. */
const RATE_LIMIT_HEADER = /ratelimit|retry-after/i;

/** The client cannot be built as asked: a refused base URL, or a key that cannot be a header. Never carries the key. */
export class FlashapiConfigError extends Error {
  readonly code: "BASE_URL_NOT_ALLOWED" | "INVALID_KEY";
  constructor(code: FlashapiConfigError["code"], message: string) {
    super(message);
    this.name = "FlashapiConfigError";
    this.code = code;
  }
}

export type FlashapiFailure = "rejected" | "forbidden" | "rate-limited" | "http" | "network" | "timeout" | "aborted" | "too-large" | "invalid";

/** What an answer said about itself: never its body, and header VALUES only for the rate-limit family (redacted). */
export interface FlashapiResponseInfo {
  status: number;
  /** Every response header's name, lowercase. The reset header's name is unknown (SP5), so all names are logged. */
  headerNames: string[];
  rateLimit: Record<string, string>;
  /** `x-ratelimit-requests-remaining` as a whole number, else null. */
  remaining: number | null;
  /** `x-ratelimit-requests-limit` as a whole number, else null. */
  limit: number | null;
  bodyBytes: number;
  /** The server's own clock, from its `Date` header, epoch ms; null when absent or not a plausible time. Kept for clock-skew forensics. */
  serverDateMs: number | null;
}

/** A request that did not end in a usable list. `detail` is redacted of the key; `response` is null when nothing came back. */
export class FlashapiError extends Error {
  readonly kind: FlashapiFailure;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly response: FlashapiResponseInfo | null;
  readonly detail: string;

  constructor(kind: FlashapiFailure, detail: string, extra: { status?: number; retryAfterMs?: number | null; response?: FlashapiResponseInfo } = {}) {
    super(detail);
    this.name = "FlashapiError";
    this.kind = kind;
    this.detail = detail;
    this.status = extra.status ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.response = extra.response ?? null;
  }
}

export type FlashapiFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

export interface FlashapiClientOptions {
  /** The RapidAPI key, from the engine's memory; never read from anywhere else, never logged. */
  key: string;
  /** The API base; `FLASHAPI_BASE` unless the build allows an override (`allowBaseUrlOverride`). */
  baseUrl: string;
  /** True only in an E2E build (`STUDIO_E2E`): a production build passes false, so any other base throws. */
  allowBaseUrlOverride: boolean;
  /** The runtime's own `fetch` in the engine, a fake in tests. Only the call shape below is used. */
  fetch: FlashapiFetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface FlashapiListResult {
  list: Extract<ListParse, { ok: true }>;
  response: FlashapiResponseInfo;
}

export interface FlashapiClient {
  /** One request. Rejects with `FlashapiError`; never retries. */
  fetchTrending(signal?: AbortSignal): Promise<FlashapiListResult>;
}

function checkedBaseUrl(baseUrl: string, allowOverride: boolean): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base === FLASHAPI_BASE) return base;
  const refuse = (why: string): never => {
    throw new FlashapiConfigError("BASE_URL_NOT_ALLOWED", `base URL refused: ${why}`);
  };
  if (!allowOverride) return refuse(`this build only talks to ${FLASHAPI_BASE}`);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return refuse("it does not parse as a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("only http and https are allowed");
  if (url.username !== "" || url.password !== "") refuse("it carries credentials");
  if (url.search !== "" || url.hash !== "") refuse("it carries a query or a fragment");
  if (!LOOPBACK_HOSTS.has(url.hostname)) refuse("an override may only point at a loopback mock server");
  return base;
}

function checkedKey(key: string): string {
  if (!HEADER_SAFE_KEY.test(key)) throw new FlashapiConfigError("INVALID_KEY", "the RapidAPI key cannot be sent as a header");
  return key;
}

/**
 * The server's `remaining`: a whole number, and a NEGATIVE one (a server that over-counted) reads as 0, since a
 * quota that has gone below zero is exhausted, never "unknown".
 */
function remainingFigure(value: string | null): number | null {
  if (value !== null && /^-\d{1,9}$/.test(value)) return 0;
  return wholeNumber(value);
}

/** A `Date` header as epoch ms, or null unless it is a real time between 2000 and 2100. */
function serverDate(value: string | null): number | null {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= 946_684_800_000 && at < 4_102_444_800_000 ? at : null;
}

/** A runtime's own error code (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`), read from an error's `cause`; nothing else of the cause is used. */
function causeCode(error: unknown): string | null {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code: unknown = typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

function wholeNumber(value: string | null): number | null {
  return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

/** Seconds only: an HTTP date or junk is not a delay this client can trust. */
function retryAfterMs(value: string | null): number | null {
  const seconds = wholeNumber(value === null ? null : value.trim());
  return seconds === null ? null : seconds * 1000;
}

/** Text of a body for a message: control chars out, whitespace collapsed, the key out, THEN cut. */
function snippet(text: string, redact: (text: string) => string): string {
  const flat = text.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, " ").replace(/\s+/g, " ").trim();
  return redact(flat).slice(0, DETAIL_SNIPPET_CHARS);
}

/**
 * Reads at most `max` bytes of a body. `over` is true when there is more than that (the rest is not read: the stream
 * is cancelled), and a `Content-Length` above the cap is over without reading anything.
 */
async function readCapped(res: Response, max: number, keepHead: boolean): Promise<{ bytes: Uint8Array; over: boolean }> {
  const none = { bytes: new Uint8Array(0), over: true };
  const declared = wholeNumber(res.headers.get("content-length"));
  if (declared !== null && declared > max && !keepHead) {
    await res.body?.cancel().catch(() => undefined);
    return none;
  }
  if (res.body === null) return { bytes: new Uint8Array(0), over: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      if (!keepHead) return none;
      // An error body: the first `max` bytes are enough to say what went wrong.
      chunks.push(value.subarray(0, max - total));
      total = max;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, over: false };
}

export function createFlashapiClient(options: FlashapiClientOptions): FlashapiClient {
  const key = checkedKey(options.key);
  const base = checkedBaseUrl(options.baseUrl, options.allowBaseUrlOverride);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const redact = (text: string): string => redactKnown(text, key);

  function infoOf(res: Response, bodyBytes: number): FlashapiResponseInfo {
    const headerNames: string[] = [];
    const rateLimit: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (headerNames.length < MAX_HEADER_NAMES) headerNames.push(lower);
      if (RATE_LIMIT_HEADER.test(lower)) rateLimit[lower] = redact(value).slice(0, MAX_HEADER_VALUE_CHARS);
    });
    return {
      status: res.status,
      headerNames: headerNames.sort(),
      rateLimit,
      remaining: remainingFigure(res.headers.get("x-ratelimit-requests-remaining")),
      limit: wholeNumber(res.headers.get("x-ratelimit-requests-limit")),
      bodyBytes,
      serverDateMs: serverDate(res.headers.get("date")),
    };
  }

  async function fetchTrending(signal?: AbortSignal): Promise<FlashapiListResult> {
    if (signal?.aborted) throw new FlashapiError("aborted", "the request was cancelled before it was sent");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    // `head` is what the answer's headers said, when they had arrived: a request cut short in its BODY (a timeout, a
    // dropped connection, an abort) must still carry the server's `remaining`, or a floor of 0 is lost with it.
    const interrupted = (error: unknown, head: FlashapiResponseInfo | null = null): FlashapiError => {
      const extra = head === null ? {} : { status: head.status, response: head };
      if (timedOut) return new FlashapiError("timeout", `flashapi did not answer within ${timeoutMs} ms`, extra);
      if (signal?.aborted) return new FlashapiError("aborted", "the request was cancelled", extra);
      // Under Electron's Node `fetch failed` says nothing more: the runtime's cause code (only) says why.
      const code = causeCode(error);
      const what = error instanceof Error ? `${error.name}: ${error.message}${code === null ? "" : `, ${code}`}` : "unknown error";
      return new FlashapiError("network", `the request failed (${snippet(what, redact)})`, extra);
    };
    try {
      let res: Response;
      try {
        res = await options.fetch(`${base}${TRENDING_PATH}`, {
          method: "GET",
          headers: { "x-rapidapi-host": FLASHAPI_HOST, "x-rapidapi-key": key, accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        throw interrupted(error);
      }
      // The figures live in the headers and do not depend on the body, so they are read BEFORE it.
      const head = infoOf(res, 0);
      let read: { bytes: Uint8Array; over: boolean };
      try {
        read = await readCapped(res, res.ok ? maxBodyBytes : ERROR_BODY_BYTES, !res.ok);
      } catch (error) {
        // A 401 and a 429 are complete answers in their headers: a body that hangs or is cut (or a caller's abort
        // while it is read) must not turn them into a timeout or a network error, or the rejected key would go
        // unmarked and a 429's Retry-After would be lost.
        if (head.status === 401) throw new FlashapiError("rejected", "flashapi answered 401 (its body could not be read)", { status: 401, response: head });
        if (head.status === 429) {
          throw new FlashapiError("rate-limited", "flashapi answered 429 (its body could not be read)", { status: 429, retryAfterMs: retryAfterMs(res.headers.get("retry-after")), response: head });
        }
        throw interrupted(error, head);
      }
      const response = { ...head, bodyBytes: read.bytes.byteLength };

      if (res.status >= 300 || res.status < 200) {
        const said = read.bytes.byteLength > 0 ? `: ${snippet(new TextDecoder().decode(read.bytes), redact)}` : "";
        const detail = `flashapi answered ${res.status}${said}`;
        if (res.status === 401) throw new FlashapiError("rejected", detail, { status: 401, response });
        if (res.status === 403) throw new FlashapiError("forbidden", detail, { status: 403, response });
        if (res.status === 429) throw new FlashapiError("rate-limited", detail, { status: 429, retryAfterMs: retryAfterMs(res.headers.get("retry-after")), response });
        throw new FlashapiError("http", detail, { status: res.status, response });
      }
      if (read.over) throw new FlashapiError("too-large", `the answer is larger than ${maxBodyBytes} bytes`, { status: res.status, response });

      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(read.bytes));
      } catch {
        throw new FlashapiError("invalid", `the answer is not JSON (${snippet(new TextDecoder().decode(read.bytes.subarray(0, 80)), redact)})`, { status: res.status, response });
      }
      const list = parseFlashapiList(json);
      if (!list.ok) throw new FlashapiError("invalid", `the answer is not a list of items (${list.reason})`, { status: res.status, response });
      return { list, response };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  return { fetchTrending };
}
