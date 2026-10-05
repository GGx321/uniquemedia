import type { EngineNotice, NoticeCode } from "../../shared/engine";
import { countOf } from "../lib/format";
import { Notice } from "./Notice";

const NOTICE_TITLE: Record<NoticeCode, string> = {
  "engine-restarted": "Движок перезапускался",
  "settings-reset": "Настройки сброшены",
  "engine-internal-error": "Внутренняя ошибка движка",
};

// engine-restarted says only what happened: whether open reserves need a
// reconcile is AccountBanner's own, more specific call to action (paidStop's
// "reconcile" case), driven by MoneyStatus, not by this notice. Saying it
// twice — once here, generically, and once there, with the actual button —
// would explain the same situation from two places.
const NOTICE_TEXT: Record<NoticeCode, string> = {
  "engine-restarted": "Движок перезапускался: работа, которая шла в момент сбоя, могла быть потеряна.",
  "settings-reset": "Файл настроек не удалось прочитать, поэтому используются значения по умолчанию. Проверьте ключ и папку библиотеки в Настройках.",
  "engine-internal-error": "Движок перехватил непредвиденную ошибку и продолжил работу. Если что-то работает не так, перезапустите Studio.",
};

/** A notice as the owner closed it: the notice and how many times it had happened then (a repeat is news again). */
export const dismissalKey = (notice: Pick<EngineNotice, "noticeId" | "count">): string => `${notice.noticeId}:${notice.count}`;

/**
 * The engine's own pending notices (a crash and restart, a corrupt
 * settings.json): from the snapshot, then live `engine.notice` events, always
 * deduped by code in the store (store.ts, mergeNotice) — shown wherever the
 * app is, not tied to one screen. There is no dismiss command in the contract:
 * «Понятно» closes one in this window only (slice review 5, L1; `dismissed`,
 * kept by the window), until it happens again. Each notice states only what
 * happened; any action it implies (a reconcile, a key check) is a different
 * component's job — AccountBanner's for money.
 */
export function EngineNotices({ notices, dismissed, onDismiss }: { notices: readonly EngineNotice[]; dismissed: ReadonlySet<string>; onDismiss: (notice: EngineNotice) => void }) {
  const shown = notices.filter((n) => !dismissed.has(dismissalKey(n)));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((n) => (
        <Notice
          key={n.noticeId}
          noticeKey={`engine:${dismissalKey(n)}`}
          tone="warn"
          title={NOTICE_TITLE[n.code]}
          actions={
            <button type="button" className="btn btn-s" onClick={() => onDismiss(n)}>
              Понятно
            </button>
          }
        >
          {NOTICE_TEXT[n.code]}
          {n.count > 1 && ` Повторилось ${countOf(n.count, ["раз", "раза", "раз"])} за эту сессию.`}
        </Notice>
      ))}
    </>
  );
}
