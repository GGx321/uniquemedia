import { Buffer } from "node:buffer";
import { open, rm } from "node:fs/promises";
import { z } from "zod";
import { costToMicrosCeil } from "../money/settleRule";
import { faultOf, freeGet, httpFault, SAFE_ID } from "./freeCall";
import { clean, describe, errorDetail, finalKind, isModerationRefusal, safeJson, sendOnce, type ClientContext } from "./transport";
import type { BodyReader, OpenedFile, OpenRouterResponse, VideoDownloadResult, VideoPollResult, VideoRequest, VideoStatus, VideoSubmitResult } from "./types";

// The async video transport: HTTP only. No reserve, no settle, no journal, no retry. The state machine that owns the money is S5.V3b.

/** Kling's own wording (probe P0): «task failed with status: FAIL, message: Failure to pass the risk control system». */
const RISK_CONTROL = /risk control/i;

/**
 * Whether a failed job's text (or the `/generation` finish reason) is a content refusal: the moderation matcher the image path uses,
 * Kling's risk control, or a `content_filter` finish. A provider timeout or an internal error text is not.
 */
export function isContentFailure(error: string | null, finishReason: string | null): boolean {
  if (finishReason === "content_filter") return true;
  if (error === null) return false;
  // The matcher reads `error.message` of a 4xx body; a failed job's text is the same kind of message.
  return RISK_CONTROL.test(error) || isModerationRefusal(400, JSON.stringify({ error: { message: error } }));
}

// ---------- POST /videos ----------

const Accepted = z.object({ id: z.string().regex(SAFE_ID) });

/**
 * Sends one `POST /videos`. It is sent once: a job may be billed from the moment the request leaves, so no failure is retried here. A
 * 2xx without a usable id is `uncertain`, never `accepted`: the job may exist.
 */
export async function submitVideo(ctx: ClientContext, request: VideoRequest, signal: AbortSignal): Promise<VideoSubmitResult> {
  const label = "POST /videos";
  const exchange = await sendOnce(
    ctx,
    `${ctx.base}/videos`,
    { method: "POST", headers: { Authorization: `Bearer ${ctx.key}`, "Content-Type": "application/json" }, body: JSON.stringify(request) },
    signal,
    ctx.timeoutMs,
  );
  if (exchange.kind === "no-response") {
    const cause = exchange.stoppedBy === "timeout" ? "timeout" : exchange.stoppedBy === "abort" ? "aborted" : "network";
    const detail = cause === "timeout" ? `${label}: no response within ${ctx.timeoutMs} ms` : cause === "aborted" ? `${label}: aborted` : `${label}: ${exchange.message}`;
    return uncertain(ctx, cause, null, detail);
  }
  const { status, text } = exchange;
  if (status >= 200 && status <= 299) {
    const parsed = text === null || exchange.truncated ? null : Accepted.safeParse(safeJson(text));
    if (parsed !== null && parsed.success) return { kind: "accepted", id: parsed.data.id };
    return uncertain(ctx, "unreadable-accept", status, `${label}: HTTP ${status}, the answer carries no usable job id`);
  }
  const body = text ?? "";
  const detail = `${label}: HTTP ${status}: ${errorDetail(body)}`;
  if (status === 408) return uncertain(ctx, "timeout", status, detail);
  if (status < 400 || status >= 500) return uncertain(ctx, "server-error", status, detail);
  const result: VideoSubmitResult = {
    kind: "refused",
    httpStatus: status,
    errorKind: finalKind(status),
    moderation: isModerationRefusal(status, body),
    detail: clean(ctx, detail),
  };
  ctx.log(clean(ctx, `[video] ${label} refused: HTTP ${status}${result.moderation ? " (moderation)" : ""}`));
  return result;
}

function uncertain(ctx: ClientContext, cause: Extract<VideoSubmitResult, { kind: "uncertain" }>["cause"], httpStatus: number | null, detail: string): VideoSubmitResult {
  ctx.log(clean(ctx, `[video] POST /videos uncertain (${cause}${httpStatus === null ? "" : `, HTTP ${httpStatus}`}); it will not be resent`));
  return { kind: "uncertain", cause, httpStatus, detail: clean(ctx, detail) };
}

// ---------- GET /videos/<id>/content ----------

/** How long a call waits on the disk after it was stopped (timeout or abort): a local open or close ends in milliseconds. */
const POST_STOP_WAIT_MS = 500;
const TIMED_OUT = Symbol("timed out");

/** `work`, or `TIMED_OUT` after `ms`: a hung file system cannot hold the caller. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** "wx": never truncate or later delete a file that was already there. */
function openExclusive(path: string): Promise<OpenedFile> {
  return open(path, "wx");
}

/** The whole body, from request to the last byte. A clip is up to 100 MiB, so this is far above the 20 s of a free JSON GET. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
/** How much of a non-2xx body is read for its message. */
const ERROR_BODY_BYTES = 4 * 1024;

type Stopped = "timeout" | "abort" | null;

function redirectRelated(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    if (/redirect/i.test(e.message)) return true;
  }
  return false;
}

/** The host of a redirect's target; never its path or query, which may be a signed URL. */
function hostOf(location: string | null): string | null {
  if (location === null) return null;
  try {
    return new URL(location, "http://invalid.invalid").host;
  } catch {
    return null;
  }
}

/**
 * Streams the finished clip into `toPath`, flushed to disk, byte for byte. The caller owns `toPath` (a temp name) and renames it after
 * V4b's checks. No redirect is followed, whatever its target: the bearer key must never be sent to another host. A body over `capBytes`
 * is refused as soon as it is known (by `Content-Length`, or by the bytes that arrive, whichever comes first). On every result but
 * `saved`, this call leaves no file of its own at `toPath`; a file that was already there is never touched (`exists`). Every wait on the
 * disk, and every wait after a stop, is bounded, so a hung file system cannot hold the call past its timeout.
 */
export async function downloadVideo(ctx: ClientContext, id: string, toPath: string, capBytes: number, signal: AbortSignal): Promise<VideoDownloadResult> {
  if (!Number.isSafeInteger(capBytes) || capBytes < 1) throw new RangeError(`capBytes must be a positive integer, got ${capBytes}`);
  const label = "GET /videos/<id>/content";
  const failed = (cause: Extract<VideoDownloadResult, { kind: "failed" }>["cause"], httpStatus: number | null, detail: string): VideoDownloadResult => {
    const result: VideoDownloadResult = { kind: "failed", cause, httpStatus, detail: clean(ctx, detail) };
    ctx.log(clean(ctx, `[video] ${label} failed (${cause}${httpStatus === null ? "" : `, HTTP ${httpStatus}`})`));
    return result;
  };
  if (!SAFE_ID.test(id)) return failed("malformed", null, `${label}: the id is not a job id; nothing was sent`);

  const controller = new AbortController();
  let stoppedBy: Stopped = null;
  const stop = (why: Exclude<Stopped, null>): void => {
    stoppedBy ??= why;
    controller.abort();
  };
  const onAbort = (): void => stop("abort");
  const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  stopped.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = ctx.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const race = <T>(work: Promise<T>): Promise<T> => {
    work.catch(() => {});
    return Promise.race([work, stopped]);
  };
  const interrupted = (): VideoDownloadResult =>
    stoppedBy === "timeout" ? failed("timeout", null, `${label}: not finished within ${timeoutMs} ms`) : failed("aborted", null, `${label}: aborted`);

  let reader: BodyReader | null = null;
  let handle: OpenedFile | null = null;
  let opened = false;
  let keepFile = false;
  try {
    let res: OpenRouterResponse;
    try {
      res = await race(
        ctx.fetch(`${ctx.base}/videos/${encodeURIComponent(id)}/content?index=0`, {
          method: "GET",
          headers: { Authorization: `Bearer ${ctx.key}` },
          redirect: "error",
          signal: controller.signal,
        }),
      );
    } catch (err) {
      if (stoppedBy !== null) return interrupted();
      if (redirectRelated(err)) return { kind: "redirect-refused", httpStatus: null, host: null };
      return failed("network", null, `${label}: ${describe(err)}`);
    }
    const { status } = res;
    reader = res.body === null ? null : res.body.getReader();
    const giveUpOnBody = (): void => void reader?.cancel().catch(() => {});

    if (status >= 300 && status < 400) {
      giveUpOnBody();
      const host = hostOf(res.headers.get("location"));
      return { kind: "redirect-refused", httpStatus: status, host: host === null ? null : clean(ctx, host) };
    }
    if (status < 200 || status > 299) {
      const text = await smallText(reader, race);
      giveUpOnBody();
      if (stoppedBy !== null) return interrupted();
      // Only the provider's own answer ends the clip for good; a proxy's 404 page is retryable.
      if ((status === 404 || status === 410) && GoneBody(status).safeParse(safeJson(text)).success) return { kind: "gone", httpStatus: status };
      const fault = httpFault(ctx, label, status, text);
      return failed(fault.cause, status, fault.detail);
    }
    if (status !== 200) {
      giveUpOnBody();
      return failed("http", status, `${label}: HTTP ${status}, expected a 200 with the clip`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (res.headers.get("content-length") !== null && Number.isFinite(declared) && declared > capBytes) {
      giveUpOnBody();
      return { kind: "too-large", capBytes };
    }
    if (reader === null) return failed("empty", status, `${label}: HTTP ${status}, no body`);

    // "wx": never truncate or later delete a file that was already there.
    const opening = (ctx.openFile ?? openExclusive)(toPath);
    try {
      handle = await race(opening);
      opened = true;
    } catch (err) {
      giveUpOnBody();
      if (stoppedBy !== null) {
        // The open may land after the stop (a local open ends quickly): close and remove what it made.
        // Bounded: a hung open is cleaned up in the background if it ever lands.
        const late = await within(opening.catch(() => null), POST_STOP_WAIT_MS);
        const cleanUp = async (file: OpenedFile): Promise<void> => {
          await within(file.close().catch(() => {}), POST_STOP_WAIT_MS);
          await within(rm(toPath, { force: true }).catch(() => {}), POST_STOP_WAIT_MS);
        };
        if (late === TIMED_OUT) void opening.then(cleanUp, () => {});
        else if (late !== null) await cleanUp(late);
        return interrupted();
      }
      const exists = err instanceof Error && "code" in err && err.code === "EEXIST";
      return failed(exists ? "exists" : "disk", status, `${label}: the file could not be created: ${describe(err)}`);
    }
    let total = 0;
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await race(reader.read());
      } catch (err) {
        giveUpOnBody();
        if (stoppedBy !== null) return interrupted();
        return failed("network", status, `${label}: the body broke after ${total} bytes: ${describe(err)}`);
      }
      if (chunk.done) break;
      if (chunk.value === undefined || chunk.value.byteLength === 0) continue;
      total += chunk.value.byteLength;
      if (total > capBytes) {
        giveUpOnBody();
        return { kind: "too-large", capBytes };
      }
      try {
        await race(handle.write(chunk.value));
      } catch (err) {
        giveUpOnBody();
        if (stoppedBy !== null) return interrupted();
        return failed("disk", status, `${label}: the file could not be written: ${describe(err)}`);
      }
    }
    if (total === 0) return failed("empty", status, `${label}: HTTP ${status}, the body is empty`);
    try {
      await race(handle.sync());
      await race(handle.close());
      handle = null;
    } catch (err) {
      if (stoppedBy !== null) return interrupted();
      return failed("disk", status, `${label}: the file could not be flushed: ${describe(err)}`);
    }
    keepFile = true;
    return { kind: "saved", bytes: total };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (handle !== null) await within(handle.close().catch(() => {}), POST_STOP_WAIT_MS);
    if (opened && !keepFile) await within(rm(toPath, { force: true }).catch(() => {}), POST_STOP_WAIT_MS);
  }
}

/** The provider's own 404 or 410: a JSON error object carrying that code. */
const GoneBody = (status: 404 | 410) => z.object({ error: z.object({ code: z.literal(status) }) });

/** At most `ERROR_BODY_BYTES` of a non-2xx body as text, for its message; a failure to read it is an empty text. */
async function smallText(
  reader: BodyReader | null,
  race: <T>(work: Promise<T>) => Promise<T>,
): Promise<string> {
  if (reader === null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < ERROR_BODY_BYTES) {
      const { done, value } = await race(reader.read());
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // The status is what matters; a body that cannot be read is no text.
  }
  return Buffer.concat(chunks).subarray(0, ERROR_BODY_BYTES).toString("utf8");
}

// ---------- GET /videos/<id> ----------

const PollBody = z.object({
  status: z.string().min(1),
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
  generation_id: z.unknown().optional(),
});
const GenerationId = z.string().regex(SAFE_ID);
const UsageCost = z.object({ cost: z.number().finite().nonnegative() });

const STATUS_WORDS: ReadonlyMap<string, VideoStatus> = new Map<string, VideoStatus>(Object.entries({
  pending: "pending",
  queued: "pending",
  in_progress: "in_progress",
  processing: "in_progress",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
}));

/** A failed job's text: a string, or an object with a string `message`; anything else is no text. */
function errorTextOf(error: unknown): string | null {
  if (typeof error === "string") return error;
  const wrapped = z.object({ message: z.string() }).safeParse(error);
  return wrapped.success ? wrapped.data.message : null;
}

function billOf(usage: unknown): number | null {
  const parsed = UsageCost.safeParse(usage);
  if (!parsed.success) return null;
  const micros = costToMicrosCeil(parsed.data.cost);
  return Number.isSafeInteger(micros) ? micros : null;
}

/** One `GET /videos/<id>` (free). Any failure to read an answer is `unreadable`, never thrown: the caller polls again. */
export async function pollVideo(ctx: ClientContext, id: string, signal?: AbortSignal): Promise<VideoPollResult> {
  const label = "GET /videos/<id>";
  if (!SAFE_ID.test(id)) return { kind: "unreadable", ...faultOf(ctx, "malformed", null, `${label}: the id is not a job id; nothing was sent`) };
  const answer = await freeGet(ctx, `${ctx.base}/videos/${encodeURIComponent(id)}`, label, signal);
  if (answer.kind === "fault") return { kind: "unreadable", ...answer.fault };
  const { status, text } = answer;
  if (status < 200 || status > 299) return { kind: "unreadable", ...httpFault(ctx, label, status, text) };
  const parsed = answer.truncated ? null : PollBody.safeParse(safeJson(text));
  if (parsed === null || !parsed.success) {
    return { kind: "unreadable", ...faultOf(ctx, "malformed", status, `${label}: HTTP ${status}, the body is not a job status`) };
  }
  const rawStatus = parsed.data.status;
  const rawError = errorTextOf(parsed.data.error);
  const error = rawError === null ? null : clean(ctx, rawError);
  return {
    kind: "status",
    status: STATUS_WORDS.get(rawStatus) ?? "unknown",
    rawStatus: clean(ctx, rawStatus),
    usageCostMicros: billOf(parsed.data.usage),
    error,
    contentFailure: isContentFailure(rawError, null),
    generationId: GenerationId.safeParse(parsed.data.generation_id).data ?? null,
  };
}
