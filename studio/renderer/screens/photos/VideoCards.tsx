import { useId, useRef, useState, type ReactNode } from "react";
import type { ExportStatus, Montage, TrackSummary, VideoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { percentOf, renderPhase, rendersAhead } from "../../engine/renderJobs";
import type { JobView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { countOf, NBSP } from "../../lib/format";
import { coverUrl, placeholderGradient, posterUrl } from "../../lib/media";
import { Icon, PlayIcon, Spin } from "../../ui/Icon";
import { cancelOnEscape, useConfirmFocus } from "../../ui/useConfirmFocus";
import { useMediaRetry } from "../../ui/useMediaRetry";
import { ClipPoster } from "../montage/ClipPoster";
import { draftMeta, draftName, whenLabel } from "../montage/labels";
import { DeleteVideoDialog } from "./DeleteVideoDialog";
import { durationPill, failedRenderLine, videoCardView, videoMeta } from "./videosModel";

// 3e.2: the cards of the avatar's «Видео» tab (AvatarVideos.dc.html, card variants from the components sheet): a record in its
// file state, and a render job queued, running, saving or failed. The tab owns the commands; a card only asks for them.

const RENDER_FORMS = ["рендера", "рендеров", "рендеров"] as const;

/** The poster of a card: the record's poster frame when it has one, else its first clip as rendered (the drafts' still), else a stand-in. S4.9c: the launch's results draw it too. */
export function Poster({ avatarId, videoId, hasPoster, clip, children }: { avatarId: string; videoId: string | null; hasPoster: boolean; clip: VideoSummary["firstClip"]; children?: ReactNode }) {
  const { client } = useEngine();
  const address = hasPoster && videoId !== null && client.kind !== "mock" ? posterUrl(avatarId, videoId) : null;
  const retry = useMediaRetry(address);
  const poster = retry.failed ? null : address;
  return (
    <div className="ph video-poster" aria-hidden="true">
      {poster !== null ? (
        <img key={retry.key} className="video-poster-img" src={poster} alt="" decoding="async" loading="lazy" onError={retry.onError} />
      ) : clip !== null ? (
        <ClipPoster clip={clip} avatarId={avatarId} />
      ) : (
        <div className="video-poster-none" style={{ background: placeholderGradient(videoId ?? avatarId) }} />
      )}
      {children}
    </div>
  );
}

/** «Birds of a Feather · Billie Eilish» with the track's cover and its «E»; «без музыки» for a silent video. */
function MusicLine({ music, tracks }: { music: VideoSummary["music"]; tracks: ReadonlyMap<string, TrackSummary> }) {
  const { client } = useEngine();
  const track = music === null || music.trackId === null ? undefined : tracks.get(music.trackId);
  const address = music !== null && music.trackId !== null && track?.hasCover === true && client.kind !== "mock" ? coverUrl(music.trackId) : null;
  const retry = useMediaRetry(address);
  if (music === null) return <span className="faint video-nomusic">без музыки</span>;
  const cover = retry.failed ? null : address;
  const text = music.artist === null ? music.title : `${music.title} · ${music.artist}`;
  return (
    <div className="video-music">
      {cover === null ? (
        <span className="video-cover" aria-hidden="true" style={{ background: placeholderGradient(music.trackId ?? music.title) }} />
      ) : (
        <img key={retry.key} className="video-cover" src={cover} alt="" loading="lazy" onError={retry.onError} />
      )}
      <span className="muted video-music-text" lang="en">
        {text}
      </span>
      {track?.explicit === true && (
        <span className="e-badge" role="img" aria-label="explicit">
          E
        </span>
      )}
    </div>
  );
}

export interface VideoCardProps {
  video: VideoSummary;
  exportStatus: ExportStatus | null;
  tracks: ReadonlyMap<string, TrackSummary>;
  now: Date;
  /** A command of this card is out (a delete, a reveal): its buttons wait. */
  busy: boolean;
  /** S4.9c: its place among the avatar's videos counted from the oldest: a video of the autopilot, which has no draft, is «Видео N» by it. */
  ordinal: number;
  /** S4.9c: the owner's «Опубликовано» mark as the list could read it (an unreadable log shows none), and a mark on its way. */
  published: boolean;
  publishing: boolean;
  /** The avatar's marks could not be read: the delete dialog says so (fix round 1). */
  marksUnknown: boolean;
  onPlay: (video: VideoSummary) => void;
  onReveal: (video: VideoSummary) => void;
  onEdit: (montageId: string) => void;
  /** `reject` (S4.9c): «Удалить видео и отклонить фото», the video's photos rejected before it goes. */
  onDelete: (video: VideoSummary, mode: "video" | "record", reject: boolean) => void;
  onPublished: (video: VideoSummary, published: boolean) => void;
  onRecheck: () => void;
}

/**
 * S4.9c: what a record is called in a sentence — «видео «утро дома»» by its draft's name, «видео 12» for a video of the autopilot (no draft: `ordinal`, its
 * place among the avatar's videos counted from the oldest, as PhotoVideos numbers them), else «видео 003» by its file's number.
 */
export function videoLabel(video: VideoSummary, ordinal: number): string {
  if (video.title !== null) return `видео «${video.title}»`;
  if (video.origin === "autopilot") return `видео ${ordinal}`;
  return `видео ${video.relPath.slice(video.relPath.lastIndexOf("_") + 1, -".mp4".length)}`;
}

/** One video record, in its file state (A23-A31; the states no artboard draws in the same language). */
export function VideoCard({ video, exportStatus, tracks, now, busy, ordinal, published, publishing, marksUnknown, onPlay, onReveal, onEdit, onDelete, onPublished, onRecheck }: VideoCardProps) {
  const titleId = useId();
  const [asking, setAsking] = useState<"record" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const view = videoCardView(video, exportStatus);
  const number = video.relPath.slice(video.relPath.lastIndexOf("_") + 1, -".mp4".length);
  const autopilot = video.origin === "autopilot";
  // A video of the autopilot has no draft and so no name of its own: it is «Видео 12» by its place among the avatar's videos (PhotoVideos).
  const name = autopilot && video.title === null ? `Видео ${ordinal}` : draftName(video.title);
  const edit =
    video.montageId === null ? null : (
      <button type="button" className="btn btn-s" disabled={busy} onClick={() => onEdit(video.montageId ?? "")}>
        Изменить
      </button>
    );
  // Slice review 5-M4: the confirmation keeps the keyboard's place (Settings' pattern): asked, the focus is on «Отмена»; cancelled, it goes back
  // to the button that asked («Удалить запись», which is mounted again). S4.9c: the trash asks in a dialog with two ways (README decision 11), which gives
  // the focus back to the trash itself.
  const focus = useConfirmFocus();
  const trashRef = useRef<HTMLButtonElement>(null);
  const recordRef = useRef<HTMLButtonElement>(null);
  const ask = (mode: "video" | "record"): void => {
    if (asking !== null || deleting || busy) return;
    if (mode === "video") setDeleting(true);
    else if (view.recordDelete?.confirm === null) onDelete(video, "record", false);
    else {
      setAsking(mode);
      focus.opened();
    }
  };
  const cancel = (): void => {
    setAsking(null);
    focus.moveTo(() => recordRef.current);
  };
  const confirmText = asking === "record" ? (view.recordDelete?.confirm ?? null) : null;
  return (
    <article className={asking !== null ? "card video-card video-card-asking" : "card video-card"} aria-labelledby={titleId} aria-busy={busy}>
      <div className="video-poster-wrap">
        <Poster avatarId={video.avatarId} videoId={video.videoId} hasPoster={video.hasPoster} clip={video.firstClip}>
          {view.dim && <span className="video-poster-dim" />}
          {view.pill !== null && <span className={`pill video-pill video-pill-${view.pill.tone}`}>{view.pill.text}</span>}
          {published && (
            <span className="video-pub-mark" title="Опубликовано">
              <Icon name="check" size={11} strokeWidth={3.4} />
            </span>
          )}
          <span className="pill mono video-len">{durationPill(video.durationMs)}</span>
        </Poster>
        {view.canPlay && (
          <button type="button" className="video-play" aria-label={`Смотреть видео «${name}»`} onClick={() => onPlay(video)}>
            <PlayIcon size={16} />
          </button>
        )}
      </div>
      <div className="video-body">
        <div className="video-top">
          <div className="video-heading">
            <span className="video-name-row">
              <h3 id={titleId} className="video-name">
                {name}
              </h3>
              {autopilot && (
                <span className="tag video-ap-tag">
                  <Icon name="bolt" size={9} />
                  автопилот
                </span>
              )}
            </span>
            <span className="mono faint video-when">{whenLabel(video.createdAt, now)}</span>
          </div>
          {view.trash && (
            <button
              ref={trashRef}
              type="button"
              className={deleting ? "ibtn video-trash video-trash-on" : "ibtn video-trash"}
              aria-label={autopilot && video.title === null ? `Удалить видео ${ordinal}` : `Удалить видео ${number}`}
              aria-haspopup="dialog"
              aria-disabled={busy || asking !== null || deleting}
              onClick={() => ask("video")}
            >
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
        <span className="mono muted">{videoMeta(video)}</span>
        <MusicLine music={video.music} tracks={tracks} />
        {confirmText !== null ? (
          <>
            <span role="alert" className="video-status video-confirm-text">
              {confirmText}
            </span>
            <div className="video-actions" onKeyDown={(e) => cancelOnEscape(e, cancel, busy)}>
              <button type="button" className="btn btn-s btn-d" disabled={busy} onClick={() => onDelete(video, "record", false)}>
                {busy && <Spin />}
                Удалить запись
              </button>
              <button ref={focus.cancelRef} type="button" className="btn btn-s" disabled={busy} onClick={cancel}>
                Отмена
              </button>
            </div>
          </>
        ) : (
          <>
            <span className={`video-status video-status-${view.status.tone}`}>{view.status.text}</span>
            {/* S4.9c (PhotoVideos): the owner's «Опубликовано», on every video; Studio deletes nothing by it. */}
            <span className={published ? "video-pub video-pub-on" : "video-pub"}>
              <button
                type="button"
                className={published ? "sw sw-s sw-on" : "sw sw-s"}
                role="switch"
                aria-checked={published}
                aria-label={`Опубликовано: ${name}`}
                aria-busy={publishing || undefined}
                onClick={publishing ? undefined : () => onPublished(video, !published)}
              />
              <span aria-hidden="true">Опубликовано</span>
            </span>
            <div className="video-actions">
              {view.canReveal && (
                <button type="button" className="btn btn-s" disabled={busy} onClick={() => onReveal(video)}>
                  Открыть в папке
                </button>
              )}
              {view.recheck && (
                <button type="button" className="btn btn-s" disabled={busy} onClick={onRecheck}>
                  Проверить снова
                </button>
              )}
              {view.recordDelete !== null && (
                <button ref={recordRef} type="button" className="btn btn-s" disabled={busy} onClick={() => ask("record")}>
                  {busy && <Spin />}
                  Удалить запись
                </button>
              )}
              {edit}
            </div>
          </>
        )}
      </div>
      {deleting && (
        <DeleteVideoDialog
          label={videoLabel(video, ordinal)}
          published={published}
          marksUnknown={marksUnknown}
          photos={video.photoCount}
          busy={false}
          onCancel={() => setDeleting(false)}
          onDelete={(choice) => {
            setDeleting(false);
            onDelete(video, "video", choice === "reject");
          }}
          returnFocus={() => trashRef.current}
        />
      )}
    </article>
  );
}

export interface JobCardProps {
  job: JobView;
  jobs: readonly JobView[];
  /** The draft it was rendered from, when it is still there: its name, its first clip and its summary. */
  draft: Montage | null;
  cancelling: boolean;
  /** A retry of this card is out. */
  retrying: boolean;
  onCancel: (job: JobView) => void;
  onRetry: (job: JobView) => void;
  onEdit: (montageId: string) => void;
  onDismiss: (job: JobView) => void;
}

/** A render on its way or failed (A15-A22), drawn from the same job model as the editor's button and the drafts screen (3d.6). */
export function JobCard({ job, jobs, draft, cancelling, retrying, onCancel, onRetry, onEdit, onDismiss }: JobCardProps) {
  const titleId = useId();
  const phase = renderPhase(job);
  const name = draftName(draft?.name ?? null);
  const clip = draft?.spec.clips[0] ?? null;
  const percent = percentOf(job.done, job.total);
  // The frames of the finished video: 30 a second.
  const length = job.total > 0 ? durationPill(Math.round((job.total * 1000) / 30)) : null;
  const failed = phase === "failed";
  const pill =
    phase === "queued"
      ? { text: "В очереди", tone: "muted" }
      : phase === "saving"
        ? { text: "Сохранение…", tone: "accent" }
        : phase === "failed"
          ? { text: "Не собралось", tone: "danger" }
          : { text: `Рендер · ${percent}${NBSP}%`, tone: "accent" };
  const ahead = rendersAhead(jobs, job);
  return (
    <article className={failed ? "card video-card video-card-failed" : "card video-card"} aria-labelledby={titleId}>
      <div className="video-poster-wrap">
        <Poster avatarId={job.avatarId} videoId={job.videoId} hasPoster={false} clip={clip}>
          {(phase === "rendering" || phase === "saving") && <div className="shim" />}
          {failed && (
            <span className="video-poster-alert">
              <Icon name="alert" size={22} />
            </span>
          )}
          <span className={`pill video-pill video-pill-${pill.tone}`}>{pill.text}</span>
          {length !== null && <span className="pill mono video-len">{length}</span>}
        </Poster>
      </div>
      <div className="video-body">
        <div className="video-top">
          <div className="video-heading">
            <h3 id={titleId} className="video-name">
              {name}
            </h3>
            <span className="mono faint video-when">{phase === "queued" ? "в очереди" : failed ? "не собралось" : "сейчас"}</span>
          </div>
          {failed && (
            <button type="button" className="ibtn video-trash" aria-label={`Убрать карточку «${name}»`} onClick={() => onDismiss(job)}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
        {draft !== null && <span className="mono muted">{draftMeta(draft.spec)}</span>}
        {phase === "rendering" && (
          <>
            <div className="video-progress">
              <div className="video-progress-row">
                <span>Рендер</span>
                <span className="mono">
                  кадр {job.done} из {job.total}
                </span>
              </div>
              <div className="bar" role="progressbar" aria-label={`Рендер: ${name}`} aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done}>
                <span style={{ width: `${percent}%` }} />
              </div>
            </div>
            <div className="video-actions">
              <button type="button" className="btn btn-s" disabled={cancelling} onClick={() => onCancel(job)}>
                {cancelling && <Spin />}
                {cancelling ? "Отменяем…" : "Отменить"}
              </button>
            </div>
          </>
        )}
        {phase === "saving" && (
          <>
            <span className="video-status video-status-accent">Сохранение в «Готовые видео»…</span>
            <div className="video-actions">
              <button type="button" className="btn btn-s" disabled title="Видео уже сохраняется: отменить его нельзя">
                Отменить
              </button>
            </div>
          </>
        )}
        {phase === "queued" && (
          <>
            <span className="muted video-status">{ahead === 0 ? "в очереди · следующий" : `в очереди · после ${countOf(ahead, RENDER_FORMS)}`}</span>
            <div className="video-actions">
              <button type="button" className="btn btn-s" disabled={cancelling} onClick={() => onCancel(job)}>
                {cancelling && <Spin />}
                {cancelling ? "Убираем…" : "Убрать из очереди"}
              </button>
            </div>
          </>
        )}
        {failed && (
          <>
            <span className="video-status video-status-danger" title={job.error === null ? undefined : errorText(job.error)}>
              {failedRenderLine(job.error ?? { code: "INTERNAL" })}
            </span>
            <div className="video-actions">
              {job.montageId !== null && draft !== null && (
                <button type="button" className="btn btn-s" onClick={() => onEdit(job.montageId ?? "")}>
                  Изменить
                </button>
              )}
              {job.montageId !== null && draft !== null && (
                <button type="button" className="btn btn-s" disabled={retrying} onClick={() => onRetry(job)}>
                  {retrying && <Spin />}
                  Повторить
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
