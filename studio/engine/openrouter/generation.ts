import { z } from "zod";
import { costToMicros } from "../money/settleRule";
import { faultOf, freeGet, httpFault } from "./freeCall";
import { safeJson, type ClientContext } from "./transport";
import type { GenerationResult } from "./types";

/** Only the figures the money path reads; every other field of the record is ignored. */
const GenerationBody = z.object({
  data: z.object({
    total_cost: z.number().finite().nonnegative(),
    finish_reason: z.string().nullish(),
  }),
});

/** The API's own 404: `{"error":{"message":"Generation <id> not found","code":404}}`. A proxy's 404 page is not this. */
const NotFoundBody = z.object({
  error: z.object({ code: z.number().optional(), message: z.string().nullish() }),
});

function isApiNotFound(text: string): boolean {
  const parsed = NotFoundBody.safeParse(safeJson(text));
  if (!parsed.success) return false;
  const { code, message } = parsed.data.error;
  return code === 404 || (typeof message === "string" && /not found/i.test(message));
}

/**
 * `GET /generation?id=` (free): the provider's own bill for one generation.
 *
 * A 404 from the API is `not-found`, never an error: it is evidence the money path weighs (a video's record appears about 15 s after it
 * completes; a refused Kling job never got one). Any other failure, and a body that does not validate, is `unreadable`: never a guessed cost.
 */
export async function fetchGeneration(ctx: ClientContext, id: string, signal?: AbortSignal): Promise<GenerationResult> {
  const label = "GET /generation";
  const answer = await freeGet(ctx, `${ctx.base}/generation?id=${encodeURIComponent(id)}`, label, signal);
  if (answer.kind === "fault") return { kind: "unreadable", ...answer.fault };
  const { status, text } = answer;
  if (status === 404 && isApiNotFound(text)) return { kind: "not-found" };
  if (status < 200 || status > 299) return { kind: "unreadable", ...httpFault(ctx, label, status, text) };
  const parsed = answer.truncated ? null : GenerationBody.safeParse(safeJson(text));
  if (parsed === null || !parsed.success) {
    const why = parsed === null ? `the body exceeded ${ctx.maxBodyBytes} bytes` : "the body is not a generation record with a valid total_cost";
    return { kind: "unreadable", ...faultOf(ctx, "malformed", status, `${label}: HTTP ${status}, ${why}`) };
  }
  const totalCostMicros = costToMicros(parsed.data.data.total_cost);
  if (!Number.isSafeInteger(totalCostMicros)) {
    return { kind: "unreadable", ...faultOf(ctx, "malformed", status, `${label}: HTTP ${status}, total_cost is too large`) };
  }
  return { kind: "found", totalCostMicros, finishReason: parsed.data.data.finish_reason ?? null };
}
