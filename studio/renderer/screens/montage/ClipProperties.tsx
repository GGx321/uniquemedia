import { type DragEvent, type KeyboardEvent, useId } from "react";
import type { Clip, MontageDraft, Motion } from "../../../shared/engine";
import { MAX_TOTAL_MS } from "../../../shared/montage";
import { NBSP } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import { type ClipLayout, cellsOf, type Edit, clipStartMs, layoutOf, maxDurationMs, roomMs, setDuration, setLayout, setMotion, setStagger, totalMs } from "./clipOps";
import { ownsKeys } from "./keys";
import { actionWhyLabel, clipKindLabel, rangeLabel, secondsLabel, staggerStepLabel } from "./labels";
import { selectClip, selectionActions } from "./selection";
import type { DraftSession } from "./session";
import { usePlayheadRest } from "./usePlayhead";
import { type TimelineState, useSelectionCommands } from "./useTimeline";

// 3d.3a: the selected clip's properties (Editor.dc.html, `sel = c2`; the reconciliation's R3–R14). «Раскладка»
// switches one photo ↔ a collage (cells cut or padded empty), «Ячейки» picks a cell (and takes a bin photo dropped
// on it), «Анимация» and «Ячейки по очереди», «Длительность» on the 100 ms grid within the 15 s. No «Масштаб» (Q3).
// SLOT 3d.4: the focus drag in the preview. SLOT 3f: an own video's «Обрезка» strip and its source facts (R16–R20).

const LAYOUTS: readonly { id: ClipLayout; label: string }[] = [
  { id: "photo", label: "1 фото" },
  { id: "collage2", label: "Коллаж 2" },
  { id: "collage3", label: "Коллаж 3" },
  { id: "collage4", label: "Коллаж 4" },
];
const LAYOUT_CELLS: Record<ClipLayout, number> = { photo: 1, collage2: 2, collage3: 3, collage4: 4 };

const MOTIONS: readonly { id: Motion; label: string }[] = [
  { id: "kenburns", label: "Ken Burns" },
  { id: "pan", label: "Панорама" },
  { id: "static", label: "Статика" },
];

/** What the face judge said about the selected cell's photo (R8, AM9). */
type FaceState = "empty" | "pending" | "found" | "none";

function faceState(clip: Clip, cell: number, pending: ReadonlySet<string>): FaceState {
  const target = cellsOf(clip)[cell];
  if (target === undefined || target.photo === null) return "empty";
  if (target.focus !== null) return "found";
  return target.photo.source === "scene" && pending.has(target.photo.photoId) ? "pending" : "none";
}

const FACE_TAGS: Record<Exclude<FaceState, "empty">, { text: string; tone: string }> = {
  found: { text: "кадр по лицу", tone: "ed-face-found" },
  pending: { text: "ищем лицо…", tone: "ed-face-pending" },
  none: { text: "лицо не найдено", tone: "ed-face-none" },
};

const FACE_HINTS: Record<FaceState, string> = {
  empty: "Ячейка пуста: кликните фото слева или перетащите его на ячейку.",
  pending: "Ищем лицо на фото — кадр подстроится под него сам.",
  found: "Фото кадрировано по лицу.",
  none: "Лицо не найдено: фото стоит по центру, чуть выше середины.",
};

export interface ClipPropertiesProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly index: number;
  readonly cell: number;
  readonly avatarId: string;
  readonly timeline: TimelineState;
  /** Photos whose face focus is still being judged. */
  readonly focusPending: ReadonlySet<string>;
  readonly dragPhoto: string | null;
  readonly onFillCell: (clip: number, cell: number, photoId: string) => void;
}

export function ClipProperties({ session, spec, index, cell, avatarId, timeline, focusPending, dragPhoto, onFillCell }: ClipPropertiesProps) {
  const commands = useSelectionCommands(session, timeline);
  const durationId = useId();
  // Where the playhead rests (3d.4): a playback does not re-render the panel.
  const restMs = usePlayheadRest(timeline.playhead);
  const clip = spec.clips[index];
  if (clip === undefined) return null;
  const start = clipStartMs(spec, index);
  const layout = layoutOf(clip);
  const cells = cellsOf(clip);
  const actions = selectionActions(spec, timeline.selection, restMs);
  const face = layout === null ? null : faceState(clip, cell, focusPending);
  const max = maxDurationMs(spec, index);
  const room = roomMs(spec);
  const durationKey = `duration:${clip.clipId}`;

  /** An edit of this clip through the session; a refused one (the draft gone) changes nothing. */
  function apply(next: Edit | MontageDraft, mergeKey?: string): void {
    const draft = "ok" in next ? (next.ok ? next.spec : null) : next;
    if (draft === null || draft === session.state.spec) return;
    session.edit(draft, mergeKey === undefined ? {} : { mergeKey });
  }

  /** The live index of this clip in the session's current draft (it may have moved since this render). */
  const liveIndex = (): number => session.state.spec.clips.findIndex((c) => c.clipId === clip.clipId);

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    // Delete on a control (the «Длительность» slider) or ending a composition is not the clip's (keys.ts).
    if (ownsKeys(event.target) || event.nativeEvent.isComposing) return;
    if ((event.key === "Delete" || event.key === "Backspace") && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      commands.remove();
    }
  }

  function dropOnCell(event: DragEvent<HTMLButtonElement>, target: number): void {
    if (dragPhoto === null) return;
    event.preventDefault();
    onFillCell(index, target, dragPhoto);
  }

  return (
    <aside className="ed-props" aria-label="Свойства" data-slot="properties 3d.5" onKeyDown={onKeyDown}>
      <div className="ed-props-top">
        <div className="ed-props-head">
          <span className="lbl">
            Кадр {index + 1} из {spec.clips.length}
          </span>
          <span className="mono faint ed-props-sub">
            {clipKindLabel(clip)} · {rangeLabel(start, start + clip.durationMs)}
          </span>
        </div>
        <div className="ed-props-actions">
          <button type="button" className="ibtn" aria-label="Дублировать" disabled={!actions.duplicate.enabled} title={actions.duplicate.enabled ? (layout === null ? "Копия этого видео" : "Копия без фото: одно фото — один раз в ролике") : actionWhyLabel(actions.duplicate.why)} onClick={() => void commands.duplicate()}>
            <Icon name="copy" size={14} />
          </button>
          <button type="button" className="ibtn" aria-label="Удалить" onClick={() => void commands.remove()}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {layout !== null && clip.kind !== "video" && (
        <>
          <div className="ed-pgroup">
            <span className="lbl">Раскладка</span>
            <div className="ed-layouts" role="group" aria-label="Раскладка">
              {LAYOUTS.map((option) => {
                const on = option.id === layout;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={on ? "tb tb-on" : "tb"}
                    aria-pressed={on}
                    onClick={() => {
                      const at = liveIndex();
                      if (at < 0) return;
                      const result = setLayout(session.state.spec, at, option.id);
                      if (!result.ok || result.spec === session.state.spec || !session.edit(result.spec)) return;
                      // New empty cells wait for photos: the first one is selected, so the next bin click fills it.
                      const next = result.spec.clips[at];
                      const empty = next === undefined ? -1 : cellsOf(next).findIndex((c) => c.photo === null);
                      timeline.select(selectClip(result.spec, at, empty >= 0 ? empty : Math.min(cell, LAYOUT_CELLS[option.id] - 1)));
                    }}
                  >
                    <span className={`tbox tbox-${option.id}`} aria-hidden="true">
                      {Array.from({ length: LAYOUT_CELLS[option.id] }, (_, i) => (
                        <span key={i} />
                      ))}
                    </span>
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="ed-pgroup">
            <div className="ed-prow">
              <span className="lbl">Ячейки</span>
              {face !== null && face !== "empty" && (
                <span className={`tag ed-face ${FACE_TAGS[face].tone}`}>
                  <Icon name="face" size={11} strokeWidth={2.4} />
                  {FACE_TAGS[face].text}
                </span>
              )}
            </div>
            <div className="ed-cells" role="group" aria-label="Ячейки">
              {cells.map((c, i) => {
                const on = i === cell;
                const photo = c.photo;
                return (
                  <button
                    key={i}
                    type="button"
                    className={["ph ed-cell", on ? "ed-cell-on" : "", photo === null ? "ed-cell-empty" : "", dragPhoto !== null ? "ed-cell-target" : ""].filter(Boolean).join(" ")}
                    aria-pressed={on}
                    aria-label={`Ячейка ${i + 1}: ${photo === null ? "пусто" : "фото"}`}
                    onClick={() => timeline.select(selectClip(spec, index, i))}
                    onDragOver={(e) => {
                      if (dragPhoto === null) return;
                      e.preventDefault();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                    }}
                    onDrop={(e) => dropOnCell(e, i)}
                  >
                    {photo?.source === "scene" && <Portrait avatarId={avatarId} photoId={photo.photoId} label={`Ячейка ${i + 1}`} />}
                    {photo?.source === "own" && <span className="clip-poster-own" />}
                    <span className="mono ed-cell-n">{i + 1}</span>
                  </button>
                );
              })}
            </div>
            {face !== null && <span className="faint ed-props-note">{FACE_HINTS[face]}</span>}
          </div>

          <div className="ed-pgroup">
            <span className="lbl">Анимация</span>
            <div className="seg ed-motion" role="group" aria-label="Анимация">
              {MOTIONS.map((motion) => (
                <button
                  key={motion.id}
                  type="button"
                  className={clip.motion === motion.id ? "on" : undefined}
                  aria-pressed={clip.motion === motion.id}
                  onClick={() => {
                    const at = liveIndex();
                    if (at >= 0) apply(setMotion(session.state.spec, at, motion.id));
                  }}
                >
                  {motion.label}
                </button>
              ))}
            </div>
            <div className={clip.kind === "collage" ? "ed-prow ed-stagger" : "ed-prow ed-stagger ed-stagger-off"}>
              <span>{clip.kind === "collage" ? `Ячейки по очереди, шаг ${staggerStepLabel(clip.durationMs, clip.cells.length)}` : "Ячейки по очереди"}</span>
              <button
                type="button"
                role="switch"
                className={clip.kind === "collage" && clip.stagger ? "sw sw-on" : "sw"}
                aria-checked={clip.kind === "collage" && clip.stagger}
                aria-label="Ячейки по очереди"
                disabled={clip.kind !== "collage"}
                title={clip.kind === "collage" ? undefined : "Только для коллажа"}
                onClick={() => {
                  const at = liveIndex();
                  if (at >= 0 && clip.kind === "collage") apply(setStagger(session.state.spec, at, !clip.stagger));
                }}
              />
            </div>
          </div>
        </>
      )}

      <div className="ed-pgroup ed-pgroup-tight">
        <div className="ed-prow ed-duration">
          <label htmlFor={durationId}>Длительность</label>
          <input
            id={durationId}
            type="range"
            min={5}
            max={Math.max(5, max / 100)}
            step={1}
            value={clip.durationMs / 100}
            aria-valuetext={secondsLabel(clip.durationMs)}
            onChange={(e) => {
              const at = liveIndex();
              if (at >= 0) apply(setDuration(session.state.spec, at, Number(e.target.value) * 100), durationKey);
            }}
            onPointerUp={() => session.endMerge()}
            onKeyUp={() => session.endMerge()}
            onBlur={() => session.endMerge()}
          />
          <span className="mono ed-duration-value">{secondsLabel(clip.durationMs)}</span>
        </div>
        <span className="faint ed-props-note">
          {room > 0
            ? `ролик ${secondsLabel(totalMs(spec))} из ${MAX_TOTAL_MS / 1000} · кадр можно удлинить ещё на ${secondsLabel(room)}`
            : `ролик ${secondsLabel(totalMs(spec))} из ${MAX_TOTAL_MS / 1000} · длиннее кадр уже не станет`}
        </span>
      </div>

      {clip.kind === "video" && <p className="faint ed-props-note">Своё видео: обрезка и кадр{NBSP}— скоро. Звук видео не используется — в ролике только музыка.</p>}
    </aside>
  );
}
