import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { EngineError, UnreadableLaunch } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { useNavigate } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";
import { ScreenTitle } from "../../ui/ScreenTitle";
import { useMounted } from "../photos/shared";
import { historyRow, historySub, unreadableEntry, type HistoryRow } from "./historyModel";
import { useLaunchList } from "./useLaunches";

// S4.9c: «История запусков» (AutopilotS4.dc.html state history; LaunchStates «История»): every launch of the library, newest first — when, whose faces and
// names, videos done of planned, «Потрачено $S из $W′», its status — each row a button to its page. An entry the engine cannot read as a launch blocks a new
// one until it is gone: «Убрать запись» moves its file to the library's quarantine (`autopilot.removeUnreadable` by its opaque `entryId`); a folder that could
// not be read at all (`io-error`) has no file to move, and says so instead. The rows sit first: they are what stands in the way.

export function HistoryScreen({ focus }: { focus: string | null }) {
  const view = useEngineView();
  const navigate = useNavigate();
  const { list, reread } = useLaunchList();
  const names = useMemo(() => new Map(view.avatars.map((a) => [a.avatarId, a.name])), [view.avatars]);
  const masters = useMemo(() => new Map(view.avatars.map((a) => [a.avatarId, a.masterPhotoId])), [view.avatars]);
  const nameOf = useCallback((avatarId: string): string | null => names.get(avatarId) ?? null, [names]);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const titleRef = useRef<HTMLDivElement>(null);
  /** Where the focus goes once the list shows (back from a launch: its row; after «Убрать запись»: the next row, or the title). */
  const [focusTo, setFocusTo] = useState<{ readonly key: string | null } | null>(focus === null ? null : { key: focus });

  const ready = list.state === "ready" ? list : null;
  const launches = ready?.launches ?? [];
  const unreadable = ready?.unreadable ?? [];
  const rows = launches.map((summary) => historyRow(summary, nameOf));
  const keys = [...unreadable.map((u) => `bad:${u.entryId}`), ...rows.map((r) => r.launchId)];

  useEffect(() => {
    if (focusTo === null || ready === null) return;
    setFocusTo(null);
    const el = focusTo.key === null ? null : (rowRefs.current.get(focusTo.key) ?? null);
    (el ?? titleRef.current?.querySelector<HTMLElement>("h1"))?.focus();
  }, [focusTo, ready]);

  const removed = (entryId: string): void => {
    const at = keys.indexOf(`bad:${entryId}`);
    const next = keys.filter((k) => k !== `bad:${entryId}`)[at] ?? null;
    setFocusTo({ key: next });
    reread();
  };

  return (
    <div className="page ap-page ap-history-page">
      <header className="ap-launch-head">
        <div ref={titleRef} className="ap-launch-head-text">
          <button type="button" className="back-link" onClick={() => navigate({ name: "section", id: "autopilot" })}>
            <Icon name="back" size={14} strokeWidth={2.4} />
            Автопилот
          </button>
          <ScreenTitle>История запусков</ScreenTitle>
          {ready !== null && <p className="mono muted ap-launch-meta">{historySub(launches.length, unreadable.length)}</p>}
        </div>
      </header>

      {list.state === "failed" && (
        <ErrorNotice
          error={list.error}
          actions={
            <button type="button" className="btn btn-s" onClick={reread}>
              Повторить
            </button>
          }
        />
      )}
      {list.state === "loading" && (
        <p className="muted ap-launch-loading" role="status">
          Читаем историю…
        </p>
      )}

      {ready !== null &&
        (launches.length === 0 && unreadable.length === 0 ? (
          <section className="card ap-history-empty" aria-label="Запуски">
            <span className="ap-empty-title">Запусков пока не было</span>
            <span className="faint">Первый запуск появится здесь сразу после «Запустить».</span>
          </section>
        ) : (
          <>
            <section className="card ap-history" aria-label="Запуски">
              <div className="ap-hrow ap-hrow-head" aria-hidden="true">
                <span>Когда</span>
                <span>Аватары</span>
                <span>Видео</span>
                <span>Потрачено</span>
                <span>Статус</span>
                <span />
              </div>
              {unreadable.map((entry) => (
                <UnreadableRow
                  key={entry.entryId}
                  entry={entry}
                  rowRef={(el) => {
                    if (el === null) rowRefs.current.delete(`bad:${entry.entryId}`);
                    else rowRefs.current.set(`bad:${entry.entryId}`, el);
                  }}
                  onRemoved={() => removed(entry.entryId)}
                  onReread={reread}
                />
              ))}
              {rows.map((row) => (
                <LaunchRow
                  key={row.launchId}
                  row={row}
                  masters={masters}
                  rowRef={(el) => {
                    if (el === null) rowRefs.current.delete(row.launchId);
                    else rowRefs.current.set(row.launchId, el);
                  }}
                  onOpen={() => navigate({ name: "launch", launchId: row.launchId, from: "history" })}
                />
              ))}
            </section>
            <p className="faint ap-history-foot">
              Потрачено — по журналу расходов: закрытые запросы по цене, открытые — по худшей, пока не сверены. «из» — предел запуска: худшая цена плана на старте, не больше
              принятой кликом «Запустить».
            </p>
          </>
        ))}
    </div>
  );
}

function LaunchRow({ row, masters, rowRef, onOpen }: { row: HistoryRow; masters: ReadonlyMap<string, string>; rowRef: (el: HTMLButtonElement | null) => void; onOpen: () => void }) {
  return (
    <button ref={rowRef} type="button" className="ap-hrow" aria-label={row.aria} onClick={onOpen}>
      <span className="ap-hrow-when">
        <b>{row.day}</b>
        <span className="mono faint">{row.span}</span>
      </span>
      <span className="ap-hrow-who">
        <span className="ap-faces" aria-hidden="true">
          {row.faces.slice(0, 5).flatMap((avatarId) => {
            const master = masters.get(avatarId);
            return master === undefined
              ? []
              : [
                  <span key={avatarId} className="ph ap-face">
                    <Portrait avatarId={avatarId} photoId={master} label="" />
                  </span>,
                ];
          })}
        </span>
        <span className="ap-hrow-names">{row.names}</span>
      </span>
      <span className="mono ap-hrow-n">{row.videos}</span>
      <span className="mono ap-hrow-n">
        {row.spent} <span className="faint">{row.of}</span>
      </span>
      <span>
        <span className={`tag ap-st ap-st-${row.tag.tone}`}>{row.tag.text}</span>
      </span>
      <span className="ap-hrow-go" aria-hidden="true">
        <Icon name="forward" size={16} />
      </span>
    </button>
  );
}

function UnreadableRow({ entry, rowRef, onRemoved, onReread }: { entry: UnreadableLaunch; rowRef: (el: HTMLElement | null) => void; onRemoved: () => void; onReread: () => void }) {
  const { client } = useEngine();
  const mounted = useMounted();
  const ids = useId();
  const text = unreadableEntry(entry.reason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const reply = await client.request("autopilot.removeUnreadable", { entryId: entry.entryId });
    if (!mounted.current) return;
    setBusy(false);
    if (reply.ok) onRemoved();
    else if (reply.error.code === "NOT_FOUND") {
      // The file reads fine now, or is gone already: the list says which.
      onReread();
    } else setError(reply.error);
  };

  return (
    <div ref={rowRef} className="ap-hrow-bad" role="group" aria-labelledby={`${ids}-t`} aria-describedby={`${ids}-d`} tabIndex={-1}>
      <div className="ap-hrow ap-hrow-badrow">
        <span id={`${ids}-t`} className="ap-hrow-bad-title">
          <Icon name="alert" size={16} />
          {text.title}
        </span>
        <span id={`${ids}-d`} className="muted ap-hrow-bad-text">
          {text.text}
        </span>
        <span>
          <span className="tag ap-st ap-st-warn">не читается</span>
        </span>
        <span />
      </div>
      <div className="ap-hrow-bad-act">
        <span className="faint">{text.note}</span>
        {text.removable ? (
          <button type="button" className="btn btn-s" aria-busy={busy || undefined} disabled={busy} onClick={() => void remove()}>
            {busy && <Spin />}
            Убрать запись
          </button>
        ) : (
          <button type="button" className="btn btn-s" onClick={onReread}>
            Прочитать снова
          </button>
        )}
      </div>
      {error !== null && <ErrorNotice error={error} />}
    </div>
  );
}
