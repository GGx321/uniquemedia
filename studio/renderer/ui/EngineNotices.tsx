import type { EngineNotice, NoticeCode } from "../../shared/engine";
import { countOf } from "../lib/format";
import { Notice } from "./Notice";

const NOTICE_TITLE: Record<NoticeCode, string> = {
  "engine-restarted": "Движок перезапускался",
  "settings-reset": "Настройки сброшены",
};

// engine-restarted says only what happened: whether open reserves need a
// reconcile is AccountBanner's own, more specific call to action (paidStop's
// "reconcile" case), driven by MoneyStatus, not by this notice. Saying it
// twice — once here, generically, and once there, with the actual button —
// would explain the same situation from two places.
const NOTICE_TEXT: Record<NoticeCode, string> = {
  "engine-restarted": "Движок перезапускался: работа, которая шла в момент сбоя, могла быть потеряна.",
  "settings-reset": "Файл настроек не удалось прочитать, поэтому используются значения по умолчанию. Проверьте ключ и папку библиотеки в Настройках.",
};

/**
 * The engine's own pending notices (a crash and restart, a corrupt
 * settings.json): from the snapshot, then live `engine.notice` events, always
 * deduped by code in the store (store.ts, mergeNotice). There is no dismiss
 * command in the contract, so these stay until a fresher one of the same code
 * replaces them — shown wherever the app is, not tied to one screen. Each
 * notice states only what happened; any action it implies (a reconcile, a
 * key check) is a different component's job — AccountBanner's for money.
 */
export function EngineNotices({ notices }: { notices: readonly EngineNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((n) => (
        <Notice key={n.noticeId} tone="warn" title={NOTICE_TITLE[n.code]}>
          {NOTICE_TEXT[n.code]}
          {n.count > 1 && ` Повторилось ${countOf(n.count, ["раз", "раза", "раз"])} за эту сессию.`}
        </Notice>
      ))}
    </>
  );
}
