import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { MONTAGE_ISSUE_MESSAGES_RU, type MontageDraft } from "../../../shared/engine";
import { MAX_TOTAL_MS, STEP_MS, videoClipCrop } from "../../../shared/montage";
import { Icon } from "../../ui/Icon";
import { roomMs, totalMs } from "./clipOps";
import { DRAG_THRESHOLD_PX, trackPointer } from "./gesture";
import { secondsLabel, trimOfLabel, trimRangeLabel, videoFactsLabel, videoRoomLabel } from "./labels";
import type { OwnVideo, VideoLookup, VideoProblem } from "./ownVideos";
import type { DraftSession } from "./session";
import { growMs, slideTrim, trimEndTo, trimLimits, trimStartTo, trimView } from "./videoTrim";

// 3f.3b: the body of an own video clip's properties (EditorMine.dc.html, `sel = c3`; R16–R20), under ClipProperties' head:
// - «Обрезка» (R16): the whole stored video as a strip, the clip's part of it as a window. The window slides (the length kept), its left edge moves the
//   start (the end kept) and its right edge the end (the start kept); each is also a slider (←/→ 0.1 s, ⇧ 1 s, PageUp/PageDown 1 s, Home/End). Every
//   time lands on the contract's 100 ms grid (videoTrim.ts). A drag moves the window alone while the pointer is down and is ONE edit when let go (a
//   cancelled pointer changes nothing, as the music card's window, 3d.5); a held key is one undo step. Below it «1.8 → 3.8 с» and «2.0 с из 6.4»;
// - what is left of the 15 s, held to what the video still has (R14's line);
// - the render's refusal of this clip, in the contract's own words (`video-too-short`, `media-unavailable`);
// - «Кадр» (R17–R18): the crop is moved in the preview (as a photo's, 3d.4); Q3: no «Масштаб» slider in Stage 3;
// - the source facts (R19) and the V4 note (R20): the video's sound is never used.

/** The artboard's strip: the panel's 300 px less its padding. Used until the strip is laid out (and in tests that lay nothing out). */
const STRIP_PX = 272;
/** The strip's frames, as drawn. */
const STRIP_FRAMES = 10;
/** A window narrower than this (a short clip of a long video) has its two edges outside it, so neither covers the other. */
const NARROW_WINDOW_PX = 24;

type Part = "window" | "start" | "end";
type VideoClip = Extract<MontageDraft["clips"][number], { kind: "video" }>;

const pct = (fraction: number): string => `${fraction * 100}%`;

/** The R18 hint: what dragging the video in the preview can do with it, from its stored size and the frame's 9:16. */
function cropHint(video: OwnVideo): string {
  const crop = videoClipCrop({ w: video.width, h: video.height }, null);
  if (crop.w >= video.width && crop.h >= video.height) return "Видео уже 9:16 и занимает весь кадр — сдвигать нечего.";
  return crop.w < video.width
    ? "Видео шире кадра: в ролик попадает его часть. Тяните видео в превью влево или вправо, чтобы выбрать какую."
    : "Видео выше кадра: в ролик попадает его часть. Тяните видео в превью вверх или вниз, чтобы выбрать какую.";
}

export interface VideoClipBodyProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly index: number;
  /** What the window knows of the clip's video. */
  readonly video: VideoLookup;
  /** What the render refuses the clip for (the engine's verdict, or the window's guess for an edit not judged yet). */
  readonly problem: VideoProblem | null;
}

export function VideoClipBody({ session, spec, index, video, problem }: VideoClipBodyProps) {
  const clip = spec.clips[index];
  if (clip?.kind !== "video") return null;
  const known = video.state === "known" ? video.video : null;
  const total = totalMs(spec);
  const room = roomMs(spec);

  return (
    <>
      <div className="ed-pgroup">
        <span className="lbl">Обрезка</span>
        {known !== null ? (
          <TrimStrip session={session} spec={spec} index={index} sourceMs={known.durationMs} />
        ) : (
          <div className="ed-trim ed-trim-none">
            <span className="faint">{video.state === "gone" ? "Видео нет — обрезать нечего" : "Читаем видео…"}</span>
          </div>
        )}
        {known === null && (
          <div className="ed-prow">
            <span className="mono ed-trim-range">{trimRangeLabel(clip.trimStartMs, clip.trimStartMs + clip.durationMs)}</span>
            <span className="mono faint">{secondsLabel(clip.durationMs)}</span>
          </div>
        )}
        <span className="faint ed-props-note">
          {known !== null ? videoRoomLabel(total, room, growMs(spec, index, known.durationMs)) : `ролик ${secondsLabel(total)} из ${MAX_TOTAL_MS / 1000}`}
        </span>
      </div>

      {problem !== null && (
        // The music card's warning look (3d.5): the render's refusal in the contract's own words.
        <p className="ed-music-problem" role="status">
          <Icon name="alert" size={14} />
          {MONTAGE_ISSUE_MESSAGES_RU[problem]}
        </p>
      )}

      {known !== null && (
        <div className="ed-pgroup ed-pgroup-tight">
          <span className="lbl">Кадр</span>
          <span className="faint ed-props-note">{cropHint(known)}</span>
        </div>
      )}

      <div className="ed-video-card">
        <span className="ed-video-name">{known?.name ?? (video.state === "gone" ? "Файла больше нет" : "Своё видео")}</span>
        {known !== null && <span className="mono muted ed-video-facts">{videoFactsLabel(known)}</span>}
        <span className="ed-video-tags">
          <span className="tag">свой файл</span>
          {known?.hdrToSdr === true && <span className="tag tag-o">HDR → SDR</span>}
        </span>
        <span className="faint ed-video-mute">
          <Icon name="soundOff" size={13} />
          Звук видео не используется — в ролике только музыка
        </span>
      </div>
    </>
  );
}

/**
 * «Обрезка»: the strip, the window and its two edges, and the times under them. Drawn from what a drag holds while the pointer is down, else from the
 * draft; every edit is made on the session's CURRENT draft (another edit may have landed since this render).
 */
function TrimStrip({ session, spec, index, sourceMs }: { session: DraftSession; spec: MontageDraft; index: number; sourceMs: number }) {
  const strip = useRef<HTMLDivElement>(null);
  const gesture = useRef<(() => void) | null>(null);
  const heldKey = useRef<string | null>(null);
  /** Where a drag holds the clip's part while the pointer is down; null when nothing is dragged. */
  const [slip, setSlip] = useState<{ startMs: number; durationMs: number } | null>(null);
  useEffect(() => () => gesture.current?.(), []);
  const found = spec.clips[index];
  if (found?.kind !== "video") return null;
  const clip: VideoClip = found;
  const clipId = clip.clipId;
  const shown = { ...clip, ...(slip === null ? {} : { trimStartMs: slip.startMs, durationMs: slip.durationMs }) };
  const view = trimView(shown, sourceMs);
  const limits = trimLimits(spec, index, sourceMs);

  /** `part` moved to `wantedMs` (the window: its start) on the session's current draft; null when the clip is gone from it. */
  function moved(part: Part, wantedMs: number): MontageDraft | null {
    const current = session.state.spec;
    const at = current.clips.findIndex((c) => c.clipId === clipId);
    if (at < 0 || current.clips[at]?.kind !== "video") return null;
    if (part === "window") return slideTrim(current, at, wantedMs, sourceMs);
    return part === "start" ? trimStartTo(current, at, wantedMs, sourceMs) : trimEndTo(current, at, wantedMs, sourceMs);
  }

  /** The clip's part in `draft`, for the slip. */
  function partOf(draft: MontageDraft): { startMs: number; durationMs: number } | null {
    const found = draft.clips.find((c) => c.clipId === clipId);
    return found?.kind === "video" ? { startMs: found.trimStartMs, durationMs: found.durationMs } : null;
  }

  function commit(next: MontageDraft | null, mergeKey?: string): void {
    if (next === null || next === session.state.spec) return;
    session.edit(next, mergeKey === undefined ? {} : { mergeKey });
  }

  function press(event: ReactPointerEvent<HTMLElement>, part: Part | "strip"): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = strip.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const width = rect !== undefined && rect.width > 0 ? rect.width : STRIP_PX;
    const msAt = (x: number): number => ((x - left) / width) * sourceMs;
    const startX = event.clientX;
    const from = { start: clip.trimStartMs, end: clip.trimStartMs + clip.durationMs };
    // A press on the strip outside the window takes the window there, its middle under the pointer, and drags it on from there.
    const what: Part = part === "strip" ? "window" : part;
    const grab = part === "strip" ? clip.durationMs / 2 : msAt(startX) - from.start;
    const wanted = (x: number): number => (what === "window" ? msAt(x) - grab : (what === "start" ? from.start : from.end) + ((x - startX) / width) * sourceMs);
    // An edge moves at once; the window waits for a real drag, so a click on it changes nothing.
    let active = part !== "window";
    let last: number | null = part === "strip" ? wanted(startX) : null;
    if (last !== null) setSlip(partOf(moved(what, last) ?? session.state.spec));
    gesture.current?.();
    gesture.current = trackPointer(
      event,
      (move) => {
        if (!active && Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
        active = true;
        last = wanted(move.clientX);
        const next = moved(what, last);
        setSlip(next === null ? null : partOf(next));
      },
      (end) => {
        gesture.current = null;
        setSlip(null);
        // The system took the pointer: nothing changes.
        if (end === null || last === null) return;
        commit(moved(what, last));
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>, part: Part): void {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const value = part === "end" ? clip.trimStartMs + clip.durationMs : clip.trimStartMs;
    const step = event.shiftKey ? 1_000 : STEP_MS;
    const range = part === "window" ? limits.slide : part === "start" ? limits.start : limits.end;
    const targets: Record<string, number> = {
      ArrowLeft: value - step,
      ArrowDown: value - step,
      ArrowRight: value + step,
      ArrowUp: value + step,
      PageDown: value - 1_000,
      PageUp: value + 1_000,
      Home: range.min,
      End: range.max,
    };
    const wanted = targets[event.key];
    if (wanted === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // Held keys repeat: one undo step until the key is let go.
    heldKey.current = event.key;
    commit(moved(part, wanted), `trim-${part}-key:${clipId}`);
  }

  function release(event?: KeyboardEvent<HTMLElement>): void {
    if (event !== undefined && event.key !== heldKey.current) return;
    heldKey.current = null;
    session.endMerge();
  }

  const range = trimRangeLabel(view.startMs, view.endMs);
  const keys = {
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => release(event),
    onBlur: () => release(),
    "aria-keyshortcuts": "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown Home End",
  };

  return (
    <>
      <div className={["ed-trim", slip === null ? "" : "ed-trim-moving", view.width * STRIP_PX < NARROW_WINDOW_PX ? "ed-trim-narrow" : ""].filter(Boolean).join(" ")} ref={strip} onPointerDown={(e) => press(e, "strip")}>
        <span className="ed-trim-film" aria-hidden="true">
          {Array.from({ length: STRIP_FRAMES }, (_, i) => (
            <span key={i} className="ed-trim-frame" />
          ))}
        </span>
        <span className="ed-trim-dim" aria-hidden="true" style={{ left: 0, width: pct(view.from) }} />
        <span className="ed-trim-dim" aria-hidden="true" style={{ left: pct(view.from + view.width), right: 0 }} />
        <span
          className="ed-trim-window"
          role="slider"
          tabIndex={0}
          aria-label="Отрезок видео"
          aria-valuemin={limits.slide.min}
          aria-valuemax={limits.slide.max}
          aria-valuenow={view.startMs}
          aria-valuetext={range}
          style={{ left: pct(view.from), width: pct(view.width) }}
          onPointerDown={(e) => press(e, "window")}
          onKeyDown={(e) => onKeyDown(e, "window")}
          {...keys}
        />
        <span
          className="ed-trim-hd ed-trim-hd-l"
          role="slider"
          tabIndex={0}
          aria-label="Начало отрезка"
          aria-valuemin={limits.start.min}
          aria-valuemax={limits.start.max}
          aria-valuenow={view.startMs}
          aria-valuetext={`с ${secondsLabel(view.startMs)}`}
          style={{ left: pct(view.from) }}
          onPointerDown={(e) => press(e, "start")}
          onKeyDown={(e) => onKeyDown(e, "start")}
          {...keys}
        />
        <span
          className="ed-trim-hd ed-trim-hd-r"
          role="slider"
          tabIndex={0}
          aria-label="Конец отрезка"
          aria-valuemin={limits.end.min}
          aria-valuemax={limits.end.max}
          aria-valuenow={view.endMs}
          aria-valuetext={`до ${secondsLabel(view.endMs)}`}
          style={{ left: pct(view.from + view.width) }}
          onPointerDown={(e) => press(e, "end")}
          onKeyDown={(e) => onKeyDown(e, "end")}
          {...keys}
        />
      </div>
      <div className="ed-prow">
        <span className="mono ed-trim-range">{range}</span>
        <span className="mono faint">{trimOfLabel(view.endMs - view.startMs, sourceMs)}</span>
      </div>
    </>
  );
}
