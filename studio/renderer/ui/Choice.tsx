import { useId } from "react";
import type { Choice } from "../lib/traits";

// Single and multiple choice built on native radio buttons and checkboxes:
// Tab enters a group, arrow keys move inside a radio group, Space toggles a
// checkbox, and screen readers get the group name from the legend. What the
// eye sees is the sheet's own component under each invisible input: `.chip`,
// a `.seg` of options, or a `.swatch`, with its `-on` / `.on` state.

interface RadioChoicesProps<T extends string> {
  legend: string;
  options: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  variant: "chips" | "segments" | "swatches";
  /** Keep the legend for screen readers only (the segment pairs share one visible label). */
  legendHidden?: boolean;
  /** `.seg-l`: the screen-header segments, as tall as a `.btn`. */
  large?: boolean;
}

function optionsClass(variant: RadioChoicesProps<string>["variant"], large: boolean): string {
  if (variant === "segments") return large ? "choice-options seg seg-l" : "choice-options seg";
  return variant === "swatches" ? "choice-options swatches" : "choice-options";
}

export function RadioChoices<T extends string>({ legend, options, value, onChange, variant, legendHidden, large = false }: RadioChoicesProps<T>) {
  const name = useId();
  return (
    <fieldset className="choice">
      <legend className={legendHidden ? "sr-only" : "fl"}>{legend}</legend>
      <div className={optionsClass(variant, large)}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label key={o.value} className="choice-option" title={variant === "swatches" ? o.label : undefined}>
              <input type="radio" className="choice-input" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} />
              {variant === "swatches" ? (
                <>
                  <span className={on ? "swatch swatch-on" : "swatch"} style={{ background: o.color }} aria-hidden="true" />
                  <span className="sr-only">{o.label}</span>
                </>
              ) : variant === "segments" ? (
                <span className={on ? "choice-face on" : "choice-face"}>{o.label}</span>
              ) : (
                <span className={on ? "chip chip-on" : "chip"}>{o.label}</span>
              )}
            </label>
          );
        })}
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
    <fieldset className="choice">
      <legend className="fl">{legend}</legend>
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
              <span className={checked ? "chip chip-on" : "chip"}>{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
