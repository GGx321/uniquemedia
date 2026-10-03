import { useState } from "react";
import { countOf, NBSP } from "../../lib/format";
import { USAGE_UNKNOWN_REASONS_RU, type AvatarSummary, type EngineError } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { useMounted } from "./shared";
import { usageActions, type UsageAction } from "./videosModel";

// 3e.2 (K16): an avatar whose photo usage the library cannot vouch for (a broken video record, broken reject marks, a record
// from a newer Studio, a stale index) shows this instead of counting its photos as free. It says why, each reason in the
// owner's words, and offers the way out he can take himself, each behind a confirmation: «Убрать повреждённую запись» moves the
// broken record files into the library's quarantine, «Восстановить отметки» keeps every readable mark and sets the log aside.
// The avatar's summary (and so this notice) follows the `avatar.changed` the engine sends once the usage is trusted again.

const RECORD_FORMS = ["запись", "записи", "записей"] as const;
const MARK_FORMS = ["отметка", "отметки", "отметок"] as const;
const LINE_FORMS = ["строка", "строки", "строк"] as const;

type Outcome = { tone: "ok" | "info"; text: string };

export function UsageNotice({ avatar }: { avatar: AvatarSummary }) {
  const { client } = useEngine();
  const mounted = useMounted();
  const [asking, setAsking] = useState<UsageAction | null>(null);
  const [running, setRunning] = useState<UsageAction["command"] | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const usage = avatar.usage;
  const actions = usageActions(usage);

  async function run(action: UsageAction): Promise<void> {
    setRunning(action.command);
    setError(null);
    setOutcome(null);
    const { avatarId } = avatar;
    let next: Outcome | EngineError;
    if (action.command === "videos.quarantineRecords") {
      const reply = await client.request("videos.quarantineRecords", { avatarId });
      next = !reply.ok
        ? reply.error
        : reply.result.quarantined === 0
          ? { tone: "info", text: "Повреждённых записей не нашлось: убирать нечего." }
          : { tone: "ok", text: `В карантин библиотеки ${reply.result.quarantined === 1 ? "убрана" : "убрано"} ${countOf(reply.result.quarantined, RECORD_FORMS)}.` };
    } else {
      const reply = await client.request("photos.rebuildRejected", { avatarId });
      next = !reply.ok
        ? reply.error
        : !reply.result.rebuilt
          ? { tone: "info", text: "Журнал отметок цел: восстанавливать нечего." }
          : { tone: "ok", text: `Отметки восстановлены: ${countOf(reply.result.kept, MARK_FORMS)} на месте, ${countOf(reply.result.dropped, LINE_FORMS)} не${NBSP}читались и убраны. Копия журнала — в карантине библиотеки.` };
    }
    if (!mounted.current) return;
    setRunning(null);
    setAsking(null);
    if ("code" in next) setError(next);
    else setOutcome(next);
  }

  if (usage.state === "ok") {
    // A recovery that just made the avatar trusted again says what it did, once.
    return outcome === null ? null : (
      <Notice
        tone={outcome.tone}
        actions={
          <button type="button" className="btn btn-s" onClick={() => setOutcome(null)}>
            Закрыть
          </button>
        }
      >
        {outcome.text}
      </Notice>
    );
  }

  return (
    <>
      <Notice
        tone="warn"
        title="Использование фото неизвестно"
        actions={
          asking === null && actions.length > 0 ? (
            <>
              {actions.map((action) => (
                <button key={action.command} type="button" className="btn btn-s" disabled={running !== null} onClick={() => setAsking(action)}>
                  {action.label}
                </button>
              ))}
            </>
          ) : undefined
        }
      >
        {usage.reasons.map((reason) => (
          <p key={reason} className="usage-reason">
            {USAGE_UNKNOWN_REASONS_RU[reason]}
          </p>
        ))}
        <p className="usage-reason faint">Пока это так, фото этого аватара не считаются свободными и новые видео из них не собираются.</p>
        {asking !== null && (
          <div className="usage-confirm" role="alert">
            <p>{asking.confirm}</p>
            <div className="usage-confirm-actions">
              <button type="button" className="btn btn-s btn-d" disabled={running !== null} onClick={() => void run(asking)}>
                {running === asking.command && <Spin />}
                {asking.label}
              </button>
              <button type="button" className="btn btn-s" disabled={running !== null} onClick={() => setAsking(null)}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </Notice>
      {outcome !== null && <Notice tone={outcome.tone}>{outcome.text}</Notice>}
      {error !== null && <ErrorNotice error={error} />}
    </>
  );
}
