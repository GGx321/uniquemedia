import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { MAX_SCENES_PER_WRITE, POOL_SHOTS, SCENE_IDEA_MAX, SceneIdeaInput, type EngineError, type PoolShot, type SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { EngineView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { formatUsdTiered } from "../../lib/money";
import { Icon } from "../../ui/Icon";
import { about, describedBy, InlinePaidButton, paidButtonState, PriceFailed, setPriceKey } from "./scenePaid";
import { SHOT_LABEL, writeCapRefusal } from "./sceneReview";
import { ideaHint, ideaTitle, WRITE_CAP_TEXT } from "./sceneText";
import { usePaidAction } from "./usePaidAction";

// CS.6: «+ Своя сцена» — the one mode, «по описанию» (owner decision 2, 2026-10-07; ReviewAddIdea, ReviewStates D): an idea in any language (1–500), how many
// scenes (1–5) and a shot (CS.8: «Авто» lets the model pick the shot and the angle from the idea, the mirror only when the idea names one; the hint under the
// row follows the shot); the model writes the English sentences, one paid request. Opens with the focus in «Идея»; Escape
// closes it and the focus goes back to «+ Своя сцена». A write that failed for good (the provider refused the idea, or two answers were rejected) opens it
// again with the idea, saying why.

export interface IdeaStart {
  readonly idea: string;
  readonly count: number;
  readonly shot: PoolShot | null;
  /** The write that failed with this idea, said inside the form. */
  readonly failure: { readonly error: EngineError; readonly spentMicros: number | null } | null;
}

export const EMPTY_IDEA: IdeaStart = { idea: "", count: 1, shot: null, failure: null };

/** Any idea the price can be asked with: the price of an idea write is its count and the text model, never the idea itself (sceneSets/estimate.ts). */
const PRICE_IDEA = "idea";

interface SceneIdeaFormProps {
  set: SceneSetView;
  view: EngineView;
  start: IdeaStart;
  blocked: string | null;
  onPaidInFlightChange: (inFlight: boolean) => void;
  onClose: () => void;
  /** The write started: its placeholders are drawn, the focus goes to the first one. */
  onStarted: () => void;
}

function failureText(failure: NonNullable<IdeaStart["failure"]>): { line: string; detail: string | null } {
  const spent = failure.spentMicros === null ? null : `потрачено ${formatUsdTiered(failure.spentMicros, "nearest")}`;
  if (failure.error.code === "MODERATION_REFUSED") return { line: "Модель отказалась писать по этой идее — переформулируйте её.", detail: ["MODERATION_REFUSED", spent].filter(Boolean).join(" · ") };
  if (failure.error.code === "INTERNAL") return { line: "Модель дважды вернула неподходящий текст — переформулируйте идею.", detail: spent };
  return { line: errorText(failure.error), detail: spent };
}

export function SceneIdeaForm({ set, view, start, blocked, onPaidInFlightChange, onClose, onStarted }: SceneIdeaFormProps) {
  const { client, store, sceneSets } = useEngine();
  const ids = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const writeRef = useRef<HTMLButtonElement>(null);
  const [idea, setIdea] = useState(start.idea);
  const [count, setCount] = useState(start.count);
  const [shot, setShot] = useState<PoolShot | null>(start.shot);
  useEffect(() => {
    field.current?.focus();
  }, []);

  const parsed = SceneIdeaInput.safeParse(idea);
  const valid = parsed.success;
  const blank = idea.trim().length === 0;
  const target = { kind: "idea" as const, idea: idea.trim(), count, shot };
  const write = usePaidAction({
    key: `idea|${count}|${setPriceKey(set, view)}`,
    price: () => client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target: { kind: "idea", idea: valid ? idea.trim() : PRICE_IDEA, count, shot } }),
    send: (acceptedWorstMicros) => client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      store.trackScenesJob(result.jobId, set.sceneSetId, set.avatarId, count);
      sceneSets.trackJob(result.jobId, { sceneSetId: set.sceneSetId, kind: "idea", price: accepted, sceneIds: null, idea: { idea: target.idea, count, shot } });
      onStarted();
    },
    onPaidInFlightChange,
  });
  const invalid = blank ? "Опишите идею." : !valid ? "Уберите из идеи служебные символы." : null;
  const state = paidButtonState(write, ideaTitle(count), blocked !== null || invalid !== null);
  const failure = start.failure !== null && idea === start.idea ? failureText(start.failure) : null;

  function onKey(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || write.sending) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  const titleId = `${ids}-title`;
  const ideaId = `${ids}-idea`;
  const hintId = `${ids}-hint`;
  const countId = `${ids}-count`;
  const shotId = `${ids}-shot`;
  const whyId = `${ids}-why`;
  const invalidId = `${ids}-invalid`;
  const priceId = `${ids}-price`;

  return (
    <section className="card scene-idea-form" aria-labelledby={titleId} onKeyDown={onKey}>
      <div className="scene-idea-head">
        <h3 id={titleId} className="scene-idea-title">
          Своя сцена <span className="faint">· по описанию</span>
        </h3>
        <button type="button" className="ibtn ibtn-s" aria-label="Закрыть" disabled={write.sending} onClick={onClose}>
          <Icon name="close" size={12} strokeWidth={2.4} />
        </button>
      </div>
      <div className="scene-idea-field">
        <div className="field-row">
          <label className="fl" htmlFor={ideaId}>
            Идея <span className="faint">· на любом языке</span>
          </label>
          <span className="mono faint">
            {idea.length}/{SCENE_IDEA_MAX}
          </span>
        </div>
        <textarea
          ref={field}
          id={ideaId}
          className={invalid !== null ? "in scene-ta scene-idea-ta scene-edit-bad" : "in scene-ta scene-idea-ta"}
          rows={3}
          maxLength={SCENE_IDEA_MAX}
          placeholder="Например: пикник в парке осенью, плед и термос"
          aria-invalid={invalid !== null}
          aria-describedby={[invalid !== null ? invalidId : null, hintId].filter(Boolean).join(" ")}
          value={idea}
          disabled={write.sending}
          onChange={(e) => setIdea(e.target.value)}
        />
        {invalid !== null && (
          <p id={invalidId} className="scene-idea-invalid">
            {invalid}
          </p>
        )}
      </div>
      <div className="scene-idea-row">
        <div className="scene-idea-count">
          <span className="fl" id={countId}>
            Сколько
          </span>
          <div className="scene-idea-stepper" role="group" aria-labelledby={countId}>
            <button type="button" className="ibtn ibtn-s" aria-label="Меньше" disabled={count <= 1 || write.sending} onClick={() => setCount((c) => Math.max(1, c - 1))}>
              <Icon name="minus" size={12} strokeWidth={2.4} />
            </button>
            <output className="mono scene-idea-n" aria-live="polite" aria-labelledby={countId}>
              {count}
            </output>
            <button type="button" className="ibtn ibtn-s" aria-label="Больше" disabled={count >= MAX_SCENES_PER_WRITE || write.sending} onClick={() => setCount((c) => Math.min(MAX_SCENES_PER_WRITE, c + 1))}>
              <Icon name="plus" size={12} strokeWidth={2.4} />
            </button>
          </div>
          <span className="mono faint scene-idea-range">1–{MAX_SCENES_PER_WRITE}</span>
        </div>
        <div className="scene-idea-shot">
          <label className="fl" htmlFor={shotId}>
            Кадр
          </label>
          <span className={shot === null ? "chip ed-chip-select" : "chip chip-on ed-chip-select"}>
            <select
              id={shotId}
              value={shot ?? ""}
              disabled={write.sending}
              aria-describedby={hintId}
              onChange={(e) => setShot(POOL_SHOTS.find((s) => s === e.target.value) ?? null)}
            >
              {/* CS.7 V3: «Авто» alone keeps «Кадр» in the form's row at 1200; what it picks (shot and angle, the mirror only when the idea names one) is said in the hint below. */}
              <option value="">Авто</option>
              {POOL_SHOTS.map((s) => (
                <option key={s} value={s}>
                  {SHOT_LABEL[s]}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} strokeWidth={2.4} />
          </span>
        </div>
      </div>
      <p id={hintId} className="faint scene-idea-hint">
        {ideaHint(shot)}
      </p>
      {failure !== null && (
        <div className="notice notice-danger scene-idea-failure" role="alert">
          <span className="notice-icon">
            <Icon name="alert" size={16} />
          </span>
          <div className="notice-body">
            <div className="notice-text">{failure.line}</div>
            {failure.detail !== null && <p className="mono faint scene-idea-failure-detail">{failure.detail}</p>}
          </div>
        </div>
      )}
      {write.error !== null && <p className="scene-pop-error">{writeCapRefusal(write.error) ? WRITE_CAP_TEXT : errorText(write.error)}</p>}
      <div className="scene-idea-foot">
        <span className="mono muted scene-idea-price">{write.estimate !== null ? about(write.estimate.expectedMicros) : "≈ …"}</span>
        <button type="button" className="btn btn-s" disabled={write.sending} onClick={onClose}>
          Отмена
        </button>
        <InlinePaidButton buttonRef={writeRef} state={state} describedBy={describedBy(blocked !== null && whyId, write.priceError !== null && priceId)} onClick={write.click} />
      </div>
      {blocked !== null && (
        <p id={whyId} className="faint scene-idea-why">
          {blocked}
        </p>
      )}
      {write.priceError !== null && <PriceFailed id={priceId} error={write.priceError} onRetry={write.retryPrice} after={() => writeRef.current} />}
    </section>
  );
}
