import { EDGE_MODES } from "../../core/types";
import type { EdgeMode, MediaKind } from "../../core/types";

export interface AdvancedValue {
  strength: number;
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number;
  spoofMetadata: boolean;
  edgeMode: EdgeMode;
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

export function AdvancedPanel({
  kind,
  value,
  onChange,
}: {
  /** A still has no soundtrack, so the audio row is not shown for one. The kind
   *  is required rather than optional so that every call site has to say which
   *  media it is settings for, instead of defaulting into a dead toggle. */
  kind: MediaKind;
  value: AdvancedValue;
  onChange: (v: AdvancedValue) => void;
}) {
  const set = (patch: Partial<AdvancedValue>) => onChange({ ...value, ...patch });
  const pct = ((value.strength - 0.5) / 1.0) * 100;
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
        {kind === "photo" && (
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
        <label className="adv-row">
          Метаданные iPhone
          <input
            className="switch"
            aria-label="Метаданные iPhone"
            type="checkbox"
            checked={value.spoofMetadata}
            onChange={(e) => set({ spoofMetadata: e.target.checked })}
          />
        </label>
      </div>
    </details>
  );
}
