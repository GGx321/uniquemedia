import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_IDS, P, RENDER_CONFIGS, type ConfigId, type RefName } from "../lib/config";
import { findExisting, outRel, readJson } from "../lib/files";
import { runImageJobs, type Ctx, type ImageJob } from "../lib/jobs";
import { ScenesFile, bindReferences } from "../lib/scenes";

export function parseConfigs(arg: string | undefined): ConfigId[] {
  if (!arg) throw new Error("render needs --config <A|B|C|D|E|all>");
  if (arg.trim().toLowerCase() === "all") return CONFIG_IDS;
  // Case-insensitive and de-duplicated: "A,a" must not queue the same jobs twice.
  const ids = new Set(arg.split(",").map((s) => s.trim().toUpperCase()));
  const out: ConfigId[] = [];
  for (const id of ids) {
    const match = CONFIG_IDS.find((c) => c === id);
    if (!match) throw new Error(`Unknown config "${id}" (expected A, B, C, D, E or all)`);
    out.push(match);
  }
  return out;
}

/** Reference image on disk; in a dry run a missing one is reported, not fatal. */
function refPath(name: RefName, dryRun: boolean): string {
  const found = findExisting(join(P.avatar, name));
  if (found) return found;
  if (!dryRun) throw new Error(`Reference out/avatar/${name}.* is missing; run candidates/pack first.`);
  console.log(`(dry run) note: out/avatar/${name}.* does not exist yet`);
  return join(P.avatar, `${name}.png`);
}

export async function render(ctx: Ctx, configArg: string | undefined, limit: number | undefined): Promise<void> {
  const configs = parseConfigs(configArg);
  if (!existsSync(P.scenes)) throw new Error(`${outRel(P.scenes)} is missing; run \`scenes\` first.`);
  const plan = await readJson(P.scenes, ScenesFile);
  if (plan.fake && !ctx.dryRun) {
    throw new Error(`${outRel(P.scenes)} was made by --fake-writer; delete it and run \`scenes\` for real before rendering.`);
  }

  const needed = new Set(configs.flatMap((c) => RENDER_CONFIGS[c].refs));
  const found = new Map<RefName, string>();
  for (const name of needed) found.set(name, refPath(name, ctx.dryRun));
  const refs = (names: RefName[]): string[] =>
    names.map((n) => {
      const p = found.get(n);
      if (!p) throw new Error(`Reference ${n} was not resolved`);
      return p;
    });

  const jobs: ImageJob[] = [];
  for (const id of configs) {
    const cfg = RENDER_CONFIGS[id];
    for (const slot of plan.slots) {
      if (!cfg.slotIndexes.includes(slot.index)) continue;
      const prompt = plan.prompts[slot.slotId];
      if (!prompt) throw new Error(`scenes.json has no prompt for ${slot.slotId}`);
      jobs.push({
        jobId: `${id}:${slot.slotId}`,
        model: cfg.model,
        resolution: cfg.resolution,
        quality: cfg.quality,
        aspect: "9:16",
        prompt: bindReferences(prompt, cfg.refs.length),
        refPaths: refs(cfg.refs),
        refNames: cfg.refs,
        outBase: join(P.render, id, slot.slotId),
        config: id,
        slotId: slot.slotId,
        category: slot.category,
        spice: slot.spice,
        shot: slot.shot,
      });
    }
  }
  const title = `render ${configs.join(",")}${limit !== undefined ? ` --limit ${limit}` : ""}${plan.fake ? " (FAKE scenes.json)" : ""}`;
  await runImageJobs(title, jobs, ctx, { limitPerConfig: limit });
}
