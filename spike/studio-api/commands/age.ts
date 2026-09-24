import { join } from "node:path";
import { z } from "zod";
import { AGE_MAX_TOKENS, AGE_QUESTION, AGE_WORST_MICROS, API, CHAT_MODEL, CONFIG_IDS, P, RENDER_CONCURRENCY } from "../lib/config";
import { appendJsonl, listImages, outRel, readJsonl } from "../lib/files";
import { downscaledJpeg, jpegDataUrl } from "../lib/image";
import { printPlan, runPool, type Ctx } from "../lib/jobs";
import { billedJobIds, usd } from "../lib/money";
import { ChatResponse, paidRequest, rawPath } from "../lib/openrouter";

export const AgeLine = z.object({
  file: z.string(),
  adult: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
  costMicros: z.number().int().nonnegative(),
  latencyMs: z.number().nullable(),
  at: z.string().optional(),
});
export type AgeLine = z.infer<typeof AgeLine>;

const AgeAnswer = z.object({ adult: z.boolean(), confidence: z.number(), reason: z.string() });

const AGE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "age_check",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["adult", "confidence", "reason"],
      properties: { adult: { type: "boolean" }, confidence: { type: "number" }, reason: { type: "string" } },
    },
  },
};

/** Every image on disk under render/<config>/ (only ok renders are written) plus avatar/*. */
async function targets(): Promise<string[]> {
  const files: string[] = [];
  for (const id of CONFIG_IDS) files.push(...(await listImages(join(P.render, id))));
  files.push(...(await listImages(P.avatar)));
  return files;
}

interface Checked {
  line: AgeLine | null;
  message: string;
  costMicros: number;
  /** Set when the run must stop: an unusable billed answer, a bill over the worst case, auth/credits. */
  fatal: string | null;
}

async function checkOne(file: string, ctx: Ctx): Promise<Checked> {
  const rel = outRel(file);
  const jobId = `age:${rel}`;
  const small = await downscaledJpeg(file, 768);
  const body = {
    model: CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: AGE_QUESTION },
          { type: "image_url", image_url: { url: await jpegDataUrl(small) } },
        ],
      },
    ],
    reasoning: { effort: "low" },
    response_format: AGE_RESPONSE_FORMAT,
    max_tokens: AGE_MAX_TOKENS,
    usage: { include: true },
  };
  const o = await paidRequest({
    jobId,
    model: CHAT_MODEL,
    url: API.chat,
    body,
    worstCaseMicros: AGE_WORST_MICROS,
    budget: ctx.budget,
    schema: ChatResponse,
    saveRaw: "always",
  });
  if (o.status !== "ok") {
    return { line: null, message: `${o.status}${o.httpStatus ? ` ${o.httpStatus}` : ""}: ${o.errorMessage}`, costMicros: o.costMicros, fatal: o.fatal };
  }
  const content = o.data.choices[0].message.content ?? "";
  const unusable = (why: string): Checked => ({
    line: null,
    message: `billed ${usd(o.costMicros)} but ${why}`,
    costMicros: o.costMicros,
    fatal: `${jobId}: billed answer ${why}; raw body in ${outRel(rawPath(jobId))}`,
  });
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return unusable("is not JSON");
  }
  const answer = AgeAnswer.safeParse(json);
  if (!answer.success) return unusable("does not match the schema");
  const line: AgeLine = { file: rel, ...answer.data, costMicros: o.costMicros, latencyMs: o.latencyMs, at: new Date().toISOString() };
  return { line, message: `adult=${line.adult} conf=${line.confidence} ${usd(line.costMicros)}`, costMicros: o.costMicros, fatal: o.fatal };
}

export async function age(ctx: Ctx): Promise<void> {
  const done = new Set((await readJsonl(P.age, AgeLine)).map((l) => l.file));
  const billed = await billedJobIds();
  const pending = (await targets()).filter((f) => !done.has(outRel(f)));
  // A billed check without an age line is never bought again; it is listed for manual recovery.
  const billedNoResult = pending.filter((f) => billed.has(`age:${outRel(f)}`)).map((f) => `age:${outRel(f)}`);
  const todo = pending.filter((f) => !billed.has(`age:${outRel(f)}`));

  if (ctx.dryRun) {
    const rows = pending.map((f) => ({
      jobId: `age:${outRel(f)}`,
      model: CHAT_MODEL,
      resolution: "768px",
      quality: "-",
      refs: 1,
      aspect: "-",
      prompt: AGE_QUESTION,
      worstMicros: AGE_WORST_MICROS,
      skip: billed.has(`age:${outRel(f)}`) ? "billed_no_file" : null,
    }));
    console.log(`${done.size} image(s) already have an age result.`);
    await printPlan("age", rows, ctx);
    return;
  }

  console.log(`age: ${todo.length} image(s) to check, ${done.size} already done, ${billedNoResult.length} billed without a result`);
  let fatal: string | null = null;
  let stoppedCap = false;
  const unstarted = await runPool(
    todo,
    RENDER_CONCURRENCY,
    async (file) => {
      let r: Checked;
      try {
        r = await checkOne(file, ctx);
      } catch (err) {
        const msg = `local failure in age:${outRel(file)}: ${err instanceof Error ? err.message : String(err)}`;
        r = { line: null, message: msg, costMicros: 0, fatal: msg };
      }
      if (r.line) await appendJsonl(P.age, r.line);
      else if (r.costMicros > 0) billedNoResult.push(`age:${outRel(file)}`);
      console.log(`[age:${outRel(file)}] ${r.message}`);
      if (r.fatal && !fatal) fatal = r.fatal;
    },
    () => {
      if (ctx.budget.capHit) stoppedCap = true;
      return ctx.budget.capHit || fatal !== null;
    }
  );
  if (stoppedCap) console.log(`CAP HIT: ${usd(ctx.capMicros)} would be exceeded; ${unstarted.length} check(s) not started.`);
  console.log(`age done; ledger spent ${usd(ctx.budget.spentMicros)} of cap ${usd(ctx.capMicros)}`);
  if (billedNoResult.length) console.log(`billed_no_file (never re-requested; bodies in out/raw/): ${billedNoResult.join(", ")}`);
  if (fatal) throw new Error(`STOPPED: ${fatal}${unstarted.length ? ` (${unstarted.length} check(s) not started)` : ""}`);
}
