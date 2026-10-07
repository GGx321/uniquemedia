import { z } from "zod";
import { Micros, ModelId } from "./primitives";

// The image-model catalogue the Settings «Фото» select shows, and the one rule
// that decides whether a choice of model and quality may be saved. Pure: the
// engine builds the catalogue (engine/imageModels), main validates a
// `settings.setModels` against it, the mock serves a fixed one, and all three
// call `checkImageChoice`, so a refusal reads the same everywhere.

/** The quality knob of a model that has one (today only grok-imagine-image-2.0); a model without one is stored as `null`. */
export const ImageQuality = z.enum(["low", "medium"]);
export type ImageQuality = z.infer<typeof ImageQuality>;

/**
 * One selectable image model. `qualities` is empty for a model with no quality
 * knob: its price list then holds one entry with `quality: null`. `micros` is
 * the worst-case price of one photo in micro-dollars with one reference image
 * (a scene photo's master portrait), 1K, the same figure the run's estimate is
 * built from. `tested` is true for the models of the 2026-09-24 spike (their
 * prices are also in the engine's dated fallback table): the face reference is
 * only judged good for those.
 */
export const ImageModelEntry = z
  .strictObject({
    id: ModelId,
    name: z.string().min(1).max(120),
    qualities: z.array(ImageQuality).max(ImageQuality.options.length),
    prices: z.array(z.strictObject({ quality: ImageQuality.nullable(), micros: Micros })).min(1).max(ImageQuality.options.length),
    tested: z.boolean(),
  })
  .superRefine((entry, ctx) => {
    if (new Set(entry.qualities).size !== entry.qualities.length) ctx.addIssue({ code: "custom", message: "a quality must not repeat", path: ["qualities"] });
    const expected = entry.qualities.length === 0 ? [null] : entry.qualities;
    const priced = entry.prices.map((p) => p.quality);
    const same = priced.length === expected.length && expected.every((q) => priced.includes(q)) && new Set(priced).size === priced.length;
    if (!same) ctx.addIssue({ code: "custom", message: "prices must name each listed quality once, or null alone for a model with no quality knob", path: ["prices"] });
  });
export type ImageModelEntry = z.infer<typeof ImageModelEntry>;

/** A live catalogue is read again after this long (the engine's cache and a Settings card left open both use it). */
export const LIVE_CATALOGUE_TTL_MS = 30 * 60_000;
/** A bundled or partial catalogue retries the live read sooner: the outage may be over. */
export const FALLBACK_CATALOGUE_TTL_MS = 60_000;

/**
 * `live` when the list came from OpenRouter just now (within the engine's refresh time), `fallback` when it is the bundled list. `complete` is true when
 * every candidate of a live list was priced: a live list with a model left out by a transient failure is not complete, and is read again soon.
 */
export const ImageModelCatalogue = z
  .strictObject({
    models: z.array(ImageModelEntry).max(100),
    source: z.enum(["live", "fallback"]),
    complete: z.boolean(),
  })
  .superRefine((catalogue, ctx) => {
    if (new Set(catalogue.models.map((m) => m.id)).size !== catalogue.models.length) ctx.addIssue({ code: "custom", message: "a model must not repeat", path: ["models"] });
  });
export type ImageModelCatalogue = z.infer<typeof ImageModelCatalogue>;

/** How long a catalogue is served before it is read again: the long time only for a live list that is complete, the short one otherwise. */
export function catalogueTtlMs(catalogue: { readonly source: "live" | "fallback"; readonly complete: boolean }): number {
  return catalogue.source === "live" && catalogue.complete ? LIVE_CATALOGUE_TTL_MS : FALLBACK_CATALOGUE_TTL_MS;
}

/** Said when the model is not in the catalogue. The renderer shows it as is; the engine's own detail would be English. */
export const UNKNOWN_IMAGE_MODEL_RU = "Этой модели нет в списке доступных для фото. Обновите Настройки и выберите модель из списка.";
/** Said when the quality is not one the model lists (or a model with no quality knob was given one). */
export const UNSUPPORTED_IMAGE_QUALITY_RU = "Эта модель не поддерживает выбранное качество. Выберите качество из списка модели.";

export type ImageChoiceResult = { ok: true; imageQuality: ImageQuality | null } | { ok: false; detail: string };

/**
 * Whether `request` (a `settings.setModels`) may be saved, and the quality to
 * store. The model must be in the catalogue; the one exception is the model
 * already set, which stays saveable (a text-model-only change by an older
 * caller, or a catalogue that cannot list it right now) with its current
 * quality. A quality must be one the model lists; a model with no quality
 * knob stores `null`. No quality sent keeps the current one when the model
 * lists it, else `low` when it does, else the model's first.
 */
export function checkImageChoice(
  catalogue: { readonly models: readonly ImageModelEntry[] },
  current: { imageModel: string; imageQuality: ImageQuality | null },
  request: { imageModel: string; imageQuality?: ImageQuality | null },
): ImageChoiceResult {
  const entry = catalogue.models.find((m) => m.id === request.imageModel);
  if (entry === undefined) {
    const unchanged = request.imageModel === current.imageModel && (request.imageQuality === undefined || request.imageQuality === current.imageQuality);
    return unchanged ? { ok: true, imageQuality: current.imageQuality } : { ok: false, detail: UNKNOWN_IMAGE_MODEL_RU };
  }
  if (entry.qualities.length === 0) {
    return request.imageQuality === undefined || request.imageQuality === null ? { ok: true, imageQuality: null } : { ok: false, detail: UNSUPPORTED_IMAGE_QUALITY_RU };
  }
  if (request.imageQuality === undefined) {
    const kept = current.imageQuality !== null && entry.qualities.includes(current.imageQuality) ? current.imageQuality : null;
    const fallback = entry.qualities.includes("low") ? "low" : entry.qualities[0];
    return { ok: true, imageQuality: kept ?? fallback ?? null };
  }
  if (request.imageQuality === null || !entry.qualities.includes(request.imageQuality)) return { ok: false, detail: UNSUPPORTED_IMAGE_QUALITY_RU };
  return { ok: true, imageQuality: request.imageQuality };
}
