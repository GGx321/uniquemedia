import { createHash } from "node:crypto";
import { z } from "zod";
import {
  API,
  P,
  RENDER_CONCURRENCY,
  imageWorstCaseMicros,
  type Aspect,
  type ImageModel,
  type Quality,
  type Resolution,
} from "./config";
import { appendJsonl, findExisting, outRel, writeAtomic } from "./files";
import { downscaledJpeg, extFor, imageSize, jpegDataUrl, sniffMediaType } from "./image";
import { billedJobIds, ledgerSpentMicros, usd, type Budget } from "./money";
import { ImageResponse, paidRequest, saveRawBody, type Outcome } from "./openrouter";

export interface Ctx {
  dryRun: boolean;
  capMicros: number;
  budget: Budget;
}

// ---------- dry-run plan printing ----------

export interface PlanRow {
  jobId: string;
  model: string;
  resolution: string;
  quality: string;
  refs: number;
  aspect: string;
  prompt: string;
  worstMicros: number;
  /** Why the job would not be sent (output exists, already billed, over --limit). */
  skip: string | null;
}

export async function printPlan(title: string, rows: PlanRow[], ctx: Ctx): Promise<void> {
  console.log(`\n=== DRY RUN: ${title} — no network calls, nothing written ===`);
  console.log(`OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? "present" : "absent"}`);
  let total = 0;
  let fitsUntil: number | null = null;
  const spent = await ledgerSpentMicros();
  for (const [i, r] of rows.entries()) {
    const cost = r.skip ? 0 : r.worstMicros;
    total += cost;
    if (fitsUntil === null && spent + total > ctx.capMicros) fitsUntil = i;
    console.log(
      [
        r.jobId.padEnd(22),
        r.model.padEnd(33),
        r.resolution.padEnd(3),
        r.quality.padEnd(6),
        `refs=${r.refs}`,
        r.aspect.padEnd(4),
        r.skip ? `SKIP(${r.skip})` : usd(r.worstMicros),
        JSON.stringify(r.prompt.slice(0, 100)),
      ].join("  ")
    );
  }
  const sent = rows.filter((r) => !r.skip).length;
  console.log(`--- ${sent} request(s), ${rows.length - sent} skipped; total worst case ${usd(total)}`);
  console.log(
    `--- cap ${usd(ctx.capMicros)}, ledger spent ${usd(spent)}, headroom ${usd(ctx.capMicros - spent)}: ` +
      (fitsUntil === null ? "fits under the cap" : `cap would stop scheduling at request #${fitsUntil + 1}`)
  );
}

// ---------- worker pool ----------

/**
 * Runs `work` with bounded concurrency. `shouldStop` is checked before an item
 * is taken, so every item is either finished or returned as unstarted.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
  shouldStop: () => boolean
): Promise<T[]> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      await work(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return items.slice(next);
}

// ---------- image jobs ----------

export interface ImageJob {
  jobId: string;
  model: ImageModel;
  resolution: Resolution;
  quality: Quality | null;
  aspect: Aspect;
  /** Final prompt as sent. */
  prompt: string;
  /** Source reference images; each is downscaled to 1024 px JPEG before sending. */
  refPaths: string[];
  refNames: string[];
  /** Absolute output path without extension; the extension follows the returned bytes. */
  outBase: string;
  config: string;
  slotId: string;
  category: string | null;
  spice: number | null;
  shot: string | null;
}

export const ResultStatus = z.enum(["ok", "refused", "error", "timeout", "skipped_cap"]);
export const ResultLine = z.object({
  jobId: z.string(),
  config: z.string(),
  slotId: z.string(),
  category: z.string().nullable(),
  spice: z.number().int().nullable(),
  shot: z.string().nullable(),
  model: z.string(),
  resolution: z.string(),
  quality: z.string().nullable(),
  refs: z.array(z.string()),
  promptSha: z.string().optional(),
  status: ResultStatus,
  httpStatus: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  costMicros: z.number().int().nonnegative(),
  latencyMs: z.number().nullable(),
  attempts: z.number().int().optional(),
  mediaType: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  file: z.string().nullable(),
  at: z.string(),
});
export type ResultLine = z.infer<typeof ResultLine>;

export function worstCaseOf(job: ImageJob): number {
  return imageWorstCaseMicros(job.model, job.resolution, job.quality, job.refPaths.length);
}

function promptSha(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

const refUrlCache = new Map<string, Promise<string>>();
function refDataUrl(path: string): Promise<string> {
  let p = refUrlCache.get(path);
  if (!p) {
    p = downscaledJpeg(path, 1024).then(jpegDataUrl);
    refUrlCache.set(path, p);
  }
  return p;
}

type Fields = "status" | "httpStatus" | "errorMessage" | "costMicros" | "latencyMs" | "at";
function baseLine(job: ImageJob): Omit<ResultLine, Fields> {
  return {
    jobId: job.jobId,
    config: job.config,
    slotId: job.slotId,
    category: job.category,
    spice: job.spice,
    shot: job.shot,
    model: job.model,
    resolution: job.resolution,
    quality: job.quality,
    refs: job.refNames,
    promptSha: promptSha(job.prompt),
    mediaType: null,
    width: null,
    height: null,
    bytes: null,
    file: null,
  };
}

function failLine(job: ImageJob, o: Exclude<Outcome<ImageResponse>, { status: "ok" }>): ResultLine {
  return {
    ...baseLine(job),
    status: o.status,
    httpStatus: o.httpStatus,
    errorMessage: o.errorMessage,
    costMicros: o.costMicros,
    latencyMs: o.latencyMs,
    attempts: o.attempts,
    at: new Date().toISOString(),
  };
}

function skippedCapLine(job: ImageJob, message: string): ResultLine {
  return { ...baseLine(job), status: "skipped_cap", httpStatus: null, errorMessage: message, costMicros: 0, latencyMs: null, at: new Date().toISOString() };
}

async function executeImageJob(job: ImageJob, budget: Budget): Promise<{ line: ResultLine; fatal: string | null }> {
  const refUrls = await Promise.all(job.refPaths.map(refDataUrl));
  const body = {
    model: job.model,
    prompt: job.prompt,
    resolution: job.resolution,
    aspect_ratio: job.aspect,
    ...(job.quality ? { quality: job.quality } : {}),
    ...(refUrls.length ? { input_references: refUrls.map((url) => ({ type: "image_url", image_url: { url } })) } : {}),
  };
  const o = await paidRequest({
    jobId: job.jobId,
    model: job.model,
    url: API.images,
    body,
    worstCaseMicros: worstCaseOf(job),
    budget,
    schema: ImageResponse,
    saveRaw: "on_failure",
  });
  if (o.status !== "ok") return { line: failLine(job, o), fatal: o.fatal };

  const common = { ...baseLine(job), httpStatus: o.httpStatus, costMicros: o.costMicros, latencyMs: o.latencyMs, attempts: o.attempts };
  try {
    const first = o.data.data[0];
    const bytes = Buffer.from(first.b64_json.replace(/^data:[^,]*,/, ""), "base64");
    const sniffed = sniffMediaType(bytes);
    if (!sniffed) throw new Error(`unrecognised image bytes (media_type ${first.media_type ?? "none"})`);
    const file = `${job.outBase}.${extFor(sniffed)}`;
    await writeAtomic(file, bytes);
    const size = imageSize(bytes);
    const line: ResultLine = {
      ...common,
      status: "ok",
      errorMessage: null,
      mediaType: sniffed,
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: bytes.length,
      file: outRel(file),
      at: new Date().toISOString(),
    };
    return { line, fatal: o.fatal };
  } catch (err) {
    // Paid for, but no usable file: keep the body for manual recovery and stop the run.
    const reason = err instanceof Error ? err.message : String(err);
    let rawNote: string;
    try {
      rawNote = `raw body saved to ${outRel(await saveRawBody(job.jobId, o.raw))}`;
    } catch (saveErr) {
      rawNote = `raw body could not be saved either: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
    }
    const line: ResultLine = { ...common, status: "error", errorMessage: `billed 2xx unusable: ${reason}`.slice(0, 500), at: new Date().toISOString() };
    return { line, fatal: `${job.jobId}: billed but the image could not be saved (${reason}); ${rawNote}` };
  }
}

function statusText(l: ResultLine): string {
  const cost = l.costMicros ? ` ${usd(l.costMicros)}` : "";
  const lat = l.latencyMs !== null ? ` ${(l.latencyMs / 1000).toFixed(1)}s` : "";
  if (l.status === "ok") return `ok ${l.width ?? "?"}x${l.height ?? "?"} ${l.file}${cost}${lat}`;
  return `${l.status}${l.httpStatus ? ` ${l.httpStatus}` : ""}${cost}${lat}: ${(l.errorMessage ?? "").slice(0, 200)}`;
}

export interface RunOptions {
  /** Canary: only the first N jobs of each config (in plan order) are eligible. */
  limitPerConfig?: number;
}

/**
 * Plans, prints (dry run) or executes image jobs. A job is skipped without a
 * request when its output exists or when the ledger already holds a billed
 * line for its id (listed as billed_no_file). Every outcome of a started job
 * is appended to results.jsonl; after the cap is hit the unstarted jobs are
 * recorded as skipped_cap. A fatal outcome stops scheduling and throws.
 */
export async function runImageJobs(title: string, jobs: ImageJob[], ctx: Ctx, opts: RunOptions = {}): Promise<void> {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.jobId)) throw new Error(`Duplicate job id ${job.jobId}; refusing to run`);
    ids.add(job.jobId);
  }

  const billed = await billedJobIds();
  const seenPerConfig = new Map<string, number>();
  const rows: PlanRow[] = [];
  const todo: ImageJob[] = [];
  const billedNoFile: string[] = [];
  for (const job of jobs) {
    const index = (seenPerConfig.get(job.config) ?? 0) + 1;
    seenPerConfig.set(job.config, index);
    const existing = findExisting(job.outBase);
    let skip: string | null = null;
    if (opts.limitPerConfig !== undefined && index > opts.limitPerConfig) skip = "over --limit";
    else if (existing) skip = "exists";
    else if (billed.has(job.jobId)) {
      skip = "billed_no_file";
      billedNoFile.push(job.jobId);
    }
    rows.push({
      jobId: job.jobId,
      model: job.model,
      resolution: job.resolution,
      quality: job.quality ?? "-",
      refs: job.refPaths.length,
      aspect: job.aspect,
      prompt: job.prompt,
      worstMicros: worstCaseOf(job),
      skip,
    });
    if (!ctx.dryRun && skip && skip !== "over --limit") console.log(`[${job.jobId}] skip, ${skip}${existing ? `: ${outRel(existing)}` : ""}`);
    if (!skip) todo.push(job);
  }

  if (ctx.dryRun) {
    await printPlan(title, rows, ctx);
    return;
  }
  console.log(`${title}: ${todo.length} request(s) to send, cap ${usd(ctx.capMicros)}, spent ${usd(ctx.budget.spentMicros)}`);

  const counts: Record<string, number> = {};
  let fatal: string | null = null;
  const unstarted = await runPool(
    todo,
    RENDER_CONCURRENCY,
    async (job) => {
      let result: { line: ResultLine; fatal: string | null };
      try {
        result = await executeImageJob(job, ctx.budget);
      } catch (err) {
        // Thrown before or around the request (reference prep, ledger write): nothing usable was produced.
        const msg = `local failure in ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`;
        result = { line: { ...baseLine(job), status: "error", httpStatus: null, errorMessage: msg.slice(0, 500), costMicros: 0, latencyMs: null, at: new Date().toISOString() }, fatal: msg };
      }
      const { line } = result;
      await appendJsonl(P.results, line);
      counts[line.status] = (counts[line.status] ?? 0) + 1;
      console.log(`[${job.jobId}] ${statusText(line)}`);
      if (line.costMicros > 0 && line.status !== "ok") billedNoFile.push(job.jobId);
      if (result.fatal && !fatal) fatal = result.fatal;
    },
    () => ctx.budget.capHit || fatal !== null
  );

  if (ctx.budget.capHit) {
    for (const job of unstarted) {
      await appendJsonl(P.results, skippedCapLine(job, "not started: cap reached"));
      counts.skipped_cap = (counts.skipped_cap ?? 0) + 1;
    }
    console.log(`CAP HIT: ${usd(ctx.capMicros)} would be exceeded; stopped scheduling new jobs.`);
  }
  console.log(`${title} done: ${JSON.stringify(counts)}; ledger spent ${usd(ctx.budget.spentMicros)} of cap ${usd(ctx.capMicros)}`);
  if (billedNoFile.length) {
    console.log(`billed_no_file (${billedNoFile.length}, never re-requested; bodies in out/raw/ for recovery): ${billedNoFile.join(", ")}`);
  }
  if (fatal) throw new Error(`STOPPED: ${fatal}${unstarted.length ? ` (${unstarted.length} job(s) not started)` : ""}`);
}
