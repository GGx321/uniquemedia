import { useEffect, useId, useRef, useState } from "react";
import type { EngineError, Estimate, RunSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../../engine/store";
import { countOf } from "../../lib/format";
import { formatUsd } from "../../lib/money";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { modelName } from "./runForm";
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
  /** A paid runs.start or runs.resume is in flight for this avatar, from this row or the generate card or another row (L5). */
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  onResumed: (resumed: { runId: string; jobId: string }) => void;
}

function ResumeRow({ run, blockedReason, paidInFlight, onPaidInFlightChange, onResumed }: ResumeRowProps) {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const sending = useRef(false);
  const titleId = useId();
  const hintId = useId();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  // Busy from the very first frame: the price is on its way before the button can ever be clicked.
  const [busy, setBusy] = useState<ResumeBusy>("estimate");
  const [error, setError] = useState<EngineError | null>(null);

  async function askPrice(): Promise<void> {
    setBusy("estimate");
    setError(null);
    const reply = await client.request("runs.estimateResume", { runId: run.runId });
    if (!mounted.current) return;
    setBusy(null);
    if (reply.ok) {
      setEstimate(reply.result.estimate);
      setPreviousWorst(null);
    } else setError(reply.error);
  }

  useEffect(() => {
    void askPrice();
  }, [run.runId]); // once per run: a retry is the button's own

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
      const fresh = await client.request("runs.estimateResume", { runId: run.runId });
      if (!mounted.current) return;
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
    }
  }

  // Another paid command (the generate card's or another row's) is in flight for this avatar (L5): this row locks too, though it is not the one sending.
  const lockedByOther = paidInFlight && busy === null;
  const effectiveBlockedReason = blockedReason ?? (lockedByOther ? "Дождитесь окончания другого платного действия." : null);
  const title = busy === "estimate" ? "Считаем…" : busy === "resume" ? "Продолжаем…" : previousWorst !== null ? "Подтвердить новую цену" : estimate ? "Продолжить" : "Узнать цену";
  const paidClick = estimate !== null && effectiveBlockedReason === null;
  const clickable = busy === null && (estimate === null || paidClick);
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
          {estimate && busy !== "estimate" && (
            <>
              <span className="sr-only"> · </span>
              <span className="mono">до {formatUsd(estimate.worstMicros, 2, "up")}</span>
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

/** How the run this screen watched ended: the gallery shows its photos, this says what else happened. */
function RunOutcome({ job }: { job: JobView }) {
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
        В галерее {countOf(photoIds.length, PHOTO_FORMS)} этого запуска.
        {failedSlots > 0 && ` Не получилось: ${failedSlots} — стоимость попыток учтена.`}
      </Notice>
    );
  }
  return null;
}

interface ScenesColumnProps {
  view: EngineView;
  count: number;
  /** This avatar's latest run job, if the window knows one. */
  runJob: JobView | null;
  /** Its run, once known (the start reply, or `runs.list`); cancel needs it. */
  activeRunId: string | null;
  /** Whether the latest run job was seen running on this screen: only then does its ending get a notice. */
  watched: boolean;
  runs: readonly RunSummary[];
  runsError: EngineError | null;
  /** Retries the `runs.list` this screen asks for its stopped runs and, when a running job's own runId is not yet known, its cancel target (M2). */
  onRetryRuns: () => void;
  /** Why a paid resume cannot be sent right now, if anything stops it. */
  blockedReason: string | null;
  /** A paid runs.start or runs.resume is in flight for this avatar, from the generate card or any resume row (L5). */
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  onResumed: (resumed: { runId: string; jobId: string }) => void;
}

/**
 * The mockup's «Сцены» column. The contract has no scene plan to show before
 * or while a run draws (no per-scene text, shot, status, edit or re-roll), so
 * the column carries what it does have — the running job with its cancel,
 * how the watched run ended, and the stopped runs a resume can continue —
 * and marks the scene list itself as coming.
 */
export function ScenesColumn({
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
}: ScenesColumnProps) {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const cancelSending = useRef(false);
  const progressId = useId();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<EngineError | null>(null);

  const running = runJob !== null && isActiveJob(runJob);
  // "Отменяем…" while runs.cancel is in flight and for as long after as the job has no real end yet (store.markCancelling).
  const cancelling = cancelBusy || (runJob !== null && view.cancellingJobs.has(runJob.jobId));
  const total = runJob?.total ?? 0;

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

  const textModel = view.settings ? modelName(view.settings.textModel) : null;

  return (
    <section className="photos-scenes" aria-labelledby="scenes-title">
      <div className="photos-sec-head">
        <h2 id="scenes-title" className="card-title">
          Сцены
        </h2>
        <span className="mono muted">
          {count}
          {textModel && ` · ${textModel}`}
        </span>
        <button type="button" className="btn btn-s photos-sec-action" disabled title="Скоро: сцены пересоставляются до отрисовки">
          <Icon name="reload" size={14} />
          Пересоставить
        </button>
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
        </div>
      )}
      {cancelError && <ErrorNotice error={cancelError} />}
      {!running && watched && runJob && <RunOutcome job={runJob} />}
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
      {runs.map((run) => (
        <ResumeRow
          key={`${run.runId}:${run.open}`}
          run={run}
          blockedReason={running ? "Дождитесь конца текущего запуска." : blockedReason}
          paidInFlight={paidInFlight}
          onPaidInFlightChange={onPaidInFlightChange}
          onResumed={onResumed}
        />
      ))}

      <article className="photos-soon" aria-label="Список сцен — скоро">
        <div className="photos-scene-tags">
          <span className="tag">скоро</span>
        </div>
        <p className="photos-scene-text">
          Сцены по одной — с текстом, типом кадра и статусом, с правкой и перегенерацией до отрисовки. Пока движок составляет и рисует их за один запуск.
        </p>
      </article>
    </section>
  );
}
