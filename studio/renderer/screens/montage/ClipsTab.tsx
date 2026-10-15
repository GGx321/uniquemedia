import { useEffect, useId, useRef } from "react";
import type { EngineError } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { NBSP } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { Poster } from "../clips/ClipTile";
import type { AddRefusal } from "./clipOps";
import { clipAction, clipsHint, type ClipTile, clipTileAria, clipTileTitle, PREPARING, pickAria, TAKEN_BAND, TAKEN_LABELS } from "./clipTiles";
import type { BinDrag, FillTarget } from "./mine";

// 5b.2 part A (S5.WA4; plan §5.1; mockups 57–57d, README §S5.WAD): the editor's «Клипы» tab, after «Фото». The draft avatar's ready clips, two to a row:
// the 5b.1 poster and pills («0:05», «1080p» / «Grok»), the frame's state at the poster's head, the motion and «Фото N» under it. A click (or a drag onto
// «Кадры») places the clip's own copy as an own video — made first when there is none («Готовим для монтажа…», an import job from the job list, so it
// outlives a window reload; no cancel). A taken frame (Q-F = 1) is dimmed and never placed. The state is on the `li`, what a click does on its button
// (README L5); a preparing tile stays focusable but does nothing (`aria-disabled`, `aria-busy`, L6), as does a clip that waits while a video of the draft
// is not known (S5.WA4 round 2). The tab's one live region is always there and is filled with what is being prepared (L7; round 2, L2). A refused
// preparation is a card over the tiles, one text per reason (57c); after a damaged file or a placement the draft no longer takes, the focus goes to the
// card's ✕ (round 2, L1). The tab has no delete: a copy lives and dies with its clip.

/** A refused preparation (57c): its card's key, the clip's motion for the title, and the reason's text. */
export interface ClipCard {
  readonly key: string;
  readonly motion: string;
  readonly text: string;
}

export interface ClipsTabProps {
  readonly avatarName: string;
  /** The tiles (`clipTiles`); null until `clips.list` first answers. */
  readonly tiles: readonly ClipTile[] | null;
  /** Why `clips.list` could not be read, while nothing was. */
  readonly listError: EngineError | null;
  readonly onRetryList: () => void;
  readonly cards: readonly ClipCard[];
  /** The card whose ✕ takes the focus now (a new `tick` asks again). */
  readonly cardFocus?: { readonly key: string; readonly tick: number } | null;
  readonly onCloseCard: (key: string) => void;
  /** The selected cell a photo click would fill: a clip still goes to the end (the hint says so). */
  readonly fillTarget: FillTarget;
  /** Why no kadr can be added (20 kadrs, or nothing left of the 15 s). */
  readonly addBlock: AddRefusal | null;
  /** A tile clicked: select its kadr, or place its copy at the end. */
  readonly onPick: (tile: ClipTile) => void;
  /** A clip dragged out of the tab (onto «Кадры»), or null when the drag ends. */
  readonly onDrag: (drag: BinDrag | null) => void;
}

/** A no-break space before a dash (README L3). */
const nbDash = (text: string): string => text.replace(/ — /g, `${NBSP}— `);

function TileHead({ tile }: { tile: ClipTile }) {
  const { state } = tile;
  if (state.kind === "taken") {
    return (
      <>
        <span className="ed-bin-dim" aria-hidden="true" />
        {TAKEN_BAND.has(state.why) ? (
          <span className="edc-band" aria-hidden="true">
            {TAKEN_LABELS[state.why]}
          </span>
        ) : (
          <span className="pill mono ed-bin-used edc-state" aria-hidden="true">
            {TAKEN_LABELS[state.why]}
          </span>
        )}
      </>
    );
  }
  if (state.kind === "damaged") return <span className="ed-bin-dim" aria-hidden="true" />;
  if (state.kind === "busy") {
    return (
      <>
        <span className="ed-bin-dim" aria-hidden="true" />
        <div className="shim" />
        {/* Said as news by the tab's one live region (round 2, L2); the `li` and the button name the state. */}
        <span className="mine-busy edc-busy" aria-hidden="true">
          <span className="spin" />
          <span className="edc-busy-label">{PREPARING}</span>
        </span>
      </>
    );
  }
  return null;
}

function ClipTileView({ tile, addBlock, hintId, onPick, onDrag }: { tile: ClipTile; addBlock: AddRefusal | null; hintId: string; onPick: (tile: ClipTile) => void; onDrag: (drag: BinDrag | null) => void }) {
  const { clip, state } = tile;
  const action = clipAction(tile, addBlock);
  const busy = state.kind === "busy";
  // A preparing tile, and one that waits while a video of the draft is not known, keep the focus and do nothing (README L6).
  const waiting = busy || action === "wait";
  const off = action === "taken" || action === "damaged" || action === "full";
  const draggable = (state.kind === "free" || state.kind === "failed") && addBlock === null;
  const title = clipTileTitle(tile, addBlock);
  const classes = [
    "edc-tile",
    state.kind === "placed" ? "edc-tile-in" : "",
    state.kind === "taken" || state.kind === "damaged" ? "edc-tile-taken" : "",
    busy ? "edc-tile-busy" : "",
    state.kind === "failed" || state.kind === "damaged" ? "edc-tile-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={classes} aria-label={clipTileAria(tile)} data-clip-id={clip.clipId}>
      <div className="ph edc-poster">
        <button
          type="button"
          className="edc-pick"
          aria-label={pickAria(tile, addBlock)}
          aria-describedby={hintId}
          title={title ?? undefined}
          // A preparing tile keeps the focus and says it is busy, but does nothing (README L6); a taken frame or a damaged file is off, as the bin's taken photo.
          disabled={off}
          aria-disabled={waiting || undefined}
          aria-busy={busy || undefined}
          draggable={draggable}
          onClick={() => {
            if (!waiting) onPick(tile);
          }}
          onDragStart={(e) => {
            if (!draggable) return;
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = "copy";
              // Chromium needs some data to start a drag; the clip itself travels in renderer state.
              e.dataTransfer.setData("text/plain", clip.motion.label);
            }
            onDrag({ source: "clip", clipId: clip.clipId });
          }}
          onDragEnd={() => onDrag(null)}
        >
          <Poster clip={clip} />
        </button>
        <TileHead tile={tile} />
        <div className="clip-pills edc-pills">
          <span className={tile.length === "0:10" ? "pill mono clip-len clip-len-long" : "pill mono clip-len"}>{tile.length}</span>
          {tile.tags.map((tag) => (
            <span key={tag} className="pill clip-tag">
              {tag}
            </span>
          ))}
        </div>
        {(state.kind === "failed" || state.kind === "damaged") && (
          <span className="edc-mark" aria-hidden="true">
            <Icon name="alert" size={12} strokeWidth={2.4} />
          </span>
        )}
        {state.kind === "placed" && <span className="mono ed-bin-slot">{state.slot}</span>}
      </div>
      <div className="edc-cap">
        <span className="edc-name" title={clip.motion.label}>
          {clip.motion.label}
        </span>
        {tile.source !== null && <span className="mono faint edc-src">{tile.source}</span>}
      </div>
    </li>
  );
}

/** A refused preparation (57c): «Мои»'s card in the warning tone; its ✕ says what it closes (README L4). */
function ClipAlert({ card, focusTick, onClose }: { card: ClipCard; focusTick: number | null; onClose: () => void }) {
  const title = `Клип «${card.motion}»`;
  const close = useRef<HTMLButtonElement>(null);
  // Round 2, L1: the tile that was pressed turned off (a damaged file) or the copy did not go in: the focus waits on this card's ✕, never on the page.
  useEffect(() => {
    if (focusTick !== null) close.current?.focus();
  }, [focusTick]);
  return (
    <div className="edc-alert" role="alert">
      <Icon name="alert" size={16} strokeWidth={2} />
      <span className="edc-alert-body">
        <span className="edc-alert-title">{title}</span>
        <span className="edc-alert-text">{card.text}</span>
      </span>
      <button ref={close} type="button" className="mine-x mine-x-card" aria-label={`Закрыть: ${title}`} onClick={onClose}>
        <Icon name="close" size={11} strokeWidth={2.6} />
      </button>
    </div>
  );
}

export function ClipsTab({ avatarName, tiles, listError, onRetryList, cards, cardFocus = null, onCloseCard, fillTarget, addBlock, onPick, onDrag }: ClipsTabProps) {
  const hintId = useId();
  // The tab's one live region, always mounted (round 2, L2): what is being prepared now.
  const preparing = (tiles ?? []).filter((tile) => tile.state.kind === "busy").map((tile) => `Клип «${tile.clip.motion.label}»: ${PREPARING}`);
  return (
    <>
      <div className="ed-chips">
        <span className="chip ed-chip-fixed" title="Аватар черновика не меняется">
          {avatarName}
        </span>
      </div>
      <p className="sr-only" role="status">
        {preparing.join(" ")}
      </p>
      {cards.map((card) => (
        <ClipAlert key={card.key} card={card} focusTick={cardFocus?.key === card.key ? cardFocus.tick : null} onClose={() => onCloseCard(card.key)} />
      ))}
      {tiles === null ? (
        listError !== null ? (
          <div className="mine-empty" role="alert">
            <p className="muted">Не удалось прочитать клипы. {errorText(listError)}</p>
            <button type="button" className="btn btn-s" onClick={onRetryList}>
              Повторить
            </button>
          </div>
        ) : (
          <div className="ed-bin edc-grid" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="edc-tile">
                <div className="ph edc-poster">
                  <div className="shim" />
                </div>
              </div>
            ))}
          </div>
        )
      ) : tiles.length === 0 ? (
        <div className="mine-empty edc-empty">
          <span className="mine-empty-ic" aria-hidden="true">
            <Icon name="film" size={18} strokeWidth={1.8} />
          </span>
          <p className="mine-empty-title">Клипов пока нет.</p>
          <p className="faint">{nbDash("Оживите фото — они появятся здесь.")}</p>
        </div>
      ) : (
        <>
          <ul className="ed-bin edc-grid" aria-label="Клипы аватара">
            {tiles.map((tile) => (
              <ClipTileView key={tile.clip.clipId} tile={tile} addBlock={addBlock} hintId={hintId} onPick={onPick} onDrag={onDrag} />
            ))}
          </ul>
          <p id={hintId} className={addBlock !== null ? "ed-bin-hint ed-bin-hint-full" : "faint ed-bin-hint"}>
            {clipsHint(fillTarget, addBlock)}
          </p>
        </>
      )}
    </>
  );
}
