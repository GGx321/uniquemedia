import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EXPORT_UNAVAILABLE_REASONS_RU, type AvatarSummary, type EngineError, type Montage, type TrackSummary, type VideoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { classifyAnswer } from "../../engine/renderJobs";
import type { EngineView, JobView } from "../../engine/store";
import { EXPORT_UNAVAILABLE_TITLE } from "../../lib/exportFolder";
import { useNavigate } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { useMounted } from "./shared";
import { JobCard, VideoCard, videoLabel } from "./VideoCards";
import { VideoPlayer } from "./VideoPlayer";
import { deleteFailedText, rejectDoneText } from "./deleteVideo";
import { avatarFolderDisplay, deleteOutcomeText, filterCounts, megabytesLabel, renderCardsOf, visibleItems, type VideoFilter } from "./videosModel";

// 3e.2: the avatar's «Видео» tab (AvatarVideos.dc.html). The records come from `videos.list` (each with its file's state, looked
// at on that read) and are read again when the store applies a `video.changed` of this avatar, when it resyncs, and when the
// export folder's status moves (every record is judged against that folder). The render jobs come from the store's job model
// (3d.6): queued, running, saving and failed renders are cards of their own, ahead of the records. Every command names ids only.

const FILTERS: readonly { id: VideoFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "work", label: "В работе" },
  { id: "failed", label: "С ошибкой" },
];

interface Listed {
  readonly videos: readonly VideoSummary[];
  /** S4.9c: whether the owner's «Опубликовано» marks could be read (`videos.list.published`; absent from an older producer, read as `ok`). */
  readonly marks: "ok" | "unknown";
}

export function VideosTab({ avatar, view }: { avatar: AvatarSummary; view: EngineView }) {
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const mounted = useMounted();
  const titleId = useId();
  const { avatarId } = avatar;
  const ready = view.phase === "ready";

  const heading = useRef<HTMLHeadingElement>(null);
  const [listed, setListed] = useState<Listed | null>(null);
  const [listError, setListError] = useState<EngineError | null>(null);
  const [reread, setReread] = useState(0);
  const [filter, setFilter] = useState<VideoFilter>("all");
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: "ok" | "info"; text: string } | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  /** S4.9c: «Удалить видео и отклонить фото» that did not go, in its own words (its work may still go on). */
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const [publishing, setPublishing] = useState<ReadonlySet<string>>(new Set());
  const [hidePublished, setHidePublished] = useState(false);
  const [playing, setPlaying] = useState<VideoSummary | null>(null);
  const [rootDisplay, setRootDisplay] = useState<string | null>(null);
  const [tracks, setTracks] = useState<ReadonlyMap<string, TrackSummary>>(new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Montage>>(new Map());
  const [draftsRead, setDraftsRead] = useState(0);
  const [opening, setOpening] = useState(false);

  // The export folder's status as every window knows it (the snapshot, then `export.status`): the records are judged against it.
  const exportKey = view.exportStatus === null ? "none" : view.exportStatus.status === "ok" ? "ok" : `unavailable:${view.exportStatus.reason}`;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("videos.list", { avatarId }).then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setListed({ videos: reply.result.videos, marks: reply.result.published ?? "ok" });
        setListError(null);
      } else setListError(reply.error);
    });
    return () => {
      alive = false;
    };
  }, [ready, client, avatarId, reread, exportKey]);

  // A record of this avatar landed or went (or the store had to resync): read the list again.
  useEffect(
    () =>
      store.subscribeVideos((signal) => {
        if (signal.change === "resynced" || (signal.change === "upserted" ? signal.video.avatarId : signal.avatarId) === avatarId) setReread((n) => n + 1);
      }),
    [store, avatarId],
  );

  // The export folder as a person reads it, asked again whenever the settings name another one.
  const exportPath = view.settings?.exportPath ?? null;
  useEffect(() => {
    if (!ready || exportPath === null) return;
    let alive = true;
    void client.request("settings.exportDisplay", {}).then((reply) => {
      if (alive) setRootDisplay(reply.ok ? reply.result.display : null);
    });
    return () => {
      alive = false;
    };
  }, [ready, client, exportPath]);

  // The covers and «E» of the tracks the videos use: `music.list` is free and reads only what is on disk.
  const usesTracks = (listed?.videos ?? []).some((v) => v.music !== null && v.music.trackId !== null);
  useEffect(() => {
    if (!ready || !usesTracks) return;
    let alive = true;
    void client.request("music.list", {}).then((reply) => {
      if (alive && reply.ok) setTracks(new Map(reply.result.tracks.map((t) => [t.trackId, t])));
    });
    return () => {
      alive = false;
    };
  }, [ready, client, usesTracks]);

  const cards = useMemo(() => renderCardsOf(view.jobs, avatarId, dismissed), [view.jobs, avatarId, dismissed]);

  // The drafts the render cards came from: their names, first clips and summaries. Read again when a draft changes.
  const wantsDrafts = cards.some((job) => job.montageId !== null);
  useEffect(() => (wantsDrafts ? store.subscribeMontages(() => setDraftsRead((n) => n + 1)) : undefined), [store, wantsDrafts]);
  useEffect(() => {
    if (!ready || !wantsDrafts) return;
    let alive = true;
    void client.request("montages.list", { avatarId }).then((reply) => {
      if (alive && reply.ok) setDrafts(new Map(reply.result.items.map((item) => [item.montage.montageId, item.montage])));
    });
    return () => {
      alive = false;
    };
  }, [ready, client, avatarId, wantsDrafts, draftsRead]);

  const markBusy = (id: string, on: boolean): void =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function remove(video: VideoSummary, mode: "video" | "record", reject: boolean): Promise<void> {
    // Said after it is gone: its name as the card showed it.
    const label = videoLabel(video, ordinalOf(video));
    markBusy(video.videoId, true);
    setError(null);
    setNotice(null);
    setFailure(null);
    const reply = await client.request("videos.delete", { videoId: video.videoId, mode, ...(reject ? { rejectPhotos: true as const } : {}) });
    if (!mounted.current) return;
    markBusy(video.videoId, false);
    if (!reply.ok) {
      if (reject) {
        // S4.9c: a delete that timed out reads as refused while its work may still go on (the photos already rejected): the list and the photos are read again.
        setFailure(deleteFailedText(reply.error, true));
        void store.refreshAvatars();
      } else setError(reply.error);
      setReread((n) => n + 1);
      return;
    }
    // The card goes with the `video.changed` that follows, and the focus with it: the tab's heading takes it (slice review 5-M4). What happened
    // to the file is said here, as the answer says it.
    heading.current?.focus();
    if (reject) {
      setNotice({ tone: "ok", text: rejectDoneText(label, reply.result) });
      return;
    }
    const text = deleteOutcomeText(mode, reply.result, view.exportStatus);
    if (text !== null) setNotice({ tone: reply.result.fileDeleted || mode === "record" ? "ok" : "info", text });
  }

  async function markPublished(video: VideoSummary, published: boolean): Promise<void> {
    if (publishing.has(video.videoId)) return;
    setPublishing((now) => new Set(now).add(video.videoId));
    setError(null);
    const reply = await client.request("videos.setPublished", { videoId: video.videoId, published });
    if (!mounted.current) return;
    setPublishing((now) => {
      const next = new Set(now);
      next.delete(video.videoId);
      return next;
    });
    if (!reply.ok) {
      setError(reply.error);
      setReread((n) => n + 1);
      return;
    }
    // The card the owner just marked leaves while «Скрыть опубликованные» is on: the focus goes to the tab's heading, as after a delete.
    if (published && hidePublished) heading.current?.focus();
    // `video.changed` reads the list again; under an unreadable log the mark heals it, and a mark that changed nothing announces nothing, so it is read here.
    if (listed?.marks === "unknown") setReread((n) => n + 1);
  }

  async function reveal(video: VideoSummary): Promise<void> {
    markBusy(video.videoId, true);
    setError(null);
    const reply = await client.request("videos.reveal", { videoId: video.videoId });
    if (!mounted.current) return;
    markBusy(video.videoId, false);
    if (!reply.ok) {
      setError(reply.error);
      // The file may have moved meanwhile: the card shows what a fresh look finds.
      setReread((n) => n + 1);
    }
  }

  async function openFolder(): Promise<void> {
    setOpening(true);
    setError(null);
    const reply = await client.request("videos.revealFolder", { avatarId });
    if (!mounted.current) return;
    setOpening(false);
    if (!reply.ok) setError(reply.error);
  }

  async function cancel(job: JobView): Promise<void> {
    setError(null);
    const reply = await client.request("videos.cancel", { jobId: job.jobId });
    // The store waits for the job's real end, whichever window or screen is on show then.
    if (reply.ok) store.markCancelling(job.jobId);
    else if (mounted.current) setError(reply.error);
  }

  async function retry(job: JobView): Promise<void> {
    const montageId = job.montageId;
    if (montageId === null) return;
    setRetrying((prev) => new Set(prev).add(job.jobId));
    setError(null);
    const reply = await client.request("videos.render", { montageId });
    if (!mounted.current) return;
    setRetrying((prev) => {
      const next = new Set(prev);
      next.delete(job.jobId);
      return next;
    });
    const outcome = classifyAnswer(reply);
    // A new job comes through the store's events; the failed card it replaces goes. A refusal queued nothing.
    if (outcome.kind === "queued") setDismissed((prev) => new Set(prev).add(job.jobId));
    else setError(outcome.error);
  }

  const edit = useCallback((montageId: string) => navigate({ name: "editor", montageId }), [navigate]);
  // Stable, so the player's own effect (its focus and its Escape) runs once per opening, not once per render.
  const closePlayer = useCallback(() => setPlaying(null), []);

  const videos = listed?.videos ?? [];
  const counts = filterCounts(cards, videos);
  // S4.9c: a mark is shown only while the marks could be read (an unreadable log shows every video unmarked, with its notice).
  const marksKnown = listed?.marks !== "unknown";
  const isPublished = (video: VideoSummary): boolean => marksKnown && typeof video.publishedAt === "string";
  // A record's place among the avatar's videos from the oldest (the list is newest first): «Видео N» of a video of the autopilot.
  const ordinalOf = (video: VideoSummary): number => videos.length - videos.indexOf(video);
  const publishedCount = videos.filter(isPublished).length;
  const items = visibleItems(filter, cards, videos).filter((item) => !(hidePublished && item.kind === "video" && isPublished(item.video)));
  const folder = avatarFolderDisplay(rootDisplay, videos);
  const exportStatus = view.exportStatus;
  const now = new Date();

  return (
    <section className="videos-tab" aria-labelledby={titleId} aria-busy={listed === null && listError === null}>
      <div className="videos-head">
        <h2 ref={heading} id={titleId} className="videos-title" tabIndex={-1}>
          Видео
        </h2>
        {listed !== null && (
          <span className="mono muted videos-sum">
            {videos.length} · {megabytesLabel(videos)} · сначала новые
          </span>
        )}
        <div className="seg videos-filter" role="group" aria-label="Фильтр видео">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? "on" : undefined} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span className="mono videos-filter-n">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <span className="videos-hide">
          <button
            type="button"
            className={hidePublished ? "sw sw-s sw-on" : "sw sw-s"}
            role="switch"
            aria-checked={hidePublished}
            aria-labelledby={`${titleId}-hide`}
            onClick={() => setHidePublished(!hidePublished)}
          />
          <span id={`${titleId}-hide`}>
            Скрыть опубликованные <span className="mono faint">{publishedCount}</span>
          </span>
        </span>
        <div className="videos-folder">
          {folder !== null && (
            <span className="mono faint videos-path" title={folder}>
              {folder}
            </span>
          )}
          <button type="button" className="btn btn-s" disabled={!ready || opening} onClick={() => void openFolder()}>
            {opening ? <Spin /> : <Icon name="folder" size={14} strokeWidth={1.9} />}
            Папка «Готовые видео»
          </button>
        </div>
      </div>

      {/* The folder's state as every window knows it: never the answer to one render's size check. */}
      {exportStatus?.status === "unavailable" && (
        <Notice
          tone="warn"
          title={EXPORT_UNAVAILABLE_TITLE}
          actions={
            <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus: "export" })}>
              Открыть папку в Настройках
            </button>
          }
        >
          {EXPORT_UNAVAILABLE_REASONS_RU[exportStatus.reason]} Пока она недоступна, Studio не может проверить файлы видео и собрать новые.
        </Notice>
      )}
      {listed !== null && !marksKnown && (
        <Notice tone="warn" role="status">
          Отметки «Опубликовано» не читаются — все видео показаны без отметки. Studio по ним ничего не удаляет; новая отметка допишется.
        </Notice>
      )}
      {failure !== null && (
        <Notice
          tone="warn"
          title={failure.title}
          role="alert"
          actions={
            <button type="button" className="btn btn-s" onClick={() => setFailure(null)}>
              Закрыть
            </button>
          }
        >
          {failure.text}
        </Notice>
      )}
      {notice !== null && (
        <Notice
          tone={notice.tone}
          actions={
            <button type="button" className="btn btn-s" onClick={() => setNotice(null)}>
              Закрыть
            </button>
          }
        >
          {notice.text}
        </Notice>
      )}
      {error !== null && (
        <ErrorNotice
          error={error}
          actions={
            <button type="button" className="btn btn-s" onClick={() => setError(null)}>
              Закрыть
            </button>
          }
        />
      )}
      {listError !== null && (
        <ErrorNotice
          error={listError}
          actions={
            <button type="button" className="btn btn-s" onClick={() => setReread((n) => n + 1)}>
              Повторить
            </button>
          }
        />
      )}

      {listed === null && listError === null ? (
        <div className="videos-grid" aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="card video-card video-card-loading">
              <div className="ph video-poster">
                <div className="shim" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="videos-empty">
          <span className="cand-slot-title">{filter === "all" ? "Видео пока нет" : filter === "work" ? "Сейчас ничего не собирается" : "Ошибок нет"}</span>
          {filter === "all" && (
            <span className="cand-slot-sub">
              {avatar.status === "active" ? "«Новый монтаж» откроет пустой черновик этого аватара, а «Монтаж из выбранных» на вкладке «Фото» соберёт ролик из отмеченных фото." : "Аватар в архиве: новые видео для него не собираются."}
            </span>
          )}
        </div>
      ) : (
        <div className="videos-grid">
          {items.map((item) =>
            item.kind === "job" ? (
              <JobCard
                key={item.job.jobId}
                job={item.job}
                jobs={view.jobs}
                draft={item.job.montageId === null ? null : (drafts.get(item.job.montageId) ?? null)}
                cancelling={view.cancellingJobs.has(item.job.jobId)}
                retrying={retrying.has(item.job.jobId)}
                onCancel={(job) => void cancel(job)}
                onRetry={(job) => void retry(job)}
                onEdit={edit}
                onDismiss={(job) => setDismissed((prev) => new Set(prev).add(job.jobId))}
              />
            ) : (
              <VideoCard
                key={item.video.videoId}
                video={item.video}
                exportStatus={exportStatus}
                tracks={tracks}
                now={now}
                busy={busy.has(item.video.videoId)}
                ordinal={ordinalOf(item.video)}
                published={isPublished(item.video)}
                marksUnknown={!marksKnown}
                publishing={publishing.has(item.video.videoId)}
                onPlay={setPlaying}
                onReveal={(video) => void reveal(video)}
                onEdit={edit}
                onDelete={(video, mode, reject) => void remove(video, mode, reject)}
                onPublished={(video, published) => void markPublished(video, published)}
                onRecheck={() => setReread((n) => n + 1)}
              />
            ),
          )}
        </div>
      )}
      {playing !== null && <VideoPlayer video={playing} onClose={closePlayer} />}
    </section>
  );
}
