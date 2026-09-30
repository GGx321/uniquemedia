import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DRAFT_CHANGING_DETAIL, DRAFT_TOO_NEW_DETAIL, type AvatarSummary, type EngineError, type Montage, type MontageIssue, type PhotoSummary, type VideoSummary } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { realScheduler } from "../engine/scheduler";
import { onFlushRequest } from "../engine/windowStudio";
import { isActiveJob, type EngineView } from "../engine/store";
import { errorText } from "../lib/errors";
import { NBSP } from "../lib/format";
import { type Route, useLeaveGuard, useNavigate } from "../navigation";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon, PlayIcon, Spin } from "../ui/Icon";
import { ErrorNotice, Notice } from "../ui/Notice";
import { ScreenTitle } from "../ui/ScreenTitle";
import { MediaPanel, PreviewSlot, PropertiesSlot, TimelineSlot } from "./montage/EditorSlots";
import { draftTitle, outputLabel, outputParts, saveLabel } from "./montage/labels";
import { photoProblems, renderBlock, type EngineVerdict, type RenderBlock, type UsedVideo } from "./montage/renderBlock";
import { useDraftFlushes } from "./montage/flushes";
import { DraftSession } from "./montage/session";
import { useMounted } from "./photos/shared";

// 3d.2: the montage editor's shell (Editor.dc.html, EditorNew.dc.html). It opens a draft by `montages.get`, keeps
// it in a `DraftSession` (undo/redo of up to 100 spec versions, the serialised autosave), and lays out the header
// and the four slots the next tasks fill: the timeline (3d.3a, 3d.3b), the preview (3d.4), the media and
// properties panels (3d.5). The «Рендер» button shows why it is disabled; its queue and job states are 3d.6's.

type Load =
  | { kind: "loading" }
  | { kind: "error"; error: EngineError }
  /** `lost`: why the last edit of the editor that closed before was not saved, told once. */
  | { kind: "ready"; montage: Montage; issues: readonly MontageIssue[]; lost: EngineError | null };

/** How many times an INTERNAL «the draft was changed just now» is retried before it is shown. */
const CHANGING_RETRIES = 2;
/** The pause before such a retry: the save that was replacing the file is done by then. */
const CHANGING_PAUSE_MS = 150;

/** A key that is the owner typing: text undo belongs to the field, not to the draft. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** «2026-09-30_collage3_001»: a video's file name without its folder and extension, as the owner sees it in «Готовые видео». */
function fileLabel(video: VideoSummary): string {
  const file = video.relPath.slice(video.relPath.lastIndexOf("/") + 1);
  return file.replace(/\.mp4$/, "");
}

function EditorHeader({
  session,
  title,
  fresh,
  block,
  busy,
  leaving,
  onBack,
  onDrafts,
  onRender,
}: {
  session: DraftSession;
  title: { avatar: string | null };
  /** Opened right after `montages.create`: «создан только что» until the first save lands. */
  fresh: boolean;
  block: RenderBlock | null;
  busy: { label: string } | null;
  /** The way out is waiting for the unsaved edit to be saved. */
  leaving: boolean;
  onBack: () => void;
  onDrafts: () => void;
  onRender: () => void;
}) {
  const navigate = useNavigate();
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.state,
  );
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const whyId = useId();
  const gone = state.save.kind === "gone";

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  function commitName(): void {
    const value = input.current?.value ?? "";
    setRenaming(false);
    session.rename(value);
  }

  return (
    <header className="ed-head">
      <button type="button" className="ibtn" aria-label="Назад к фото" aria-busy={leaving} disabled={leaving} onClick={onBack}>
        {leaving ? <Spin /> : <Icon name="back" size={16} strokeWidth={2.2} />}
      </button>
      <div className="ed-title">
        {renaming ? (
          <input
            ref={input}
            className="in in-s ed-title-input"
            aria-label="Название черновика"
            defaultValue={state.name ?? ""}
            placeholder="без названия"
            maxLength={80}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="ed-title-row">
            <ScreenTitle>{draftTitle(title.avatar, state.name)}</ScreenTitle>
            <button type="button" className="ed-rename" aria-label="Переименовать черновик" disabled={gone} onClick={() => setRenaming(true)}>
              <Icon name="pencil" size={12} strokeWidth={2.2} />
            </button>
          </span>
        )}
        <span className="mono faint ed-saved" role="status">
          {saveLabel(state.save, state.saved, { fresh })}
          {state.save.kind === "failed" && (
            <>
              {" · "}
              <button type="button" className="ed-retry" onClick={() => session.retry()}>
                Повторить
              </button>
            </>
          )}
        </span>
      </div>
      <div className="ed-history">
        <button type="button" className="ibtn" aria-label="Отменить" aria-keyshortcuts="Meta+Z Control+Z" disabled={!state.canUndo || gone} onClick={() => session.undo()}>
          <Icon name="undo" size={15} />
        </button>
        <button type="button" className="ibtn" aria-label="Повторить" aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y" disabled={!state.canRedo || gone} onClick={() => session.redo()}>
          <Icon name="redo" size={15} />
        </button>
      </div>
      <div className="ed-head-end">
        <span className="mono muted ed-output" title={outputLabel(state.spec)}>
          <span className="ed-output-format">{outputParts(state.spec).format} · </span>
          <span className="ed-output-length">{outputParts(state.spec).length}</span>
        </span>
        <button type="button" className="btn" aria-busy={leaving} disabled={leaving} onClick={onDrafts}>
          {leaving ? <Spin /> : <Icon name="list" size={15} />}
          Черновики
        </button>
        {/* SLOT 3d.6: the queue position, the saving phase, Cancel, done («Готово · Открыть в папке») and failed states. */}
        {busy !== null ? (
          <button type="button" className="btn btn-p ed-render-busy" aria-busy="true" aria-disabled="true">
            <Spin />
            {busy.label}
          </button>
        ) : block !== null ? (
          <>
            <span id={whyId} className="faint ed-render-why" title={block.text}>
              {block.text}
              {block.settings && (
                <>
                  {" · "}
                  <button type="button" className="ed-link" onClick={() => navigate({ name: "settings" })}>
                    Настройки
                  </button>
                </>
              )}
            </span>
            <button type="button" className="btn btn-p" disabled aria-describedby={whyId}>
              <PlayIcon />
              Рендер
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-p" disabled={gone} onClick={onRender}>
            <PlayIcon />
            Рендер
          </button>
        )}
      </div>
    </header>
  );
}

function DraftEditor({
  initial,
  initialIssues,
  lostEdit,
  created,
  avatar,
  view,
}: {
  initial: Montage;
  initialIssues: readonly MontageIssue[];
  lostEdit: EngineError | null;
  created: boolean;
  avatar: AvatarSummary | null;
  view: EngineView;
}) {
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const mounted = useMounted();
  const photosTab = useRef<HTMLButtonElement>(null);
  const { montageId } = initial;
  const avatarId = initial.spec.avatarId;
  const [session] = useState(
    () =>
      new DraftSession({
        montage: initial,
        scheduler: realScheduler,
        send: (id, content) => client.request("montages.save", { montageId: id, spec: content.spec, name: content.name }),
      }),
  );
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.state,
  );
  // This draft's latest render as the store knows it; its key moves with the job's status.
  const renderJob = view.jobs.filter((j) => j.kind === "render" && j.montageId === montageId).at(-1) ?? null;
  const renderKey = renderJob === null ? "none" : `${renderJob.jobId}:${renderJob.status}`;
  /** The engine's verdict, and the render state it was read AFTER: a verdict older than a render's end is stale. */
  const [verdict, setVerdict] = useState<EngineVerdict & { after: string }>(() => ({ spec: initial.spec, issues: initialIssues, after: renderKey }));
  const [photos, setPhotos] = useState<readonly PhotoSummary[] | null>(null);
  const [videos, setVideos] = useState<readonly VideoSummary[] | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  /** The render this window just queued, until the store knows how it ended: no second submit in between. */
  const [submittedJob, setSubmittedJob] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<EngineError | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** Why the previous editor's last edit of this draft was not saved (told once, on this open). */
  const [lost, setLost] = useState<EngineError | null>(lostEdit);
  /** Where the owner was going when the save before leaving was refused: the edit stays, and so does the window. */
  const [blockedLeave, setBlockedLeave] = useState<Route | null>(null);

  // Every way out (the header's buttons, the sidebar, a link in a notice) saves the unsaved edit FIRST, and stays
  // if the engine refuses it: the edit is never dropped behind the owner's back (the 3d.2 review's HIGH 1).
  // Leaving without it is the owner's own choice (`force`). A deleted draft has nothing left to save.
  useLeaveGuard(async (to) => {
    setLeaving(true);
    const flushed = await session.flush();
    if (!mounted.current) return true;
    setLeaving(false);
    if (flushed.ok || session.state.save.kind === "gone") return true;
    setBlockedLeave(to);
    return false;
  });
  // Closing the window (⌘W) with an edit that is not saved yet: the close is held (Electron cancels it without a
  // dialog), the edit is saved, then the window closes itself. A refused save keeps the window open with the reason
  // and «Закрыть без сохранения» (the 3d.2 review's HIGH 2).
  const [closeRefused, setCloseRefused] = useState(false);
  const allowClose = useRef(false);
  const saved = state.save.kind === "saved";
  useEffect(() => {
    if (saved) {
      setBlockedLeave(null);
      setCloseRefused(false);
    }
  }, [saved]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (allowClose.current) return;
      const kind = session.state.save.kind;
      if (kind !== "pending" && kind !== "saving" && kind !== "failed") return;
      event.preventDefault();
      event.returnValue = false;
      void session.flush().then((result) => {
        if (!mounted.current) return;
        if (result.ok) {
          allowClose.current = true;
          window.close();
        } else setCloseRefused(true);
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [session, mounted]);

  // Quitting (⌘Q): main asks every window to save before the engine shuts down, and waits (bounded) for the answer.
  useEffect(
    () =>
      onFlushRequest(async () => {
        await session.flush();
      }),
    [session],
  );

  // The store's montage.changed, in seq order: echoes of this window's saves change nothing, a save from
  // elsewhere is taken while nothing here is unsaved, a delete ends the session.
  // A resync lost whatever montage.changed was in its gap: the draft is read again (below), and that answer goes
  // through the same echo / adopt / keep rules as an event.
  useEffect(
    () =>
      store.subscribeMontages((signal) => {
        if (signal.change === "resynced") setFocusTick((n) => n + 1);
        else session.receive(signal);
      }),
    [store, session],
  );

  // Closing the editor any way at all (even leaving without saving) sends whatever is still unsaved once more, and
  // the window keeps that save's promise: the same draft opened again is read only after it answered.
  const flushes = useDraftFlushes();
  useEffect(() => () => flushes.track(montageId, session.flush()), [flushes, montageId, session]);

  useEffect(() => {
    const onFocus = (): void => setFocusTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target) || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const redo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey);
      const undo = key === "z" && !event.shiftKey;
      if (!undo && !redo) return;
      event.preventDefault();
      if (redo) session.redo();
      else session.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  // The engine's verdict again after each save it acknowledged, when the avatar changed (a render ended, a photo
  // was rejected: `avatar.changed`), and when the window comes back. Under a stale used index `montages.get` marks
  // every photo unavailable while a render would re-read it, and nothing announces the index healing: these
  // refetches are what clear it (the 3d.1a review note for 3d.2).
  // Each answer is also the draft as the engine holds it now: it goes through the same echo / adopt / keep rules as
  // a montage.changed, so a save this window missed (a resync gap, a hidden window) is picked up here.
  useEffect(() => {
    if (state.save.kind === "gone") return;
    let alive = true;
    const after = renderKey;
    void client.request("montages.get", { montageId }).then((reply) => {
      if (!alive || !mounted.current) return;
      if (reply.ok) {
        session.receive({ change: "upserted", montage: reply.result.montage });
        setVerdict({ spec: reply.result.montage.spec, issues: reply.result.issues, after });
      } else if (reply.error.code === "NOT_FOUND") session.receive({ change: "removed", montageId, avatarId });
    });
    return () => {
      alive = false;
    };
    // `state.saved` moves on each acknowledged save; `avatar` on each avatar.changed.
  }, [client, session, montageId, avatarId, state.saved, avatar, focusTick, renderKey, state.save.kind === "gone"]);

  // The avatar's photos: the bin, and why the engine refuses a photo.
  useEffect(() => {
    let alive = true;
    void client.request("photos.list", { avatarId }).then((reply) => {
      if (alive && reply.ok) setPhotos(reply.result.photos);
    });
    return () => {
      alive = false;
    };
  }, [client, avatarId, avatar, focusTick]);

  const photoIndex = useMemo(() => (photos === null ? null : new Map(photos.map((p) => [p.photoId, p]))), [photos]);
  const flagged = photoProblems(state.spec, verdict, photoIndex ?? new Map());
  const usedVideoId = flagged.find((f) => f.problem === "used")?.videoId ?? null;

  // Only when a photo is already in a video: its title for «Фото уже в видео «…»».
  useEffect(() => {
    if (usedVideoId === null) return;
    let alive = true;
    void client.request("videos.list", { avatarId }).then((reply) => {
      if (alive && reply.ok) setVideos(reply.result.videos);
    });
    return () => {
      alive = false;
    };
  }, [client, avatarId, usedVideoId, avatar]);

  const holder = usedVideoId === null ? undefined : videos?.find((v) => v.videoId === usedVideoId);
  // K12 (the video's own title) comes with 3e.2: until then a video made from this draft is «из этого черновика»
  // (the draft's name may have changed since), any other is called by its file name in «Готовые видео».
  const usedVideo: UsedVideo | null = holder === undefined ? null : holder.montageId === montageId ? "this-draft" : { file: fileLabel(holder) };

  const block = renderBlock({
    spec: state.spec,
    exportStatus: view.exportStatus,
    avatarActive: avatar?.status !== "archived",
    verdict,
    photos: photoIndex,
    usedVideo,
  });
  const activeJob = renderJob !== null && isActiveJob(renderJob) ? renderJob : null;
  // A render of this draft that just ended moved its photos (one photo, one video): until a verdict read after that
  // end answers, the old one cannot be trusted, so «Рендер» stays busy instead of flashing ready.
  const verdictBehind = renderJob !== null && !isActiveJob(renderJob) && verdict.after !== renderKey;
  // The answer may come before the job's first event (only the events and the snapshot promise it): until the store
  // has heard of the submitted job, the button stays busy.
  const submittedUnheard = submittedJob !== null && !view.jobs.some((j) => j.jobId === submittedJob);
  useEffect(() => {
    if (submittedJob !== null && !submittedUnheard) setSubmittedJob(null);
  }, [submittedJob, submittedUnheard]);
  const busy = submitting || submittedUnheard || verdictBehind
    ? { label: "Рендер…" }
    : activeJob === null
      ? null
      : { label: activeJob.status === "queued" ? "В очереди" : `Рендер · ${activeJob.total > 0 ? Math.floor((activeJob.done / activeJob.total) * 100) : 0}${NBSP}%` };

  async function submitRender(): Promise<void> {
    setSubmitting(true);
    setRenderError(null);
    // The engine renders the draft as STORED: the newest edit must be there first.
    const flushed = await session.flush();
    if (!mounted.current) return;
    if (!flushed.ok) {
      setSubmitting(false);
      setRenderError(flushed.error);
      return;
    }
    const reply = await client.request("videos.render", { montageId });
    if (!mounted.current) return;
    setSubmitting(false);
    if (reply.ok) setSubmittedJob(reply.result.jobId);
    else {
      setRenderError(reply.error);
      setFocusTick((n) => n + 1);
    }
  }

  const gone = state.save.kind === "gone";
  return (
    <div className="editor">
      <EditorHeader
        session={session}
        title={{ avatar: avatar?.name ?? null }}
        fresh={created && state.saved.updatedAt === initial.updatedAt && renderJob === null}
        block={gone ? null : block}
        busy={busy}
        leaving={leaving}
        onBack={() => navigate({ name: "photos", avatarId })}
        onDrafts={() => navigate({ name: "montages" })}
        onRender={() => void submitRender()}
      />
      {lost !== null && (
        <div className="ed-notices">
          <Notice
            tone="warn"
            title="Последнее изменение не сохранилось"
            actions={
              <button type="button" className="btn btn-s" onClick={() => setLost(null)}>
                Понятно
              </button>
            }
          >
            {errorText(lost)} Черновик открыт таким, каким его хранит Studio.
          </Notice>
        </div>
      )}
      {(gone || state.save.kind === "failed" || renderError !== null) && (
        <div className="ed-notices">
          {gone ? (
            <Notice
              tone="warn"
              title="Черновик удалён"
              actions={
                <button type="button" className="btn btn-s" onClick={() => navigate({ name: "montages" })}>
                  К черновикам
                </button>
              }
            >
              Его удалили на экране черновиков или в другом окне. Изменения здесь больше не сохраняются.
            </Notice>
          ) : state.save.kind === "failed" ? (
            <ErrorNotice
              error={state.save.error}
              actions={
                closeRefused ? (
                  <>
                    <button type="button" className="btn btn-s" onClick={() => session.retry()}>
                      Сохранить ещё раз
                    </button>
                    <button
                      type="button"
                      className="btn btn-s btn-d"
                      onClick={() => {
                        allowClose.current = true;
                        window.close();
                      }}
                    >
                      Закрыть без сохранения
                    </button>
                  </>
                ) : blockedLeave === null ? (
                  <button type="button" className="btn btn-s" onClick={() => session.retry()}>
                    Сохранить ещё раз
                  </button>
                ) : (
                  <>
                    {/* The guard saves again on the way out: saved, the window goes where the owner was going. */}
                    <button type="button" className="btn btn-s" onClick={() => navigate(blockedLeave)}>
                      Сохранить и перейти
                    </button>
                    <button type="button" className="btn btn-s btn-d" onClick={() => navigate(blockedLeave, { force: true })}>
                      Уйти без сохранения
                    </button>
                  </>
                )
              }
            />
          ) : (
            renderError !== null && (
              <ErrorNotice
                error={renderError}
                actions={
                  <button type="button" className="btn btn-s" onClick={() => setRenderError(null)}>
                    Закрыть
                  </button>
                }
              />
            )
          )}
        </div>
      )}
      <div className="ed-body">
        <MediaPanel avatarName={avatar?.name ?? "Аватар"} avatarId={avatarId} spec={state.spec} photos={photos} tabRef={photosTab} />
        <PreviewSlot spec={state.spec} />
        <PropertiesSlot empty={state.spec.clips.length === 0} />
      </div>
      <TimelineSlot spec={state.spec} flagged={block?.clips ?? []} onAddClip={() => photosTab.current?.focus()} />
    </div>
  );
}

/** A draft that could not be opened: gone, no library, a newer Studio, or a read that failed. */
function EditorProblem({ error, onRetry }: { error: EngineError; onRetry: () => void }) {
  const navigate = useNavigate();
  const back = (
    <button type="button" className="btn btn-s" onClick={() => navigate({ name: "montages" })}>
      К черновикам
    </button>
  );
  return (
    <div className="page ed-problem">
      <ScreenTitle>Монтаж</ScreenTitle>
      {error.code === "NOT_FOUND" ? (
        <Notice tone="warn" title="Черновик удалён" actions={back}>
          Такого черновика больше нет: его удалили. Видео, собранные из него, остались в «Готовых видео».
        </Notice>
      ) : (
        <ErrorNotice
          error={error}
          actions={
            <>
              {/* A newer Studio's draft opens only after an update: a retry cannot help. */}
              {error.detail !== DRAFT_TOO_NEW_DETAIL && (
                <button type="button" className="btn btn-s" onClick={onRetry}>
                  Повторить
                </button>
              )}
              {back}
            </>
          }
        />
      )}
    </div>
  );
}

export function EditorScreen({ montageId, created = false }: { montageId: string; created?: boolean }) {
  const view = useEngineView();
  const { client } = useEngine();
  const flushes = useDraftFlushes();
  const ready = view.phase === "ready";
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loaded = load.kind === "ready";

  useEffect(() => {
    if (!ready || loaded) return;
    let alive = true;
    let retries = 0;
    let cancelPause: (() => void) | null = null;
    const get = (lost: EngineError | null): void => {
      void client.request("montages.get", { montageId }).then((reply) => {
        if (!alive) return;
        if (reply.ok) setLoad({ kind: "ready", montage: reply.result.montage, issues: reply.result.issues, lost });
        else if (reply.error.code === "INTERNAL" && reply.error.detail === DRAFT_CHANGING_DETAIL && retries < CHANGING_RETRIES) {
          // Being saved right now: a moment later it reads whole.
          retries += 1;
          cancelPause = realScheduler.schedule(CHANGING_PAUSE_MS, () => get(lost));
        } else setLoad({ kind: "error", error: reply.error });
      });
    };
    // An editor of this draft that just closed may still be saving its last edit: read the draft after that.
    void flushes.settle(montageId).then((lost) => {
      if (alive) get(lost);
    });
    return () => {
      alive = false;
      cancelPause?.();
    };
  }, [ready, loaded, client, flushes, montageId, attempt]);

  if (load.kind === "ready") {
    const avatar = view.avatars.find((a) => a.avatarId === load.montage.spec.avatarId) ?? null;
    return (
      <DraftEditor key={load.montage.montageId} initial={load.montage} initialIssues={load.issues} lostEdit={load.lost} created={created} avatar={avatar} view={view} />
    );
  }
  if (view.phase === "offline") {
    return (
      <div className="page ed-problem">
        <ScreenTitle>Монтаж</ScreenTitle>
        <EngineOffline view={view} />
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <EditorProblem
        error={load.error}
        onRetry={() => {
          setLoad({ kind: "loading" });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return (
    <div className="editor editor-loading" aria-busy="true">
      <header className="ed-head">
        <ScreenTitle>Монтаж</ScreenTitle>
      </header>
      <div className="ed-body">
        <div className="ed-media" />
        <div className="ed-preview">
          <div className="ed-frame">
            <div className="shim" />
          </div>
        </div>
        <div className="ed-props" />
      </div>
      <div className="ed-timeline" />
    </div>
  );
}
