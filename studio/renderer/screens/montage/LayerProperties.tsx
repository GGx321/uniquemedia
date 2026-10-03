import type { KeyboardEvent } from "react";
import type { MontageDraft } from "../../../shared/engine";
import { stickerById } from "../../../shared/stickers/manifest";
import { NBSP } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { totalMs } from "./clipOps";
import { ownsKeys } from "./keys";
import { actionWhyLabel, loopLabel, rangeLabel, stickerName, trackClock, trackTitle } from "./labels";
import type { TrackLookup } from "./MusicTrack";
import { type ActionState, selectionActions } from "./selection";
import type { DraftSession } from "./session";
import { type TimelineState, useSelectionCommands } from "./useTimeline";

// 3d.3b: the properties panel's head for a selected text, sticker or the music (EditorText, EditorGif and EditorMusic
// artboards: «Текст · слой 1 из 3 · 0.3–4.4 с», «Стикер 2 из 2 · 6.0–9.6 с · петля», «Музыка · 0–9.6 с · весь ролик»), with
// «Дублировать» / «Удалить» and the layer's place in the z-order («Слой выше» / «Слой ниже», no artboard draws it).
// SLOT 3d.5: the text's caption, font, style, size and plaque colour; the sticker's size and «Заменить стикер»; the music
// card with the highlight picks and «Заменить трек». The timeline already moves and trims the layer and the music's start.

function Step({ label, icon, state, onClick }: { label: string; icon: "layerUp" | "layerDown"; state: ActionState; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-s ed-zstep" disabled={!state.enabled} title={state.enabled ? undefined : actionWhyLabel(state.why)} onClick={onClick}>
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

/** Delete on the panel removes the selected item, as on the timeline; a control keeps its own keys (keys.ts). */
function deleteKeyHandler(remove: () => boolean) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (ownsKeys(event.target) || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    remove();
  };
}

export interface LayerPropertiesProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly index: number;
  readonly timeline: TimelineState;
}

export function LayerProperties({ session, spec, index, timeline }: LayerPropertiesProps) {
  const commands = useSelectionCommands(session, timeline);
  const onKeyDown = deleteKeyHandler(commands.remove);
  const layer = spec.layers[index];
  if (layer === undefined) return null;
  const actions = selectionActions(spec, timeline.selection, timeline.playheadMs);
  const ofKind = spec.layers.filter((l) => l.kind === layer.kind);
  const place = spec.layers.slice(0, index + 1).filter((l) => l.kind === layer.kind).length;
  const loop = layer.kind === "sticker" ? loopLabel(layer) : null;
  const sub = [rangeLabel(layer.startMs, layer.endMs), ...(loop === null ? [] : ["петля"]), ...(layer.endMs > totalMs(spec) ? ["после конца ролика"] : [])].join(" · ");
  const entry = layer.kind === "sticker" && layer.sticker.source === "builtin" ? stickerById(layer.sticker.stickerId) : undefined;

  return (
    <aside className="ed-props" aria-label="Свойства" data-slot="properties 3d.5" onKeyDown={onKeyDown}>
      <div className="ed-props-top">
        <div className="ed-props-head">
          <span className="lbl">{layer.kind === "text" ? `Текст · слой ${place} из ${ofKind.length}` : `Стикер ${place} из ${ofKind.length}`}</span>
          <span className="mono faint ed-props-sub">{sub}</span>
        </div>
        <div className="ed-props-actions">
          <button type="button" className="ibtn" aria-label="Дублировать" disabled={!actions.duplicate.enabled} title={actions.duplicate.enabled ? "Копия поверх, на то же время" : actionWhyLabel(actions.duplicate.why)} onClick={() => void commands.duplicate()}>
            <Icon name="copy" size={14} />
          </button>
          <button type="button" className="ibtn" aria-label="Удалить" onClick={() => void commands.remove()}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {layer.kind === "sticker" && (
        <div className="ed-pgroup">
          <span className="ed-props-sticker">
            <span className="mono">{stickerName(layer)}</span>
            <span className="mono faint">{entry === undefined ? (layer.sticker.source === "own" ? "свой · скоро" : "нет во встроенном наборе") : `встроенный · ${loop ?? ""}`}</span>
          </span>
        </div>
      )}

      <div className="ed-pgroup">
        <span className="lbl">Порядок слоёв</span>
        <div className="ed-zsteps">
          <Step label="Выше" icon="layerUp" state={actions.raise} onClick={() => void commands.raise()} />
          <Step label="Ниже" icon="layerDown" state={actions.lower} onClick={() => void commands.lower()} />
        </div>
        <span className="faint ed-props-note">
          Сверху тот слой, что позже в списке. На таймлайне: тяните блок, чтобы сдвинуть, или его край{NBSP}— чтобы обрезать; ⌥↑ ⌥↓ — выше и ниже.
        </span>
      </div>

      <p className="faint ed-props-note">{layer.kind === "text" ? "Надпись, шрифт, стиль и размер — скоро." : "Размер и замена стикера — скоро."}</p>
    </aside>
  );
}

export interface MusicPropertiesProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly timeline: TimelineState;
  readonly lookup: TrackLookup;
}

export function MusicProperties({ session, spec, timeline, lookup }: MusicPropertiesProps) {
  const commands = useSelectionCommands(session, timeline);
  const onKeyDown = deleteKeyHandler(commands.remove);
  const music = spec.music;
  if (music === null) return null;
  const total = totalMs(spec);
  const track = lookup.state === "listed" ? lookup.track : null;
  const name = track !== null ? trackTitle(track) : lookup.state === "unlisted" ? "Трек из прежнего списка" : lookup.state === "own" ? "Свой трек" : "…";

  return (
    <aside className="ed-props" aria-label="Свойства" data-slot="properties 3d.5" onKeyDown={onKeyDown}>
      <div className="ed-props-top">
        <div className="ed-props-head">
          <span className="lbl">Музыка</span>
          <span className="mono faint ed-props-sub">0–{(total / 1000).toFixed(1)}{NBSP}с · весь ролик</span>
        </div>
        <div className="ed-props-actions">
          <button type="button" className="ibtn" aria-label="Удалить" title="Без музыки видео получит тишину той же длины" onClick={() => void commands.remove()}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      <div className="ed-pgroup">
        <span className="ed-props-track">{name}</span>
        <span className="mono faint">
          {trackClock(music.startMs)} → {trackClock(music.startMs + total)}
          {track !== null && ` · трек ${trackClock(track.durationMs)}`}
        </span>
        <span className="faint ed-props-note">Тяните трек на таймлайне, чтобы он начинался с другого места. Громкость трека не меняется, при рендере приглушаются только пики.</span>
      </div>
      <p className="faint ed-props-note">Лучшая часть и замена трека — скоро.</p>
    </aside>
  );
}
