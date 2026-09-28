import { Fragment, type ReactNode, type Ref, useId } from "react";
import { ERROR_MESSAGES_RU, type Candidate, type FailedCandidateSlot } from "../../../shared/engine";
import { isActiveJob, type JobView } from "../../engine/store";
import { afterColon, countOf } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { Portrait, Silhouette } from "../../ui/Portrait";

const SLOTS = 4;

const FAILED_FORMS = ["вариант не удалось получить", "варианта не удалось получить", "вариантов не удалось получить"] as const;
const VARIANT_FORMS = ["вариант", "варианта", "вариантов"] as const;

type FailedSlot = Extract<FailedCandidateSlot, { reason: "failed" }>;

/** The failed (non-age-rejected) slots of a finished batch, summarised: their shared reason if they agree, otherwise a generic line. */
function failedSummary(failed: readonly FailedSlot[]): string {
  const codes = new Set(failed.map((f) => f.error.code));
  const [onlyCode] = codes;
  const reason = codes.size === 1 && onlyCode !== undefined ? ERROR_MESSAGES_RU[onlyCode] : "Причины разные — подробности в журнале.";
  return `${countOf(failed.length, FAILED_FORMS)}: ${afterColon(reason)}`;
}

export function candidateLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

interface CandidatesCardProps {
  candidates: readonly Candidate[];
  job: JobView | null;
  picked: string | null;
  onPick: (photoId: string) => void;
  onCancel: () => void;
  cancelling: boolean;
  /** Where focus goes when the button the user pressed (generate, cancel) disappears. */
  headingRef: Ref<HTMLHeadingElement>;
  /** How many of this draft's stored candidates today's age threshold hides (the Draft contract's own count); 0 when none are. */
  hiddenBelowThreshold: number;
}

/**
 * A slot of the running batch whose portrait has not come yet. A slot counts
 * as done (`job.done`) only once its outcome is known — and a portrait that
 * passed is already in `candidates` by then (the engine's `draft.changed`
 * lands before the `job.progress` that counts it), so only the slots not yet
 * done are drawn here: a done slot is either a real candidate above or, once
 * the batch ends, a «Не получилось» / «Скрыт» tile.
 */
function PendingSlot() {
  return (
    <div className="ph cand-slot cand-slot-drawing" aria-hidden="true">
      <Silhouette />
      <div className="shim" />
      <span className="pill cand-slot-pill link-text">
        Рисуется
      </span>
    </div>
  );
}

/** A slot with no portrait to offer: a failed attempt, or one the age check hides. The notice above says why in full. */
function EmptySlot({ letter, kind, sub }: { letter: string; kind: "failed" | "hidden"; sub: string }) {
  return (
    <div className={kind === "failed" ? "cand-slot cand-slot-failed" : "ph cand-slot cand-slot-hidden"}>
      <span className="mono cand-slot-letter" aria-hidden="true">
        {letter}
      </span>
      <span className={kind === "failed" ? "danger-text" : "muted"}>
        <Icon name={kind === "failed" ? "alert" : "eyeOff"} size={20} strokeWidth={1.8} />
      </span>
      <span className="cand-slot-title">{kind === "failed" ? "Не получилось" : "Скрыт"}</span>
      <span className="cand-slot-sub">{sub}</span>
    </div>
  );
}

/** Step 2 «Кандидаты»: progress while the job runs, then the portraits to choose from. */
export function CandidatesCard({ candidates, job, picked, onPick, onCancel, cancelling, headingRef, hiddenBelowThreshold }: CandidatesCardProps) {
  const groupName = useId();
  const running = job !== null && isActiveJob(job);
  const total = job?.total || SLOTS;
  const result = job?.result?.kind === "avatar.candidates" ? job.result : null;
  const rejected = result?.rejectedByAgeCheck ?? 0;
  const failedOther = result ? result.failedSlots.filter((f): f is FailedSlot => f.reason === "failed") : [];
  // The batch ran to its end but produced nothing to choose from — distinct
  // from "not started yet", which looks the same (four empty letters) otherwise.
  const allFailed = job?.status === "done" && candidates.length === 0 && (rejected > 0 || failedOther.length > 0);

  // Every tile after the portraits, lettered on from them: the batch still
  // drawing, or — once it ended — the slots that gave nothing, then the older
  // portraits a stricter age threshold now hides.
  const extra: { key: string; node: (letter: string) => ReactNode }[] = [];
  if (running) {
    for (let i = job.done; i < total; i++) {
      extra.push({ key: `pending-${i}`, node: () => <PendingSlot /> });
    }
  } else {
    for (const f of failedOther) {
      extra.push({ key: `failed-${f.slot}`, node: (letter) => <EmptySlot letter={letter} kind="failed" sub="стоимость попытки учтена" /> });
    }
    for (let i = 0; i < rejected; i++) {
      extra.push({ key: `rejected-${i}`, node: (letter) => <EmptySlot letter={letter} kind="hidden" sub="не прошёл проверку возраста" /> });
    }
  }
  for (let i = 0; i < hiddenBelowThreshold; i++) {
    extra.push({ key: `hidden-${i}`, node: (letter) => <EmptySlot letter={letter} kind="hidden" sub="не проходит новый порог возраста" /> });
  }
  const nothingYet = candidates.length === 0 && extra.length === 0;

  return (
    <section className="card candidates-card" aria-labelledby="candidates-title">
      <div className="candidates-head">
        <h2 id="candidates-title" ref={headingRef} className="card-title" tabIndex={-1}>
          Кандидаты
        </h2>
        <span className="mono">
          {candidates.length > 0 ? `${countOf(candidates.length, VARIANT_FORMS)} · выберите один` : "4 варианта на выбор"}
        </span>
      </div>

      {running && (
        <div className="job-progress">
          <div className="job-progress-row">
            <span id={`${groupName}-progress`} className="job-progress-label">
              Рисуем портреты: {job.done} из {total}
            </span>
            <button type="button" className="btn btn-s" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "Отменяем…" : "Отменить"}
            </button>
          </div>
          <div
            className="bar"
            role="progressbar"
            aria-labelledby={`${groupName}-progress`}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={job.done}
          >
            <span style={{ width: `${(job.done / total) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="sr-only" role="status">
        {job?.status === "done" ? `Готово: ${countOf(candidates.length, VARIANT_FORMS)} на выбор.` : ""}
      </div>

      {job?.status === "failed" && job.error && <ErrorNotice error={job.error} />}
      {job?.status === "cancelled" && (
        <Notice tone="info" title="Генерация остановлена">
          Прерванные запросы считаются по худшей цене, пока расходы не сверены.
        </Notice>
      )}
      {rejected > 0 && (
        <Notice tone="info">
          {countOf(rejected, ["вариант отклонён", "варианта отклонены", "вариантов отклонены"])} проверкой возраста и не показаны. Их
          стоимость учтена.
        </Notice>
      )}
      {failedOther.length > 0 && (
        <Notice tone={allFailed ? "danger" : "warn"}>
          {failedSummary(failedOther)} Стоимость попытки учтена.
        </Notice>
      )}

      {hiddenBelowThreshold > 0 && (
        <Notice tone="info">
          {countOf(hiddenBelowThreshold, [
            "вариант из прошлой партии больше не проходит",
            "варианта из прошлой партии больше не проходят",
            "вариантов из прошлой партии больше не проходят",
          ])}{" "}
          проверку возраста при более строгом пороге. Сгенерируйте новую партию.
        </Notice>
      )}

      {allFailed && <p className="muted">Ни один вариант не получился. Можно попробовать снова — это отдельная оплаченная попытка.</p>}

      {nothingYet ? (
        <div className="cand-grid" aria-hidden="true">
          {Array.from({ length: SLOTS }, (_, i) => (
            <div key={i} className="cand-slot cand-slot-empty">
              <span className="mono cand-slot-letter">{candidateLetter(i)}</span>
            </div>
          ))}
        </div>
      ) : candidates.length === 0 ? (
        // No real candidate to choose among (every slot failed or was hidden):
        // a <fieldset>/radiogroup with nothing to select is empty semantics,
        // so the failed tiles are drawn plainly instead.
        <div className="cand-grid">
          {extra.map((t, i) => (
            <Fragment key={t.key}>{t.node(candidateLetter(i))}</Fragment>
          ))}
        </div>
      ) : (
        <fieldset className="cand-fieldset">
          <legend className="sr-only">Выберите вариант</legend>
          <div className="cand-grid">
            {candidates.map((c, i) => {
              const on = c.photoId === picked;
              const letter = candidateLetter(i);
              return (
                <label key={c.photoId} className={on ? "ph cand cand-on" : "ph cand"}>
                  <input
                    type="radio"
                    className="choice-input"
                    name={groupName}
                    value={c.photoId}
                    checked={on}
                    onChange={() => onPick(c.photoId)}
                    aria-label={`Вариант ${letter}`}
                  />
                  <Portrait avatarId={c.avatarId} photoId={c.photoId} label={`Вариант ${letter}`} />
                  <span className="pill cand-letter" aria-hidden="true">
                    {letter}
                  </span>
                  {on && (
                    <span className="pill cand-picked" aria-hidden="true">
                      Выбран
                    </span>
                  )}
                </label>
              );
            })}
            {extra.map((t, i) => (
              <Fragment key={t.key}>{t.node(candidateLetter(candidates.length + i))}</Fragment>
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
}
