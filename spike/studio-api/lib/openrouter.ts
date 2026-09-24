import { join } from "node:path";
import { z } from "zod";
import { API, MAX_RETRIES, P, TIMEOUT_MS } from "./config";
import { outRel, writeAtomic } from "./files";
import { appendLedger, costToMicros, usd, type Budget } from "./money";

/**
 * Dry-run guard: nothing can reach the network until a non-dry command calls
 * enableNetwork(). A dry run therefore cannot spend money even through a bug.
 */
let networkEnabled = false;
export function enableNetwork(): void {
  networkEnabled = true;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 120_000;

/** Only the image bytes are required; every other field may be missing or null. */
export const ImageResponse = z.object({
  created: z.number().nullish(),
  data: z.array(z.object({ b64_json: z.string().min(1), media_type: z.string().nullish() })).min(1),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});
export type ImageResponse = z.infer<typeof ImageResponse>;

export const ChatResponse = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }), finish_reason: z.string().nullish() }))
    .min(1),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;

const CostProbe = z.object({ usage: z.object({ cost: z.number().finite().nonnegative().nullish() }).nullish() });
const ErrorBody = z.object({
  error: z.object({ message: z.string().nullish(), metadata: z.record(z.string(), z.unknown()).nullish() }),
});
const CreditsBody = z.object({ data: z.object({ total_credits: z.number(), total_usage: z.number() }) });

export type FailStatus = "refused" | "error" | "timeout";
/**
 * `fatal` is set when the run must stop scheduling: a billed response that
 * cannot be used, a bill above the worst case, or an auth/credit failure.
 */
export type Outcome<T> =
  | { status: "ok"; data: T; raw: string; httpStatus: number; costMicros: number; estimated: boolean; latencyMs: number; attempts: number; fatal: string | null }
  | { status: FailStatus; httpStatus: number | null; errorMessage: string; costMicros: number; latencyMs: number | null; attempts: number; fatal: string | null }
  | { status: "skipped_cap"; httpStatus: null; errorMessage: string; costMicros: 0; latencyMs: null; attempts: 0; fatal: null };

export interface PaidRequest<T> {
  jobId: string;
  model: string;
  url: string;
  body: object;
  worstCaseMicros: number;
  budget: Budget;
  schema: z.ZodType<T>;
  /** "always" saves every 2xx body to out/raw before validation; "on_failure" only unusable ones. */
  saveRaw: "always" | "on_failure";
}

export function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** out/raw/<jobId>.json: the response body only, never request headers. */
export function rawPath(jobId: string): string {
  return join(P.raw, `${jobId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

export async function saveRawBody(jobId: string, text: string): Promise<string> {
  const path = rawPath(jobId);
  await writeAtomic(path, text);
  return path;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(text: string): string {
  const r = ErrorBody.safeParse(safeJson(text));
  if (!r.success) return truncate(text);
  const meta = r.data.error.metadata ? ` ${JSON.stringify(r.data.error.metadata)}` : "";
  return truncate(`${r.data.error.message ?? "(no message)"}${meta}`);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function describe(err: unknown): string {
  return truncate(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

/** Retry-After (seconds or HTTP date) or exponential backoff, plus jitter. Null = too long, give up. */
function retryDelayMs(retryAfter: string | null, attempt: number): number | null {
  const backoff = 2_000 * 2 ** attempt;
  let hinted = 0;
  if (retryAfter) {
    const secs = Number(retryAfter);
    hinted = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (!Number.isFinite(hinted)) hinted = 0;
  }
  if (hinted > MAX_RETRY_AFTER_MS) return null;
  return Math.max(backoff, hinted) + Math.floor(Math.random() * 1_000);
}

function apiKey(): string {
  if (!networkEnabled) throw new Error("Network is disabled (dry-run guard)");
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return key;
}

/**
 * One billed-at-most-once request. The worst case is reserved before the first
 * attempt and held through retries; retries only follow unbilled failures
 * (429/5xx). A 2xx is written to the ledger before its body is validated, so a
 * malformed success still counts against the cap and is never bought again.
 */
export async function paidRequest<T>(req: PaidRequest<T>): Promise<Outcome<T>> {
  const key = apiKey();
  const { jobId, model, budget, worstCaseMicros: worst } = req;
  if (!budget.tryReserve(worst)) {
    return {
      status: "skipped_cap",
      httpStatus: null,
      errorMessage: `cap ${usd(budget.capMicros)} would be exceeded`,
      costMicros: 0,
      latencyMs: null,
      attempts: 0,
      fatal: null,
    };
  }

  let billed = 0;
  const bill = async (costMicros: number, estimated: boolean): Promise<void> => {
    billed = costMicros;
    await appendLedger({ jobId, model, costMicros, at: new Date().toISOString(), ...(estimated ? { estimated: true as const } : {}) });
  };

  try {
    for (let attempt = 0; ; attempt++) {
      const attempts = attempt + 1;
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);

      let res: Response;
      try {
        res = await fetch(req.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "studio-api spike" },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // No response: the client disconnected, which OpenRouter does not bill.
        return { status: isTimeout(err) ? "timeout" : "error", httpStatus: null, errorMessage: describe(err), costMicros: 0, latencyMs: elapsed(), attempts, fatal: null };
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        if (!res.ok) {
          return { status: isTimeout(err) ? "timeout" : "error", httpStatus: res.status, errorMessage: describe(err), costMicros: 0, latencyMs: elapsed(), attempts, fatal: null };
        }
        // A 2xx whose body was cut off may still have been billed: assume the worst and stop.
        await bill(worst, true);
        return {
          status: isTimeout(err) ? "timeout" : "error",
          httpStatus: res.status,
          errorMessage: describe(err),
          costMicros: billed,
          latencyMs: elapsed(),
          attempts,
          fatal: `${jobId}: HTTP ${res.status} body could not be read (${describe(err)}); billed as worst case`,
        };
      }
      const latencyMs = elapsed();

      if (res.ok) {
        if (req.saveRaw === "always") await saveRawBody(jobId, text);
        const json = safeJson(text);
        const probe = CostProbe.safeParse(json);
        const cost = probe.success ? probe.data.usage?.cost : null;
        const estimated = cost === null || cost === undefined;
        await bill(estimated ? worst : costToMicros(cost), estimated);
        const overBudget =
          billed > worst ? `${jobId}: billed ${usd(billed)} exceeds its worst case ${usd(worst)}; price table is wrong` : null;

        const parsed = req.schema.safeParse(json);
        if (!parsed.success) {
          const path = outRel(await saveRawBody(jobId, text));
          const why =
            json === undefined ? "body is not JSON" : `body does not match the schema: ${z.prettifyError(parsed.error).replace(/\s*\n\s*/g, " ")}`;
          return {
            status: "error",
            httpStatus: res.status,
            errorMessage: truncate(`billed 2xx unusable: ${why}`),
            costMicros: billed,
            latencyMs,
            attempts,
            fatal: overBudget ?? truncate(`${jobId}: billed HTTP ${res.status} but ${why}; raw body saved to ${path}`),
          };
        }
        return { status: "ok", data: parsed.data, raw: text, httpStatus: res.status, costMicros: billed, estimated, latencyMs, attempts, fatal: overBudget };
      }

      const message = errorMessage(text);
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        const wait = retryDelayMs(res.headers.get("retry-after"), attempt);
        if (wait !== null) {
          console.log(`[${jobId}] HTTP ${res.status}, retry ${attempts}/${MAX_RETRIES} in ${(wait / 1000).toFixed(1)}s: ${truncate(message, 160)}`);
          await Bun.sleep(wait);
          continue;
        }
      }
      const status: FailStatus = res.status >= 400 && res.status < 500 && res.status !== 429 ? "refused" : "error";
      const fatal = res.status === 401 || res.status === 402 ? `HTTP ${res.status} (auth or credits): ${truncate(message, 200)}` : null;
      return { status, httpStatus: res.status, errorMessage: message, costMicros: 0, latencyMs, attempts, fatal };
    }
  } finally {
    budget.settle(worst, billed);
  }
}

/**
 * Remaining OpenRouter balance in micro-dollars (free GET). Used only to
 * reconcile against the ledger; a failure is reported, never fatal.
 */
export async function remainingCredits(): Promise<{ micros: number } | { error: string }> {
  try {
    const res = await fetch(API.credits, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}: ${errorMessage(text).slice(0, 200)}` };
    const r = CreditsBody.safeParse(safeJson(text));
    if (!r.success) return { error: "unexpected /credits body" };
    return { micros: costToMicros(r.data.data.total_credits) - costToMicros(r.data.data.total_usage) };
  } catch (err) {
    return { error: describe(err) };
  }
}
