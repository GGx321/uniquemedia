import { Buffer } from "node:buffer";
import { z } from "zod";
import type { Budget, ReserveHandle } from "../money/budget";
import { MoneyError } from "../money/errors";
import type { Scope } from "../money/ledger";
import { settleRule, type AttemptOutcome } from "../money/settleRule";
import type { BodyReader, Failed, FailureKind, LedgerEffect, NotOk, OpenRouterFetch, OpenRouterRequestInit, OpenRouterResponse } from "./types";

export const MAX_MESSAGE_CHARS = 500;
/** Default cap on a response body: far above a 2K image as base64. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** How much of an over-cap body is kept for `saveRaw`. */
export const RAW_PREFIX_BYTES = 64 * 1024;
/** Read past the kept prefix, so a secret straddling the cut is redacted whole (keys are ~75 bytes). */
const SECRET_OVERLAP_BYTES = 256;

/** What the client methods share: validated configuration and injected seams. */
export interface ClientContext {
  key: string;
  base: string;
  fetch: OpenRouterFetch;
  saveRaw: (attemptId: string, text: string) => Promise<void>;
  log: (line: string) => void;
  timeoutMs: number;
  maxBodyBytes: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
  clock: () => number;
  monotonic: () => number;
  /** Removes the key (and anything key-shaped) from text that leaves the client. */
  redact: (text: string) => string;
  /** Redacts the text before `cut`, keeping a secret that straddles the cut whole. */
  redactHead: (text: string, cut: number) => string;
}

/** How a paid 2xx body is used: its value, or why it is unusable. */
export type Interpretation<T> =
  | { ok: true; value: T }
  /** UNUSABLE_PAID_RESPONSE: the raw body is saved and the error is fatal. EMPTY_CONTENT: neither. */
  | { ok: false; kind: "UNUSABLE_PAID_RESPONSE" | "EMPTY_CONTENT"; why: string };

export interface AttemptSpec<T> {
  attemptId: string;
  jobId: string;
  scope: Scope;
  model: string;
  worstMicros: number;
  budget: Budget;
  signal: AbortSignal;
  path: string;
  /** Called after the reserve; a throw here means the request was never sent. */
  buildBody: () => unknown;
  /** `body` is the parsed JSON, or undefined when the text is not JSON. */
  interpret: (body: unknown) => Interpretation<T>;
}

export type AttemptResult<T> =
  | { status: "ok"; value: T; costMicros: number; estimated: boolean; latencyMs: number; httpTries: number; aboveWorst: boolean }
  | NotOk;

export function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Every message, log line and ledger reason: redacted first, so a cut can never leave part of the key. */
export function clean(ctx: ClientContext, text: string): string {
  return truncate(ctx.redact(text));
}

export function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Closes the attempt once; any later close is a bug that must surface. */
type Finish = (outcome: AttemptOutcome) => Promise<{ ledger: LedgerEffect; aboveWorst: boolean }>;

/**
 * Closes the attempt the way the money core's settle rule says. A bill above
 * the worst case is recorded by the budget and then reported here as
 * `aboveWorst` (the budget already refuses every further reserve); any other
 * money error propagates.
 */
async function close(budget: Budget, handle: ReserveHandle, outcome: AttemptOutcome): Promise<{ ledger: LedgerEffect; aboveWorst: boolean }> {
  const decision = settleRule(outcome, handle.worstMicros);
  switch (decision.action) {
    case "settle": {
      let aboveWorst = false;
      try {
        await budget.settle(handle, { costMicros: decision.costMicros, estimated: decision.estimated });
      } catch (err) {
        if (!(err instanceof MoneyError && err.code === "SETTLE_ABOVE_WORST")) throw err;
        aboveWorst = true;
      }
      return { ledger: { action: "settled", costMicros: decision.costMicros, estimated: decision.estimated }, aboveWorst };
    }
    case "release":
      await budget.release(handle, decision.reason);
      return { ledger: { action: "released" }, aboveWorst: false };
    case "leave-open":
      await budget.abandon(handle);
      return { ledger: { action: "left-open", worstMicros: handle.worstMicros }, aboveWorst: false };
  }
}

/**
 * After an unexpected throw, leaves no attempt in flight (reconcile refuses
 * while one is): released if `fetch` was never called, otherwise abandoned
 * (open at its worst case). A release the ledger cannot record falls back to
 * abandon; an attempt a failed close already closed is left as it is.
 */
async function closeAfterThrow(budget: Budget, handle: ReserveHandle, dispatched: boolean): Promise<void> {
  if (!dispatched) {
    try {
      await budget.release(handle, "unexpected error before the request was sent");
      return;
    } catch {
      // Fall through: abandon writes nothing, so it cannot fail on the ledger.
    }
  }
  try {
    await budget.abandon(handle);
  } catch (err) {
    if (!(err instanceof MoneyError && err.code === "ATTEMPT_CLOSED")) throw err;
  }
}

function failed(ctx: ClientContext, kind: FailureKind, message: string, httpStatus: number | null, ledger: LedgerEffect, extra: Partial<Failed> = {}): Failed {
  const fatal = kind === "AUTH_INVALID" || kind === "INSUFFICIENT_CREDITS" || kind === "UNUSABLE_PAID_RESPONSE";
  return { status: "error", kind, message: clean(ctx, message), httpStatus, fatal, ...extra, ledger };
}

/**
 * One paid attempt: reserve (on disk) before anything is sent, then send, then
 * close the reserve per the money core's settle rule. Whatever throws after
 * the reserve, the attempt does not stay in flight.
 */
export async function runPaidAttempt<T>(ctx: ClientContext, spec: AttemptSpec<T>): Promise<AttemptResult<T>> {
  const { budget } = spec;
  const reserved = await budget.tryReserve({
    attemptId: spec.attemptId,
    jobId: spec.jobId,
    scope: spec.scope,
    model: spec.model,
    worstMicros: spec.worstMicros,
  });
  if (!reserved.ok) return { status: "blocked", refusal: reserved };
  const handle = reserved.handle;

  const progress = { dispatched: false, closed: false };
  const finish: Finish = async (outcome) => {
    const closed = await close(budget, handle, outcome);
    progress.closed = true;
    return closed;
  };
  try {
    return await sendAttempt(ctx, spec, finish, progress);
  } catch (err) {
    if (!progress.closed) await closeAfterThrow(budget, handle, progress.dispatched);
    throw err;
  }
}

async function sendAttempt<T>(ctx: ClientContext, spec: AttemptSpec<T>, finish: Finish, progress: { dispatched: boolean }): Promise<AttemptResult<T>> {
  let init: Omit<OpenRouterRequestInit, "signal" | "redirect">;
  try {
    init = {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(spec.buildBody()),
    };
  } catch (err) {
    const reason = clean(ctx, `the request could not be built: ${describe(err)}`);
    const { ledger } = await finish({ kind: "not-sent", reason });
    return failed(ctx, "NOT_SENT", reason, null, ledger);
  }

  /** The status of the last non-2xx received in this attempt, if any. */
  let lastStatus: number | null = null;
  for (let retry = 0; ; retry++) {
    if (spec.signal.aborted) {
      // Nothing is in flight: either nothing was ever sent, or the last exchange was a final non-2xx.
      const outcome: AttemptOutcome =
        lastStatus === null ? { kind: "not-sent", reason: "aborted before the request was sent" } : { kind: "response", status: lastStatus, body: undefined };
      const { ledger } = await finish(outcome);
      return { status: "aborted", ledger };
    }

    const started = ctx.monotonic();
    progress.dispatched = true;
    const exchange = await sendOnce(ctx, `${ctx.base}${spec.path}`, init, spec.signal, ctx.timeoutMs);
    const latencyMs = Math.max(0, Math.round(ctx.monotonic() - started));

    if (exchange.kind === "no-response") return endWithoutResponse(ctx, finish, exchange);
    const { status, text } = exchange;
    if (status >= 200 && status <= 299) return endPaid(ctx, spec, finish, { ...exchange, latencyMs, httpTries: retry + 1 });

    // A non-2xx is final and free, even when its body could not be read.
    lastStatus = status;
    if (exchange.stoppedBy === "abort") continue;
    const body = text ?? "";
    const detail = errorDetail(body);
    const retryAfterMs = parseRetryAfter(exchange.retryAfter, ctx.clock());
    const hintTooLong = retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS;
    if (RETRYABLE.has(status) && retry < MAX_TRANSPORT_RETRIES && !hintTooLong) {
      const wait = Math.max(BACKOFF_BASE_MS * 2 ** retry, retryAfterMs ?? 0) + Math.floor(ctx.random() * JITTER_MS);
      ctx.log(clean(ctx, `[${spec.attemptId}] HTTP ${status}, transport retry ${retry + 1}/${MAX_TRANSPORT_RETRIES} in ${wait} ms: ${detail}`));
      await ctx.sleep(wait, spec.signal);
      continue;
    }

    const { ledger } = await finish({ kind: "response", status, body: exchange.truncated ? undefined : safeJson(body) });
    const message = `HTTP ${status}: ${detail}`;
    const hint = retryAfterMs === null ? {} : { retryAfterMs };
    if (isModerationRefusal(status, body)) return { status: "refused", httpStatus: status, message: clean(ctx, message), ledger };
    return failed(ctx, finalKind(status), message, status, ledger, hint);
  }
}

/** No status line: our abort or timeout, or a network error. The request may have been billed. */
async function endWithoutResponse<T>(ctx: ClientContext, finish: Finish, exchange: Extract<Exchange, { kind: "no-response" }>): Promise<AttemptResult<T>> {
  const outcome: AttemptOutcome =
    exchange.stoppedBy === "timeout"
      ? { kind: "timeout" }
      : exchange.stoppedBy === "abort"
        ? { kind: "aborted" }
        : { kind: "network-error", message: exchange.message };
  const { ledger } = await finish(outcome);
  if (outcome.kind === "aborted") return { status: "aborted", ledger };
  if (outcome.kind === "timeout") return failed(ctx, "TIMEOUT", `no response within ${ctx.timeoutMs} ms`, null, ledger);
  return failed(ctx, "NETWORK", exchange.message, null, ledger);
}

/**
 * A 2xx: paid. A usable body settles and returns its value. An unusable one
 * (including a body over the cap, kept as a prefix) has its raw body saved,
 * redacted, before it is settled, and is fatal; a lost body settles at the
 * worst case.
 */
async function endPaid<T>(
  ctx: ClientContext,
  spec: AttemptSpec<T>,
  finish: Finish,
  exchange: Extract<Exchange, { kind: "response" }> & { latencyMs: number; httpTries: number }
): Promise<AttemptResult<T>> {
  const { status, text } = exchange;
  if (text === null) {
    const { ledger } = await finish({ kind: "response", status, body: undefined });
    if (exchange.stoppedBy === "abort") return { status: "aborted", ledger };
    const why = exchange.stoppedBy === "timeout" ? `timed out after ${ctx.timeoutMs} ms` : exchange.bodyError;
    return failed(ctx, "UNUSABLE_PAID_RESPONSE", `HTTP ${status}, paid but the body could not be read: ${why}`, status, ledger, { rawSaved: false });
  }

  const body = exchange.truncated ? undefined : safeJson(text);
  const used: Interpretation<T> = exchange.truncated
    ? { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: `the body exceeded ${ctx.maxBodyBytes} bytes` }
    : spec.interpret(body);
  if (!used.ok) {
    let rawSaved = false;
    let saveError = "";
    if (used.kind === "UNUSABLE_PAID_RESPONSE") {
      // Redact before cutting: a key split by the cut must not survive as a fragment.
      const raw = exchange.truncated
        ? `${ctx.redactHead(text, exchange.keptChars)}\n[truncated: the body exceeded ${ctx.maxBodyBytes} bytes; only its start is kept]`
        : ctx.redact(text);
      try {
        await ctx.saveRaw(spec.attemptId, raw);
        rawSaved = true;
      } catch (err) {
        saveError = `; the raw body could not be saved: ${describe(err)}`;
      }
    }
    const { ledger } = await finish({ kind: "response", status, body });
    const extra = used.kind === "UNUSABLE_PAID_RESPONSE" ? { rawSaved } : {};
    return failed(ctx, used.kind, `HTTP ${status}, paid but unusable: ${used.why}${saveError}`, status, ledger, extra);
  }

  const { ledger, aboveWorst } = await finish({ kind: "response", status, body });
  if (ledger.action !== "settled") throw new Error(`a 2xx must settle, got ${ledger.action}`);
  const { latencyMs, httpTries } = exchange;
  return { status: "ok", value: used.value, costMicros: ledger.costMicros, estimated: ledger.estimated, latencyMs, httpTries, aboveWorst };
}

// ---------- one HTTP try ----------

type StoppedBy = "timeout" | "abort";

export type Exchange =
  /** No status line: our timeout or abort fired, or fetch rejected on its own (network). */
  | { kind: "no-response"; stoppedBy: StoppedBy | null; message: string }
  /**
   * A status line. `text` is null when the body could not be read. When
   * `truncated`, it holds only the start of a body over the cap: the kept
   * prefix (`keptChars` characters) plus a short overlap past it.
   */
  | {
      kind: "response";
      status: number;
      retryAfter: string | null;
      text: string | null;
      truncated: boolean;
      keptChars: number;
      stoppedBy: StoppedBy | null;
      bodyError: string;
    };

/**
 * Sends one HTTP try with its own timeout (response body included) linked to
 * the caller's signal; redirects are refused. The signal goes to `fetch`, and
 * both are also raced against the fetch and every body read, so a fetch that
 * ignores its signal cannot hold the attempt past the timeout.
 */
export async function sendOnce(
  ctx: ClientContext,
  url: string,
  init: Omit<OpenRouterRequestInit, "signal" | "redirect">,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Exchange> {
  const controller = new AbortController();
  let stoppedBy: StoppedBy | null = null;
  const stop = (why: StoppedBy): void => {
    stoppedBy ??= why;
    controller.abort();
  };
  const onAbort = (): void => stop("abort");
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  });
  // The race below observes `stopped`; this only keeps an unobserved rejection from being reported.
  stopped.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);

  /** Races `work` against our stop; a late rejection of the abandoned `work` is observed and dropped. */
  const race = <T>(work: Promise<T>): Promise<T> => {
    work.catch(() => {});
    return Promise.race([work, stopped]);
  };
  try {
    let res: OpenRouterResponse;
    try {
      res = await race(ctx.fetch(url, { ...init, redirect: "error", signal: controller.signal }));
    } catch (err) {
      return { kind: "no-response", stoppedBy, message: describe(err) };
    }
    const retryAfter = res.headers.get("retry-after");
    try {
      const { text, truncated, keptChars } = await readCapped(res.body, race, ctx.maxBodyBytes);
      return { kind: "response", status: res.status, retryAfter, text, truncated, keptChars, stoppedBy: null, bodyError: "" };
    } catch (err) {
      return { kind: "response", status: res.status, retryAfter, text: null, truncated: false, keptChars: 0, stoppedBy, bodyError: describe(err) };
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads a body up to `maxBytes`, counting bytes as they stream in. Over the
 * cap it stops once it holds the kept prefix plus the overlap, and cancels
 * the stream; `keptChars` marks where the prefix ends in `text`.
 */
async function readCapped(
  body: { getReader(): BodyReader } | null,
  race: <T>(work: Promise<T>) => Promise<T>,
  maxBytes: number
): Promise<{ text: string; truncated: boolean; keptChars: number }> {
  if (body === null) return { text: "", truncated: false, keptChars: 0 };
  const reader = body.getReader();
  // Cancelling is best effort: the stream may already be errored or closed.
  const cancel = (): void => void reader.cancel().catch(() => {});
  const keepBytes = Math.min(maxBytes, RAW_PREFIX_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read());
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes && total >= keepBytes + SECRET_OVERLAP_BYTES) {
        cancel();
        break;
      }
    }
  } catch (err) {
    cancel();
    throw err;
  }
  const bytes = Buffer.concat(chunks);
  if (total <= maxBytes) return { text: bytes.toString("utf8"), truncated: false, keptChars: 0 };
  return {
    text: bytes.subarray(0, keepBytes + SECRET_OVERLAP_BYTES).toString("utf8"),
    truncated: true,
    keptChars: bytes.subarray(0, keepBytes).toString("utf8").length,
  };
}

// ---------- non-2xx ----------

/** Transport retries: only these statuses, and only inside the same attempt id. */
const RETRYABLE: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const MAX_TRANSPORT_RETRIES = 2;
/** A `Retry-After` longer than this is not waited out: the attempt ends RATE_LIMITED with the hint. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** A reported `Retry-After` is clamped to this. */
export const MAX_RETRY_HINT_MS = 24 * 60 * 60 * 1_000;
const BACKOFF_BASE_MS = 1_000;
const JITTER_MS = 1_000;

/**
 * Moderation wording in `error.message` only (a prompt echo or a parameter
 * name such as `safety_tolerance` must not count). Spike: "xAI blocked this
 * request through content moderation." (400). Seedream: "... may contain
 * sensitive information".
 */
const MODERATION_MESSAGE = /content moderation|blocked this request|flagged|content[ _]polic|nsfw|sensitive (?:content|information)/i;
/** Provider error codes inside `error.metadata.raw`, e.g. ByteDance's `InputImageSensitiveContentDetected`. */
const PROVIDER_MODERATION_CODE = /SensitiveContent/;

const ErrorBody = z.object({
  error: z.object({
    message: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }),
});

export function errorDetail(text: string): string {
  const parsed = ErrorBody.safeParse(safeJson(text));
  if (!parsed.success) return text.trim() === "" ? "(no body)" : text;
  const { message, metadata } = parsed.data.error;
  return `${message ?? "(no message)"}${metadata ? ` ${JSON.stringify(metadata)}` : ""}`;
}

function isModerationRefusal(status: number, text: string): boolean {
  if (status !== 400 && status !== 403 && status !== 422) return false;
  const parsed = ErrorBody.safeParse(safeJson(text));
  if (!parsed.success) return false;
  const { message, metadata } = parsed.data.error;
  if (typeof message === "string" && MODERATION_MESSAGE.test(message)) return true;
  const raw = metadata?.raw;
  const rawText = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw);
  return PROVIDER_MODERATION_CODE.test(rawText);
}

export function finalKind(status: number): FailureKind {
  if (status === 401) return "AUTH_INVALID";
  if (status === 402) return "INSUFFICIENT_CREDITS";
  if (status === 429) return "RATE_LIMITED";
  return "HTTP_ERROR";
}

/** Seconds or an HTTP date, in whole ms from now, clamped to [0, MAX_RETRY_HINT_MS]; null when absent or unreadable. */
function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(MAX_RETRY_HINT_MS, Math.max(0, Math.round(ms)));
}
