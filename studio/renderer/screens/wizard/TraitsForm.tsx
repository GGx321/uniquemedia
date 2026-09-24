import { useId } from "react";
import { yearsOld } from "../../lib/format";
import {
  BUILDS,
  ETHNICITIES,
  EYE_COLORS,
  HAIR_COLORS,
  HAIR_LENGTHS,
  HAIR_TEXTURES,
  MARKS,
  MAX_AGE,
  MIN_AGE,
  SKIN_TONES,
  type Traits,
  VIBE_MAX,
} from "../../lib/traits";
import { CheckChips, RadioChoices } from "../../ui/Choice";

interface TraitsFormProps {
  traits: Traits;
  onChange: (traits: Traits) => void;
  vibeIssues: readonly string[];
  /** Read-only: a draft exists (its descriptor is written) or the paid commands are on their way. */
  locked: boolean;
}

/** Step 1: the avatar's look, from the fixed choices of the contract. */
export function TraitsForm({ traits, onChange, vibeIssues, locked }: TraitsFormProps) {
  const ageId = useId();
  const vibeId = useId();
  const vibeHintId = useId();
  const vibeErrorId = useId();
  const set = <K extends keyof Traits>(key: K, value: Traits[K]): void => onChange({ ...traits, [key]: value });
  const invalid = vibeIssues.length > 0;

  return (
    <fieldset className="traits" disabled={locked}>
      <legend className="sr-only">Внешность</legend>

      <div className="field">
        <div className="field-row">
          <label className="field-label" htmlFor={ageId}>
            Возраст
          </label>
          <span className="mono muted" aria-hidden="true">
            {yearsOld(traits.age)} · от {MIN_AGE}
          </span>
        </div>
        <input
          id={ageId}
          className="range"
          type="range"
          min={MIN_AGE}
          max={MAX_AGE}
          step={1}
          value={traits.age}
          aria-valuetext={yearsOld(traits.age)}
          onChange={(e) => {
            const age = Math.round(Number(e.currentTarget.value));
            if (Number.isFinite(age)) set("age", Math.min(MAX_AGE, Math.max(MIN_AGE, age)));
          }}
        />
      </div>

      <RadioChoices legend="Типаж" variant="chips" options={ETHNICITIES} value={traits.ethnicity} onChange={(v) => set("ethnicity", v)} />

      <div className="field-pair">
        <RadioChoices legend="Кожа" variant="swatches" options={SKIN_TONES} value={traits.skinTone} onChange={(v) => set("skinTone", v)} />
        <RadioChoices legend="Цвет волос" variant="swatches" options={HAIR_COLORS} value={traits.hairColor} onChange={(v) => set("hairColor", v)} />
      </div>

      <div className="field">
        <span className="field-label" aria-hidden="true">
          Волосы
        </span>
        <div className="segment-pair">
          <RadioChoices legend="Длина волос" legendHidden variant="segments" options={HAIR_LENGTHS} value={traits.hairLength} onChange={(v) => set("hairLength", v)} />
          <RadioChoices legend="Текстура волос" legendHidden variant="segments" options={HAIR_TEXTURES} value={traits.hairTexture} onChange={(v) => set("hairTexture", v)} />
        </div>
      </div>

      <RadioChoices legend="Глаза" variant="chips" options={EYE_COLORS} value={traits.eyeColor} onChange={(v) => set("eyeColor", v)} />
      <RadioChoices legend="Телосложение" variant="segments" options={BUILDS} value={traits.build} onChange={(v) => set("build", v)} />
      <CheckChips legend="Приметы" options={MARKS} values={traits.marks} onChange={(v) => set("marks", v)} />

      <div className="field">
        <div className="field-row">
          <label className="field-label" htmlFor={vibeId}>
            Вайб
          </label>
          <span className={traits.vibe.length > VIBE_MAX ? "mono danger-text" : "mono faint"} aria-hidden="true">
            {traits.vibe.length}/{VIBE_MAX}
          </span>
        </div>
        <input
          id={vibeId}
          className="input"
          type="text"
          value={traits.vibe}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={invalid ? `${vibeErrorId} ${vibeHintId}` : vibeHintId}
          onChange={(e) => set("vibe", e.currentTarget.value)}
        />
        <p id={vibeHintId} className="field-hint">
          Характер и интересы — по-английски или по-русски. Возраст задаётся только ползунком.
        </p>
        {/* Always mounted and polite: announced once the typing settles, not as an alert per keystroke. */}
        <div id={vibeErrorId} className="vibe-errors" aria-live="polite">
          {invalid && (
            <ul className="field-errors">
              {vibeIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </fieldset>
  );
}
