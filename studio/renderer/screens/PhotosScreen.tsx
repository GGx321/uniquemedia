import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MAX_CLIPS, type AvatarSummary, type EngineError, type Estimate, type PhotoSummary, type RunSummary } from "../../shared/engine";
import { useEngine, useEngineView, useSceneSet } from "../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../engine/store";
import { useNavigate, type PhotosTab } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon, Spin } from "../ui/Icon";
import { ErrorNotice } from "../ui/Notice";
import { Portrait } from "../ui/Portrait";
import { ScreenTitle } from "../ui/ScreenTitle";
import { Gallery, type PendingSlots } from "./photos/Gallery";
import { GenerateCard } from "./photos/GenerateCard";
import type { MarkControl, MarkFailure } from "./photos/photoState";
import { listedPicks, usablePicks, useMontagePicks } from "./photos/picks";
import { arrangeCategories, DEFAULT_RUN_FORM, paidBlockedReason, type RunForm } from "./photos/runForm";
import { useRunForms } from "./photos/runForms";
import { ScenesColumn } from "./photos/ScenesColumn";
import { readSceneReview, viewerStorage, writeSceneReview } from "./photos/sceneReview";
import { focusSceneCard } from "./photos/SceneSetPanel";
import { liveScenesJob } from "./photos/SceneStrip";
import { launchLinkOf } from "./photos/launchSet";
import { useMounted } from "./photos/shared";
import { UsageNotice } from "./photos/UsageNotice";
import { avatarPhotoKeys, usePhotoPages } from "./photos/usePhotoPages";
import { VideosTab } from "./photos/VideosTab";
import { headerCounts, type GalleryFilter } from "./photos/videosModel";

/**
 * The avatar asked for; else — none asked, or the one remembered is gone
 * (another library, say) — the first active one, else any saved one (an
 * archive still has its photos).
 */
function resolveAvatar(avatars: readonly AvatarSummary[], avatarId: string | null): AvatarSummary | null {
  const asked = avatarId === null ? undefined : avatars.find((a) => a.avatarId === avatarId);
  return asked ?? avatars.find((a) => a.status === "active") ?? avatars[0] ?? null;
}

/**
 * This avatar's photo-run job to show: its active (queued/running) run job,
 * else its latest run job. Every job event names its kind and avatar, so
 * nothing here guesses: an active job of a saved avatar is only ever its run
 * when `kind` says so, and a second run started by another window right
 * after this screen watched the first finish is simply the newer active job.
 */
function latestRunJob(jobs: readonly JobView[], avatarId: string): JobView | null {
  const own = jobs.filter((j) => j.kind === "run" && j.avatarId === avatarId);
  return own.filter(isActiveJob).at(-1) ?? own.at(-1) ?? null;
}

/**
 * «124 фото · 31 не использовано · 18 видео» (A1, F1): the avatar's own counts from its summary (the one eligibility function;
 * the videos are its records), kept current by `avatar.changed`. While its usage cannot be trusted the middle part says so.
 */
function HeaderCounts({ avatar }: { avatar: AvatarSummary }) {
  const counts = headerCounts(avatar);
  return (
    <p className="mono muted photos-sub">
      {counts.photos} · <span className={counts.unknown ? "warn-text" : undefined}>{counts.unused}</span> · {counts.videos}
      {avatar.status === "archived" && " · в архиве"}
    </p>
  );
}

function AvatarPhotos({ avatar, view, initialTab, focus }: { avatar: AvatarSummary; view: EngineView; initialTab: PhotosTab; focus: "launch" | null }) {
  const { client, store } = useEngine();
  const ready = view.phase === "ready";
  const { avatarId } = avatar;
  const photosTabId = useId();
  const videosTabId = useId();
  const panelId = useId();
  const [tab, setTab] = useState<PhotosTab>(initialTab);

  // CS.7 L4: kept by the window, so a look at Settings and back finds it as it was (a new category still on, the count, the poses).
  const runForms = useRunForms();
  const [form, setForm] = useState<RunForm>(() => runForms.get(avatarId) ?? DEFAULT_RUN_FORM);
  useEffect(() => runForms.set(avatarId, form), [runForms, avatarId, form]);
  // CS.3 (owner decision 4): a category this window made comes into the run at once, its dialog shown or hidden; in creation order.
  const { categories: categoryLibrary } = useEngine();
  useEffect(
    () =>
      categoryLibrary.subscribeCreated((created) => {
        const list = categoryLibrary.getView().list;
        const order = list.status === "ready" ? list.categories.map((c) => c.categoryId) : [created.categoryId];
        setForm((now) => ({ ...now, categories: arrangeCategories([...now.categories, created.categoryId], order) }));
      }),
    [categoryLibrary],
  );
  const [galleryRetry, setGalleryRetry] = useState(0);
  /** «Все / Неиспользованные / Отклонённые» (F4). */
  const [filter, setFilter] = useState<GalleryFilter>("all");
  /** Photos whose reject mark is being set (3e.2). */
  const [marking, setMarking] = useState<ReadonlySet<string>>(new Set());
  const [markError, setMarkError] = useState<MarkFailure | null>(null);
  /** This avatar's runs, for the resume rows. */
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [runsError, setRunsError] = useState<EngineError | null>(null);
  const [runsRefresh, setRunsRefresh] = useState(0);
  /** Run jobs seen queued or running on this screen: only their ending earns a notice. */
  const [watched, setWatched] = useState<ReadonlySet<string>>(new Set());
  /**
   * The jobs the window already knew when this screen opened: a job that
   * ended before then is old news (its notice was earned, or missed, back
   * then), while one the store first hears of afterwards is news even if
   * this screen never saw it running (a run that failed before its first
   * progress, say).
   */
  const [knownAtOpen] = useState<ReadonlySet<string>>(() => new Set(view.jobs.map((j) => j.jobId)));
  /**
   * Photos picked for a montage, in the order they were picked: «Монтаж из выбранных» places them in that order. Kept by the window for this avatar
   * while it runs (slice review 5-L3): leaving the screen and coming back finds them as they were.
   */
  const picks = useMontagePicks();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => picks.get(avatarId));
  useEffect(() => picks.set(avatarId, picked), [picks, avatarId, picked]);
  const picksChecked = useRef(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<EngineError | null>(null);
  /** The picked photos `montages.create` refused (`PHOTO_UNAVAILABLE` at `["photoIds", i]`, K11). */
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  /** «Новый монтаж» (3e.2): the empty draft of this avatar is being made. */
  const [creatingEmpty, setCreatingEmpty] = useState(false);
  const mounted = useMounted();
  const navigate = useNavigate();
  const whyId = useId();
  /**
   * A paid runs.start or runs.resume is in flight for this avatar, from the
   * generate card or any resume row (L5): locks the others until it
   * answers. Read from the window-wide store, not local state (LOW-3): a
   * remount mid-send (leaving and coming back through the sidebar, say)
   * must still see it, or a second paid command could slip through the
   * very lock this flag exists to enforce.
   */
  const paidInFlight = view.paidInFlightAvatars.has(avatarId);
  const setPaidInFlight = (inFlight: boolean): void => store.setPaidInFlight(avatarId, inFlight);

  const runJob = latestRunJob(view.jobs, avatarId);
  const runActive = runJob !== null && isActiveJob(runJob);
  const runJobId = runJob?.jobId ?? null;

  // CS.6: «Сцены на проверку» (on unless turned off on this machine) and the avatar's scene set, read by the window's slice.
  const [review, setReview] = useState(() => readSceneReview(viewerStorage()));
  const changeReview = (on: boolean): void => {
    setReview(on);
    writeSceneReview(viewerStorage(), on);
  };
  const { slice: sceneSlice, entry: sceneEntry, view: sliceView } = useSceneSet(avatarId);
  // Unknown (`undefined`) while it is read and when the read failed: nothing composes then, as a second open set would be refused.
  const sceneSet = sceneEntry.status === "ready" ? sceneEntry.sceneSet : undefined;
  const sceneReadError = sceneEntry.status === "failed" ? sceneEntry.error : null;
  const scenesJob = liveScenesJob(view.jobs, avatarId);
  // S4.9b: the set is an unfinished launch's (its band, «Продолжить запуск», «в запуске автопилота»), whatever this machine's «Сцены на проверку» says.
  const launchLink = launchLinkOf(view.autopilot, avatarId, sceneSet);
  const [composePrice, setComposePrice] = useState<Estimate | null>(null);

  // The gallery: on open, and again whenever this avatar's run reports a
  // slot done or ends — each photo lands in the library before its progress
  // event — and whenever the avatar's counts move (a video made or deleted,
  // a render queued or ended, a mark set: `avatar.changed`), since a photo's
  // used, reserved and rejected states move with them. S4.P2: past 500
  // photos it pages («Показать ещё»), one read at a time; a new photo reads
  // only the top, a change of state every page the owner opened.
  const progressKey = runJob ? `${runJob.jobId}:${runJob.done}:${runJob.status}` : "none";
  const keys = avatarPhotoKeys(avatar);
  const gallery = usePhotoPages(client, avatarId, {
    enabled: ready,
    refresh: [keys.states, galleryRetry],
    arrivals: [progressKey, keys.arrivals],
    onRead: (list, added) => {
      // The picks the window kept from an earlier visit are checked once, against the first answer (review r1 LOW-6) — against the
      // photos it lists: one picked on a later page is kept until its own page comes in with «Показать ещё», and checked then. Once
      // the last page is in, a pick on none of them is of a photo gone meanwhile, and goes (review MEDIUM-2).
      if (added !== null) setPicked((current) => (list.nextCursor === null ? listedPicks(usablePicks(current, added, true), list.photos) : usablePicks(current, added, true)));
      else if (!picksChecked.current) {
        picksChecked.current = true;
        setPicked((current) => usablePicks(current, list.photos, list.nextCursor !== null));
      }
    },
  });

  // The runs a resume can continue: on open, whenever this avatar's run job
  // starts or ends, after this window's own start or resume, and whenever the
  // library's launch moves to another status (S4.9b L9: a batch of a launch
  // that ended is the owner's own to continue, its `launchId` gone).
  const autopilot = view.autopilot;
  const statusKey = `${runJob ? `${runJob.jobId}:${runJob.status}` : "none"}|${autopilot === null ? "none" : `${autopilot.launchId}:${autopilot.status}`}`;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("runs.list", {}).then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setRuns(reply.result.runs.filter((r) => r.avatarId === avatarId));
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
    // Only this photo's mark goes: the others the engine refused stay marked until they are dealt with. The last
    // one dealt with takes the refusal notice with it.
    if (refused.has(photoId)) {
      const next = new Set(refused);
      next.delete(photoId);
      setRefused(next);
      if (next.size === 0) setCreateError(null);
    }
  }

  /** «Монтаж из выбранных · N»: a draft of the picked photos in the order picked (`defaultSpec` in the engine), then the editor. */
  async function createMontage(): Promise<void> {
    const photoIds = [...picked];
    setCreating(true);
    setCreateError(null);
    setRefused(new Set());
    // Up to ~30 s: the engine judges every photo's face focus before it answers.
    const reply = await client.request("montages.create", { avatarId, photoIds });
    if (!mounted.current) return;
    setCreating(false);
    if (reply.ok) {
      // A draft is made of them: the picks are done with (the screen goes before its own state could say so).
      picks.set(avatarId, new Set());
      navigate({ name: "editor", montageId: reply.result.montage.montageId, created: true });
      return;
    }
    setCreateError(reply.error);
    const marked = (reply.error.issues ?? []).flatMap((issue) => {
      const [root, i] = issue.path;
      const photoId = root === "photoIds" && typeof i === "number" ? photoIds[i] : undefined;
      return photoId === undefined ? [] : [photoId];
    });
    setRefused(new Set(marked));
    // The gallery as the engine sees it now: the refused tiles show why (in a video, in a render) and are not pickable.
    if (reply.error.code === "PHOTO_UNAVAILABLE") setGalleryRetry((n) => n + 1);
  }

  /** «Новый монтаж» on the «Видео» tab (the owner's option Б, 3d.2 review): an empty draft for this avatar, opened at once. */
  async function createEmpty(): Promise<void> {
    setCreatingEmpty(true);
    setCreateError(null);
    const reply = await client.request("montages.create", { avatarId, photoIds: [] });
    if (!mounted.current) return;
    setCreatingEmpty(false);
    if (reply.ok) navigate({ name: "editor", montageId: reply.result.montage.montageId, created: true });
    else setCreateError(reply.error);
  }

  /** The owner's «do not use» mark, or its restore (`photos.setRejected`): the tile shows the photo as the engine answers it. */
  async function markPhoto(photo: PhotoSummary, rejected: boolean): Promise<void> {
    setMarking((prev) => new Set(prev).add(photo.photoId));
    setMarkError(null);
    const reply = await client.request("photos.setRejected", { avatarId, photoId: photo.photoId, rejected });
    if (!mounted.current) return;
    setMarking((prev) => {
      const next = new Set(prev);
      next.delete(photo.photoId);
      return next;
    });
    if (!reply.ok) {
      setMarkError({ photoId: photo.photoId, error: reply.error });
      return;
    }
    const updated = reply.result.photo;
    gallery.replace(updated);
    // A rejected photo no longer goes into a montage: it leaves the selection.
    if (updated.rejected) {
      setPicked((current) => {
        if (!current.has(updated.photoId)) return current;
        const next = new Set(current);
        next.delete(updated.photoId);
        return next;
      });
    }
  }

  const mark: MarkControl = {
    marking,
    blocked: avatar.usage.state === "unknown" && avatar.usage.reasons.includes("rejects-unreadable") ? "Журнал отметок повреждён: сначала восстановите отметки" : null,
    failure: markError,
    onMark: (photo, rejected) => void markPhoto(photo, rejected),
  };

  const tabIds: Record<PhotosTab, string> = { photos: photosTabId, videos: videosTabId };
  // ← and → move between the two tabs that work («История сцен» is not in Stage 3).
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: PhotosTab = tab === "photos" ? "videos" : "photos";
    setTab(next);
    document.getElementById(tabIds[next])?.focus();
  };

  const montageWhy =
    avatar.status !== "active"
      ? "Аватар в архиве — новые ролики для него не создаются"
      : picked.size === 0
        ? "Отметьте фото, чтобы собрать ролик"
        : picked.size > MAX_CLIPS
          ? `Не больше ${MAX_CLIPS} фото в одном ролике — снимите лишние`
          : null;

  // The active job's own runId, straight off its events (or the start/resume reply): cancel never waits on runs.list.
  const activeRunId = runActive && runJob !== null ? runJob.runId : null;
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
          <HeaderCounts avatar={avatar} />
        </div>
        <div className="seg seg-l photos-tabs" role="tablist" aria-label="Разделы аватара">
          <button
            type="button"
            role="tab"
            id={photosTabId}
            aria-selected={tab === "photos"}
            aria-controls={panelId}
            tabIndex={tab === "photos" ? 0 : -1}
            className={tab === "photos" ? "on" : undefined}
            onClick={() => setTab("photos")}
            onKeyDown={onTabKey}
          >
            Фото
          </button>
          <button type="button" role="tab" aria-selected="false" disabled title="Скоро">
            История сцен
          </button>
          <button
            type="button"
            role="tab"
            id={videosTabId}
            aria-selected={tab === "videos"}
            aria-controls={panelId}
            tabIndex={tab === "videos" ? 0 : -1}
            className={tab === "videos" ? "on" : undefined}
            onClick={() => setTab("videos")}
            onKeyDown={onTabKey}
          >
            Видео
          </button>
        </div>
        {tab === "photos" ? (
          <div className="photos-montage">
            {montageWhy !== null && (
              <span id={whyId} className="faint photos-montage-why">
                {montageWhy}
              </span>
            )}
            <button
              type="button"
              className="btn btn-p"
              aria-busy={creating}
              aria-describedby={montageWhy !== null ? whyId : undefined}
              disabled={creating || !ready || montageWhy !== null}
              onClick={() => void createMontage()}
            >
              {creating ? <Spin /> : <Icon name="film" size={16} />}
              Монтаж из выбранных · {picked.size}
            </button>
          </div>
        ) : (
          // An archived avatar makes no new content: no «Новый монтаж» (montages.create would answer NOT_FOUND).
          avatar.status === "active" && (
            <div className="photos-montage">
              <button type="button" className="btn btn-p" aria-busy={creatingEmpty} disabled={creatingEmpty || !ready} onClick={() => void createEmpty()}>
                {creatingEmpty ? <Spin /> : <Icon name="film" size={16} />}
                Новый монтаж
              </button>
            </div>
          )
        )}
      </header>

      <div id={panelId} className="photos-panel" role="tabpanel" aria-labelledby={tabIds[tab]}>
        {view.phase === "offline" ? <EngineOffline view={view} /> : <AccountBanner view={view} />}
        {createError !== null && (
          <ErrorNotice
            error={createError}
            actions={
              <button type="button" className="btn btn-s" onClick={() => setCreateError(null)}>
                Закрыть
              </button>
            }
          />
        )}
        <UsageNotice key={avatarId} avatar={avatar} />

        {tab === "photos" ? (
          <>
            <GenerateCard
              avatar={avatar}
              view={view}
              form={form}
              onFormChange={setForm}
              runActive={runActive}
              onStarted={launched}
              paidInFlight={paidInFlight}
              onPaidInFlightChange={setPaidInFlight}
              review={review}
              onReviewChange={changeReview}
              sceneSet={sceneSet}
              sliceView={sliceView}
              scenesJob={scenesJob}
              onComposePrice={setComposePrice}
              onFocusScene={focusSceneCard}
              launchLink={launchLink}
              focusLaunch={focus === "launch"}
            />

            <div className="photos-body">
              <ScenesColumn
                avatar={avatar}
                review={review}
                sceneSet={sceneSet}
                sceneReadError={sceneReadError}
                onRetrySceneSet={() => sceneSlice.reload(avatarId)}
                sliceView={sliceView}
                scenesJob={scenesJob}
                composePrice={composePrice}
                view={view}
                count={form.count}
                runJob={runJob}
                activeRunId={activeRunId}
                watched={runJob !== null && (watched.has(runJob.jobId) || !knownAtOpen.has(runJob.jobId))}
                runs={runs}
                runsError={runsError}
                onRetryRuns={() => setRunsRefresh((n) => n + 1)}
                paidInFlight={paidInFlight}
                onPaidInFlightChange={setPaidInFlight}
                blockedReason={paidBlockedReason(view) ?? (avatar.status !== "active" ? "Аватар в архиве — новые фото для него не создаются." : null)}
                onResumed={launched}
                launchLink={launchLink}
              />
              <div className="photos-gallery-col">
                {markError !== null && (
                  <ErrorNotice
                    error={markError.error}
                    actions={
                      <button type="button" className="btn btn-s" onClick={() => setMarkError(null)}>
                        Закрыть
                      </button>
                    }
                  />
                )}
                <Gallery
                  gallery={gallery.pages}
                  error={gallery.error}
                  more={{ state: gallery.more, added: gallery.added, onMore: gallery.loadMore }}
                  pending={pending}
                  picked={picked}
                  refused={refused}
                  onToggle={togglePick}
                  onRetry={() => setGalleryRetry((n) => n + 1)}
                  filter={filter}
                  onFilter={setFilter}
                  usage={avatar.usage}
                  mark={mark}
                />
              </div>
            </div>
          </>
        ) : (
          <VideosTab avatar={avatar} view={view} />
        )}
      </div>
    </div>
  );
}

/** No saved avatar to show photos for: the library has none yet. */
function NoAvatar() {
  const navigate = useNavigate();
  const titleId = useId(); // L12: was the hardcoded "photos-empty-title"
  return (
    <div className="page photos-page">
      <ScreenTitle>Фото</ScreenTitle>
      <section className="card empty" aria-labelledby={titleId}>
        <span className="tile-icon" aria-hidden="true">
          <Icon name="plus" size={22} strokeWidth={2.2} />
        </span>
        <h2 id={titleId} className="empty-title">
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
 * with each photo's face similarity — and (3e.2) its videos (AvatarVideos.dc.html)
 * on the «Видео» tab. Opened from an avatar's name on the Avatars grid (its
 * «K видео» opens the «Видео» tab), or from the sidebar's «Фото» (the avatar
 * shown last, else the first active one).
 */
export function PhotosScreen({ avatarId, tab = "photos", focus = null }: { avatarId: string | null; tab?: PhotosTab; focus?: "launch" | null }) {
  const view = useEngineView();
  // L11/N5: once the route names no avatar (the sidebar's own «Фото»), or
  // names one that is no longer present (a library switch, say — N5: a
  // *named* route is just as exposed to this as the sidebar's own, and
  // wasn't pinning at all before), pin the resolved avatar locally for the
  // rest of this mount. Left unpinned, `avatar` would be re-resolved fresh
  // on every render, so a later change to view.avatars — another window
  // archiving the resolved avatar, say — would silently switch this screen
  // to a different one instead of just showing the same avatar now
  // archived. (The prop itself only ever changes across a remount —
  // App.tsx keys the screen on it — so pinning once here for its lifetime
  // is enough.) While the named id is present, it always wins outright —
  // the pin exists only to stand in once it stops being.
  const [pinned, setPinned] = useState<string | null>(null);
  const askedPresent = avatarId !== null && view.avatars.some((a) => a.avatarId === avatarId);
  const avatar = resolveAvatar(view.avatars, askedPresent ? avatarId : pinned);
  // The pinned id itself can disappear too — a second library switch, say —
  // in which case `avatar` above already fell back to a fresh resolution
  // this same render (resolveAvatar's own `asked` lookup simply fails).
  // Left un-re-pinned, that fresh choice would stay exposed to the exact
  // silent-switch bug this pin exists to prevent (the next avatars.list
  // change would re-resolve it again, and again).
  const pinnedGone = pinned !== null && !view.avatars.some((a) => a.avatarId === pinned);

  useEffect(() => {
    if (!askedPresent && (pinned === null || pinnedGone) && avatar !== null) setPinned(avatar.avatarId);
  }, [askedPresent, pinned, pinnedGone, avatar]);

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
  return <AvatarPhotos key={avatar.avatarId} avatar={avatar} view={view} initialTab={tab} focus={focus} />;
}
