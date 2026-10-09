import { type KeyboardEvent, type PointerEvent, type RefObject, useLayoutEffect, useRef } from "react";
import type { LaunchMix } from "../../../shared/engine";
import { handleAt, handleValueText, isDefaultMix, mixKey, moveHandle, type MixHandle } from "./launchForm";

// S4.9a: «Тип видео» (the design's decision 4, LaunchStates «Тип видео»): the mockup's bar became the control itself — two handles on the borders of the
// shares, so the three always sum to 100 and there is no error to report. role slider each; ← → by 5 %, Home / End to the neighbouring handle or the bar's
// edge; a pointer drags by whole percent. Untouched it is «по умолчанию»; touched, «Сбросить · 70 / 20 / 10» puts it back and the focus on the first handle.

export interface MixControlProps {
  readonly mix: LaunchMix;
  readonly readOnly: boolean;
  readonly onChange: (mix: LaunchMix) => void;
  readonly onReset: () => void;
  /** The legend's per-shape prices, «≈ $0.070» (a video's photos all new), or null while the engine has priced nothing yet. */
  readonly prices: { readonly single: string; readonly collage: string; readonly slides: string } | null;
  /** «На аватар 7 · 2 · 1 · цена — за видео из новых фото». */
  readonly note: string;
  readonly labelId: string;
  readonly noteId: string;
  readonly firstHandleRef: RefObject<HTMLButtonElement | null>;
}

const LEGEND = [
  { shape: "single", label: "Одно фото" },
  { shape: "collage", label: "Коллаж 2–4" },
  { shape: "slides", label: "Слайды 5–7" },
] as const;

export function MixControl({ mix, readOnly, onChange, onReset, prices, note, labelId, noteId, firstHandleRef }: MixControlProps) {
  const track = useRef<HTMLDivElement>(null);
  // A drag reads the mix as it moves, not as it was when the pointer went down.
  const live = useRef(mix);
  useLayoutEffect(() => {
    live.current = mix;
  });
  const dragging = useRef<MixHandle | null>(null);

  const percentAt = (clientX: number): number | null => {
    const box = track.current?.getBoundingClientRect();
    if (box === undefined || box.width <= 0) return null;
    return ((clientX - box.left) / box.width) * 100;
  };
  const down = (handle: MixHandle) => (event: PointerEvent<HTMLButtonElement>) => {
    if (readOnly) return;
    dragging.current = handle;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (handle: MixHandle) => (event: PointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== handle) return;
    const at = percentAt(event.clientX);
    if (at === null) return;
    const next = moveHandle(live.current, handle, at);
    if (handleAt(next, handle) !== handleAt(live.current, handle)) onChange(next);
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (handle: MixHandle) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (readOnly) return;
    const next = mixKey(mix, handle, event.key);
    if (next === null) return;
    event.preventDefault();
    if (handleAt(next, handle) !== handleAt(mix, handle)) onChange(next);
  };

  const custom = !isDefaultMix(mix);
  return (
    <div className="ap-block ap-mix-block">
      <div className="ap-block-head">
        <b id={labelId} className="ap-block-title">
          Тип видео
        </b>
        {custom ? (
          <button type="button" className="lbtn ap-mix-reset" aria-disabled={readOnly || undefined} onClick={readOnly ? undefined : onReset}>
            Сбросить · 70 / 20 / 10
          </button>
        ) : (
          <span className="tag">по умолчанию</span>
        )}
      </div>
      <div className="ap-mix" role="group" aria-labelledby={labelId} aria-describedby={noteId}>
        <div ref={track} className="ap-mix-track" aria-hidden="true">
          {mix.single > 0 && <span className="ap-mix-seg ap-mix-single" style={{ width: `${mix.single}%` }} />}
          {mix.collage > 0 && <span className="ap-mix-seg ap-mix-collage" style={{ width: `${mix.collage}%` }} />}
          {mix.slides > 0 && <span className="ap-mix-seg ap-mix-slides" style={{ width: `${mix.slides}%` }} />}
        </div>
        {([1, 2] as const).map((handle) => {
          const at = handleAt(mix, handle);
          return (
            <button
              key={handle}
              ref={handle === 1 ? firstHandleRef : undefined}
              type="button"
              className="ap-thumb"
              role="slider"
              aria-label={handle === 1 ? "Граница «Одно фото» и «Коллаж»" : "Граница «Коллаж» и «Слайды»"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={at}
              aria-valuetext={handleValueText(mix, handle)}
              aria-disabled={readOnly || undefined}
              style={{ left: `${at}%` }}
              onKeyDown={key(handle)}
              onPointerDown={down(handle)}
              onPointerMove={move(handle)}
              onPointerUp={up}
              onPointerCancel={up}
            />
          );
        })}
      </div>
      <div className="ap-leg">
        {LEGEND.map(({ shape, label }) => (
          <div key={shape} className="ap-leg-item">
            <span className={`ap-leg-dot ap-mix-${shape}`} aria-hidden="true" />
            <span className="ap-leg-label">{label}</span>
            <span className="mono muted">{mix[shape]}%</span>
            <span className="mono faint ap-leg-price">{prices === null ? "—" : prices[shape]}</span>
          </div>
        ))}
      </div>
      <span id={noteId} className="faint ap-note">
        {note}
      </span>
    </div>
  );
}
