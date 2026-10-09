import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAUNCH_MAX_VIDEO_MS, type EngineError, type LaunchPreview, type MediaSummary } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { countOf, NBSP, plural } from "../../lib/format";
import { placeholderGradient } from "../../lib/media";
import { Spin } from "../../ui/Icon";
import { ErrorNotice } from "../../ui/Notice";
import { useMounted } from "../photos/shared";
import { durationPill } from "../photos/videosModel";

// S4.9c: «Музыка для автопилота», the window of the chip «Тренды + мои» (ApPlanMusic; LaunchStates «Музыка»): the stored trends the autopilot may take (none
// marked E), the owner's own tracks each with «для автопилота» (`media.setForAutopilot`, free, saved at once), and when the trends refresh by themselves.
// Not modal: the plan behind it is asked again as the marks change. It opens with the focus on the first track's mark; Tab goes round inside; Escape or
// «Готово» close it and the focus goes back to what opened it (the chip, or «Мои треки…» of the waiting-music notice).

const TRACKS = ["трек", "трека", "треков"] as const;
const TRENDS_FIT = ["подходит", "подходят", "подходят"] as const;
const MARKED = ["отмечен", "отмечены", "отмечены"] as const;

type TrackList = { readonly state: "loading" } | { readonly state: "ready"; readonly tracks: readonly MediaSummary[] } | { readonly state: "failed"; readonly error: EngineError };

/** The owner's own tracks (`media.list {kind: "audio"}`), kept current by `media.changed`, listed again after a resync. */
function useOwnTracks(): { readonly list: TrackList; readonly retry: () => void } {
  const { client, store } = useEngine();
  const ready = useEngineView().phase === "ready";
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<TrackList>({ state: "loading" });
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("media.list", { kind: "audio" }).then((reply) => {
      if (alive) setList(reply.ok ? { state: "ready", tracks: reply.result.media } : { state: "failed", error: reply.error });
    });
    const stop = store.subscribeMedia((signal) => {
      if (!alive) return;
      if (signal.change === "resynced") {
        setAttempt((n) => n + 1);
        return;
      }
      setList((now) => {
        if (now.state !== "ready") return now;
        if (signal.change === "removed") return { state: "ready", tracks: now.tracks.filter((t) => t.mediaId !== signal.mediaId) };
        if (signal.media.kind !== "audio") return now;
        const known = now.tracks.some((t) => t.mediaId === signal.media.mediaId);
        return { state: "ready", tracks: known ? now.tracks.map((t) => (t.mediaId === signal.media.mediaId ? signal.media : t)) : [signal.media, ...now.tracks] };
      });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [ready, client, store, attempt]);
  return { list, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

/** The line at the window's foot: whether the autopilot refreshes the trends by itself at the start, and the quota it leaves. */
export function autoRefreshLine(music: LaunchPreview["music"] | null): string | null {
  if (music === null) return null;
  const left = music.quotaRemaining === null ? "" : ` Осталось ${music.quotaRemaining} из 30 запросов.`;
  switch (music.autoRefresh) {
    case "will":
      return `Обновим тренды при запуске: ${music.candidates < 10 ? "подходящих меньше 10" : "список старше 3 дней"}.${left}`;
    case "not-needed":
      return `Тренды свежие — при запуске обновлять не нужно.${left}`;
    case "no-quota":
      return `Тренды сами не обновим: запросов осталось мало — бережём их для вас.${left}`;
    case "no-key":
      return "Нет ключа музыки — тренды не обновить. Ключ — в Настройках.";
  }
}

/** A track's note: its length, and that it fits only the shorter videos when it is under 10 s. */
export function trackNote(track: MediaSummary): string {
  const length = track.durationMs === null ? "—" : durationPill(track.durationMs);
  return track.durationMs !== null && track.durationMs < LAUNCH_MAX_VIDEO_MS ? `${length} · короче 10${NBSP}с — только для коротких` : length;
}

export interface MusicDialogProps {
  /** The plan's word on the music (the trends that fit, the E skipped, the auto refresh); null when no plan has been asked yet. */
  readonly music: LaunchPreview["music"] | null;
  /** The chip it hangs from. */
  readonly anchor: HTMLElement | null;
  readonly wide: boolean;
  readonly onClose: () => void;
  /** A mark changed: the plan is asked again. */
  readonly onChanged: () => void;
  readonly returnFocus: () => HTMLElement | null;
}

export function MusicDialog({ music, anchor, wide, onClose, onChanged, returnFocus }: MusicDialogProps) {
  const ids = useId();
  const { client } = useEngine();
  const mounted = useMounted();
  const { list, retry } = useOwnTracks();
  const popRef = useRef<HTMLElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<EngineError | null>(null);
  const placedFocus = useRef(false);
  const latest = useRef({ onClose, returnFocus });
  useLayoutEffect(() => {
    latest.current = { onClose, returnFocus };
  });
  const width = wide ? 340 : 300;

  // Beside the settings column, its arrow at the chip, inside the window.
  useLayoutEffect(() => {
    const measure = (): void => {
      const pop = popRef.current;
      if (pop === null || anchor === null) return;
      const chip = anchor.getBoundingClientRect();
      const column = anchor.closest(".ap-settings")?.getBoundingClientRect() ?? chip;
      const height = pop.offsetHeight;
      const center = chip.top + chip.height / 2;
      const top = Math.max(16, Math.min(window.innerHeight - height - 16, center - Math.min(height - 40, 150)));
      setPlace({ left: Math.min(column.right + 12, window.innerWidth - width - 16), top, arrow: Math.max(14, Math.min(height - 24, center - top - 6)) });
    };
    measure();
    window.addEventListener("resize", measure);
    // The settings column scrolls: the window follows its chip.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor, width, list.state]);
  // At 1200 the chip may sit below the column's fold: it is brought into view as the window opens (ApPlanMusic at 1200).
  useLayoutEffect(() => {
    if (anchor !== null && typeof anchor.scrollIntoView === "function") anchor.scrollIntoView({ block: "center" });
  }, [anchor]);

  // The focus goes in once the tracks are listed (the first mark), or to «Готово» when there are none; and back out when the window closes.
  useEffect(() => {
    if (placedFocus.current || list.state === "loading") return;
    placedFocus.current = true;
    const first = popRef.current?.querySelector<HTMLElement>('[role="switch"]:not([aria-disabled="true"])');
    (first ?? doneRef.current)?.focus();
  }, [list.state]);
  useEffect(() => {
    popRef.current?.focus();
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || popRef.current?.contains(target) === true || anchor?.contains(target) === true) return;
      latest.current.onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      const inside = popRef.current?.contains(document.activeElement) === true || document.activeElement === document.body;
      if (inside) latest.current.returnFocus()?.focus();
    };
  }, [anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(popRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === popRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const toggle = async (track: MediaSummary): Promise<void> => {
    if (busy.has(track.mediaId) || refused.has(track.mediaId)) return;
    setBusy((now) => new Set(now).add(track.mediaId));
    setError(null);
    const reply = await client.request("media.setForAutopilot", { mediaId: track.mediaId, on: track.forAutopilot !== true });
    if (!mounted.current) return;
    setBusy((now) => {
      const next = new Set(now);
      next.delete(track.mediaId);
      return next;
    });
    if (reply.ok) {
      onChanged();
      return;
    }
    // A track stored outside an m4a cannot go into a render: the engine says so only now (the record does not), and the mark stays off.
    if (reply.error.code === "MEDIA_UNSUPPORTED") setRefused((now) => new Set(now).add(track.mediaId));
    else if (reply.error.code === "NOT_FOUND") retry();
    else setError(reply.error);
  };

  const tracks = list.state === "ready" ? list.tracks : [];
  const flagged = tracks.filter((t) => t.forAutopilot === true).length;
  const trends = music === null ? null : Math.max(0, music.candidates - music.ownFlagged);
  const refresh = autoRefreshLine(music);

  return createPortal(
    <section
      ref={popRef}
      className="ap-music-pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${ids}-t`}
      tabIndex={-1}
      style={{ width, left: place?.left ?? -9999, top: place?.top ?? 0, visibility: place === null ? "hidden" : undefined }}
      onKeyDown={onKeyDown}
    >
      <span className="pop-arrow" aria-hidden="true" style={{ top: place?.arrow ?? 20 }} />
      <div className="ap-music-head">
        <b id={`${ids}-t`}>Музыка для автопилота</b>
        <span className="mono faint">бесплатно</span>
      </div>
      {music !== null && trends !== null && (
        <div className="ap-music-part">
          <div className="ap-music-row">
            <span>Тренды</span>
            <span className="mono muted">
              {trends} {plural(trends, TRENDS_FIT)}
            </span>
          </div>
          <span className="faint ap-music-note">
            Сохранённые тренды без пометки E{music.explicitSkipped > 0 ? ` — ${countOf(music.explicitSkipped, TRACKS)} с пометкой пропускаем` : ""}. Тренд, что реже всего был у аватара, — первым.
          </span>
        </div>
      )}
      <div className="ap-music-part ap-music-own">
        <div className="ap-music-row">
          <span id={`${ids}-own`}>Мои треки</span>
          {list.state === "ready" && tracks.length > 0 && (
            <span className="mono muted">
              {flagged} из {tracks.length} {plural(flagged, MARKED)}
            </span>
          )}
        </div>
        {list.state === "loading" && <span className="faint ap-music-note">Читаем свои треки…</span>}
        {list.state === "failed" && (
          <ErrorNotice
            error={list.error}
            actions={
              <button type="button" className="btn btn-s" onClick={retry}>
                Повторить
              </button>
            }
          />
        )}
        {list.state === "ready" && tracks.length === 0 && <span className="faint ap-music-note">Своих треков пока нет — их добавляют в «Монтаже», вкладка «Мои».</span>}
        {tracks.length > 0 && (
          <ul className="ap-trks" aria-labelledby={`${ids}-own`}>
            {tracks.map((track) => {
              const off = refused.has(track.mediaId);
              const on = track.forAutopilot === true && !off;
              const working = busy.has(track.mediaId);
              return (
                <li key={track.mediaId} className={off ? "ap-trk ap-trk-off" : "ap-trk"}>
                  <span className="ap-trk-cover" aria-hidden="true" style={{ background: placeholderGradient(track.mediaId) }} />
                  <span className="ap-trk-text">
                    <span className="ap-trk-name">{track.name}</span>
                    <span className="mono faint ap-trk-note">{off ? "не m4a — отметить нельзя" : trackNote(track)}</span>
                  </span>
                  {working && <Spin />}
                  <button
                    type="button"
                    className={on ? "sw sw-s sw-on" : "sw sw-s"}
                    role="switch"
                    aria-checked={on}
                    aria-label={`Для автопилота: ${track.name}`}
                    aria-disabled={off || working || undefined}
                    title={off ? "Автопилот берёт только m4a с известной длиной" : undefined}
                    onClick={off || working ? undefined : () => void toggle(track)}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <span className="faint ap-music-note">Свои треки автопилот берёт только с отметкой «для автопилота». Та же отметка — в «Монтаже», вкладка «Мои».</span>
        {error !== null && <ErrorNotice error={error} />}
      </div>
      <div className="ap-music-foot">
        <span className="faint ap-music-note">{refresh ?? ""}</span>
        <button ref={doneRef} type="button" className="btn btn-s" onClick={onClose}>
          Готово
        </button>
      </div>
    </section>,
    document.body,
  );
}
