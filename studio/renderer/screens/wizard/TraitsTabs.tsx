import type { KeyboardEvent, ReactNode } from "react";

// S5.2d: the wizard's «Внешность» card holds two tabs, «Лицо и волосы» | «Тело N / 6» (.omc/stage5/design 01–03): with every body field the form
// no longer fits a 900 px window, and the tabs keep the card one height with «Случайно» / «Оценить» shared under both. The count keeps the body in sight.

export type TraitsTab = "face" | "body";

export interface TraitsTabIds {
  readonly face: string;
  readonly body: string;
  readonly facePanel: string;
  readonly bodyPanel: string;
}

const ORDER: readonly TraitsTab[] = ["face", "body"];

export function TraitsTabs({ tab, onChange, bodyCount, ids }: { tab: TraitsTab; onChange: (tab: TraitsTab) => void; bodyCount: number; ids: TraitsTabIds }) {
  // ← and → (and Home / End) move between the two tabs, round the ends, as the avatar page's tabs do.
  const onKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    let next: TraitsTab | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") next = ORDER[(ORDER.indexOf(tab) + 1) % ORDER.length] ?? "face";
    else if (event.key === "Home") next = "face";
    else if (event.key === "End") next = "body";
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    document.getElementById(next === "face" ? ids.face : ids.body)?.focus();
  };
  const button = (which: TraitsTab, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      id={which === "face" ? ids.face : ids.body}
      aria-selected={tab === which}
      aria-controls={which === "face" ? ids.facePanel : ids.bodyPanel}
      tabIndex={tab === which ? 0 : -1}
      className={tab === which ? "on" : undefined}
      onClick={() => onChange(which)}
      onKeyDown={onKey}
    >
      {label}
    </button>
  );
  return (
    <div className="seg traits-tabs" role="tablist" aria-label="Внешность">
      {button("face", "Лицо и волосы")}
      {button(
        "body",
        <>
          Тело
          <span className="mono tab-count" aria-hidden="true">
            {bodyCount} / 6
          </span>
          <span className="sr-only">, задано {bodyCount} из 6</span>
        </>,
      )}
    </div>
  );
}
