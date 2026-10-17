import {
  CLIP_REASONS_RU,
  MOTION_PROBLEMS,
  MOTION_PROBLEMS_RU,
  motionCostShownMicros,
  OWN_IDEA_FALLBACK_LABEL,
  OWN_IDEA_MAX,
  OwnIdeaText,
  type ClipFrameNote,
  type ClipMotionChoice,
  type MotionProblem,
} from "../../../shared/engine";
import { NBSP, plural } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3, §6 rows 62–63c, I5.66–I5.68; mockups 62–63c, 59d, 59e and README §S5.WCD): what the sheet says about «Предложить движения» and «Своя идея…», read off the engine's
// answers alone. Every figure is the engine's (`costMicros` of a result, the live estimate of a button); nothing here adds or compares money. The refusal texts are the contract's (`MOTION_PROBLEMS_RU`), and
// the idea field checks with the contract's `OwnIdeaText`, so the window and the engine agree on every character.

// ---------- the copy (README §S5.WCD «Тексты — новые», owner veto) ----------

export const SUGGEST_LABEL = "Предложить движения";
export const SUGGESTING = "Смотрим кадр…";
export const IDEA_OPEN = "Своя идея…";
export const IDEA_FIELD = "Своя идея";
export const IDEA_PLACEHOLDER = "Опишите одно небольшое движение — например, «медленно поворачивает голову к окну»";
export const IDEA_HINT = `От 1 до ${OWN_IDEA_MAX} символов. Английский текст увидите до оплаты клипа.`;
/** SceneIdeaForm's own words for the same rule. */
export const IDEA_INVALID = "Уберите из идеи служебные символы.";
/** New (owner veto): an idea of digits, signs or emoji alone — `OwnIdeaText` wants a letter. */
export const IDEA_NO_LETTER = "Опишите движение словами.";
export const TRANSLATE_LABEL = "Перевести";
export const TRANSLATING = "Переводим…";
/** §6 63a: an own idea's row is «Своя идея: <his words>». */
export const OWN_PREFIX = "Своя идея: ";
/** §6 62b: the mark of a suggestion; 59d: the mark of an own idea in a batch row. */
export const SUGGESTED_TAG = "предложено";
export const OWN_TAG = "своя идея";
/** 59d: the batch row's list groups. */
export const GROUP_VISION = "Предложено";
export const GROUP_OWN = "Свои идеи";
/** 62d: the list of the frame reading's marks. */
export const NOTES_LABEL = "Заметки о кадре";
/** §5.3, §6 62d: the frame reading's marks — they mark, they never refuse, price or change the camera line (I5.68). */
export const FRAME_NOTES_RU = {
  "capture-differs": "Камера в кадре не такая, как в сцене",
  "second-phone": "В кадре виден второй телефон — он может остаться в клипе",
} as const satisfies Record<ClipFrameNote, string>;
/** §5.3 `motion-busy`: «Оживить» waits while a part C call runs (r2.1 N10). */
export const MOTION_BUSY = CLIP_REASONS_RU["motion-busy"];
/**
 * S5.WC5b: the sheet's OWN «Оживить» on its way holds the two part C buttons (owner veto) — ONE clip, the one this sheet sends (round 2, L-4). A clip or a batch that already runs is said by the sheet's
 * footer, and the buttons point at that line instead, so the two never disagree; the engine's own refusal after a click says `CLIP_REASONS_RU["clip-busy"]`.
 */
export const CLIP_BUSY = "Клип отправляется — предложить или перевести движение можно после него.";
/** S5.WC5b: a motion the engine no longer knows (`unknown-motion`), in a sheet that offers another: the batch row's line and sheet 38's after its click. */
export const MOTION_UNAVAILABLE = "Движение больше недоступно — выберите другое.";

/** S5.WC5b round 2 (L-3): the batch row's line once its list read again put it on another motion: what it is on now, not a request to choose. */
export function motionUnavailableNote(chosen: string): string {
  return `Движение больше недоступно — выбрано «${chosen}».`;
}

const MOTION_FORMS = ["движение", "движения", "движений"] as const;

// ---------- the money words ----------

/**
 * A call's cost in words: «бесплатно» ONLY when it cost nothing (`costMicros === 0`, a moderation 4xx); any other cost «оплачено $X», at least $0.001 (`motionCostShownMicros`), to the nearest in three
 * decimals. The outcome never decides it: a mixed paid-then-moderation `none`, and a `rejected`, carry what they cost.
 */
export function motionMoneyWord(costMicros: number): string {
  const parts = moneyParts(costMicros);
  return parts.money === null ? parts.word : `${parts.word}${parts.money}`;
}

/** The same, the figure apart (the sheet sets it in mono): «оплачено » + «$0.003», or «бесплатно» alone. */
export function moneyParts(costMicros: number): { readonly word: string; readonly money: string | null } {
  const shown = motionCostShownMicros(costMicros);
  return shown === 0 ? { word: "бесплатно", money: null } : { word: "оплачено ", money: formatUsdTiered(shown, "nearest") };
}

/** A sentence with at most one figure in it, the figure apart. `text` joins it. */
export interface MoneyLine {
  readonly before: string;
  readonly money: string | null;
  readonly after: string;
}

export const lineText = (line: MoneyLine): string => `${line.before}${line.money ?? ""}${line.after}`;

/** «<lead> — оплачено $X.» / «<lead> — бесплатно.» (the dash bound to its word, as the app's lines are). */
function withCost(lead: string, costMicros: number, period = true): MoneyLine {
  const { word, money } = moneyParts(costMicros);
  const end = period ? "." : "";
  return money === null ? { before: `${lead}${NBSP}— ${word}${end}`, money: null, after: "" } : { before: `${lead}${NBSP}— ${word}`, money, after: end };
}

/** 62b: «Предложено 3 движения — оплачено $0.003.» */
export function suggestedLine(count: number, costMicros: number): MoneyLine {
  return withCost(`Предложено ${count}${NBSP}${plural(count, MOTION_FORMS)}`, costMicros);
}

/**
 * 62c: nothing usable came out: «Не получилось предложить движения — оплачено $0.004.», or «… — бесплатно.» at 0. S5.WC5b: a free `none` is not always the model's refusal (`usage.cost: 0` gives one
 * too), so the words name no cause. `reason: "repeated"` (S5.WC3c): the model answered, and every motion was already on the sheet: «Модель повторила уже предложенные движения — оплачено $X.»
 */
export function suggestNoneLine(costMicros: number, reason?: "repeated"): MoneyLine {
  if (reason === "repeated") return withCost("Модель повторила уже предложенные движения", costMicros);
  return withCost("Не получилось предложить движения", costMicros);
}

/** 63a: «Идея переведена — оплачено $0.001.» */
export function translatedLine(costMicros: number): MoneyLine {
  return withCost("Идея переведена", costMicros);
}

/** 63b, 63c: under a refusal, what the translation cost: «За перевод оплачено $0.002.» (a rejection is normally paid; 0 says «Перевод — бесплатно.»). */
export function rejectedPaidLine(costMicros: number): MoneyLine {
  const { word, money } = moneyParts(costMicros);
  return money === null ? { before: `Перевод${NBSP}— ${word}.`, money: null, after: "" } : { before: `За перевод ${word}`, money, after: "." };
}

/** 63b #none-paid / #none-free: `translateIdea` answered `none` — the same neutral words at 0 (S5.WC5b). */
export function ideaNoneLine(costMicros: number): MoneyLine {
  return withCost("Не получилось перевести идею", costMicros);
}

// ---------- a rejected idea ----------

/**
 * The refusal of an idea: ONE text, the first problem's in the contract's display order (`MOTION_PROBLEMS`; contract `clipMotions.ts`, README §S5.WCD «Один текст на отказ», mockup 63b), in the owner's
 * wording (`MOTION_PROBLEMS_RU`). `takes-off` is no longer produced (S5.WC2c).
 */
export function rejectionText(problems: readonly MotionProblem[]): string | null {
  const first = MOTION_PROBLEMS.find((problem) => problems.includes(problem));
  return first === undefined ? null : MOTION_PROBLEMS_RU[first];
}

// ---------- the rows ----------

/** A motion's row title: an own idea is «Своя идея: <label>» (§6 63a); the others their label. */
export function motionRowLabel(motion: Pick<ClipMotionChoice, "source" | "label">): string {
  // A recovered clip whose words are gone carries the bare «Своя идея» (`OWN_IDEA_FALLBACK_LABEL`): never «Своя идея: Своя идея».
  return motion.source === "own" && motion.label !== OWN_IDEA_FALLBACK_LABEL ? `${OWN_PREFIX}${motion.label}` : motion.label;
}

/** Whether a row shows its English under the label: the scene's (as 38), and everything a model wrote — a suggestion and an own idea (I5.67: the English is seen before any video money). */
export function showsEnglish(motion: Pick<ClipMotionChoice, "source">): boolean {
  return motion.source !== "code";
}

/** 59d: the mark beside the English of a batch row's chosen motion; null for the scene and the code. */
export function batchTagOf(motion: Pick<ClipMotionChoice, "source">): string | null {
  return motion.source === "vision" ? SUGGESTED_TAG : motion.source === "own" ? OWN_TAG : null;
}

/** 62d: what is said of the frame's marks, one sentence: «Заметки о кадре: камера в кадре не такая, как в сцене; в кадре виден второй телефон — ….»; null without one. */
export function frameNotesNews(notes: readonly ClipFrameNote[]): string | null {
  if (notes.length === 0) return null;
  const lower = (text: string): string => `${text.charAt(0).toLocaleLowerCase("ru")}${text.slice(1)}`;
  return `${NOTES_LABEL}: ${notes.map((note) => lower(FRAME_NOTES_RU[note])).join("; ")}.`;
}

/** Round 2 (L1): the chosen row left the list read again (only the newest suggestions and ideas are listed) — said, and what is chosen now. */
export function motionGoneNews(gone: string, chosen: string): string {
  return `Движение «${gone}» больше не в списке${NBSP}— выбрано «${chosen}».`;
}

// ---------- the idea field ----------

/** Why «Перевести» waits for the text in the field: empty (no word said), no letter, or a control or format character. */
export type IdeaFault = "blank" | "no-letter" | "service";

/**
 * The idea as the window would send it, or why it would not: the contract's `OwnIdeaText` decides (1–300 characters, at least one letter, no control or format character — a ZWJ emoji included — no
 * line or paragraph separator, no broken surrogate). The text is sent trimmed; an empty field and white space alone are `blank`.
 */
export function checkIdea(text: string): { readonly ok: true; readonly idea: string } | { readonly ok: false; readonly fault: IdeaFault } {
  // The field's text as it stands is what the rule reads (a tab at its edge is refused too); a text that passes stays a pass without its edge spaces.
  if (OwnIdeaText.safeParse(text).success) return { ok: true, idea: text.trim() };
  // The engine's rule said no: say the cause the owner can act on — a character to remove first, else nothing typed yet, else the missing letter.
  if (SERVICE.test(text)) return { ok: false, fault: "service" };
  return { ok: false, fault: text.trim() === "" ? "blank" : "no-letter" };
}

/** The characters `OwnIdeaText` refuses (its own class), to name the cause; validity itself is the contract's verdict. */
const SERVICE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** The line under the field for a fault; a blank field says nothing (the button waits, described by the hint). */
export function ideaFaultText(fault: IdeaFault): string | null {
  return fault === "service" ? IDEA_INVALID : fault === "no-letter" ? IDEA_NO_LETTER : null;
}

/** Enter and pasted line breaks become spaces: the contract refuses a newline, and the window replaces it before it sends. */
export function flattenLines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** The longest prefix of whole code points within `room` UTF-16 units: a cut never leaves half a surrogate pair. */
function cutToRoom(text: string, room: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > room) break;
    out += char;
  }
  return out;
}

/**
 * `inserted` typed or pasted over the selection [start, end) of `value`: its line breaks made spaces, cut to what the limit leaves (as a browser cuts a paste at `maxLength`), and the caret after it.
 */
export function insertIdeaText(value: string, start: number, end: number, inserted: string, max = OWN_IDEA_MAX): { readonly value: string; readonly caret: number } {
  const head = value.slice(0, start);
  const tail = value.slice(end);
  const room = Math.max(0, max - head.length - tail.length);
  const piece = cutToRoom(flattenLines(inserted), room);
  return { value: `${head}${piece}${tail}`, caret: head.length + piece.length };
}

/** S5.WC5b (59d): the same for a batch row, which names its photo: «Фото 3 · Дом: движение «…» больше не в списке — выбрано «…».» */
export function batchMotionGoneNews(photo: string, gone: string, chosen: string): string {
  return `${photo}: движение «${gone}» больше не в списке${NBSP}— выбрано «${chosen}».`;
}
