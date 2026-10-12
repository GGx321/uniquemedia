import type { LegsShare } from "../../../shared/engine";
import { LEGS_OPTIONS } from "./legs";

// S5.8b (mockups 33, 34): «Нет · Немного 15 % · Много 30 %» — chips that are native radios of one group, as the generate card and «Автопилот» draw them.
// `off` disables them (no built-in category on, or too few new photos: the caption says why); `readOnly` leaves them reachable but unchangeable (a running
// launch's own settings, as «Подача» there).

export interface LegsChipsProps {
  /** The radios' shared name: one group to the keyboard. */
  readonly name: string;
  readonly labelledBy: string;
  readonly describedBy: string | undefined;
  /** The chip that reads on. */
  readonly shown: LegsShare;
  readonly off: boolean;
  readonly readOnly?: boolean;
  readonly onPick: (share: LegsShare) => void;
}

export function LegsChips({ name, labelledBy, describedBy, shown, off, readOnly = false, onPick }: LegsChipsProps) {
  return (
    <div className="choice-options gen-legs" role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {LEGS_OPTIONS.map((option) => {
        const on = shown === option.value;
        return (
          <label key={option.value} className="choice-option">
            <input
              type="radio"
              className="choice-input"
              name={name}
              value={option.value}
              checked={on}
              disabled={off}
              aria-disabled={readOnly || undefined}
              onChange={() => {
                if (!readOnly) onPick(option.value);
              }}
            />
            <span className={on ? "chip chip-on" : "chip"}>
              {option.label}
              {option.share !== null && (
                <>
                  {" "}
                  <span className="mono gen-chip-pct">{option.share}</span>
                </>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
