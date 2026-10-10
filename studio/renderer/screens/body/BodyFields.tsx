import { useId, type ReactNode } from "react";
import { BODY_MARKS_MAX, type AvatarBody } from "../../../shared/engine";
import {
  BODY_MARKS,
  BOTTOM_SHAPES,
  BOTTOM_SIZES,
  BUSTS,
  FIGURES,
  HEIGHTS,
  LEG_LENGTHS,
  LEG_SHAPES,
  type BodySource,
  type BuildValue,
  type MarkChoice,
  type ProposalSources,
} from "../../lib/body";
import { BUILDS, type Choice } from "../../lib/traits";
import { RadioChoices } from "../../ui/Choice";
import { Icon } from "../../ui/Icon";

// S5.2d: the «Тело» fields (.omc/stage5/design 01–03, 05–06, 08), shared by the wizard's «Тело» tab and «Изменить тело» on the avatar's «Внешность».
// Every new field is optional: «не задано» is a choice like the others, only quieter, so «unset» never reads as a pick, and the radios stay native
// (arrows, Tab, the legend as the group's name). «Фигура» is radio chips that wrap (six faces do not fit a 420 px form as one segment).
// «Телосложение» is the build the descriptor model writes: chosen here in the wizard, read-only on «Внешность» (D1, plan r2.1 · N4), where it is
// changed in «Описании».

/** «с фото» / «не видно на фото» / «угадано по лицу»: where an import's proposal took a value from. */
function SourceTag({ source }: { source: BodySource | "guess" | undefined }) {
  if (source === "photo") {
    return (
      <span className="tag src-photo">
        <Icon name="face" size={12} strokeWidth={2} />с фото
      </span>
    );
  }
  if (source === "guess") {
    return (
      <span className="tag src-guess">
        <Icon name="face" size={12} strokeWidth={2} />
        угадано по лицу
      </span>
    );
  }
  if (source === "none") return <span className="tag tag-o src-none">не видно на фото</span>;
  return null;
}

const SOURCE_WORDS: Record<BodySource, string> = { photo: "с фото", none: "не видно на фото" };

/** A visible legend, with a tag at its right end («с фото», «до двух») read after a comma. */
function Legend({ children, tag }: { children: ReactNode; tag?: ReactNode }) {
  return (
    <legend className="fl body-legend">
      <span>{children}</span>
      {tag !== undefined && (
        <>
          <span className="sr-only">, </span>
          {tag}
        </>
      )}
    </legend>
  );
}

/** «не задано» or one of `options`, on native radios: a `.seg` (or wrapping chips) whose first face is the quiet «не задано». */
function OptionalChoices<T extends string>({
  legend,
  srLegend,
  options,
  value,
  onChange,
  variant = "segments",
  tight = false,
  source,
}: {
  /** The visible legend. */
  legend?: ReactNode;
  /** Instead: a legend for screen readers only, for one half of a pair that shares a visible label (the source, if any, is read with it). */
  srLegend?: string;
  options: readonly Choice<T>[];
  value: T | undefined;
  onChange: (value: T | undefined) => void;
  variant?: "segments" | "chips";
  /** «Форма попы»: five faces, a little tighter, and they wrap in a narrow form. */
  tight?: boolean;
  source?: BodySource;
}) {
  const name = useId();
  const segments = variant === "segments";
  const face = (on: boolean, unset: boolean): string => {
    if (segments) return ["choice-face", unset ? "unset" : null, on ? "on" : null].filter(Boolean).join(" ");
    return ["chip", unset ? "unset" : null, on ? "chip-on" : null].filter(Boolean).join(" ");
  };
  return (
    <fieldset className="choice">
      {srLegend !== undefined ? (
        <legend className="sr-only">{source === undefined ? srLegend : `${srLegend}, ${SOURCE_WORDS[source]}`}</legend>
      ) : (
        <Legend tag={source === undefined ? undefined : <SourceTag source={source} />}>{legend}</Legend>
      )}
      <div className={segments ? (tight ? "choice-options seg seg-tight" : "choice-options seg") : "choice-options"}>
        <label className="choice-option">
          <input type="radio" className="choice-input" name={name} value="" checked={value === undefined} onChange={() => onChange(undefined)} />
          <span className={face(value === undefined, true)}>не задано</span>
        </label>
        {options.map((o) => (
          <label key={o.value} className="choice-option">
            <input type="radio" className="choice-input" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span className={face(o.value === value, false)}>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** «Тату и родинки на теле»: two rows of checkbox chips, at most two marks; the third waits (disabled) until one is taken off. */
function MarksField({ marks, onChange, source }: { marks: readonly MarkChoice["value"][]; onChange: (marks: MarkChoice["value"][]) => void; source?: BodySource }) {
  const full = marks.length >= BODY_MARKS_MAX;
  const count = marks.length === 0 ? "до двух" : `${marks.length} из ${BODY_MARKS_MAX}`;
  const row = (kind: MarkChoice["row"], caption: string) => (
    <div className="mark-row">
      <span className="mark-row-cap" aria-hidden="true">
        {caption}
      </span>
      {BODY_MARKS.filter((m) => m.row === kind).map((m) => {
        const on = marks.includes(m.value);
        const off = full && !on;
        return (
          <label key={m.value} className="choice-option">
            <input
              type="checkbox"
              className="choice-input"
              value={m.value}
              checked={on}
              disabled={off}
              onChange={() => onChange(on ? marks.filter((v) => v !== m.value) : [...marks, m.value])}
            />
            {/* The row's word first, for a screen reader: «Тату, щиколотка» holds the visible word (WCAG 2.5.3). */}
            <span className="sr-only">{caption}, </span>
            <span className={on ? "chip chip-on" : off ? "chip chip-off" : "chip"}>{m.place}</span>
          </label>
        );
      })}
    </div>
  );
  return (
    <fieldset className="choice">
      <Legend tag={source !== undefined ? <SourceTag source={source} /> : <span className="mono faint body-count">{count}</span>}>Тату и родинки на теле</Legend>
      <div className="mark-rows">
        {row("tattoo", "Тату")}
        {row("mole", "Родинка")}
      </div>
    </fieldset>
  );
}

/** A visible label shared by two groups («Ноги · длина и форма»): the groups carry their own names for a screen reader. */
function PairField({ label, sub, source, children }: { label: string; sub: string; source?: BodySource; children: ReactNode }) {
  return (
    <div className="field">
      <span className="fl body-legend" aria-hidden="true">
        <span>
          {label} <span className="body-sub">· {sub}</span>
        </span>
        <SourceTag source={source} />
      </span>
      <div className="segment-pair">{children}</div>
    </div>
  );
}

/** «Телосложение» as «Внешность» shows it (D1): the build word lives in the description's text and is changed there. */
function BuildReadOnly({ value, source }: { value: BuildValue | null; source?: "photo" | "guess" }) {
  const label = value === null ? null : (BUILDS.find((b) => b.value === value)?.label ?? null);
  return (
    <div className="field body-build">
      <span className="fl body-legend">
        <span>Телосложение</span>
        <SourceTag source={source} />
      </span>
      <p className="body-build-value">
        {label !== null ? <b>{label}</b> : null}
        <span className="faint">{label !== null ? "меняется в «Описании»" : "записано в «Описании» и меняется там"}</span>
      </p>
    </div>
  );
}

export type BuildField =
  | { readonly editable: true; readonly value: BuildValue; readonly onChange: (value: BuildValue) => void }
  | { readonly editable: false; readonly value: BuildValue | null };

export function BodyFields({
  body,
  onChange,
  build,
  layout,
  sources = null,
}: {
  body: AvatarBody;
  onChange: (body: AvatarBody) => void;
  build: BuildField;
  /** `column`: the wizard's 420 px form; `columns`: «Изменить тело» on «Внешность», short fields in two columns, «Ноги» and «Попа» full-width rows. */
  layout: "column" | "columns";
  /** An import's proposal: each field tagged «с фото» or «не видно на фото». */
  sources?: ProposalSources | null;
}) {
  const set = <K extends keyof AvatarBody>(key: K, value: AvatarBody[K]): void => onChange({ ...body, [key]: value });
  const tags = sources?.fields ?? {};

  const buildField = build.editable ? (
    <RadioChoices legend="Телосложение" variant="segments" options={BUILDS} value={build.value} onChange={build.onChange} />
  ) : (
    <BuildReadOnly value={build.value} source={sources?.build} />
  );
  const height = <OptionalChoices legend="Рост" options={HEIGHTS} value={body.height} onChange={(v) => set("height", v)} source={tags.height} />;
  const bust = <OptionalChoices legend="Грудь" options={BUSTS} value={body.bust} onChange={(v) => set("bust", v)} source={tags.bust} />;
  const figure = (
    <OptionalChoices
      legend={
        <>
          Фигура <span className="body-sub">· плечи, талия и бёдра</span>
        </>
      }
      variant="chips"
      options={FIGURES}
      value={body.figure}
      onChange={(v) => set("figure", v)}
      source={tags.figure}
    />
  );
  const legs = (
    <PairField label="Ноги" sub="длина и форма" source={tags.legs}>
      <OptionalChoices srLegend="Длина ног" options={LEG_LENGTHS} value={body.legLength} onChange={(v) => set("legLength", v)} source={tags.legs} />
      <OptionalChoices srLegend="Форма ног" options={LEG_SHAPES} value={body.legShape} onChange={(v) => set("legShape", v)} source={tags.legs} />
    </PairField>
  );
  const bottom = (
    <PairField label="Попа" sub="размер и форма" source={tags.bottom}>
      <OptionalChoices srLegend="Размер попы" options={BOTTOM_SIZES} value={body.bottomSize} onChange={(v) => set("bottomSize", v)} source={tags.bottom} />
      <OptionalChoices
        srLegend="Форма попы"
        options={BOTTOM_SHAPES}
        value={body.bottomShape}
        onChange={(v) => set("bottomShape", v)}
        tight
        source={tags.bottom}
      />
    </PairField>
  );
  const marks = <MarksField marks={body.bodyMarks ?? []} onChange={(v) => set("bodyMarks", v.length === 0 ? undefined : v)} source={tags.marks} />;

  if (layout === "columns") {
    return (
      <>
        <div className="body-grid">
          <div className="body-col">
            {buildField}
            {height}
            {bust}
          </div>
          <div className="body-col">
            {figure}
            {marks}
          </div>
        </div>
        <div className="body-rows">
          {legs}
          {bottom}
        </div>
      </>
    );
  }
  return (
    <div className="body-fields">
      {buildField}
      {height}
      {bust}
      {figure}
      {legs}
      {bottom}
      {marks}
    </div>
  );
}
