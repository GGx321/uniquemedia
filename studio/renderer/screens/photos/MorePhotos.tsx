import { useEffect, useId, useRef } from "react";
import { MAX_LISTED_PHOTOS } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { countOf, groupNumber, NBSP } from "../../lib/format";
import { Icon, Spin } from "../../ui/Icon";
import { useAnnouncer } from "../../ui/useAnnouncer";
import type { PhotoPages } from "./photoPages";
import { PHOTO_FORMS } from "./shared";
import type { MoreState } from "./usePhotoPages";

// S4.P2: «Показать ещё» at the end of an avatar's photos. The owner's mockups draw none, so it is drawn in their language: a quiet
// secondary button with what remains in mono, «Показать ещё · 1 201». Busy while the next page is on its way (the button keeps the
// focus: aria-disabled, never disabled); failed with the reason under it and «Повторить» on the same button; and, on the «Фото»
// gallery once the owner has paged to it, the gallery's end. The page in, the focus goes to its first photo on screen.

export interface MorePhotosProps {
  readonly pages: PhotoPages;
  readonly more: MoreState;
  /** The photos the last «Показать ещё» brought (a new array each time), from `usePhotoPages`. */
  readonly added: readonly string[] | null;
  readonly onMore: () => void;
  /** The control of the first of `photoIds` that is on screen and can take the focus (a filter may hide some), in that order. */
  readonly firstShown: (photoIds: readonly string[]) => HTMLElement | null;
  /** Where the focus goes when nothing the page brought is shown and the button went with the last page. */
  readonly fallback: () => HTMLElement | null;
  /** `gallery`: under the «Фото» grid, a hairline either side, and the gallery's end; `bin`: the editor's narrow bin, the button alone. */
  readonly variant: "gallery" | "bin";
}

const photos = (n: number): string => `${groupNumber(n)}${NBSP}фото`;

/** The button's description: how much one press brings of what remains. */
function nextPageHint(remaining: number): string {
  return remaining > MAX_LISTED_PHOTOS ? `Следующие ${MAX_LISTED_PHOTOS} из ${photos(remaining)}` : `Остаток галереи: ${photos(remaining)}`;
}

export function MorePhotos({ pages, more, added, onMore, firstShown, fallback, variant }: MorePhotosProps) {
  const hintId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [spoken, say] = useAnnouncer();
  /** The page whose focus is dealt with: one brought before this mount (before a look at another tab) moves nothing. */
  const handled = useRef(added);

  useEffect(() => {
    if (added === handled.current) return;
    handled.current = added;
    if (added === null) return;
    // Only from where the owner asked: the button, or nowhere (the button went with the last page). A control he moved to meanwhile keeps it.
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== button.current) return;
    const tile = added.length > 0 ? firstShown(added) : null;
    if (tile !== null) {
      tile.focus();
      return;
    }
    // Nothing of the page on screen: the focus stays on the button, or, the button gone with the last page, goes to `fallback`; and
    // what happened is said, as nothing new took the focus to say it (review LOW-2: a last page that came empty, its photos gone).
    if (button.current === null) fallback()?.focus();
    say(added.length === 0 ? "Больше фото нет" : `Загружено ещё ${countOf(added.length, PHOTO_FORMS)}: ни одно не подходит под этот фильтр`);
  }, [added, firstShown, fallback, say]);

  const loading = more.status === "loading";
  const failed = more.status === "failed" ? more.error : null;
  const rules = variant === "gallery";
  const end = rules && pages.nextCursor === null && pages.depth !== null;
  // Nothing beyond the first page, or nothing more in the bin: no row at all (it would cost its column a gap). The live region stays,
  // out of the layout (.sr-only), so a last page that just came in is still said and its focus still moves.
  const shown = pages.nextCursor !== null || end;

  return (
    <>
      {shown && (
        <div className={`photos-more photos-more-${variant}`}>
          {pages.nextCursor !== null && (
            <>
              <div className="photos-more-row">
                {rules && <span className="photos-more-rule" aria-hidden="true" />}
                <button
                  ref={button}
                  type="button"
                  className="btn btn-s photos-more-btn"
                  data-state={more.status}
                  aria-busy={loading}
                  aria-disabled={loading || undefined}
                  aria-describedby={hintId}
                  onClick={() => {
                    if (!loading) onMore();
                  }}
                >
                  {loading ? <Spin /> : <Icon name={failed === null ? "chevronDown" : "reload"} size={14} strokeWidth={2.2} />}
                  {failed === null ? (
                    <>
                      Показать ещё <span className="mono photos-more-count">· {groupNumber(pages.remainingTotal)}</span>
                    </>
                  ) : (
                    "Повторить"
                  )}
                </button>
                {rules && <span className="photos-more-rule" aria-hidden="true" />}
              </div>
              <span id={hintId} className="sr-only">
                {nextPageHint(pages.remainingTotal)}
              </span>
              {failed !== null && (
                <p className="photos-more-error" role="alert">
                  <Icon name="alert" size={14} />
                  <span>Не удалось загрузить ещё фото. {errorText(failed)}</span>
                </p>
              )}
            </>
          )}
          {end && (
            <div className="photos-more-row photos-more-end">
              <span className="photos-more-rule" aria-hidden="true" />
              <span className="mono">Конец галереи · {photos(pages.photos.length)}</span>
              <span className="photos-more-rule" aria-hidden="true" />
            </div>
          )}
        </div>
      )}
      <span className="sr-only photos-more-said" aria-live="polite">
        {spoken}
      </span>
    </>
  );
}
