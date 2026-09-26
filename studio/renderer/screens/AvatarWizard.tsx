import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AvatarName, type Candidate, type EngineError, type Estimate } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { isActiveJob, type JobView } from "../engine/store";
import { formatUsd } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { DEFAULT_TRAITS, randomTraits, type Traits, traitsProblem } from "../lib/traits";
import { vibeIssues } from "../lib/vibe";
import { useNavigate } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon } from "../ui/Icon";
import { ErrorNotice } from "../ui/Notice";
import { ScreenTitle } from "../ui/ScreenTitle";
import { CandidatesCard, candidateLetter } from "./wizard/CandidatesCard";
import { type EstimateAction, EstimateCard } from "./wizard/EstimateCard";
import { TraitsForm } from "./wizard/TraitsForm";

type Busy = "estimate" | "generate" | "cancel" | "save" | null;

const STEPS = ["Внешность", "Оценка", "Кандидаты", "Сохранение"] as const;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="stepper" aria-label="Шаги">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li key={label} className={`step step-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="step-num mono" aria-hidden="true">
              {state === "done" ? <Icon name="check" size={12} strokeWidth={3} /> : n}
            </span>
            {label}
            {state === "done" && <span className="sr-only"> — готово</span>}
          </li>
        );
      })}
    </ol>
  );
}

function nameIssue(name: string): string | null {
  const parsed = AvatarName.safeParse(name);
  if (parsed.success) return null;
  if (name.trim().length === 0) return "Введите имя.";
  if (name.length > 60) return "Не длиннее 60 символов.";
  return "Уберите невидимые и управляющие символы.";
}

function uniqueCandidates(lists: readonly (readonly Candidate[])[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of lists.flat()) {
    if (!seen.has(c.photoId)) {
      seen.add(c.photoId);
      out.push(c);
    }
  }
  return out;
}

function latestCandidatesJob(jobs: readonly JobView[], avatarId: string | null): JobView | null {
  if (avatarId === null) return null;
  const own = jobs.filter((j) => j.avatarId === avatarId && j.kind !== "run");
  return own[own.length - 1] ?? null;
}

/**
 * The "Новый аватар" wizard: traits → estimate → 4 candidates → pick. Nothing
 * paid is sent until the user has seen the estimate; every paid command
 * carries the worst case shown for *that* command — createDraft the whole
 * new-avatar estimate, generateCandidates the draft's own batch estimate —
 * and a PRICE_CHANGED refusal shows the new estimate and asks again.
 */
export function AvatarWizard({ draftId }: { draftId: string | null }) {
  const { client, store } = useEngine();
  const view = useEngineView();
  const navigate = useNavigate();
  const nameId = useId();
  const nameErrorId = useId();

  const [avatarId, setAvatarId] = useState<string | null>(draftId);
  const draft = avatarId === null ? null : (view.drafts.find((d) => d.avatarId === avatarId) ?? null);
  const [traits, setTraits] = useState<Traits>(draft?.traits ?? DEFAULT_TRAITS);
  const [estimate, setEstimate] = useState<Estimate | null>(draft?.estimate ?? null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [saveError, setSaveError] = useState<EngineError | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [showNameIssue, setShowNameIssue] = useState(false);
  // Bumped on every traits change: an estimate answer for older traits is dropped.
  const traitsVersion = useRef(0);
  // False once the user has left the wizard: a paid step already under way sends nothing more.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidatesHeading = useRef<HTMLHeadingElement>(null);

  // A draft opened from the grid may arrive with the snapshot, after the first render.
  const draftKey = draft?.avatarId ?? null;
  useEffect(() => {
    if (!draft) return;
    setTraits(draft.traits);
    setEstimate((current) => current ?? draft.estimate);
  }, [draftKey]); // only when a different draft appears

  // A continued draft's cached price can be missing (the engine could not
  // price it when the draft was made) or, once shown, is not refreshed on its
  // own: avatars.estimateCandidates prices "another batch" and re-validates
  // the descriptor, so a DESCRIPTOR_INVALID here is caught before any spend.
  // `busy !== null` is deliberately not in the deps array below: it is read
  // as of the render where draftKey changes, to skip a draft generate() just
  // created (busy is "generate" for its whole flow) — that flow prices its
  // own fallback and gates the batch on a fresh click; this effect racing it
  // for the same avatars.estimateCandidates call would double-fetch and could
  // overwrite that gate's estimate with a differently-timed answer.
  useEffect(() => {
    if (draft === null || draft.estimate !== null || busy !== null) return;
    let alive = true;
    setBusy("estimate");
    void client.request("avatars.estimateCandidates", { avatarId: draft.avatarId }).then((reply) => {
      if (!alive) return;
      setBusy(null);
      if (reply.ok) setEstimate(reply.result);
      else setError(reply.error);
    });
    return () => {
      alive = false;
    };
  }, [draftKey]); // keyed on the draft's identity, not its (possibly still-null) estimate

  const locked = avatarId !== null;
  const issues = vibeIssues(traits.vibe, traits.age);
  const problem = issues.length > 0 ? "Исправьте поле «Вайб»." : traitsProblem(traits);
  const traitsValid = problem === null;
  const key = view.settings?.apiKey;
  const keyUsable = key !== undefined && key.stored && !key.rejected;
  const stop = paidStop(view);
  const offline = view.phase === "offline";

  const job = (jobId ? view.jobs.find((j) => j.jobId === jobId) : null) ?? latestCandidatesJob(view.jobs, avatarId);
  const running = job !== null && isActiveJob(job);
  // "Отменяем…" while this window's own avatars.cancel is in flight (busy),
  // and for as long as afterward as the store has no real end for the job
  // yet (M-optimistic-cancel) — cleared by whatever ends the job, cancelled
  // or not, never by this command's own reply alone.
  const cancelling = busy === "cancel" || (job !== null && view.cancellingJobs.has(job.jobId));
  const jobCandidates = job?.result?.kind === "avatar.candidates" ? job.result.candidates : [];
  const candidates = uniqueCandidates([draft?.candidates ?? [], jobCandidates]);
  const pickedIndex = candidates.findIndex((c) => c.photoId === picked);

  const step = picked !== null ? 4 : locked || running || candidates.length > 0 ? 3 : estimate ? 2 : 1;

  function changeTraits(next: Traits): void {
    if (locked || busy === "generate") return;
    traitsVersion.current += 1;
    setTraits(next);
    // The estimate was for the old traits: it must be asked for again.
    setEstimate(null);
    setPreviousWorst(null);
    setError(null);
  }

  async function estimateCost(): Promise<void> {
    const version = traitsVersion.current;
    setBusy("estimate");
    setError(null);
    const reply = await client.request("avatars.estimate", { traits });
    setBusy(null);
    // The traits changed while the price was on its way: it belongs to a look that is gone.
    if (version !== traitsVersion.current) return;
    if (reply.ok) {
      setEstimate(reply.result);
      setPreviousWorst(null);
    } else setError(reply.error);
  }

  /**
   * Paid: descriptor (once) and a batch of candidates. createDraft is capped
   * at the whole new-avatar worst the user just accepted, as before — the
   * engine checks it against that whole job (engine.ts ~:824). But
   * generateCandidates must never reuse that same number: the engine checks
   * it against the batch job alone, no descriptor in it (engine.ts ~:890),
   * so sending the whole avatar's worst to both let their spend add up past
   * what the user actually accepted — up to the descriptor's own worst case
   * (whole-slice review, M1). Once the draft exists, its own batch estimate
   * is what gets shown and sent for every paid call from here on.
   */
  async function generate(accepted: Estimate): Promise<void> {
    setBusy("generate");
    setError(null);
    let id = avatarId;
    // What generateCandidates is about to be sent: the whole new-avatar
    // estimate until a draft exists, then replaced below by the draft's own
    // batch estimate — never the whole one again.
    let batchAccepted = accepted;
    if (id === null) {
      const created = await client.request("avatars.createDraft", { traits, acceptedWorstMicros: accepted.worstMicros });
      if (!created.ok) return refused(created.error, accepted, id);
      store.upsertDraft(created.result.draft);
      // The user left while the descriptor was being written: the draft stays, but no batch is bought for a wizard nobody sees.
      if (!mounted.current) return;
      id = created.result.draft.avatarId;
      setAvatarId(id);

      if (created.result.draft.estimate !== null) {
        // createDraft prices its whole job and this draft's next batch from
        // the same price book in the same call (engine.ts ~:822 and ~:863),
        // so this number was already covered by the whole-avatar worst the
        // user just accepted above: safe to send on unchanged.
        const batch = created.result.draft.estimate;
        setEstimate(batch); // "Ещё 4 варианта" must show the batch's own price, not the whole avatar's
        setPreviousWorst(null);
        batchAccepted = batch;
      } else {
        // Draft.estimate is nullable in the contract (studio/shared/engine/
        // state.ts): the engine could not price the batch when it built the
        // draft. Unreachable today — createDraft always fills it — but must
        // stay safe: avatars.estimateCandidates is a separate, later call
        // that can come back from a fresher (and higher) price book than
        // createDraft's own accepted-check used, and the user never saw
        // this number. Same rule as M1 — never send an accepted worst the
        // user did not see — so it must not go straight to
        // generateCandidates; show it and require a fresh click, exactly
        // like a PRICE_CHANGED refusal.
        const batch = await estimateBatch(id);
        if (batch === null || !mounted.current) return; // estimateBatch already reported the error, or the user left meanwhile
        setEstimate(batch);
        setPreviousWorst(accepted.worstMicros);
        setBusy(null);
        return;
      }
    }
    const started = await client.request("avatars.generateCandidates", { avatarId: id, acceptedWorstMicros: batchAccepted.worstMicros });
    if (!started.ok) return refused(started.error, batchAccepted, id);
    store.trackCandidatesJob(started.result.jobId, id);
    setJobId(started.result.jobId);
    setPreviousWorst(null);
    setBusy(null);
    // The generate button is gone now; the candidates card is where the work shows up.
    candidatesHeading.current?.focus();
  }

  /**
   * The batch price for a fresh draft whose createDraft answer carried none;
   * null (error already shown, busy already cleared) on failure. On
   * failure, `estimate` is cleared too: it still held the whole new-avatar
   * price from before generate() was clicked, and leaving it in place would
   * make "Ещё 4 варианта" clickable again at that whole price — sending it
   * to generateCandidates would bring the M1 bug straight back. With no
   * estimate, retryBatchEstimate() below is the only way back to a button.
   */
  async function estimateBatch(id: string): Promise<Estimate | null> {
    const reply = await client.request("avatars.estimateCandidates", { avatarId: id });
    if (reply.ok) return reply.result;
    setEstimate(null);
    setError(reply.error);
    setBusy(null);
    return null;
  }

  /** Retries the batch price after estimateBatch (or the mount-time fetch below) failed and left `estimate` null. */
  async function retryBatchEstimate(): Promise<void> {
    if (avatarId === null) return;
    setBusy("estimate");
    setError(null);
    const reply = await client.request("avatars.estimateCandidates", { avatarId });
    setBusy(null);
    if (reply.ok) {
      setEstimate(reply.result);
      setPreviousWorst(null);
    } else {
      setError(reply.error);
    }
  }

  /**
   * `refusedAvatarId` is generate()'s own local `id`, not the `avatarId`
   * state read from this closure: right after a fresh createDraft, `id` is
   * already the new draft's id, but the component has not re-rendered yet,
   * so `avatarId` here would still read null and wrongly re-price the whole
   * new avatar (and re-check the descriptor) instead of just the next batch.
   */
  async function refused(err: EngineError, accepted: Estimate, refusedAvatarId: string | null): Promise<void> {
    if (err.code === "PRICE_CHANGED") {
      // A draft already has a descriptor, fresh or continued alike: its
      // refreshed price (and DESCRIPTOR_INVALID check) comes from
      // avatars.estimateCandidates, not the full avatars.estimate, which
      // would price the descriptor again.
      const fresh =
        refusedAvatarId !== null
          ? await client.request("avatars.estimateCandidates", { avatarId: refusedAvatarId })
          : await client.request("avatars.estimate", { traits });
      if (fresh.ok) {
        setEstimate(fresh.result);
        setPreviousWorst(accepted.worstMicros);
        setBusy(null);
        return;
      }
      setError(fresh.error);
    } else {
      setError(err);
    }
    setBusy(null);
  }

  /**
   * Optimistic cancel, done right (M-optimistic-cancel): the engine answers
   * avatars.cancel before the job actually ends (engine.ts's #runCandidates
   * settles it later, once the abort really lands) — accepting the command
   * must not by itself claim the job is cancelled. `store.markCancelling`
   * only records that this window is waiting; the real end — `job.cancelled`,
   * or the job no longer active in a fresh snapshot — is what flips its
   * status, wherever that end comes from (including M5's dead-engine
   * failure and a plain restart, which `markCancelling`'s own bookkeeping
   * already resolves on its own).
   */
  async function cancel(): Promise<void> {
    if (!job) return;
    setBusy("cancel");
    const reply = await client.request("avatars.cancel", { jobId: job.jobId });
    setBusy(null);
    if (reply.ok) {
      store.markCancelling(reply.result.jobId);
      candidatesHeading.current?.focus();
    } else setError(reply.error);
  }

  async function save(): Promise<void> {
    setShowNameIssue(true);
    if (avatarId === null || picked === null || nameIssue(name) !== null) return;
    setBusy("save");
    setSaveError(null);
    const reply = await client.request("avatars.pick", { avatarId, photoId: picked, name: name.trim() });
    setBusy(null);
    if (!reply.ok) {
      setSaveError(reply.error);
      return;
    }
    store.saveAvatar(reply.result.avatar);
    navigate({ name: "avatars", saved: reply.result.avatar.name });
  }

  // ---------- the estimate card's action ----------

  let action: EstimateAction | null = null;
  let blockedReason: string | null = null;
  if (estimate && !running) {
    const worst = formatUsd(estimate.worstMicros, 2, "up");
    const label =
      previousWorst !== null
        ? `Подтвердить новую цену · до ${worst}`
        : locked
          ? `Ещё 4 варианта · до ${worst}`
          : `Сгенерировать 4 варианта · до ${worst}`;
    if (stop?.kind === "offline") blockedReason = "Нет связи с движком — дождитесь, пока он снова ответит.";
    else if (!keyUsable) blockedReason = "Нужен рабочий ключ OpenRouter — добавьте его в Настройках.";
    else if (stop?.kind === "reconcile") blockedReason = "Платные запросы остановлены до сверки расходов.";
    else if (stop?.kind === "restart") blockedReason = restartStopText(stop.code);
    else if (problem !== null) blockedReason = problem;
    action = {
      label,
      onClick: () => void generate(estimate),
      disabled: busy !== null || blockedReason !== null,
      busy: busy === "generate",
    };
  }

  const nameProblem = nameIssue(name);
  const pickedLetter = pickedIndex >= 0 ? candidateLetter(pickedIndex) : null;

  /** DESCRIPTOR_INVALID points at its recovery: the Avatars grid's unreadable tiles, where «Переписать описание» lives. */
  function descriptorFix(source: EngineError | null): ReactNode {
    if (source?.code !== "DESCRIPTOR_INVALID") return undefined;
    return (
      <button type="button" className="btn btn-sm" onClick={() => navigate({ name: "avatars" })}>
        Переписать описание
      </button>
    );
  }

  /**
   * The estimate card's own error action. DESCRIPTOR_INVALID keeps pointing
   * at its recovery. Otherwise, once a draft exists with no estimate — the
   * batch price could not be fetched, so estimateBatch cleared it — the
   * only way back to a "Ещё 4 варианта" button is this retry: with no
   * estimate at all, there is nothing else on this card to click.
   */
  function estimateErrorActions(source: EngineError | null): ReactNode {
    const fix = descriptorFix(source);
    if (fix !== undefined) return fix;
    if (source === null || estimate !== null || !locked) return undefined;
    return (
      <button type="button" className="btn btn-sm" onClick={() => void retryBatchEstimate()} disabled={busy !== null} aria-busy={busy === "estimate"}>
        {busy === "estimate" ? "Считаем…" : "Повторить оценку"}
      </button>
    );
  }

  return (
    <div className="page page-wizard">
      <header className="page-head">
        <div>
          <button type="button" className="back-link" onClick={() => navigate({ name: "avatars" })}>
            <Icon name="back" size={14} strokeWidth={2.2} />
            Аватары
          </button>
          <ScreenTitle>Новый аватар</ScreenTitle>
        </div>
        <Stepper current={step} />
      </header>

      {offline ? <EngineOffline view={view} /> : <AccountBanner view={view} />}

      <div className="wizard">
        <section className="card wizard-form" aria-labelledby="traits-title">
          <div className="card-head">
            <h2 id="traits-title" className="card-kicker">
              Внешность
            </h2>
            {locked && <span className="pill pill-muted">зафиксирована в черновике</span>}
          </div>

          <TraitsForm traits={traits} onChange={changeTraits} vibeIssues={issues} locked={locked || busy === "generate"} />

          {!locked && (
            <div className="wizard-form-footer">
              <button type="button" className="btn" onClick={() => changeTraits(randomTraits())} disabled={busy !== null}>
                <Icon name="dice" size={16} strokeWidth={1.9} />
                Случайно
              </button>
              <button
                type="button"
                className={estimate ? "btn btn-grow" : "btn btn-primary btn-grow"}
                onClick={() => void estimateCost()}
                disabled={!traitsValid || busy !== null}
                aria-busy={busy === "estimate"}
              >
                {busy === "estimate" ? "Считаем…" : estimate ? "Оценить заново" : "Оценить стоимость"}
              </button>
            </div>
          )}
          {!locked && problem !== null && <p className="field-hint wizard-form-problem">{problem}</p>}
        </section>

        <div className="wizard-side">
          <EstimateCard
            estimate={estimate}
            previousWorst={previousWorst}
            estimating={busy === "estimate"}
            action={action}
            blockedReason={blockedReason}
            error={error}
            errorActions={estimateErrorActions(error)}
            repeat={locked}
          />

          <CandidatesCard
            candidates={candidates}
            job={job}
            picked={picked}
            onPick={setPicked}
            onCancel={() => void cancel()}
            cancelling={cancelling}
            headingRef={candidatesHeading}
          />

          {draft && (
            <section className="card descriptor-card" aria-labelledby="descriptor-title">
              <div className="card-head">
                <h2 id="descriptor-title" className="card-title">
                  Дескриптор
                </h2>
                <span className="muted">уходит в каждый промпт как якорь внешности</span>
              </div>
              <p className="descriptor-text mono" lang="en">
                {draft.descriptor.text}
              </p>
            </section>
          )}

          <section className="card save-card" aria-labelledby="save-title">
            <h2 id="save-title" className="sr-only">
              Сохранение
            </h2>
            <div className="field save-name">
              <label className="field-label" htmlFor={nameId}>
                Имя <span className="faint">· в промпты не уходит</span>
              </label>
              <input
                id={nameId}
                className="input"
                type="text"
                value={name}
                maxLength={80}
                autoComplete="off"
                placeholder="Mia"
                aria-invalid={showNameIssue && nameProblem !== null}
                aria-describedby={showNameIssue && nameProblem ? nameErrorId : undefined}
                onChange={(e) => setName(e.currentTarget.value)}
                onBlur={() => name !== "" && setShowNameIssue(true)}
              />
              {showNameIssue && nameProblem && (
                <p id={nameErrorId} className="field-error" role="alert">
                  {nameProblem}
                </p>
              )}
            </div>
            <div className="save-action">
              <button
                type="button"
                className="btn btn-primary"
                disabled={picked === null || busy !== null || running}
                onClick={() => void save()}
                aria-busy={busy === "save"}
              >
                {busy === "save" ? "Сохраняем…" : "Сохранить"}
              </button>
              <p className="field-hint">
                {running
                  ? "Дождитесь конца генерации, чтобы сохранить."
                  : pickedLetter
                    ? `Мастер-портрет — вариант ${pickedLetter}.`
                    : "Сначала выберите вариант."}
              </p>
            </div>
            {saveError && <ErrorNotice error={saveError} actions={descriptorFix(saveError)} />}
          </section>
        </div>
      </div>
    </div>
  );
}
