import { type ReactNode, type RefObject, useId, useRef } from "react";
import { MAX_VIDEOS_PER_AVATAR, SceneCategory, type CategoryRef, type CategorySummary, type LaunchMix } from "../../../shared/engine";
import { Icon } from "../../ui/Icon";
import { CardAnglesLine } from "../photos/AnglesLines";
import { ownAnglesLine } from "../photos/categoryText";
import { CATEGORY_LABEL } from "../photos/runForm";
import { MIN_VIDEOS_PER_AVATAR, wantedShapes, type LaunchForm } from "./launchForm";
import { useOverflows } from "./layout";
import { MixControl } from "./MixControl";
import type { MusicLine } from "./planModel";

// S4.9a: column 2 of «Автопилот», «Настройки запуска» (AutopilotS4.dc.html): videos per avatar, the shape mix, the scene categories (built-in and the
// owner's own), «Ракурсы», the library and generation switches, «Сцены на проверку», «Музыка», «GIF-стикеры» and «Предел запуска». No «Текст на видео»
// (owner decision 8). While a launch runs these are its settings, read only, under a line that says so.

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
  readonly onPose: (pose: "profile" | "back") => void;
  readonly onSwitch: (which: "library" | "generate" | "sceneReview" | "stickers") => void;
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
    ...SceneCategory.options.map((ref) => ({ ref, label: CATEGORY_LABEL[ref] })),
    ...(customs ?? []).map((c) => ({ ref: c.categoryId, label: c.name })),
  ];
  const chosen = chips.filter((c) => form.categories.includes(c.ref)).length;
  const ownAngles = ownAnglesLine((customs ?? []).flatMap((c) => (form.categories.includes(c.categoryId) && c.pool.poses !== undefined ? [{ name: c.name, poses: c.pool.poses }] : [])));
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
                  return (
                    <button key={ref} type="button" className={on ? "chip chip-on" : "chip"} aria-pressed={on} aria-disabled={off} onClick={readOnly ? undefined : () => props.onCategory(ref)}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="ap-row ap-row-wrap ap-angles">
              <div className="rl">
                <b id={id("ang")}>Ракурсы</b>
                <span id={id("ang-hint")}>анфас и три четверти — всегда</span>
              </div>
              <div className="ap-chips" role="group" aria-labelledby={id("ang")} aria-describedby={ownAngles !== null ? `${id("ang-hint")} ${id("ang-own")}` : id("ang-hint")}>
                {(["profile", "back"] as const).map((pose) => {
                  const on = form.poses[pose];
                  return (
                    <button key={pose} type="button" className={on ? "chip chip-on" : "chip"} aria-pressed={on} aria-disabled={off} onClick={readOnly ? undefined : () => props.onPose(pose)}>
                      {pose === "profile" ? "Профиль" : "Со спины"}
                    </button>
                  );
                })}
              </div>
              <span className="faint ap-row-note">профиль и со спины — без проверки сходства</span>
              {ownAngles !== null && <CardAnglesLine line={ownAngles} describedId={id("ang-own")} />}
            </div>

            <SwitchRow
              id={id("lib")}
              title="Сначала свободные фото из библиотеки"
              sub="не отклонённые и не занятые черновиками"
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
              {/* The chip's window (own tracks «для автопилота», ApPlanMusic) belongs to S4.9c; until then the chip only says what the launch has. */}
              <span className="chip ap-chip-static" aria-describedby={id("mus-sub")}>
                <Icon name="music" size={13} />
                {music.chip}
              </span>
            </div>
            <SwitchRow id={id("gif")} title="GIF-стикеры" sub="встроенные · один на видео" on={form.stickers} disabled={readOnly} onToggle={() => props.onSwitch("stickers")} />
            <div className="ap-row">
              <div className="rl">
                <b>Предел запуска</b>
                <span>худшая цена: до 3 попыток на фото — дороже не выйдет</span>
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
