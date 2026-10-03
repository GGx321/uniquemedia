import type { Clip, Montage, MontageDraft } from "../../../shared/engine";
import { estimateBytes, FPS, FRAME_H, FRAME_W, FRAMES_PER_STEP, staggerStepFrames } from "../../../shared/montage";
import { countOf, NBSP } from "../../lib/format";
import type { RenderControl } from "../../engine/renderJobs";
import type { SaveState } from "./autosave";
import type { AddRefusal } from "./clipOps";
import type { PhotoProblem } from "./renderBlock";
import type { ActionBlock } from "./selection";

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

// ---------- the timeline (3d.3a) ----------

/** «2.4–5.6 с»: a range on the timeline. */
export function rangeLabel(startMs: number, endMs: number): string {
  return `${(startMs / 1000).toFixed(1)}–${(endMs / 1000).toFixed(1)}${NBSP}с`;
}

const LAYOUT_NAMES = { photo: "1 фото", collage2: "коллаж 2", collage3: "коллаж 3", collage4: "коллаж 4" } as const;

/** «1 фото», «коллаж 3», «видео»: what a clip is, as the properties header and the clip's name say it. */
export function clipKindLabel(clip: Clip): string {
  return clip.kind === "video" ? "видео" : clip.kind === "collage" ? LAYOUT_NAMES[clip.layout] : LAYOUT_NAMES.photo;
}

/** The tag on a clip block whose photo the engine refused, as the components sheet writes it. */
export const PHOTO_PROBLEM_TAGS: Record<PhotoProblem, string> = {
  rejected: "⚠ фото отклонено",
  used: "⚠ фото уже в видео",
  reserved: "⚠ фото в рендере",
  unavailable: "⚠ фото недоступно",
};

/** A clip block's accessible name: «Кадр 2: коллаж 3, 3.2 с», «Кадр 1: фото отклонено, 2.4 с». */
export function clipAria(index: number, clip: Clip, problem: PhotoProblem | null): string {
  const what = problem === null ? clipKindLabel(clip) : PHOTO_PROBLEM_TAGS[problem].replace(/^⚠\s*/, "");
  return `Кадр ${index + 1}: ${what}, ${secondsLabel(clip.durationMs)}`;
}

/** Why a toolbar action is off, in its tooltip. */
export function actionWhyLabel(why: ActionBlock): string {
  switch (why) {
    case "nothing-selected":
      return "Сначала выберите кадр на таймлайне";
    case "photo-split":
      return "Фото и коллаж не режутся: одно фото — один раз в ролике";
    case "playhead-outside":
      return "Поставьте плейхед внутрь выбранного";
    case "too-short":
      return "Слишком близко к краю: части выйдут короче минимума";
    case "clip-cap":
      return "Не больше 20 кадров в одном видео";
    case "no-room":
      return "До 15 с осталось меньше 0.5 с — укоротите кадр";
    case "layer-cap":
      return "Не больше 10 слоёв одного вида";
    case "music":
      return "Трек в ролике один — его можно только убрать";
  }
}

/** The bin's line when a click on a photo cannot add a clip (the components sheet's caps state). */
export function addBlockedLabel(why: AddRefusal): string {
  return why === "clip-cap"
    ? "Не больше 20 кадров в одном видео. Клик по фото в панели ничего не добавит."
    : "Ролик почти 15 с: на новый кадр нет и 0.5 с. Укоротите кадр, чтобы добавить фото.";
}

/** «0.3 с»: a collage's stagger step (`staggerStepFrames`), with two decimals when it is not a whole 100 ms. */
export function staggerStepLabel(durationMs: number, cellCount: number): string {
  const frames = staggerStepFrames(durationMs, cellCount);
  const seconds = frames / FPS;
  // Three frames are exactly 100 ms; anything else is a third of a step and needs the second decimal.
  return `${frames % FRAMES_PER_STEP === 0 ? seconds.toFixed(1) : seconds.toFixed(2)}${NBSP}с`;
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

/** The render button's label while a render is on its way (3d.6): «Рендер…», «В очереди · после 2», «Рендер · 42 %», «Сохранение…». */
export function renderButtonLabel(control: Extract<RenderControl, { kind: "submitting" | "queued" | "running" | "saving" }>): string {
  switch (control.kind) {
    case "submitting":
      return "Рендер…";
    case "queued":
      if (control.cancelling) return "Отменяем…";
      return control.after === 0 ? "В очереди" : `В очереди · после ${control.after}`;
    case "running":
      return control.cancelling ? "Отменяем…" : `Рендер · ${control.percent}${NBSP}%`;
    case "saving":
      return "Сохранение…";
  }
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
