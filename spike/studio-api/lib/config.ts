import { join } from "node:path";

/** Everything the spike writes lives here, independent of the caller's cwd. */
export const OUT = join(import.meta.dir, "..", "out");
export const P = {
  ledger: join(OUT, "ledger.jsonl"),
  results: join(OUT, "results.jsonl"),
  age: join(OUT, "age.jsonl"),
  scenes: join(OUT, "scenes.json"),
  face: join(OUT, "face.json"),
  report: join(OUT, "report.html"),
  lock: join(OUT, ".run.lock"),
  avatar: join(OUT, "avatar"),
  refs: join(OUT, "refs"),
  render: join(OUT, "render"),
  meta: join(OUT, "meta"),
  raw: join(OUT, "raw"),
} as const;

/**
 * SPIKE_API_BASE exists only to exercise the paid path against a local mock
 * server; it is refused for anything but localhost so the key cannot be sent
 * to a third party by a typo.
 */
function apiBase(): string {
  const override = process.env.SPIKE_API_BASE;
  if (!override) return "https://openrouter.ai/api/v1";
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|$)/.test(override)) {
    throw new Error("SPIKE_API_BASE may only point at a local mock (http://127.0.0.1:<port>)");
  }
  return override.replace(/\/$/, "");
}
const BASE = apiBase();
export const API = {
  images: `${BASE}/images`,
  chat: `${BASE}/chat/completions`,
  credits: `${BASE}/credits`,
} as const;

export const TIMEOUT_MS = 180_000;
export const MAX_RETRIES = 2;
export const RENDER_CONCURRENCY = 4;
export const DEFAULT_CAP = "7.00";

export type ImageModel =
  | "x-ai/grok-imagine-image-quality"
  | "x-ai/grok-imagine-image-2.0"
  | "bytedance-seed/seedream-5-0-pro";
export type Resolution = "1K" | "2K";
export type Quality = "low" | "medium";
export type Aspect = "3:4" | "9:16";

export const CHAT_MODEL = "x-ai/grok-4.3";

/**
 * Worst-case prices in integer micro-dollars (1 USD = 1_000_000), taken from
 * /api/v1/images/models/<id>/endpoints on 2026-09-24. Every paid request
 * reserves this amount against the cap before it starts.
 */
const OUTPUT_PRICE: Record<ImageModel, (res: Resolution, q: Quality | null) => number> = {
  "x-ai/grok-imagine-image-quality": (res) => (res === "1K" ? 50_000 : 70_000),
  "x-ai/grok-imagine-image-2.0": (res, q) => {
    const medium = q === "medium";
    if (res === "1K") return medium ? 60_000 : 40_000;
    return medium ? 80_000 : 60_000;
  },
  "bytedance-seed/seedream-5-0-pro": (res) => (res === "1K" ? 45_000 : 90_000),
};
const INPUT_IMAGE_PRICE: Record<ImageModel, number> = {
  "x-ai/grok-imagine-image-quality": 10_000,
  "x-ai/grok-imagine-image-2.0": 10_000,
  "bytedance-seed/seedream-5-0-pro": 3_000,
};

export function imageWorstCaseMicros(
  model: ImageModel,
  res: Resolution,
  quality: Quality | null,
  refs: number
): number {
  return OUTPUT_PRICE[model](res, quality) + refs * INPUT_IMAGE_PRICE[model];
}

/**
 * Chat worst cases. `max_tokens` bounds the output side so the estimate is a
 * real ceiling: grok-4.3 costs $2.50/M output, so 8_000 output tokens is
 * $0.020, leaving $0.010 for ~8K input tokens (writer), and 1_000 output
 * tokens is $0.0025, leaving $0.0025 for ~2K input tokens (one 768 px image).
 */
export const WRITER_WORST_MICROS = 30_000;
export const WRITER_MAX_TOKENS = 8_000;
export const AGE_WORST_MICROS = 5_000;
export const AGE_MAX_TOKENS = 1_000;

// ---------- prompts ----------

export const DESCRIPTOR =
  "a 25-year-old woman with light olive skin, hazel eyes, light freckles across the nose, shoulder-length wavy chestnut hair and a slim athletic build";

export const CANDIDATE_PROMPT = `Head-and-shoulders portrait photo of ${DESCRIPTOR}, looking straight at the camera with a relaxed, slight smile. Soft natural daylight, plain light grey background. Natural skin texture, minimal makeup, smartphone photo, no retouching, no beauty filter.`;

export const PACK_FRONT_PROMPT =
  "The same woman as in the reference photo, with her exact face, facial proportions and hairline. Front-facing portrait, neutral expression, even soft studio light, plain white background, shoulders visible. Natural skin texture, no retouching.";

export const PACK_BODY_PROMPT =
  "The same woman as in the reference photo, with her exact face, facial proportions and hairline; slim athletic build. Full-body photo standing straight and facing the camera, wearing a plain white t-shirt, blue jeans and white sneakers, plain light grey studio background, even soft light. Natural skin texture, no retouching.";

export const AGE_QUESTION =
  "Does the person in this image clearly appear to be an adult, at least 21 years old? If there is any doubt, answer adult=false.";

// ---------- render configs ----------

export type ConfigId = "A" | "B" | "C" | "D" | "E";
export type RefName = "master" | "pack-front";

export interface RenderConfig {
  id: ConfigId;
  model: ImageModel;
  resolution: Resolution;
  quality: Quality | null;
  refs: RefName[];
  /** Slot indexes (1-based) within each category that this config renders. */
  slotIndexes: number[];
}

export const RENDER_CONFIGS: Record<ConfigId, RenderConfig> = {
  A: { id: "A", model: "x-ai/grok-imagine-image-quality", resolution: "1K", quality: null, refs: ["master"], slotIndexes: [1, 2, 3, 4, 5] },
  B: { id: "B", model: "x-ai/grok-imagine-image-2.0", resolution: "1K", quality: "low", refs: ["master"], slotIndexes: [1, 2, 3, 4, 5] },
  C: { id: "C", model: "bytedance-seed/seedream-5-0-pro", resolution: "1K", quality: null, refs: ["master"], slotIndexes: [1, 2, 3, 4, 5] },
  D: { id: "D", model: "x-ai/grok-imagine-image-quality", resolution: "1K", quality: null, refs: ["master", "pack-front"], slotIndexes: [1, 2] },
  E: { id: "E", model: "x-ai/grok-imagine-image-quality", resolution: "2K", quality: null, refs: ["master"], slotIndexes: [1] },
};
export const CONFIG_IDS: ConfigId[] = ["A", "B", "C", "D", "E"];
