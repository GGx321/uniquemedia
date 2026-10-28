import { type ReactNode, type RefObject, useId, useRef } from "react";
import {
  BOLD_CATEGORIES,
  isBoldCategory,
  MAX_VIDEOS_PER_AVATAR,
  ORDINARY_SCENE_CATEGORIES,
  type CategoryRef,
  type CategorySummary,
  type LaunchMix,
  type LegsShare,
  type SceneLevel,
} from "../../../shared/engine";
import { Icon } from "../../ui/Icon";
import { OwnAnglesNote } from "../photos/AnglesLines";
import { ownAnglesAt } from "../photos/categoryText";
import { LEGS_ROW_HINT, type LegsRow } from "../photos/legs";
import { LegsChips } from "../photos/LegsChips";
import { ANGLE_FROM_SCENE_SHORT, gatedNote, LEVEL_OPTIONS } from "../photos/level";
import { categoriesAt, CATEGORY_LABEL } from "../photos/runForm";
import { MIN_VIDEOS_PER_AVATAR, wantedShapes, type LaunchForm } from "./launchForm";
import { useOverflows } from "./layout";
import { MixControl } from "./MixControl";
import type { MusicLine } from "./planModel";

// S4.9a: column 2 of «Автопилот», «Настройки запуска» (AutopilotS4.dc.html): videos per avatar, the shape mix, the scene categories (built-in and the
// owner's own), «Подача» (S5.7c, mockup 30: it replaced «Ракурсы» — the angle comes from the scene), «Ножки» (S5.8b, mockup 34), the library and
// generation switches, «Сцены на проверку», «Музыка», «GIF-стикеры» and «Предел запуска». No «Текст на видео» (owner decision 8). While a launch runs
// these are its settings, read only, under a line that says so. S5.9g (plan s5a3 §13.1; mockup 52): «Смелая» is live, and «Ночнушки и бельё» and «Пляж и
// бассейн» follow the five with the card's gating. 5a.4 (S5.BA8): every category draws «Смелая», so «Предел запуска» says option B at any «Смелая» launch, and the library's switch
// says it takes only «Смелая» frames there.

/** «Предел запуска»'s sub-line, and its longer form while every new photo of the launch is priced at the Seedream 2K unit (plan §10.2, option B; mockup 52). */
const LIMIT_SUB = "худшая цена: до 3 попыток на фото — дороже не выйдет";
const LIMIT_SUB_BOLD = `${LIMIT_SUB}; со «Смелой» каждое новое фото считается по цене Seedream 2K`;

/** «Сначала свободные фото из библиотеки»'s sub-line, and its longer form at «Смелая», where the library offers only the «Смелая» frames (5a.4, §5.9 row 22, r2.2 D2). */
const LIBRARY_SUB = "не отклонённые и не занятые черновиками";
const LIBRARY_SUB_BOLD = `${LIBRARY_SUB}; на «Смелой» — только кадры «Смелой»`;

export interface SettingsColumnProps {
  readonly form: LaunchForm;
  /** A launch is unfinished: these are its settings. */
  readonly launchSettings: boolean;
  /** Nothing can be changed (a launch's settings, or the form while «Запустить» is on its way). */
  readonly readOnly: boolean;
  readonly customs: readonly CategorySummary[] | null;
  readonly prices: { readonly single: string; readonly collage: string; readonly slides: string } | null;
  readonly music: MusicLine;
  readonly limit: string;
  readonly wide: boolean;
  readonly firstHandleRef: RefObject<HTMLButtonElement | null>;
  readonly onVideos: (delta: number) => void;
  readonly onMix: (mix: LaunchMix) => void;
  readonly onMixReset: () => void;
  readonly onCategory: (ref: CategoryRef) => void;
  readonly onLevel: (level: SceneLevel) => void;
  /** «Кокетливая»'s count of flirty new frames (mockup 30), «Смелая»'s of bold and flirty ones (mockup 52), or null while «Обычная» is on. */
  readonly levelCaption: string | null;
  /** §5.9 row 19b: the line of its own for the chosen avatars made from a photo, or null. */
  readonly importedLine: string | null;
  /** §5.9 row 20: the month line at «Смелая», from the plan's own photo unit and the month's budget, or null. */
  readonly monthLine: string | null;
  /** S5.8b: the «Ножки» row as the form and the plan make it (mockups 34, 34#few). */
  readonly legs: LegsRow;
  readonly onLegs: (legs: LegsShare) => void;
  readonly onSwitch: (which: "library" | "generate" | "sceneReview" | "stickers") => void;
  /** S4.9c: the music chip's window is open, and the chip that opens and closes it. */
  readonly musicOpen: boolean;
  readonly musicChipRef: RefObject<HTMLButtonElement | null>;
  readonly onMusic: () => void;
}

export function SettingsColumn(props: SettingsColumnProps) {
  const { form, launchSettings: isLaunch, readOnly, customs, prices, music, limit, wide, firstHandleRef } = props;
  const ids = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const over = useOverflows(scroller, content);
  const id = (name: string): string => `${ids}-${name}`;

  const shapes = wantedShapes(form.videosPerAvatar, form.mix);
  const mixNote = `На аватар ${shapes.single} · ${shapes.collage} · ${shapes.slides} · ${wide ? "цена — за видео из новых фото" : "цена — если фото новые"}`;
  const chips: { ref: CategoryRef; label: string }[] = [
    ...ORDINARY_SCENE_CATEGORIES.map((ref) => ({ ref, label: CATEGORY_LABEL[ref] })),
    ...BOLD_CATEGORIES.map((ref) => ({ ref, label: CATEGORY_LABEL[ref] })),
    ...(customs ?? []).map((c) => ({ ref: c.categoryId, label: c.name })),
  ];
  // S5.9g (mockup 52): under another «Подача» the «Смелая» two wait, a pick of theirs kept (drawn dashed) and left out of the launch and of the count.
  const boldOn = form.level === "bold";
  const asked = categoriesAt(form.level, form.categories);
  const chosen = chips.filter((c) => asked.includes(c.ref)).length;
  const kept = BOLD_CATEGORIES.filter((ref) => !boldOn && form.categories.includes(ref)).map((ref) => CATEGORY_LABEL[ref]);
  // 5a.4 (r2.2 I5.77, §5.9 row 21): every photo of any «Смелая» launch is priced at the Seedream 2K unit, whatever the categories.
  const optionB = boldOn;
  // r2.3 M6: none at «Смелая», where the run's toggles decide a custom category's angles.
  const ownAngles = ownAnglesAt(form.level, customs, form.categories);
  const off = readOnly || undefined;
  const reviewOff = readOnly || !form.generate || undefined;

  return (
    <section className="card ap-col ap-settings" aria-labelledby={id("title")}>
      <h2 id={id("title")} className="ap-h2">
        Настройки запуска
      </h2>
      {isLaunch && (
        <p className="ap-lock-note">
          <Icon name="lock" size={12} strokeWidth={2.4} />
          <span>Это настройки идущего запуска — изменить их можно в следующем. Новый запуск — после «Стоп» или конца этого.</span>
        </p>
      )}
      <div className="ap-fw">
        <div ref={scroller} className={isLaunch ? "ap-sc ap-lockd" : "ap-sc"}>
          <div ref={content} className="ap-sc-in">
            <div className="ap-row">
              <div className="rl">
                <b id={id("per")}>Видео на аватар</b>
                <span>каждое — до 10 с, без текста</span>
              </div>
              <div className="ap-stepper" role="group" aria-labelledby={id("per")}>
                <button
                  type="button"
                  className="ibtn"
                  aria-label="Меньше видео"
                  aria-disabled={readOnly || form.videosPerAvatar <= MIN_VIDEOS_PER_AVATAR || undefined}
                  onClick={readOnly || form.videosPerAvatar <= MIN_VIDEOS_PER_AVATAR ? undefined : () => props.onVideos(-1)}
                >
                  <Icon name="minus" size={12} strokeWidth={2.6} />
                </button>
                <output className="mono ap-stepper-value" aria-live="polite" aria-labelledby={id("per")}>
                  {form.videosPerAvatar}
                </output>
                <button
                  type="button"
                  className="ibtn"
                  aria-label="Больше видео"
                  aria-disabled={readOnly || form.videosPerAvatar >= MAX_VIDEOS_PER_AVATAR || undefined}
                  onClick={readOnly || form.videosPerAvatar >= MAX_VIDEOS_PER_AVATAR ? undefined : () => props.onVideos(1)}
                >
                  <Icon name="plus" size={12} strokeWidth={2.6} />
                </button>
              </div>
            </div>

            <MixControl
              mix={form.mix}
              readOnly={readOnly}
              onChange={props.onMix}
              onReset={props.onMixReset}
              prices={prices}
              note={mixNote}
              labelId={id("mix")}
              noteId={id("mix-note")}
              firstHandleRef={firstHandleRef}
            />

            <div className="ap-block">
              <div className="ap-block-head">
                <b id={id("cats")} className="ap-block-title">
                  Категории сцен
                </b>
                <span className="mono faint ap-block-count">
                  {chosen} из {chips.length}
                </span>
              </div>
              <div className="ap-chips" role="group" aria-labelledby={id("cats")}>
                {chips.map(({ ref, label }) => {
                  const on = form.categories.includes(ref);
                  const gated = !boldOn && isBoldCategory(ref);
                  const classes = ["chip", on && "chip-on", gated && "gen-chip-gated", gated && on && "gen-chip-kept"].filter(Boolean).join(" ");
                  return (
                    <button
                      key={ref}
                      type="button"
                      className={classes}
                      aria-pressed={on && !gated}
                      aria-disabled={off ?? (gated || undefined)}
                      aria-describedby={gated ? id("gated") : undefined}
                      onClick={readOnly || gated ? undefined : () => props.onCategory(ref)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {!boldOn && (
                <span id={id("gated")} className="faint ap-note gen-gated-note">
                  {gatedNote(kept)}
                </span>
              )}
            </div>

            {/* S5.7c (mockup 30): «Подача» where «Ракурсы» was; read only, a launch's own stays checked whatever is clicked. */}
            <div className="ap-row ap-row-wrap ap-level">
              <div className="rl">
                <b id={id("lvl")}>Подача</b>
                <span id={id("lvl-hint")}>{ANGLE_FROM_SCENE_SHORT}</span>
              </div>
              <div
                className="seg choice-options gen-seg"
                role="radiogroup"
                aria-labelledby={id("lvl")}
                aria-describedby={[id("lvl-hint"), props.levelCaption !== null && id("lvl-cap"), props.importedLine !== null && id("lvl-imported"), props.monthLine !== null && id("lvl-month")].filter(Boolean).join(" ")}
              >
                {LEVEL_OPTIONS.map((option) => {
                  const on = form.level === option.value;
                  return (
                    <label key={option.value} className="choice-option">
                      <input
                        type="radio"
                        className="choice-input"
                        name={id("lvl-radio")}
                        value={option.value}
                        checked={on}
                        aria-disabled={off}
                        onChange={() => {
                          if (!readOnly) props.onLevel(option.value);
                        }}
                      />
                      <span className={on ? "choice-face on" : "choice-face"}>{option.label}</span>
                    </label>
                  );
                })}
              </div>
              {props.levelCaption !== null && (
                <span id={id("lvl-cap")} className="ap-row-note gen-cap">
                  {props.levelCaption}
                </span>
              )}
              {props.importedLine !== null && (
                <span id={id("lvl-imported")} className="ap-row-note gen-cap">
                  {props.importedLine}
                </span>
              )}
              {props.monthLine !== null && (
                <span id={id("lvl-month")} className="ap-row-note gen-cap">
                  {props.monthLine}
                </span>
              )}
              {ownAngles !== null && <OwnAnglesNote line={ownAngles} className="ap-row-note" />}
            </div>

            {/* S5.8b (mockups 34, 34#few): «Ножки» under «Подача»; read only, a launch's own stays checked whatever is clicked. */}
            <div className="ap-row ap-row-wrap ap-legs">
              <div className="rl">
                <b id={id("legs")}>Ножки</b>
                <span>{LEGS_ROW_HINT}</span>
              </div>
              <LegsChips
                name={id("legs-radio")}
                labelledBy={id("legs")}
                describedBy={props.legs.caption !== null ? id("legs-cap") : undefined}
                shown={props.legs.shown}
                off={props.legs.off}
                readOnly={readOnly}
                onPick={props.onLegs}
              />
              {props.legs.caption !== null && (
                <span id={id("legs-cap")} className={props.legs.caption.why ? "ap-row-note gen-cap gen-cap-why" : "ap-row-note gen-cap"}>
                  {props.legs.caption.text}
                </span>
              )}
            </div>

            <SwitchRow
              id={id("lib")}
              title="Сначала свободные фото из библиотеки"
              sub={boldOn ? LIBRARY_SUB_BOLD : LIBRARY_SUB}
              on={form.library}
              disabled={readOnly}
              onToggle={() => props.onSwitch("library")}
            />
            <SwitchRow
              id={id("gen")}
              title="Догенерировать недостающие"
              sub={form.generate ? "сначала сцены, потом фото — партиями до 25" : "выключено — только то, что есть в библиотеке"}
              on={form.generate}
              disabled={readOnly}
              onToggle={() => props.onSwitch("generate")}
            />
            <SwitchRow
              id={id("rev")}
              title="Сцены на проверку"
              sub={!form.generate ? "нужна только для новых фото" : form.sceneReview ? "как на «Фото»: вы проверяете сцены, потом рисуем" : "сцены пишутся и рисуются без остановки"}
              on={form.sceneReview}
              disabled={reviewOff === true}
              dim={!form.generate}
              onToggle={() => props.onSwitch("sceneReview")}
            />
            <div className="ap-row ap-row-wrap">
              <div className="rl ap-music-label">
                <b id={id("mus")}>Музыка</b>
                <span id={id("mus-sub")} className={music.warn ? "warn-text" : undefined}>
                  {music.sub}
                </span>
              </div>
              {/* S4.9c: the chip opens «Музыка для автопилота» (ApPlanMusic): the own tracks' «для автопилота» is the library's, not the launch's, so it opens
                  while a launch runs too (its videos waiting for music go on as soon as a track is marked). */}
              <button
                ref={props.musicChipRef}
                type="button"
                className={props.musicOpen ? "chip chip-on ap-music-chip" : "chip ap-music-chip"}
                aria-haspopup="dialog"
                aria-expanded={props.musicOpen}
                aria-describedby={id("mus-sub")}
                onClick={props.onMusic}
              >
                <Icon name="music" size={13} />
                {music.chip}
              </button>
            </div>
            <SwitchRow id={id("gif")} title="GIF-стикеры" sub="встроенные · один на видео" on={form.stickers} disabled={readOnly} onToggle={() => props.onSwitch("stickers")} />
            <div className="ap-row">
              <div className="rl">
                <b>Предел запуска</b>
                <span>{optionB ? LIMIT_SUB_BOLD : LIMIT_SUB}</span>
              </div>
              <span className="mono ap-limit">{limit}</span>
            </div>
            <div className="ap-sc-end" />
          </div>
        </div>
        {over && <div className="ap-fd" aria-hidden="true" />}
      </div>
    </section>
  );
}

function SwitchRow({ id, title, sub, on, disabled, dim, onToggle }: { id: string; title: string; sub: ReactNode; on: boolean; disabled: boolean; dim?: boolean; onToggle: () => void }) {
  return (
    <div className="ap-row">
      <div className="rl">
        <b id={id}>{title}</b>
        <span id={`${id}-sub`}>{sub}</span>
      </div>
      <button
        type="button"
        className={["sw", on && "sw-on", dim && "sw-dim"].filter(Boolean).join(" ")}
        role="switch"
        aria-checked={on}
        aria-labelledby={id}
        aria-describedby={`${id}-sub`}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onToggle}
      />
    </div>
  );
}
