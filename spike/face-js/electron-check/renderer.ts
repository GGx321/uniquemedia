/**
 * Renderer half of the Electron check: the same YuNet + SFace port, with Chromium decoding
 * the images (createImageBitmap -> OffscreenCanvas -> getImageData) instead of ffmpeg.
 * Bundled by `bun build` (see main.mjs) and driven from the main process.
 */
import * as ort from "onnxruntime-web";
import type { BgrImage } from "../lib/decode.ts";
import { alignCrop, cosine, createRecognizer, feature } from "../lib/sface.ts";
import { createDetector, detect } from "../lib/yunet.ts";

interface RunOptions {
  keys: string[];
  threads: number;
}

interface Timing {
  decode: number;
  detect: number;
  embed: number;
}

interface Entry {
  faces: number;
  headRatio: number | null;
  width: number;
  height: number;
  cosMaster: number | null;
  cosFront: number | null;
  score: number | null;
  ms: Timing;
}

declare global {
  interface Window {
    runFaceJs: (opts: RunOptions) => Promise<{ meta: Record<string, unknown>; images: Record<string, Entry> }>;
  }
}

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d;

async function decodeChromium(url: string): Promise<BgrImage> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const n = bmp.width * bmp.height;
  const data = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = rgba[i * 4 + 2];
    data[i * 3 + 1] = rgba[i * 4 + 1];
    data[i * 3 + 2] = rgba[i * 4];
  }
  const img = { width: bmp.width, height: bmp.height, data };
  bmp.close();
  return img;
}

window.runFaceJs = async ({ keys, threads }) => {
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = new URL("/node_modules/onnxruntime-web/dist/", location.href).href;
  ort.env.logLevel = "error";
  const sessionOptions: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], logSeverityLevel: 3 };
  const models = "/spike/studio-api/out/models/";
  const bytes = async (name: string) => new Uint8Array(await (await fetch(models + name)).arrayBuffer());

  const t0 = performance.now();
  const detector = await createDetector(await bytes("face_detection_yunet_2023mar.onnx"), { scoreThreshold: 0.7, nmsThreshold: 0.3, topK: 5000 }, sessionOptions);
  const recognizer = await createRecognizer(await bytes("face_recognition_sface_2021dec.onnx"), sessionOptions);
  const modelLoadMs = performance.now() - t0;

  const analyse = async (key: string) => {
    const a = performance.now();
    const img = await decodeChromium(`/spike/studio-api/out/${key}`);
    const b = performance.now();
    const faces = await detect(detector, img);
    let face: Float32Array | null = null;
    for (const f of faces) if (!face || f[2] * f[3] > face[2] * face[3]) face = f;
    const c = performance.now();
    const feat = face ? await feature(recognizer, alignCrop(img, face)) : null;
    const d = performance.now();
    return { img, count: faces.length, face, feat, ms: { decode: b - a, detect: c - b, embed: d - c } };
  };

  const master = await analyse("avatar/master.jpg");
  const front = await analyse("avatar/pack-front.jpg");
  const images: Record<string, Entry> = {};
  for (const key of keys) {
    const r = await analyse(key);
    const cos = (ref: Float32Array | null) => (r.feat && ref ? round(cosine(r.feat, ref), 6) : null);
    images[key] = {
      faces: r.count,
      headRatio: r.face ? round(r.face[3] / r.img.height, 4) : null,
      width: r.img.width,
      height: r.img.height,
      cosMaster: cos(master.feat),
      cosFront: cos(front.feat),
      score: r.face ? round(r.face[14], 4) : null,
      ms: { decode: round(r.ms.decode, 1), detect: round(r.ms.detect, 1), embed: round(r.ms.embed, 1) },
    };
  }
  return {
    meta: {
      runtime: `electron renderer (${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "chrome"})`,
      crossOriginIsolated,
      wasmThreads: ort.env.wasm.numThreads,
      modelLoadMs: round(modelLoadMs, 1),
      warmup: { master: master.ms, "pack-front": front.ms },
    },
    images,
  };
};
