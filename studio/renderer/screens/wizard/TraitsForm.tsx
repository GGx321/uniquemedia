import { useId } from "react";
import { bodyOfTraits, withBody } from "../../lib/body";
import { yearsOld } from "../../lib/format";
import {
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
import { BodyFields } from "../body/BodyFields";
import type { TraitsTab, TraitsTabIds } from "./TraitsTabs";

interface TraitsFormProps {
  traits: Traits;
  onChange: (traits: Traits) => void;
  vibeIssues: readonly string[];
  /** Read-only: a draft exists (its descriptor is written) or the paid commands are on their way. */
  locked: boolean;
  /** S5.2d: the tab on show, «Лицо и волосы» or «Тело»; the other panel stays mounted, hidden. */
  tab: TraitsTab;
  tabIds: TraitsTabIds;
}

/**
 * Step 1: the avatar's look, from the fixed choices of the contract; a `fieldset.lock` once a draft fixes it. Two panels (S5.2d): the face and hair,
 * and the body — «Телосложение» (still the descriptor model's build word, chosen here before the draft) and the optional body traits.
 */
export function TraitsForm({ traits, onChange, vibeIssues, locked, tab, tabIds }: TraitsFormProps) {
  const ageId = useId();
  const vibeId = useId();
  const vibeHintId = useId();
  const vibeErrorId = useId();
  const set = <K extends keyof Traits>(key: K, value: Traits[K]): void => onChange({ ...traits, [key]: value });
  const invalid = vibeIssues.length > 0;

  return (
    <fieldset className="lock" disabled={locked}>
      <legend className="sr-only">{locked ? "Внешность зафиксирована в черновике" : "Внешность"}</legend>

      <div role="tabpanel" id={tabIds.facePanel} aria-labelledby={tabIds.face} className="traits-panel" hidden={tab !== "face"}>
        <div className="field">
          <div className="field-row">
            <label className="fl" htmlFor={ageId}>
              Возраст
            </label>
            <span className="mono muted" aria-hidden="true">
              {yearsOld(traits.age)} · от {MIN_AGE}
            </span>
          </div>
          <input
            id={ageId}
            type="range"
            min={MIN_AGE}
            max={MAX_AGE}
            step={1}
            value={traits.age}
            // The thumb's position, 0–1: ui.css fills the track up to it (the slider is drawn by hand).
            style={{ "--range-fill": (traits.age - MIN_AGE) / (MAX_AGE - MIN_AGE) }}
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
          <span className="fl" aria-hidden="true">
            Волосы
          </span>
          <div className="segment-pair">
            <RadioChoices legend="Длина волос" legendHidden variant="segments" options={HAIR_LENGTHS} value={traits.hairLength} onChange={(v) => set("hairLength", v)} />
            <RadioChoices legend="Текстура волос" legendHidden variant="segments" options={HAIR_TEXTURES} value={traits.hairTexture} onChange={(v) => set("hairTexture", v)} />
          </div>
        </div>

        <RadioChoices legend="Глаза" variant="chips" options={EYE_COLORS} value={traits.eyeColor} onChange={(v) => set("eyeColor", v)} />
        <CheckChips legend="Приметы" options={MARKS} values={traits.marks} onChange={(v) => set("marks", v)} />

        <div className="field">
          <div className="field-row">
            <label className="fl" htmlFor={vibeId}>
              Вайб
            </label>
            {!locked && (
              <span className={traits.vibe.length > VIBE_MAX ? "mono danger-text" : "mono faint"} aria-hidden="true">
                {traits.vibe.length}/{VIBE_MAX}
              </span>
            )}
          </div>
          <input
            id={vibeId}
            className="in"
            type="text"
            value={traits.vibe}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby={locked ? undefined : invalid ? `${vibeErrorId} ${vibeHintId}` : vibeHintId}
            onChange={(e) => set("vibe", e.currentTarget.value)}
          />
          {/* How to fill it in, while it can be filled in: a locked look has nothing left to type. */}
          {!locked && (
            <p id={vibeHintId} className="field-hint">
              Характер и интересы — по-английски или по-русски. Возраст задаётся только ползунком.
            </p>
          )}
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
      </div>

      <div role="tabpanel" id={tabIds.bodyPanel} aria-labelledby={tabIds.body} className="traits-panel" hidden={tab !== "body"}>
        <BodyFields
          body={bodyOfTraits(traits)}
          onChange={(body) => onChange(withBody(traits, body))}
          build={{ editable: true, value: traits.build, onChange: (v) => set("build", v) }}
          layout="column"
        />
      </div>
    </fieldset>
  );
}
