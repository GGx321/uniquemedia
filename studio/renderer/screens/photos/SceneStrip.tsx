import { Fragment, type ReactNode, type Ref, type RefObject, useId, useMemo, useState } from "react";
import type { AvatarSummary, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { SceneSetSliceView } from "../../engine/sceneSetSlice";
import { isActiveJob, type EngineView, type JobView } from "../../engine/store";
import { countOf } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { modelName, paidBlockedReason } from "./runForm";
import { about, ceiling, describedBy, paidButtonState, PriceChangedNotice, PriceFailed, setPriceKey, StackButton, useImagesPrice, Why } from "./scenePaid";
import { setAction, setCategoryTags, tallyScenes } from "./sceneReview";
import { approveReason, approveTitle, continueTitle, MODELS_LINE_TITLE, priceSourceText, SCENES_CHANGED_APPROVE, stepScenes } from "./sceneText";
import { SEEDREAM_FALLBACK_IMAGE_MODEL } from "./shared";
import { usePaidAction } from "./usePaidAction";

// CS.6: the generate card collapsed to a strip while a scene set is open (owner decision 3, 2026-10-05; the CS.0 artboards' compact card). Left: the set's
// own settings — its categories as tags (two lines at most, then «ещё N»), «Мои категории», the poses with «Пересоставить…», and the models the run will
// use (the current Settings). Middle: the price by steps. Right: the switch and the one button — «Составляем…» while a compose or «Дописать» writes,
// «Дописать N сцен» while scenes wait, else «Отрисовать M фото».

const SET_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Tags the strip shows before «ещё N»: about two lines at the window's width (the design's 7 at 1440, 5 at 1200). */
function tagsThatFit(): number {
  try {
    return window.matchMedia("(min-width: 1440px)").matches ? 7 : 5;
  } catch {
    return 7;
  }
}

export interface StepRow {
  readonly n: string;
  readonly state: "current" | "next" | "done";
  readonly label: string;
  readonly value: string;
}

/** One numbered step of the price column («1 Сцены ≈ $0.009»). */
export function Step({ row }: { row: StepRow }) {
  return (
    <div className={`mono photos-cost-row scene-step scene-step-${row.state}`}>
      <span className={`stepn stepn-${row.state}`} aria-hidden={row.state === "done" ? undefined : "true"}>
        {row.state === "done" ? <Icon name="check" size={10} strokeWidth={3.4} /> : row.n}
      </span>
      {row.state === "done" && <span className="sr-only">Сделано: </span>}
      <span data-label className="scene-step-label">
        {row.label}
      </span>
      <span className="nowrap">{row.value}</span>
    </div>
  );
}

/** «grok-imagine-image-2.0 · low · 9:16 · референс — мастер-портрет · текст grok-4.3», the segments never broken inside. */
export function modelSegments(view: EngineView, textModel: string): string[] {
  const s = view.settings;
  if (s === null) return [];
  const quality = s.imageQuality !== null && s.imageModel !== SEEDREAM_FALLBACK_IMAGE_MODEL ? [s.imageQuality] : [];
  return [modelName(s.imageModel), ...quality, "9:16", "референс — мастер-портрет", ...(s.cameraRealism ? ["реализм камеры"] : []), `текст ${modelName(textModel)}`];
}

interface SceneStripProps {
  avatar: AvatarSummary;
  view: EngineView;
  set: SceneSetView;
  sliceView: SceneSetSliceView;
  /** This avatar's scenes job, if one is queued or running. */
  scenesJob: JobView | null;
  runActive: boolean;
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  onToggleReview: () => void;
  /** Why the switch waits (a write of the set runs), or null. */
  switchWaits: string | null;
  onOpenSheet: () => void;
  myCategories: number | null;
  onRecompose: () => void;
  onStarted: (started: { runId: string; jobId: string }) => void;
  onFocusScene: (sceneId: number) => void;
  /** The card's button, for the focus to land on (after «Удалить набор», for one, or once a price asked again comes). */
  goRef: RefObject<HTMLButtonElement | null>;
  recomposeRef: Ref<HTMLButtonElement>;
  /** «Мои категории»: where the focus goes after the sheet or the create dialog closes while the set is open. */
  sheetRef: Ref<HTMLButtonElement>;
}

export function SceneStrip({
  avatar,
  view,
  set,
  sliceView,
  scenesJob,
  runActive,
  paidInFlight,
  onPaidInFlightChange,
  onToggleReview,
  switchWaits,
  onOpenSheet,
  myCategories,
  onRecompose,
  onStarted,
  onFocusScene,
  goRef,
  recomposeRef,
  sheetRef,
}: SceneStripProps) {
  const { client, store, sceneSets } = useEngine();
  const ids = useId();
  const [expanded, setExpanded] = useState(false);
  const [approveChanged, setApproveChanged] = useState(false);
  const action = setAction(set);
  const tally = tallyScenes(set.scenes);
  const key = setPriceKey(set, view);
  const live = set.write !== null;

  // «Отрисовать»: the images only, for exactly this revision and these Settings (re-asked on every scenes.changed: the revision moves).
  const approvable = action.kind === "approve" && action.block === null;
  const approve = usePaidAction({
    key: approvable ? `approve|${key}` : null,
    price: () => client.request("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision }),
    send: (acceptedWorstMicros) => client.request("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros }),
    onSent: (result) => {
      store.trackRunJob(result.jobId, result.runId, avatar.avatarId, action.kind === "approve" ? action.photos : tally.withText);
      // CS.7 M4: the strip gives way to the card, the button with the focus goes; the run's «Отменить» in the column takes it.
      sceneSets.requestCancelFocus(result.jobId);
      onStarted(result);
    },
    onRefused: (error) => {
      if (error.code === "SCENES_CHANGED") {
        setApproveChanged(true);
        sceneSets.reload(avatar.avatarId);
      }
    },
    onPaidInFlightChange,
  });

  // «Дописать»: the scenes still waiting, each request at the attempts it has left.
  const more = usePaidAction({
    key: action.kind === "continue" ? `more|${key}` : null,
    price: () => client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target: { kind: "unwritten" } }),
    send: (acceptedWorstMicros) => client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "unwritten" }, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      store.trackScenesJob(result.jobId, set.sceneSetId, avatar.avatarId, tally.pending);
      sceneSets.trackJob(result.jobId, { sceneSetId: set.sceneSetId, kind: "unwritten", price: accepted, sceneIds: null, idea: null });
      // The column shows the job's «Отменить» once the job is on screen: the focus goes there (README «Keyboard and focus»).
      sceneSets.requestCancelFocus(result.jobId);
    },
    onPaidInFlightChange,
  });

  // The images for the scenes the set would draw, when «Отрисовать» cannot be priced itself (a stop, a write, a scene with no text).
  const photos = action.kind === "approve" ? action.photos : tally.active;
  const images = useImagesPrice(avatar.avatarId, approvable ? 0 : photos, view);
  const imagesShown = approvable ? approve.estimate : images;

  const lockedByOther = paidInFlight && !approve.sending && !more.sending;
  const common =
    paidBlockedReason(view) ??
    (avatar.status !== "active" ? "Аватар в архиве — новые фото для него не создаются." : runActive ? "Дождитесь конца текущего запуска." : lockedByOther ? "Дождитесь окончания другого платного действия." : null);

  // ---------- the button ----------

  const why = `${ids}-why`;
  let button: { title: string; price: string | null; busy: boolean; clickable: boolean };
  let onClick: () => void = () => undefined;
  let reason: ReactNode = null;
  let confirm: { previous: number; estimate: NonNullable<typeof approve.estimate> } | null = null;
  if (action.kind === "writing") {
    const note = scenesJob === null ? undefined : sliceView.jobs.get(scenesJob.jobId);
    button = { title: action.write.kind === "unwritten" ? "Дописываем…" : "Составляем…", price: note?.price ? ceiling(note.price.worstMicros) : null, busy: true, clickable: false };
  } else if (action.kind === "continue") {
    // Between the write's answer and the set saying it writes, the tracked job holds the button as the write itself will.
    const blocked = common ?? (live || scenesJob !== null ? "Дождитесь, пока модель допишет сцену." : null);
    const state = paidButtonState(more, continueTitle(action.scenes), blocked !== null);
    button = state;
    onClick = more.click;
    reason = blocked;
    if (more.previousWorst !== null && more.estimate !== null) confirm = { previous: more.previousWorst, estimate: more.estimate };
  } else {
    const block = action.block;
    const firstPlaceholder = set.scenes.reduce((max, s) => Math.max(max, s.sceneId), 0) + 1;
    const blockReason = block === null ? null : approveReason(block, firstPlaceholder);
    const blocked = common !== null || block !== null;
    if (block !== null && block.kind === "empty") {
      button = { title: approveTitle(0), price: null, busy: false, clickable: false };
    } else if (block !== null) {
      button = { title: approveTitle(action.photos), price: images === null ? "до …" : ceiling(images.worstMicros), busy: false, clickable: false };
    } else {
      button = paidButtonState(approve, approveTitle(action.photos), blocked);
      if (approve.previousWorst !== null && approve.estimate !== null) confirm = { previous: approve.previousWorst, estimate: approve.estimate };
    }
    onClick = approve.click;
    reason =
      common ??
      (blockReason === null ? null : (
        <>
          {blockReason.pre}
          {blockReason.link !== null && (
            <button type="button" className="link-btn" onClick={() => onFocusScene(blockReason.link?.sceneId ?? 0)}>
              {blockReason.link.text}
            </button>
          )}
          {blockReason.post}
        </>
      ));
  }

  // ---------- the price column ----------

  const step1 = stepScenes(set);
  const steps: { n: string; state: "current" | "next" | "done"; label: string; value: string }[] = [];
  const photosLabel = countOf(photos, ["фото", "фото", "фото"]);
  let total: { label: string; value: string; sub: string | null };
  if (action.kind === "writing") {
    steps.push({ n: "1", state: "current", label: step1.label, value: step1.value }, { n: "2", state: "next", label: photosLabel, value: images === null ? "≈ …" : about(images.expectedMicros) });
    const note = scenesJob === null ? undefined : sliceView.jobs.get(scenesJob.jobId);
    // «Весь запуск» only while nothing is spent; once something was (step 1 shows it) the line is «Дальше».
    const label = step1.spent === null ? "Весь запуск" : "Дальше";
    total =
      images !== null && note?.price
        ? { label, value: about(images.expectedMicros + note.price.expectedMicros), sub: `${ceiling(images.worstMicros + note.price.worstMicros)} без правок` }
        : { label, value: images === null ? "—" : about(images.expectedMicros), sub: null };
  } else if (action.kind === "continue") {
    steps.push({ n: "1", state: "current", label: step1.label, value: step1.value }, { n: "2", state: "next", label: photosLabel, value: images === null ? "≈ …" : about(images.expectedMicros) });
    const write = more.estimate;
    total =
      images !== null && write !== null
        ? { label: "Дальше", value: about(images.expectedMicros + write.expectedMicros), sub: `${ceiling(images.worstMicros + write.worstMicros)} без правок` }
        : { label: "Дальше", value: "—", sub: null };
  } else {
    steps.push({ n: "1", state: "done", label: step1.label, value: step1.value }, { n: "2", state: "current", label: photosLabel, value: action.photos === 0 ? "—" : imagesShown === null ? "≈ …" : about(imagesShown.expectedMicros) });
    total = { label: "Ожидаемая", value: action.photos === 0 ? "—" : imagesShown === null ? "—" : about(imagesShown.expectedMicros), sub: null };
  }
  const source = imagesShown ?? more.estimate ?? images;

  // ---------- the left block ----------

  const tags = useMemo(() => setCategoryTags(set), [set]);
  const fit = tagsThatFit();
  const shownTags = expanded ? tags : tags.slice(0, fit);
  const hidden = tags.length - shownTags.length;
  const meta = setMetaText(set);
  const poses = ["анфас", "три четверти", ...(set.poses.profile ? ["профиль"] : []), ...(set.poses.back ? ["со спины"] : [])].join(", ");
  const models = modelSegments(view, set.textModel);
  const switchLabel = `${ids}-sw`;
  const reasonShown = reason !== null && !button.busy;
  // M2: the button's own free price could not be had («Дописать», or «Отрисовать» when it can be priced): why, and «Повторить».
  const priced = action.kind === "continue" ? more : approvable ? approve : null;
  const priceFailed = priced?.priceError ?? null;
  const priceFailedId = `${ids}-price`;

  return (
    <>
      <section className="card photos-gen scene-strip" aria-label="Генерация фото · набор сцен">
        <div className="scene-strip-main">
          <div className="scene-strip-head">
            <span className="lbl nowrap">Набор сцен</span>
            <span className="mono faint scene-strip-meta">
              {meta.count}
              {meta.detail !== null && <span className="scene-strip-meta-detail"> · {meta.detail}</span>}
            </span>
            <button ref={sheetRef} type="button" className="lbtn scene-strip-sheet" aria-haspopup="dialog" aria-label={`Мои категории · ${myCategories ?? 0}`} onClick={onOpenSheet}>
              <Icon name="list" size={13} strokeWidth={2.2} />
              Мои категории
              {myCategories !== null && <span className="mono lbtn-n">{myCategories}</span>}
            </button>
          </div>
          <div className="scene-strip-tags" role="list" aria-label="Категории набора">
            {tags.length === 0 && <span className="faint scene-strip-nocats">без категорий — только свои сцены</span>}
            {shownTags.map((tag) => (
              <span key={tag.ref} role="listitem" className="tag scene-strip-tag" title={tag.label}>
                <span className="scene-strip-tag-name">{tag.label}</span>
                <span className="mono scene-strip-tag-n">{tag.count}</span>
              </span>
            ))}
            {(hidden > 0 || expanded) && tags.length > fit && (
              <button type="button" className="tag tag-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
                {expanded ? "свернуть" : `ещё ${hidden}`}
                <span className={expanded ? "chip-more-icon chip-more-up" : "chip-more-icon"} aria-hidden="true">
                  <Icon name="chevronDown" size={11} strokeWidth={2.4} />
                </span>
              </button>
            )}
          </div>
          <div className="scene-strip-foot">
            <p className="scene-strip-lock">
              <Icon name="lock" size={12} strokeWidth={2.4} />
              <span>
                Ракурсы: {poses}. Настройки набора не меняются —{" "}
                <button
                  ref={recomposeRef}
                  type="button"
                  className="link-btn"
                  aria-haspopup="dialog"
                  aria-disabled={live}
                  title={live ? "Сначала дождитесь конца запроса к модели или отмените его" : "Удалить набор и начать заново — спросит перед удалением"}
                  onClick={() => {
                    if (!live) onRecompose();
                  }}
                >
                  Пересоставить…
                </button>{" "}
                начнёт заново.
              </span>
            </p>
            {models.length > 0 && (
              <p className="faint scene-strip-models" title={MODELS_LINE_TITLE}>
                {models.map((segment, i) => (
                  <span key={segment}>
                    <span className="nowrap">{segment}</span>
                    {i < models.length - 1 && " · "}
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>

        <div className="photos-gen-side scene-strip-prices">
          <div className="mono photos-cost-row">
            <span>Цены</span>
            <span className={source?.prices === "fallback" ? "warn-text" : "faint"}>{priceSourceText(source?.prices ?? null, source?.pricesAsOf ?? null)}</span>
          </div>
          {steps.map((row, i) => (
            <Fragment key={row.n}>
              <Step row={row} />
              {i === 0 && step1.spent !== null && <div className="mono faint scene-step-spent">{step1.spent}</div>}
            </Fragment>
          ))}
          <div className="mono photos-cost-row">
            <span>Проверка возраста</span>
            <span className={view.settings?.imageAgeCheck === "on" ? undefined : "faint"}>{view.settings?.imageAgeCheck === "on" ? "вкл." : "выкл."}</span>
          </div>
          <div className="mono photos-cost-row photos-cost-total">
            <span>{total.label}</span>
            <span aria-live="polite">{total.value}</span>
          </div>
          {total.sub !== null && <div className="mono faint scene-total-sub">{total.sub}</div>}
        </div>

        <div className="photos-gen-side scene-strip-go">
          <ReviewSwitch on onToggle={onToggleReview} labelId={switchLabel} waits={switchWaits} />
          <StackButton buttonRef={goRef} state={button} describedBy={describedBy(reasonShown && why, priceFailed !== null && priceFailedId)} onClick={onClick} />
          {reasonShown && <Why id={why}>{reason}</Why>}
          {priceFailed !== null && priced !== null && <PriceFailed id={priceFailedId} error={priceFailed} onRetry={priced.retryPrice} after={() => goRef.current} />}
        </div>
      </section>
      {confirm !== null && <PriceChangedNotice previousWorst={confirm.previous} estimate={confirm.estimate} />}
      {approveChanged && (
        <Notice
          tone="warn"
          title="Набор изменился"
          actions={
            <button type="button" className="btn btn-s" onClick={() => setApproveChanged(false)}>
              Понятно
            </button>
          }
        >
          {SCENES_CHANGED_APPROVE}
        </Notice>
      )}
      {approve.error !== null && approve.error.code !== "SCENES_CHANGED" && <ErrorNotice error={approve.error} />}
      {more.error !== null && <ErrorNotice error={more.error} />}
    </>
  );
}

/** «20 сцен · составлен 5 окт., 14:02», «20 сцен · составляются», «60 сцен · составлено 25», «пустой набор · свои сцены». */
export function setMetaText(set: SceneSetView): { count: string; detail: string | null } {
  const tally = tallyScenes(set.scenes);
  if (tally.total === 0 && set.write === null) return { count: "пустой набор", detail: "свои сцены" };
  const count = countOf(tally.total, ["сцена", "сцены", "сцен"]);
  if (set.write !== null && (set.write.kind === "compose" || set.write.kind === "unwritten")) return { count, detail: "составляются" };
  if (tally.pending > 0) return { count, detail: `составлено ${tally.withText}` };
  return { count, detail: `составлен ${SET_DATE.format(Date.parse(set.createdAt))}` };
}

/**
 * «Сцены на проверку»: a switch named by its visible label (README «Keyboard and focus»). `waits` (CS.7 M3) keeps it as it is, saying why under it: turned
 * off while a write of the set runs, it would hide the job and its «Отменить».
 */
export function ReviewSwitch({ on, onToggle, labelId, waits = null }: { on: boolean; onToggle: () => void; labelId: string; waits?: string | null }) {
  const whyId = `${labelId}-why`;
  return (
    <>
      <div className="scene-switch">
        <button
          type="button"
          className={on ? "sw sw-on" : "sw"}
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={waits !== null ? whyId : undefined}
          disabled={waits !== null}
          onClick={onToggle}
        />
        <span id={labelId}>Сцены на проверку</span>
      </div>
      {waits !== null && (
        <p id={whyId} className="field-hint scene-why scene-switch-why">
          {waits}
        </p>
      )}
    </>
  );
}

/** This avatar's scenes job while it is queued or running. */
export function liveScenesJob(jobs: readonly JobView[], avatarId: string): JobView | null {
  return jobs.filter((j) => j.kind === "scenes" && j.avatarId === avatarId && isActiveJob(j)).at(-1) ?? null;
}
