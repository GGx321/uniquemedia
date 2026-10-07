import { type ReactNode, useId, useRef } from "react";
import type { SceneInterruptedIdea, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { EngineView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { Icon } from "../../ui/Icon";
import { describedBy, InlinePaidButton, paidButtonState, PriceFailed, setPriceKey } from "./scenePaid";
import { emptySceneIds, interruptedRewrites, otherSceneTargets, tallyScenes, writeCapRefusal } from "./sceneReview";
import { emptyButton, gaveUpNotice, ideaNotice, otherScenesButton, type ReserveState, rewriteNotice, stoppedNotice, WRITE_CAP_TEXT } from "./sceneText";
import { usePaidAction } from "./usePaidAction";

// CS.6: the «Сцены» column's notices (README decision 18: a failed or interrupted paid write is shown in ONE place, here, and its card's marker). A
// compose or «Дописать» that stopped; a compose that ended with scenes given up on («Готово 35 из 60 · 25 не составлены»); a rewrite cut short (per write,
// each scene marked); an idea write cut short. Each says why (`stoppedBy`) and what the request still holds (open reserve, or closed by a reconcile this
// window saw), and offers the way on: «Повторить» at the attempts left, «Другие сцены для N», «Убрать N пустых», «Оставить как есть» / «Не нужно».

/** What a notice does to the set: the column runs it (a free edit) or opens the idea form. */
export interface NoticeHandlers {
  readonly onRemoveEmpty: (sceneIds: readonly number[]) => void;
  readonly onDismissScenes: (sceneIds: readonly number[]) => void;
  readonly onDismissWrite: (write: number) => void;
  readonly onOpenIdea: (idea: SceneInterruptedIdea) => void;
  readonly onCloseGaveUp: () => void;
  /** A paid write the notice started: the job's «Отменить» takes the focus. */
  readonly onStarted: () => void;
}

interface Common {
  set: SceneSetView;
  view: EngineView;
  blocked: string | null;
  onPaidInFlightChange: (inFlight: boolean) => void;
}

function WarnNotice({ title, text, role, children, onClose }: { title: string; text: string; role: "alert" | "status"; children?: ReactNode; onClose?: () => void }) {
  return (
    <div className="notice notice-warn scene-notice" role={role}>
      <span className="notice-icon">
        <Icon name="alert" size={16} />
      </span>
      <div className="notice-body scene-notice-body">
        <p className="notice-title">{title}</p>
        <div className="notice-text">{text}</div>
        {children}
      </div>
      {onClose !== undefined && (
        <button type="button" className="ibtn ibtn-s scene-notice-close" aria-label="Скрыть плашку — счётчик в шапке колонки останется" onClick={onClose}>
          <Icon name="close" size={12} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}

/** «Другие сцены для N»: one rewrite with a redraw for the first five given up on. */
function OtherScenesButton({ set, view, blocked, onPaidInFlightChange, onStarted }: Common & { onStarted: () => void }) {
  const { client, store, sceneSets } = useEngine();
  const priceId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const ids = otherSceneTargets(set);
  const target = { kind: "rewrite" as const, sceneIds: ids, redraw: true };
  const action = usePaidAction({
    key: ids.length === 0 ? null : `others|${ids.join(",")}|${setPriceKey(set, view)}`,
    price: () => client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target }),
    send: (acceptedWorstMicros) => client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      store.trackScenesJob(result.jobId, set.sceneSetId, set.avatarId, ids.length);
      sceneSets.trackJob(result.jobId, { sceneSetId: set.sceneSetId, kind: "rewrite", price: accepted, sceneIds: ids, idea: null });
      onStarted();
    },
    onPaidInFlightChange,
  });
  if (ids.length === 0) return null;
  return (
    <>
      <InlinePaidButton
        buttonRef={button}
        state={paidButtonState(action, otherScenesButton(ids.length), blocked !== null)}
        primary={false}
        describedBy={describedBy(action.priceError !== null && priceId)}
        onClick={action.click}
      />
      {action.error !== null && <span className="scene-pop-error">{writeCapRefusal(action.error) ? WRITE_CAP_TEXT : errorText(action.error)}</span>}
      {action.priceError !== null && <PriceFailed id={priceId} error={action.priceError} onRetry={action.retryPrice} after={() => button.current} />}
    </>
  );
}

/** «Повторить»: the interrupted write carried on, at the attempts it has left. `stuck` says why it cannot be (a removed scene). */
function ResumeButton({ set, view, blocked, onPaidInFlightChange, write, scenes, kind, idea, stuck, onStarted, why }: Common & {
  write: number;
  scenes: readonly number[];
  kind: "rewrite" | "idea";
  idea: SceneInterruptedIdea | null;
  stuck: boolean;
  onStarted: () => void;
  /** The notice's reason line, when paid calls wait. */
  why: string | undefined;
}) {
  const { client, store, sceneSets } = useEngine();
  const priceId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const target = { kind: "resume" as const, write };
  const action = usePaidAction({
    key: stuck ? null : `resume|${write}|${setPriceKey(set, view)}`,
    price: () => client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target }),
    send: (acceptedWorstMicros) => client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      store.trackScenesJob(result.jobId, set.sceneSetId, set.avatarId, kind === "idea" ? (idea?.count ?? 1) : scenes.length);
      sceneSets.trackJob(result.jobId, {
        sceneSetId: set.sceneSetId,
        kind,
        price: accepted,
        sceneIds: kind === "rewrite" ? scenes : null,
        idea: idea === null ? null : { idea: idea.idea, count: idea.count, shot: idea.shot },
      });
      onStarted();
    },
    onPaidInFlightChange,
  });
  const state = paidButtonState(action, "Повторить", stuck || blocked !== null);
  return (
    <>
      <InlinePaidButton
        buttonRef={button}
        state={stuck ? { ...state, price: null } : state}
        primary={false}
        describedBy={describedBy(why, action.priceError !== null && priceId)}
        onClick={action.click}
      />
      {action.error !== null && <span className="scene-pop-error">{writeCapRefusal(action.error) ? WRITE_CAP_TEXT : errorText(action.error)}</span>}
      {action.priceError !== null && <PriceFailed id={priceId} error={action.priceError} onRetry={action.retryPrice} after={() => button.current} />}
    </>
  );
}

/** The reserve a stop left, as this window knows it (sceneText's `ReserveState`). */
function reserveState(set: SceneSetView, reconciled: number | null): ReserveState {
  if (set.openReserveMicros !== null && set.openReserveMicros > 0) return "open";
  return reconciled !== null ? "reconciled" : "none";
}

interface SceneNoticesProps extends Common, NoticeHandlers {
  /** The open reserve this window saw a reconcile close for this set (null: it saw none). */
  reconciled: number | null;
  gaveUpDismissed: boolean;
  /** A write of the set runs: the notices' actions wait. */
  live: boolean;
}

export function SceneNotices(props: SceneNoticesProps) {
  const { set, blocked, reconciled, gaveUpDismissed, live, onRemoveEmpty, onDismissScenes, onDismissWrite, onOpenIdea, onCloseGaveUp, onStarted } = props;
  const ids = useId();
  const tally = tallyScenes(set.scenes);
  const empty = emptySceneIds(set);
  const reserve = reserveState(set, reconciled);
  const paidBlocked = blocked ?? (live ? "Дождитесь, пока модель допишет." : null);
  const common = { set, view: props.view, blocked: paidBlocked, onPaidInFlightChange: props.onPaidInFlightChange };
  const notices: ReactNode[] = [];

  // A compose or «Дописать» that stopped with scenes still waiting.
  if (set.status === "stopped" && tally.pending > 0) {
    const { title, text } = stoppedNotice(set, reconciled);
    const role = set.stoppedBy === "closed" && reserve !== "open" ? "status" : "alert";
    notices.push(
      <WarnNotice key="stopped" title={title} text={text} role={role}>
        <div className="notice-actions">
          <button type="button" className="btn btn-s" disabled={live} onClick={() => onRemoveEmpty(empty)}>
            {emptyButton(empty.length)}
          </button>
          {tally.gaveUp > 0 && <OtherScenesButton {...common} onStarted={onStarted} />}
        </div>
      </WarnNotice>,
    );
  }

  // A compose that ended with whole requests given up on.
  if (set.status !== "stopped" && tally.gaveUp > 0 && set.lastCompose !== null && set.lastCompose.gaveUp > 0 && !gaveUpDismissed) {
    const { title, text } = gaveUpNotice(set);
    notices.push(
      <WarnNotice key="gave-up" title={title} text={text} role="status" onClose={onCloseGaveUp}>
        <div className="notice-actions">
          <button type="button" className="btn btn-s" disabled={live} onClick={() => onRemoveEmpty(empty)}>
            {emptyButton(empty.length)}
          </button>
          <OtherScenesButton {...common} onStarted={onStarted} />
        </div>
      </WarnNotice>,
    );
  }

  // Rewrites cut short, one notice per write (scenes all removed: nothing to carry on, nothing said).
  for (const group of interruptedRewrites(set)) {
    if (group.removed.length === group.sceneIds.length) continue;
    const origin = set.scenes.find((s) => s.sceneId === group.sceneIds[0])?.origin ?? "planned";
    const { title, text } = rewriteNotice(group, origin, reserve);
    const why = `${ids}-rw-${group.write}`;
    const stuck = group.removed.length > 0;
    notices.push(
      <WarnNotice key={`rw-${group.write}`} title={title} text={text} role={group.stoppedBy === "closed" && reserve === "reconciled" ? "status" : "alert"}>
        <div className="notice-actions">
          <ResumeButton {...common} write={group.write} scenes={group.sceneIds} kind="rewrite" idea={null} stuck={stuck} onStarted={onStarted} why={paidBlocked !== null ? why : undefined} />
          <button type="button" className="btn btn-s" disabled={live} onClick={() => onDismissScenes(group.sceneIds)}>
            Оставить как есть
          </button>
        </div>
        {paidBlocked !== null && !stuck && (
          <p id={why} className="faint scene-notice-why">
            {paidBlocked}
          </p>
        )}
      </WarnNotice>,
    );
  }

  // Idea writes cut short.
  for (const idea of set.interruptedIdeas ?? []) {
    const { title, text } = ideaNotice(idea, reserve);
    const why = `${ids}-idea-${idea.write}`;
    notices.push(
      <WarnNotice key={`idea-${idea.write}`} title={title} text={text} role="alert">
        <div className="notice-actions">
          <ResumeButton {...common} write={idea.write} scenes={[]} kind="idea" idea={idea} stuck={false} onStarted={onStarted} why={paidBlocked !== null ? why : undefined} />
          <button type="button" className="btn btn-s" disabled={live} onClick={() => onOpenIdea(idea)}>
            Открыть идею
          </button>
          <button type="button" className="btn btn-s" disabled={live} onClick={() => onDismissWrite(idea.write)}>
            Не нужно
          </button>
        </div>
        {paidBlocked !== null && (
          <p id={why} className="faint scene-notice-why">
            {paidBlocked}
          </p>
        )}
      </WarnNotice>,
    );
  }

  return notices.length === 0 ? null : <div className="scene-notices">{notices}</div>;
}
