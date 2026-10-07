import { useId, useState } from "react";
import { Icon } from "../../ui/Icon";
import type { OwnAnglesLine } from "./categoryText";

// CS.8b: the two lines that say who does not follow a «Ракурсы» row — under the generate card's toggles (CatChipsAngles; README «Copy», «Card line») and in
// the scene set's strip («у «{имя}» и ещё N — свои», ReviewAngles). «ещё N» opens every such category with its angles under the line, so the names a screen
// reader hears and a mouse finds in the title are within a keyboard's reach too (README «Keyboard and focus»: a disclosure, the focus staying on it).

/** «{имя} — {список}» per line, under the line that opened it. */
export function OwnersList({ id, open, rows }: { id: string; open: boolean; rows: readonly { readonly name: string; readonly list: string }[] }) {
  return (
    <ul id={id} className="angles-owners" hidden={!open}>
      {rows.map((row) => (
        <li key={row.name}>
          <span className="angles-owner-name">{row.name}</span> — {row.list}
        </li>
      ))}
    </ul>
  );
}

/** The «ещё N» button: it opens and closes the list, `aria-expanded`, the focus staying on it. */
export function MoreButton({ label, open, controls, onToggle }: { label: string; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="link-btn angles-more" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {label}
      <span className={open ? "chip-more-icon chip-more-up" : "chip-more-icon"} aria-hidden="true">
        <Icon name="chevronDown" size={11} strokeWidth={2.4} />
      </span>
    </button>
  );
}

/**
 * The line under the card's «Ракурсы» when a category of the run has angles of its own: one line, the message first, the name capped, the list cut by an
 * ellipsis when it does not fit. The visible words are hidden from a screen reader, which hears `describedId` instead — every category with its angles, named
 * by the «Ракурсы» group's `aria-describedby` — while «ещё N категорий» stays a button it can reach.
 */
export function CardAnglesLine({ line, describedId }: { line: OwnAnglesLine; describedId: string }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="photos-angles-own" title={line.title}>
      <p className="photos-angles-own-line">
        <Icon name="info" size={12} strokeWidth={2.2} />
        {line.list !== null ? (
          <span className="photos-angles-own-text" aria-hidden="true">
            Эти переключатели не касаются «<span className="angles-owner-name photos-angles-own-name">{line.name}</span>» — у неё свои ракурсы:{" "}
            <span className="angles-owner-name">{line.list}</span>.
          </span>
        ) : (
          <span className="photos-angles-own-text">
            <span aria-hidden="true">
              Эти переключатели не касаются «<span className="angles-owner-name photos-angles-own-name">{line.name}</span>» и{" "}
            </span>
            <MoreButton label={line.moreLabel} open={open} controls={listId} onToggle={() => setOpen((o) => !o)} />
            <span aria-hidden="true"> — у них свои ракурсы.</span>
          </span>
        )}
      </p>
      <span id={describedId} className="sr-only">
        {line.full}
      </span>
      {line.more > 0 && <OwnersList id={listId} open={open} rows={line.rows} />}
    </div>
  );
}

/** A disclosure split in two: the strip's «ещё N» sits inside its sentence, the list it opens under the sentence. */
export function useOwnersDisclosure(): { readonly open: boolean; readonly listId: string; toggle(): void } {
  const listId = useId();
  const [open, setOpen] = useState(false);
  return { open, listId, toggle: () => setOpen((o) => !o) };
}

