import type { ImageMediaType, LibraryReference } from "../library/media";
import type { Budget, ReserveRefusal } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { ImageQuality, ImageResolution, PriceBook } from "../money/prices";

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

/** The part of a file handle the download writes with; `fs.promises.FileHandle` satisfies it. */
export interface OpenedFile {
  write(bytes: Uint8Array): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

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
  /**
   * Saves the body of a paid 2xx that could not be used; called before the
   * attempt is settled. `keepBytes` is the attempt's own cap (image.ts's
   * attempts pass a small one); omitted, the store's own default applies.
   */
  saveRaw: (attemptId: string, text: string, keepBytes?: number) => Promise<void>;
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
  /** A clip download's whole-body limit, file writes included. Default `DOWNLOAD_TIMEOUT_MS` (10 min). */
  downloadTimeoutMs?: number;
  /** Creates the download's file, exclusively (it must fail if the path exists). Default: `fs.promises.open(path, "wx")`. */
  openFile?: (path: string) => Promise<OpenedFile>;
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
  /**
   * Asked right before every HTTP try, after the reserve (T6, review L1): a
   * caller that stopped sending — a photo run after a fatal error in another
   * slot — answers false, and the attempt ends as `aborted` without the
   * request (its reserve released, or its last non-2xx settled at zero),
   * exactly like an abort at that point. Omitted: always send.
   */
  beforeSend?: () => boolean;
}

export interface ImageParams extends AttemptParams {
  prompt: string;
  aspectRatio: AspectRatio;
  quality?: ImageQuality | null;
  /** Already-downscaled JPEGs, sourced only through `Library.loadReference()` (invariant 9). */
  references: readonly LibraryReference[];
  /** 5a.3 (S5.9d): the size this one call asks for and is priced at; absent = `IMAGE_RESOLUTION` (1K), the body every request had before the «Смелая» route. */
  resolution?: ImageResolution;
}

/**
 * 5a.3 (S5.9d, I5.38): the «Смелая» request: Seedream at 2K with no quality knob and EXACTLY ONE reference, the portrait master (four references refused everything on Seedream;
 * two were not adopted). The tuple makes a second reference a compile error, the way a portrait batch's `PortraitBatch.references` does.
 */
export interface BoldImageParams extends ImageParams {
  resolution: "2K";
  quality?: null;
  references: readonly [LibraryReference];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * What the request asks of the model's reasoning, sent as `reasoning: { effort }` and nothing else. 5b.2 (S5.WCX): «none» turns grok-4.3's reasoning off (P-R: 0 reasoning tokens in 6 of 6
 * calls). `reasoning.max_tokens` is never sent: for Grok, OpenRouter maps it to an effort and it RAISED the reasoning (P-R: 1 024-2 575 tokens).
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface ChatParams extends AttemptParams {
  messages: readonly ChatMessage[];
  /** Structured output: sent as a strict `json_schema` response format. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  /** Prompt-token ceiling, images included, for the worst case (see money/estimate.ts). */
  inputTokens: number;
  /** 5b.2 (S5.WCX): the reasoning allowance priced on top of `maxTokens` and never sent (`ChatPriceShape.reasoningTokens`, openrouter/chat.ts); absent = 0. */
  reasoningTokens?: number;
  reasoningEffort: ReasoningEffort;
  /** JPEGs, attached to the last user message. */
  images?: readonly Uint8Array[];
  /**
   * 5b.2 (S5.WC3, I5.67): a caller's own scrub of a saved raw body, run AFTER the image-data scrub (`omitByPattern`). A paid answer that cannot be used is saved on disk; a caller whose request held text
   * that must not outlive the call (the owner's idea) removes it from the saved body here. Absent: only the image-data scrub runs, as before.
   * A caller that passes it also gets the provider's message of a failed (non-2xx) answer replaced AS A WHOLE by `[provider message: N chars]` in the retry log line and the result's message; this function
   * does not run over it (S5.WC3c: it finds only the forms it knows, and a partial echo would survive).
   */
  scrubRaw?: (text: string) => string;
}

/** Why a free GET (a poll, a `/generation` lookup) gave no usable answer. */
export type FreeCallCause = "auth" | "credits" | "http" | "timeout" | "aborted" | "network" | "malformed";

/** A free GET that gave no usable answer. Never a thrown error: the caller decides what an unknown answer means for the money. */
export interface FreeCallFault {
  cause: FreeCallCause;
  httpStatus: number | null;
  /** Redacted, at most 500 characters. */
  detail: string;
}

/**
 * `GET /generation?id=` (free).
 * - `found`: the provider's own bill in integer micro-dollars, and why the job ended.
 * - `not-found`: the API's own 404 for this id. Distinct from `unreadable`: right after a video completes it is a 404 for about 15 s,
 *   and for a refused Kling job it stayed one through +10 min (probes P0 and P-V), so it is evidence, not a failure.
 * - `unreadable`: anything else (a 5xx, a timeout, a 404 that is not the API's, a body that fails validation).
 */
export type GenerationResult =
  | { kind: "found"; totalCostMicros: number; finishReason: string | null }
  | { kind: "not-found" }
  | ({ kind: "unreadable" } & FreeCallFault);

/** One image of a video request, as the API takes it: a JPEG data URL. */
export interface VideoFrameImage {
  type: "image_url";
  image_url: { url: string };
  frame_type: "first_frame" | "last_frame";
}

/**
 * The body of `POST /videos`. The caller builds it (prompt, frames, price); the client only sends it. `generate_audio` is Kling's alone (`false`): Grok's listing has no audio flag,
 * so its body carries none (plan s5b1 §5.5; S5.V4a1 made the field optional, additively).
 */
export interface VideoRequest {
  model: string;
  prompt: string;
  duration: number;
  resolution: "720p" | "1080p";
  aspect_ratio: "9:16";
  generate_audio?: false;
  frame_images: readonly VideoFrameImage[];
}

/**
 * What one `POST /videos` did. It is sent once, never resent: a job may be billed from the moment the request leaves.
 * - `accepted`: a 2xx with a usable job id.
 * - `refused`: a definite 4xx. Nothing was started and nothing is billed. `moderation` is true for a content refusal.
 * - `uncertain`: no answer, a 5xx, or a 2xx without a usable id. The job may exist and may bill, so the caller keeps its reserve open.
 */
export type VideoSubmitResult =
  | { kind: "accepted"; id: string }
  | { kind: "refused"; httpStatus: number; errorKind: FailureKind; moderation: boolean; detail: string }
  | { kind: "uncertain"; cause: "timeout" | "aborted" | "network" | "server-error" | "unreadable-accept"; httpStatus: number | null; detail: string };

/**
 * The job states the API reports, plus `unknown` for a word this client has not seen (the caller keeps polling).
 * `queued` reads as `pending` and `processing` as `in_progress`.
 */
export type VideoStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired" | "unknown";

/**
 * One `GET /videos/<id>` (free).
 * - `status`: a readable answer. `usageCostMicros` is the job's own bill when the body carries a valid one, else null (a completed job
 *   may come without it; `/generation` then answers). `error` is the provider's text of a failed job.
 *   `contentFailure` is true when that text is a content refusal (moderation, Kling's risk control).
 *   `generationId` is the body's `generation_id` when it is a plain id, else null: the proof of a free refusal reads `/generation` by the job id and trusts it only when the two are the same (I5.47).
 * - `unreadable`: no answer or an invalid body; the caller polls again.
 */
export type VideoPollResult =
  | { kind: "status"; status: VideoStatus; rawStatus: string; usageCostMicros: number | null; error: string | null; contentFailure: boolean; generationId: string | null }
  | ({ kind: "unreadable" } & FreeCallFault);

/**
 * `GET /videos/<id>/content?index=0` streamed to a file (free once the job completed).
 * - `saved`: the whole body is in the file and flushed to disk. Nothing is checked about the bytes here (V4b validates them).
 * - `too-large`: the body is over the cap (by its `Content-Length` or by the bytes that arrived); the file is removed.
 * - `gone`: 404 or 410, the file has left OpenRouter for good.
 * - `redirect-refused`: the answer was a redirect. None is followed, whatever its target, so the bearer key never goes to another host;
 *   `host` is the target's host when it could be read (never its path or query, which may be a signed URL).
 * - `failed`: anything else; the file this call made is removed. `disk` is a local write error, `empty` a 200 without a body, `exists` a file already at the path (never touched).
 * On every result but `saved`, this call leaves no file of its own at the path; on `exists` the file that was already there stays (by design).
 */
export type VideoDownloadResult =
  | { kind: "saved"; bytes: number }
  | { kind: "too-large"; capBytes: number }
  | { kind: "gone"; httpStatus: 404 | 410 }
  | { kind: "redirect-refused"; httpStatus: number | null; host: string | null }
  | { kind: "failed"; cause: FreeCallCause | "disk" | "empty" | "exists"; httpStatus: number | null; detail: string };

export interface OpenRouterClient {
  generateImage(params: ImageParams): Promise<ImageResult>;
  chat(params: ChatParams): Promise<ChatResult>;
  /** The parsed JSON body of `GET /credits`, for the money core's reconcile. */
  fetchCredits(): Promise<unknown>;
  /** `GET /generation?id=<id>`: the provider's bill for one generation, or the fact that none is there (yet). */
  fetchGeneration(id: string, signal?: AbortSignal): Promise<GenerationResult>;
  /** `POST /videos`: starts one video job, once. No money here: the caller reserves before and settles after. */
  submitVideo(request: VideoRequest, signal: AbortSignal): Promise<VideoSubmitResult>;
  /** `GET /videos/<id>`: the job's status. */
  pollVideo(id: string, signal?: AbortSignal): Promise<VideoPollResult>;
  /** Streams the finished clip to `toPath` (a temp name the caller owns), refusing a body over `capBytes` and every redirect. */
  downloadVideo(id: string, toPath: string, capBytes: number, signal: AbortSignal): Promise<VideoDownloadResult>;
}
