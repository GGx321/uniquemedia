import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { MontageDraft } from "../../../shared/engine";
import { STEP_MS } from "../../../shared/montage";
import { useEngine } from "../../engine/react";
import { NBSP } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { totalMs } from "./clipOps";
import { DRAG_THRESHOLD_PX, trackPointer } from "./gesture";
import { trackClock } from "./labels";
import { deleteKeyHandler } from "./LayerProperties";
import type { MediaTab } from "./MediaPanel";
import { clampMusicStart, highlightPicks, musicStartRange, musicWindow, setMusicStart, trackProblem, type TrackVerdict } from "./musicOps";
import { Cover, trackLength } from "./MusicTab";
import { type PlayableFacts, playableFacts, type TrackLookup, usePeaks } from "./MusicTrack";
import type { DraftSession } from "./session";
import { type TimelineState, useSelectionCommands } from "./useTimeline";

// 3d.5: the music card (EditorMusic.dc.html, `sel = music`; R42–R51). The track's cover and facts, «Лучшая часть»: the WHOLE track's
// waveform (`music.peaks`, 68 bars, free) with the highlights as ★ and a window as long as the montage where the music starts. The
// window drags (and is a slider: ←/→ 0.1 s, ⇧ 1 s, Home/End) in 100 ms steps (AM8), never so late that the montage runs past the
// track's end; the chips are quick picks, ascending with the likely `1500` default last (CF6), one undo step each. The copy follows
// A5 (CF7): the level is the track's own, only peaks are lowered. The 3d.3b block on the timeline moves the same start.
// The owner's feedback (2026-10-05) took R49's «Послушать» (it played the montage from its start, as the main ▶ and Space do) and
// «Заменить трек» (it opened the «Музыка» tab the left panel already shows) off the card. Only a track that cannot be used (gone, too
// short, out of the list) still points to the tabs that hold another one: «Музыка» and «Мои».

/** The artboard's waveform: 68 bars over the whole track (K26). */
const CARD_BARS = 68;

function Star() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" fill="currentColor" />
    </svg>
  );
}

/**
 * The whole track and the montage's window over it: drag it, click elsewhere to move it there, or use the keys. A drag is shown
 * as a slip of the window alone (review round 1: the draft is not written on every move) and is ONE edit when it is let go; a
 * cancelled pointer (`pointercancel`) changes nothing; a click that does not drag moves the window to the click on release.
 */
function TrackWindow({ session, track, startMs, total, peaks }: { session: DraftSession; track: PlayableFacts; startMs: number; total: number; peaks: readonly number[] | null }) {
  const strip = useRef<HTMLDivElement>(null);
  const gesture = useRef<(() => void) | null>(null);
  const heldKey = useRef<string | null>(null);
  /** Where a drag holds the window while the pointer is down; null when nothing is being dragged. */
  const [slip, setSlip] = useState<number | null>(null);
  const trackMs = track.durationMs;
  const shownMs = slip ?? startMs;
  const range = musicStartRange(startMs, total, trackMs);
  const win = musicWindow(shownMs, total, trackMs);
  const marks = track.highlights.filter((h) => !h.likelyDefault && h.ms < trackMs);

  useEffect(() => () => gesture.current?.(), []);

  /** Where the music would start for `wanted`: the 100 ms step, held to where it may start in the draft as it is now. */
  function startFor(wanted: number): number | null {
    const current = session.state.spec;
    if (current.music === null) return null;
    return clampMusicStart(current.music.startMs, Math.round(wanted / STEP_MS) * STEP_MS, totalMs(current), trackMs);
  }

  /** The music from `wanted`, as one undo step (or a step of `mergeKey`'s gesture: a held key). */
  function moveTo(wanted: number, mergeKey?: string): void {
    const at = startFor(wanted);
    const current = session.state.spec;
    if (at === null) return;
    const edit = setMusicStart(current, at, trackMs);
    if (edit.ok && edit.spec !== current) session.edit(edit.spec, mergeKey === undefined ? {} : { mergeKey });
  }

  function press(event: ReactPointerEvent<HTMLDivElement>): void {
    const rect = strip.current?.getBoundingClientRect();
    if (event.button !== 0 || rect === undefined || rect.width <= 0) return;
    event.preventDefault();
    const msAt = (x: number): number => ((x - rect.left) / rect.width) * trackMs;
    const startX = event.clientX;
    // Pressed inside the window, it is held where it was taken; anywhere else, the window's start follows the pointer.
    const inside = msAt(startX) >= startMs && msAt(startX) <= startMs + total;
    const grab = inside ? msAt(startX) - startMs : 0;
    let moved = false;
    let last: number | null = null;
    gesture.current?.();
    gesture.current = trackPointer(
      event,
      (move) => {
        if (!moved && Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
        moved = true;
        last = startFor(msAt(move.clientX) - grab);
        setSlip(last);
      },
      (end) => {
        gesture.current = null;
        setSlip(null);
        // The system took the pointer: nothing moves.
        if (end === null) return;
        if (moved) {
          if (last !== null) moveTo(last);
        } else if (!inside) moveTo(msAt(end.clientX));
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.shiftKey ? 1_000 : STEP_MS;
    const targets: Record<string, number> = {
      ArrowLeft: startMs - step,
      ArrowDown: startMs - step,
      ArrowRight: startMs + step,
      ArrowUp: startMs + step,
      PageDown: startMs - 1_000,
      PageUp: startMs + 1_000,
      Home: range.min,
      End: range.max,
    };
    const wanted = targets[event.key];
    if (wanted === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    heldKey.current = event.key;
    // Held keys repeat: one undo step until the key is let go.
    moveTo(wanted, "music-window-key");
  }

  return (
    <div className={slip === null ? "ed-hl" : "ed-hl ed-hl-moving"} ref={strip} onPointerDown={press}>
      <div className="ed-hl-marks" aria-hidden="true">
        {marks.map((h) => (
          <span key={h.ms} className={h.ms === shownMs ? "ed-hl-mark ed-hl-mark-on" : "ed-hl-mark"} style={{ left: `calc(3px + (100% - 6px) * ${h.ms / trackMs})` }}>
            <Star />
          </span>
        ))}
      </div>
      <div className="ed-hl-wave" aria-hidden="true">
        {(peaks ?? Array.from({ length: CARD_BARS }, () => 0)).map((peak, i, all) => {
          const at = (i + 0.5) / all.length;
          const inside = at >= win.from && at < win.from + win.width;
          return <span key={i} className={inside ? "ed-hl-bar ed-hl-bar-in" : "ed-hl-bar"} style={{ height: `${Math.max(3, Math.round(4 + (22 * peak) / 1000))}px` }} />;
        })}
      </div>
      <div
        className="ed-hl-window"
        role="slider"
        tabIndex={0}
        aria-label="Начало музыки в треке"
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={shownMs}
        aria-valuetext={`с ${trackClock(shownMs)}`}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
        style={{ left: `calc(3px + (100% - 6px) * ${win.from})`, width: `calc((100% - 6px) * ${win.width})` }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key !== heldKey.current) return;
          heldKey.current = null;
          session.endMerge();
        }}
        onBlur={() => {
          heldKey.current = null;
          session.endMerge();
        }}
      />
    </div>
  );
}

export interface MusicCardProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  readonly lookup: TrackLookup;
  /** When the track list was last fetched: a new list asks for the waveform again. */
  readonly listVersion: string | null;
  /** The engine's verdict on the track for the spec on screen. */
  readonly verdict: TrackVerdict;
  /** Opens a tab that holds another track (the focus goes to it): offered only while this one cannot be used. */
  readonly onOpenTab: (tab: TrackTab) => void;
}

/** The media panel's tabs that hold tracks: the trending list and the owner's own files. */
export type TrackTab = Extract<MediaTab, "music" | "mine">;

/**
 * A trending track out of the list, before the engine has judged it: its facts are unknown, and it is picked again in «Музыка» (review round 2:
 * not sent to «Мои», which holds no trending track).
 */
function UnlistedSwap({ onOpenTab }: { onOpenTab: (tab: TrackTab) => void }) {
  return (
    <p className="faint ed-music-swap">
      Длина и лучшие части этого трека неизвестны: выберите его снова во вкладке{" "}
      <button type="button" className="ed-link" aria-label="Открыть вкладку «Музыка»" onClick={() => onOpenTab("music")}>
        «Музыка»
      </button>{" "}
      или другой трек.
    </p>
  );
}

/** «Другой трек — во вкладке «Музыка» или «Мои»»: where another track is picked, said for a track that cannot be used. */
function TrackSwap({ onOpenTab }: { onOpenTab: (tab: TrackTab) => void }) {
  return (
    <p className="faint ed-music-swap">
      Другой трек — во вкладке{" "}
      <button type="button" className="ed-link" aria-label="Открыть вкладку «Музыка»" onClick={() => onOpenTab("music")}>
        «Музыка»
      </button>{" "}
      или{" "}
      <button type="button" className="ed-link" aria-label="Открыть вкладку «Мои»" onClick={() => onOpenTab("mine")}>
        «Мои»
      </button>
      .
    </p>
  );
}

export function MusicProperties({ session, spec, timeline, lookup, listVersion, verdict, onOpenTab }: MusicCardProps) {
  const { client } = useEngine();
  const commands = useSelectionCommands(session, timeline);
  const onKeyDown = deleteKeyHandler(commands.remove);
  const music = spec.music;
  /** A trending track as `music.list` describes it (its cover, artist, «E» and highlights), and an own one as `media.list` does (3f.4: a name and a length). */
  const track = lookup.state === "listed" ? lookup.track : null;
  const own = lookup.state === "own" ? lookup.track : null;
  const facts = playableFacts(lookup);
  const ask =
    music === null || facts === null || facts.durationMs <= 0
      ? null
      : music.source === "own"
        ? { mediaId: music.mediaId, startMs: 0, durationMs: facts.durationMs, bars: CARD_BARS }
        : track === null
          ? null
          : { trackId: track.trackId, startMs: 0, durationMs: track.durationMs, bars: CARD_BARS };
  const { peaks, missing } = usePeaks(client, ask, listVersion);
  if (music === null) return null;
  const total = totalMs(spec);
  const problem = trackProblem({ missing: missing !== null, verdict, guessTooShort: facts !== null && music.startMs + total > facts.durationMs });
  const picks = facts === null ? [] : highlightPicks(facts.highlights, music.startMs, total, facts.durationMs);
  // A track that cannot be used, or whose facts are no longer known, is replaced from a tab: the card says which.
  const swap = problem !== null || lookup.state === "unlisted" || lookup.state === "own-gone";

  function pick(ms: number): void {
    if (facts === null) return;
    const edit = setMusicStart(session.state.spec, ms, facts.durationMs);
    if (edit.ok && edit.spec !== session.state.spec) session.edit(edit.spec);
  }

  return (
    <aside className="ed-props" aria-label="Свойства" data-slot="properties 3d.5" onKeyDown={onKeyDown}>
      <div className="ed-props-top">
        <div className="ed-props-head">
          <span className="lbl">Музыка</span>
          <span className="mono faint ed-props-sub">
            0–{(total / 1000).toFixed(1)}
            {NBSP}с · весь ролик
          </span>
        </div>
        <div className="ed-props-actions">
          <button type="button" className="ibtn" aria-label="Удалить" title="Без музыки видео получит тишину той же длины" onClick={() => void commands.remove()}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      <div className="ed-music-card">
        {track !== null ? <Cover track={track} className="ed-music-cover" /> : <span className="ed-music-cover ed-music-cover-none" aria-hidden="true" />}
        <span className="ed-music-facts">
          <span className="ed-music-name">
            {track !== null ? track.title : own !== null ? own.name : lookup.state === "unlisted" ? "Трек из прежнего списка" : lookup.state === "own-gone" ? "Свой трек: файла больше нет" : "Трек…"}
          </span>
          {track !== null && <span className="muted">{track.artist ?? "исполнитель не указан"}</span>}
          {own !== null && <span className="muted">свой трек</span>}
          <span className="mono faint">
            {track !== null
              ? `${trackLength(track.durationMs)} · тренд Instagram${track.explicit ? " · E" : ""}`
              : own !== null
                ? `${trackLength(own.durationMs)} · свой файл`
                : lookup.state === "unlisted"
                  ? "его нет в нынешнем списке"
                  : " "}
          </span>
        </span>
      </div>

      {problem !== null && (
        <div className="ed-music-trouble">
          <p className="ed-music-problem" role="status">
            <Icon name="alert" size={14} />
            <span>{problem === "unavailable" ? "Трека больше нет в Studio: видео с ним не соберётся. Замените трек." : "Трек кончается раньше ролика: начните его раньше или замените трек."}</span>
          </p>
          <TrackSwap onOpenTab={onOpenTab} />
        </div>
      )}

      {facts !== null ? (
        <div className="ed-pgroup">
          <div className="ed-prow">
            {/* An own track has no highlights of Instagram's: the window is the whole of what it offers. */}
            <span className="lbl">{track !== null ? "Лучшая часть" : "Начало музыки"}</span>
            <span className="mono faint ed-props-sub">{track !== null ? `от Instagram · ${track.highlights.length}` : "свой файл"}</span>
          </div>
          <TrackWindow session={session} track={facts} startMs={music.startMs} total={total} peaks={peaks?.peaks ?? null} />
          {picks.length > 0 && (
            <div className="ed-hl-picks" role="group" aria-label="Выбрать лучшую часть">
              {picks.map((p) => (
                <button
                  key={p.ms}
                  type="button"
                  className={["chip", p.on ? "chip-on" : "", p.likelyDefault ? "ed-hl-default" : ""].filter(Boolean).join(" ")}
                  aria-pressed={p.on}
                  aria-label={p.likelyDefault ? `С ${trackClock(p.ms)}, похоже на начало трека` : `Лучшая часть с ${trackClock(p.ms)}`}
                  disabled={!p.fits}
                  title={!p.fits ? "Отсюда трек кончится раньше ролика" : p.likelyDefault ? "Похоже, это просто начало трека, а не выбранная часть" : undefined}
                  onClick={() => pick(p.ms)}
                >
                  {!p.likelyDefault && <Star />}
                  <span className="mono">{trackClock(p.ms)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="ed-prow">
            <span className="faint ed-props-sub">звучит в ролике</span>
            <span className="mono ed-hl-range">
              {trackClock(music.startMs)} → {trackClock(music.startMs + total)}
            </span>
          </div>
        </div>
      ) : null}
      {/* Without a reason on screen (the verdict not in yet), a track out of the list or out of the library still says, once, where to pick it
          again or another one (review round 1: one line, not the old hint and this one). */}
      {problem === null && swap && (lookup.state === "unlisted" ? <UnlistedSwap onOpenTab={onOpenTab} /> : <TrackSwap onOpenTab={onOpenTab} />)}

      <p className="ed-music-copy">
        <Icon name="check" size={13} strokeWidth={2.6} />
        Громкость трека не меняется, при рендере приглушаются только пики. Трек длиннее ролика обрежется по его концу.
      </p>
    </aside>
  );
}
