import type { ErrorCode, ExportUnavailableReason } from "./errors";
import type { MontageIssueCode } from "./montage";

/** Russian user-facing text for each error code. Codes never carry text themselves. */
export const ERROR_MESSAGES_RU = {
  AUTH_INVALID: "OpenRouter не принял ключ (401). Проверьте или замените ключ в Настройках.",
  INSUFFICIENT_CREDITS: "На балансе OpenRouter не хватает средств (402). Пополните баланс и повторите.",
  BUDGET_EXCEEDED: "Месячный бюджет исчерпан. Увеличьте его в Настройках или дождитесь следующего месяца.",
  RUN_CAP_EXCEEDED: "Запуск дошёл до своего лимита расходов и остановлен.",
  MODERATION_REFUSED: "Модель отказалась генерировать это изображение.",
  RATE_LIMITED:
    "OpenRouter просит снизить частоту запросов. Ничего не повторяется само. Фото-ран продолжите кнопкой «Продолжить» — новый ран запускать не нужно; действие с аватаром запустите ещё раз.",
  NETWORK: "Нет связи с OpenRouter. Проверьте подключение к интернету.",
  TIMEOUT: "OpenRouter не ответил вовремя. До сверки попытка считается по худшей цене.",
  RECONCILE_REQUIRED: "Нужна сверка расходов: до неё платные запросы остановлены.",
  ENCRYPTION_UNAVAILABLE: "Системное шифрование недоступно, поэтому ключ не сохранён.",
  VALIDATION: "Некорректные данные запроса.",
  NOT_FOUND: "Запрошенный объект не найден.",
  INTERNAL: "Внутренняя ошибка движка.",
  LEDGER_CORRUPT: "Журнал расходов повреждён. Платные запросы остановлены до проверки.",
  LEDGER_UNREADABLE: "Не удалось прочитать журнал расходов. Платные запросы остановлены — проверьте доступ к файлу и перезапустите Studio.",
  SETTLE_ABOVE_WORST: "Списание оказалось выше зарезервированного максимума. Платные запросы остановлены.",
  LEDGER_WRITE_FAILED: "Не удалось записать журнал расходов на диск. Платные запросы остановлены.",
  PRICE_UNAVAILABLE: "Не удалось узнать цену модели, поэтому запрос не отправлен.",
  PRICE_CHANGED: "Цена выросла выше подтверждённой. Проверьте новую оценку и подтвердите снова.",
  IN_FLIGHT: "Дождитесь завершения текущих платных запросов.",
  LIBRARY_UNAVAILABLE: "Папка библиотеки недоступна. Выберите папку в Настройках — до этого ничего не тратится.",
  DESCRIPTOR_INVALID: "Описание аватара не проходит текущую проверку возраста, поэтому по нему ничего не генерируется. Описание нужно переписать.",
  AGE_CHECK_FAILED: "Проверка возраста на фото не подтвердила уверенно, что это взрослый человек. Импорт отменён, ничего не сохранено; оплачена только проверка возраста.",
  IMPORT_SUBJECT_INVALID: "На фото должна быть ровно одна взрослая женщина — без других людей в кадре. Импорт отменён, ничего не сохранено.",
  QA_REJECTED: "Проверка качества отклонила фото этой сцены, попытки для неё закончились.",
  // Reworded twice (2b whole-slice review, then its follow-up): T7a wired the
  // age gate into every photo run whose toggle is on, so `#assertAgeGate()`
  // (engine.ts) no longer fires because the feature "is not yet connected" —
  // in production the age gate is always registered, so this is unreachable
  // there, only a defensive guard against a broken engine wiring. A wiring
  // defect is in the build, so a restart cannot fix it: the text names the
  // one thing that works (the age check switched off) and says the build is
  // at fault.
  AGE_GATE_UNAVAILABLE:
    "Проверка возраста на фото включена, но её модуль не подключён к движку — это дефект сборки приложения, перезапуск его не исправит. Выключите проверку в Настройках, чтобы продолжить; саму сборку нужно исправить. Ничего не потрачено.",
  FACE_GATE_UNAVAILABLE: "Проверка совпадения лица недоступна: запуск не может продолжаться без неё. Перезапустите Studio; если ошибка повторится, переустановите приложение. Ничего не потрачено.",
  MASTER_FACE_UNUSABLE: "На главном фото этого аватара не удалось найти лицо для проверки совпадения. Создайте нового аватара или импортируйте другое фото. Ничего не потрачено.",
  MONTAGE_INVALID: "Монтаж не готов к рендеру: исправьте отмеченные проблемы.",
  PHOTO_UNAVAILABLE:
    "Это фото нельзя использовать в видео. В видео идут только сгенерированные сцены этого аватара: не отклонённые вами и прошедшие проверку возраста.",
  EXPORT_UNAVAILABLE: "Папка «Готовые видео» недоступна. Проверьте её в Настройках: видео не сохранено, ничего не потрачено.",
  RENDER_FAILED: "Не удалось собрать видео. Готовый файл не создан, ничего не потрачено. Попробуйте ещё раз.",
  RENDER_VERIFY_FAILED: "Собранное видео не прошло проверку и не сохранено. Попробуйте ещё раз.",
} as const satisfies Record<ErrorCode, string>;

/** Russian text for each structural problem of a montage (the `issues` of MONTAGE_INVALID). */
export const MONTAGE_ISSUE_MESSAGES_RU = {
  "no-clips": "В монтаже нет ни одного клипа.",
  "duration-too-short": "Монтаж короче 4 секунд.",
  "duration-too-long": "Монтаж длиннее 15 секунд.",
  "too-many-text-layers": "Текстовых слоёв больше 10.",
  "too-many-sticker-layers": "Стикеров больше 10.",
  "cells-layout-mismatch": "Число фото в коллаже не совпадает с его раскладкой.",
  "cell-empty": "В клипе есть пустая ячейка: добавьте фото или уберите клип.",
  "layer-too-short": "Слой короче 0,3 секунды.",
  "layer-outside-timeline": "Слой заканчивается после конца монтажа.",
  "duplicate-clip-id": "Два клипа с одним идентификатором.",
  "duplicate-layer-id": "Два слоя с одним идентификатором.",
  "photo-repeated": "Одно и то же фото стоит в монтаже больше одного раза.",
  "photo-unavailable": "Это фото нельзя использовать в видео: оно не подходит или было отклонено.",
  "not-yet-supported": "Эта часть монтажа пока не поддерживается.",
} as const satisfies Record<MontageIssueCode, string>;

/** Why the «Готовые видео» folder cannot be used, for the notice behind EXPORT_UNAVAILABLE. */
export const EXPORT_UNAVAILABLE_REASONS_RU = {
  missing: "Папка не найдена.",
  "not-a-directory": "По этому пути лежит файл, а не папка.",
  "not-writable": "В эту папку нельзя записывать.",
  "not-enough-space": "В папке не хватает свободного места.",
} as const satisfies Record<ExportUnavailableReason, string>;
