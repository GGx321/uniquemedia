import { useId, useState } from "react";
import { Icon } from "../../ui/Icon";
import type { OwnAnglesLine } from "./categoryText";

// CS.8b, S5.7c: the lines that name the categories keeping angles of their own — under the angle note of the generate card and of «Автопилот» (mockup 27:
// «У «{имя}» свои ракурсы: …»), and in the scene set's strip («у «{имя}» и ещё N — свои»). «ещё N» opens every such category with its angles under the
// line, so the names a mouse finds in the title are within a keyboard's reach too (README «Keyboard and focus»: a disclosure, the focus staying on it).

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
 * S5.7c (mockup 27): the line under «Ракурс берётся из сцены…» when a category of the run keeps angles of its own — «У «{имя}» свои ракурсы: {список}.», or with
 * several «У «{имя}» и [ещё N] — свои ракурсы.», the button opening the list.
 */
export function OwnAnglesNote({ line, className }: { line: OwnAnglesLine; className?: string }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={className === undefined ? "gen-angle-owners" : `gen-angle-owners ${className}`} title={line.title}>
      <p className="gen-angle-own">
        <Icon name="info" size={12} strokeWidth={2.2} />
        {line.list !== null ? (
          <span>
            У «<span className="angles-owner-name">{line.name}</span>» свои ракурсы: <span className="angles-owner-name">{line.list}</span>.
          </span>
        ) : (
          <span>
            У «<span className="angles-owner-name">{line.name}</span>» и <MoreButton label={line.moreLabel} open={open} controls={listId} onToggle={() => setOpen((o) => !o)} /> —
            свои ракурсы.
          </span>
        )}
      </p>
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
