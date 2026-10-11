import {
  ERROR_MESSAGES_RU,
  NO_ANSWER_DETAIL_PREFIX,
  PORTRAIT_CANDIDATES_MAX,
  PORTRAIT_MIN_LIKENESS,
  PORTRAITS_PER_BATCH,
  type EngineError,
  type FailedPortraitSlot,
} from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { afterColon, countOf } from "../../lib/format";
import type { IconName } from "../../ui/Icon";

// S5.3d: what the reference portrait says, apart from the components that draw it (.omc/stage5/design 14–23): the tiles of a finished batch's slots
// that gave no portrait, the lines over the grid, what a pick and a reset say for the master they would replace, and the limit. No money is computed
// here: every price on the card and the panel is the engine's `avatars.estimatePortraits`, formatted where it is drawn.

/** The master the variants would replace (design review H1): the imported photo, or a portrait picked earlier. */
export type MasterKind = "source" | "portrait";

export const PORTRAIT_TEXT = {
  /** Review M7: why a clean portrait, in one name for the photo everywhere — «исходное фото» (M5). */
  why: "Если на исходном фото есть телефон, зеркало или комната, они попадают в сцены. Мастер-портрет — чистый портрет её лица, нарисованный с этого фото.",
  /** Review M6: the paid start, on the card and wherever it is offered. */
  start: "Получить 5 вариантов",
  /** Review M6: the free pick. */
  pick: "Сделать мастером",
  /** Controller decision 5: the way back to the imported photo. */
  revert: "Сделать мастером снова",
  revertAsk: "Портрет удалится. Вернуть исходное фото мастером?",
  held: "Варианты можно сделать, когда закончатся съёмка и другие задачи этого аватара",
  /** Review L2: a pick the avatar's other work holds, and a pick refused IN_FLIGHT. */
  pickHeld: "Выбрать можно, когда закончатся съёмка и другие задачи этого аватара.",
  /** The reset and the way back claim the avatar as the pick does: the same wait, in their own words. */
  discardHeld: "Удалить варианты можно, когда закончатся съёмка и другие задачи этого аватара.",
  revertHeld: "Вернуть исходное фото можно, когда закончатся съёмка и другие задачи этого аватара.",
  /** Review M4: the start never ran, or was refused before anything was paid. */
  notStarted: "Варианты не запускались — ничего не потрачено.",
  /** Review M5: §3's own words, not MASTER_FACE_UNUSABLE's «главное фото» and its advice to make a new avatar. */
  noFace: "На исходном фото не найдено лицо — варианты не с чем сравнить. Ничего не потрачено.",
  /** Review L3. */
  priceUnknown: "цена недоступна, попробуйте позже",
  discardHint: "Варианты удалятся.",
  /** Review L6, M8: «используют его», and the §2.7 hint about a stopped run resumed after the switch. */
  saved: "Мастер-портрет сохранён. Новые фото и автопилот используют его; уже снятые фото не меняются. Остановленная съёмка продолжится уже с мастер-портретом.",
  running: "Описание и тело можно менять и сейчас: варианты рисуются по тексту, взятому в начале.",
  /** S5.3c `masterMissing`: the master's own file is gone while the imported photo is alive; the one way out is the imported photo. */
  masterMissing: "Файл мастер-портрета не найден. Верните исходное фото мастером или получите новые варианты.",
  cancelledSaved: "Готовые варианты сохранены.",
} as const;

/** Design decision 4 (H1): what the pick says under it, by the master it would replace. */
export const PICK_HINT: Record<MasterKind, string> = {
  source: "Бесплатно. Остальные варианты удалятся, исходное фото останется.",
  portrait: "Если выберете вариант, текущий мастер-портрет и остальные варианты удалятся.",
};

/** The reset (`avatars.discardPortraits`): what it keeps. */
export const RESET_LABEL: Record<MasterKind, string> = { source: "Оставить исходное фото", portrait: "Оставить текущий мастер-портрет" };

/** Review M3: the reset deletes every waiting variant, so it asks inline first. */
export const DISCARD_ASK: Record<MasterKind, string> = {
  source: "Все варианты удалятся, мастером останется исходное фото.",
  portrait: "Все варианты удалятся, мастером останется текущий мастер-портрет.",
};

export const VARIANT_FORMS = ["вариант", "варианта", "вариантов"] as const;

/** A likeness as the gallery's «лицо 0.76» says one: two decimals, never rounded into another figure. */
export function likenessText(likeness: number): string {
  return likeness.toFixed(2);
}

/** «порог 0.55»: the face gate's fixed threshold, the same figure the engine stores and picks by. */
export const THRESHOLD_TEXT = likenessText(PORTRAIT_MIN_LIKENESS);

/**
 * What a failed slot cost is the engine's word, carried by the slot (`FailedPortraitSlot.charge`, settled from the ledger outcome of its image and its age check for the
 * mode the batch was started in): `free`, `paid`, or `worst-until-reconcile` (a reserve left open, counted at its worst case until a reconcile). The window shows it and
 * guesses nothing: the age-check setting can change while a batch runs, and the code alone does not say which request failed.
 */
type FailedSlot = Extract<FailedPortraitSlot, { reason: "failed" }>;

function failedOnly(failedSlots: readonly FailedPortraitSlot[]): FailedSlot[] {
  return failedSlots.filter((f): f is FailedSlot => f.reason === "failed");
}

/** A slot of a finished batch that gave no portrait: never selectable, and it says why (design decision 3). */
export interface GoneTile {
  readonly key: string;
  /** `failed`: a dashed tile (nothing was drawn, or it could not finish); `dropped`: a dark one (drawn and paid, then dropped, never stored). */
  readonly look: "failed" | "dropped";
  readonly icon: IconName;
  readonly tone: "muted" | "warn-text" | "danger-text";
  readonly title: string;
  readonly sub: string | null;
}

const PAID = "стоимость учтена";

/** The finished batch's slots without a portrait, in slot order, each with its own words (16, 16b, 16e, 17). */
export function goneTiles(failedSlots: readonly FailedPortraitSlot[]): GoneTile[] {
  return [...failedSlots]
    .sort((a, b) => a.slot - b.slot)
    .map((f): GoneTile => {
      const key = `gone-${f.slot}`;
      switch (f.reason) {
        case "unlike":
          return { key, look: "dropped", icon: "face", tone: "warn-text", title: `Не похожа · ${likenessText(f.likeness)}`, sub: PAID };
        case "no-face":
          return { key, look: "dropped", icon: "face", tone: "muted", title: "Лицо не найдено", sub: PAID };
        case "multiple-faces":
          return { key, look: "dropped", icon: "people", tone: "muted", title: "Несколько лиц", sub: PAID };
        case "age-rejected":
          return { key, look: "dropped", icon: "eyeOff", tone: "muted", title: "Скрыт проверкой возраста", sub: PAID };
        case "failed":
          if (f.charge !== "free") return { key, look: "failed", icon: "alert", tone: "danger-text", title: "Не получилось · стоимость учтена", sub: null };
          return f.error.code === "MODERATION_REFUSED"
            ? { key, look: "failed", icon: "close", tone: "muted", title: "Модель отказалась · бесплатно", sub: null }
            : { key, look: "failed", icon: "alert", tone: "muted", title: "Не получилось · бесплатно", sub: null };
      }
    });
}

const FAILED_FORMS = ["вариант не удалось получить", "варианта не удалось получить", "вариантов не удалось получить"] as const;
const WORST_UNTIL_RECONCILE = "До сверки попытка считается по худшей цене.";

/** «N вариантов не удалось получить: <their shared reason>» — the app's text for the code when they agree. */
function failureHead(slots: readonly FailedSlot[]): string {
  const codes = new Set(slots.map((f) => f.error.code));
  const [only] = codes;
  const reason = codes.size === 1 && only !== undefined ? ERROR_MESSAGES_RU[only] : "Причины разные — подробности в журнале.";
  return `${countOf(slots.length, FAILED_FORMS)}: ${afterColon(reason)}`;
}

/**
 * 16e: the failures that may have cost (`worst-until-reconcile` and `paid`) in one line, their shared reason when they agree — «2 варианта не удалось получить: OpenRouter
 * не ответил вовремя. До сверки попытка считается по худшей цене. Стоимость попытки учтена.» A reserve left open says the worst-price rule when the
 * code's own text does not. What cost nothing is not counted (its tile says «бесплатно»); null when nothing failed at a cost.
 */
export function paidFailureLine(failedSlots: readonly FailedPortraitSlot[]): string | null {
  const counted = failedOnly(failedSlots).filter((f) => f.charge !== "free");
  if (counted.length === 0) return null;
  const head = failureHead(counted);
  const worst = counted.some((f) => f.charge === "worst-until-reconcile") && !head.includes("худшей цене") ? ` ${WORST_UNTIL_RECONCILE}` : "";
  return `${head}${worst} Стоимость попытки учтена.`;
}

/** The free failures other than a model's refusal (whose tile says it all): why, and that they cost nothing; null when there are none. */
export function freeFailureLine(failedSlots: readonly FailedPortraitSlot[]): string | null {
  const free = failedOnly(failedSlots).filter((f) => f.charge === "free" && f.error.code !== "MODERATION_REFUSED");
  return free.length === 0 ? null : `${failureHead(free)} Эти попытки ничего не стоили.`;
}

/** 16b: the slots the age check dropped, agreed in number — «1 вариант отклонён … и не показан. Его стоимость учтена.» (the README's mismatch, fixed). */
export function ageRejectedLine(count: number): string | null {
  if (count === 0) return null;
  const one = count % 10 === 1 && count % 100 !== 11;
  return one
    ? `${countOf(count, VARIANT_FORMS)} отклонён проверкой возраста и не показан. Его стоимость учтена.`
    : `${countOf(count, ["вариант", "варианта", "вариантов"])} отклонены проверкой возраста и не показаны. Их стоимость учтена.`;
}

/** 17: a batch that ended with no portrait to offer, every paid image below the gate. */
export const NONE_PASSED = `Ни один вариант не похож на исходное фото (порог ${THRESHOLD_TEXT}). Платные попытки учтены.`;

/** 17, any other end with no portrait to offer (a mix of verdicts, a failure, an age-check drop): the gate's threshold is not to blame, so it is not named. */
export const NONE_NEUTRAL = "Подходящих вариантов нет.";

/** The line over a finished batch that gave nothing to pick: the threshold only when every slot's verdict is «не похожа», the neutral one otherwise. */
export function noneCameLine(failedSlots: readonly FailedPortraitSlot[]): string {
  return failedSlots.length > 0 && failedSlots.every((f) => f.reason === "unlike") ? NONE_PASSED : NONE_NEUTRAL;
}

/** Whether another batch fits under the limit: the engine refuses one that would take the waiting variants past 15 (`too-many-candidates`). */
export function batchFits(pending: number): boolean {
  return pending + PORTRAITS_PER_BATCH <= PORTRAIT_CANDIDATES_MAX;
}

/**
 * Controller decision 6 (16c): why «Ещё 5 вариантов» is not offered. At 15 the mockup's words; from 11 on, a batch of five would already pass the limit,
 * and the line says how many wait.
 */
export function capReason(pending: number): string {
  if (pending >= PORTRAIT_CANDIDATES_MAX) return "Уже 15 вариантов — выберите один или удалите все.";
  return `Уже ${countOf(pending, VARIANT_FORMS)} — ещё ${PORTRAITS_PER_BATCH} превысят предел в ${PORTRAIT_CANDIDATES_MAX}. Выберите один или удалите все.`;
}

/** The radio's name: its letter, its likeness, and «лучший» for the best (a screen reader hears what the badges show). */
export function variantLabel(letter: string, likeness: number | undefined, best: boolean): string {
  const parts = [`Вариант ${letter}`];
  if (likeness !== undefined) parts.push(`сходство ${likenessText(likeness)}`);
  if (best) parts.push("лучший");
  return parts.join(" · ");
}

/**
 * An answer that never came (main's deadline, `main/engineHost.ts`): no refusal at all — the engine may have started the batch, as
 * `renderJobs.ts` `classifyAnswer` reads the same answer of a render. Its job, if there is one, shows up by its own events.
 */
export function answerLost(error: EngineError): boolean {
  return error.code === "INTERNAL" && error.detail?.startsWith(NO_ANSWER_DETAIL_PREFIX) === true;
}

/**
 * What a start that did not go says (18b): the app's text for the code and, unless that text says so already, that nothing was started or paid. An
 * answer that never came says only the app's «Команда могла выполниться…»: the batch may be drawing, and its money is the engine's to tell.
 */
export function startRefusalText(error: EngineError): string {
  const text = errorText(error);
  if (answerLost(error) || /ничего не потрачено\.?$/i.test(text)) return text;
  return `${text} ${PORTRAIT_TEXT.notStarted}`;
}
