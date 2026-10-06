import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { MAX_CUSTOM_CATEGORIES, SceneCategory, type CategorySummary } from "../../../shared/engine";
import type { CategoryCall, CategoryList, CategoryOutcome } from "../../engine/categoryLibrary";
import { errorText } from "../../lib/errors";
import { Icon } from "../../ui/Icon";
import { libraryHeld } from "./categoryText";
import { CATEGORY_LABEL, type RunCategory } from "./runForm";

// CS.3: the generate card's category row (CatChips, the CategoryStates sheet's row): the five built-ins in their order, then the owner's
// own in creation order, drawn alike; «+ Своя» (dashed) always last; «Мои категории · N» a text button in the label row. More than four
// custom ones: the first four and every one turned on stay, the rest wait behind «ещё N» and open in place (decision 1). While this
// window composes a pool, its chip spins in the row; hidden with «Скрыть» it takes the focus, and a click opens the dialog again.

/** Custom chips the row always shows, in creation order, besides every one turned on. */
const CUSTOM_SHOWN = 4;

/** The chip of a pool being composed: not toggleable; it reopens the dialog. When it goes with the focus on it, the row moves the focus on. */
function WaitingChip({ name, onOpen, onGone }: { name: string; onOpen: () => void; onGone: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const gone = useRef(onGone);
  useLayoutEffect(() => {
    gone.current = onGone;
  });
  useLayoutEffect(
    () => () => {
      // Read as it goes: the element is still in the page while its layout effects are cleaned up.
      if (ref.current !== null && ref.current === document.activeElement) gone.current();
    },
    [],
  );
  return (
    <button ref={ref} type="button" className="chip chip-wait cat-chip" data-chip-wait="" aria-busy="true" aria-label={`${name} — создаётся`} title={name} onClick={onOpen}>
      <span className="spin chip-spin" aria-hidden="true" />
      <span className="chip-cap">{name}</span>
    </button>
  );
}

export function CategoryRow({
  rootRef,
  categories,
  perCategory,
  list,
  creating,
  outcome,
  onToggle,
  onCreate,
  onReopen,
  onSheet,
  onRetry,
}: {
  /** The row's own element: the card finds the chips in it to put the focus back after the dialog. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** The run's categories (built-ins, then custom in creation order). */
  categories: readonly RunCategory[];
  perCategory: ReadonlyMap<RunCategory, number>;
  list: CategoryList;
  /** This window's create on its way, if any: its chip spins in the row. */
  creating: CategoryCall | null;
  /** How this window's last create ended: the focus goes to its chip when the spinning one had it. */
  outcome: CategoryOutcome | null;
  onToggle: (ref: RunCategory) => void;
  onCreate: () => void;
  onReopen: () => void;
  onSheet: () => void;
  onRetry: () => void;
}) {
  const ids = useId();
  const labelId = `${ids}-cats`;
  const limitId = `${ids}-limit`;
  const groupRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const customs: readonly CategorySummary[] = list.status === "ready" ? list.categories : [];
  const held = list.status === "ready" ? libraryHeld(list) : null;
  const full = held !== null && held >= MAX_CUSTOM_CATEGORIES;
  const on = new Set<string>(categories);

  const visible = expanded ? customs : customs.filter((c, i) => i < CUSTOM_SHOWN || on.has(c.categoryId));
  const hidden = customs.length - customs.filter((c, i) => i < CUSTOM_SHOWN || on.has(c.categoryId)).length;

  // The spinning chip had the focus when its pool came back: the focus goes to the new chip (made), or to «+ Своя» (not made).
  const handOff = useRef(false);
  useEffect(() => {
    if (!handOff.current || creating !== null) return;
    handOff.current = false;
    const made = outcome?.ok === true ? outcome.category.categoryId : null;
    const target = made !== null ? groupRef.current?.querySelector<HTMLElement>(`[data-category="${made}"]`) : addRef.current;
    (target ?? addRef.current)?.focus();
  }, [creating, outcome]);

  const chip = (ref: RunCategory, label: string) => {
    const isOn = on.has(ref);
    const n = perCategory.get(ref);
    return (
      <button
        key={ref}
        type="button"
        className={isOn ? "chip chip-on cat-chip" : "chip cat-chip"}
        data-category={ref}
        aria-pressed={isOn}
        aria-label={isOn && n !== undefined ? `${label}: ${n} фото` : label}
        title={label}
        onClick={() => onToggle(ref)}
      >
        <span className="chip-cap">{label}</span>
        {/* Always present, like the mockup's: an off chip keeps the same 6px gap after its label. */}
        <span className="mono photos-chip-n" aria-hidden="true">
          {isOn && n !== undefined ? n : ""}
        </span>
      </button>
    );
  };

  return (
    <div ref={rootRef} className="photos-gen-cats">
      <div className="cat-label-row">
        <span id={labelId} className="lbl">
          Категории · фото в каждой
        </span>
        <button
          type="button"
          className="lbtn"
          data-my-categories=""
          aria-haspopup="dialog"
          aria-label={list.status === "ready" ? `Мои категории · ${customs.length}` : "Мои категории"}
          onClick={onSheet}
        >
          <Icon name="list" size={13} strokeWidth={2.2} />
          Мои категории
          {list.status === "ready" && <span className="mono lbtn-n">{customs.length}</span>}
        </button>
      </div>
      <div ref={groupRef} className="photos-chips" role="group" aria-labelledby={labelId}>
        {SceneCategory.options.map((c) => chip(c, CATEGORY_LABEL[c]))}
        {visible.map((c) => chip(c.categoryId, c.name))}
        {creating !== null && <WaitingChip name={creating.name} onOpen={onReopen} onGone={() => (handOff.current = true)} />}
        {(hidden > 0 || expanded) && customs.length > CUSTOM_SHOWN && (
          <button key="more" type="button" className="chip chip-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {expanded ? "свернуть" : `ещё ${hidden}`}
            <span className={expanded ? "chip-more-icon chip-more-up" : "chip-more-icon"} aria-hidden="true">
              <Icon name="chevronDown" size={11} strokeWidth={2.4} />
            </span>
          </button>
        )}
        <button
          ref={addRef}
          type="button"
          className="chip chip-add"
          data-add-category=""
          aria-haspopup="dialog"
          aria-disabled={full}
          aria-describedby={full ? limitId : undefined}
          onClick={() => {
            if (!full) onCreate();
          }}
        >
          <Icon name="plus" size={11} strokeWidth={2.6} />
          Своя
        </button>
      </div>
      {full && (
        <span id={limitId} className="faint photos-note">
          {MAX_CUSTOM_CATEGORIES} из {MAX_CUSTOM_CATEGORIES} — удалите ненужную в «Мои категории».
        </span>
      )}
      {list.status === "failed" && (
        <span className="faint photos-note cat-list-failed">
          Свои категории не открылись: {errorText(list.error)}{" "}
          <button type="button" className="link-btn" onClick={onRetry}>
            Повторить
          </button>
        </span>
      )}
      {on.has("glam") && <span className="faint photos-note photos-cats-note">Гламур — только неоткровенные наряды: мини, корсет, облегающее платье.</span>}
    </div>
  );
}
