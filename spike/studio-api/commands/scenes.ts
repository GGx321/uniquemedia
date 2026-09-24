import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { API, CHAT_MODEL, P, WRITER_MAX_TOKENS, WRITER_WORST_MICROS } from "../lib/config";
import { outRel, writeAtomic } from "../lib/files";
import { printPlan, type Ctx } from "../lib/jobs";
import { readLedger, usd } from "../lib/money";
import { ChatResponse, paidRequest, rawPath } from "../lib/openrouter";
import {
  PLANNER_SEED,
  WRITER_RESPONSE_FORMAT,
  WRITER_SYSTEM_PROMPT,
  WriterOutput,
  assemblePrompt,
  fakeWriterOutput,
  planSlots,
  validateScenes,
  writerUserMessage,
  type ScenesFile,
  type Slot,
} from "../lib/scenes";

const JOB_ID = "scenes:writer";

function assembleAll(slots: Slot[], output: WriterOutput): Record<string, string> {
  const bySlot = validateScenes(slots, output);
  const prompts: Record<string, string> = {};
  for (const slot of slots) {
    const scene = bySlot.get(slot.slotId);
    if (!scene) throw new Error(`No scene for ${slot.slotId}`);
    prompts[slot.slotId] = assemblePrompt(slot, scene);
  }
  return prompts;
}

function printSlots(slots: Slot[]): void {
  for (const s of slots) {
    console.log(
      `${s.slotId.padEnd(13)} ${s.shot.padEnd(12)} spice=${s.spice ?? "-"}  ${s.timeOfDay.padEnd(11)} | ${s.location} | ${s.outfit} | ${s.activity}`
    );
  }
}

async function hasRenders(): Promise<boolean> {
  if (!existsSync(P.render)) return false;
  return (await readdir(P.render, { recursive: true, withFileTypes: true })).some((d) => d.isFile());
}

/**
 * The writer's job id. The first purchase is "scenes:writer"; once the ledger
 * holds a billed writer call, another one is bought only with --force and gets
 * the next id ("scenes:writer#2", ...), so a paid-but-rejected output is never
 * silently bought again.
 */
async function writerJobId(force: boolean): Promise<string> {
  const previous = (await readLedger()).filter((l) => l.jobId === JOB_ID || l.jobId.startsWith(`${JOB_ID}#`)).length;
  if (previous > 0 && !force) {
    throw new Error(
      `The writer was already billed ${previous} time(s); its bodies are in out/raw/. Pass --force to buy another writer call.`
    );
  }
  return previous === 0 ? JOB_ID : `${JOB_ID}#${previous + 1}`;
}

/**
 * Plans the 25 slots, asks the writer for scene fields in one call, validates
 * them, assembles the prompts and writes scenes.json. An existing scenes.json
 * is never overwritten without --force, and never while renders exist (they
 * were made from it). --fake-writer skips the LLM entirely and marks the file
 * fake, which `render` refuses outside a dry run.
 */
export async function scenes(ctx: Ctx, opts: { force: boolean; fakeWriter: boolean }): Promise<void> {
  if (existsSync(P.scenes) && !opts.force) {
    throw new Error(`${outRel(P.scenes)} already exists; refusing to regenerate it (use --force to replace it).`);
  }
  if (!ctx.dryRun && (await hasRenders())) {
    throw new Error(`out/render/ already holds renders made from the current scenes.json; move them away before regenerating it.`);
  }
  const slots = planSlots();
  const user = writerUserMessage(slots);

  if (opts.fakeWriter) {
    const writerOutput = fakeWriterOutput(slots);
    const prompts = assembleAll(slots, writerOutput);
    if (ctx.dryRun) {
      printSlots(slots);
      console.log(`\n--fake-writer --dry-run: ${Object.keys(prompts).length} prompts assembled, nothing written. Example:\n${prompts[slots[0].slotId]}`);
      return;
    }
    const file: ScenesFile = {
      version: 1,
      fake: true,
      createdAt: new Date().toISOString(),
      seed: PLANNER_SEED,
      slots,
      writerOutput,
      prompts,
      writer: { model: "fake-writer", jobId: "scenes:fake-writer", costMicros: 0, estimated: false, latencyMs: null, finishReason: null },
    };
    await writeAtomic(P.scenes, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`Wrote FAKE ${outRel(P.scenes)} (no LLM call). render refuses it outside --dry-run.`);
    return;
  }

  const jobId = await writerJobId(opts.force);
  if (ctx.dryRun) {
    printSlots(slots);
    await printPlan(
      "scenes (writer)",
      [{ jobId, model: CHAT_MODEL, resolution: "-", quality: "-", refs: 0, aspect: "-", prompt: user, worstMicros: WRITER_WORST_MICROS, skip: null }],
      ctx
    );
    return;
  }

  const body = {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: WRITER_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    temperature: 0.8,
    reasoning: { effort: "low" },
    response_format: WRITER_RESPONSE_FORMAT,
    max_tokens: WRITER_MAX_TOKENS,
    usage: { include: true },
  };
  const o = await paidRequest({
    jobId,
    model: CHAT_MODEL,
    url: API.chat,
    body,
    worstCaseMicros: WRITER_WORST_MICROS,
    budget: ctx.budget,
    schema: ChatResponse,
    saveRaw: "always",
  });
  if (o.status !== "ok") {
    throw new Error(o.fatal ?? `Writer call ${o.status}${o.httpStatus ? ` (HTTP ${o.httpStatus})` : ""}: ${o.errorMessage}`);
  }
  const raw = outRel(rawPath(jobId));
  const choice = o.data.choices[0];
  const content = choice.message.content;
  if (!content) throw new Error(`Writer returned no content (finish_reason ${choice.finish_reason ?? "none"}); raw body in ${raw}`);
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error(`Writer content is not JSON (finish_reason ${choice.finish_reason ?? "none"}); raw body in ${raw}`);
  }
  const parsed = WriterOutput.safeParse(json);
  if (!parsed.success) throw new Error(`Writer JSON does not match the schema (raw body in ${raw}): ${z.prettifyError(parsed.error).slice(0, 400)}`);
  let prompts: Record<string, string>;
  try {
    prompts = assembleAll(slots, parsed.data);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)} (nothing written; raw body in ${raw})`);
  }

  const file: ScenesFile = {
    version: 1,
    fake: false,
    createdAt: new Date().toISOString(),
    seed: PLANNER_SEED,
    slots,
    writerOutput: parsed.data,
    prompts,
    writer: {
      model: CHAT_MODEL,
      jobId,
      costMicros: o.costMicros,
      estimated: o.estimated,
      latencyMs: o.latencyMs,
      finishReason: choice.finish_reason ?? null,
    },
  };
  await writeAtomic(P.scenes, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Wrote ${outRel(P.scenes)}: ${slots.length} slots, writer ${jobId} ${usd(o.costMicros)}${o.estimated ? " (estimated)" : ""}, ${o.latencyMs} ms`);
  if (o.fatal) throw new Error(`STOPPED: ${o.fatal}`);
}
