import { type Ref, useId } from "react";
import type { Candidate } from "../../../shared/engine";
import { isActiveJob, type JobView } from "../../engine/store";
import { countOf } from "../../lib/format";
import { Icon } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";

const SLOTS = 4;

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
}

function PendingSlots({ job }: { job: JobView }) {
  const total = job.total || SLOTS;
  return (
    <>
      {Array.from({ length: total }, (_, i) => {
        const drawn = i < job.done;
        return (
          <div key={i} className={drawn ? "cand-slot cand-slot-drawn" : "cand-slot cand-slot-drawing"} aria-hidden="true">
            {!drawn && <span className="shimmer" />}
            <span className="pill cand-slot-pill">{drawn ? "готов · проверка" : "рисуется"}</span>
          </div>
        );
      })}
    </>
  );
}

/** Step 3: progress while the job runs, then the portraits to choose from. */
export function CandidatesCard({ candidates, job, picked, onPick, onCancel, cancelling, headingRef }: CandidatesCardProps) {
  const groupName = useId();
  const running = job !== null && isActiveJob(job);
  const total = job?.total || SLOTS;
  const rejected = job?.result?.kind === "avatar.candidates" ? job.result.rejectedByAgeCheck : 0;

  return (
    <section className="card candidates-card" aria-labelledby="candidates-title">
      <div className="card-head">
        <h2 id="candidates-title" ref={headingRef} className="card-title" tabIndex={-1}>
          Кандидаты
        </h2>
        <span className="mono faint">
          {candidates.length > 0 ? `${countOf(candidates.length, ["вариант", "варианта", "вариантов"])} · выберите один` : "4 варианта на выбор"}
        </span>
      </div>

      {running && (
        <div className="job-progress">
          <div className="job-progress-row">
            <span id={`${groupName}-progress`} className="job-progress-label">
              Рисуем портреты: {job.done} из {total}
            </span>
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "Отменяем…" : "Отменить"}
            </button>
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-labelledby={`${groupName}-progress`}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={job.done}
          >
            <span className="progress-fill" style={{ width: `${(job.done / total) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="sr-only" role="status">
        {job?.status === "done" ? `Готово: ${countOf(candidates.length, ["вариант", "варианта", "вариантов"])} на выбор.` : ""}
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

      {candidates.length === 0 && !running ? (
        <div className="cand-grid" aria-hidden="true">
          {Array.from({ length: SLOTS }, (_, i) => (
            <div key={i} className="cand-slot cand-slot-empty">
              <span className="mono faint">{candidateLetter(i)}</span>
            </div>
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
                <label key={c.photoId} className={on ? "cand cand-on" : "cand"}>
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
                    <span className="pill pill-accent cand-picked" aria-hidden="true">
                      <Icon name="check" size={12} strokeWidth={3} />
                      Выбран
                    </span>
                  )}
                </label>
              );
            })}
            {running && job && <PendingSlots job={job} />}
          </div>
        </fieldset>
      )}
    </section>
  );
}
