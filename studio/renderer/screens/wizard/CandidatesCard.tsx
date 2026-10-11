import { Fragment, type ReactNode, type Ref, useId } from "react";
import { ERROR_MESSAGES_RU, type Candidate, type FailedCandidateSlot } from "../../../shared/engine";
import { isActiveJob, type JobView } from "../../engine/store";
import { afterColon, countOf } from "../../lib/format";
import { Icon, type IconName } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { Portrait, Silhouette } from "../../ui/Portrait";
import { likenessText, PORTRAIT_TEXT, THRESHOLD_TEXT, variantLabel, type GoneTile } from "../look/portraitModel";

/** The wizard's batch: four portraits. A reference-portrait batch passes its own count (`slots`, S5.3d). */
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

/** A portrait to choose: the wizard's candidate, or (S5.3d) a reference portrait with its likeness to the imported photo. */
export type CardCandidate = Candidate & { readonly likeness?: number };

/**
 * S5.3d: the same card as «Варианты мастер-портрета» (.omc/stage5/design 15–23): the panel's head, a likeness badge and «лучший» on each portrait, the
 * finished batch's slots by outcome, its own lines, and the action rail beside the grid. While the batch runs the drawn portraits are shown but are no
 * radios yet (review L1): there is nothing to choose until it ends.
 */
export interface PortraitMode {
  readonly best: string | null;
  /** The finished batch's slots that gave no portrait (none while it runs, and none after a failure or a cancel: those events carry no slots). */
  readonly gone: readonly GoneTile[];
  /** The head's count; null for none (review L1: the head promises no count while the batch runs). */
  readonly meta: string | null;
  /** The panel's own lines over the grid: a paid failure, the age check, none passed, a refused pick or reset. */
  readonly notices: ReactNode;
  /** A cancelled batch kept the portraits it drew: its notice says so (L5). */
  readonly keptOnCancel: boolean;
  readonly rail: ReactNode;
  /** A pick is being saved: the grid holds still. */
  readonly busy: boolean;
}

interface CandidatesCardProps {
  candidates: readonly CardCandidate[];
  job: JobView | null;
  picked: string | null;
  onPick: (photoId: string) => void;
  onCancel: () => void;
  cancelling: boolean;
  /** Where focus goes when the button the user pressed (generate, cancel) disappears. */
  headingRef: Ref<HTMLHeadingElement>;
  /** How many of this draft's stored candidates today's age threshold hides (the Draft contract's own count); 0 when none are. */
  hiddenBelowThreshold: number;
  /** S5.3d: the slots of one batch, for «N из M» before the first progress and for the empty grid: the wizard's 4 unless said. */
  slots?: number;
  /** S5.3d: the reference-portrait mode; the wizard leaves it out. */
  portrait?: PortraitMode;
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

/** A slot with no portrait to offer: a failed attempt, or one the age check (or, S5.3d, the face check) dropped. The notice above says why in full. */
function EmptySlot({ letter, look, icon, tone, title, sub }: { letter: string; look: "failed" | "dropped"; icon: IconName; tone: string; title: string; sub: string | null }) {
  return (
    <div className={look === "failed" ? "cand-slot cand-slot-failed" : "ph cand-slot cand-slot-hidden"}>
      <span className="mono cand-slot-letter" aria-hidden="true">
        {letter}
      </span>
      <span className={tone}>
        <Icon name={icon} size={20} strokeWidth={1.8} />
      </span>
      <span className="cand-slot-title">{title}</span>
      {sub !== null && <span className="cand-slot-sub">{sub}</span>}
    </div>
  );
}

/** The wizard's two kinds of empty slot, as they have always read. */
function wizardSlot(kind: "failed" | "hidden", sub: string): (letter: string) => ReactNode {
  return (letter) =>
    kind === "failed" ? (
      <EmptySlot letter={letter} look="failed" icon="alert" tone="danger-text" title="Не получилось" sub={sub} />
    ) : (
      <EmptySlot letter={letter} look="dropped" icon="eyeOff" tone="muted" title="Скрыт" sub={sub} />
    );
}

/** S5.3d: a reference portrait's badges, under the face: «лучший» over «сходство 0.76» (design decision 2). */
function PortraitBadges({ likeness, best }: { likeness: number | undefined; best: boolean }) {
  return (
    <span className="portrait-badges" aria-hidden="true">
      {best && <span className="pill portrait-best">лучший</span>}
      {likeness !== undefined && <span className="pill mono photo-badge photo-face">сходство {likenessText(likeness)}</span>}
    </span>
  );
}

/** Step 2 «Кандидаты»: progress while the job runs, then the portraits to choose from. S5.3d: also «Варианты мастер-портрета» (`portrait`). */
export function CandidatesCard({ candidates, job, picked, onPick, onCancel, cancelling, headingRef, hiddenBelowThreshold, slots = SLOTS, portrait }: CandidatesCardProps) {
  const groupName = useId();
  // S5.3d review L7: the portrait panel names itself by a generated id (the wizard keeps its own, unchanged).
  const portraitsTitleId = useId();
  const running = job !== null && isActiveJob(job);
  const total = job?.total || slots;
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
  } else if (portrait !== undefined) {
    for (const g of portrait.gone) {
      extra.push({ key: g.key, node: (letter) => <EmptySlot letter={letter} look={g.look} icon={g.icon} tone={g.tone} title={g.title} sub={g.sub} /> });
    }
  } else {
    for (const f of failedOther) {
      extra.push({ key: `failed-${f.slot}`, node: wizardSlot("failed", "стоимость попытки учтена") });
    }
    for (let i = 0; i < rejected; i++) {
      extra.push({ key: `rejected-${i}`, node: wizardSlot("hidden", "не прошёл проверку возраста") });
    }
  }
  for (let i = 0; i < hiddenBelowThreshold; i++) {
    extra.push({ key: `hidden-${i}`, node: wizardSlot("hidden", "не проходит новый порог возраста") });
  }
  const nothingYet = candidates.length === 0 && extra.length === 0;

  const progress = running && (
    <div className="job-progress">
      <div className="job-progress-row">
        <span id={`${groupName}-progress`} className="job-progress-label">
          Рисуем портреты: {job.done} из {total}
        </span>
        <button type="button" className="btn btn-s" onClick={onCancel} disabled={cancelling}>
          {cancelling ? "Отменяем…" : "Отменить"}
        </button>
      </div>
      <div className="bar" role="progressbar" aria-labelledby={`${groupName}-progress`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={job.done}>
        <span style={{ width: `${(job.done / total) * 100}%` }} />
      </div>
    </div>
  );

  const status = (
    <div className="sr-only" role="status">
      {job?.status === "done" ? `Готово: ${countOf(candidates.length, VARIANT_FORMS)} на выбор.` : ""}
    </div>
  );

  const ended = (
    <>
      {job?.status === "failed" && job.error && <ErrorNotice error={job.error} />}
      {job?.status === "cancelled" && (
        <Notice tone="info" title="Генерация остановлена">
          Прерванные запросы считаются по худшей цене, пока расходы не сверены.
          {portrait?.keptOnCancel === true && ` ${PORTRAIT_TEXT.cancelledSaved}`}
        </Notice>
      )}
    </>
  );

  const emptyLetters = (
    <div className="cand-grid" aria-hidden="true">
      {Array.from({ length: slots }, (_, i) => (
        <div key={i} className="cand-slot cand-slot-empty">
          <span className="mono cand-slot-letter">{candidateLetter(i)}</span>
        </div>
      ))}
    </div>
  );

  if (portrait !== undefined) {
    return (
      <section
        className={running ? "card candidates-card portraits-panel portraits-panel-running" : "card candidates-card portraits-panel"}
        aria-labelledby={portraitsTitleId}
        aria-busy={portrait.busy || undefined}
      >
        <div className="candidates-head portraits-head">
          <h2 id={portraitsTitleId} ref={headingRef} className="card-title" tabIndex={-1}>
            Варианты мастер-портрета
          </h2>
          {portrait.meta !== null && <span className="mono">{portrait.meta}</span>}
          <span className="portraits-ref">сходство — с исходным фото · порог {THRESHOLD_TEXT}</span>
        </div>
        <div className="portraits-body">
          <div className="portraits-main">
            {progress}
            {status}
            {ended}
            {portrait.notices}
            {nothingYet ? (
              emptyLetters
            ) : running ? (
              // Review L1: drawn, but nothing to choose until the batch ends.
              <div className="cand-grid portrait-grid">
                {candidates.map((c, i) => (
                  <div
                    key={c.photoId}
                    className="ph cand cand-still"
                    role="img"
                    aria-label={`Вариант ${candidateLetter(i)} готов${c.likeness === undefined ? "" : ` · сходство ${likenessText(c.likeness)}`}`}
                  >
                    <Portrait avatarId={c.avatarId} photoId={c.photoId} label={`Вариант ${candidateLetter(i)}`} />
                    <span className="pill cand-letter" aria-hidden="true">
                      {candidateLetter(i)}
                    </span>
                    <PortraitBadges likeness={c.likeness} best={false} />
                  </div>
                ))}
                {extra.map((t, i) => (
                  <Fragment key={t.key}>{t.node(candidateLetter(candidates.length + i))}</Fragment>
                ))}
              </div>
            ) : candidates.length === 0 ? (
              <div className="cand-grid portrait-grid">
                {extra.map((t, i) => (
                  <Fragment key={t.key}>{t.node(candidateLetter(i))}</Fragment>
                ))}
              </div>
            ) : (
              <fieldset className="cand-fieldset" disabled={portrait.busy}>
                <legend className="sr-only">Выберите мастер-портрет</legend>
                <div className="cand-grid portrait-grid">
                  {candidates.map((c, i) => {
                    const on = c.photoId === picked;
                    const best = c.photoId === portrait.best;
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
                          aria-label={variantLabel(letter, c.likeness, best)}
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
                        <PortraitBadges likeness={c.likeness} best={best} />
                      </label>
                    );
                  })}
                  {extra.map((t, i) => (
                    <Fragment key={t.key}>{t.node(candidateLetter(candidates.length + i))}</Fragment>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
          {portrait.rail}
        </div>
      </section>
    );
  }

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

      {progress}

      {status}

      {ended}
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
        emptyLetters
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
