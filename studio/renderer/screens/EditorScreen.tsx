import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DRAFT_CHANGING_DETAIL, DRAFT_TOO_NEW_DETAIL, type AvatarSummary, type EngineError, type MediaSummary, type Montage, type MontageIssue, type PhotoSummary, type VideoSummary } from "../../shared/engine";
import { ownVideoClips } from "../../shared/montage";
import { useEngine, useEngineView } from "../engine/react";
import { realScheduler } from "../engine/scheduler";
import { onFlushRequest, quitWithoutSaving } from "../engine/windowStudio";
import { classifyAnswer, foundAfterSubmit, latestRenderOf, renderControl, type RenderControl } from "../engine/renderJobs";
import { isActiveJob, type EngineView } from "../engine/store";
import { errorText } from "../lib/errors";
import { type Route, useLeaveGuard, useNavigate } from "../navigation";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon, Spin } from "../ui/Icon";
import { ErrorNotice, Notice } from "../ui/Notice";
import { ScreenTitle } from "../ui/ScreenTitle";
import { type BinFilter, isFreePhoto } from "./montage/bin";
import { ClipProperties } from "./montage/ClipProperties";
import { sameJson } from "./montage/json";
import { LayerProperties } from "./montage/LayerProperties";
import { addLayerRefusal } from "./montage/layerOps";
import { type MediaTab, MediaPanel } from "./montage/MediaPanel";
import { type BinDrag, dragKey, parseDragKey } from "./montage/mine";
import { MineTab, type MineTabProps } from "./montage/MineTab";
import { MusicProperties } from "./montage/MusicCard";
import { musicVerdictOf, pickOwnTrack, pickTrack, type TrackVerdict } from "./montage/musicOps";
import { MusicTab } from "./montage/MusicTab";
import { useTrackSummary } from "./montage/MusicTrack";
import { changeTouches, draftMediaIds } from "./montage/ownMedia";
import { MediaStandIn } from "./montage/PanelSplitter";
import { useOwnVideos, videoProblems } from "./montage/ownVideos";
import { TrimPeekStore } from "./montage/trimPeek";
import { PhotoBin } from "./montage/PhotoBin";
import { replaceSticker } from "./montage/stickerOps";
import { StickerTab, type StickerTabProps } from "./montage/StickerTab";
import { TextPreviewsProvider, useRefusedCaptions, useTextPreviewQueue } from "./montage/textPreviews";
import { TextTab, type TextTabProps } from "./montage/TextTab";
import {
  addRefusal,
  appendOwnPhotoClip,
  appendPhotoClip,
  appendVideoClip,
  cellsOf,
  clipStartMs,
  type Edit,
  insertOwnPhotoClip,
  insertPhotoClip,
  insertVideoClip,
  type OwnVideoFacts,
  setCellOwnPhoto,
  setCellPhoto,
  totalMs,
} from "./montage/clipOps";
import { PropertiesSlot } from "./montage/EditorSlots";
import { Preview } from "./montage/Preview";
import { draftTitle, layerAddLabel, layerName, outputLabel, outputParts, saveLabel } from "./montage/labels";
import { RenderControls } from "./montage/RenderControls";
import { layerProblems, photoProblems, renderBlock, type EngineVerdict, type PhotoProblem, type UsedVideo } from "./montage/renderBlock";
import { useDraftFlushes } from "./montage/flushes";
import { isTextEntry, spacePlays } from "./montage/keys";
import { resolveSelection, selectClip } from "./montage/selection";
import { DraftSession } from "./montage/session";
import { useDraftSessions } from "./montage/sessions";
import { Timeline } from "./montage/Timeline";
import { seekInto } from "./montage/timelineScale";
import { usePlayheadRest } from "./montage/usePlayhead";
import { playheadStep, type TimelineState, useFocusResolver, useSelectionCommands, useTimeline } from "./montage/useTimeline";
import { useMounted } from "./photos/shared";

// 3d.2: the montage editor's shell (Editor.dc.html, EditorNew.dc.html). It opens a draft by `montages.get`, keeps
// it in a `DraftSession` (undo/redo of up to 100 spec versions, the serialised autosave), and lays out the header
// and the regions: the timeline (3d.3a: the clip track; 3d.3b: layers and music), the live preview (3d.4), the media
// and properties panels (3d.3a places photos and edits a clip; 3d.5: the «Фото», «Музыка», «GIF» and «Текст» tabs and
// the text, sticker and music properties). The «Рендер» button shows why it is disabled; its queue and job states are
// 3d.6's. Every edit goes through the session: one undo step, autosaved.

type Load =
  | { kind: "loading" }
  | { kind: "error"; error: EngineError }
  /** `lost`: why the last edit of the editor that closed before was not saved, told once. */
  | { kind: "ready"; montage: Montage; issues: readonly MontageIssue[]; lost: EngineError | null };

/** How many times an INTERNAL «the draft was changed just now» is retried before it is shown. */
const CHANGING_RETRIES = 2;
/** The pause before such a retry: the save that was replacing the file is done by then. */
const CHANGING_PAUSE_MS = 150;
/** How long a render whose answer never came waits for its job to show up in the events and the snapshot before the owner is told. */
const NO_ANSWER_GRACE_MS = 2_000;

/** «2026-09-30_collage3_001»: a video's file name without its folder and extension, as the owner sees it in «Готовые видео». */
function fileLabel(video: VideoSummary): string {
  const file = video.relPath.slice(video.relPath.lastIndexOf("/") + 1);
  return file.replace(/\.mp4$/, "");
}

function EditorHeader({
  session,
  title,
  fresh,
  control,
  revealing,
  leaving,
  onBack,
  onDrafts,
  onRender,
  onCancel,
  onReveal,
}: {
  session: DraftSession;
  title: { avatar: string | null };
  /** Opened right after `montages.create`: «создан только что» until the first save lands. */
  fresh: boolean;
  /** The render button's state (3d.6): from the job model. */
  control: RenderControl;
  /** «Открыть в папке» was asked and is not answered yet. */
  revealing: boolean;
  /** The way out is waiting for the unsaved edit to be saved. */
  leaving: boolean;
  onBack: () => void;
  onDrafts: () => void;
  onRender: () => void;
  onCancel: () => void;
  onReveal: (videoId: string) => void;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.state,
  );
  const [renaming, setRenaming] = useState(false);
  /** Why the typed name was refused; the field stays open with it. */
  const [nameError, setNameError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const nameErrorId = useId();
  const gone = state.save.kind === "gone";

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  function commitName(): void {
    const value = input.current?.value ?? "";
    // The only name the contract refuses that the field lets through: one with a control character (a pasted tab).
    if (!session.rename(value)) {
      setNameError("В названии не может быть служебных символов (табуляции и других) — уберите их.");
      return;
    }
    setNameError(null);
    setRenaming(false);
  }

  function cancelRename(): void {
    setNameError(null);
    setRenaming(false);
  }

  return (
    <header className="ed-head">
      <button type="button" className="ibtn" aria-label="Назад к фото" aria-busy={leaving} disabled={leaving} onClick={onBack}>
        {leaving ? <Spin /> : <Icon name="back" size={16} strokeWidth={2.2} />}
      </button>
      <div className="ed-title">
        {renaming ? (
          <span className="ed-title-edit">
            <input
              ref={input}
              className="in in-s ed-title-input"
              aria-label="Название черновика"
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? nameErrorId : undefined}
              defaultValue={state.name ?? ""}
              placeholder="без названия"
              maxLength={80}
              onBlur={commitName}
              onKeyDown={(e) => {
                // Enter that ends an input method's composition belongs to the composition, not to the rename.
                if (e.key === "Enter" && !e.nativeEvent.isComposing) commitName();
                if (e.key === "Escape") cancelRename();
              }}
            />
            {nameError !== null && (
              <span id={nameErrorId} className="ed-title-error" role="alert">
                {nameError}
              </span>
            )}
          </span>
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
        <RenderControls control={control} gone={gone} revealing={revealing} onRender={onRender} onCancel={onCancel} onReveal={onReveal} />
      </div>
    </header>
  );
}

/**
 * The «Текст» tab where the playhead rests: «Добавить текст в X с» and why it cannot (3d.4: the tab follows the playhead on its own,
 * so a playback re-renders neither it nor the editor).
 */
function TextTabAtPlayhead({ timeline, spec, ...props }: { timeline: TimelineState; spec: Montage["spec"] } & Omit<TextTabProps, "spec" | "playheadMs" | "addWhy">) {
  const restMs = usePlayheadRest(timeline.playhead);
  const why = layerAddLabel("text", addLayerRefusal(spec, "text", restMs), totalMs(spec)).why;
  return <TextTab spec={spec} playheadMs={restMs} addWhy={why} {...props} />;
}

/** Why no sticker can be added where the playhead rests (G10: at the cap it says what to do about it). */
function stickerAddWhy(spec: Montage["spec"], restMs: number): string | null {
  const refusal = addLayerRefusal(spec, "sticker", restMs);
  return refusal === "layer-cap" ? "Не больше 10 стикеров в одном видео — уберите один, чтобы добавить другой." : layerAddLabel("sticker", refusal, totalMs(spec)).why;
}

/** The «Мои» tab (3f.6), with why no sticker can be added where the playhead rests (M12 follows the «GIF» tab's rules). */
function MineTabAtPlayhead({ timeline, spec, ...props }: { timeline: TimelineState } & Omit<MineTabProps, "stickerWhy" | "playhead">) {
  const restMs = usePlayheadRest(timeline.playhead);
  return <MineTab spec={spec} playhead={timeline.playhead} stickerWhy={stickerAddWhy(spec, restMs)} {...props} />;
}

/** The «GIF» tab, and why no sticker can be added where the playhead rests (G10: at the cap it says what to do about it). */
function StickerTabAtPlayhead({ timeline, spec, ...props }: { timeline: TimelineState; spec: Montage["spec"] } & Omit<StickerTabProps, "spec" | "addWhy">) {
  const restMs = usePlayheadRest(timeline.playhead);
  return <StickerTab spec={spec} addWhy={stickerAddWhy(spec, restMs)} {...props} />;
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
  const { montageId } = initial;
  const avatarId = initial.spec.avatarId;
  // Slice review 5-M2: an editor of this draft that closed in this window (the owner went to Settings and came back) left its session and its
  // place: they go on, with the undo history. The draft as the engine holds it now goes through the session's own rules (an echo of its last
  // save changes nothing; a save made elsewhere meanwhile is taken, on top of the history).
  const sessions = useDraftSessions();
  const [kept] = useState(() => sessions.resume(montageId));
  const [session] = useState(() => {
    if (kept !== null) {
      kept.session.receive({ change: "upserted", montage: initial });
      return kept.session;
    }
    return new DraftSession({
      montage: initial,
      scheduler: realScheduler,
      send: (id, content) => client.request("montages.save", { montageId: id, spec: content.spec, name: content.name }),
    });
  });
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.state,
  );
  // This draft's latest render as the store knows it; its key moves with the job's status.
  const renderJob = latestRenderOf(view.jobs, montageId);
  const renderKey = renderJob === null ? "none" : `${renderJob.jobId}:${renderJob.status}`;
  /** The engine's verdict, and the render state it was read AFTER: a verdict older than a render's end is stale. */
  const [verdict, setVerdict] = useState<EngineVerdict & { after: string }>(() => ({ spec: initial.spec, issues: initialIssues, after: renderKey }));
  const [photos, setPhotos] = useState<readonly PhotoSummary[] | null>(null);
  const [videos, setVideos] = useState<readonly VideoSummary[] | null>(null);
  /** Why the last re-read of the draft failed (cleared by the next one that answers). */
  const [verdictError, setVerdictError] = useState<EngineError | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  /**
   * The render this window just submitted, until the store has heard of its job: no second submit in between. `jobId` is the
   * one the answer named; an answer that never came names none, and the job is looked for by this draft among the jobs the
   * window did not know (`known`).
   */
  const [pending, setPending] = useState<{ jobId: string | null; known: ReadonlySet<string>; silent: EngineError | null } | null>(null);
  const [renderError, setRenderError] = useState<EngineError | null>(null);
  /** The frames a refused render named (`PHOTO_UNAVAILABLE` / `MONTAGE_INVALID` issues), highlighted until the next try. */
  const [refusedClips, setRefusedClips] = useState<readonly number[]>([]);
  /** The failed render whose notice the owner closed. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<EngineError | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** Why the previous editor's last edit of this draft was not saved (told once, on this open). */
  const [lost, setLost] = useState<EngineError | null>(lostEdit);
  /** Where the owner was going when the save before leaving was refused: the edit stays, and so does the window. */
  const [blockedLeave, setBlockedLeave] = useState<Route | null>(null);

  // Every way out (the header's buttons, the sidebar, a link in a notice) saves the unsaved edit FIRST, and stays
  // if the engine refuses it: the edit is never dropped behind the owner's back (the 3d.2 review's HIGH 1).
  // Leaving without it is the owner's own choice (`force`). A deleted draft has nothing left to save.
  useLeaveGuard(async (target) => {
    setLeaving(true);
    const flushed = await session.flush();
    if (!mounted.current) return true;
    setLeaving(false);
    if (flushed.ok || session.state.save.kind === "gone") return true;
    // Where the owner meant to go last (clicks while the save was out change it).
    setBlockedLeave(target());
    return false;
  });
  // Closing the window (⌘W) with an edit that is not saved yet: the close is held (Electron cancels it without a
  // dialog), the edit is saved, then the window closes itself. A refused save keeps the window open with the reason
  // and «Закрыть без сохранения» (the 3d.2 review's HIGH 2).
  const [closeRefused, setCloseRefused] = useState(false);
  /** A quit (⌘Q) was cancelled because the edit could not be saved: «Выйти без сохранения» is offered. */
  const [quitRefused, setQuitRefused] = useState(false);
  const allowClose = useRef(false);
  const saved = state.save.kind === "saved";
  useEffect(() => {
    if (saved) {
      setBlockedLeave(null);
      setCloseRefused(false);
      setQuitRefused(false);
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
        const flushed = await session.flush();
        const saved = flushed.ok || session.state.save.kind === "gone";
        // Not saved: main cancels the quit before touching the engine, and the window offers to quit anyway.
        if (!saved && mounted.current) setQuitRefused(true);
        return saved;
      }),
    [session, mounted],
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
  // After «Уйти без сохранения» the owner already chose: a failure of that last try is not told again on the reopen.
  const leftBehind = useRef(false);
  useEffect(() => () => flushes.track(montageId, session.flush(), { report: !leftBehind.current }), [flushes, montageId, session]);

  useEffect(() => {
    const onFocus = (): void => setFocusTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Text undo belongs to a text field; a slider or a button keeps none, so ⌘Z there is the draft's (keys.ts).
      if (event.defaultPrevented || isTextEntry(event.target) || !(event.metaKey || event.ctrlKey) || event.altKey) return;
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
  const gone = state.save.kind === "gone";
  const savedAt = state.saved.updatedAt;
  // 3f.3b fix round 1 (M1): a `media.changed` about one of the draft's own files (an own photo, video, sticker or track deleted in «Мои» or
  // replaced) reads the verdict again: `media.delete` announces nothing else, and a clean verdict on the same spec would otherwise stand.
  const [mediaTick, setMediaTick] = useState(0);
  const draftMedia = useRef<ReadonlySet<string>>(new Set());
  draftMedia.current = draftMediaIds(state.spec);
  useEffect(() => {
    // A burst (several files deleted at once) is one read: the changes heard before the microtask runs are coalesced into one tick (fix round 2).
    let queued = false;
    return client.subscribe((event) => {
      if (event.type !== "media.changed" || !changeTouches(event.payload, draftMedia.current) || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        setMediaTick((tick) => tick + 1);
      });
    });
  }, [client]);
  useEffect(() => {
    if (gone) return;
    let alive = true;
    const after = renderKey;
    // A new read starts: an earlier one's failure is no longer the news (the button waits for this answer instead).
    setVerdictError(null);
    void client.request("montages.get", { montageId }).then((reply) => {
      if (!alive || !mounted.current) return;
      if (reply.ok) {
        session.receive({ change: "upserted", montage: reply.result.montage });
        setVerdict({ spec: reply.result.montage.spec, issues: reply.result.issues, after });
        setVerdictError(null);
      } else if (reply.error.code === "NOT_FOUND") session.receive({ change: "removed", montageId, avatarId });
      else setVerdictError(reply.error);
    });
    return () => {
      alive = false;
    };
    // `savedAt` moves when the engine's state of the draft does (not when the same state is heard again, which would
    // read it again in a loop); `avatar` on each avatar.changed; `mediaTick` on a change to one of the draft's own files.
  }, [client, session, montageId, avatarId, savedAt, avatar, focusTick, renderKey, gone, mediaTick]);

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
  // The first unusable photo of each clip: the timeline's «⚠ фото отклонено» tags.
  const clipProblems = new Map<number, PhotoProblem>();
  for (const cell of flagged) if (!clipProblems.has(cell.clip)) clipProblems.set(cell.clip, cell.problem);

  // ---------- the timeline (3d.3a; 3d.3b: layers and music) ----------
  const timeline = useTimeline(state.spec, undefined, kept?.place ?? null);
  const { playhead } = timeline;

  // The owner's feedback (2026-10-05): Space plays and pauses the montage wherever the focus is, but where Space is the control's own
  // (keys.ts `spacePlays`: typing, a checkbox or a radio, an open dialog or menu). On a focused button the key is taken, so the button is
  // not ALSO pressed (the timeline's ▶ would start and stop at once); a held Space does not toggle again. Nothing to play leaves it alone.
  useEffect(() => {
    let taken = false;
    const onDown = (event: KeyboardEvent): void => {
      if (!spacePlays(event, document) || playhead.totalMs <= 0) return;
      event.preventDefault();
      taken = true;
      if (!event.repeat) playhead.toggle();
    };
    // An engine that presses a focused button when Space is let go (not Chromium's: its press needs the key down) finds this key taken too.
    const onUp = (event: KeyboardEvent): void => {
      if (event.key !== " " || !taken) return;
      taken = false;
      event.preventDefault();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [playhead]);
  const musicLookup = useTrackSummary(client, state.spec.music, view.music?.listFetchedAt ?? null);
  // The engine's referential verdict on the layers and the track counts only for the spec it judged (as renderBlock reads it).
  const judgedNow = sameJson(verdict.spec, state.spec);
  const judged = judgedNow ? verdict.issues : [];
  // The track: judged (by the length the engine's decode proved) or not yet; the block trusts only a verdict on the spec on screen.
  const musicVerdict: TrackVerdict = musicVerdictOf(judgedNow, judged);
  // The draft's one queue of text previews is made here, above its provider, so that «Рендер» and the layer blocks read the same verdict the
  // caption panel shows: a refusal of the caption as it stands now (a cluster the real emoji font lacks). With no verdict yet nothing is blocked.
  const previewQueue = useTextPreviewQueue(client, avatarId);
  const previewRefused = useRefusedCaptions(previewQueue, state.spec.layers);
  const flaggedLayers = layerProblems(verdict.spec, judged, previewRefused);
  // 3f.3b: the own videos the clips play (their records, by id), and what the render refuses each video clip for: the engine's verdict on the spec on
  // screen, else the window's guess from the records.
  const ownVideos = useOwnVideos(client, ownVideoClips(state.spec).map((clip) => clip.mediaId));
  const clipVideoProblems = videoProblems(state.spec, verdict, ownVideos);
  // 3f.3b fix round 1 (L8): «Обрезка» tells the preview which frame a drag is at, without re-rendering the editor.
  const [trimPeek] = useState(() => new TrimPeekStore());
  const focus = useFocusResolver(client, session, avatarId);
  /**
   * What is dragged out of the media panel: a free scene photo from «Фото», or an own photo or video from «Мои» (3f.6). The timeline and the
   * preview carry its key back untouched (`dragKey`); a video never goes into a cell, so only a photo's key is offered to the cells.
   */
  const [drag, setDrag] = useState<BinDrag | null>(null);
  const dragAny = drag === null ? null : dragKey(drag);
  const dragCell = drag !== null && (drag.source === "scene" || drag.kind === "photo") ? dragAny : null;
  const selected = resolveSelection(state.spec, timeline.selection);
  const selectedCell = selected?.kind === "clip" ? cellsOf(selected.clip)[selected.cell] : undefined;
  const fillTarget = selected?.kind === "clip" && selectedCell !== undefined && selectedCell.photo === null ? { clip: selected.index, cell: selected.cell } : null;

  // ---------- the media panel (3d.5) ----------
  const commands = useSelectionCommands(session, timeline);
  const [tab, setTab] = useState<MediaTab>(kept?.place.tab ?? "photos");
  // Closing, the editor leaves its session and its place with the window, for the next editor of this draft here (slice review 5-M2).
  const place = useRef({ tab, timeline });
  place.current = { tab, timeline };
  useEffect(
    () => () => {
      const { tab: lastTab, timeline: last } = place.current;
      sessions.keep(montageId, { session, place: { tab: lastTab, selection: last.selection, playheadMs: playheadStep(last), zoom: last.zoom } });
    },
    [sessions, montageId, session],
  );
  /** Bumped when the timeline's «+» or a «Заменить…» asks for a tab: the focus goes to it. */
  const [tabFocus, setTabFocus] = useState(0);
  const [binFilter, setBinFilter] = useState<BinFilter>({ unusedOnly: false, category: null });
  /** «Заменить стикер» under way: the layer whose sticker the next «GIF» tile swaps (time, place and size kept). */
  const [replacing, setReplacing] = useState<string | null>(null);
  const replacingIndex = replacing === null ? -1 : state.spec.layers.findIndex((l) => l.layerId === replacing && l.kind === "sticker");
  const selectedLayer = selected?.kind === "layer" ? selected.layer : null;
  // A replacement belongs to the sticker that asked for it: another selection, another tab, or the layer gone ends it.
  const replaceLive = replacingIndex >= 0 && tab === "gif" && selectedLayer?.layerId === replacing;
  useEffect(() => {
    if (replacing !== null && !replaceLive) setReplacing(null);
  }, [replacing, replaceLive]);

  function openTab(next: MediaTab): void {
    setTab(next);
    setTabFocus((n) => n + 1);
  }

  /** Selects a layer from the «Текст» tab's list and brings the playhead into it, as a click on its block does. */
  function selectLayer(layerId: string): void {
    const spec = session.state.spec;
    const layer = spec.layers.find((l) => l.layerId === layerId);
    if (layer === undefined) return;
    timeline.select({ kind: "layer", layerId });
    const now = playheadStep(timeline);
    const into = seekInto(now, layer.startMs, Math.min(layer.endMs, totalMs(spec)));
    if (into !== now) timeline.seek(into);
  }

  /** A track from the «Музыка» tab: into the montage at its first highlight that fits (free: no request leaves), then selected. */
  function pickMusic(track: Parameters<typeof pickTrack>[1]): void {
    const spec = session.state.spec;
    const edit = pickTrack(spec, track);
    if (!edit.ok) return;
    if (edit.spec !== spec && !session.edit(edit.spec)) return;
    timeline.select({ kind: "music" });
  }

  /** A «GIF» tile: swaps the sticker being replaced, or puts a new one at the playhead. */
  function pickSticker(stickerId: string): void {
    if (replaceLive && replacing !== null) {
      const spec = session.state.spec;
      const at = spec.layers.findIndex((l) => l.layerId === replacing);
      if (at >= 0 && spec.layers[at]?.kind === "sticker") {
        const next = replaceSticker(spec, at, stickerId);
        if (next !== spec) session.edit(next);
      }
      setReplacing(null);
      return;
    }
    commands.addSticker(stickerId);
  }

  const currentSticker = selectedLayer?.kind === "sticker" && selectedLayer.sticker.source === "builtin" ? selectedLayer.sticker.stickerId : null;
  const currentOwnSticker = selectedLayer?.kind === "sticker" && selectedLayer.sticker.source === "own" ? selectedLayer.sticker.mediaId : null;

  /** Selects clip `index` of the current draft (and its cell), bringing the playhead into it. */
  function selectClipAt(index: number, cell = 0): void {
    const spec = session.state.spec;
    const clip = spec.clips[index];
    if (clip === undefined) return;
    timeline.select(selectClip(spec, index, cell));
    const start = clipStartMs(spec, index);
    const now = playheadStep(timeline);
    const into = seekInto(now, start, start + clip.durationMs);
    if (into !== now) timeline.seek(into);
  }

  /** A free scene photo as a new clip at `boundary` (the end by default); its face focus is asked for at once (K6). */
  function placePhoto(photoId: string, boundary?: number): void {
    const photo = photoIndex?.get(photoId);
    if (photo === undefined || !isFreePhoto(photo)) return;
    const spec = session.state.spec;
    const result = boundary === undefined ? appendPhotoClip(spec, photoId) : insertPhotoClip(spec, boundary, photoId);
    if (!result.ok || result.id === undefined || !session.edit(result.spec)) return;
    focus.resolve(photoId);
    const index = result.spec.clips.findIndex((c) => c.clipId === result.id);
    if (index >= 0) selectClipAt(index);
  }

  /** After a cell was filled: the selection moves on to the clip's next empty cell, if any. */
  function selectAfterFill(spec: Montage["spec"], clipIndex: number, cell: number): void {
    const clip = spec.clips[clipIndex];
    const cells = clip === undefined ? [] : cellsOf(clip);
    const next = cells.findIndex((c, i) => i > cell && c.photo === null);
    const anyEmpty = cells.findIndex((c) => c.photo === null);
    timeline.select(selectClip(spec, clipIndex, next >= 0 ? next : anyEmpty >= 0 ? anyEmpty : cell));
  }

  /** A free scene photo into a cell; the selection moves on to the clip's next empty cell, if any. */
  function fillCell(clipIndex: number, cell: number, photoId: string): void {
    const photo = photoIndex?.get(photoId);
    if (photo === undefined || !isFreePhoto(photo)) return;
    const result = setCellPhoto(session.state.spec, clipIndex, cell, photoId);
    if (!result.ok || !session.edit(result.spec)) return;
    focus.resolve(photoId);
    selectAfterFill(result.spec, clipIndex, cell);
  }

  // ---------- «Мои» (3f.6): the owner's own files, by the same rules ----------

  /** A new clip made by `edit` (an own photo or video), selected; one undo step. */
  function placeOwn(result: Edit): string | null {
    if (!result.ok || result.id === undefined || !session.edit(result.spec)) return null;
    const index = result.spec.clips.findIndex((c) => c.clipId === result.id);
    if (index >= 0) selectClipAt(index);
    return result.id;
  }

  /** An own photo as a new clip at `boundary` (the end by default); its face focus is asked for at once (K6, as for a scene photo). */
  function placeOwnPhoto(mediaId: string, boundary?: number): void {
    const spec = session.state.spec;
    if (placeOwn(boundary === undefined ? appendOwnPhotoClip(spec, mediaId) : insertOwnPhotoClip(spec, boundary, mediaId)) !== null) focus.resolveOwn(mediaId);
  }

  /** An own video as a new clip at `boundary` (the end by default): from its start, for min(2 s, the room, its length). */
  function placeOwnVideo(video: OwnVideoFacts, boundary?: number): void {
    const spec = session.state.spec;
    placeOwn(boundary === undefined ? appendVideoClip(spec, video) : insertVideoClip(spec, boundary, video));
  }

  /** An own photo into a cell; the selection moves on as for a scene photo. */
  function fillOwnCell(clipIndex: number, cell: number, mediaId: string): void {
    const result = setCellOwnPhoto(session.state.spec, clipIndex, cell, mediaId);
    if (!result.ok || !session.edit(result.spec)) return;
    focus.resolveOwn(mediaId);
    selectAfterFill(result.spec, clipIndex, cell);
  }

  /** A drag from the media panel dropped on «Кадры» at `boundary`: a scene photo, an own photo or an own video as a new clip there. */
  function insertDropped(key: string, boundary: number): void {
    const dropped = parseDragKey(key);
    if (dropped === null) return;
    if (dropped.source === "scene") placePhoto(dropped.photoId, boundary);
    else if (dropped.kind === "photo") placeOwnPhoto(dropped.mediaId, boundary);
    else placeOwnVideo(dropped, boundary);
  }

  /** A drag dropped on an empty cell: a photo fills it (a video has no cell; it is never offered one). */
  function fillDropped(clipIndex: number, cell: number, key: string): void {
    const dropped = parseDragKey(key);
    if (dropped === null) return;
    if (dropped.source === "scene") fillCell(clipIndex, cell, dropped.photoId);
    else if (dropped.kind === "photo") fillOwnCell(clipIndex, cell, dropped.mediaId);
  }

  /** A click on a photo or video tile of «Мои»: a placed one selects its clip; a photo fills the waiting cell; else a new clip at the end. */
  function pickOwnVisual(media: MediaSummary): void {
    const spec = session.state.spec;
    for (const [i, clip] of spec.clips.entries()) {
      if (clip.kind === "video" && clip.mediaId === media.mediaId) {
        selectClipAt(i);
        return;
      }
      const cell = cellsOf(clip).findIndex((c) => c.photo?.source === "own" && c.photo.mediaId === media.mediaId);
      if (cell >= 0) {
        selectClipAt(i, cell);
        return;
      }
    }
    if (media.kind === "photo") {
      if (fillTarget !== null) fillOwnCell(fillTarget.clip, fillTarget.cell, media.mediaId);
      else placeOwnPhoto(media.mediaId);
    } else if (media.kind === "video") placeOwnVideo({ mediaId: media.mediaId, durationMs: media.durationMs ?? 0 });
  }

  /** A track row of «Мои»: the music from its start (never one shorter than the montage), then selected. */
  function chooseOwnTrack(media: MediaSummary): void {
    const spec = session.state.spec;
    const edit = pickOwnTrack(spec, { mediaId: media.mediaId, durationMs: media.durationMs ?? 0 });
    if (!edit.ok) return;
    if (edit.spec !== spec && !session.edit(edit.spec)) return;
    timeline.select({ kind: "music" });
  }

  /** A click on a bin photo: a placed one selects its clip; a free one fills the selected empty cell or is appended. */
  function pickPhoto(photoId: string): void {
    const spec = session.state.spec;
    for (const [i, clip] of spec.clips.entries()) {
      const cell = cellsOf(clip).findIndex((c) => c.photo?.source === "scene" && c.photo.photoId === photoId);
      if (cell >= 0) {
        selectClipAt(i, cell);
        return;
      }
    }
    if (fillTarget !== null) fillCell(fillTarget.clip, fillTarget.cell, photoId);
    else placePhoto(photoId);
  }

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
    previewRefused,
    spec: state.spec,
    exportStatus: view.exportStatus,
    avatarActive: avatar?.status !== "archived",
    verdict,
    photos: photoIndex,
    usedVideo,
  });
  // A render of this draft that just ended moved its photos (one photo, one video): until a verdict read after that
  // end answers, the old one cannot be trusted, so «Рендер» stays busy instead of flashing ready.
  const verdictBehind = renderJob !== null && !isActiveJob(renderJob) && verdict.after !== renderKey;
  // ...unless that read failed: then the button is blocked with the reason, and «Повторить» reads it again.
  const verdictFailed = verdictBehind && verdictError !== null;
  // The answer may come before the job's first event (only the events and the snapshot promise it): until the store has
  // heard of the job the answer named, or, when no answer came, of a new render of this draft, the button stays busy.
  const heard = pending === null || (pending.jobId !== null ? view.jobs.some((j) => j.jobId === pending.jobId) : foundAfterSubmit(view.jobs, montageId, pending.known) !== null);
  useEffect(() => {
    if (pending !== null && heard) setPending(null);
  }, [pending, heard]);
  // An answer that never came: the job may exist. It is waited for a moment (the events and snapshot name it), and when none
  // shows, the owner is told it may have been queued; nothing is sent again on its own.
  useEffect(() => {
    if (pending === null || pending.jobId !== null || heard) return;
    return realScheduler.schedule(NO_ANSWER_GRACE_MS, () => {
      setPending(null);
      setRenderError(pending.silent);
    });
  }, [pending, heard]);

  const cancelling = cancelBusy || (renderJob !== null && view.cancellingJobs.has(renderJob.jobId));
  const control = renderControl({
    block: gone ? null : verdictFailed ? { text: "Черновик не удалось проверить после рендера", settings: false } : block,
    job: renderJob,
    jobs: view.jobs,
    submitting: submitting || !heard,
    verdictPending: verdictBehind && !verdictFailed,
    dismissed,
    cancelling,
  });

  // A new engine process (a new bootId) knows nothing of a submit made to the old one: an ok answer whose job event never came
  // would hold the button in «Рендер…» for ever. The jobs the new process has come with its snapshot.
  const { bootId } = view;
  useEffect(() => setPending(null), [bootId]);

  // The window's own lock: a click that lands before React shows the busy button still cannot send a second render.
  const submitLock = useRef(false);
  // The frames a refusal named describe the spec that was refused: an edit retires them.
  useEffect(() => setRefusedClips([]), [state.spec]);

  async function submitRender(): Promise<void> {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setRenderError(null);
    setRefusedClips([]);
    const known = new Set(view.jobs.map((j) => j.jobId));
    // The engine renders the draft as STORED: the newest edit must be there first.
    const flushed = await session.flush();
    if (!mounted.current) return;
    if (!flushed.ok) {
      submitLock.current = false;
      setSubmitting(false);
      setRenderError(flushed.error);
      return;
    }
    const reply = await client.request("videos.render", { montageId });
    if (!mounted.current) return;
    submitLock.current = false;
    setSubmitting(false);
    const outcome = classifyAnswer(reply);
    if (outcome.kind === "queued") setPending({ jobId: outcome.jobId, known, silent: null });
    else if (outcome.kind === "unknown") setPending({ jobId: null, known, silent: outcome.error });
    else {
      // A refusal queued nothing: asking again is safe. The engine's verdict is read again (it may name what changed).
      setRenderError(outcome.error);
      setRefusedClips(outcome.clips);
      setFocusTick((n) => n + 1);
    }
  }

  async function cancelRender(): Promise<void> {
    if (renderJob === null || cancelBusy) return;
    setCancelBusy(true);
    const reply = await client.request("videos.cancel", { jobId: renderJob.jobId });
    // The store is window-wide: it waits for the job's real end even if this editor is gone by now.
    if (reply.ok) store.markCancelling(renderJob.jobId);
    if (!mounted.current) return;
    setCancelBusy(false);
    if (!reply.ok) setRenderError(reply.error);
  }

  async function revealVideo(videoId: string): Promise<void> {
    setRevealing(true);
    setRevealError(null);
    const reply = await client.request("videos.reveal", { videoId });
    if (!mounted.current) return;
    setRevealing(false);
    if (!reply.ok) setRevealError(reply.error);
  }

  return (
    <TextPreviewsProvider queue={previewQueue}>
      <div className="editor">
        <EditorHeader
          session={session}
          title={{ avatar: avatar?.name ?? null }}
          fresh={created && state.saved.updatedAt === initial.updatedAt && renderJob === null}
          control={control}
          revealing={revealing}
          leaving={leaving}
          onBack={() => navigate({ name: "photos", avatarId })}
          onDrafts={() => navigate({ name: "montages" })}
          onRender={() => void submitRender()}
          onCancel={() => void cancelRender()}
          onReveal={(videoId) => void revealVideo(videoId)}
        />
        {/* Slice review 5-M1: the store went offline after the draft opened (the engine restarted while main could not answer). It drops the
            events until the owner retries, so a render's progress and its end would freeze unseen: said as on every other screen, with «Повторить». */}
        {view.phase === "offline" && (
          <div className="ed-notices">
            <EngineOffline view={view} />
          </div>
        )}
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
        {verdictFailed && verdictError !== null && (
          <div className="ed-notices">
            <ErrorNotice
              error={verdictError}
              actions={
                <button type="button" className="btn btn-s" onClick={() => setFocusTick((n) => n + 1)}>
                  Повторить
                </button>
              }
            />
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
                  quitRefused ? (
                    <>
                      <button type="button" className="btn btn-s" onClick={() => session.retry()}>
                        Сохранить ещё раз
                      </button>
                      <button
                        type="button"
                        className="btn btn-s btn-d"
                        onClick={() => {
                          allowClose.current = true;
                          quitWithoutSaving();
                        }}
                      >
                        Выйти без сохранения
                      </button>
                    </>
                  ) : closeRefused ? (
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
                      <button
                        type="button"
                        className="btn btn-s btn-d"
                        onClick={() => {
                          leftBehind.current = true;
                          navigate(blockedLeave, { force: true });
                        }}
                      >
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
        {(control.kind === "failed" || revealError !== null) && (
          <div className="ed-notices">
            {control.kind === "failed" && renderJob !== null && (
              <ErrorNotice
                error={control.error}
                actions={
                  <button type="button" className="btn btn-s" onClick={() => setDismissed(renderJob.jobId)}>
                    Закрыть
                  </button>
                }
              />
            )}
            {revealError !== null &&
              (revealError.code === "NOT_FOUND" ? (
                <Notice
                  tone="warn"
                  actions={
                    <button type="button" className="btn btn-s" onClick={() => setRevealError(null)}>
                      Закрыть
                    </button>
                  }
                >
                  Файла нет в папке «Готовые видео»: его удалили или переместили.
                </Notice>
              ) : (
                <ErrorNotice
                  error={revealError}
                  actions={
                    <button type="button" className="btn btn-s" onClick={() => setRevealError(null)}>
                      Закрыть
                    </button>
                  }
                />
              ))}
          </div>
        )}
        <div className="ed-body">
          <MediaPanel tab={tab} onTab={setTab} focusTick={tabFocus}>
            {tab === "photos" ? (
              <PhotoBin
                avatarName={avatar?.name ?? "Аватар"}
                avatarId={avatarId}
                spec={state.spec}
                photos={photos}
                filter={binFilter}
                onFilter={setBinFilter}
                onPick={pickPhoto}
                fillTarget={fillTarget}
                addBlock={addRefusal(state.spec)}
                onDragPhoto={(photoId) => setDrag(photoId === null ? null : { source: "scene", photoId })}
              />
            ) : tab === "mine" ? (
              <MineTabAtPlayhead
                timeline={timeline}
                spec={state.spec}
                fillTarget={fillTarget}
                addBlock={addRefusal(state.spec)}
                selectedSticker={currentOwnSticker}
                onPickVisual={pickOwnVisual}
                onDragVisual={setDrag}
                onPickTrack={chooseOwnTrack}
                onPickSticker={(mediaId) => void commands.addOwnSticker(mediaId)}
              />
            ) : tab === "music" ? (
              <MusicTab spec={state.spec} status={view.music} onPick={pickMusic} />
            ) : tab === "gif" ? (
              <StickerTabAtPlayhead
                timeline={timeline}
                spec={state.spec}
                current={currentSticker}
                replacing={replaceLive ? layerName(state.spec, replacingIndex) : null}
                onCancelReplace={() => setReplacing(null)}
                onPick={pickSticker}
                onOpenMine={() => openTab("mine")}
              />
            ) : (
              <TextTabAtPlayhead
                timeline={timeline}
                spec={state.spec}
                selected={selectedLayer?.kind === "text" ? selectedLayer.layerId : null}
                onAdd={(preset) => void commands.addText(preset)}
                onSelect={selectLayer}
              />
            )}
          </MediaPanel>
          <Preview
            session={session}
            spec={state.spec}
            timeline={timeline}
            focusPending={focus.pending}
            dragPhoto={dragCell}
            onFillCell={(clip, cell, key) => {
              setDrag(null);
              fillDropped(clip, cell, key);
            }}
            onSelectCell={(clip, cell) => selectClipAt(clip, cell)}
            videos={ownVideos}
            trimPeek={trimPeek}
          />
          {selected?.kind === "clip" ? (
            <ClipProperties
              session={session}
              spec={state.spec}
              index={selected.index}
              cell={selected.cell}
              avatarId={avatarId}
              timeline={timeline}
              focusPending={focus.pending}
              dragPhoto={dragCell}
              onFillCell={fillDropped}
              videos={ownVideos}
              videoProblems={clipVideoProblems}
              trimPeek={trimPeek}
            />
          ) : selected?.kind === "layer" ? (
            <LayerProperties
              session={session}
              spec={state.spec}
              index={selected.index}
              timeline={timeline}
              onReplaceSticker={(layerId) => {
                setReplacing(layerId);
                openTab("gif");
              }}
            />
          ) : selected?.kind === "music" ? (
            <MusicProperties session={session} spec={state.spec} timeline={timeline} lookup={musicLookup} listVersion={view.music?.listFetchedAt ?? null} verdict={musicVerdict} onOpenTab={openTab} />
          ) : (
            <PropertiesSlot empty={state.spec.clips.length === 0} />
          )}
        </div>
        <Timeline
          session={session}
          spec={state.spec}
          avatarId={avatarId}
          flagged={clipProblems}
          highlighted={block?.clips ?? refusedClips}
          flaggedLayers={flaggedLayers}
          musicLookup={musicLookup}
          musicListVersion={view.music?.listFetchedAt ?? null}
          musicVerdict={musicVerdict}
          timeline={timeline}
          dragPhoto={dragAny}
          onInsertPhoto={(key, boundary) => {
            setDrag(null);
            insertDropped(key, boundary);
          }}
          onAddClip={() => openTab("photos")}
          onAddMusic={() => openTab("music")}
          onAddSticker={() => openTab("gif")}
          onSelectClip={(index) => selectClipAt(index)}
          videos={ownVideos}
          videoProblems={clipVideoProblems}
        />
      </div>
    </TextPreviewsProvider>
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
  const sessions = useDraftSessions();
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
        } else {
          // A deleted draft has no editor to go on with.
          if (reply.error.code === "NOT_FOUND") sessions.forget(montageId);
          setLoad({ kind: "error", error: reply.error });
        }
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
  }, [ready, loaded, client, flushes, sessions, montageId, attempt]);

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
        <MediaStandIn />
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
