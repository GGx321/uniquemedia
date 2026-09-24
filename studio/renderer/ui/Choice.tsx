import { useId } from "react";
import type { Choice } from "../lib/traits";

// Single and multiple choice built on native radio buttons and checkboxes:
// Tab enters a group, arrow keys move inside a radio group, Space toggles a
// checkbox, and screen readers get the group name from the legend. The chips,
// segments and swatches are only styles on the labels.

interface RadioChoicesProps<T extends string> {
  legend: string;
  options: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  variant: "chips" | "segments" | "swatches";
  /** Keep the legend for screen readers only (the segment pairs share one visible label). */
  legendHidden?: boolean;
}

export function RadioChoices<T extends string>({ legend, options, value, onChange, variant, legendHidden }: RadioChoicesProps<T>) {
  const name = useId();
  return (
    <fieldset className={`choice choice-${variant}`}>
      <legend className={legendHidden ? "sr-only" : "field-label"}>{legend}</legend>
      <div className="choice-options">
        {options.map((o) => (
          <label key={o.value} className="choice-option" title={variant === "swatches" ? o.label : undefined}>
            <input
              type="radio"
              className="choice-input"
              name={name}
              value={o.value}
              checked={o.value === value}
              onChange={() => onChange(o.value)}
            />
            {variant === "swatches" ? (
              <>
                <span className="swatch" style={{ background: o.color }} aria-hidden="true" />
                <span className="sr-only">{o.label}</span>
              </>
            ) : (
              <span className="choice-face">{o.label}</span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface CheckChipsProps<T extends string> {
  legend: string;
  options: readonly Choice<T>[];
  values: readonly T[];
  onChange: (values: T[]) => void;
}

export function CheckChips<T extends string>({ legend, options, values, onChange }: CheckChipsProps<T>) {
  return (
    <fieldset className="choice choice-chips">
      <legend className="field-label">{legend}</legend>
      <div className="choice-options">
        {options.map((o) => {
          const checked = values.includes(o.value);
          return (
            <label key={o.value} className="choice-option">
              <input
                type="checkbox"
                className="choice-input"
                value={o.value}
                checked={checked}
                onChange={() => onChange(checked ? values.filter((v) => v !== o.value) : [...values, o.value])}
              />
              <span className="choice-face">{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
