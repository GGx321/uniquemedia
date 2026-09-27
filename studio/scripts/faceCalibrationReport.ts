/**
 * One-off calibration report (plan T7b, "Calibration"): real SFace
 * embeddings (this port, via createFaceGate) for the spike's full image set,
 * used to evaluate the "gallery" strategy's real numbers — face.json only
 * ever recorded cosine-to-master, never the pairwise cosines between renders
 * a gallery strategy needs. fixed-threshold and best-of-N need no
 * embeddings at all (calibration.test.ts already pins their numbers against
 * fixtures/spikeCosMaster.ts's real cosMaster values); this script is only
 * for the gallery number, and to re-run the whole comparison if the spike's
 * image set is ever refreshed.
 *
 * Not part of `bun test`: it reads the spike's own (git-ignored, throwaway)
 * output directory, which is never present in CI and not meant to be. Run
 * by hand, from the repo root, after the studio-api and face-js spikes:
 *   bun studio/scripts/faceCalibrationReport.ts --spike-dir spike/studio-api/out
 */
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { aggregateSimilarity, evaluateBestOfN, evaluateFixedThreshold } from "../engine/face/calibration";
import { cosine } from "../engine/face/sface";
import { createFaceGate } from "../engine/face/gate";
import type { FaceGateImage } from "../engine/face/gate";
import { decodeImagesWithElectron } from "../engine/face/testing/decodeWithElectron";
import { ensureFaceModels } from "./faceModelCache";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function listImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith(".") && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Leave-one-out max/mean cosine of `index` against every OTHER embedding in `pool`, plus the master. */
function galleryScore(target: Float32Array, pool: readonly Float32Array[], excludeIndex: number, master: Float32Array, aggregate: "max" | "mean"): number {
  const scores = [cosine(target, master)];
  for (let i = 0; i < pool.length; i++) {
    if (i === excludeIndex) continue;
    const other = pool[i];
    if (other) scores.push(cosine(target, other));
  }
  return aggregateSimilarity(scores, aggregate);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { "spike-dir": { type: "string" } } });
  const spikeDir = values["spike-dir"];
  if (!spikeDir) throw new Error("usage: faceCalibrationReport.ts --spike-dir <spike/studio-api/out>");

  const root = join(import.meta.dir, "..", "..");
  const modelPaths = await ensureFaceModels(root);
  const models = { yunet: await Bun.file(modelPaths.yunet).bytes(), sface: await Bun.file(modelPaths.sface).bytes() };

  const renderPaths = await listImages(join(spikeDir, "render"));
  const impostorPaths = [1, 2, 3].map((n) => join(spikeDir, "avatar", `candidate-${n}.jpg`));
  const masterPath = join(spikeDir, "avatar", "master.jpg");

  console.log(`decoding ${renderPaths.length} true renders + ${impostorPaths.length} impostors + master...`);
  const [masterImage, ...rest] = await decodeImagesWithElectron([masterPath, ...renderPaths, ...impostorPaths]);
  if (!masterImage) throw new Error("failed to decode the master image");
  const trueImages = rest.slice(0, renderPaths.length);
  const impostorImages = rest.slice(renderPaths.length);

  const gate = await createFaceGate(models);
  try {
    const masterEmbedding = await gate.embed(masterImage);
    const embed = async (images: readonly FaceGateImage[]) => {
      const out: Float32Array[] = [];
      for (const image of images) out.push(await gate.embed(image));
      return out;
    };
    const trueEmbeddings = await embed(trueImages);
    const impostorEmbeddings = await embed(impostorImages);

    const trueCosMaster = trueEmbeddings.map((e) => cosine(e, masterEmbedding));
    const impostorCosMaster = impostorEmbeddings.map((e) => cosine(e, masterEmbedding));

    console.log("\n--- fixed-threshold (cosine to master only) ---");
    for (const threshold of [0.55, 0.6, 0.66, 0.7]) {
      const r = evaluateFixedThreshold(trueCosMaster, impostorCosMaster, threshold);
      console.log(`threshold ${threshold}: true ${r.truePositives}/${trueCosMaster.length}, impostors passing ${r.falsePositives}/${impostorCosMaster.length}`);
    }

    console.log("\n--- keep-best-of-N (cosine to master only, consecutive non-overlapping groups) ---");
    for (const n of [2, 3]) {
      for (const threshold of [0.66, 0.7]) {
        const r = evaluateBestOfN(trueCosMaster, n, threshold);
        console.log(`n=${n}, threshold ${threshold}: best-of-group passes in ${(r.passRate * 100).toFixed(1)}% of ${r.groups} groups`);
      }
    }

    console.log("\n--- gallery (leave-one-out max/mean against master + every other true render) ---");
    for (const aggregate of ["max", "mean"] as const) {
      const trueGallery = trueEmbeddings.map((e, i) => galleryScore(e, trueEmbeddings, i, masterEmbedding, aggregate));
      const impostorGallery = impostorEmbeddings.map((e) => galleryScore(e, trueEmbeddings, -1, masterEmbedding, aggregate));
      for (const threshold of [0.66, 0.7]) {
        const r = evaluateFixedThreshold(trueGallery, impostorGallery, threshold);
        console.log(
          `${aggregate}, threshold ${threshold}: true ${r.truePositives}/${trueGallery.length}, impostors passing ${r.falsePositives}/${impostorGallery.length}` +
            ` (impostor gallery scores: ${impostorGallery.map((s) => s.toFixed(4)).join(", ")})`,
        );
      }
    }
  } finally {
    await gate.dispose();
  }
}

await main();
