import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import type { SceneSetView, SceneView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { EngineView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { paidStop } from "../../lib/paidStop";
import { useNavigate } from "../../navigation";
import { about, describedBy, InlinePaidButton, paidButtonState, PriceFailed, setPriceKey } from "./scenePaid";
import { sceneCategoryLabel, writeCapRefusal } from "./sceneReview";
import { interruptedChoiceText, ownRewriteText, redrawGoneText, redrawText, WRITE_CAP_TEXT, writeCapLine } from "./sceneText";
import { usePaidAction } from "./usePaidAction";

// CS.6: the ⟳ price popover (README decisions 10, 16, 18; ReviewStates C). Only for the moment before a send: what ⟳ does, its price, «Заменить» —
// disabled with the reason and a way out when paid calls are stopped. A planned scene gets «Другая сцена» (a redraw: a new place, outfit, action and time of
// day from its category, owner decision 3); an own scene «Переписать» (from its stored idea, shot and pose kept). A scene whose earlier rewrite was cut off
// offers both «Повторить» (that write, at the attempts it has left) and a new one. Opens with the focus on «Отмена»; Tab stays inside; Escape closes it.

interface ScenePopoverProps {
  set: SceneSetView;
  scene: SceneView;
  view: EngineView;
  /** Why no paid call may go now (the screen's own reasons on top of paidBlockedReason), or null. */
  blocked: string | null;
  onPaidInFlightChange: (inFlight: boolean) => void;
  /** Closed without a send: the focus goes back to the card's ⟳. */
  onClose: () => void;
  /** A write started: its job runs; the column puts the focus on the job's «Отменить». */
  onStarted: () => void;
}

export function ScenePopover({ set, scene, view, blocked, onPaidInFlightChange, onClose, onStarted }: ScenePopoverProps) {
  const { client, store, sceneSets } = useEngine();
  const navigate = useNavigate();
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  /** Which button's price «Повторить» asked again: the focus goes there once it comes. */
  const retried = useRef<"replace" | "resume">("replace");
  const own = scene.origin === "own";
  const key = setPriceKey(set, view);
  const target = { kind: "rewrite" as const, sceneIds: [scene.sceneId], redraw: !own };
  const marker = scene.rewriteInterrupted;

  const replace = usePaidAction({
    key: `rewrite|${scene.sceneId}|${key}`,
    price: () => client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target }),
    send: (acceptedWorstMicros) => client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      store.trackScenesJob(result.jobId, set.sceneSetId, set.avatarId, 1);
      sceneSets.trackJob(result.jobId, { sceneSetId: set.sceneSetId, kind: "rewrite", price: accepted, sceneIds: [scene.sceneId], idea: null });
      onStarted();
    },
    onPaidInFlightChange,
  });
  const resume = usePaidAction({
    key: marker === undefined ? null : `resume|${marker.write}|${key}`,
    price: () => client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target: { kind: "resume", write: marker?.write ?? 1 } }),
    send: (acceptedWorstMicros) =>
      client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "resume", write: marker?.write ?? 1 }, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      store.trackScenesJob(result.jobId, set.sceneSetId, set.avatarId, 1);
      sceneSets.trackJob(result.jobId, { sceneSetId: set.sceneSetId, kind: "rewrite", price: accepted, sceneIds: [scene.sceneId], idea: null });
      onStarted();
    },
    onPaidInFlightChange,
  });

  const gone = replace.priceError?.code === "NOT_FOUND" && !own;
  // Opens with the focus on «Отмена»; a redraw refused (its category is gone) turns it into «Понятно», which takes the focus instead.
  useEffect(() => {
    cancel.current?.focus();
  }, [gone]);
  const sending = replace.sending || resume.sending;
  const stopped = blocked;

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!sending) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const titleId = `${ids}-title`;
  const whyId = `${ids}-why`;
  const label = sceneCategoryLabel(scene);
  const stop = paidStop(view);
  const settingsLink =
    stopped === null ? null : stop?.kind === "reconcile" ? (
      <button type="button" className="link-btn" onClick={() => navigate({ name: "settings", focus: "money" })}>
        Перейти к сверке
      </button>
    ) : view.settings !== null && (!view.settings.apiKey.stored || view.settings.apiKey.rejected) ? (
      <button type="button" className="link-btn" onClick={() => navigate({ name: "settings", focus: "key" })}>
        Открыть Настройки
      </button>
    ) : null;
  const refused = replace.error ?? resume.error;

  if (gone) {
    return (
      <div ref={root} className="pop scene-pop" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
        <span className="pop-arrow" aria-hidden="true" />
        <b id={titleId} className="scene-pop-title">
          Другая сцена недоступна
        </b>
        <p className="scene-pop-text">{redrawGoneText(label)}</p>
        <div className="scene-pop-actions">
          <button ref={cancel} type="button" className="btn btn-s" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    );
  }

  const replaceState = paidButtonState(replace, own ? "Переписать" : "Заменить", stopped !== null);
  const resumeState = paidButtonState(resume, "Повторить", stopped !== null);
  const offline = stop?.kind === "offline";
  // M2: a price that could not be had (not a deleted category's, said above): why, and «Повторить» for the one(s) it failed for.
  const priceFailed = replace.priceError ?? resume.priceError;
  const priceId = `${ids}-price`;
  const replaceWhy = describedBy(stopped !== null && whyId, replace.priceError !== null && priceId);
  const resumeWhy = describedBy(stopped !== null && whyId, resume.priceError !== null && priceId);

  return (
    <div ref={root} className="pop scene-pop" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
      <span className="pop-arrow" aria-hidden="true" />
      <div className="scene-pop-head">
        <b id={titleId} className="scene-pop-title">
          {own ? "Переписать сцену" : "Другая сцена"}
        </b>
        {!offline && replace.estimate !== null && <span className="mono muted">{about(replace.estimate.expectedMicros)}</span>}
      </div>
      <p className="scene-pop-text">{own ? ownRewriteText(scene.idea ?? "") : redrawText(label, scene.sceneId)}</p>
      {marker !== undefined && <p className="scene-pop-text scene-pop-marker">{interruptedChoiceText(scene.origin)}</p>}
      {!offline && replace.estimate !== null && <p className="mono faint scene-pop-cap">{writeCapLine(replace.estimate.worstMicros)}</p>}
      {replace.previousWorst !== null && <p className="scene-pop-warn">Цена выросла — подтвердите новую.</p>}
      <div className="scene-pop-actions">
        <button ref={cancel} type="button" className="btn btn-s" disabled={sending} onClick={onClose}>
          Отмена
        </button>
        {marker !== undefined && (
          <InlinePaidButton buttonRef={resumeRef} state={offline ? { ...resumeState, price: null } : resumeState} primary={false} describedBy={resumeWhy} onClick={resume.click} />
        )}
        <InlinePaidButton buttonRef={replaceRef} state={offline ? { ...replaceState, price: null } : replaceState} describedBy={replaceWhy} onClick={replace.click} />
      </div>
      {stopped !== null && (
        <p id={whyId} className="faint scene-pop-why">
          {stopped} {settingsLink}
        </p>
      )}
      {priceFailed !== null && (
        <PriceFailed
          id={priceId}
          error={priceFailed}
          onRetry={() => {
            retried.current = replace.priceError !== null ? "replace" : "resume";
            if (replace.priceError !== null) replace.retryPrice();
            if (resume.priceError !== null) resume.retryPrice();
          }}
          after={() => (retried.current === "resume" ? resumeRef.current : replaceRef.current)}
        />
      )}
      {refused !== null && <p className="scene-pop-error">{writeCapRefusal(refused) ? WRITE_CAP_TEXT : errorText(refused)}</p>}
    </div>
  );
}
