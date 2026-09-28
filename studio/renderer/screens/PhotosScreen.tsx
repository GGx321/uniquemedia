import { useEffect, useId, useState } from "react";
import { MAX_LISTED_PHOTOS, type AvatarSummary, type EngineError, type RunSummary } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../engine/store";
import { countOf, groupNumber, NBSP } from "../lib/format";
import { useNavigate } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon } from "../ui/Icon";
import { Portrait } from "../ui/Portrait";
import { ScreenTitle } from "../ui/ScreenTitle";
import { Gallery, type GalleryList, type PendingSlots } from "./photos/Gallery";
import { GenerateCard } from "./photos/GenerateCard";
import { DEFAULT_RUN_FORM, paidBlockedReason, type RunForm } from "./photos/runForm";
import { ScenesColumn } from "./photos/ScenesColumn";
import { PHOTO_FORMS } from "./photos/shared";

/**
 * The avatar asked for; else — none asked, or the one remembered is gone
 * (another library, say) — the first active one, else any saved one (an
 * archive still has its photos).
 */
function resolveAvatar(avatars: readonly AvatarSummary[], avatarId: string | null): AvatarSummary | null {
  const asked = avatarId === null ? undefined : avatars.find((a) => a.avatarId === avatarId);
  return asked ?? avatars.find((a) => a.status === "active") ?? avatars[0] ?? null;
}

/** "124 фото"; "500+ фото" when the list is cut at its bound, whose real size is then not known. */
function photoCountLabel(list: GalleryList): string {
  const shown = list.photos.length + list.skippedTotal;
  return list.photos.length >= MAX_LISTED_PHOTOS ? `${groupNumber(shown)}+${NBSP}фото` : countOf(shown, PHOTO_FORMS);
}

/**
 * This avatar's latest photo-run job. A job this window did not start is
 * known only by its events until it ends, and `job.progress` carries no
 * kind: a job of a saved avatar whose kind is not yet confirmed could in
 * principle still be a candidates batch this window never tracked, from
 * when this id was a draft (L8) — so a job already confirmed `kind ===
 * "run"` is always preferred over an unconfirmed one, and only the latest
 * unconfirmed job stands in while none is confirmed yet (a run just
 * started elsewhere, seen only through its own job.progress so far).
 */
function latestRunJob(jobs: readonly JobView[], avatarId: string): JobView | null {
  const own = jobs.filter((j) => j.avatarId === avatarId && j.kind !== "avatar.candidates");
  const confirmed = own.filter((j) => j.kind === "run");
  return confirmed.at(-1) ?? own.at(-1) ?? null;
}

function AvatarPhotos({ avatar, view }: { avatar: AvatarSummary; view: EngineView }) {
  const { client } = useEngine();
  const ready = view.phase === "ready";
  const { avatarId } = avatar;
  const tabId = useId();
  const panelId = useId();

  const [form, setForm] = useState<RunForm>(DEFAULT_RUN_FORM);
  /** The last list photos.list answered (null until the first); a later failure is shown above it, never instead of it. */
  const [gallery, setGallery] = useState<GalleryList | null>(null);
  const [galleryError, setGalleryError] = useState<EngineError | null>(null);
  const [galleryRetry, setGalleryRetry] = useState(0);
  /** This avatar's runs, with the job state they were read under: a running entry is trusted only for that state. */
  const [runs, setRuns] = useState<{ forKey: string; runs: readonly RunSummary[] }>({ forKey: "", runs: [] });
  const [runsError, setRunsError] = useState<EngineError | null>(null);
  const [runsRefresh, setRunsRefresh] = useState(0);
  /** Run jobs seen queued or running on this screen: only their ending earns a notice. */
  const [watched, setWatched] = useState<ReadonlySet<string>>(new Set());
  /** Photos picked for a montage (stage 3): drawn as the mockup draws them, not sent anywhere yet. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** A paid runs.start or runs.resume is in flight for this avatar, from the generate card or any resume row (L5): locks the others until it answers. */
  const [paidInFlight, setPaidInFlight] = useState(false);

  const runJob = latestRunJob(view.jobs, avatarId);
  const runActive = runJob !== null && isActiveJob(runJob);
  const runJobId = runJob?.jobId ?? null;

  // The gallery: on open, and again whenever this avatar's run reports a
  // slot done or ends — each photo lands in the library before its progress
  // event. An answer overtaken by a newer ask is dropped.
  const progressKey = runJob ? `${runJob.jobId}:${runJob.done}:${runJob.status}` : "none";
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("photos.list", { avatarId }).then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setGallery({ photos: reply.result.photos, skippedTotal: reply.result.skippedTotal });
        setGalleryError(null);
      } else setGalleryError(reply.error);
    });
    return () => {
      alive = false;
    };
  }, [ready, client, avatarId, progressKey, galleryRetry]);

  // The runs a resume can continue (and the running one's id, for its
  // cancel): on open, whenever this avatar's run job starts or ends, and
  // after this window's own start or resume.
  const statusKey = runJob ? `${runJob.jobId}:${runJob.status}` : "none";
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("runs.list", {}).then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setRuns({ forKey: statusKey, runs: reply.result.runs.filter((r) => r.avatarId === avatarId) });
        setRunsError(null);
      } else setRunsError(reply.error);
    });
    return () => {
      alive = false;
    };
  }, [ready, client, avatarId, statusKey, runsRefresh]);

  useEffect(() => {
    if (runActive && runJobId !== null) setWatched((seen) => (seen.has(runJobId) ? seen : new Set([...seen, runJobId])));
  }, [runActive, runJobId]);

  function launched({ jobId }: { runId: string; jobId: string }): void {
    setWatched((seen) => new Set([...seen, jobId]));
    setRunsRefresh((n) => n + 1);
  }

  function togglePick(photoId: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  // One run per avatar at a time (the engine claims the avatar), so the running one in runs.list is this job's run —
  // but only in a list read since this job last changed state: an older one may name a run that has ended since.
  // Consulted only when the job's own runId is not yet known (M2): a run this
  // window itself started or resumed always carries it from the store, and
  // must never wait on (or be redirected by a stale) runs.list for its cancel.
  const listedRunning = runs.forKey === statusKey ? (runs.runs.find((r) => r.running)?.runId ?? null) : null;
  const activeRunId = runActive && runJob !== null ? (runJob.runId ?? listedRunning) : null;
  const resumable = runs.runs.filter((r) => r.resumable);
  const pending: PendingSlots | null =
    runJob !== null && runActive && runJob.total > runJob.done
      ? { remaining: runJob.total - runJob.done, drawing: Math.min(runJob.total - runJob.done, view.settings?.concurrency.network ?? 1) }
      : null;

  return (
    <div className="page photos-page">
      <header className="photos-head">
        <div className="ph photos-avatar">
          <Portrait avatarId={avatarId} photoId={avatar.masterPhotoId} label={`Мастер-портрет: ${avatar.name}`} />
        </div>
        <div>
          <ScreenTitle>{avatar.name}</ScreenTitle>
          <p className="mono muted photos-sub">
            {gallery === null ? "…" : photoCountLabel(gallery)}
            {avatar.status === "archived" && " · в архиве"}
          </p>
        </div>
        <div className="seg seg-l photos-tabs" role="tablist" aria-label="Разделы аватара">
          <button type="button" role="tab" id={tabId} aria-selected="true" aria-controls={panelId} className="on">
            Фото
          </button>
          <button type="button" role="tab" aria-selected="false" disabled title="Скоро">
            История сцен
          </button>
          <button type="button" role="tab" aria-selected="false" disabled title="Скоро">
            Видео
          </button>
        </div>
        <button type="button" className="btn btn-p photos-montage" disabled title="Монтаж — скоро">
          <Icon name="film" size={16} />
          Монтаж из выбранных · {picked.size}
        </button>
      </header>

      <div id={panelId} className="photos-panel" role="tabpanel" aria-labelledby={tabId}>
        {view.phase === "offline" ? <EngineOffline view={view} /> : <AccountBanner view={view} />}

        <GenerateCard
          avatar={avatar}
          view={view}
          form={form}
          onFormChange={setForm}
          runActive={runActive}
          onStarted={launched}
          paidInFlight={paidInFlight}
          onPaidInFlightChange={setPaidInFlight}
        />

        <div className="photos-body">
          <ScenesColumn
            view={view}
            count={form.count}
            runJob={runJob}
            activeRunId={activeRunId}
            watched={runJob !== null && watched.has(runJob.jobId)}
            runs={resumable}
            runsError={runsError}
            onRetryRuns={() => setRunsRefresh((n) => n + 1)}
            paidInFlight={paidInFlight}
            onPaidInFlightChange={setPaidInFlight}
            blockedReason={paidBlockedReason(view) ?? (avatar.status !== "active" ? "Аватар в архиве — новые фото для него не создаются." : null)}
            onResumed={launched}
          />
          <Gallery gallery={gallery} error={galleryError} pending={pending} picked={picked} onToggle={togglePick} onRetry={() => setGalleryRetry((n) => n + 1)} />
        </div>
      </div>
    </div>
  );
}

/** No saved avatar to show photos for: the library has none yet. */
function NoAvatar() {
  const navigate = useNavigate();
  return (
    <div className="page photos-page">
      <ScreenTitle>Фото</ScreenTitle>
      <section className="card empty" aria-labelledby="photos-empty-title">
        <span className="tile-icon" aria-hidden="true">
          <Icon name="plus" size={22} strokeWidth={2.2} />
        </span>
        <h2 id="photos-empty-title" className="empty-title">
          Сначала нужен аватар
        </h2>
        <p className="empty-text">Фото генерируются для сохранённого аватара: его мастер-портрет — референс лица для каждого кадра.</p>
        <div className="empty-actions">
          <button type="button" className="btn btn-p" onClick={() => navigate({ name: "avatars" })}>
            К аватарам
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * T8b: an avatar's photos (Photos.dc.html) — the generation card with its
 * price, the run in progress and the stopped runs to resume, and the gallery
 * with each photo's face similarity. Opened from an avatar's name on the
 * Avatars grid, or from the sidebar's «Фото» (the avatar shown last, else
 * the first active one).
 */
export function PhotosScreen({ avatarId }: { avatarId: string | null }) {
  const view = useEngineView();
  const avatar = resolveAvatar(view.avatars, avatarId);

  if (view.phase === "connecting") {
    return (
      <div className="page photos-page" aria-busy="true">
        <ScreenTitle>Фото</ScreenTitle>
      </div>
    );
  }
  if (avatar === null) {
    if (view.phase === "offline") {
      return (
        <div className="page photos-page">
          <ScreenTitle>Фото</ScreenTitle>
          <EngineOffline view={view} />
        </div>
      );
    }
    return <NoAvatar />;
  }
  return <AvatarPhotos key={avatar.avatarId} avatar={avatar} view={view} />;
}
