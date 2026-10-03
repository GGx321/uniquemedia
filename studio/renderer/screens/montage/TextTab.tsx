import { useId } from "react";
import { MAX_TEXT_LAYERS, type MontageDraft } from "../../../shared/engine";
import { Icon } from "../../ui/Icon";
import { captionLine, layerName, rangeLabel, secondsLabel } from "./labels";
import { TEXT_PRESETS, type TextPreset } from "./textOps";

// 3d.5: the «Текст» tab (EditorText.dc.html; T1–T5). «Добавить текст в 4.1 с» (the first preset with a neutral sample, AM7), the six
// «Стили» presets (each adds a text in its font and style, its sample as the caption), and the montage's texts in z-order («Слои ·
// 3 из 10»), a click selecting one. At 10 texts, or with no room at the playhead, the button and the presets are off and the line
// under them says why (T5).

export interface TextTabProps {
  readonly spec: MontageDraft;
  readonly playheadMs: number;
  readonly selected: string | null;
  /** Why a text cannot be added at the playhead now; null when it can. */
  readonly addWhy: string | null;
  readonly onAdd: (preset?: TextPreset) => void;
  readonly onSelect: (layerId: string) => void;
}

/** A preset's sample, drawn in its own font and style (a likeness: the picture itself is the engine's, 3d.4). */
export function PresetSample({ preset }: { preset: TextPreset }) {
  return (
    <span lang="en" className={`cap cap-f-${preset.font} cap-s-${preset.style}`}>
      {preset.sample}
    </span>
  );
}

export function TextTab({ spec, playheadMs, selected, addWhy, onAdd, onSelect }: TextTabProps) {
  const whyId = useId();
  const texts = spec.layers.flatMap((layer, index) => (layer.kind === "text" ? [{ layer, index }] : []));
  const off = addWhy !== null;

  return (
    <>
      <div className="ed-text-add">
        <button type="button" className="btn ed-text-add-btn" disabled={off} aria-describedby={off ? whyId : undefined} onClick={() => onAdd()}>
          <Icon name="plus" size={15} strokeWidth={2.2} />
          Добавить текст <span className="mono faint">в {secondsLabel(Math.floor(playheadMs / 100) * 100)}</span>
        </button>
        {off && (
          <span id={whyId} className="faint ed-text-why">
            {addWhy}
          </span>
        )}
      </div>

      <div className="ed-text-section">
        <span className="lbl">Стили</span>
        <div className="ed-presets">
          {TEXT_PRESETS.map((preset) => (
            <button key={preset.label} type="button" className="pre" aria-label={`Добавить текст: ${preset.label}`} disabled={off} title={addWhy ?? undefined} onClick={() => onAdd(preset)}>
              <span className={`pre-box pre-box-${preset.font}-${preset.style}`}>
                <PresetSample preset={preset} />
              </span>
              <span className="pre-name">{preset.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="ed-text-section ed-text-layers">
        <span className="lbl">
          Слои <span className="mono">· {texts.length} из {MAX_TEXT_LAYERS}</span>
        </span>
        {texts.length === 0 ? (
          <span className="faint ed-text-none">Текстов в ролике пока нет.</span>
        ) : (
          <ul className="ed-text-list" aria-label="Тексты ролика">
            {texts.map(({ layer, index }) => {
              const on = layer.layerId === selected;
              return (
                <li key={layer.layerId}>
                  <button type="button" className={on ? "ed-text-row ed-text-row-on" : "ed-text-row"} aria-pressed={on} aria-label={`${layerName(spec, index)}: «${captionLine(layer.value)}», ${rangeLabel(layer.startMs, layer.endMs)}`} onClick={() => onSelect(layer.layerId)}>
                    <span className="ed-text-t" aria-hidden="true">
                      T
                    </span>
                    <span lang="en" className="ed-text-value">
                      {captionLine(layer.value)}
                    </span>
                    <span className="mono faint ed-text-range">{rangeLabel(layer.startMs, layer.endMs)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
