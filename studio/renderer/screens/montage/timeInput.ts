import type { MontageDraft } from "../../../shared/engine";
import { NBSP } from "../../lib/format";
import { type LayerEdge, type LayerRefusal, trimLayer } from "./layerOps";

// 3d.5: «Время 0.3 — 4.4 с» (EditorText / EditorGif; R32, R37): a text's or a sticker's start and end, typed in seconds. Each is
// the timeline's own trim (`trimLayer`: the 100 ms grid, at least 0.3 s, never further past the montage's end), so a typed time and
// a dragged handle can never disagree. A refused time leaves the draft as it was; the field says why.

/** Why a typed time was not taken: not a number at all, or what the trim refuses. */
export type TimeRefusal = "not-a-number" | Extract<LayerRefusal, "too-short" | "outside-montage">;

export type TimeEdit = { readonly ok: true; readonly spec: MontageDraft } | { readonly ok: false; readonly reason: TimeRefusal };

/** Seconds with a dot or a comma and nothing else (spaces around allowed). */
const SECONDS = /^\d+(?:[.,]\d+)?$/;

/** Typed seconds as ms on the 100 ms grid (the nearest step), or null when it is no time at all. */
export function parseSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (!SECONDS.test(trimmed)) return null;
  const seconds = Number(trimmed.replace(",", "."));
  return Number.isFinite(seconds) ? Math.round(seconds * 10) * 100 : null;
}

/** Layer `index`'s `edge` at the typed time; the same draft when it is there already. */
export function setLayerTime(spec: MontageDraft, index: number, edge: LayerEdge, text: string): TimeEdit {
  const ms = parseSeconds(text);
  if (ms === null) return { ok: false, reason: "not-a-number" };
  const edit = trimLayer(spec, index, edge, ms);
  if (edit.ok) return { ok: true, spec: edit.spec };
  return { ok: false, reason: edit.reason === "too-short" ? "too-short" : "outside-montage" };
}

/** What the field says under a refused time. */
export function timeRefusalLabel(reason: TimeRefusal, totalMs: number): string {
  switch (reason) {
    case "not-a-number":
      return "Введите секунды, например 4.4";
    case "too-short":
      return `Слой не может быть короче 0.3${NBSP}с`;
    case "outside-montage":
      return `Слой должен закончиться до конца ролика, ${(totalMs / 1000).toFixed(1)}${NBSP}с`;
  }
}
