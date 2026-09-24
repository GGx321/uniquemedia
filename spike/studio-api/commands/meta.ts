import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { exiftool } from "exiftool-vendored";
import { z } from "zod";
import { CONFIG_IDS, P } from "../lib/config";
import { findExisting, listImages, outRel, writeAtomic } from "../lib/files";
import { runFfmpeg } from "../lib/image";
import type { Ctx } from "../lib/jobs";

const RawTags = z.record(z.string(), z.unknown());
const READ_ARGS = ["-G1", "-a", "-u"];
const SKIP_KEYS = new Set(["SourceFile", "System:Directory", "System:FileName"]);
const MARKERS = /c2pa|jumbf|xmp|digitalsourcetype|trainedalgorithmicmedia|grok|xai|bytedance|seedream|generated/i;
// "AI" as a word or a camel-case prefix ("AIGenerated", "x.ai"), not inside "Detail" or "MAIN".
const AI_WORD = [/(?<![A-Za-z])AI(?![a-z])/, /(?<![a-z])ai(?![a-z])/i];

interface Target {
  name: string;
  file: string;
}

async function defaultTargets(): Promise<Target[]> {
  const out: Target[] = [];
  const master = findExisting(join(P.avatar, "master"));
  if (master) out.push({ name: "master", file: master });
  for (const id of CONFIG_IDS) {
    const [first] = await listImages(join(P.render, id));
    if (first) out.push({ name: `${id}-${basename(first, extname(first))}`, file: first });
  }
  return out;
}

async function dump(file: string, jsonPath: string): Promise<Record<string, unknown>> {
  const tags = RawTags.parse(await exiftool.readRaw(file, { readArgs: READ_ARGS }));
  await writeAtomic(jsonPath, `${JSON.stringify(tags, null, 2)}\n`);
  return tags;
}

function flagged(tags: Record<string, unknown>): string[] {
  const hits: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    if (SKIP_KEYS.has(key)) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const hay = `${key} ${text}`;
    if (MARKERS.test(hay) || AI_WORD.some((re) => re.test(hay))) hits.push(`${key} = ${text.slice(0, 160)}`);
  }
  return hits;
}

function report(label: string, tags: Record<string, unknown>): void {
  const hits = flagged(tags);
  console.log(`\n${label}: ${Object.keys(tags).length} tags, ${hits.length} flagged`);
  for (const h of hits) console.log(`  ! ${h}`);
}

/**
 * Free and local. Dumps exiftool metadata of master plus one ok render per
 * config (or the --file images), renders each into a 3 s MP4 with metadata
 * stripped, dumps that too, and prints tags that hint at AI provenance.
 */
export async function meta(ctx: Ctx, files: string[]): Promise<void> {
  const targets = files.length
    ? files.map((f) => ({ name: basename(f, extname(f)), file: resolve(f) }))
    : await defaultTargets();
  if (!targets.length) throw new Error("meta: no images found (need out/avatar/master.* or renders, or pass --file <path>)");
  for (const t of targets) if (!existsSync(t.file)) throw new Error(`meta: file not found: ${t.file}`);

  if (ctx.dryRun) {
    console.log("=== DRY RUN: meta (free, local) — nothing written ===");
    for (const t of targets) console.log(`${t.name}: ${t.file} -> out/meta/${t.name}.json, out/meta/${t.name}.mp4(.json)`);
    return;
  }

  try {
    for (const t of targets) {
      const imgTags = await dump(t.file, join(P.meta, `${t.name}.json`));
      report(`${t.name} (image)`, imgTags);

      const mp4 = join(P.meta, `${t.name}.mp4`);
      const tmp = join(P.meta, `.${t.name}.${process.pid}.tmp.mp4`);
      await runFfmpeg([
        "-y",
        "-loop", "1",
        "-t", "3",
        "-i", t.file,
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-map_metadata", "-1",
        tmp,
      ]);
      await rename(tmp, mp4);
      const mp4Tags = await dump(mp4, join(P.meta, `${t.name}.mp4.json`));
      report(`${t.name} (mp4 ${outRel(mp4)})`, mp4Tags);
    }
  } finally {
    await exiftool.end();
  }
}
