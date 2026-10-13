import { DEFAULT_COSTS_USD } from "./mockOpenRouter";

// 5a.3 (S5.9f, plan s5a3 §12): what the packaged smoke (smoke-engine.ts, CI only) asserts of the image requests a «Смелая» run sends, as pure functions. The smoke needs Electron; these do not, so
// boldSmoke.test.ts holds them against the bodies the engine's own client builds.

/** The model of the «Смелая» route: Seedream 5 Pro at 2K (also the 1K moderation fallback's id, which the smoke's run never reaches). */
export const BOLD_MODEL = "bytedance-seed/seedream-5-0-pro";

/** An image request as the mock OpenRouter recorded it: the model and the resolution it names, and the body as parsed. */
export interface SentImageRequest {
  model: string | null;
  resolution: string | null;
  body: Record<string, unknown>;
}

function referencesOf(body: Record<string, unknown>): number {
  const references = body.input_references;
  return Array.isArray(references) ? references.length : 0;
}

/** What is wrong with a request for a Seedream slot: it must name Seedream at 2K, 9:16, carry exactly the master as its one reference, and no quality knob. Empty when nothing is. */
export function boldRequestProblems(request: SentImageRequest): string[] {
  const problems: string[] = [];
  if (request.model !== BOLD_MODEL) problems.push(`model is ${String(request.model)}, not ${BOLD_MODEL}`);
  if (request.resolution !== "2K") problems.push(`resolution is ${String(request.resolution)}, not 2K`);
  if (request.body.aspect_ratio !== "9:16") problems.push(`aspect_ratio is ${String(request.body.aspect_ratio)}, not 9:16`);
  const references = referencesOf(request.body);
  if (references !== 1) problems.push(`input_references holds ${references}, not exactly one`);
  if ("quality" in request.body) problems.push(`quality is sent (${String(request.body.quality)}); the Seedream route has no quality knob`);
  return problems;
}

/** What is wrong with a request for a slot on the owner's model in the same run: it must not name Seedream, and it stays at 1K, 9:16, as it always was. Empty when nothing is. */
export function ownerRequestProblems(request: SentImageRequest): string[] {
  const problems: string[] = [];
  if (request.model === BOLD_MODEL) problems.push(`model is ${BOLD_MODEL}: a slot on the owner's model went to the Seedream route`);
  if (request.resolution !== "1K") problems.push(`resolution is ${String(request.resolution)}, not 1K`);
  if (request.body.aspect_ratio !== "9:16") problems.push(`aspect_ratio is ${String(request.body.aspect_ratio)}, not 9:16`);
  return problems;
}

/** The scene reasons of the slots a run's `job.done` says ended without a photo, in slot order; empty when it names none. */
export function failedReasonsOf(end: unknown): string[] {
  if (typeof end !== "object" || end === null) return [];
  const payload: unknown = Reflect.get(end, "payload");
  const result: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "result") : undefined;
  const reasons: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "failedReasons") : undefined;
  if (!Array.isArray(reasons)) return [];
  return reasons
    .flatMap((entry): { slotIndex: number; reason: string }[] => {
      const slotIndex: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "slotIndex") : undefined;
      const reason: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "reason") : undefined;
      return typeof slotIndex === "number" && typeof reason === "string" ? [{ slotIndex, reason }] : [];
    })
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((entry) => entry.reason);
}

/**
 * What the mock OpenRouter bills for these image requests, in whole micro-dollars: a 2K image $0.045 (the Seedream bill P-5a3 measured), any other $0.04; `refused` of them were refused and are
 * free. An answer with no image is billed like a drawn one, so it needs no term of its own. The smoke compares this with what /credits grew by.
 */
export function expectedBilledMicros(sent: readonly SentImageRequest[], refused: number): number {
  const bold = Math.round(DEFAULT_COSTS_USD.boldImage * 1_000_000);
  const plain = Math.round(DEFAULT_COSTS_USD.image * 1_000_000);
  const bill = sent.reduce((sum, request) => sum + (request.resolution === "2K" ? bold : plain), 0);
  // The refusals are Seedream's: each takes one 2K request off the bill.
  return bill - refused * bold;
}
