import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clipExportLineRu, EXPORT_UNAVAILABLE_REASONS_RU, type ClipSummary, type EngineError, type ExportUnavailableReason } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { EXPORT_UNAVAILABLE_TITLE } from "../../lib/exportFolder";
import { NBSP } from "../../lib/format";
import { clipUrl } from "../../lib/media";
import { useNavigate } from "../../navigation";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { Portrait, PortraitPlaceholder } from "../../ui/Portrait";
import { useMediaRetry } from "../../ui/useMediaRetry";
import { useBackdropClose, useModalDialog } from "../../ui/useModalDialog";
import { useMounted } from "../photos/shared";
import { viewerStep } from "../photos/viewerModel";
import { clipLength, costFact, exportFailureText, exportPercent, faceBadge, faceFact, modelFact, readyTags, savedExport } from "./clipModel";
import type { PhotoPlace } from "./clipsContext";
import { deleteOutcome } from "./clipUse";
import { DeleteClipDialog } from "./DeleteClipDialog";
import { motionRowLabel, showsEnglish } from "./motionModel";

// Stage 5, 5b.1, S5.V8: the clip viewer (mockups 43, 43a, 43b, 43c; plan s5b1 §6 43, §5.13; README §S5.VD decision 7, §S5.VD2 decisions 1–3). The photo viewer's card: the clip plays muted,
// in a loop, 9:16; beside it its facts as §6 words them (from which photo, the motion, the model, the cost, the face) and its actions. «Сохранить в папку» runs the export job (a
// re-encode, owner Q-C): the button keeps the focus while it saves (aria-disabled, never disabled), says «Сохраняем…», then «Сохраняем · N %» past 2 s with the bar under it, and a
// polite line says when it is done; then the green line names the file and says what it is. ← and → step through the ready clips, Escape and «Закрыть» close it.

type Ready = Extract<ClipSummary, { status: "ready" }>;

/** §5.13 «Progress»: the percent shows once an export runs past this (`clipTimings.exportProgressAfterMs`). */
export const EXPORT_PERCENT_AFTER_MS = 2_000;
/** The new string of VD2 (owner to confirm): the progress bar's name for a screen reader. */
const EXPORT_BAR_LABEL = "Сохранение клипа в папку";

export interface ClipViewerProps {
  readonly clip: Ready;
  readonly index: number;
  readonly total: number;
  readonly prevId: string | null;
  readonly nextId: string | null;
  readonly view: EngineView;
  /** The source photo in the gallery, or null; `galleryComplete` says whether null means it is gone. */
  readonly source: PhotoPlace | null;
  readonly galleryComplete: boolean;
  /** `settings.exportDisplay`: the export folder as a person reads it («~/Movies/Готовые видео»). */
  readonly rootDisplay: string | null;
  readonly onShow: (clipId: string) => void;
  readonly onClose: () => void;
  readonly onAgain: (photoId: string) => void;
  readonly onShowPhoto: (photoId: string) => void;
  readonly onDeleted: () => void;
  readonly onExportStarted: (jobId: string) => void;
  readonly onChanged: () => void;
  readonly returnFocus: (clipId: string) => HTMLElement | null;
  /** A dialog of the tab is open over this one (the sheet): its keys wait. */
  readonly covered: boolean;
}

/** «Готовые видео / Nini / 2026-10-11_clip_001.mp4»: the export folder's own name, then the file's place in it. */
export function savedPathLabel(rootDisplay: string | null, relPath: string): string {
  const parts = relPath.split("/");
  const root = rootDisplay === null ? null : (rootDisplay.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? null);
  return [...(root === null || root === "" ? [] : [root]), ...parts].join(" / ");
}

/** The newest export job of this clip, or null. */
function exportJobOf(jobs: readonly JobView[], clipId: string): JobView | null {
  return jobs.filter((job) => job.kind === "clip" && job.clip?.export === true && job.clip.clipId === clipId).at(-1) ?? null;
}

function ClipFrame({ clip, label }: { clip: Ready; label: string }) {
  const { client } = useEngine();
  const src = clipUrl(clip.avatarId, clip.clipId);
  const retry = useMediaRetry(src);
  const [at, setAt] = useState(0);
  const length = clipLength(clip.durationMs);
  const playable = client.kind !== "mock" && src !== null && !retry.failed && !retry.waiting;
  return (
    <div className="viewer-ph clip-frame">
      {playable ? (
        <video
          key={retry.key}
          className="clip-video"
          src={src}
          aria-label={label}
          autoPlay
          loop
          muted
          playsInline
          onError={retry.onError}
          onTimeUpdate={(event) => setAt(Math.round(event.currentTarget.currentTime * 1000))}
        />
      ) : (
        <PortraitPlaceholder seed={clip.clipId} label={label} />
      )}
      <div className="clip-hud" aria-hidden="true">
        <div className="clip-hud-bar">
          <span style={{ width: `${clip.durationMs > 0 ? Math.min(100, (at / clip.durationMs) * 100) : 0}%` }} />
        </div>
        <div className="clip-hud-row">
          <span className="mono">
            {clipLength(at)} / {length}
          </span>
          <span className="clip-hud-mute">
            <Icon name="soundOff" size={13} strokeWidth={2} />
            без звука · по кругу
          </span>
        </div>
      </div>
    </div>
  );
}

export function ClipViewer(props: ClipViewerProps) {
  const { clip, index, total, prevId, nextId, view, source, galleryComplete, rootDisplay, onShow, onClose, onAgain, onShowPhoto, onDeleted, onExportStarted, onChanged, returnFocus, covered } = props;
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const mounted = useMounted();
  const titleId = useId();
  const folderId = useId();
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** 5b.2 (44b): how many times «Удалить» was refused `in-use` (a render holds the clip's copy): the open dialog says so, again on each refusal (S5.WAR L7). */
  const [inRender, setInRender] = useState(0);
  const [refusal, setRefusal] = useState<EngineError | null>(null);
  const [revealError, setRevealError] = useState<EngineError | null>(null);
  const [revealing, setRevealing] = useState(false);
  /** The clip whose export request is on its way (until its job is known in the view). */
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [percentShown, setPercentShown] = useState<string | null>(null);
  const [news, setNews] = useState("");
  // The viewer stays mounted from clip to clip (a key would drop the focus), so what belongs to one clip is dropped when the clip changes — in the render that shows the new one.
  const [stateFor, setStateFor] = useState(clip.clipId);
  const clipIdRef = useRef(clip.clipId);
  clipIdRef.current = clip.clipId;
  if (stateFor !== clip.clipId) {
    setStateFor(clip.clipId);
    setRefusal(null);
    setRevealError(null);
    setInRender(0);
    setRevealing(false);
    setPercentShown(null);
    setNews("");
  }
  /** The export jobs this viewer started: only their end is announced. */
  const startedJobs = useRef(new Set<string>());
  /** What the last effect saw of the clip's export job: an end is news only when it is seen to come. */
  const lastSeen = useRef<{ clipId: string; jobId: string | null; status: string | null }>({ clipId: clip.clipId, jobId: null, status: null });
  useModalDialog({ dialog: dialogRef, initialFocus: closeRef, onClose, returnFocus: () => returnFocus(clip.clipId) });
  const backdrop = useBackdropClose(onClose, [scrimRef, dialogRef]);
  const coveredRef = useRef(covered || asking);
  coveredRef.current = covered || asking;

  // ← and →, wherever the focus is inside the viewer, while nothing is open over it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || coveredRef.current) return;
      const direction = viewerStep(event);
      if (direction === null) return;
      event.preventDefault();
      const target = direction === "prev" ? prevId : nextId;
      if (target !== null) onShow(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevId, nextId, onShow]);

  // A clip opened is seen: «новый» and the tab's count go (`clips.markSeen`, free).
  useEffect(() => {
    if (clip.seen) return;
    void client.request("clips.markSeen", { avatarId: clip.avatarId, clipId: clip.clipId }).then((reply) => {
      if (reply.ok) onChanged();
    });
  }, [client, clip.avatarId, clip.clipId, clip.seen]);

  const job = exportJobOf(view.jobs, clip.clipId);
  const running = sentFor === clip.clipId || (job !== null && isActiveJob(job));
  const runningId = job !== null && isActiveJob(job) ? job.jobId : null;
  // Past 2 s an export says how far it is (§5.13); a fast one finishes before.
  useEffect(() => {
    if (runningId === null) return;
    const timer = setTimeout(() => setPercentShown(runningId), EXPORT_PERCENT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [runningId]);
  const percent = job !== null && runningId !== null && percentShown === runningId ? exportPercent(job.done, job.total) : null;
  const failure = !running && job !== null && job.status === "failed" && job.error !== null ? job.error : null;

  // Its end, said politely where the button is (the green line and the warning say it on screen).
  const jobStatus = job?.status ?? null;
  const jobId = job?.jobId ?? null;
  useEffect(() => {
    const before = lastSeen.current;
    lastSeen.current = { clipId: clip.clipId, jobId, status: jobStatus };
    // Not on arriving at a clip (opened, or stepped onto), not for a job another visit started, not twice for one end.
    if (before.clipId !== clip.clipId || jobId === null || !startedJobs.current.has(jobId) || (before.jobId === jobId && before.status === jobStatus)) return;
    if (jobStatus === "done") setNews("Клип сохранён в папку.");
    else if (jobStatus === "failed") setNews("Клип не сохранён в папку.");
  }, [clip.clipId, jobStatus, jobId]);

  const saved = savedExport(clip);
  const exportStatus = view.exportStatus;
  // The general state of the folder is the store's: it locks the button, and a folder that is back lets it work again. A refusal of THIS clip (the engine judges the size: «не хватает
  // места» never enters the general status) shows its reason for this clip only and locks nothing; the next click asks again.
  const storeReason: ExportUnavailableReason | null = exportStatus?.status === "unavailable" ? exportStatus.reason : null;
  const refusedReason: ExportUnavailableReason | null = refusal?.code === "EXPORT_UNAVAILABLE" && refusal.exportReason !== undefined ? refusal.exportReason : null;
  const folderReason = storeReason ?? refusedReason;
  const saveWaits = running || storeReason !== null;
  // Once the store has its own word on the folder (it went away, or came back), a refusal of the folder is old news.
  useEffect(() => {
    setRefusal((now) => (now?.code === "EXPORT_UNAVAILABLE" ? null : now));
  }, [storeReason]);

  async function save(): Promise<void> {
    if (saveWaits) return;
    setSentFor(clip.clipId);
    setRefusal(null);
    setNews("Сохраняем клип в папку…");
    const asked = clip.clipId;
    const reply = await client.request("clips.export", { avatarId: clip.avatarId, clipId: clip.clipId });
    if (reply.ok) {
      startedJobs.current.add(reply.result.jobId);
      store.trackClipJob(reply.result.jobId, clip.avatarId, clip.clipId, "export");
      onExportStarted(reply.result.jobId);
    } else if (reply.error.code === "EXPORT_UNAVAILABLE") void store.recheckExport({ force: true });
    // The viewer may be on another clip by now: the answer is not its news.
    if (!mounted.current) return;
    setSentFor((now) => (now === asked ? null : now));
    if (clipIdRef.current !== asked) return;
    if (!reply.ok) {
      setNews("");
      setRefusal(reply.error);
    }
  }

  async function reveal(): Promise<void> {
    setRevealing(true);
    setRevealError(null);
    const reply = await client.request("clips.reveal", { avatarId: clip.avatarId, clipId: clip.clipId });
    if (!mounted.current) return;
    setRevealing(false);
    if (!reply.ok) {
      setRevealError(reply.error);
      onChanged();
    }
  }

  async function remove(): Promise<void> {
    setDeleting(true);
    const reply = await client.request("clips.delete", { avatarId: clip.avatarId, clipId: clip.clipId });
    if (!mounted.current) return;
    setDeleting(false);
    const outcome = deleteOutcome(reply);
    // 5b.2 (44b `#in-render`): a render holds the clip's copy: the dialog stays and says so; a try after the render is harmless.
    if (outcome.kind === "in-render") {
      setInRender((n) => n + 1);
      return;
    }
    setAsking(false);
    if (outcome.kind === "deleted") onDeleted();
    else setRevealError(outcome.error);
  }

  const face = faceFact(clip.face);
  const label = `Клип ${index + 1} из ${total}: ${clip.motion.label}`;
  const tags = readyTags(clip);
  const badge = faceBadge(clip.face);
  const saveLabel =
    running && percent !== null ? (
      <>
        Сохраняем · <span className="mono">{`${percent}${NBSP}%`}</span>
      </>
    ) : running ? (
      "Сохраняем…"
    ) : (
      "Сохранить в папку"
    );

  return createPortal(
    <div ref={scrimRef} className="viewer-scrim" role="presentation" {...backdrop}>
      <div ref={dialogRef} className="viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <button type="button" className="viewer-nav" aria-label="Предыдущий клип" aria-keyshortcuts="ArrowLeft" disabled={prevId === null} onClick={() => prevId !== null && onShow(prevId)}>
          <Icon name="back" size={20} strokeWidth={2.2} />
        </button>
        <div className="viewer-card">
          <div className="viewer-frame">
            <ClipFrame key={clip.clipId} clip={clip} label={label} />
          </div>
          <div className="viewer-side">
            <header className="viewer-head">
              <div className="viewer-title-row">
                <h2 id={titleId} className="viewer-title">
                  Клип {index + 1} из {total}
                </h2>
                <button ref={closeRef} type="button" className="ibtn" aria-label="Закрыть" aria-keyshortcuts="Escape" onClick={onClose}>
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="viewer-meta">
                {source !== null && <span className="tag viewer-category">{source.label}</span>}
                <span className={badge.kind === "low" ? "pill photo-badge clip-face-low" : badge.kind === "none" ? "pill mono photo-badge photo-face-none" : "pill mono photo-badge photo-face"}>{badge.text}</span>
                {tags.map((tag) => (
                  <span key={tag} className="pill clip-tag clip-tag-meta">
                    {tag}
                  </span>
                ))}
              </div>
            </header>
            <dl className="clip-facts">
              <div className={source === null && galleryComplete ? "clip-fact clip-fact-quiet" : "clip-fact"}>
                <dt>Из фото</dt>
                <dd>
                  {source !== null ? (
                    <button type="button" className="clip-src" onClick={() => onShowPhoto(clip.photoId)}>
                      <span className="ph clip-src-thumb" aria-hidden="true">
                        <Portrait avatarId={clip.avatarId} photoId={clip.photoId} label="" />
                      </span>
                      <span>
                        Фото {source.position} · {source.label}
                      </span>
                    </button>
                  ) : (
                    <span className="clip-src-gone">{galleryComplete ? "исходное фото удалено" : "исходное фото здесь не показано"}</span>
                  )}
                </dd>
              </div>
              <div className="clip-fact">
                <dt>Движение</dt>
                <dd>
                  {/* S5.WC5b: the sheet's rule — an own idea is «Своя идея: …», and the English shows for the scene and for what a model wrote (a suggestion, an own idea). */}
                  {motionRowLabel(clip.motion)}
                  {showsEnglish(clip.motion) && (
                    <span className="clip-en" lang="en">
                      {clip.motion.text}
                    </span>
                  )}
                </dd>
              </div>
              <div className="clip-fact">
                <dt>Модель</dt>
                <dd>{modelFact(clip)}</dd>
              </div>
              <div className="clip-fact">
                <dt>Стоимость</dt>
                <dd>{costFact(clip)}</dd>
              </div>
              <div className={face.tone === "ok" ? "clip-fact" : `clip-fact clip-fact-${face.tone}`}>
                <dt>Лицо</dt>
                <dd>
                  {face.value !== null ? (
                    <>
                      <span className="mono">{face.value}</span> <span className="faint">{face.text}</span>
                    </>
                  ) : (
                    face.text
                  )}
                </dd>
              </div>
            </dl>

            <div className="viewer-actions" data-export-root="">
              {failure !== null && (
                <div className="clip-export-warn clip-export-fail" role="alert">
                  <Icon name="alert" size={15} strokeWidth={2} />
                  <span>{exportFailureText(failure)}</span>
                </div>
              )}
              {folderReason !== null && (
                <div className="clip-export-warn" id={folderId} role="status">
                  <b>{EXPORT_UNAVAILABLE_TITLE}</b>
                  <span>{EXPORT_UNAVAILABLE_REASONS_RU[folderReason]}</span>
                  <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus: "export" })}>
                    Открыть папку в Настройках
                  </button>
                </div>
              )}
              {refusal !== null && refusal.code !== "EXPORT_UNAVAILABLE" && <p className="viewer-error">{errorText(refusal)}</p>}
              {saved !== null && !running && (
                <p className="clip-saved" role="status">
                  <Icon name="check" size={14} strokeWidth={2.6} />
                  <span>
                    Сохранено: <span className="mono">{savedPathLabel(rootDisplay, saved.relPath)}</span>
                    <span className="clip-saved-line">{clipExportLineRu(saved.profile)}</span>
                  </span>
                </p>
              )}
              {saved !== null && !running && (
                <button type="button" className="btn btn-s" aria-busy={revealing || undefined} onClick={() => void reveal()}>
                  {revealing && <Spin />}
                  Открыть в папке
                </button>
              )}
              {/* One button through the whole save: busy is aria-disabled, never disabled, so it keeps the focus (the review's note). */}
              <button
                ref={saveRef}
                type="button"
                className={saved === null || running ? "btn btn-s btn-p clip-save" : "btn btn-s clip-save"}
                aria-busy={running || undefined}
                aria-disabled={saveWaits || undefined}
                aria-describedby={folderReason !== null ? folderId : undefined}
                onClick={() => void save()}
              >
                {running ? <Spin /> : <Icon name="folder" size={14} strokeWidth={1.9} />}
                <span>{saveLabel}</span>
              </button>
              {percent !== null && (
                <div className="bar clip-export-bar" role="progressbar" aria-label={EXPORT_BAR_LABEL} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <span style={{ width: `${percent}%` }} />
                </div>
              )}
              <p className="sr-only" aria-live="polite">
                {news}
              </p>
              {revealError !== null && <p className="viewer-error">{errorText(revealError)}</p>}
              <button type="button" className="btn btn-s" aria-haspopup="dialog" onClick={() => onAgain(clip.photoId)}>
                <Icon name="sparkle" size={14} strokeWidth={2} />
                Оживить снова…
              </button>
              <button type="button" className="btn btn-s clip-del" aria-haspopup="dialog" onClick={() => setAsking(true)}>
                <Icon name="trash" size={14} />
                Удалить
              </button>
            </div>
            <p className="viewer-keys" aria-hidden="true">
              <kbd>←</kbd>
              <kbd>→</kbd> листать · <kbd>Esc</kbd> закрыть
            </p>
          </div>
        </div>
        <button type="button" className="viewer-nav" aria-label="Следующий клип" aria-keyshortcuts="ArrowRight" disabled={nextId === null} onClick={() => nextId !== null && onShow(nextId)}>
          <Icon name="forward" size={20} strokeWidth={2.2} />
        </button>
        <FocusEdge edge="end" />
        {asking && (
          <DeleteClipDialog
            saved={saved !== null}
            busy={deleting}
            use={clip.use}
            inRender={inRender}
            onCancel={() => {
              setAsking(false);
              setInRender(0);
            }}
            onDelete={() => void remove()}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
