import type { Montage, MontageDraft } from "../../../shared/engine";
import { estimateBytes, FPS, FRAME_H, FRAME_W } from "../../../shared/montage";
import { countOf, NBSP } from "../../lib/format";
import type { SaveState } from "./autosave";

// The words the drafts screen and the editor header show, as the EditorEmpty, Editor and EditorNew artboards set
// them. Lengths and sizes are written with a dot and one decimal («9.6 с», «≈ 4.2 МБ»), in mono, as drawn.

/** A draft's own name, or «без названия» until the owner names it (K1: a new draft is stored with `name: null`). */
export function draftName(name: string | null): string {
  return name ?? "без названия";
}

/** «Mia · «кафе и город»», «Elena · без названия»; the name alone when the avatar is not listed. */
export function draftTitle(avatarName: string | null, name: string | null): string {
  if (avatarName === null) return name === null ? "Без названия" : `«${name}»`;
  return name === null ? `${avatarName} · без названия` : `${avatarName} · «${name}»`;
}

const totalMs = (spec: MontageDraft): number => spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);

/** «9.6 с»: seconds with one decimal. */
export function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)}${NBSP}с`;
}

const CLIP_FORMS = ["кадр", "кадра", "кадров"] as const;
const TEXT_FORMS = ["текст", "текста", "текстов"] as const;

/** A draft card's summary: «9.6 с · 4 кадра · 3 текста», «… · без текста», or «нет кадров». */
export function draftMeta(spec: MontageDraft): string {
  if (spec.clips.length === 0) return "нет кадров";
  const texts = spec.layers.filter((layer) => layer.kind === "text").length;
  return `${secondsLabel(totalMs(spec))} · ${countOf(spec.clips.length, CLIP_FORMS)} · ${texts === 0 ? "без текста" : countOf(texts, TEXT_FORMS)}`;
}

/** «≈ 4.2 МБ»: the expected size in decimal megabytes, as `estimateBytes` gives it. */
export function sizeLabel(bytes: number): string {
  return `≈${NBSP}${(bytes / 1_000_000).toFixed(1)}${NBSP}МБ`;
}

/**
 * The output line in two parts: the format, the same for every draft (a narrow window hides it first), and the
 * draft's own length and expected size (never hidden).
 */
export function outputParts(spec: MontageDraft): { format: string; length: string } {
  const format = `${FRAME_W}×${FRAME_H} · ${FPS}${NBSP}fps`;
  if (spec.clips.length === 0) return { format, length: `0${NBSP}с` };
  return { format, length: `${secondsLabel(totalMs(spec))} · ${sizeLabel(estimateBytes(spec.clips))}` };
}

/** The editor header's output line: «1080×1920 · 30 fps · 9.6 с · ≈ 4.2 МБ», or «… · 0 с» for an empty draft. */
export function outputLabel(spec: MontageDraft): string {
  const { format, length } = outputParts(spec);
  return `${format} · ${length}`;
}

/** The timeline's clock: «00:04.1». */
export function clockLabel(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(whole / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  const tenths = Math.floor((whole % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

const MONTHS = ["янв.", "февр.", "марта", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."] as const;

interface DayParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The calendar day of `date` on the owner's clock (or `timeZone`'s). */
function dayOf(date: Date, timeZone: string | undefined): DayParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const pick = (type: "year" | "month" | "day"): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

const dayNumber = (d: DayParts): number => Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;

/** «14:02» on the owner's clock. */
export function timeOfDay(iso: string, timeZone?: string): string {
  // h23, not `hour12: false`: some engines then print midnight as «24:05».
  return new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** When a draft last changed: «сегодня, 14:02», «вчера, 21:40», «26 сент., 09:15», «31 дек. 2025, 23:59». */
export function whenLabel(iso: string, now: Date, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = dayOf(date, timeZone);
  const today = dayOf(now, timeZone);
  const time = timeOfDay(iso, timeZone);
  const ago = dayNumber(today) - dayNumber(day);
  if (ago === 0) return `сегодня, ${time}`;
  if (ago === 1) return `вчера, ${time}`;
  const dayMonth = `${day.day}${NBSP}${MONTHS[day.month - 1] ?? ""}`;
  return day.year === today.year ? `${dayMonth}, ${time}` : `${dayMonth} ${day.year}, ${time}`;
}

/**
 * The line under the draft's name: «черновик · сохранён 14:02» (the engine's last answer), «черновик · создан
 * только что» (opened right after `montages.create` and not edited since), «черновик · сохраняется…», «черновик ·
 * не сохранён» (a retry sits next to it), «черновик удалён».
 */
export function saveLabel(save: SaveState, saved: Montage, options: { fresh: boolean; timeZone?: string }): string {
  switch (save.kind) {
    case "pending":
    case "saving":
      return "черновик · сохраняется…";
    case "failed":
      return "черновик · не сохранён";
    case "gone":
      return "черновик удалён";
    case "saved":
      return options.fresh ? "черновик · создан только что" : `черновик · сохранён ${timeOfDay(saved.updatedAt, options.timeZone)}`;
  }
}
