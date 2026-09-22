import { useId } from "react";
import { EDGE_MODES, FIRST_FRAME_MODES, IDENTITY_MODES } from "../../core/types";
import type { EdgeMode, FirstFrameMode, IdentityMode, MediaKind } from "../../core/types";
import type { CoverPick } from "../../../electron/ipc";
import { basename } from "../util";

export interface AdvancedValue {
  strength: number;
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number;
  identity: IdentityMode;
  edgeMode: EdgeMode;
  firstFrame: FirstFrameMode;
  /** The picture for `firstFrame: "photo"`, once chosen — path and thumbnail
   *  together, because the thumbnail is only ever shown beside the path it
   *  was read from. Kept across mode changes: flicking to «Чёрный» to compare
   *  should not cost the user the file they picked. */
  cover: CoverPick | null;
}

/** Reading the answer back as one of the three modes rather than casting the
 *  select's string: an unrecognised value is simply not `fit` and would crop in
 *  silence, which is the damage the control exists to prevent. */
function toEdgeMode(value: string, fallback: EdgeMode): EdgeMode {
  return EDGE_MODES.find((m) => m === value) ?? fallback;
}

/** «Сохранять края кадра»: Авто / Всегда / Никогда. `auto` decides from the
 *  picture, and is the default because it is right for both kinds of image. */
const EDGE_LABELS: Record<EdgeMode, string> = {
  auto: "Авто",
  fit: "Всегда",
  crop: "Никогда",
};

/** «Метаданные»: what a copy says about itself. Three states rather than a
 *  switch, because «Чисто» is neither on nor off — it is the absence of both
 *  the encoder's signature and the borrowed identity. */
const IDENTITY_LABELS: Record<IdentityMode, string> = {
  engine: "Движок",
  iphone: "iPhone",
  clean: "Чисто",
};

/** «Первый кадр»: what a copy opens on. The middle one is what the old
 *  switch did; the last one needs a picture, and gets a row of its own. */
const FIRST_FRAME_LABELS: Record<FirstFrameMode, string> = {
  off: "Выкл",
  black: "Чёрный",
  photo: "Фото",
};

/** A segmented control in the identity row's register: a radiogroup of
 *  buttons, labelled by the text beside it. */
function Segmented<M extends string>({
  labelId,
  modes,
  labels,
  value,
  onChange,
}: {
  labelId: string;
  modes: readonly M[];
  labels: Record<M, string>;
  value: M;
  onChange: (mode: M) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-labelledby={labelId}>
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          className="seg-btn"
          onClick={() => onChange(m)}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

/**
 * The first-frame choice and, under «Фото», the picture it needs: a button
 * that opens the host's image dialog, and — once one is chosen — its
 * thumbnail and file name. The panel never opens a dialog itself: the pick
 * is the host's (`onPickCover`), the same way the dropzone's is.
 */
function FirstFrameRow({
  value,
  cover,
  onChange,
  onPickCover,
  pickDisabled,
}: {
  value: FirstFrameMode;
  cover: CoverPick | null;
  onChange: (mode: FirstFrameMode) => void;
  onPickCover: () => void;
  pickDisabled: boolean;
}) {
  const labelId = useId();
  return (
    <>
      <div className="adv-row adv-row-static">
        <span className="adv-label">
          <span id={labelId}>Первый кадр</span>
        </span>
        <Segmented
          labelId={labelId}
          modes={FIRST_FRAME_MODES}
          labels={FIRST_FRAME_LABELS}
          value={value}
          onChange={onChange}
        />
      </div>
      {value === "photo" && (
        <div className="adv-row adv-row-static cover-row">
          <span className="cover-pick">
            {cover ? (
              <>
                <img className="cover-thumb" src={cover.thumb} alt="Фото для первого кадра" />
                <span className="cover-name" title={cover.path}>{basename(cover.path)}</span>
              </>
            ) : (
              <span className="cover-name cover-empty">Фото не выбрано</span>
            )}
          </span>
          <button type="button" className="cover-btn" onClick={onPickCover} disabled={pickDisabled}>
            Выбрать фото
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The three-way choice plus the ⓘ that explains it. A CSS tooltip in the
 * app's own register rather than a native `title`, shown on hover and on
 * keyboard focus alike: the glyph is a real button, so Tab reaches it, and
 * `aria-describedby` ties the text to it for a screen reader. Positioned
 * against the row and spanning its width, so it cannot run past the panel
 * edge that `.advanced` clips at.
 */
function IdentityRow({
  value,
  onChange,
}: {
  value: IdentityMode;
  onChange: (identity: IdentityMode) => void;
}) {
  const labelId = useId();
  const tipId = useId();
  return (
    <div className="adv-row adv-row-static">
      <span className="adv-label">
        <span id={labelId}>Метаданные</span>
        <span className="info-wrap">
          <button
            type="button"
            className="info"
            aria-label="Что означают режимы"
            aria-describedby={tipId}
          >
            i
          </button>
          <span role="tooltip" id={tipId} className="tip">
            <p>
              <b>Движок</b> — метаданные исходника удалены, но в файле остаётся
              подпись кодировщика (ffmpeg, x264).
            </p>
            <p>
              <b>iPhone</b> — файл выглядит снятым на iPhone: модель, дата, место,
              объектив. Следов кодировщика нет.
            </p>
            <p>
              <b>Чисто</b> — никаких метаданных и подписей. Голый файл.
            </p>
          </span>
        </span>
      </span>
      <Segmented
        labelId={labelId}
        modes={IDENTITY_MODES}
        labels={IDENTITY_LABELS}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

export function AdvancedPanel({
  kind,
  value,
  onChange,
  onPickCover,
  pickCoverDisabled = false,
}: {
  /** A still has no soundtrack, so the audio row is not shown for one. The kind
   *  is required rather than optional so that every call site has to say which
   *  media it is settings for, instead of defaulting into a dead toggle. */
  kind: MediaKind;
  value: AdvancedValue;
  onChange: (v: AdvancedValue) => void;
  /** Opens the host's image dialog for the photo first frame; the host puts
   *  the result on `value.cover`. */
  onPickCover: () => void;
  /** While a batch runs: a pick the host refuses is reported on the same
   *  error channel as a failed batch, and the renderer's handler for that
   *  channel ends the batch on screen while ffmpeg keeps going. */
  pickCoverDisabled?: boolean;
}) {
  const set = (patch: Partial<AdvancedValue>) => onChange({ ...value, ...patch });
  const pct = ((value.strength - 0.5) / 1.0) * 100;
  // The edge mode reaches the render for a still, and for the cover of a
  // video whose first frame is a photo — the route hands the cover the same
  // setting. A setting that reaches the render has to be on screen.
  const edgesApply = kind === "photo" || value.firstFrame === "photo";
  return (
    <details className="advanced">
      <summary>
        <span className="chev" aria-hidden />
        Дополнительно
      </summary>
      <div className="advanced-body">
        <label className="field">
          <span className="adv-slider-head">
            <span className="micro-label">Сила изменений</span>
            <span className="val">{Math.round(value.strength * 100)}%</span>
          </span>
          <input
            aria-label="Сила изменений"
            type="range"
            min={0.5}
            max={1.5}
            step={0.1}
            value={value.strength}
            onChange={(e) => set({ strength: Number(e.target.value) })}
            style={{ ["--pct" as string]: `${pct}%` }}
          />
        </label>
        {kind !== "photo" && (
          <label className="adv-row">
            Сохранить оригинальный звук
            <input
              className="switch"
              aria-label="Сохранить оригинальный звук"
              type="checkbox"
              checked={value.keepTrendAudio}
              onChange={(e) => set({ keepTrendAudio: e.target.checked })}
            />
          </label>
        )}
        <label className="adv-row">
          Зеркальное отражение (отражает текст)
          <input
            className="switch"
            aria-label="Зеркальное отражение"
            type="checkbox"
            checked={value.allowMirror}
            onChange={(e) => set({ allowMirror: e.target.checked })}
          />
        </label>
        {kind !== "photo" && (
          <FirstFrameRow
            value={value.firstFrame}
            cover={value.cover}
            onChange={(firstFrame) => set({ firstFrame })}
            onPickCover={onPickCover}
            pickDisabled={pickCoverDisabled}
          />
        )}
        {edgesApply && (
          <label className="adv-row">
            Сохранять края кадра
            <span className="select-wrap">
              <select
                className="input adv-select"
                aria-label="Сохранять края кадра"
                value={value.edgeMode}
                onChange={(e) => set({ edgeMode: toEdgeMode(e.target.value, value.edgeMode) })}
              >
                {EDGE_MODES.map((m) => (
                  <option key={m} value={m}>{EDGE_LABELS[m]}</option>
                ))}
              </select>
            </span>
          </label>
        )}
        <IdentityRow value={value.identity} onChange={(identity) => set({ identity })} />
      </div>
    </details>
  );
}
