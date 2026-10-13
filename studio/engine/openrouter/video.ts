import { z } from "zod";
import { costToMicros } from "../money/settleRule";
import { faultOf, freeGet, httpFault, SAFE_ID } from "./freeCall";
import { clean, errorDetail, finalKind, isModerationRefusal, safeJson, sendOnce, type ClientContext } from "./transport";
import type { VideoPollResult, VideoRequest, VideoStatus, VideoSubmitResult } from "./types";

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

// ---------- GET /videos/<id> ----------

const PollBody = z.object({
  status: z.string().min(1),
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
});
const UsageCost = z.object({ cost: z.number().finite().nonnegative() });

const STATUS_WORDS: Readonly<Record<string, VideoStatus>> = {
  pending: "pending",
  queued: "pending",
  in_progress: "in_progress",
  processing: "in_progress",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
};

/** A failed job's text: a string, or an object with a string `message`; anything else is no text. */
function errorTextOf(error: unknown): string | null {
  if (typeof error === "string") return error;
  const wrapped = z.object({ message: z.string() }).safeParse(error);
  return wrapped.success ? wrapped.data.message : null;
}

function billOf(usage: unknown): number | null {
  const parsed = UsageCost.safeParse(usage);
  if (!parsed.success) return null;
  const micros = costToMicros(parsed.data.cost);
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
    status: STATUS_WORDS[rawStatus] ?? "unknown",
    rawStatus: clean(ctx, rawStatus),
    usageCostMicros: billOf(parsed.data.usage),
    error,
    contentFailure: isContentFailure(rawError, null),
  };
}
