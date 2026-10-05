import { useState } from "react";
import type { MontageDraft } from "../../../shared/engine";
import { STICKER_CATEGORIES, STICKER_MANIFEST, type StickerCategoryId } from "../../../shared/stickers/manifest";
import { useEngine } from "../../engine/react";
import { stickerUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import { stickerUses } from "./stickerOps";

// 3d.5: the «GIF» tab (EditorGif.dc.html; G1–G10). The built-in set from the shared manifest (CF11: its 10 stickers, its Russian
// names and its 7 categories, not the artboard's 20), each tile with how often the montage uses it (G4) and a ring on the selected
// layer's sticker (G5). A click puts the sticker at the playhead (G6), or, after «Заменить стикер», swaps the selected layer's
// sticker in place (R41). At 10 stickers the tiles are off and the line says why (G10). The owner's own stickers are in the «Мои» tab (3f.6): the block here points there.

export interface StickerTabProps {
  readonly spec: MontageDraft;
  /** The selected layer's built-in sticker, ringed; null when no sticker layer is selected. */
  readonly current: string | null;
  /** «Заменить стикер» is under way for this layer («Стикер 2»): a tile replaces its sticker instead of adding one. */
  readonly replacing: string | null;
  readonly onCancelReplace: () => void;
  /** Why a sticker cannot be added at the playhead now (the cap, no room, no clips); null when it can. */
  readonly addWhy: string | null;
  readonly onPick: (stickerId: string) => void;
  /** Switches the media panel to the «Мои» tab, where the owner's own GIF and APNG live (3f.6). */
  readonly onOpenMine: () => void;
}

export function StickerTab({ spec, current, replacing, onCancelReplace, addWhy, onPick, onOpenMine }: StickerTabProps) {
  const { client } = useEngine();
  const [category, setCategory] = useState<StickerCategoryId | null>(null);
  const uses = stickerUses(spec);
  const categories = STICKER_CATEGORIES.filter((c) => STICKER_MANIFEST.some((s) => s.category === c.id));
  const shown = STICKER_MANIFEST.filter((s) => category === null || s.category === category);
  const blocked = replacing === null && addWhy !== null;

  return (
    <>
      <div className="ed-chips" role="group" aria-label="Категория стикеров">
        <button type="button" className={category === null ? "chip chip-on" : "chip"} aria-pressed={category === null} onClick={() => setCategory(null)}>
          Все
          <span className="mono ed-chip-count">{STICKER_MANIFEST.length}</span>
        </button>
        {categories.map((c) => (
          <button key={c.id} type="button" className={category === c.id ? "chip chip-on" : "chip"} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
            {c.nameRu}
          </button>
        ))}
      </div>

      {replacing !== null ? (
        <div className="ed-gif-replace" role="status">
          <span>
            Замена: <b>{replacing}</b> — выберите новый стикер, время и место останутся.
          </span>
          <button type="button" className="btn btn-s" onClick={onCancelReplace}>
            Отмена
          </button>
        </div>
      ) : (
        addWhy !== null && (
          <p className="ed-gif-cap" role="status">
            <Icon name="alert" size={14} />
            {addWhy}
          </p>
        )
      )}

      <div className="ed-gif-section">
        <span className="lbl">
          Встроенные <span className="mono">· {shown.length}</span>
        </span>
        <ul className={blocked ? "ed-gif-grid ed-gif-grid-off" : "ed-gif-grid"} aria-label="Встроенные стикеры">
          {shown.map((sticker) => {
            const url = stickerUrl(client, sticker.id);
            const count = uses.get(sticker.id) ?? 0;
            const on = sticker.id === current;
            const does = replacing !== null ? "заменить выбранный" : "в плейхед";
            return (
              <li key={sticker.id}>
                <button
                  type="button"
                  className={on ? "stk stk-on" : "stk"}
                  aria-label={`${sticker.nameRu}: ${does}${count > 0 ? `, в ролике ${count}` : ""}${on ? ", у выбранного слоя" : ""}`}
                  title={blocked ? (addWhy ?? undefined) : sticker.nameRu}
                  disabled={blocked}
                  onClick={() => onPick(sticker.id)}
                >
                  {url === null ? <Icon name="sparkle" size={20} /> : <img src={url} alt="" draggable={false} />}
                  {count > 0 && <span className="mono stk-count">{count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <span className="faint ed-gif-hint">{replacing !== null ? "Клик — этот стикер вместо прежнего." : "Клик — стикер в плейхед на 3 с, поверх остальных. Анимация идёт по кругу."}</span>
      </div>

      <div className="ed-gif-section ed-gif-mine">
        <span className="lbl">Мои</span>
        <span className="faint ed-gif-hint">Свои GIF и APNG — во вкладке «Мои».</span>
        <button type="button" className="btn btn-s" onClick={onOpenMine}>
          Открыть «Мои»
        </button>
      </div>
    </>
  );
}
