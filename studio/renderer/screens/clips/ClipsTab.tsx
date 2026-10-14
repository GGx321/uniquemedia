import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BOLD_CLIPS, isBoldCategory, type ClipSummary, type EngineError } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { isActiveJob, type JobView } from "../../engine/store";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice } from "../../ui/Notice";
import { clipLength, phaseLine, upUsd } from "./clipModel";
import { clipDismissals, clipIntents, dismissClipJob, type ClipIntent, type ClipsControl } from "./clipsContext";
import { ClipSheet } from "./ClipSheet";
import { FailedJobTile, FailedTile, ReadyTile, WorkTile } from "./ClipTile";
import { ClipViewer } from "./ClipViewer";

// Stage 5, 5b.1, S5.V8: the avatar's «Клипы» tab (mockups 39–42, 46; plan s5b1 §6; README §S5.VD decisions 4–6). A gallery, not the «Видео» cards: a clip is a picture the owner
// publishes. VideosTab's head (the title, the count, the path and «Папка «Готовые видео»») over a grid of 9:16 tiles: the clips at work first (from the store's jobs), then the clip
// jobs that ended with no record, then the records newest first (`clips.list`). Every figure is the engine's.

type Ready = Extract<ClipSummary, { status: "ready" }>;
type Failed = Extract<ClipSummary, { status: "failed" }>;

/** I5.48: a late clip may still come until 60 min after its submit; the engine's own date (`reconcileAvailableAt`) is preferred, this stands in without it. */
const LATE_GIVE_UP_MS = 60 * 60_000;

/** A clock for the elapsed times and the deadlines on show: ticks each second while anything on screen counts. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The folder of this avatar's clips in the export folder as a person reads it: the root, and the avatar's subfolder once an export names it. */
function folderOf(rootDisplay: string | null, clips: readonly ClipSummary[]): string | null {
  if (rootDisplay === null) return null;
  const relPath = clips.flatMap((clip) => clip.exports.filter((e) => e.fileState === undefined || e.fileState === "present")).at(0)?.relPath;
  if (relPath === undefined || !relPath.includes("/")) return rootDisplay;
  const separator = rootDisplay.includes("\\") && !rootDisplay.includes("/") ? "\\" : "/";
  return `${rootDisplay.replace(/[\\/]+$/, "")}${separator}${relPath.slice(0, relPath.indexOf("/"))}`;
}

export function ClipsTab({ control, arrived, onArrivalHandled }: { control: ClipsControl; arrived: number; onArrivalHandled: () => void }) {
  const { client, store } = useEngine();
  const { avatar, view, list, photoInfo, galleryComplete, started, showPhoto } = control;
  const { avatarId } = avatar;
  const ready = view.phase === "ready";
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [rootDisplay, setRootDisplay] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // The put-away tiles are the window's (see `clipDismissals`); the state only draws the tab again.
  const [, setDismissals] = useState(0);
  const dismissed = clipDismissals(store);
  const [viewing, setViewing] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ photoId: string } | null>(null);
  const [opening, setOpening] = useState(false);
  /** When this window first saw each clip job on its way: an elapsed time from another clock counts from here. */
  const seen = useRef(new Map<string, number>());
  const intents = clipIntents(store);

  // A clip just started from the sheet: the tab's heading takes the focus, the new tile right under it. One-shot: the screen is told, so a later visit to the tab (→ from «Фото»)
  // leaves the focus on the tab.
  useEffect(() => {
    if (arrived === 0) return;
    heading.current?.focus();
    onArrivalHandled();
  }, [arrived, onArrivalHandled]);

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

  const records = list.clips ?? [];
  const recordOf = new Map(records.map((clip) => [clip.clipId, clip]));
  const clipJobs = view.jobs.filter((job): job is JobView & { clip: NonNullable<JobView["clip"]> } => job.kind === "clip" && job.avatarId === avatarId && job.clip !== undefined && !job.clip.export);
  /** A job that ended after the list on show was asked for: its record may not be listed yet, so its tile stays as it was. One the list already accounts for and does not hold was deleted. */
  const behind = (job: JobView): boolean => list.readEnded === null || !list.readEnded.has(job.jobId);
  const work = clipJobs.filter((job) => isActiveJob(job) || (job.status === "done" && behind(job) && !recordOf.has(job.clip.clipId)));
  const workClips = new Set(work.map((job) => job.clip.clipId));
  const failedJobs = clipJobs.filter((job) => job.status === "failed" && job.error !== null && !recordOf.has(job.clip.clipId) && !dismissed.has(job.jobId));
  const now = useNow(work.length > 0 || records.some((clip) => clip.status === "failed" && clip.retryDownloadUntil !== undefined));
  for (const job of work) if (!seen.current.has(job.jobId)) seen.current.set(job.jobId, Date.now());

  const money = view.money?.ledger === "open" ? view.money : null;
  const lateUntilOf = (job: JobView & { clip: NonNullable<JobView["clip"]> }): number | null => {
    if (money?.reconcileAvailableAt !== undefined) return Date.parse(money.reconcileAvailableAt);
    return job.clip.submittedAt === null ? null : Date.parse(job.clip.submittedAt) + LATE_GIVE_UP_MS;
  };

  const readyClips = records.filter((clip): clip is Ready => clip.status === "ready");
  const viewIndex = viewing === null ? -1 : readyClips.findIndex((clip) => clip.clipId === viewing);
  const shown = readyClips[viewIndex];
  // The clip on show was deleted or replaced by another window: the viewer closes.
  useEffect(() => {
    if (viewing !== null && list.clips !== null && shown === undefined) setViewing(null);
  }, [viewing, list.clips, shown]);

  const mark = (id: string, on: boolean): void =>
    setBusy((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function cancel(job: JobView): Promise<void> {
    setError(null);
    const reply = await client.request("avatars.cancel", { jobId: job.jobId });
    if (reply.ok) store.markCancelling(job.jobId);
    else setError(reply.error);
  }

  async function remove(clip: Failed): Promise<void> {
    mark(clip.clipId, true);
    setError(null);
    const reply = await client.request("clips.delete", { avatarId, clipId: clip.clipId });
    mark(clip.clipId, false);
    // The tile goes with the list read again; the focus to the tab's heading, as a video card's delete does.
    if (reply.ok) heading.current?.focus();
    else setError(reply.error);
    list.reread();
  }

  async function redownload(clip: Failed): Promise<void> {
    mark(clip.clipId, true);
    setError(null);
    const reply = await client.request("clips.retryDownload", { avatarId, clipId: clip.clipId });
    mark(clip.clipId, false);
    if (reply.ok) store.trackClipJob(reply.result.jobId, avatarId, clip.clipId, "retry");
    else {
      setError(reply.error);
      list.reread();
    }
  }

  /** 42n: «Снять на Grok · до $0.85», a new clip at the offer's own price, with the motion the refused one had (an id the photo still offers). */
  async function shootOnGrok(clip: Failed): Promise<void> {
    const offer = clip.failure.grokOffer;
    if (offer === undefined) return;
    mark(clip.clipId, true);
    setError(null);
    const options = await client.request("clips.options", { avatarId, photoId: clip.photoId });
    const motion = options.ok && options.result.suitable ? options.result.motions.find((m) => m.text === clip.motion.text) : undefined;
    if (!options.ok || motion === undefined) {
      mark(clip.clipId, false);
      setError(options.ok ? { code: "VALIDATION", clipReason: options.result.suitable ? "unknown-motion" : options.result.reason } : options.error);
      return;
    }
    store.setPaidInFlight(avatarId, true);
    const reply = await client.request("clips.create", {
      avatarId,
      photoId: clip.photoId,
      motionId: motion.id,
      model: "grok",
      quality: "std",
      seconds: clip.request.seconds,
      fallback: "none",
      acceptedWorstMicros: offer.worstMicros,
    });
    store.setPaidInFlight(avatarId, false);
    mark(clip.clipId, false);
    if (!reply.ok) {
      setError(reply.error);
      // A price that moved is the list's to say again (`grokOffer` is priced at list time).
      list.reread();
      return;
    }
    const intent: ClipIntent = {
      clipId: reply.result.jobId,
      avatarId,
      photoId: clip.photoId,
      motionLabel: motion.label,
      requestModel: "grok",
      seconds: clip.request.seconds,
      acceptedWorstMicros: offer.worstMicros,
      klingWorstMicros: offer.worstMicros,
      grokWorstMicros: offer.worstMicros,
    };
    started(reply.result.jobId, intent);
  }

  async function openFolder(): Promise<void> {
    setOpening(true);
    setError(null);
    const reply = await client.request("videos.revealFolder", { avatarId });
    setOpening(false);
    if (!reply.ok) setError(reply.error);
  }

  const onOpen = useCallback((clipId: string) => setViewing(clipId), []);
  /** The clip the viewer just deleted: its tile is about to go, so the focus goes to the tab's heading, as after a tile's own delete. */
  const deleted = useRef<string | null>(null);
  const tileFor = (clipId: string): HTMLElement | null =>
    deleted.current === clipId
      ? heading.current
      : (gridRef.current?.querySelector<HTMLElement>(`button.clip-open[data-clip-id="${clipId}"]`) ?? gridRef.current?.querySelector<HTMLElement>("button.clip-open") ?? heading.current);

  const subtitleOf = (photoId: string): string | null => {
    const place = photoInfo(photoId);
    return place === null ? null : `Фото ${place.position} из ${Math.max(place.total, avatar.photoCount)} · ${place.label}`;
  };
  const boldOf = (photoId: string): boolean => {
    const place = photoInfo(photoId);
    return place !== null && isBoldCategory(place.photo.category) && BOLD_CLIPS !== "with-fallback";
  };

  const empty = list.clips !== null && records.length === 0 && work.length === 0 && failedJobs.length === 0;
  const folder = folderOf(rootDisplay, records);

  return (
    <section className="clips-tab" aria-labelledby={titleId} aria-busy={list.clips === null && list.error === null}>
      <div className="videos-head">
        <h2 ref={heading} id={titleId} className="videos-title" tabIndex={-1}>
          Клипы
        </h2>
        {list.clips !== null && records.length > 0 && <span className="mono muted videos-sum">{records.length} · сначала новые</span>}
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
      {list.error !== null && (
        <ErrorNotice
          error={list.error}
          actions={
            <button type="button" className="btn btn-s" onClick={list.reread}>
              Повторить
            </button>
          }
        />
      )}

      {list.clips === null && list.error === null ? (
        <div className="clips-grid" aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="clip-slot">
              <div className="ph clip-tile-poster">
                <div className="shim" />
              </div>
            </div>
          ))}
        </div>
      ) : empty ? (
        <div className="videos-empty">
          <span className="cand-slot-title">Клипов пока нет</span>
          <span className="cand-slot-sub">Откройте фото и нажмите «Оживить».</span>
        </div>
      ) : (
        <div ref={gridRef} className="clips-grid">
          {work.map((job) => {
            // S5.V8b: what the tile shows is the engine's own (the job's facts, told in its events and its snapshot), so a window that never saw the click draws it whole; this window's intent is the
            // fallback for a job that tells none (an older engine's).
            const facts = job.clip.facts;
            const intent = intents.get(job.clip.clipId);
            const record = recordOf.get(job.clip.clipId);
            const phase = isActiveJob(job) ? (job.clip.phase ?? "preparing") : "saving";
            const grokOffer = facts === undefined ? intent?.requestModel === "grok" : facts.request.model === "grok";
            const line = phaseLine(
              { phase, model: job.clip.model, submittedAt: job.clip.submittedAt, proveUntil: job.clip.proveUntil },
              { nowMs: now, seenMs: seen.current.get(job.jobId) ?? now, lateUntilMs: lateUntilOf(job), grokOffer },
            );
            const heldOpen = phase === "late" || phase === "recovering";
            const acceptedWorst = facts?.acceptedWorstMicros ?? intent?.acceptedWorstMicros ?? null;
            // What a late or recovered attempt holds open is its own model's reserve (the sheet's, when this window has it); the engine's accepted worst case stands in for a window that has not.
            const reserve = intent === undefined ? acceptedWorst : job.clip.model === "grok" ? intent.grokWorstMicros : intent.klingWorstMicros;
            const moneyLine =
              record !== undefined
                ? "бесплатно"
                : heldOpen
                  ? reserve === null
                    ? null
                    : `до ${upUsd(reserve)} — спишется при сверке`
                  : acceptedWorst === null
                    ? null
                    : `до ${upUsd(acceptedWorst)}`;
            const seconds = facts?.request.seconds ?? intent?.seconds ?? record?.request.seconds ?? null;
            return (
              <div key={job.jobId} className="clip-slot">
                <WorkTile
                  motion={facts?.motion.label ?? intent?.motionLabel ?? record?.motion.label ?? "Клип"}
                  avatarId={avatarId}
                  photoId={facts?.photoId ?? intent?.photoId ?? record?.photoId ?? null}
                  clip={job.clip}
                  line={line}
                  done={job.done}
                  total={job.total}
                  length={seconds === null ? null : clipLength(seconds * 1000)}
                  money={moneyLine}
                  cancelling={view.cancellingJobs.has(job.jobId)}
                  onCancel={isActiveJob(job) ? () => void cancel(job) : null}
                />
              </div>
            );
          })}
          {failedJobs.map((job) => {
            const intent = intents.get(job.clip.clipId);
            return (
              <div key={job.jobId} className="clip-slot">
                <FailedJobTile
                  motion={job.clip.facts?.motion.label ?? intent?.motionLabel ?? "Клип"}
                  avatarId={avatarId}
                  photoId={job.clip.facts?.photoId ?? intent?.photoId ?? null}
                  clipId={job.clip.clipId}
                  error={job.error ?? { code: "INTERNAL" }}
                  onDismiss={() => {
                    dismissClipJob(store, job.jobId);
                    setDismissals((n) => n + 1);
                    heading.current?.focus();
                  }}
                />
              </div>
            );
          })}
          {records
            .filter((clip) => !workClips.has(clip.clipId))
            .map((clip) => (
              <div key={clip.clipId} className="clip-slot">
                {clip.status === "ready" ? (
                  <ReadyTile clip={clip} nowMs={now} onOpen={onOpen} />
                ) : (
                  <FailedTile
                    clip={clip}
                    nowMs={now}
                    bold={boldOf(clip.photoId)}
                    busy={busy.has(clip.clipId)}
                    onAgain={(c) => setSheet({ photoId: c.photoId })}
                    onRedownload={(c) => void redownload(c)}
                    onGrok={(c) => void shootOnGrok(c)}
                    onRemove={(c) => void remove(c)}
                  />
                )}
              </div>
            ))}
        </div>
      )}

      {shown !== undefined && (
        <ClipViewer
          clip={shown}
          index={viewIndex}
          total={readyClips.length}
          prevId={readyClips[viewIndex - 1]?.clipId ?? null}
          nextId={readyClips[viewIndex + 1]?.clipId ?? null}
          view={view}
          source={photoInfo(shown.photoId)}
          galleryComplete={galleryComplete}
          rootDisplay={rootDisplay}
          onShow={setViewing}
          onClose={() => setViewing(null)}
          onAgain={(photoId) => setSheet({ photoId })}
          onShowPhoto={(photoId) => {
            setViewing(null);
            showPhoto(photoId);
          }}
          onDeleted={() => {
            deleted.current = shown.clipId;
            setViewing(null);
            list.reread();
          }}
          onExportStarted={() => list.reread()}
          onChanged={list.reread}
          returnFocus={tileFor}
          covered={sheet !== null}
        />
      )}
      {sheet !== null && (
        <ClipSheet
          avatarId={avatarId}
          photoId={sheet.photoId}
          subtitle={subtitleOf(sheet.photoId)}
          frameLabel={`Кадр, который оживёт: ${subtitleOf(sheet.photoId) ?? "фото"}`}
          onClose={() => setSheet(null)}
          onStarted={(jobId, intent) => {
            setSheet(null);
            setViewing(null);
            started(jobId, intent);
          }}
        />
      )}
    </section>
  );
}
