import type { CaptionIssue, CategoryReason, DescriptorReason, ErrorCode, ExportUnavailableReason, LaunchReason, MusicUnavailableReason, PhotoUnavailableReason, PortraitReason, SceneReason } from "./errors";
import { MAX_PICKED_FILES, type MediaKind, type MediaUnsupportedReason } from "./media";
import { MIN_CLIP_MS, type MontageIssueCode } from "./montage";
import type { UsageUnknownReason } from "./state";

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
  // True for every source of IN_FLIGHT (a library switch, an import, a render, a paid request): most of them cost no money.
  IN_FLIGHT: "Studio сейчас занята другим действием (например, платными запросами или импортом): дождитесь, когда оно закончится, и повторите.",
  LIBRARY_UNAVAILABLE: "Папка библиотеки недоступна. Выберите папку в Настройках — до этого ничего не тратится.",
  DESCRIPTOR_INVALID: "Описание аватара не проходит текущую проверку возраста, поэтому по нему ничего не генерируется. Описание нужно переписать.",
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
  // The general text, for a refusal with no `photoReason` (a rejected, missing or foreign photo, or cells refused for different causes):
  // `PHOTO_UNAVAILABLE_REASONS_RU` has one per cause the engine names.
  PHOTO_UNAVAILABLE:
    "Это фото нельзя поставить в видео: оно уже в другом видео (одно фото идёт только в одно видео), занято рендером в очереди, отклонено вами или больше не подходит. Выберите другое.",
  // Said to a render, to «Удалить» and to «Папка «Готовые видео»»: it claims nothing about a video, only that no money moved.
  EXPORT_UNAVAILABLE: "Папка «Готовые видео» недоступна. Проверьте её в Настройках: ничего не потрачено.",
  RENDER_FAILED: "Не удалось собрать видео. Готовый файл не создан, ничего не потрачено. Попробуйте ещё раз.",
  // The check is the same next time: a retry helps only when the file changed under it; otherwise the montage has to change.
  RENDER_VERIFY_FAILED: "Собранное видео не прошло проверку и не сохранено. Если повтор даст то же, измените монтаж или обновите Studio.",
  RENDER_QUEUE_FULL: "В очереди уже слишком много видео. Дождитесь, пока часть из них соберётся, или отмените лишние, и повторите. Ничего не потрачено и не сохранено.",
  LIBRARY_TOO_NEW: "Часть записей видео создана более новой версией Studio. Обновите приложение: до этого такие записи не показываются и не удаляются, а новые видео этого аватара не собираются.",
  TEXT_INVALID: "Надпись не подходит для видео. Исправьте текст надписи.",
  TEXT_PREVIEW_SUPERSEDED: "Этот предпросмотр надписи устарел: уже запрошен более новый. Ничего не нарисовано, ошибки нет.",
  MUSIC_KEY_MISSING: "Ключ RapidAPI не задан. Добавьте его в Настройках — до этого запросы за музыкой не отправляются и не тратятся.",
  MUSIC_KEY_REJECTED: "RapidAPI не принял ключ (401). Замените ключ в Настройках: до этого запросы за музыкой не отправляются и не тратятся.",
  MUSIC_QUOTA_EXHAUSTED:
    "Запросы за музыкой сейчас недоступны: отправлено 30 за 31 день, или сервис музыки ответил, что запросов не осталось. Ничего не отправлено; когда можно снова, показывает Studio.",
  MEDIA_UNSUPPORTED: "Этот файл не удалось добавить. Причина указана рядом; в «Мои» ничего не попало.",
  TRASH_UNAVAILABLE:
    "Системная Корзина не приняла папку аватара (сетевой диск, том без Корзины или сбой перемещения). Аватар не удалён и остался как был: ничего не пропало.",
  MUSIC_UNAVAILABLE: "Не удалось получить список музыки; предыдущий список остался как был. Если запрос был отправлен, он засчитан в лимит. Попробуйте позже.",
  POOL_REJECTED: "Модель дважды вернула неподходящий набор — переформулируйте описание.",
  SCENES_CHANGED: "Набор сцен уже изменён: в другом окне или записью модели. Ничего не изменено и не отправлено — посмотрите набор заново и повторите.",
} as const satisfies Record<ErrorCode, string>;

/**
 * Why an own file was turned away (the `mediaReason` behind MEDIA_UNSUPPORTED, K30, CF10). One text per reason, each saying what to do.
 * `satisfies Record<MediaUnsupportedReason, string>`: the per-kind tasks (3f.2 to 3f.5) that append a reason must append its text here.
 */
export const MEDIA_REASONS_RU = {
  "not-a-file": "Это не файл: выберите обычный файл, а не папку, ярлык или устройство.",
  empty: "Файл пустой.",
  "too-large": "Файл слишком большой для этого типа: фото — до 30 МБ, видео — до 2 ГБ, музыка — до 100 МБ, стикер — до 5 МБ.",
  format: "Формат не подходит. Фото — JPEG, PNG или WebP; видео — MP4 или MOV; музыка — mp3, m4a, aac, wav, flac, alac, ogg или opus; стикер — GIF или APNG.",
  heic: "Формат HEIC не читается — сохраните как JPEG и добавьте снова.",
  changed: "Файл изменился, пока его копировали. Выберите его ещё раз.",
  unreadable: "Не удалось прочитать файл или записать его копию. Проверьте доступ к файлу и место на диске.",
  "no-space": "На диске библиотеки не хватает места для копии и обработки файла. Освободите место и повторите.",
  "too-many": `За один раз можно добавить не больше ${MAX_PICKED_FILES} файлов, а когда в очереди на добавление уже много файлов, новые не принимаются. Остальные выберите ещё раз, когда часть файлов добавится.`,
  failed: "Не удалось добавить файл. Попробуйте ещё раз.",
  cancelled: "Добавление отменено, в «Мои» ничего не попало.",
  "not-yet-supported": "Файлы такого типа пока нельзя добавить.",
  // 3f.2 and 3f.3a: the codes below are shared by every kind, so these are the NEUTRAL texts; a kind that has more to say has it in
  // MEDIA_REASONS_BY_KIND_RU. `animated-webp` is only ever a photo's.
  "too-small": "Изображение слишком маленькое: каждая сторона должна быть не меньше 2 пикселей.",
  dimensions: "Картинка слишком большого размера. Уменьшите разрешение и добавьте снова.",
  "animated-webp": "Анимированный WebP не подходит для фото. Сохраните один кадр как JPEG или PNG и добавьте снова.",
  "too-long": "Файл слишком длинный для этого типа. Сократите его и добавьте снова.",
  codec: "Файл закодирован в формате, который не поддерживается. Сохраните его в другом формате и добавьте снова.",
  structure: "Файл устроен необычно, и добавить его нельзя: например, в нём несколько изображений, нестандартный поворот или цвет, или он собран из частей. Пересохраните его обычным способом и добавьте снова.",
  "not-animated": "Файл не анимирован: нужен GIF или APNG минимум с двумя кадрами, идущими не быстрее 30 кадров в секунду (быстрее кадры сливаются в один).",
  "loop-too-long": "Анимация слишком длинная: до 300 кадров, то есть 10 секунд при 30 кадрах в секунду. Сократите её и добавьте снова.",
  // 3f.6: the neutral text names no kind; video and audio have their own below.
  "too-short": "Файл слишком короткий, чтобы им можно было воспользоваться. Возьмите файл подлиннее и добавьте снова.",
} as const satisfies Record<MediaUnsupportedReason, string>;

/**
 * The texts a kind says in its own words, over the neutral ones above (3f.3a review M2): the reason CODES are shared by every kind, the text
 * depends on the kind of the file that was turned away. 3f.2 (photo) and 3f.4 (music) add theirs here.
 */
export const MEDIA_REASONS_BY_KIND_RU: Partial<Record<MediaKind, Partial<Record<MediaUnsupportedReason, string>>>> = {
  photo: {
    "too-small": "Фото слишком маленькое: каждая сторона должна быть не короче 2 пикселей.",
    dimensions: "У фото слишком много пикселей: допустимо до 50 мегапикселей (например, 8000 × 6000). Уменьшите его и добавьте снова.",
  },
  audio: {
    "too-long": "Трек длиннее 10 минут. Обрежьте его и добавьте снова.",
    codec: "Такой звук не поддерживается. Подойдут mp3, AAC, ALAC, FLAC, WAV, Ogg Vorbis и Opus: сохраните трек в одном из них.",
    format: "Это не музыкальный файл, который Studio читает: нужен один звуковой трек (mp3, m4a, aac, wav, flac, ogg или opus), без видео и нескольких дорожек.",
    structure: "Файл устроен необычно, и добавить его нельзя. Пересохраните трек обычным способом (например, в mp3 или m4a) и добавьте снова.",
    // The shortest montage is 4 s (`MIN_TOTAL_MS`) and a track must cover it from its start.
    "too-short": "Трек короче 4 с — это меньше самого короткого монтажа, музыку из него не поставить. Выберите трек подлиннее.",
  },
  video: {
    "too-large": "Видео слишком тяжёлое: исходный файл и готовая копия, которую делает Studio, не должны быть больше 2 ГБ. Длинный зернистый или шумный ролик даже из небольшого файла может не поместиться. Сократите его и добавьте снова.",
    "too-long": "Видео длиннее трёх минут. Обрежьте его и добавьте снова.",
    codec: "Такой видеокодек не поддерживается. Подойдут видео H.264, HEVC (в том числе HDR) и ProRes: сохраните ролик в одном из них.",
    dimensions: "Видео больше 4K. Уменьшите разрешение до 4096 × 2160 и добавьте снова.",
    "too-small": "Кадр видео слишком маленький: каждая сторона должна быть не меньше 2 пикселей.",
    structure: "Видео устроено необычно, и добавить его нельзя: например, в нём несколько видеодорожек, нестандартный поворот или цвет, или оно собрано из частей. Пересохраните ролик обычным способом и добавьте снова.",
    // The shortest clip is `MIN_CLIP_MS` (0.1 s). The dot in «0.1» is the editor's (its own text for a short video says «0.1 с» too).
    "too-short": `Видео короче ${(MIN_CLIP_MS / 1000).toFixed(1)} с — в ролик его не поставить.`,
    // A file with sound that the video importer cannot read (an audio track beside a video track with no frames, say) is what the owner meant as music, most likely.
    format: "Это не видео, которое читает Studio: нужен MP4 или MOV с одной видеодорожкой. Если в файле только звук, добавьте как музыку.",
  },
  // 3f.5: what an own sticker is turned away for, in the sticker's own words (it takes a GIF or an APNG, not a photo).
  sticker: {
  format:
    "Для стикера нужен GIF или APNG. Если это APNG, перед анимацией не должно быть отдельной картинки-заставки, а сам файл должен читаться целиком: сохраните анимацию заново и добавьте снова.",
  "too-large": "Стикер слишком тяжёлый: исходный файл и готовая анимация не должны быть больше 5 МБ. Уменьшите размер картинки или число кадров.",
  "too-small": "Стикер слишком маленький: каждая сторона должна быть не короче 2 пикселей.",
  dimensions: "Стикер слишком большой: каждая сторона — не длиннее 720 пикселей, а размер кадра, умноженный на длину анимации, ограничен (166 кадров при 720 × 720, 300 кадров при 480 × 480). Уменьшите стикер или сократите анимацию и добавьте снова.",
  "not-animated": "Это не анимация: нужен GIF или APNG минимум с двумя кадрами, идущими не быстрее 30 кадров в секунду (быстрее кадры сливаются в один). Обычную картинку (PNG, JPEG) стикером сделать нельзя.",
  "loop-too-long": "Анимация слишком длинная: стикер — это петля до 300 кадров, то есть 10 секунд при 30 кадрах в секунду. Сократите анимацию и добавьте снова.",
  failed: "Не удалось добавить стикер. Попробуйте ещё раз или сохраните анимацию заново.",
  },
};

/** The Russian text for a refusal: the kind's own when it has one, else the neutral one. `kind` is the kind of the file that was turned away, when known. */
export function mediaReasonRu(reason: MediaUnsupportedReason, kind?: MediaKind): string {
  return (kind === undefined ? undefined : MEDIA_REASONS_BY_KIND_RU[kind]?.[reason]) ?? MEDIA_REASONS_RU[reason];
}

/**
 * Why a caption is refused (the `captionIssue` behind TEXT_INVALID). The charset text names © ® ™ on purpose:
 * the fonts have them, but the owner does not allow them in captions.
 */
export const CAPTION_ISSUES_RU = {
  charset:
    "В надписи допустимы английские буквы, цифры, обычные знаки препинания, ’ ‘ “ ” – — … и эмодзи. Символы ©, ® и ™ не поддерживаются (ни отдельно, ни как эмодзи), как и любые другие знаки, управляющие символы и текст на других языках.",
  "emoji-missing": "Этого эмодзи нет в шрифте, поэтому его не удастся нарисовать. Замените его другим.",
  "emoji-text-style": "Эмодзи с селектором текстового начертания (VS15) нарисовать нельзя. Уберите селектор или возьмите обычный цветной эмодзи.",
  "too-long": "В надписи больше 60 символов. Сократите текст.",
  "too-many-lines": "В надписи больше двух строк. Уберите лишние переносы строки.",
} as const satisfies Record<CaptionIssue, string>;

/**
 * Why a photo was refused, for PHOTO_UNAVAILABLE's `photoReason`: each text names the cause and the way out. The last two refuse EVERY photo of the
 * avatar, so replacing one photo cannot help and the text says so; `pending-video` may refuse every photo too (an unreadable intent holds them all),
 * so its text does not promise that another photo is free.
 */
export const PHOTO_UNAVAILABLE_REASONS_RU = {
  "in-video": "Это фото уже в другом видео: одно фото идёт только в одно видео. Выберите другое фото или удалите то видео — тогда фото освободится.",
  "held-by-render": "Это фото сейчас занято рендером: он стоит в очереди или идёт. Отмените тот рендер — тогда фото освободится; если он соберётся, фото останется в том видео. Выберите другое фото.",
  "pending-video":
    "Это фото держит видео, которое не успело сохраниться до конца. Оно освободится, когда Studio доделает или отменит это видео — это происходит при запуске Studio. Если пришло уведомление «Незавершённое видео не прочитано», следуйте ему. Пока выберите другое фото, если оно свободно.",
  "index-stale": "Studio сейчас не может проверить, какие фото этого аватара уже в видео: она ещё перечитывает записи. Пока так, не подходят все фото этого аватара, а не одно. Подождите немного и повторите.",
  "log-needs-repair":
    "Записи об этом аватаре повреждены или недоступны, и Studio не знает, какие его фото уже в видео, поэтому не подходят все фото этого аватара, а не одно. Откройте «Фото» этого аватара: там написано, что случилось и что можно сделать.",
} as const satisfies Record<PhotoUnavailableReason, string>;

/** Why a category command was refused, for VALIDATION's `categoryReason`: each text names the cause and the way out. */
export const CATEGORY_REASONS_RU = {
  limit: "В библиотеке уже 50 своих категорий — это предел. Удалите ненужную и повторите. Ничего не потрачено.",
  "name-taken": "Такое имя уже есть у другой категории (регистр и пробелы по краям не считаются). Выберите другое имя.",
  "below-minimum": "Набор не может стать меньше: в категории остаются не меньше 5 мест и 3 образов. Уберите другое или пересоздайте набор.",
  "mirror-needed": "Колода кадров включает съёмку в зеркале, поэтому в наборе должно остаться место с зеркалом. Уберите другое место.",
  "item-not-found": "Этого места или образа в категории уже нет — возможно, его убрали. Обновите список.",
  "library-unreadable": "Диск не отдал часть записей библиотеки (так бывает, когда файл занят антивирусом или диск не отвечает), поэтому Studio не может проверить имя и число категорий. Ничего не создано и не потрачено — повторите через секунду.",
} as const satisfies Record<CategoryReason, string>;

/**
 * Why `avatars.editDescriptor` refused the owner's text, for VALIDATION's `descriptorReason`: one text per rule, each naming what to fix. The owner types
 * the descriptor in English words (it goes into image prompts as it is), so the script text says so.
 */
export const DESCRIPTOR_REASONS_RU = {
  empty: "Описание пустое",
  "hidden-chars": "В описании есть скрытые символы",
  "too-long": "Описание длиннее 600 знаков",
  "too-long-with-body": "Описание и тело вместе длиннее 600 знаков — сократите описание",
  "no-anchor": "В описании должна быть фраза «<возраст>-year-old» с возрастом этого аватара",
  script: "Описание пишется латиницей — английскими словами",
  "non-ascii-digits": "Только цифры 0–9",
  "other-age": "В описании другой возраст",
  "under-21-bound": "Нельзя указывать возрастные пределы",
  "youth-word": "Слово, которое мы не используем",
  number: "Других чисел, кроме возраста, быть не должно",
  stale: "Описание уже изменилось — проверьте ещё раз",
  invalid: "Описание не проходит проверку возраста и правил Studio. Перепишите его проще",
} as const satisfies Record<DescriptorReason, string>;

/**
 * The text for a `descriptorReason`. For `youth-word` it quotes the owner's own words after a colon, in the plural for several. For `no-anchor` it gives the avatar's own
 * `age` as the example when the caller knows it (the error itself carries none).
 */
export function descriptorReasonRu(reason: DescriptorReason, words: readonly string[] = [], age?: number): string {
  const text = DESCRIPTOR_REASONS_RU[reason];
  if (reason === "youth-word" && words.length > 0) {
    const head = words.length > 1 ? "Слова, которые мы не используем" : text;
    return `${head}: ${words.map((word) => `«${word}»`).join(", ")}`;
  }
  if (reason === "no-anchor" && age !== undefined) return `${text}, например «${age}-year-old»`;
  return text;
}

/** Why a portrait command was refused, for VALIDATION's `portraitReason`: each text names the cause and the way out, and says when nothing was spent. */
export const PORTRAIT_REASONS_RU = {
  "not-imported": "Мастер-портрет делают из импортированного фото, а у этого аватара его нет. Ничего не потрачено.",
  "too-many-candidates": "Невыбранных вариантов уже 15 — это предел. Выберите один или нажмите «Оставить как есть», потом повторите. Ничего не потрачено.",
  "not-a-candidate": "Этого варианта уже нет среди доступных — возможно, его убрали. Обновите список.",
} as const satisfies Record<PortraitReason, string>;

/** Why a scene-set command was refused, for VALIDATION's `sceneReason`: each text names the cause and the way out; the window names the scene itself from `sceneId`. */
export const SCENE_REASONS_RU = {
  "set-used": "Этот набор уже ушёл в запуск, поэтому его нельзя менять. Составьте новый набор.",
  "open-set": "У этого аватара уже есть открытый набор сцен. Отрисуйте его или удалите, потом составьте новый.",
  "nothing-waiting": "Дописывать нечего: все сцены набора уже написаны. Обновите экран.",
  "scene-missing": "Такой сцены в наборе нет — возможно, набор изменили в другом окне. Обновите экран.",
  "target-removed": "Эта сцена убрана из набора. Верните её, чтобы писать заново.",
  "scene-without-text": "У одной из сцен нет текста: напишите её, введите текст сами или уберите сцену.",
  "no-active-scenes": "В наборе не осталось сцен для отрисовки: все убраны. Верните хотя бы одну.",
  "too-many-active": "Сцен больше, чем можно отрисовать за один запуск (не больше 100). Уберите лишние.",
  "scene-text-problem": "Текст одной из сцен не проходит нынешние правила слов (после обновления они могли ужесточиться). Измените текст или уберите сцену.",
  "write-record-cap": "Слишком много правок в этом наборе — пересоставьте его.",
  "idea-room": "В наборе не хватит места для новых сцен (не больше 200, с учётом незавершённой записи по идее). Уберите ненужные или завершите ту запись.",
  "mixed-kinds": "Свои сцены и сцены из плана пишутся по-разному: выберите сцены одного вида.",
  "own-redraw": "У своей сцены нет места, которое можно перерисовать: напишите её заново по той же идее.",
  "no-open-write": "Такой незавершённой записи уже нет — возможно, её закрыли в другом окне. Обновите экран.",
  "no-attempts-left": "У этой записи не осталось попыток. Закройте её или напишите сцены заново.",
  "nothing-to-dismiss": "У этой сцены нет незавершённой записи, которую можно закрыть. Обновите экран.",
  "library-unreadable": "Диск не отдал часть наборов сцен этого аватара (так бывает, когда файл занят антивирусом или диск не отвечает), поэтому Studio не может проверить, нет ли уже открытого набора. Ничего не записано и не потрачено — повторите через секунду.",
  "launch-set": "Это часть запуска автопилота: управляйте им в «Автопилоте». Пока запуск не закончился, набор и его партии там же ставятся на паузу и останавливаются.",
  "over-plan": "В наборе больше сцен, чем запланировано для запуска: уберите лишние. Запуск не тратит больше принятого предела, поэтому сцен сверх плана он не нарисует.",
  "not-awaiting": "Этот набор сейчас не ждёт проверки в запуске: возможно, запуск уже продолжен, остановлен или на паузе. Обновите экран.",
} as const satisfies Record<SceneReason, string>;

/**
 * Why a launch could not be planned or started, for VALIDATION's `launchReason`: each text names the cause and the way out. The window words the same
 * causes with names and numbers from the preview's `blockers` (the avatar, how many photos); these are the plain texts for a refusal without that context.
 * Nothing is written or spent in any of them.
 */
export const LAUNCH_REASONS_RU = {
  "open-set": "У аватара открыт набор сцен: завершите или удалите его на экране «Фото», потом запускайте. Ничего не потрачено.",
  "too-many-photos": "Аватару нужно больше 100 новых фото, а за один запуск больше 100 нельзя. Уменьшите число видео или долю слайдов. Ничего не потрачено.",
  "usage-unknown": "Studio не знает, какие фото аватара уже в видео, поэтому из его библиотеки собрать нельзя. Уберите аватара из запуска или починьте записи на экране «Фото». Ничего не потрачено.",
  "launch-unreadable": "Одна запись прошлого запуска не читается и может описывать идущий запуск. Уберите её в «Истории запусков» и повторите. Ничего не потрачено.",
  "nothing-enabled": "Включите хотя бы одно: свободные фото из библиотеки или догенерацию. Ничего не потрачено.",
} as const satisfies Record<LaunchReason, string>;

/** Russian text for each structural problem of a montage (the `issues` of MONTAGE_INVALID). */
export const MONTAGE_ISSUE_MESSAGES_RU = {
  "no-clips": "В монтаже нет ни одного кадра.",
  "duration-too-short": "Монтаж короче 4 секунд.",
  "duration-too-long": "Монтаж длиннее 15 секунд.",
  "too-many-text-layers": "Текстовых слоёв больше 10.",
  "too-many-sticker-layers": "Стикеров больше 10.",
  "cells-layout-mismatch": "Число фото в коллаже не совпадает с его раскладкой.",
  "cell-empty": "В кадре есть пустая ячейка: добавьте фото или уберите кадр.",
  "layer-too-short": "Слой короче 0,3 секунды.",
  "layer-outside-timeline": "Слой заканчивается после конца монтажа.",
  "duplicate-clip-id": "Два кадра с одним идентификатором.",
  "duplicate-layer-id": "Два слоя с одним идентификатором.",
  "photo-repeated": "Одно и то же фото стоит в монтаже больше одного раза.",
  "photo-unavailable": "Это фото нельзя поставить в видео: оно уже в другом видео, занято рендером, отклонено или больше не подходит.",
  "not-yet-supported": "Эта часть монтажа пока не поддерживается.",
  "caption-invalid": "Надпись не проходит проверку: замените её текст.",
  "media-unavailable": "Файла, который стоит в этом месте монтажа, больше нет среди ваших файлов.",
  "sticker-unavailable": "Этого стикера больше нет: выберите другой.",
  "track-unavailable": "Этого трека больше нет: выберите другой.",
  "track-too-short": "Трек короче монтажа с выбранного места: сдвиньте начало или выберите другой трек.",
  "video-too-short": "Своё видео короче, чем нужно этому кадру: сдвиньте начало фрагмента или сократите кадр.",
} as const satisfies Record<MontageIssueCode, string>;

/** Why the «Готовые видео» folder cannot be used, for the notice behind EXPORT_UNAVAILABLE. */
export const EXPORT_UNAVAILABLE_REASONS_RU = {
  missing: "Папка не найдена.",
  "not-a-directory": "По этому пути лежит файл, а не папка.",
  "not-writable": "В эту папку нельзя записывать.",
  "not-enough-space": "В папке не хватает свободного места.",
  "overlaps-library": "Папка «Готовые видео» не может быть внутри папки библиотеки или содержать её.",
  "overlaps-work-folder": "Папка «Готовые видео» не может быть внутри рабочей папки Studio (там лежат временные файлы рендера) или содержать её. Выберите другую папку.",
  "newer-marker": "Эту папку «Готовые видео» создала более новая версия Studio. Обновите приложение или выберите другую папку.",
  "invalid-marker": "Служебный файл .studio-export.json в этой папке повреждён. Выберите другую папку или удалите этот файл сами.",
  // Never suggests touching the file: the records of the videos made so far may name the very id it held.
  "invalid-marker-with-records":
    "Служебный файл .studio-export.json в этой папке повреждён, а по нему Studio узнаёт папку с вашими видео. Не удаляйте его: если есть резервная копия, верните файл из неё, или выберите другую папку — записи о прежних видео сохранятся.",
} as const satisfies Record<ExportUnavailableReason, string>;

/**
 * What MUSIC_UNAVAILABLE means, by its `musicReason` (3c.6): each text says whether the request was sent (and so
 * counted), and what the owner can do. Only the causes where waiting helps say to wait.
 */
export const MUSIC_UNAVAILABLE_REASONS_RU = {
  "shutting-down": "Studio закрывается, поэтому запрос не отправлен. Обновите список после перезапуска.",
  "not-available": "В этой сборке Studio обновление списка музыки недоступно, поэтому запрос не отправлен. Обновите приложение.",
  "no-music-folder":
    "Studio не смогла открыть свою папку для музыки, поэтому запрос не отправлен. Перезапустите Studio; если не поможет, проверьте место на диске и права на папку данных приложения.",
  clock: "Системные часы показывают неверную дату, поэтому запрос не отправлен: по ним считается окно в 31 день. Поставьте правильные дату и время и повторите.",
  config: "Studio не смогла подготовить запрос, поэтому он не отправлен. Перезапустите приложение.",
  "log-held":
    "Прошлый ответ сервиса музыки ещё не записан в журнал запросов, поэтому новый запрос не отправлен. Освободите место на диске или проверьте права на папку данных Studio: запись повторится, когда вы снова откроете карточку «Музыка» в Настройках.",
  "log-unwritable": "Журнал запросов не записывается на диск, поэтому запрос не отправлен. Освободите место на диске или проверьте права на папку данных Studio и повторите.",
  "log-unreadable":
    "Журнал запросов не читается, поэтому запрос не отправлен: без журнала Studio не знает, сколько запросов осталось. Проверьте доступ к файлу и перезапустите Studio.",
  "log-corrupt":
    "Журнал запросов повреждён, поэтому запрос не отправлен. Восстановить журнал можно в Настройках, в карточке «Музыка»: повреждённый файл отложится в сторону, а новые запросы закроются на 31 день.",
  "log-missing":
    "Журнал запросов пропал (например, удалили папку с музыкой), а Studio уже отправляла запросы, поэтому запрос не отправлен: счёт потерян. Восстановить журнал можно в Настройках, в карточке «Музыка»: новые запросы закроются на 31 день.",
  network: "Запрос ушёл, но ответа нет: сеть или сервис музыки не ответили вовремя. Запрос засчитан в лимит, повтор — ещё 1 запрос; лучше подождать. Прежний список остался как был.",
  forbidden:
    "Сервис музыки отказал в доступе (403): скорее всего, у ключа нет подписки на flashapi в RapidAPI. Запрос засчитан. Проверьте подписку: без неё повтор снова потратит запрос.",
  "rate-limited":
    "Сервис музыки попросил подождать (429). Запрос засчитан. Если сервис сообщил, что запросов не осталось, Studio не отправит следующий, пока квота не освободится.",
  server: "Сервис музыки ответил ошибкой. Запрос засчитан в лимит, повтор — ещё 1 запрос; лучше подождать. Прежний список остался как был.",
  "bad-answer": "Сервис музыки прислал ответ без пригодных треков. Запрос засчитан; повтор, скорее всего, даст то же. Прежний список остался как был.",
  "store-failed": "Список получен, запрос засчитан, но сохранить треки не удалось. Проверьте место на диске и подключение к интернету. Треки, скачанные раньше, остались.",
  "downloads-stopped":
    "Загрузка остановлена, оставшиеся треки будут докачаны при следующем запуске Studio, без нового запроса к сервису музыки: сервер с треками отказал в скачивании.",
  "downloads-failed": "Не удалось докачать треки прошлого обновления. Запрос к сервису музыки не отправлялся и не засчитан; уже скачанные треки остались.",
} as const satisfies Record<MusicUnavailableReason, string>;

/**
 * Why an avatar's usage cannot be trusted (3e.2, K16), for the «использование неизвестно» state that stands instead of its
 * counts. A newer record and a stale index are never "repaired": the texts say so.
 */
export const USAGE_UNKNOWN_REASONS_RU = {
  "library-too-new":
    "Часть записей видео этого аватара создана более новой версией Studio. Обновите приложение: до этого Studio не знает, какие фото уже в видео, и не собирает новые видео этого аватара.",
  "index-stale": "Studio не успела учесть только что сохранённое видео и перечитывает записи сама. Подождите немного: ничего делать не нужно.",
  "record-unreadable":
    "Одна из записей о видео этого аватара повреждена, поэтому Studio не знает, какие фото уже в видео. Повреждённую запись можно убрать в карантин библиотеки: файлы видео при этом не трогаются.",
  "record-inaccessible":
    "Studio не может открыть файл одной из записей о видео этого аватара: нет доступа, файл занят другой программой или ещё не скачан из облака. Сама запись может быть цела, поэтому Studio её не трогает. Откройте к файлу доступ и перезапустите Studio: до этого Studio не знает, какие фото уже в видео.",
  "rejects-unreadable":
    "Журнал ваших отметок «Отклонено» повреждён, поэтому Studio не знает, какие фото вы отклонили. Отметки можно восстановить: всё, что читается, сохранится, а копия журнала останется в карантине библиотеки.",
} as const satisfies Record<UsageUnknownReason, string>;
