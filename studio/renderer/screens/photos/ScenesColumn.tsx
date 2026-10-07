import { useEffect, useId, useRef, useState } from "react";
import type { AvatarSummary, EngineError, Estimate, RunSummary, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { SceneSetSliceView } from "../../engine/sceneSetSlice";
import { isActiveJob, type EngineView, type JobView } from "../../engine/store";
import { countOf } from "../../lib/format";
import { formatUsd } from "../../lib/money";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { modelName } from "./runForm";
import { EMPTY_IDEA, type IdeaStart } from "./SceneIdeaForm";
import { about } from "./scenePaid";
import { focusSceneCard, SceneSetPanel } from "./SceneSetPanel";
import { headerCounts, OFF_NOTE, offNoteSet, runDoneText } from "./sceneText";
import { PHOTO_FORMS, useMounted } from "./shared";

const RUN_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

type ResumeBusy = "estimate" | "resume" | null;

/**
 * A stopped run that `runs.list` says can be continued. Its price is asked
 * for as soon as the row shows (`runs.estimateResume`, free), so the one
 * «Продолжить» button carries its worst case, and a click sends exactly
 * that as `runs.resume`'s `acceptedWorstMicros` — the same rules as the
 * generation card: busy through a PRICE_CHANGED re-price, the refused price
 * dropped when the re-price fails, never two sends.
 */
interface ResumeRowProps {
  run: RunSummary;
  blockedReason: string | null;
  /** `view.money?.reconcileNeeded` (MEDIUM-1): a resume's price this row already has can go stale the moment this flips — either way, not just cleared — since it changes what the cap has left. */
  reconcileNeeded: boolean;
  /** A paid runs.start or runs.resume is in flight for this avatar, from this row or the generate card or another row (L5). */
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  onResumed: (resumed: { runId: string; jobId: string }) => void;
}

function ResumeRow({ run, blockedReason, reconcileNeeded, paidInFlight, onPaidInFlightChange, onResumed }: ResumeRowProps) {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const sending = useRef(false);
  // N2: bumped at the start of every runs.estimateResume this row sends
  // (askPrice's own and resume's PRICE_CHANGED re-ask), so a reply this row
  // no longer cares about — issued before a newer one, but landing after it,
  // the mock resolves handle-time state on its own delayed clock — cannot
  // overwrite what the newer reply already set.
  const askSeq = useRef(0);
  // N3: a reconcileNeeded flip while this row's own resume is in flight must
  // not re-ask mid-send — askPrice's setBusy("estimate") would clobber the
  // "Продолжаем…" state resume is showing. Deferred here and drained once
  // resume's own finally is done.
  const pendingReask = useRef(false);
  const titleId = useId();
  const hintId = useId();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  // Busy from the very first frame: the price is on its way before the button can ever be clicked.
  const [busy, setBusy] = useState<ResumeBusy>("estimate");
  const [error, setError] = useState<EngineError | null>(null);

  async function askPrice(): Promise<void> {
    const seq = ++askSeq.current;
    setBusy("estimate");
    setError(null);
    const reply = await client.request("runs.estimateResume", { runId: run.runId });
    if (!mounted.current || seq !== askSeq.current) return;
    setBusy(null);
    if (reply.ok) {
      setEstimate(reply.result.estimate);
      setPreviousWorst(null);
    } else setError(reply.error);
  }

  // Once per run (a retry is the button's own) and again whenever
  // reconcileNeeded flips (MEDIUM-1): a reconcile changes what the run's cap
  // has left, so a price this row already has — shown even while blocked,
  // runs.estimateResume being free — must not go stale once the block lifts.
  // N3: while this row's own resume is sending, the re-ask is deferred
  // instead of firing mid-send (resume's finally drains it).
  useEffect(() => {
    if (sending.current) {
      pendingReask.current = true;
      return;
    }
    void askPrice();
  }, [run.runId, reconcileNeeded]);

  async function resume(accepted: Estimate): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy("resume");
    onPaidInFlightChange(true);
    setError(null);
    try {
      const reply = await client.request("runs.resume", { runId: run.runId, acceptedWorstMicros: accepted.worstMicros });
      // The run is under way whether or not this row is still shown: the (window-wide) store learns of it either way.
      if (reply.ok) store.trackRunJob(reply.result.jobId, reply.result.runId, run.avatarId, run.total, run.done + run.failed);
      if (!mounted.current) return;
      if (reply.ok) {
        onResumed(reply.result);
        return;
      }
      if (reply.error.code !== "PRICE_CHANGED") {
        setError(reply.error);
        return;
      }
      const seq = ++askSeq.current;
      const fresh = await client.request("runs.estimateResume", { runId: run.runId });
      if (!mounted.current || seq !== askSeq.current) return;
      if (fresh.ok) {
        setEstimate(fresh.result.estimate);
        setPreviousWorst(accepted.worstMicros);
        return;
      }
      setEstimate(null);
      setPreviousWorst(null);
      setError(fresh.error);
    } finally {
      sending.current = false;
      onPaidInFlightChange(false);
      if (mounted.current) setBusy(null);
      // N3: a reconcileNeeded flip landed while this send was in flight — ask again now, not mid-send.
      if (pendingReask.current) {
        pendingReask.current = false;
        void askPrice();
      }
    }
  }

  // Another paid command (the generate card's or another row's) is in flight for this avatar (L5): this row locks too, though it is not the one sending.
  const lockedByOther = paidInFlight && busy === null;
  const effectiveBlockedReason = blockedReason ?? (lockedByOther ? "Дождитесь окончания другого платного действия." : null);
  const title =
    busy === "estimate"
      ? "Считаем…"
      : busy === "resume"
        ? "Продолжаем…"
        : previousWorst !== null
            ? "Подтвердить новую цену"
            : estimate
              ? "Продолжить"
              : "Узнать цену";
  const paidClick = estimate !== null && effectiveBlockedReason === null;
  const clickable = busy === null && (estimate === null || paidClick);
  // B2: whether the row offers (or would offer, once priced) a paid resume,
  // so its own second line's height never jumps between "no price yet" and
  // "a price is in" — including the very first frame, always busy="estimate"
  // before its own mount-time price ever lands. Not "Узнать цену" (a free
  // re-ask, reached only after a failed estimate, with nothing in flight and
  // no price known).
  const offersPaidStart = busy !== null || estimate !== null;
  const failed = run.failed > 0 ? ` · не получилось ${run.failed}` : "";
  const dateId = useId();

  return (
    <article className="photos-scene photos-run" aria-labelledby={`${titleId} ${dateId}`}>
      <div className="photos-run-top">
        <div className="photos-scene-main">
          <div className="photos-scene-tags">
            <span id={titleId} className="tag">
              Остановлен
            </span>
            <span id={dateId} className="tag tag-o">
              {RUN_DATE.format(Date.parse(run.createdAt))}
            </span>
          </div>
          <p className="photos-scene-text">
            Готово {run.done} из {run.total} · осталось {run.open}
            {failed}
            {estimate && <span className="mono"> · ≈ {formatUsd(estimate.expectedMicros)}</span>}
          </p>
        </div>
        <button
          type="button"
          className={previousWorst !== null ? "btn btn-p btn-stack photos-run-go" : "btn btn-stack photos-run-go"}
          disabled={!clickable}
          aria-busy={busy !== null}
          aria-describedby={effectiveBlockedReason && estimate ? hintId : undefined}
          onClick={() => void (estimate ? resume(estimate) : askPrice())}
        >
          <span className="btn-stack-line">
            {busy !== null && <Spin />}
            {title}
          </span>
          {offersPaidStart && (
            <>
              <span className="sr-only"> · </span>
              <span className="mono">{estimate && busy !== "estimate" ? `до ${formatUsd(estimate.worstMicros, 2, "up")}` : "до …"}</span>
            </>
          )}
        </button>
      </div>
      {effectiveBlockedReason && estimate && (
        <p id={hintId} className="field-hint">
          {effectiveBlockedReason}
        </p>
      )}
      {previousWorst !== null && estimate && (
        // Same rule as the generate card's (L4): title on the fresh price actually shown, not on why it was refused.
        <Notice tone="warn" title={estimate.worstMicros > previousWorst ? "Цена выросла" : "Цена изменилась"}>
          Было не больше <span className="mono">{formatUsd(previousWorst, 2, "up")}</span>, теперь не больше{" "}
          <span className="mono">{formatUsd(estimate.worstMicros, 2, "up")}</span>. Подтвердите снова — без подтверждения ничего не отправляется.
        </Notice>
      )}
      {error && <ErrorNotice error={error} />}
    </article>
  );
}

/**
 * A run whose cap cannot fund one more attempt has reached its end (`runs.list`'s
 * `capExhausted`): a plain summary of what it made, with nothing to click or
 * price. Its photos are in the gallery; what is missing needs a new run.
 */
function EndedRunRow({ run }: { run: RunSummary }) {
  const titleId = useId();
  const dateId = useId();
  const failed = run.failed > 0 ? ` · не получилось ${run.failed}` : "";
  return (
    <article className="photos-scene photos-run" aria-labelledby={`${titleId} ${dateId}`}>
      <div className="photos-scene-main">
        <div className="photos-scene-tags">
          <span id={titleId} className="tag">
            Лимит исчерпан
          </span>
          <span id={dateId} className="tag tag-o">
            {RUN_DATE.format(Date.parse(run.createdAt))}
          </span>
        </div>
        <p className="photos-scene-text">
          Готово {run.done} из {run.total} · не дорисовано {run.open}
          {failed}
        </p>
        <p className="field-hint">Лимит расходов этого запуска исчерпан, продолжить его нельзя. Недостающие фото — новым запуском.</p>
      </div>
    </article>
  );
}


/** How the run this screen watched ended: the gallery shows its photos, this says what else happened. A run made from a set says so (ReviewStates F). */
function RunOutcome({ job, fromSet }: { job: JobView; fromSet: boolean }) {
  if (job.status === "failed" && job.error) return <ErrorNotice error={job.error} />;
  if (job.status === "cancelled") {
    return (
      <Notice tone="info" title="Генерация остановлена">
        Прерванные запросы считаются по худшей цене, пока расходы не сверены. Недорисованное можно продолжить.
      </Notice>
    );
  }
  if (job.status === "done" && job.result?.kind === "run") {
    const { photoIds, failedSlots } = job.result;
    return (
      <Notice tone={failedSlots > 0 ? "warn" : "ok"} title="Запуск завершён">
        {fromSet ? runDoneText(photoIds.length) : `В галерее ${countOf(photoIds.length, PHOTO_FORMS)} этого запуска.`}
        {failedSlots > 0 && ` Не получилось: ${failedSlots} — стоимость попыток учтена.`}
      </Notice>
    );
  }
  return null;
}

interface ScenesColumnProps {
  avatar: AvatarSummary;
  view: EngineView;
  count: number;
  /** This avatar's latest run job, if the window knows one. */
  runJob: JobView | null;
  /** Its run (from the job's own events or the start reply); cancel needs it. */
  activeRunId: string | null;
  /** Whether the latest run job was seen running on this screen: only then does its ending get a notice. */
  watched: boolean;
  /** This avatar's runs from `runs.list`: the resumable ones get a resume row, the ones ended by their cap a plain summary. */
  runs: readonly RunSummary[];
  runsError: EngineError | null;
  /** Retries the `runs.list` this screen asks for its stopped runs. */
  onRetryRuns: () => void;
  /** Why a paid resume cannot be sent right now, if anything stops it. */
  blockedReason: string | null;
  /** A paid runs.start or runs.resume is in flight for this avatar, from the generate card or any resume row (L5). */
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  onResumed: (resumed: { runId: string; jobId: string }) => void;
  /** CS.6: «Сцены на проверку». */
  review: boolean;
  /** The avatar's scene set as the slice reads it: `undefined` while it is read, null with none. */
  sceneSet: SceneSetView | null | undefined;
  sliceView: SceneSetSliceView;
  scenesJob: JobView | null;
  /** The compose's price as the card shows it, for the «как это работает» box. */
  composePrice: Estimate | null;
}

/**
 * The mockup's «Сцены» column. With «Сцены на проверку» on (CS.6) it holds the scene set: its job with the cancel, its notices, the «по описанию» form and
 * every scene; before a set exists, how review works; with review off, today's word and the set kept aside. Whatever the mode, the running photo run with
 * its cancel, how the watched run ended, and the stopped runs a resume can continue.
 */
export function ScenesColumn({
  avatar,
  view,
  count,
  runJob,
  activeRunId,
  watched,
  runs,
  runsError,
  onRetryRuns,
  blockedReason,
  paidInFlight,
  onPaidInFlightChange,
  onResumed,
  review,
  sceneSet,
  sliceView,
  scenesJob,
  composePrice,
}: ScenesColumnProps) {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const cancelSending = useRef(false);
  const progressId = useId();
  const titleId = useId(); // L12: was the hardcoded "scenes-title", which duplicate-broke aria-labelledby if this column ever rendered twice
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<EngineError | null>(null);
  const [idea, setIdea] = useState<IdeaStart | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const counterRef = useRef<HTMLButtonElement>(null);

  const running = runJob !== null && isActiveJob(runJob);
  // "Отменяем…" while runs.cancel is in flight and for as long after as the job has no real end yet (store.markCancelling).
  const cancelling = cancelBusy || (runJob !== null && view.cancellingJobs.has(runJob.jobId));
  const total = runJob?.total ?? 0;
  const reconcileNeeded = view.money?.reconcileNeeded ?? false;

  async function cancel(): Promise<void> {
    if (runJob === null || activeRunId === null || cancelSending.current) return;
    cancelSending.current = true;
    setCancelBusy(true);
    setCancelError(null);
    const reply = await client.request("runs.cancel", { runId: activeRunId });
    cancelSending.current = false;
    // The store is window-wide: it waits for the job's real end even if this screen is gone by now.
    if (reply.ok) store.markCancelling(runJob.jobId);
    if (!mounted.current) return;
    setCancelBusy(false);
    if (!reply.ok) setCancelError(reply.error);
  }

  // The set the column shows: with review on, the open set or the newest used one; with review off, none (it is kept aside, said below).
  const shownSet = review && sceneSet !== undefined && sceneSet !== null ? sceneSet : null;
  const openSet = sceneSet !== undefined && sceneSet !== null && sceneSet.status !== "used" ? sceneSet : null;
  const used = shownSet !== null && shownSet.status === "used";
  const fromSet = used && runJob !== null && runJob.runId === shownSet.runId;
  const live = shownSet !== null && shownSet.write !== null;
  const textModel = shownSet !== null ? modelName(shownSet.textModel) : view.settings ? modelName(view.settings.textModel) : null;
  const counts = shownSet === null ? null : headerCounts(shownSet, used ? (running && fromSet ? "active" : "ended") : null);
  const runCreatedAt = used ? (runs.find((r) => r.runId === shownSet.runId)?.createdAt ?? null) : null;
  // «+ Своя сцена» only for an open set; it waits while a write of the set runs or the form is open. An empty set opens with the form (ReviewEmpty).
  const canAdd = shownSet !== null && !used;
  const addOff = live || idea !== null;
  const emptySetId = openSet !== null && openSet.scenes.length === 0 && openSet.write === null ? openSet.sceneSetId : null;
  useEffect(() => {
    if (emptySetId !== null) setIdea((now) => now ?? EMPTY_IDEA);
  }, [emptySetId]);

  return (
    <section className="photos-scenes" aria-labelledby={titleId}>
      <div className="scene-col-head">
        <div className="photos-sec-head">
          <h2 id={titleId} ref={titleRef} className="card-title" tabIndex={-1}>
            Сцены
          </h2>
          <span className="mono muted scene-col-model">
            {shownSet === null && `${count} · `}
            {textModel}
          </span>
          {canAdd && (
            <button
              ref={addRef}
              type="button"
              className={addOff ? "btn btn-s photos-sec-action btn-off" : "btn btn-s photos-sec-action"}
              aria-expanded={idea !== null}
              aria-disabled={addOff}
              onClick={() => {
                if (!addOff) setIdea(EMPTY_IDEA);
              }}
            >
              <Icon name="plus" size={14} strokeWidth={2.4} />
              Своя сцена
            </button>
          )}
        </div>
        {counts !== null && (
          <p className="mono muted scene-col-counts">
            {counts.map((part, i) => (
              <span key={part.text} className="scene-col-count">
                {part.problem === undefined ? (
                  <span>{part.text}</span>
                ) : (
                  <button
                    ref={counterRef}
                    type="button"
                    className="cnt"
                    aria-label={part.problem.aria}
                    onClick={() => focusSceneCard(part.problem?.first ?? 0)}
                  >
                    {part.text}
                    <Icon name="arrowDown" size={10} strokeWidth={2.6} />
                  </button>
                )}
                {i < counts.length - 1 && " · "}
              </span>
            ))}
          </p>
        )}
      </div>

      {running && runJob && (
        <div className="job-progress">
          <div className="job-progress-row">
            <span id={progressId} className="job-progress-label">
              Рисуем фото: {runJob.done} из {total}
            </span>
            <button type="button" className="btn btn-s" onClick={() => void cancel()} disabled={cancelling || activeRunId === null}>
              {cancelling ? "Отменяем…" : "Отменить"}
            </button>
          </div>
          <div className="bar" role="progressbar" aria-labelledby={progressId} aria-valuemin={0} aria-valuemax={total} aria-valuenow={runJob.done}>
            <span style={{ width: `${total > 0 ? (runJob.done / total) * 100 : 0}%` }} />
          </div>
          {fromSet && runCreatedAt !== null && <span className="mono faint scene-progress-note">запуск из набора сцен · {RUN_DATE.format(Date.parse(runCreatedAt))}</span>}
        </div>
      )}
      {cancelError && <ErrorNotice error={cancelError} />}
      {!running && watched && runJob && <RunOutcome job={runJob} fromSet={fromSet} />}
      {runsError && (
        <ErrorNotice
          error={runsError}
          actions={
            <button type="button" className="btn btn-s" onClick={onRetryRuns}>
              Повторить
            </button>
          }
        />
      )}

      {/* Keyed on what is left too: a run whose open slots changed (another window, a resync) is priced again. */}
      {runs.filter((run) => run.capExhausted).map((run) => (
        <EndedRunRow key={run.runId} run={run} />
      ))}
      {runs.filter((run) => run.resumable).map((run) => (
        <ResumeRow
          key={`${run.runId}:${run.open}`}
          run={run}
          blockedReason={running ? "Дождитесь конца текущего запуска." : blockedReason}
          reconcileNeeded={reconcileNeeded}
          paidInFlight={paidInFlight}
          onPaidInFlightChange={onPaidInFlightChange}
          onResumed={onResumed}
        />
      ))}

      {!review && (
        <article className="photos-soon scene-box" aria-label="Проверка выключена">
          <div className="photos-scene-tags">
            <span className="tag">проверка выключена</span>
          </div>
          <p className="scene-box-text">{OFF_NOTE}</p>
          {openSet !== null && <p className="scene-box-text scene-box-muted">{offNoteSet(openSet)}</p>}
        </article>
      )}
      {review && sceneSet === null && (
        <article className="photos-soon scene-box" aria-label="Как работает проверка сцен">
          <div className="photos-scene-tags">
            <span className="tag">сцены на проверку</span>
          </div>
          <ol className="scene-explain">
            <li>
              <span className="stepn stepn-current mono">1</span>
              <span>
                <b>Составить.</b> Модель пишет {count > 0 ? countOf(count, ["сцену", "сцены", "сцен"]) : "сцены"} по настройкам карточки
                {composePrice !== null && count > 0 && (
                  <>
                    {" "}
                    — <span className="mono">{about(composePrice.expectedMicros)}</span>
                  </>
                )}
                , фото пока не рисуются.
              </span>
            </li>
            <li>
              <span className="stepn stepn-next mono">2</span>
              <span>
                <b>Проверить.</b> Поправьте текст, уберите лишние, попросите другую сцену или добавьте свою. Правки бесплатны; платно только то, что пишет
                модель, — с ценой на кнопке.
              </span>
            </li>
            <li>
              <span className="stepn stepn-next mono">3</span>
              <span>
                <b>Отрисовать.</b> Платите только за оставшиеся сцены. Набор живёт на диске — переживёт закрытие Studio.
              </span>
            </li>
          </ol>
        </article>
      )}

      {shownSet !== null && (
        <SceneSetPanel
          avatar={avatar}
          view={view}
          set={shownSet}
          sliceView={sliceView}
          scenesJob={scenesJob}
          runActive={running}
          runCreatedAt={runCreatedAt}
          paidInFlight={paidInFlight}
          onPaidInFlightChange={onPaidInFlightChange}
          idea={canAdd ? idea : null}
          onIdea={setIdea}
          titleRef={titleRef}
          addRef={addRef}
          counterRef={counterRef}
        />
      )}
    </section>
  );
}
