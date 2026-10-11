import { ERROR_MESSAGES_RU, PORTRAIT_CANDIDATES_MAX, PORTRAIT_MIN_LIKENESS, PORTRAITS_PER_BATCH, type EngineError, type FailedPortraitSlot } from "../../../shared/engine";
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
  masterMissing: "Файл мастер-портрета не найден. Верните исходное фото мастером — новые варианты можно сделать и потом.",
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

/** A refusal the provider does not bill: the model's moderation refusal is settled at zero (plan §2.5). Every other failed slot is said as paid. */
export function isFreeFailure(error: EngineError): boolean {
  return error.code === "MODERATION_REFUSED";
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
          return isFreeFailure(f.error)
            ? { key, look: "failed", icon: "close", tone: "muted", title: "Модель отказалась · бесплатно", sub: null }
            : { key, look: "failed", icon: "alert", tone: "danger-text", title: "Не получилось · стоимость учтена", sub: null };
      }
    });
}

const FAILED_FORMS = ["вариант не удалось получить", "варианта не удалось получить", "вариантов не удалось получить"] as const;

/**
 * 16e: the batch's PAID failures in one line, their shared reason when they agree — «2 варианта не удалось получить: OpenRouter не ответил вовремя. До
 * сверки попытка считается по худшей цене. Стоимость попытки учтена.» A free refusal is not counted (its tile says «бесплатно»); null when none was paid.
 */
export function paidFailureLine(failedSlots: readonly FailedPortraitSlot[]): string | null {
  const paid = failedSlots.flatMap((f) => (f.reason === "failed" && !isFreeFailure(f.error) ? [f.error.code] : []));
  if (paid.length === 0) return null;
  const codes = new Set(paid);
  const [only] = codes;
  const reason = codes.size === 1 && only !== undefined ? ERROR_MESSAGES_RU[only] : "Причины разные — подробности в журнале.";
  return `${countOf(paid.length, FAILED_FORMS)}: ${afterColon(reason)} Стоимость попытки учтена.`;
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
  return `Уже ${countOf(pending, VARIANT_FORMS)} — ещё ${PORTRAITS_PER_BATCH} не поместятся в предел ${PORTRAIT_CANDIDATES_MAX}. Выберите один или удалите все.`;
}

/** The radio's name: its letter, its likeness, and «лучший» for the best (a screen reader hears what the badges show). */
export function variantLabel(letter: string, likeness: number | undefined, best: boolean): string {
  const parts = [`Вариант ${letter}`];
  if (likeness !== undefined) parts.push(`сходство ${likenessText(likeness)}`);
  if (best) parts.push("лучший");
  return parts.join(" · ");
}

/** A refusal's line under the landing (18b): the app's text for the code and, unless that text says so already, that nothing was started or paid. */
export function refusalLine(text: string): string {
  return /ничего не потрачено\.?$/i.test(text) ? text : `${text} ${PORTRAIT_TEXT.notStarted}`;
}
