import { z } from "zod";
import { costToMicrosCeil } from "../money/settleRule";
import { faultOf, freeGet, httpFault, SAFE_ID } from "./freeCall";
import { clean, safeJson, type ClientContext } from "./transport";
import type { GenerationResult } from "./types";

/** Only the figures the money path reads; every other field of the record is ignored. */
const GenerationBody = z.object({
  data: z.object({
    total_cost: z.number().finite().nonnegative(),
    finish_reason: z.string().nullish(),
  }),
});

/**
 * The API's own 404 for this id: `{"error":{"message":"Generation <id> not found","code":404}}`, both parts. A router's or proxy's JSON 404
 * (`Not Found`, `Route … not found`, a bare code) is not this: counted as «nothing is billed» it could start a second paid attempt.
 */
const NotFoundBody = z.object({
  error: z.object({ code: z.literal(404), message: z.string() }),
});

function isApiNotFound(text: string, id: string): boolean {
  const parsed = NotFoundBody.safeParse(safeJson(text));
  return parsed.success && parsed.data.error.message === `Generation ${id} not found`;
}

/**
 * `GET /generation?id=` (free): the provider's own bill for one generation.
 *
 * A 404 from the API is `not-found`, never an error: it is evidence the money path weighs (a video's record appears about 15 s after it
 * completes; a refused Kling job never got one). Any other failure, and a body that does not validate, is `unreadable`: never a guessed cost.
 */
export async function fetchGeneration(ctx: ClientContext, id: string, signal?: AbortSignal): Promise<GenerationResult> {
  const label = "GET /generation";
  if (!SAFE_ID.test(id)) return { kind: "unreadable", ...faultOf(ctx, "malformed", null, `${label}: the id is not a job id; nothing was sent`) };
  const answer = await freeGet(ctx, `${ctx.base}/generation?id=${encodeURIComponent(id)}`, label, signal);
  if (answer.kind === "fault") return { kind: "unreadable", ...answer.fault };
  const { status, text } = answer;
  if (status === 404 && isApiNotFound(text, id)) return { kind: "not-found" };
  if (status < 200 || status > 299) return { kind: "unreadable", ...httpFault(ctx, label, status, text) };
  const parsed = answer.truncated ? null : GenerationBody.safeParse(safeJson(text));
  if (parsed === null || !parsed.success) {
    const why = parsed === null ? `the body exceeded ${ctx.maxBodyBytes} bytes` : "the body is not a generation record with a valid total_cost";
    return { kind: "unreadable", ...faultOf(ctx, "malformed", status, `${label}: HTTP ${status}, ${why}`) };
  }
  const totalCostMicros = costToMicrosCeil(parsed.data.data.total_cost);
  if (!Number.isSafeInteger(totalCostMicros)) {
    return { kind: "unreadable", ...faultOf(ctx, "malformed", status, `${label}: HTTP ${status}, total_cost is too large`) };
  }
  return { kind: "found", totalCostMicros, finishReason: parsed.data.data.finish_reason == null ? null : clean(ctx, parsed.data.data.finish_reason) };
}
