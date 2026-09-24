/**
 * Face similarity in pure JS/WASM: a port of spike/studio-api/face.py (OpenCV YuNet + SFace)
 * to onnxruntime-web, with ffmpeg-static as the only decoder.
 *
 * For every image under spike/studio-api/out/render/** and out/avatar/*: face count, largest
 * face height / image height, SFace cosine vs avatar/master and avatar/pack-front. Writes
 * spike/face-js/out/face-js.json and a parity report against spike/studio-api/out/face.json
 * (spike/face-js/out/parity.json).
 *
 * Run from the repo root:
 *   bun run spike/face-js/run.ts [--threads N] [--decoder bgr24|libjpeg] [--output path]
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron spike/face-js/run.ts --output spike/face-js/out/face-js.electron.json
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import * as ort from "onnxruntime-web";
import { type BgrImage, type Decoder, decodeBgr } from "./lib/decode.ts";
import { type JsEntry, parityDigest, parityReport, readPyResults, round } from "./lib/parity.ts";
import { alignCrop, cosine, createRecognizer, feature } from "./lib/sface.ts";
import { createDetector, type Detector, detect } from "./lib/yunet.ts";

const ROOT = process.cwd();
const STUDIO_OUT = join(ROOT, "spike/studio-api/out");
const MODELS = join(STUDIO_OUT, "models");
const OUT = join(ROOT, "spike/face-js/out");
const FFMPEG = join(ROOT, "node_modules/ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// Same values as face.py: FaceDetectorYN.create(..., 0.7, 0.3, 5000).
const DETECTOR_OPTIONS = { scoreThreshold: 0.7, nmsThreshold: 0.3, topK: 5000 };

interface Timing {
  decode: number;
  detect: number;
  embed: number;
}

interface Entry extends JsEntry {
  width: number;
  height: number;
  score: number | null;
  ms: Timing;
}

function runtimeLabel(): string {
  const v = process.versions;
  if (v.bun) return `bun ${v.bun}`;
  if (v.electron) return `electron ${v.electron} ${"parentPort" in process ? "utilityProcess" : "as node"} (node ${v.node})`;
  return `node ${v.node}`;
}

async function listImages(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith(".") && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(tmp, text);
  await rename(tmp, path);
}

function largest(faces: Float32Array[]): Float32Array | null {
  let best: Float32Array | null = null;
  for (const f of faces) if (!best || f[2] * f[3] > best[2] * best[3]) best = f;
  return best;
}

interface Analysis {
  img: BgrImage;
  count: number;
  face: Float32Array | null;
  feature: Float32Array | null;
  ms: Timing;
}

async function analyse(detector: Detector, recognizer: ort.InferenceSession, decoder: Decoder, path: string): Promise<Analysis> {
  const t0 = performance.now();
  const img = await decodeBgr(FFMPEG, path, decoder);
  const t1 = performance.now();
  const faces = await detect(detector, img);
  const face = largest(faces);
  const t2 = performance.now();
  const feat = face ? await feature(recognizer, alignCrop(img, face)) : null;
  const t3 = performance.now();
  return { img, count: faces.length, face, feature: feat, ms: { decode: t1 - t0, detect: t2 - t1, embed: t3 - t2 } };
}

function stats(values: number[]): { n: number; median: number; mean: number; p95: number; max: number } {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.round((s.length - 1) * q))];
  return {
    n: s.length,
    median: round(at(0.5), 1),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length, 1),
    p95: round(at(0.95), 1),
    max: round(s[s.length - 1], 1),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      threads: { type: "string" },
      decoder: { type: "string", default: "bgr24" },
      output: { type: "string", default: join(OUT, "face-js.json") },
    },
  });
  if (values.threads !== undefined) {
    if (!/^[1-9]\d?$/.test(values.threads)) throw new Error(`--threads must be 1..99, got "${values.threads}"`);
    ort.env.wasm.numThreads = Number(values.threads);
  }
  const decoder = values.decoder;
  if (decoder !== "bgr24" && decoder !== "libjpeg") throw new Error(`--decoder must be bgr24 or libjpeg, got "${decoder}"`);
  ort.env.logLevel = "error";
  if (!existsSync(FFMPEG)) throw new Error(`ffmpeg not found at ${FFMPEG}`);

  const sessionOptions: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], logSeverityLevel: 3 };
  const tLoad0 = performance.now();
  const [yunetBytes, sfaceBytes] = await Promise.all([
    readFile(join(MODELS, "face_detection_yunet_2023mar.onnx")),
    readFile(join(MODELS, "face_recognition_sface_2021dec.onnx")),
  ]);
  const detector = await createDetector(new Uint8Array(yunetBytes), DETECTOR_OPTIONS, sessionOptions);
  const recognizer = await createRecognizer(new Uint8Array(sfaceBytes), sessionOptions);
  const modelLoadMs = performance.now() - tLoad0;
  const threads = ort.env.wasm.numThreads;
  console.error(`${runtimeLabel()}, onnxruntime-web ${ort.env.versions.web}, wasm threads ${threads}, decoder ${decoder}; models loaded in ${modelLoadMs.toFixed(0)} ms`);

  // References first, like face.py; their timings include the first-inference warm-up.
  const refs: Record<"cosMaster" | "cosFront", Float32Array | null> = { cosMaster: null, cosFront: null };
  const warmup: Record<string, Timing> = {};
  for (const [label, name] of [["cosMaster", "master"], ["cosFront", "pack-front"]] as const) {
    const path = [".png", ".jpg", ".jpeg", ".webp"].map((e) => join(STUDIO_OUT, "avatar", name + e)).find((p) => existsSync(p));
    if (!path) continue;
    const a = await analyse(detector, recognizer, decoder, path);
    refs[label] = a.feature;
    warmup[name] = a.ms;
    console.error(`reference ${name}: ${a.feature ? "face found" : "no face"}`);
  }

  const targets = [...(await listImages(join(STUDIO_OUT, "render"))), ...(await listImages(join(STUDIO_OUT, "avatar")))];
  const images: Record<string, Entry> = {};
  for (const path of targets) {
    const a = await analyse(detector, recognizer, decoder, path);
    const cos = (ref: Float32Array | null) => (a.feature && ref ? round(cosine(a.feature, ref), 6) : null);
    const key = relative(STUDIO_OUT, path).split("\\").join("/");
    images[key] = {
      faces: a.count,
      headRatio: a.face ? round(a.face[3] / a.img.height, 4) : null,
      width: a.img.width,
      height: a.img.height,
      cosMaster: cos(refs.cosMaster),
      cosFront: cos(refs.cosFront),
      score: a.face ? round(a.face[14], 4) : null,
      ms: { decode: round(a.ms.decode, 1), detect: round(a.ms.detect, 1), embed: round(a.ms.embed, 1) },
    };
    const e = images[key];
    console.log(`${key}: faces=${e.faces} head=${e.headRatio} cosMaster=${e.cosMaster} cosFront=${e.cosFront} detect=${e.ms.detect}ms embed=${e.ms.embed}ms`);
  }

  const bySize: Record<string, ReturnType<typeof stats> & { detect: number; embed: number; decode: number }> = {};
  const groups = new Map<string, Entry[]>();
  for (const e of Object.values(images)) {
    const k = `${e.width}x${e.height}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [k, es] of groups) {
    const withFace = es.filter((e) => e.faces > 0);
    bySize[k] = {
      ...stats(withFace.map((e) => e.ms.detect + e.ms.embed)),
      detect: stats(es.map((e) => e.ms.detect)).median,
      embed: stats(withFace.map((e) => e.ms.embed)).median,
      decode: stats(es.map((e) => e.ms.decode)).median,
    };
  }

  const meta = {
    runtime: runtimeLabel(),
    platform: `${process.platform}-${process.arch}`,
    onnxruntimeWeb: ort.env.versions.web,
    wasmThreads: threads,
    decoder,
    modelLoadMs: round(modelLoadMs, 1),
    warmup,
    /** detect + embed per image (ms), grouped by image size; detect/embed/decode are medians. */
    timingBySize: bySize,
  };
  await writeAtomic(values.output, `${JSON.stringify({ meta, images }, null, 2)}\n`);
  console.error(`wrote ${relative(ROOT, values.output)} (${Object.keys(images).length} images)`);
  console.error(JSON.stringify(meta.timingBySize));

  const pyPath = join(STUDIO_OUT, "face.json");
  if (!existsSync(pyPath)) {
    console.error("no spike/studio-api/out/face.json; parity skipped");
    return;
  }
  const report = parityReport(await readPyResults(pyPath), images);
  const reportPath = join(dirname(values.output), basename(values.output).replace(/^face-js/, "parity"));
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`wrote ${relative(ROOT, reportPath)}`);
  console.error(JSON.stringify(parityDigest(report)));
}

await main();
// With wasm threads > 1 onnxruntime-web keeps its pthread workers alive, and inside an
// Electron utilityProcess they hold the process open after the work is done.
process.exit(0);
