import type { ImageMediaType } from "../library/media";
import type { Budget, ReserveRefusal } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { ImageQuality, PriceBook, Resolution } from "../money/prices";

/** The part of a response body stream the client reads, byte-counted against a cap. */
export interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/** The part of a fetch `Response` the client reads; the global `Response` satisfies it. */
export interface OpenRouterResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): BodyReader } | null;
}

export interface OpenRouterRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Always "error": a 307/308 must not replay a paid POST elsewhere. */
  redirect: "error";
  signal: AbortSignal;
}

/** The subset of `fetch` the client needs; the global `fetch` satisfies it. */
export type OpenRouterFetch = (url: string, init: OpenRouterRequestInit) => Promise<OpenRouterResponse>;

export interface OpenRouterClientOptions {
  /** Held in memory only; never logged, never part of an error message. */
  apiKey: string;
  /** Must be `OPENROUTER_API_BASE` unless `allowBaseUrlOverride` is true. */
  baseUrl: string;
  /**
   * Invariant 13: a build-time constant the engine passes; the packaged build
   * passes false. When true, only a loopback http(s) base is accepted.
   */
  allowBaseUrlOverride: boolean;
  fetch: OpenRouterFetch;
  /** Saves the body of a paid 2xx that could not be used; called before the attempt is settled. */
  saveRaw: (attemptId: string, text: string) => Promise<void>;
  /** Diagnostic lines (retries); already redacted. */
  log?: (line: string) => void;
  /**
   * Per HTTP try, response body included: an integer in [1, REQUEST_TIMEOUT_MS].
   * Default and maximum: the money core's REQUEST_TIMEOUT_MS (180 s), which its
   * reconcile wait assumes.
   */
  timeoutMs?: number;
  /** Response bodies are read up to this many bytes; a 2xx over it is unusable. Default 32 MiB. */
  maxBodyBytes?: number;
  /** Waits between transport retries; must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** [0, 1), for the retry jitter. */
  random?: () => number;
  /** Wall clock, epoch ms, for an HTTP-date `Retry-After`. */
  clock?: () => number;
  /** Monotonic ms, for latency. */
  monotonic?: () => number;
}

/**
 * What an attempt did to the ledger: settled (a final response), released
 * (it provably never left), or left open at its worst case until reconcile
 * (abort, timeout or network error while the request may have been billed).
 */
export type LedgerEffect =
  | { action: "settled"; costMicros: number; estimated: boolean }
  | { action: "released" }
  | { action: "left-open"; worstMicros: number };

/**
 * - AUTH_INVALID (401), INSUFFICIENT_CREDITS (402): fatal, never retried.
 * - RATE_LIMITED: 429 after transport retries, or a `Retry-After` above the cap.
 * - HTTP_ERROR: any other final non-2xx (5xx after retries, a 4xx that is not a moderation refusal).
 * - TIMEOUT, NETWORK: no final response; the reserve is left open.
 * - NOT_SENT: failed before `fetch` was called; the reserve is released.
 * - UNUSABLE_PAID_RESPONSE: a paid 2xx that could not be used; its raw body was saved; fatal.
 * - EMPTY_CONTENT: a paid chat 2xx whose message has no content.
 */
export type FailureKind =
  | "AUTH_INVALID"
  | "INSUFFICIENT_CREDITS"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK"
  | "NOT_SENT"
  | "UNUSABLE_PAID_RESPONSE"
  | "EMPTY_CONTENT";

/** The budget refused the reserve; nothing was sent. */
export interface Blocked {
  status: "blocked";
  refusal: ReserveRefusal;
}

/** A moderation refusal (free); never retried. */
export interface Refused {
  status: "refused";
  httpStatus: number;
  /** Redacted, at most 500 characters. */
  message: string;
  ledger: LedgerEffect;
}

export interface Failed {
  status: "error";
  kind: FailureKind;
  /** Redacted, at most 500 characters. */
  message: string;
  httpStatus: number | null;
  /** The caller must stop scheduling paid calls. */
  fatal: boolean;
  /** From `Retry-After`, when the server sent one. */
  retryAfterMs?: number;
  /** UNUSABLE_PAID_RESPONSE only: whether `saveRaw` succeeded. */
  rawSaved?: boolean;
  ledger: LedgerEffect;
}

/** The caller's signal fired. */
export interface Aborted {
  status: "aborted";
  ledger: LedgerEffect;
}

export type NotOk = Blocked | Refused | Failed | Aborted;

interface Paid {
  costMicros: number;
  estimated: boolean;
  /** The final HTTP try, request to body read. */
  latencyMs: number;
  /** HTTP tries inside this attempt id (1 + transport retries). */
  httpTries: number;
  /** The bill exceeded the reserved worst case; the budget now refuses every reserve until reconcile. */
  aboveWorst: boolean;
}

export interface ImageOk extends Paid {
  status: "ok";
  bytes: Uint8Array;
  /** From the bytes' magic number. */
  mediaType: ImageMediaType;
}

export type ImageResult = ImageOk | NotOk;

export interface ChatOk extends Paid {
  status: "ok";
  content: string;
  finishReason: string | null;
}

export type ChatResult = ChatOk | NotOk;

export type AspectRatio = `${number}:${number}`;

/** One attempt: the attempt id is never sent twice. */
export interface AttemptParams {
  attemptId: string;
  jobId: string;
  scope: Scope;
  model: string;
  budget: Budget;
  priceBook: PriceBook;
  signal: AbortSignal;
}

export interface ImageParams extends AttemptParams {
  prompt: string;
  resolution: Resolution;
  aspectRatio: AspectRatio;
  quality?: ImageQuality | null;
  /** Already-downscaled JPEGs. */
  references: readonly Uint8Array[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ChatParams extends AttemptParams {
  messages: readonly ChatMessage[];
  /** Structured output: sent as a strict `json_schema` response format. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  /** Prompt-token ceiling, images included, for the worst case (see money/estimate.ts). */
  inputTokens: number;
  reasoningEffort: ReasoningEffort;
  /** JPEGs, attached to the last user message. */
  images?: readonly Uint8Array[];
}

export interface OpenRouterClient {
  generateImage(params: ImageParams): Promise<ImageResult>;
  chat(params: ChatParams): Promise<ChatResult>;
  /** The parsed JSON body of `GET /credits`, for the money core's reconcile. */
  fetchCredits(): Promise<unknown>;
}
