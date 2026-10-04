import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from "react";
import { graphemeCount, MAX_CAPTION_GRAPHEMES, MAX_CAPTION_UNITS, type MontageDraft, type TextFont, type TextLayer, type TextStyle } from "../../../shared/engine";
import { STICKER_CATEGORIES, stickerById } from "../../../shared/stickers/manifest";
import { useEngine } from "../../engine/react";
import { NBSP } from "../../lib/format";
import { stickerUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import { captionNotice } from "./captionCheck";
import { totalMs } from "./clipOps";
import { ownsKeys } from "./keys";
import { actionWhyLabel, loopLabel, rangeLabel, stickerName } from "./labels";
import type { LayerEdge } from "./layerOps";
import { type ActionState, selectionActions } from "./selection";
import type { DraftSession } from "./session";
import { moveInside, setStickerSize, type StickerLayer, stickerPercent, stickerZones, type ZoneId } from "./stickerOps";
import { type CaptionRefusal, insertAt, MAX_TEXT_SCALE, MIN_TEXT_SCALE, setCaption, setTextColor, setTextFont, setTextScale, setTextStyle, TEXT_COLORS, textSize, typingGoesOn } from "./textOps";
import { setLayerTime, timeRefusalLabel } from "./timeInput";
import { useCaptionCheck } from "./useCaptionCheck";
import { usePlayheadRest } from "./usePlayhead";
import { type TimelineState, useSelectionCommands } from "./useTimeline";

// The properties panel for a selected text or sticker (EditorText and EditorGif artboards; R21–R41). 3d.3b drew the head («Текст ·
// слой 1 из 3 · 0.3–4.4 с», «Стикер 2 из 2 · 6.0–9.6 с · петля»), «Дублировать» / «Удалить» and the z-order («Выше» / «Ниже», no
// artboard draws it). 3d.5 adds the rest, each control one undo step through the session (a slider drag or a typing burst is ONE):
// - a text: the caption with the ENGINE's verdict inline (montages.textPreview → TEXT_INVALID + captionIssue, in the shared Russian
//   words), the emoji chips, «Стиль», the five fonts, «Размер» (CF13: the slider moves `scale`, the figure is round(scale × 56)),
//   «Плашка» / «Цвет» (Q2: the colour paints the plaque for «Плашка», the text for the others), «Время»;
// - a sticker: its picture, name, loop and category, «Размер» (CF12: 5–60 %), «Время», the Reels zone warning with «Сдвинуть
//   внутрь» (AM10, R39–R40) and «Заменить стикер» (the «GIF» tab swaps it in place).
// The music card is MusicCard.tsx.

function Step({ label, icon, state, onClick }: { label: string; icon: "layerUp" | "layerDown"; state: ActionState; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-s ed-zstep" disabled={!state.enabled} title={state.enabled ? undefined : actionWhyLabel(state.why)} onClick={onClick}>
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

/** Delete on the panel removes the selected item, as on the timeline; a control keeps its own keys (keys.ts). */
export function deleteKeyHandler(remove: () => boolean) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (ownsKeys(event.target) || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    remove();
  };
}

/** The live index of layer `layerId` in the session's current draft (it may have moved since this render). */
const liveIndex = (session: DraftSession, layerId: string): number => session.state.spec.layers.findIndex((l) => l.layerId === layerId);

/**
 * A slider's undo steps (review round 1): each press of the pointer or of a key is ONE gesture with a merge key of its own, so two
 * drags are two steps even when a release was never seen (let go outside the window), and a held key's repeats stay in its step.
 * A change no gesture announced is a step of its own.
 */
function useSliderGesture(session: DraftSession, base: string) {
  const key = useRef<string | null>(null);
  const begin = (id: string): void => {
    session.endMerge();
    key.current = `${base}:${id}`;
  };
  const end = (): void => {
    session.endMerge();
    key.current = null;
  };
  return {
    mergeKey: (): string | undefined => key.current ?? undefined,
    handlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLInputElement>) => begin(`${event.pointerId}:${event.timeStamp}`),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (!event.repeat) begin(`key:${event.key}:${event.timeStamp}`);
      },
      onPointerUp: end,
      onKeyUp: end,
      onBlur: end,
    },
  };
}

// ---------- «Время» (R32, R37) ----------

function TimeFields({ session, layer }: { session: DraftSession; layer: TextLayer | StickerLayer }) {
  const [typing, setTyping] = useState<{ edge: LayerEdge; text: string } | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const labelId = useId();
  const whyId = useId();

  function commit(edge: LayerEdge): void {
    if (typing === null || typing.edge !== edge) return;
    const at = liveIndex(session, layer.layerId);
    setTyping(null);
    if (at < 0) return;
    const edit = setLayerTime(session.state.spec, at, edge, typing.text);
    if (!edit.ok) {
      setWhy(timeRefusalLabel(edit.reason, totalMs(session.state.spec)));
      return;
    }
    setWhy(null);
    if (edit.spec !== session.state.spec) session.edit(edit.spec);
  }

  const field = (edge: LayerEdge) => {
    const ms = edge === "start" ? layer.startMs : layer.endMs;
    return (
      <input
        className="in in-s ed-time-in"
        type="text"
        inputMode="decimal"
        aria-label={edge === "start" ? "Начало, секунды" : "Конец, секунды"}
        aria-describedby={why !== null ? whyId : undefined}
        value={typing?.edge === edge ? typing.text : (ms / 1000).toFixed(1)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setTyping({ edge, text: e.target.value })}
        onBlur={() => commit(edge)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) commit(edge);
          if (e.key === "Escape") {
            e.preventDefault();
            setTyping(null);
            setWhy(null);
          }
        }}
      />
    );
  };

  return (
    <div className="ed-time">
      <div className="ed-prow ed-time-row" role="group" aria-labelledby={labelId}>
        <span id={labelId} className="ed-field-label">
          Время
        </span>
        {field("start")}
        <span className="faint">—</span>
        {field("end")}
        <span className="mono faint">с</span>
      </div>
      {why !== null && (
        <span id={whyId} className="ed-field-why" role="status">
          {why}
        </span>
      )}
    </div>
  );
}

// ---------- a text (R23–R32) ----------

const STYLES: readonly { id: TextStyle; label: string }[] = [
  { id: "plaque", label: "Плашка" },
  { id: "outline", label: "Обводка" },
  { id: "none", label: "Без фона" },
];

const FONTS: readonly { id: TextFont; label: string }[] = [
  { id: "playfair", label: "Playfair" },
  { id: "manrope", label: "Manrope" },
  { id: "oswald", label: "Oswald" },
  { id: "ptmono", label: "PT Mono" },
  { id: "caveat", label: "Caveat" },
];

/** The artboard's emoji chips (R27); the engine's verdict says if the font lacks one. */
const EMOJI = ["☀️", "☕", "✨", "💛", "🌿", "📍", "🥐"] as const;

function TextFields({ session, layer, avatarId }: { session: DraftSession; layer: TextLayer; avatarId: string }) {
  const { client } = useEngine();
  const area = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const noticeId = useId();
  const sizeId = useId();
  const colorId = useId();
  /** Text the field holds but the draft does not: the contract or the layout refuses it, so it never reached the engine. */
  const [typed, setTyped] = useState<{ text: string; reason: CaptionRefusal } | null>(null);
  const check = useCaptionCheck(client, avatarId, layer);
  // The draft's caption moved under the field (an undo, another window): the field shows it again.
  useEffect(() => setTyped(null), [layer.value]);
  const value = typed?.text ?? layer.value;
  const notice = captionNotice(typed?.reason ?? null, check);
  // Text far past the contract's bound is never segmented (review round 1): it is over the limit, whatever it holds.
  const huge = value.length > MAX_CAPTION_UNITS;
  const count = huge ? null : graphemeCount(value);
  const captionKey = `caption:${layer.layerId}`;
  /** When the last keystroke of the open typing burst came (null: none is open): the burst is one undo step. */
  const lastTyped = useRef<number | null>(null);
  const size = useSliderGesture(session, `scale:${layer.layerId}`);

  /** An edit of this text through the session, as one undo step (or a step of `mergeKey`'s gesture). */
  function apply(edit: (spec: MontageDraft, at: number) => MontageDraft, mergeKey?: string): void {
    const at = liveIndex(session, layer.layerId);
    if (at < 0) return;
    const next = edit(session.state.spec, at);
    if (next !== session.state.spec) session.edit(next, mergeKey === undefined ? {} : { mergeKey });
  }

  function type(text: string, mergeKey?: string): void {
    const at = liveIndex(session, layer.layerId);
    if (at < 0) return;
    const edit = setCaption(session.state.spec, at, text);
    if (!edit.ok) {
      setTyped({ text, reason: edit.reason });
      return;
    }
    setTyped(null);
    if (edit.spec !== session.state.spec) session.edit(edit.spec, mergeKey === undefined ? {} : { mergeKey });
  }

  function insertEmoji(emoji: string): void {
    const field = area.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const next = insertAt(value, start, end, emoji);
    // An emoji is a step of its own, apart from the typing around it (an edit with no merge key always is one).
    lastTyped.current = null;
    type(next.value);
    requestAnimationFrame(() => {
      const now = area.current;
      if (now === null) return;
      now.focus();
      now.setSelectionRange(next.caret, next.caret);
    });
  }

  /**
   * A keystroke: one step per burst, which ends on blur or after TYPING_PAUSE_MS without typing (the editor's default, 1.5 s).
   * The pause is read off the clock at each keystroke, so no timer runs.
   */
  function onType(text: string): void {
    const now = Date.now();
    if (!typingGoesOn(lastTyped.current, now)) session.endMerge();
    lastTyped.current = now;
    type(text, captionKey);
  }

  // A verdict about the text BEFORE the newest ask is shown dimmed, outside the live region, and is not the field's error.
  const fresh = notice.text !== null && !notice.pending;
  const describedBy = [hintId, fresh ? noticeId : null].filter(Boolean).join(" ");
  const over = huge || (count ?? 0) > MAX_CAPTION_GRAPHEMES;

  return (
    <>
      <div className="ed-pgroup ed-caption">
        <div className="ed-prow ed-caption-head">
          <label htmlFor={fieldId} className="lbl">
            Текст
          </label>
          <span className={over ? "mono ed-caption-count ed-caption-over" : "mono faint ed-caption-count"} aria-label={count === null ? `больше ${MAX_CAPTION_GRAPHEMES} символов` : `${count} из ${MAX_CAPTION_GRAPHEMES} символов`}>
            {count === null ? `>${MAX_CAPTION_GRAPHEMES}` : count}/{MAX_CAPTION_GRAPHEMES}
          </span>
        </div>
        <textarea
          ref={area}
          id={fieldId}
          className="in emo ed-caption-in"
          lang="en"
          rows={2}
          spellCheck={false}
          aria-invalid={notice.tone === "error" && !notice.pending ? true : undefined}
          aria-describedby={describedBy}
          aria-busy={notice.pending || undefined}
          value={value}
          onChange={(e) => onType(e.target.value)}
          onBlur={() => {
            lastTyped.current = null;
            session.endMerge();
          }}
        />
        <span id={hintId} className="faint ed-caption-hint">
          только английский · эмодзи можно · до 2 строк
        </span>
        <p id={noticeId} className={fresh ? `ed-caption-notice ed-caption-${notice.tone ?? "error"}` : "ed-caption-notice"} aria-live="polite">
          {fresh ? notice.text : ""}
        </p>
        {notice.text !== null && notice.pending && <p className={`ed-caption-stale ed-caption-${notice.tone ?? "error"}`}>{notice.text}</p>}
        <div className="ed-emoji" role="group" aria-label="Вставить эмодзи">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" className="chip emo ed-emoji-chip" aria-label={`Вставить ${emoji}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insertEmoji(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <div className="ed-pgroup">
        <span className="lbl">Стиль</span>
        <div className="seg ed-text-style" role="group" aria-label="Стиль текста">
          {STYLES.map((style) => (
            <button key={style.id} type="button" className={layer.style === style.id ? "on" : undefined} aria-pressed={layer.style === style.id} onClick={() => apply((spec, at) => setTextStyle(spec, at, style.id))}>
              {style.label}
            </button>
          ))}
        </div>
        <div className="ed-fonts" role="group" aria-label="Шрифт">
          {FONTS.map((font) => (
            <button key={font.id} type="button" className={layer.font === font.id ? `chip chip-on ed-font cap-f-${font.id}` : `chip ed-font cap-f-${font.id}`} aria-pressed={layer.font === font.id} onClick={() => apply((spec, at) => setTextFont(spec, at, font.id))}>
              {font.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ed-pgroup ed-pgroup-fields">
        <div className="ed-prow ed-field">
          <label htmlFor={sizeId} className="ed-field-label">
            Размер
          </label>
          <input
            id={sizeId}
            type="range"
            min={Math.round(MIN_TEXT_SCALE * 100)}
            max={Math.round(MAX_TEXT_SCALE * 100)}
            step={1}
            value={Math.round(layer.scale * 100)}
            aria-valuetext={`${textSize(layer.scale)}`}
            onChange={(e) => apply((spec, at) => setTextScale(spec, at, Number(e.target.value) / 100), size.mergeKey())}
            {...size.handlers}
          />
          <span className="mono ed-field-value">{textSize(layer.scale)}</span>
        </div>
        <div className="ed-prow ed-field">
          <span id={colorId} className="ed-field-label">
            {layer.style === "plaque" ? "Плашка" : "Цвет"}
          </span>
          <div className="ed-swatches" role="group" aria-labelledby={colorId}>
            {TEXT_COLORS.map(({ color, label }) => (
              <button key={color} type="button" className={layer.color === color ? "swatch swatch-on" : "swatch"} style={{ background: color }} aria-label={label} aria-pressed={layer.color === color} onClick={() => apply((spec, at) => setTextColor(spec, at, color))} />
            ))}
          </div>
        </div>
        <TimeFields session={session} layer={layer} />
      </div>
    </>
  );
}

// ---------- a sticker (R35–R41) ----------

const ZONE_WORDS: Record<"bottom" | "right" | "both", { title: string; text: string }> = {
  right: { title: "Под кнопками Reels", text: "Стикер заходит в зону справа: в ленте его могут перекрыть лайки и комментарии." },
  bottom: { title: "Под подписью Reels", text: "Стикер заходит в зону снизу: в ленте его закроют подпись и аудио." },
  both: { title: "Под кнопками и подписью Reels", text: "Стикер заходит в зоны справа и снизу: в ленте его могут закрыть кнопки, подпись и аудио." },
};

function zoneWords(zones: readonly ZoneId[]): { title: string; text: string } | null {
  if (zones.length === 0) return null;
  if (zones.length > 1) return ZONE_WORDS.both;
  return zones[0] === "bottom" ? ZONE_WORDS.bottom : ZONE_WORDS.right;
}

function StickerFields({ session, layer, onReplace }: { session: DraftSession; layer: StickerLayer; onReplace: () => void }) {
  const { client } = useEngine();
  const sizeId = useId();
  const entry = layer.sticker.source === "builtin" ? stickerById(layer.sticker.stickerId) : undefined;
  const category = entry === undefined ? undefined : STICKER_CATEGORIES.find((c) => c.id === entry.category);
  const url = entry === undefined ? null : stickerUrl(client, entry.id);
  const loop = loopLabel(layer);
  const zone = zoneWords(stickerZones(layer));
  const size = useSliderGesture(session, `size:${layer.layerId}`);

  function apply(edit: (spec: MontageDraft, at: number) => MontageDraft, mergeKey?: string): void {
    const at = liveIndex(session, layer.layerId);
    if (at < 0) return;
    const next = edit(session.state.spec, at);
    if (next !== session.state.spec) session.edit(next, mergeKey === undefined ? {} : { mergeKey });
  }

  return (
    <>
      <div className="ed-sticker-card">
        <span className="stk ed-sticker-thumb" aria-hidden="true">
          {url === null ? <Icon name="sparkle" size={22} /> : <img src={url} alt="" draggable={false} />}
        </span>
        <span className="ed-sticker-facts">
          <span className="ed-sticker-name">{stickerName(layer)}</span>
          <span className="mono muted">{entry === undefined ? (layer.sticker.source === "own" ? "свой · скоро" : "нет во встроенном наборе") : `встроенный · ${loop ?? ""}`}</span>
          {category !== undefined && <span className="tag">{category.nameRu}</span>}
        </span>
      </div>

      <div className="ed-pgroup ed-pgroup-fields">
        <div className="ed-prow ed-field">
          <label htmlFor={sizeId} className="ed-field-label">
            Размер
          </label>
          <input
            id={sizeId}
            type="range"
            min={5}
            max={60}
            step={1}
            value={stickerPercent(layer.size)}
            aria-valuetext={`${stickerPercent(layer.size)} %`}
            onChange={(e) => apply((spec, at) => setStickerSize(spec, at, Number(e.target.value) / 100), size.mergeKey())}
            {...size.handlers}
          />
          <span className="mono ed-field-value">
            {stickerPercent(layer.size)}
            {NBSP}%
          </span>
        </div>
        <TimeFields session={session} layer={layer} />
        <span className="faint ed-props-note">Анимация идёт по кругу весь отрезок. Позицию в кадре можно будет менять в превью.</span>
      </div>

      {zone !== null && (
        <div className="ed-zone" role="status">
          <Icon name="alert" size={16} />
          <div className="ed-zone-body">
            <p className="ed-zone-title">{zone.title}</p>
            <p className="ed-zone-text">{zone.text}</p>
            <button type="button" className="btn btn-s" onClick={() => apply((spec, at) => moveInside(spec, at))}>
              Сдвинуть внутрь
            </button>
          </div>
        </div>
      )}

      <button type="button" className="btn btn-s ed-props-replace" onClick={onReplace}>
        Заменить стикер
      </button>
    </>
  );
}

// ---------- the panel ----------

export interface LayerPropertiesProps {
  readonly session: DraftSession;
  readonly spec: MontageDraft;
  readonly index: number;
  readonly timeline: TimelineState;
  readonly avatarId: string;
  /** «Заменить стикер»: the «GIF» tab, set to swap this layer's sticker. */
  readonly onReplaceSticker: (layerId: string) => void;
}

export function LayerProperties({ session, spec, index, timeline, avatarId, onReplaceSticker }: LayerPropertiesProps) {
  const commands = useSelectionCommands(session, timeline);
  const onKeyDown = deleteKeyHandler(commands.remove);
  // Where the playhead rests (3d.4): a playback does not re-render the panel.
  const restMs = usePlayheadRest(timeline.playhead);
  const layer = spec.layers[index];
  if (layer === undefined) return null;
  const actions = selectionActions(spec, timeline.selection, restMs);
  const ofKind = spec.layers.filter((l) => l.kind === layer.kind);
  const place = spec.layers.slice(0, index + 1).filter((l) => l.kind === layer.kind).length;
  const loop = layer.kind === "sticker" ? loopLabel(layer) : null;
  const sub = [rangeLabel(layer.startMs, layer.endMs), ...(loop === null ? [] : ["петля"]), ...(layer.endMs > totalMs(spec) ? ["после конца ролика"] : [])].join(" · ");

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

      {layer.kind === "text" ? (
        <TextFields key={layer.layerId} session={session} layer={layer} avatarId={avatarId} />
      ) : (
        <StickerFields key={layer.layerId} session={session} layer={layer} onReplace={() => onReplaceSticker(layer.layerId)} />
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
    </aside>
  );
}
