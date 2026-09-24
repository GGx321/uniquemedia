import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CANDIDATE_PROMPT, P, PACK_BODY_PROMPT, PACK_FRONT_PROMPT } from "../lib/config";
import { findExisting, outRel, writeAtomic } from "../lib/files";
import { extFor, sniffMediaType } from "../lib/image";
import { runImageJobs, type Ctx, type ImageJob } from "../lib/jobs";

const avatarBase = (name: string) => join(P.avatar, name);

function avatarJob(name: string, prompt: string, aspect: ImageJob["aspect"], refPaths: string[]): ImageJob {
  return {
    jobId: `avatar:${name}`,
    model: "x-ai/grok-imagine-image-quality",
    resolution: "1K",
    quality: null,
    aspect,
    prompt,
    refPaths,
    refNames: refPaths.length ? ["master"] : [],
    outBase: avatarBase(name),
    config: "avatar",
    slotId: name,
    category: null,
    spice: null,
    shot: null,
  };
}

export async function candidates(ctx: Ctx): Promise<void> {
  const jobs = [1, 2, 3, 4].map((i) => avatarJob(`candidate-${i}`, CANDIDATE_PROMPT, "3:4", []));
  await runImageJobs("candidates", jobs, ctx);
}

/**
 * Copies the chosen image to avatar/master.<ext>, then renders the pack from
 * it. A master that already exists with different bytes is never replaced:
 * the pack (and every render) was made from it.
 */
export async function pack(ctx: Ctx, masterArg: string | undefined): Promise<void> {
  if (!masterArg) throw new Error("pack needs --master <path>");
  const src = resolve(masterArg);
  if (!existsSync(src)) throw new Error(`--master file not found: ${masterArg}`);
  const bytes = await readFile(src);
  const type = sniffMediaType(bytes);
  if (!type) throw new Error(`--master is not a PNG, JPEG or WebP image: ${masterArg}`);
  const dest = `${avatarBase("master")}.${extFor(type)}`;

  const current = findExisting(avatarBase("master"));
  if (current) {
    const same = Buffer.compare(await readFile(current), bytes) === 0;
    if (!same) {
      throw new Error(
        `${outRel(current)} already holds a different image. Delete out/avatar/master.* and out/avatar/pack-*.* to pick again.`
      );
    }
  }

  if (ctx.dryRun) {
    console.log(current ? `master: ${outRel(current)} already matches ${masterArg}` : `master: would copy ${masterArg} -> ${outRel(dest)}`);
  } else if (!current) {
    await writeAtomic(dest, bytes);
    console.log(`master: copied ${masterArg} -> ${outRel(dest)}`);
  }

  const masterPath = current ?? dest;
  const jobs = [
    avatarJob("pack-front", PACK_FRONT_PROMPT, "3:4", [masterPath]),
    avatarJob("pack-body", PACK_BODY_PROMPT, "9:16", [masterPath]),
  ];
  await runImageJobs("pack", jobs, ctx);
}
