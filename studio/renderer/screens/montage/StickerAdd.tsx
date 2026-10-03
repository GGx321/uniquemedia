import { useEffect, useId, useRef, useState } from "react";
import { STICKER_MANIFEST } from "../../../shared/stickers/manifest";
import { useEngine } from "../../engine/react";
import { stickerUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";

// 3d.3b: the «Стикеры» track's «+». Until the media panel's «GIF» tab lands (SLOT 3d.5: L10 says the «+» opens it), it
// opens a small menu of the built-in set right here; a pick puts that sticker at the playhead. The «+» is off at the cap
// or with no room, with the reason in its tooltip, as the components sheet draws the caps.

export interface StickerAddProps {
  /** The «+»'s accessible name: «Добавить стикер», or with why it is off. */
  readonly name: string;
  /** Why it is off; null when a sticker can be added. */
  readonly why: string | null;
  readonly onPick: (stickerId: string) => void;
}

export function StickerAdd({ name, why, onPick }: StickerAddProps) {
  const { client } = useEngine();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const disabled = why !== null;

  // Off (the cap was reached meanwhile): a menu left open would add past it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    // A press anywhere else closes it.
    const close = (event: Event): void => {
      if (!wrap.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div
      className="ed-sticker-add"
      ref={wrap}
      onKeyDown={(event) => {
        if (!open) return;
        // The menu's keys are its own: the timeline's Escape, Delete and arrows act on the selection and the playhead.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          plus.current?.focus();
          return;
        }
        const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const at = items.findIndex((item) => item === document.activeElement);
        const moves: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 };
        const to = moves[event.key];
        if (to !== undefined && at >= 0) {
          event.preventDefault();
          event.stopPropagation();
          items[(to + items.length) % items.length]?.focus();
          return;
        }
        if (event.key === "Delete" || event.key === "Backspace") event.stopPropagation();
      }}
    >
      <button
        ref={plus}
        type="button"
        className="tadd"
        aria-label={name}
        title={why ?? undefined}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((now) => !now)}
      >
        <Icon name="plus" size={11} strokeWidth={2.6} />
      </button>
      {open && (
        <div id={menuId} className="ed-sticker-menu" role="menu" aria-label="Стикер в плейхед">
          <span className="lbl ed-sticker-menu-title" aria-hidden="true">
            Стикер в плейхед
          </span>
          <div className="ed-sticker-grid">
            {STICKER_MANIFEST.map((sticker, i) => {
              const url = stickerUrl(client, sticker.id);
              return (
                <button
                  key={sticker.id}
                  ref={i === 0 ? first : undefined}
                  type="button"
                  role="menuitem"
                  className="ed-sticker-pick"
                  aria-label={sticker.nameRu}
                  title={sticker.nameRu}
                  onClick={() => {
                    setOpen(false);
                    onPick(sticker.id);
                    // The picked item goes with the menu: the focus comes back to «+», as on Escape.
                    plus.current?.focus();
                  }}
                >
                  {url === null ? <Icon name="sparkle" size={16} /> : <img src={url} alt="" draggable={false} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
