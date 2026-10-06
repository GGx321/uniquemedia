import type { ImageModelEntry, ImageQuality } from "../../shared/engine";
import { formatUsd } from "./money";

/** The Settings «Фото» card's words for the engine's image-model catalogue: labels and prices, pure. */

export const QUALITY_LABEL_RU: Record<ImageQuality, string> = { low: "Низкое", medium: "Среднее" };

/**
 * The price of one photo (a reference image included) at `quality`, in micro-dollars. A model with one price (no quality knob)
 * gives it whatever is asked; a quality the model does not list gives the dearest, never an underestimate.
 */
export function photoPriceMicros(entry: ImageModelEntry, quality: ImageQuality | null): number {
  const exact = entry.prices.find((p) => p.quality === quality)?.micros;
  if (exact !== undefined) return exact;
  const single = entry.prices.length === 1 ? entry.prices[0]?.micros : undefined;
  if (single !== undefined) return single;
  return entry.prices.reduce((max, p) => Math.max(max, p.micros), 0);
}

/** «Модель · $0.048», «от $…» for two qualities, and «не проверена» for a model outside the 2026-09-24 spike. */
export function modelOptionLabel(entry: ImageModelEntry): string {
  const micros = entry.prices.map((p) => p.micros);
  const cheapest = Math.min(...micros);
  const price = entry.prices.length > 1 ? `от ${formatUsd(cheapest, 3)}` : formatUsd(cheapest, 3);
  return entry.tested ? `${entry.name} · ${price}` : `${entry.name} · ${price} · не проверена`;
}

/** «Низкое · $0.050». */
export function qualityOptionLabel(entry: ImageModelEntry, quality: ImageQuality): string {
  return `${QUALITY_LABEL_RU[quality]} · ${formatUsd(photoPriceMicros(entry, quality), 3)}`;
}
