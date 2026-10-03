import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { MontageDraft, MontageMusic, TrackSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { useEngine } from "../../engine/react";
import { Icon } from "../../ui/Icon";
import { totalMs } from "./clipOps";
import { DRAG_THRESHOLD_PX, type GestureKit } from "./gesture";
import { musicAria, trackClock, trackName } from "./labels";
import { atHighlight, clampMusicStart, highlightMarks, setMusicStart, slipStart, trackProblem, type TrackVerdict, waveBars } from "./musicOps";
import type { DraftSession } from "./session";
import { TIMELINE_MS } from "./timelineScale";
import type { TimelineState } from "./useTimeline";

// 3d.3b: the music track (Editor.dc.html's bottom lane; the components sheet's «Музыка на дорожке · метка лучшей части»).
// One block over the whole montage: the track's waveform for the part of it the montage plays (`music.peaks`, K26), the
// start in the track («★ 0:42», the ★ when it is one of the track's highlights), the title, and the highlights that fall
// inside as marks. A drag moves where the music starts (100 ms steps, AM8; the waveform follows the pointer), never past
// the last start that keeps the whole montage inside the track. Choosing a track is the media panel's (SLOT 3d.5): with no
// music the lane offers «Добавить музыку», «Скоро» until then.

/** What the editor knows of the draft's track from `music.list` (K23). */
export type TrackLookup =
  | { readonly state: "none" }
  /** Asked, not answered yet (or the ask failed): no title to show. */
  | { readonly state: "loading" }
  | { readonly state: "listed"; readonly track: TrackSummary }
  /** A stored track the current list no longer offers (tracks of earlier lists are kept, not offered: 3c.4). */
  | { readonly state: "unlisted" }
  /** An own track (3f): nothing to look up yet. */
  | { readonly state: "own" };

/** The draft's trending track as `music.list` describes it; asked again for another track and whenever the list changes. */
export function useTrackSummary(client: EngineClient, music: MontageMusic, listVersion: string | null): TrackLookup {
  const trackId = music?.source === "trending" ? music.trackId : null;
  const [found, setFound] = useState<{ trackId: string; track: TrackSummary | null } | null>(null);
  useEffect(() => {
    if (trackId === null) return;
    let alive = true;
    void client.request("music.list", {}).then((reply) => {
      // A failed read leaves the title unknown («loading»): nothing but the words depends on it.
      if (alive && reply.ok) setFound({ trackId, track: reply.result.tracks.find((t) => t.trackId === trackId) ?? null });
    });
    return () => {
      alive = false;
    };
  }, [client, trackId, listVersion]);
  if (music === null) return { state: "none" };
  if (trackId === null) return { state: "own" };
  if (found === null || found.trackId !== trackId) return { state: "loading" };
  return found.track === null ? { state: "unlisted" } : { state: "listed", track: found.track };
}

/** A waveform `music.peaks` answered: the window it is of, and its bars. */
interface Peaks {
  readonly trackId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly peaks: readonly number[];
}

interface PeaksAsk {
  readonly trackId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly bars: number;
}

/**
 * The waveform of `[startMs, startMs + durationMs)` of a trending track, `bars` bars. One ask at a time and the latest one
 * wins: during a drag the start moves faster than the engine answers, so the next ask goes when the one out returns, for
 * wherever the start is by then. The last answer is kept until a newer one comes (the block draws it shifted meanwhile).
 * `missing`: the store does not hold the track (NOT_FOUND). A new `listVersion` (the track list was fetched again) asks
 * again: a track the store lacked may be stored now.
 */
export function usePeaks(client: EngineClient, ask: PeaksAsk | null, listVersion: string | null): { peaks: Peaks | null; missing: string | null } {
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const wanted = useRef<PeaksAsk | null>(ask);
  const out = useRef(false);
  /** Asked again (a new list) while an ask was out: its answer may be older than the list, so the ask goes once more. */
  const again = useRef(false);
  const alive = useRef(true);
  wanted.current = ask;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = ask === null ? null : `${ask.trackId}|${ask.startMs}|${ask.durationMs}|${ask.bars}`;

  useEffect(() => {
    const pump = (): void => {
      const next = wanted.current;
      if (next === null) return;
      if (out.current) {
        again.current = true;
        return;
      }
      out.current = true;
      again.current = false;
      void client.request("music.peaks", { track: { source: "trending", trackId: next.trackId }, startMs: next.startMs, durationMs: next.durationMs, bars: next.bars }).then((reply) => {
        out.current = false;
        if (!alive.current) return;
        if (reply.ok) {
          setPeaks({ trackId: next.trackId, startMs: next.startMs, durationMs: next.durationMs, peaks: reply.result.peaks });
          setMissing(null);
        } else if (reply.error.code === "NOT_FOUND") setMissing(next.trackId);
        const latest = wanted.current;
        const moved = latest !== null && (latest.trackId !== next.trackId || latest.startMs !== next.startMs || latest.durationMs !== next.durationMs || latest.bars !== next.bars);
        if (moved || again.current) pump();
      });
    };
    if (key !== null) pump();
  }, [client, key, listVersion]);

  return { peaks: ask !== null && peaks?.trackId === ask.trackId ? peaks : null, missing: ask !== null && missing === ask.trackId ? missing : null };
}

export interface MusicTrackProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  readonly kit: GestureKit;
  /** The lanes' scale as laid out now. */
  readonly pxPerMs: number;
  readonly lookup: TrackLookup;
  /** When the track list was last fetched (`MusicStatus.listFetchedAt`): a new one asks for the waveform again. */
  readonly listVersion: string | null;
  /** The engine's verdict on the track for the spec on screen, or `judged: false` while it has not judged that spec. */
  readonly verdict: TrackVerdict;
  readonly onSelect: () => void;
  /** «Добавить музыку»: the media panel's «Музыка» tab (SLOT 3d.5); absent, the button is «Скоро». */
  readonly onAddMusic?: () => void;
}

const pct = (ms: number): string => `${(ms / TIMELINE_MS) * 100}%`;
/** The waveform's inset from the block's edges, as drawn. */
const WAVE_INSET_PX = 8;

function Star() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" fill="currentColor" />
    </svg>
  );
}

export function MusicTrack({ session, spec, timeline, kit, pxPerMs, lookup, listVersion, verdict, onSelect, onAddMusic }: MusicTrackProps) {
  const { client } = useEngine();
  const [slip, setSlip] = useState<number | null>(null);
  /** The key holding a keyboard move open: its release ends the undo step. */
  const heldKey = useRef<string | null>(null);
  const music = spec.music;
  const total = totalMs(spec);
  const track = lookup.state === "listed" ? lookup.track : null;
  const startMs = slip ?? music?.startMs ?? 0;
  const widthPx = total * pxPerMs;
  const bars = waveBars(Math.max(0, widthPx - 2 * WAVE_INSET_PX));
  const ask = music?.source === "trending" && total > 0 ? { trackId: music.trackId, startMs, durationMs: total, bars } : null;
  const { peaks, missing } = usePeaks(client, ask, listVersion);

  if (music === null) {
    return (
      <button
        type="button"
        className="ed-lane-music-add"
        disabled={onAddMusic === undefined}
        title={onAddMusic === undefined ? "Музыка — скоро: трек выбирается во вкладке «Музыка»" : total > 0 ? "Без музыки видео получит тишину той же длины" : undefined}
        onClick={onAddMusic}
      >
        <Icon name="plus" size={13} strokeWidth={2.4} />
        Добавить музыку
      </button>
    );
  }

  // The engine judged the committed start; while a drag slides it, the window's guess (the listed length is the proven one) stands.
  const issue = trackProblem({ missing: missing !== null, verdict: slip === null ? verdict : { judged: false }, guessTooShort: track !== null && startMs + total > track.durationMs });
  const selected = timeline.selection?.kind === "music";
  const trackMs = track?.durationMs ?? null;
  const movable = trackMs !== null && total > 0 && issue !== "unavailable";
  const highlights = track?.highlights ?? [];
  const marks = highlightMarks(highlights, startMs, total);
  const title = trackName(lookup);
  // The bars answered for another start are drawn where that music now is, until the answer for this start comes.
  const shiftPx = peaks !== null && peaks.durationMs === total ? (peaks.startMs - startMs) * pxPerMs : 0;

  function press(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0 || music === null) return;
    const from = music.startMs;
    const startX = event.clientX;
    let moved = false;
    let last = from;
    kit.start(
      event,
      (move) => {
        const dx = move.clientX - startX;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        if (!movable || trackMs === null) return;
        moved = true;
        last = clampMusicStart(from, slipStart(from, dx / kit.pxPerMs()), totalMs(session.state.spec), trackMs);
        setSlip(last);
      },
      (end) => {
        setSlip(null);
        if (!moved) return;
        kit.swallowClick();
        // A cancelled drag (the system took the pointer) moves nothing.
        if (end === null || trackMs === null) return;
        const edit = setMusicStart(session.state.spec, last, trackMs);
        if (edit.ok && edit.spec !== session.state.spec) session.edit(edit.spec);
        onSelect();
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!event.altKey || event.metaKey || event.ctrlKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    const current = session.state.spec;
    if (!movable || trackMs === null || current.music === null) return;
    const step = event.shiftKey ? 1_000 : 100;
    // As a drag: the waveform moves the way the arrow points, so → brings earlier music under the playhead.
    const wanted = current.music.startMs + (event.key === "ArrowRight" ? -step : step);
    const edit = setMusicStart(current, clampMusicStart(current.music.startMs, wanted, totalMs(current), trackMs), trackMs);
    heldKey.current = event.key;
    // Held keys repeat: one undo step until the key is let go.
    if (edit.ok && edit.spec !== current) session.edit(edit.spec, { mergeKey: "music-start-key" });
  }

  const classes = ["blk", "ed-music", selected ? "ed-music-on" : "", slip !== null ? "ed-music-moving" : "", issue !== null ? "ed-music-warn" : "", total === 0 ? "ed-music-alone" : "", movable ? "" : "ed-music-fixed"].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={classes}
      style={total > 0 ? { width: `calc(${pct(total)} - 1px)` } : undefined}
      aria-pressed={selected}
      aria-label={musicAria(music, title, issue)}
      aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight Delete" : "Delete"}
      title={movable ? "Тяните, чтобы трек начинался с другого места (⌥← ⌥→)" : issue === "unavailable" ? "Трека больше нет в Studio — выберите другой" : lookup.state === "unlisted" ? "Длина трека неизвестна: чтобы сдвинуть начало, выберите его снова во вкладке «Музыка»" : undefined}
      onPointerDown={press}
      onClick={() => {
        if (kit.clickSwallowed()) return;
        onSelect();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key !== heldKey.current) return;
        heldKey.current = null;
        session.endMerge();
      }}
      onBlur={() => {
        if (heldKey.current === null) return;
        heldKey.current = null;
        session.endMerge();
      }}
    >
      {peaks !== null && (
        <span className="ed-wave" aria-hidden="true" style={shiftPx === 0 ? undefined : { transform: `translateX(${shiftPx}px)` }}>
          {/* The bars are positional: a bar's index is its place in the window. */}
          {peaks.peaks.map((peak, i) => (
            <span key={i} className="ed-wave-bar" style={{ height: `${Math.round(3 + (16 * peak) / 1000)}px` }} />
          ))}
        </span>
      )}
      {marks.map((mark) => (
        <span key={mark.ms} className="ed-wave-mark" aria-hidden="true" style={{ left: `calc(${WAVE_INSET_PX}px + (100% - ${2 * WAVE_INSET_PX}px) * ${mark.at})` }} />
      ))}
      <span className="ed-music-edge" aria-hidden="true" />
      <span className="ctag ed-music-start">
        {atHighlight(highlights, startMs) && <Star />}
        {trackClock(startMs)}
      </span>
      {title !== null && <span className="ctag ed-music-title">{title}</span>}
      {issue !== null && <span className="ctag ed-music-issue">{issue === "unavailable" ? "⚠ трек недоступен" : "⚠ трек короче ролика"}</span>}
      {selected && (
        <>
          <span className="ed-music-hd ed-music-hd-l" aria-hidden="true" />
          <span className="ed-music-hd ed-music-hd-r" aria-hidden="true" />
        </>
      )}
    </button>
  );
}
