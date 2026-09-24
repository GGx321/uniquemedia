import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../../money/budget";
import { Ledger, type LedgerDeps, type Scope } from "../../money/ledger";
import { PriceBook } from "../../money/prices";
import { createOpenRouterClient } from "../client";
import type {
  ChatParams,
  ImageParams,
  OpenRouterClient,
  OpenRouterClientOptions,
  OpenRouterFetch,
  OpenRouterRequestInit,
  OpenRouterResponse,
} from "../types";

// Test-only helpers: an in-process fake fetch, a real ledger + budget in a temp
// dir, and a client wired to both. Nothing here can reach the network.

/** Never a real key. Shaped like one so redaction patterns are exercised too. */
export const TEST_KEY = "sk-or-v1-TESTKEY0123456789abcdefSECRET";
export const LOCAL_BASE = "http://127.0.0.1:9/api/v1";
export const SCOPE: Scope = { avatarJobId: "avjob-1" };
export const IMAGE_MODEL = "x-ai/grok-imagine-image-2.0";
export const CHAT_MODEL = "x-ai/grok-4.3";
/** grok-imagine-image-2.0, low, 1K (40_000) + one reference (10_000), from the fallback table. */
export const WORST_ONE_REF = 50_000;

export const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00);
export const JPEG_2 = Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06);
export const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52);
export const WEBP = Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0x24, 0, 0, 0], [..."WEBPVP8 "].map((c) => c.charCodeAt(0))));

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

// ---------- fake fetch ----------

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
  signal: AbortSignal;
  /** The request body parsed as JSON. */
  json(): Record<string, unknown>;
  /** How the client consumed the response body. */
  response: { pulledChunks: number; cancelled: boolean };
}

export type Reply =
  | { status: number; body?: string | object; headers?: Record<string, string>; bodyHangs?: boolean; chunkBytes?: number }
  | { reject: unknown }
  /** Never answers; rejects when the request's signal aborts, like a real fetch. */
  | { hang: true }
  /** Never answers and ignores the signal: a broken fetch the client must not wait on forever. */
  | { hangForever: true };

export type Step = Reply | ((call: FetchCall) => Reply | Promise<Reply>);

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function responseOf(
  reply: { status: number; body?: string | object; headers?: Record<string, string>; bodyHangs?: boolean; chunkBytes?: number },
  signal: AbortSignal,
  record: FetchCall["response"]
): OpenRouterResponse {
  const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof reply.body === "string" ? reply.body : reply.body === undefined ? "" : JSON.stringify(reply.body);
  const bytes = Buffer.from(text, "utf8");
  const chunk = reply.chunkBytes ?? 64 * 1024;
  let offset = 0;
  return {
    status: reply.status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (reply.bodyHangs) return whenAborted(signal);
          if (record.cancelled || offset >= bytes.length) return { done: true };
          const value = new Uint8Array(bytes.subarray(offset, offset + chunk));
          offset += chunk;
          record.pulledChunks++;
          return { done: false, value };
        },
        cancel: async () => {
          record.cancelled = true;
        },
      }),
    },
  };
}

/** A scripted fetch: call n gets step n; a call past the script fails the test loudly. */
export function fakeFetch(steps: Step[]): { fetch: OpenRouterFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: OpenRouterFetch = async (url: string, init: OpenRouterRequestInit) => {
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
      json: () => JSON.parse(init.body ?? "null"),
      response: { pulledChunks: 0, cancelled: false },
    };
    calls.push(call);
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error(`unexpected fetch call #${calls.length} to ${url}`);
    const reply = typeof step === "function" ? await step(call) : step;
    if ("reject" in reply) throw reply.reject;
    if ("hang" in reply) return whenAborted(init.signal);
    if ("hangForever" in reply) return new Promise<never>(() => {});
    return responseOf(reply, init.signal, call.response);
  };
  return { fetch, calls };
}

// ---------- money ----------

export interface Money {
  ledgerPath: string;
  ledger: Ledger;
  budget: Budget;
  priceBook: PriceBook;
  /** The ledger file's lines as parsed JSON, read synchronously from disk. */
  lines(): Record<string, unknown>[];
  cleanup(): Promise<void>;
}

export async function setupMoney(
  opts: { runCapMicros?: number; monthlyBudgetMicros?: number; monotonic?: () => number; ledger?: LedgerDeps } = {},
): Promise<Money> {
  const dir = await mkdtemp(join(tmpdir(), "studio-openrouter-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = await Ledger.open(ledgerPath, opts.ledger);
  const budget = new Budget(ledger, {
    runCapMicros: opts.runCapMicros ?? 10_000_000,
    monthlyBudgetMicros: opts.monthlyBudgetMicros ?? 10_000_000,
    clock: () => Date.parse("2026-09-24T12:00:00.000Z"),
    monotonic: opts.monotonic ?? (() => 0),
  });
  return {
    ledgerPath,
    ledger,
    budget,
    priceBook: PriceBook.fallback(),
    lines: () => readLedgerLines(ledgerPath),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function readLedgerLines(path: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The ledger lines without their timestamps, for exact comparisons. */
export function withoutAt(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.map(({ at: _at, ...rest }) => rest);
}

// ---------- client ----------

export interface Harness {
  client: OpenRouterClient;
  logs: string[];
  raws: { attemptId: string; text: string }[];
  /** Every wait the client asked for between transport retries. */
  sleeps: number[];
}

export function makeClient(fetch: OpenRouterFetch, overrides: Partial<OpenRouterClientOptions> = {}): Harness {
  const logs: string[] = [];
  const raws: { attemptId: string; text: string }[] = [];
  const sleeps: number[] = [];
  let mono = 0;
  const client = createOpenRouterClient({
    apiKey: TEST_KEY,
    baseUrl: LOCAL_BASE,
    allowBaseUrlOverride: true,
    fetch,
    saveRaw: async (attemptId, text) => {
      raws.push({ attemptId, text });
    },
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    clock: () => Date.parse("2026-09-24T12:00:00.000Z"),
    monotonic: () => (mono += 5),
    ...overrides,
  });
  return { client, logs, raws, sleeps };
}

export function imageParams(money: Money, overrides: Partial<ImageParams> = {}): ImageParams {
  return {
    attemptId: "slot-1#1",
    jobId: "job-1",
    scope: SCOPE,
    model: IMAGE_MODEL,
    prompt: "Head-and-shoulders portrait photo of a 25-year-old woman",
    resolution: "1K",
    aspectRatio: "3:4",
    quality: "low",
    references: [JPEG],
    budget: money.budget,
    priceBook: money.priceBook,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function chatParams(money: Money, overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    attemptId: "age-1#1",
    jobId: "age-1",
    scope: SCOPE,
    model: CHAT_MODEL,
    messages: [{ role: "user", content: "Is the person clearly an adult, at least 21?" }],
    maxTokens: 1_000,
    inputTokens: 2_000,
    reasoningEffort: "low",
    budget: money.budget,
    priceBook: money.priceBook,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A 2xx Image API body. */
export function imageBody(bytes: Uint8Array, extra: { cost?: number | null; mediaType?: string | null } = {}): object {
  return {
    created: 1790208293,
    data: [{ b64_json: b64(bytes), media_type: extra.mediaType === undefined ? "image/png" : extra.mediaType }],
    ...(extra.cost === undefined ? {} : { usage: { cost: extra.cost } }),
  };
}

/** A 2xx chat completion body. */
export function chatBody(content: string | null, extra: { cost?: number; finishReason?: string | null } = {}): object {
  return {
    id: "gen-1",
    choices: [{ index: 0, finish_reason: extra.finishReason === undefined ? "stop" : extra.finishReason, message: { role: "assistant", content } }],
    ...(extra.cost === undefined ? {} : { usage: { prompt_tokens: 658, completion_tokens: 334, cost: extra.cost } }),
  };
}
