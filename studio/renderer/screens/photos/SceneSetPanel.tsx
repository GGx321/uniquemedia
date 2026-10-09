import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AvatarSummary, EngineError, SceneEditOp, SceneInterruptedIdea, SceneProblem, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { SceneSetSliceView } from "../../engine/sceneSetSlice";
import type { EngineView, JobView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { paidBlockedReason } from "./runForm";
import { SceneCard, ScenePlaceholder, type SceneWriting } from "./SceneCard";
import { type IdeaStart, SceneIdeaForm } from "./SceneIdeaForm";
import { SceneNotices } from "./SceneNotices";
import { launchWriteHint } from "./launchSet";
import { focusLost } from "./scenePaid";
import { ScenePopover } from "./ScenePopover";
import { placeholderIds } from "./sceneReview";
import { CANCEL_HINT, CANCELLING_NOTE, EMPTY_SET_LINE, progressLabel, progressNote, SCENES_CHANGED_EDIT } from "./sceneText";
import { useMounted } from "./shared";

// CS.6: the «Сцены» column's set (ReviewReady, ReviewEdit, ReviewRewriting, ReviewAddIdea, ReviewIdeaWriting, ReviewStopped…, ReviewGaveUp,
// ReviewRewriteInterrupted, ReviewEmpty, ReviewUsed): the job that writes it with its cancel, the column notices, the «по описанию» form, and the scenes.
// Every free edit carries the revision it was made on (SCENES_CHANGED when it moved: told, and the set read again). While a write of the set runs, every
// action of it waits (the engine refuses them, IN_FLIGHT).

/** Puts the focus on a scene's card (a reason's or a counter's link), scrolled into view (README «Keyboard and focus»). */
export function focusSceneCard(sceneId: number): void {
  const card = document.querySelector<HTMLElement>(`[data-scene="${sceneId}"], [data-placeholder="${sceneId}"]`);
  if (card === null) return;
  card.scrollIntoView?.({ block: "nearest" });
  card.focus();
}

interface SceneSetPanelProps {
  avatar: AvatarSummary;
  view: EngineView;
  set: SceneSetView;
  sliceView: SceneSetSliceView;
  scenesJob: JobView | null;
  runActive: boolean;
  /** The used set's run, when the set is used: its job and when it began (the run's own `createdAt`). */
  runCreatedAt: string | null;
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  /** «+ Своя сцена» in the column's header: open, and how it asks to be opened again (a failed idea write, «Открыть идею»). */
  idea: IdeaStart | null;
  onIdea: (start: IdeaStart | null) => void;
  /** The column's title and its «+ Своя сцена»: where the focus goes after some actions. */
  titleRef: RefObject<HTMLElement | null>;
  addRef: RefObject<HTMLButtonElement | null>;
  counterRef: RefObject<HTMLButtonElement | null>;
  /** S4.9b: the set is an unfinished launch's: a write of it is the launch's own («в запуске автопилота» instead of «Отменить»). */
  inLaunch?: boolean;
  /** S4.9b: the launch took the set (approved, or drawing): read only, with this note; null while it can still be edited. */
  frozenNote?: string | null;
}

/** The pencil's edit: the revision and the scene's text it was opened on — the save is made on those, never on what the set is by then. */
type Edit = { readonly sceneId: number; readonly revision: number; readonly text: string | null; readonly problem: SceneProblem | null; readonly problemFor: string | null; readonly busy: boolean };

export function SceneSetPanel({
  avatar,
  view,
  set,
  sliceView,
  scenesJob,
  runActive,
  runCreatedAt,
  paidInFlight,
  onPaidInFlightChange,
  idea,
  onIdea,
  titleRef,
  addRef,
  counterRef,
  inLaunch = false,
  frozenNote = null,
}: SceneSetPanelProps) {
  const { client, store, sceneSets } = useEngine();
  const mounted = useMounted();
  const [editing, setEditing] = useState<Edit | null>(null);
  const [popover, setPopover] = useState<number | null>(null);
  const [editError, setEditError] = useState<EngineError | "changed" | null>(null);
  const [jobFailure, setJobFailure] = useState<{ jobId: string; error: EngineError; sceneIds: readonly number[] } | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<EngineError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const editSending = useRef(false);
  // A launch's set it has taken reads as a used one: nothing on it can change any more (§3.4, the frozen list).
  const used = set.status === "used" || frozenNote !== null;
  const live = set.write !== null;
  const write = set.write;

  // ---------- the focus, moved after the screen shows the change ----------

  // A target the focus waits for: it moves once the element is on the page (a job's «Отменить» appears with the job's first event). `ifLost` (a job's end,
  // CS.7 M4) moves it only from where the job left it: its «Отменить» — waited for while still on show, the set not yet saying the write ended — or
  // nowhere; a focus the owner put elsewhere meanwhile stays there.
  const [focusNext, setFocusNext] = useState<{ target: () => HTMLElement | null; ifLost?: boolean } | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    if (focusNext.ifLost === true) {
      if (cancelRef.current !== null && document.activeElement === cancelRef.current) return;
      if (!focusLost()) {
        setFocusNext(null);
        return;
      }
    }
    const el = focusNext.target();
    if (el === null) return;
    el.focus();
    setFocusNext(null);
  });
  const focusLater = (target: () => HTMLElement | null): void => setFocusNext({ target });
  /** The set as last drawn, for a target chosen once the set says what a job made. */
  const latestSet = useRef(set);
  useLayoutEffect(() => {
    latestSet.current = set;
  });
  const sceneButton = (label: string): (() => HTMLElement | null) => () => document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  const toCancel = (): void => focusLater(() => cancelRef.current);

  // «Составить» or «Дописать» of the generate card started a job of this set: its «Отменить» is here, and takes the focus once it is on the page.
  useEffect(() => {
    for (const jobId of sliceView.cancelFocus) {
      if (sliceView.jobs.get(jobId)?.sceneSetId !== set.sceneSetId) continue;
      sceneSets.cancelFocusTaken(jobId);
      toCancel();
    }
  });

  // ---------- the ends of this window's jobs, seen while the screen shows them ----------

  const seen = useRef(new Map<string, JobView["status"]>());
  /** The set's last scene id when each idea write was first seen running: its new scenes come after it. */
  const lastIdAtStart = useRef(new Map<string, number>());
  /** The scenes waiting for their text when each «Дописать» was first seen running: the ones it writes. */
  const waitingAtStart = useRef(new Map<string, readonly number[]>());
  useEffect(() => {
    for (const [jobId, note] of sliceView.jobs) {
      if (note.sceneSetId !== set.sceneSetId) continue;
      const job = view.jobs.find((j) => j.jobId === jobId);
      if (job === undefined) continue;
      const before = seen.current.get(jobId);
      seen.current.set(jobId, job.status);
      if (before === undefined && (job.status === "queued" || job.status === "running")) {
        lastIdAtStart.current.set(jobId, set.scenes.reduce((max, s) => Math.max(max, s.sceneId), 0));
        waitingAtStart.current.set(jobId, set.scenes.filter((s) => !s.removed && s.unwritten === "pending").map((s) => s.sceneId));
      }
      if (before === undefined || before === job.status || (before !== "queued" && before !== "running")) continue;
      if (note.kind === "idea") {
        if (job.status === "done") focusLater(() => firstNewScene(latestSet.current, lastIdAtStart.current.get(jobId) ?? 0));
        else if (job.status === "failed" && job.error !== null && (job.error.code === "MODERATION_REFUSED" || job.error.code === "INTERNAL") && note.idea !== null) {
          onIdea({ idea: note.idea.idea, count: note.idea.count, shot: note.idea.shot, failure: { error: job.error, spentMicros: job.error.spentMicros ?? null } });
        } else if (job.status === "cancelled") focusLater(() => addRef.current);
        else focusLater(() => document.querySelector<HTMLElement>(".scene-notices button"));
        continue;
      }
      if (note.kind === "rewrite" && job.status === "failed" && job.error !== null && (job.error.code === "MODERATION_REFUSED" || job.error.code === "INTERNAL")) {
        setJobFailure({ jobId, error: job.error, sceneIds: note.sceneIds ?? [] });
      }
      // CS.7 M4: the job's «Отменить» goes with it — the focus goes to what it made (README «Keyboard and focus»), chosen once the set says the write
      // ended: a compose or «Дописать» done → the first scene it wrote; ⟳, «Повторить», «Другие сцены для N» → the first scene they were for (its card
      // says how it went); a compose or «Дописать» that wrote nothing → the column title, over the notice that says why.
      const done = job.status === "done";
      const waited = waitingAtStart.current.get(jobId) ?? [];
      setFocusNext({
        ifLost: true,
        target: () => {
          const now = latestSet.current;
          if (now.write !== null) return null;
          const written = (id: number): boolean => now.scenes.some((s) => s.sceneId === id && !s.removed && s.text !== null);
          const first =
            note.kind === "rewrite"
              ? (note.sceneIds ?? []).find((id) => now.scenes.some((s) => s.sceneId === id && !s.removed))
              : !done
                ? undefined
                : note.kind === "unwritten"
                  ? waited.find(written)
                  : now.scenes.find((s) => written(s.sceneId))?.sceneId;
          return (first === undefined ? null : sceneCardElement(first)) ?? titleRef.current;
        },
      });
    }
  });

  // ---------- free edits ----------

  async function edit(op: SceneEditOp, after?: () => void, revision: number = set.revision): Promise<"ok" | SceneProblem | null> {
    if (editSending.current) return null;
    editSending.current = true;
    setEditError(null);
    try {
      const reply = await client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision, op });
      if (!reply.ok) {
        if (reply.error.code === "SCENES_CHANGED") {
          sceneSets.reload(avatar.avatarId);
          if (mounted.current) setEditError("changed");
        } else if (mounted.current) setEditError(reply.error);
        return null;
      }
      if ("problem" in reply.result) return reply.result.problem;
      sceneSets.apply(reply.result.sceneSet);
      after?.();
      return "ok";
    } finally {
      editSending.current = false;
    }
  }

  async function saveText(sceneId: number, text: string): Promise<void> {
    if (editing === null || editing.sceneId !== sceneId) return;
    const opened = editing;
    setEditing((e) => (e === null ? e : { ...e, busy: true }));
    const outcome = await edit({ op: "text", sceneId, text }, undefined, opened.revision);
    if (!mounted.current) return;
    if (outcome === "ok") {
      setEditing(null);
      focusLater(sceneButton(`Изменить текст сцены ${String(sceneId).padStart(2, "0")}`));
    } else if (outcome === null) setEditing((e) => (e === null ? e : { ...e, busy: false }));
    else setEditing({ ...opened, problem: outcome, problemFor: text, busy: false });
  }

  // ---------- what blocks a paid write ----------

  const blocked =
    paidBlockedReason(view) ??
    (avatar.status !== "active"
      ? "Аватар в архиве — новые фото для него не создаются."
      : runActive
        ? "Дождитесь конца текущего запуска."
        : paidInFlight
          ? "Дождитесь окончания другого платного действия."
          : null);

  // ---------- the job ----------

  const done = scenesJob?.done ?? 0;
  const total = scenesJob !== null && scenesJob.total > 0 ? scenesJob.total : (write?.count ?? 0);
  const cancelling = cancelBusy || (scenesJob !== null && view.cancellingJobs.has(scenesJob.jobId));
  const note = scenesJob === null ? undefined : sliceView.jobs.get(scenesJob.jobId);

  async function cancel(): Promise<void> {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError(null);
    const reply = await client.request("scenes.cancel", { sceneSetId: set.sceneSetId });
    if (reply.ok && scenesJob !== null) store.markCancelling(scenesJob.jobId);
    if (!mounted.current) return;
    setCancelBusy(false);
    if (!reply.ok) setCancelError(reply.error);
  }

  const rewriting = new Set(write?.kind === "rewrite" ? (write.sceneIds ?? []) : []);
  const composing = write !== null && (write.kind === "compose" || write.kind === "unwritten");
  const fresh = sliceView.fresh.get(set.sceneSetId);
  const placeholders = placeholderIds(set);
  const placeholderIdea = note?.idea?.idea ?? null;
  const shown = used ? set.scenes.filter((s) => !s.removed && s.text !== null) : set.scenes;

  return (
    <>
      {live && write !== null && (
        <div className="job-progress scene-progress">
          <div className="job-progress-row">
            <span id={`progress-${set.sceneSetId}`} className="job-progress-label" aria-live="polite">
              {progressLabel(write, done, total, set.scenes)}
            </span>
            {inLaunch ? (
              <span className="ap-in" title={launchWriteHint(write.kind)}>
                в запуске автопилота
              </span>
            ) : (
              <button ref={cancelRef} type="button" className="btn btn-s" disabled={cancelling} onClick={() => void cancel()}>
                {cancelling ? "Отменяем…" : "Отменить"}
              </button>
            )}
          </div>
          <div className="bar" role="progressbar" aria-labelledby={`progress-${set.sceneSetId}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
            {!cancelling && <i className="shim" aria-hidden="true" />}
          </div>
          <span className="mono faint scene-progress-note">{cancelling ? CANCELLING_NOTE : progressNote(write, done, total, set.textModel, note?.price ?? null)}</span>
          {!cancelling && !inLaunch && <span className="faint scene-progress-hint">{CANCEL_HINT}</span>}
        </div>
      )}
      {cancelError !== null && <ErrorNotice error={cancelError} />}

      {used && (
        <p className="scene-used-note">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 018 0v3" />
          </svg>
          <span>
            {frozenNote ?? (runCreatedAt === null ? "Набор стал запуском — правки закрыты." : `Набор стал запуском ${RUN_TIME.format(Date.parse(runCreatedAt))} — правки закрыты.`)}
          </span>
        </p>
      )}

      {editError === "changed" && (
        <Notice tone="info" title="Набор изменился" role="status" actions={<button type="button" className="btn btn-s" onClick={() => setEditError(null)}>Понятно</button>}>
          {SCENES_CHANGED_EDIT} <span className="mono faint">SCENES_CHANGED · ничего не списано</span>
        </Notice>
      )}
      {editError !== null && editError !== "changed" && <ErrorNotice error={editError} actions={<button type="button" className="btn btn-s" onClick={() => setEditError(null)}>Закрыть</button>} />}
      {jobFailure !== null && (
        <Notice
          tone="danger"
          title={jobFailure.sceneIds.length === 1 ? `Другая сцена вместо ${String(jobFailure.sceneIds[0]).padStart(2, "0")} не вышла` : "Другие сцены не вышли"}
          actions={<button type="button" className="btn btn-s" onClick={() => setJobFailure(null)}>Закрыть</button>}
        >
          {jobFailure.error.code === "MODERATION_REFUSED" ? "Модель отказалась писать её (отказ провайдера) — тот же запрос откажут снова." : errorText(jobFailure.error)} Сцена осталась как была.
        </Notice>
      )}

      {!used && (
        <SceneNotices
          set={set}
          view={view}
          blocked={blocked}
          onPaidInFlightChange={onPaidInFlightChange}
          reconciled={sliceView.reconciled.get(set.sceneSetId) ?? null}
          gaveUpDismissed={sliceView.dismissed.has(set.sceneSetId)}
          live={live}
          onRemoveEmpty={(sceneIds) => void edit({ op: "remove", sceneIds: [...sceneIds] }, () => focusLater(() => titleRef.current))}
          onDismissScenes={(sceneIds) => {
            const [first] = sceneIds;
            void edit({ op: "dismissInterrupted", sceneIds: [...sceneIds] }, () => focusLater(() => (first === undefined ? null : document.querySelector<HTMLElement>(`[data-scene="${first}"]`))));
          }}
          onDismissWrite={(writeNumber) => void edit({ op: "dismissInterrupted", write: writeNumber }, () => focusLater(() => addRef.current))}
          onOpenIdea={(interrupted: SceneInterruptedIdea) => onIdea({ idea: interrupted.idea, count: interrupted.count, shot: interrupted.shot, failure: null })}
          onCloseGaveUp={() => {
            sceneSets.dismissGaveUp(set.sceneSetId);
            focusLater(() => counterRef.current);
          }}
          onStarted={toCancel}
        />
      )}

      {!used && idea !== null && (
        <SceneIdeaForm
          key={`${idea.idea}|${idea.count}|${idea.shot ?? ""}|${idea.failure?.error.code ?? ""}`}
          set={set}
          view={view}
          start={idea}
          blocked={blocked ?? (live ? "Дождитесь, пока модель допишет." : null)}
          onPaidInFlightChange={onPaidInFlightChange}
          onClose={() => {
            onIdea(null);
            focusLater(() => addRef.current);
          }}
          onStarted={() => {
            onIdea(null);
            focusLater(() => document.querySelector<HTMLElement>("[data-placeholder]"));
          }}
        />
      )}
      {!used && set.scenes.length === 0 && placeholders.length === 0 && <p className="faint scene-empty-line">{EMPTY_SET_LINE}</p>}

      {(shown.length > 0 || placeholders.length > 0) && (
        <div className="scene-list">
          {shown.map((scene, i) => {
            const writing: SceneWriting = rewriting.has(scene.sceneId) ? "rewrite" : composing && scene.unwritten === "pending" && !scene.removed ? "compose" : null;
            const n = String(scene.sceneId).padStart(2, "0");
            return (
              <SceneCard
                key={scene.sceneId}
                scene={scene}
                number={used ? i + 1 : scene.sceneId}
                readOnly={used}
                actionsOff={live}
                writing={writing}
                fresh={fresh?.has(scene.sceneId) === true}
                popoverOpen={popover === scene.sceneId}
                editing={editing !== null && editing.sceneId === scene.sceneId ? editing : null}
                onEdit={() => {
                  setPopover(null);
                  setEditing({ sceneId: scene.sceneId, revision: set.revision, text: scene.text, problem: null, problemFor: null, busy: false });
                }}
                onRedo={() => {
                  setEditing(null);
                  setPopover((p) => (p === scene.sceneId ? null : scene.sceneId));
                }}
                onRemove={() => void edit({ op: "remove", sceneIds: [scene.sceneId] }, () => focusLater(sceneButton(`Вернуть сцену ${n}`)))}
                onRestore={() => void edit({ op: "restore", sceneIds: [scene.sceneId] }, () => focusLater(sceneButton(`Убрать сцену ${n}`)))}
                onSave={(text) => void saveText(scene.sceneId, text)}
                onCancelEdit={() => {
                  setEditing(null);
                  focusLater(sceneButton(`Изменить текст сцены ${n}`));
                }}
                popover={
                  popover === scene.sceneId && !live ? (
                    <ScenePopover
                      set={set}
                      scene={scene}
                      view={view}
                      blocked={blocked}
                      onPaidInFlightChange={onPaidInFlightChange}
                      onClose={() => {
                        setPopover(null);
                        focusLater(sceneButton(scene.origin === "own" ? `Переписать свою сцену ${n}` : `Другая сцена вместо ${n}`));
                      }}
                      onStarted={() => {
                        setPopover(null);
                        toCancel();
                      }}
                    />
                  ) : null
                }
              />
            );
          })}
          {placeholders.map((id) => (
            <ScenePlaceholder key={`placeholder-${id}`} number={id} idea={placeholderIdea} />
          ))}
        </div>
      )}
    </>
  );
}

const RUN_TIME = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A scene's card in the column, by its id. */
function sceneCardElement(sceneId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-scene="${sceneId}"]`);
}

/** The first scene an idea write added: the lowest id above what the set held before it. */
function firstNewScene(set: SceneSetView, before: number): HTMLElement | null {
  const added = set.scenes.filter((s) => s.sceneId > before).map((s) => s.sceneId);
  const first = added.length === 0 ? null : Math.min(...added);
  return first === null ? null : document.querySelector<HTMLElement>(`[data-scene="${first}"]`);
}
