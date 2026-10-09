import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { MAX_LAUNCH_LOG_LINES, type EngineError, type LaunchView } from "../../../shared/engine";
import { useCategoryLibrary, useEngine, useEngineView } from "../../engine/react";
import { percentOf, renderPhase } from "../../engine/renderJobs";
import type { JobView } from "../../engine/store";
import { placeholderGradient } from "../../lib/media";
import { useNavigate } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { ScreenTitle } from "../../ui/ScreenTitle";
import { useAnnouncer } from "../../ui/useAnnouncer";
import { DeleteVideoDialog } from "../photos/DeleteVideoDialog";
import { deleteFailedText, plainDoneText, rejectDoneText, type DeleteChoice } from "../photos/deleteVideo";
import { useMounted } from "../photos/shared";
import { Poster } from "../photos/VideoCards";
import { deleteOutcomeText } from "../photos/videosModel";
import {
  droppedLine,
  journalCount,
  journalRows,
  launchHeading,
  launchMeta,
  listOf,
  marksUnknownText,
  resultCounts,
  resultTiles,
  settingsBits,
  statusTag,
  type AvatarVideos,
  type ResultTile,
} from "./historyModel";
import { useOverflows, useWide } from "./layout";
import { spentBlock } from "./liveModel";
import { isUnfinished } from "./planModel";
import { useAvatarVideoLists, useLaunchDetail } from "./useLaunches";

// S4.9c: one launch's page (AutopilotS4.dc.html states launch and delete-published; LaunchStates «Результаты», «Удалить видео», «Журнал»): its settings in a
// line, its videos as tiles — shape, length, size, track, «Опубликовано» (`videos.setPublished`), the trash with its two-way dialog (`videos.delete`,
// «и отклонить фото» chosen for a published video, Q4 = A) — «Скрыть опубликованные», a filter by avatar, what did not come out, and the whole log with
// «Потрачено $S из $W′». Since S4.6g the marks and the deleted videos are `autopilot.get`'s word on each video; `videos.list` only gives a finished one its picture.

/** The log shows this many lines at first, and as many more on each «Показать раньше». */
export const LOG_PAGE = 100;

const NO_AVATARS: readonly string[] = [];

interface Outcome {
  readonly tone: "ok" | "warn";
  readonly title?: string;
  readonly text: string;
}

export function LaunchScreen({ launchId, from }: { launchId: string; from: "history" | "autopilot" }) {
  const view = useEngineView();
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const wide = useWide();
  const mounted = useMounted();
  const ids = useId();
  const { view: categorySlice } = useCategoryLibrary();
  const customs = categorySlice.list.status === "ready" ? categorySlice.list.categories : null;

  const { detail, reread: rereadDetail, reads } = useLaunchDetail(launchId);
  const got = detail.state === "ready" ? detail.detail : null;
  const launch = got?.launch ?? null;
  const avatarIds = launch?.draft.avatarIds ?? NO_AVATARS;
  const { lists: answered, reread: rereadList } = useAvatarVideoLists(avatarIds);
  const names = useMemo(() => new Map(view.avatars.map((a) => [a.avatarId, a.name])), [view.avatars]);
  // Fix round 1: an avatar deleted since the launch answers NOT_FOUND for good — that is the avatar gone (inert tiles), not an error to retry.
  const lists = useMemo(() => {
    const out = new Map<string, AvatarVideos>();
    for (const id of avatarIds) {
      const list = listOf(answered.get(id), names.has(id));
      if (list !== undefined) out.set(id, list);
    }
    return out;
  }, [answered, avatarIds, names]);
  const nameOf = useCallback((avatarId: string): string => names.get(avatarId) ?? "удалённый аватар", [names]);
  const customName = useCallback((categoryId: string): string | null => customs?.find((c) => c.categoryId === categoryId)?.name ?? null, [customs]);

  const [filter, setFilter] = useState<string | null>(null);
  const [hide, setHide] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<ResultTile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [opening, setOpening] = useState(false);
  const [logShown, setLogShown] = useState(LOG_PAGE);
  const [spoken, say] = useAnnouncer();
  const resultsTitle = useRef<HTMLHeadingElement>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const trashRefs = useRef(new Map<string, HTMLButtonElement>());
  /**
   * A tile about to leave the screen (deleted, or marked while «Скрыть опубликованные» is on): the focus goes to the tile that takes its place. `read` is how
   * many answers of `autopilot.get` had landed when it was armed: a later one that still shows the tile disarms it (fix round 1).
   */
  const pendingFocus = useRef<{ readonly key: string; readonly index: number; readonly read: number } | null>(null);
  const arm = (tile: ResultTile): void => {
    pendingFocus.current = { key: tile.key, index: shown.findIndex((t) => t.key === tile.key), read: reads };
  };
  const deleted = useRef(false);

  const tiles = useMemo(() => (got === null ? [] : resultTiles(got.videos, lists, nameOf)), [got, lists, nameOf]);
  const counts = resultCounts(tiles);
  const shown = tiles.filter((t) => (filter === null || t.avatarId === filter) && !(hide && t.published));
  const shownKeys = shown.map((t) => t.key).join(" ");

  // The tile with the focus left (the design's keyboard table, «Результаты»): the focus goes to the next one, or the last, or the section's heading.
  useEffect(() => {
    const want = pendingFocus.current;
    if (want === null) return;
    const now = shownKeys === "" ? [] : shownKeys.split(" ");
    if (now.includes(want.key)) {
      // The list was read again and the tile is still there (the mark or the delete did not take): nothing to hand the focus on for.
      if (reads !== want.read) pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    const next = now[Math.min(want.index, now.length - 1)];
    (next === undefined ? resultsTitle.current : (tileRefs.current.get(next) ?? resultsTitle.current))?.focus();
  }, [shownKeys, reads]);

  const mark = (key: string, on: boolean): void =>
    setBusy((now) => {
      const next = new Set(now);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const togglePublished = async (tile: ResultTile): Promise<void> => {
    if (tile.videoId === null || busy.has(tile.key)) return;
    const published = !tile.published;
    if (hide && published) arm(tile);
    mark(tile.key, true);
    setError(null);
    const reply = await client.request("videos.setPublished", { videoId: tile.videoId, published });
    if (!mounted.current) return;
    mark(tile.key, false);
    if (!reply.ok) {
      pendingFocus.current = null;
      setError(reply.error);
      rereadDetail();
    } else if (tile.markUnknown) {
      // A mark that changed is announced (`video.changed`) and the launch is read again by that; one made over an unreadable log heals it and may change nothing, so announces nothing.
      rereadDetail();
    }
  };

  const remove = async (tile: ResultTile, choice: DeleteChoice): Promise<void> => {
    if (tile.videoId === null || deleting) return;
    const rejecting = choice === "reject";
    setDeleting(true);
    setOutcome(null);
    setError(null);
    const reply = await client.request("videos.delete", { videoId: tile.videoId, mode: "video", ...(rejecting ? { rejectPhotos: true as const } : {}) });
    if (!mounted.current) return;
    setDeleting(false);
    if (reply.ok) {
      deleted.current = true;
      arm(tile);
      const text = rejecting
        ? rejectDoneText(tile.label, reply.result)
        : reply.result.fileDeleted
          ? plainDoneText(tile.label, tile.photos)
          : (deleteOutcomeText("video", reply.result, view.exportStatus) ?? plainDoneText(tile.label, tile.photos));
      setOutcome({ tone: "ok", text });
    } else {
      deleted.current = false;
      const failed = deleteFailedText(reply.error, rejecting);
      setOutcome({ tone: "warn", title: failed.title, text: failed.text });
      // A delete that timed out reads as refused while its work may still go on (`outcome: "unknown"`): the records, the launch and the photos are read again.
      void store.refreshAvatars();
    }
    rereadList(tile.avatarId);
    // A delete that went through is announced (`video.changed`), which reads the launch again; one that did not may still go on, and is asked after.
    if (!reply.ok) rereadDetail();
    setAsking(null);
  };

  const folderAvatar = filter ?? (avatarIds.length === 1 ? (avatarIds[0] ?? null) : null);
  const openFolder = async (avatarId: string): Promise<void> => {
    setOpening(true);
    setError(null);
    const reply = await client.request("videos.revealFolder", { avatarId });
    if (!mounted.current) return;
    setOpening(false);
    if (!reply.ok) setError(reply.error);
  };

  const back = (): void => navigate(from === "history" ? { name: "launches", focus: launchId } : { name: "section", id: "autopilot" });
  // The avatars whose marks the engine could not read (S4.6g): their finished videos say so, whether or not their records were listed.
  const unknownMarks = avatarIds.filter((id) => tiles.some((t) => t.avatarId === id && t.markUnknown));
  const failedLists = avatarIds.flatMap((id) => {
    const list = lists.get(id);
    return list !== undefined && list.state === "failed" ? [{ id, error: list.error }] : [];
  });

  return (
    <div className="page ap-page ap-launch-page">
      <p className="sr-only" aria-live="polite" data-announcer="results">
        {spoken}
      </p>
      <header className="ap-launch-head">
        <div className="ap-launch-head-text">
          <button type="button" className="back-link" onClick={back}>
            <Icon name="back" size={14} strokeWidth={2.4} />
            {from === "history" ? "История запусков" : "Автопилот"}
          </button>
          {launch === null ? (
            <ScreenTitle>Запуск</ScreenTitle>
          ) : (
            <>
              <div className="ap-launch-title">
                <ScreenTitle>{launchHeading(launch.createdAt)}</ScreenTitle>
                <span className={`tag ap-st ap-st-${statusTag(launch.status).tone}`}>{statusTag(launch.status).text}</span>
              </div>
              <p className="mono muted ap-launch-meta">{launchMeta(launch)}</p>
            </>
          )}
        </div>
        {launch !== null && folderAvatar !== null && (
          <button type="button" className="btn btn-s" disabled={opening} onClick={() => void openFolder(folderAvatar)}>
            {opening ? <Spin /> : <Icon name="folder" size={14} strokeWidth={1.9} />}
            Папка «Готовые видео»
          </button>
        )}
      </header>

      {detail.state === "failed" && (
        <ErrorNotice
          error={detail.error}
          actions={
            <button type="button" className="btn btn-s" onClick={rereadDetail}>
              Повторить
            </button>
          }
        />
      )}
      {detail.state === "loading" && (
        <p className="muted ap-launch-loading" role="status">
          Читаем запуск…
        </p>
      )}

      {launch !== null && got !== null && (
        <>
          <p className="mono muted ap-launch-bits">
            {settingsBits(launch.draft, customName).map((bit) => (
              <span key={bit}>{bit}</span>
            ))}
          </p>
          {isUnfinished(launch) && (
            <Notice
              tone="info"
              role="status"
              actions={
                <button type="button" className="btn btn-s" onClick={() => navigate({ name: "section", id: "autopilot" })}>
                  Открыть «Автопилот»
                </button>
              }
            >
              Запуск ещё не закончен: видео появляются здесь по мере готовности.
            </Notice>
          )}
          <div className="ap-launch-body">
            <section className="ap-res-col" aria-labelledby={`${ids}-res`}>
              <div className="ap-res-bar">
                <h2 id={`${ids}-res`} ref={resultsTitle} className="ap-h2 ap-res-title" tabIndex={-1}>
                  Видео
                </h2>
                <span className="mono muted">
                  {counts.done} · {counts.megabytes}
                </span>
                {avatarIds.length > 1 && (
                  <div className="seg ap-res-seg" role="group" aria-label="Аватар">
                    <button type="button" className={filter === null ? "on" : undefined} aria-pressed={filter === null} onClick={() => setFilter(null)}>
                      Все <span className="mono ap-seg-n">{counts.done}</span>
                    </button>
                    {avatarIds.map((avatarId) => (
                      <button key={avatarId} type="button" className={filter === avatarId ? "on" : undefined} aria-pressed={filter === avatarId} onClick={() => setFilter(avatarId)}>
                        {nameOf(avatarId)} <span className="mono ap-seg-n">{counts.byAvatar.get(avatarId) ?? 0}</span>
                      </button>
                    ))}
                  </div>
                )}
                <span className="ap-res-hide">
                  <button
                    type="button"
                    className={hide ? "sw sw-s sw-on" : "sw sw-s"}
                    role="switch"
                    aria-checked={hide}
                    aria-labelledby={`${ids}-hide`}
                    onClick={() => {
                      // Tiles leave or come back without the focus moving: what changed is said.
                      say(hide ? "Опубликованные видео снова показаны" : `Опубликованные видео скрыты: ${counts.published}`);
                      setHide(!hide);
                    }}
                  />
                  <span id={`${ids}-hide`}>
                    Скрыть опубликованные <span className="mono faint">{counts.published}</span>
                  </span>
                </span>
              </div>
              {(() => {
                const line = droppedLine(got.videos, nameOf);
                return line === null ? null : <p className="faint ap-res-dropped">{line}</p>;
              })()}
              {unknownMarks.length > 0 && (
                <Notice tone="warn" role="status">
                  {marksUnknownText(
                    unknownMarks.map((id) => nameOf(id)),
                    unknownMarks.length === avatarIds.length,
                  )}
                </Notice>
              )}
              {failedLists.map(({ id, error: listError }) => (
                <ErrorNotice
                  key={id}
                  error={listError}
                  actions={
                    <button type="button" className="btn btn-s" onClick={() => rereadList(id)}>
                      Повторить
                    </button>
                  }
                />
              ))}
              {outcome !== null && (
                <Notice
                  tone={outcome.tone}
                  title={outcome.title}
                  role={outcome.tone === "ok" ? "status" : "alert"}
                  actions={
                    <button type="button" className="btn btn-s" onClick={() => setOutcome(null)}>
                      Закрыть
                    </button>
                  }
                >
                  {outcome.text}
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
              <ResultsGrid wide={wide}>
                {shown.length === 0 ? (
                  <div className="ap-res-empty">
                    <span className="ap-empty-title">{tiles.length === 0 ? "Видео пока нет" : hide ? "Все видео здесь опубликованы" : "У этого аватара видео нет"}</span>
                    <span className="faint">{tiles.length === 0 ? (isUnfinished(launch) ? "Готовые видео запуска появятся здесь." : "Ни одно видео этого запуска не собралось или все удалены.") : "Снимите фильтр, чтобы увидеть остальные."}</span>
                  </div>
                ) : (
                  shown.map((tile) => (
                    <ResultCard
                      key={tile.key}
                      tile={tile}
                      jobs={view.jobs}
                      busy={busy.has(tile.key)}
                      asking={asking !== null && asking.key === tile.key}
                      tileRef={(el) => {
                        if (el === null) tileRefs.current.delete(tile.key);
                        else tileRefs.current.set(tile.key, el);
                      }}
                      trashRef={(el) => {
                        if (el === null) trashRefs.current.delete(tile.key);
                        else trashRefs.current.set(tile.key, el);
                      }}
                      onPublished={() => void togglePublished(tile)}
                      onDelete={() => {
                        setOutcome(null);
                        deleted.current = false;
                        setAsking(tile);
                      }}
                    />
                  ))
                )}
              </ResultsGrid>
            </section>
            <Journal launch={launch} log={got.log} nameOf={nameOf} wide={wide} shown={logShown} onMore={() => setLogShown((n) => n + LOG_PAGE)} />
          </div>
        </>
      )}

      {asking !== null && (
        <DeleteVideoDialog
          label={asking.label}
          published={asking.published}
          marksUnknown={asking.markUnknown}
          photos={asking.photos}
          busy={deleting}
          onCancel={() => setAsking(null)}
          onDelete={(choice) => void remove(asking, choice)}
          returnFocus={(sent) => (sent && deleted.current ? resultsTitle.current : (trashRefs.current.get(asking.key) ?? resultsTitle.current))}
        />
      )}
    </div>
  );
}

/** The tiles' scrolling area, its fade shown only while the tiles are longer than it (decision 1). */
function ResultsGrid({ wide, children }: { wide: boolean; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const over = useOverflows(scroller, content);
  return (
    <div className="ap-fw ap-res-wrap">
      <div ref={scroller} className="ap-sc">
        <div ref={content} className={wide ? "ap-res-grid" : "ap-res-grid ap-res-grid-2"}>
          {children}
        </div>
      </div>
      {over && <div className="ap-fd ap-fd-page" aria-hidden="true" />}
    </div>
  );
}

interface ResultCardProps {
  readonly tile: ResultTile;
  readonly jobs: readonly JobView[];
  readonly busy: boolean;
  /** Its delete dialog is open: the trash keeps its highlight behind the scrim (ApDeletePublished). */
  readonly asking: boolean;
  readonly tileRef: (el: HTMLElement | null) => void;
  readonly trashRef: (el: HTMLButtonElement | null) => void;
  readonly onPublished: () => void;
  readonly onDelete: () => void;
}

/** One video of the launch (LaunchStates «Результаты»): finished with its mark and trash, rendering with its frames, waiting for a track, or not made. */
function ResultCard({ tile, jobs, busy, asking, tileRef, trashRef, onPublished, onDelete }: ResultCardProps) {
  const ids = useId();
  const job = tile.state === "rendering" && tile.videoId !== null ? (jobs.find((j) => j.kind === "render" && j.videoId === tile.videoId) ?? null) : null;
  const rendering = job !== null && renderPhase(job) === "rendering" ? job : null;
  const quiet = tile.state === "waiting-music" || tile.state === "dropped" || tile.status?.tone === "faint";
  const classes = ["card", "ap-res", tile.state === "dropped" ? "ap-res-dropped-tile" : "", quiet ? "ap-res-quiet" : ""].filter(Boolean).join(" ");
  return (
    <article ref={tileRef} className={classes} aria-label={tile.label} tabIndex={-1} data-state={tile.state}>
      <div className="ap-res-thumb">
        {tile.summary !== null ? (
          <Poster avatarId={tile.avatarId} videoId={tile.videoId} hasPoster={tile.summary.hasPoster} clip={tile.summary.firstClip} />
        ) : (
          <div className="ph video-poster" aria-hidden="true">
            <div className="video-poster-none" style={{ background: tile.state === "done" || tile.state === "rendering" ? placeholderGradient(tile.videoId ?? tile.key) : undefined }} />
            {tile.state === "rendering" && <div className="shim" />}
          </div>
        )}
        {tile.bars > 0 && (
          <span className="ap-res-bars" aria-hidden="true">
            {Array.from({ length: tile.bars }, (_, i) => (
              <span key={i} className={i === 0 ? "ap-res-bar-on" : undefined} />
            ))}
          </span>
        )}
        {tile.published && (
          <span className="ap-res-pub" title="Опубликовано" aria-hidden="true">
            <Icon name="check" size={11} strokeWidth={3.4} />
          </span>
        )}
        <span className="pill mono ap-res-len">{tile.length}</span>
      </div>
      <div className="ap-res-body">
        <div className="ap-res-top">
          <div className="ap-res-heading">
            <h3 id={`${ids}-name`} className="ap-res-name">
              {tile.name}
            </h3>
            {tile.when !== null && <span className="mono faint ap-res-when">{tile.when}</span>}
          </div>
          {tile.actionable && (
            <button ref={trashRef} type="button" className={asking ? "ibtn ibtn-s ap-res-trash ap-res-trash-on" : "ibtn ibtn-s ap-res-trash"} aria-label={`Удалить ${tile.label}`} aria-haspopup="dialog" aria-disabled={busy || undefined} onClick={busy ? undefined : onDelete}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
        <span className="mono muted ap-res-meta">{tile.meta}</span>
        <div className="ap-res-music">
          <span className="ap-res-cover" aria-hidden="true" style={{ background: tile.music === null ? undefined : placeholderGradient(tile.music.text) }} />
          <span className={tile.music === null ? "faint ap-res-music-text" : "muted ap-res-music-text"} lang={tile.music === null || tile.music.own ? undefined : "en"}>
            {tile.music?.text ?? (tile.state === "waiting-music" ? "трека нет" : "—")}
          </span>
        </div>
        <div className="ap-res-foot">
          {tile.actionable ? (
            <span className={tile.published ? "ap-res-pubrow ap-res-pubrow-on" : "ap-res-pubrow"}>
              <button
                type="button"
                className={tile.published ? "sw sw-s sw-on" : "sw sw-s"}
                role="switch"
                aria-checked={tile.published}
                aria-label={`Опубликовано: ${tile.label}`}
                aria-busy={busy || undefined}
                onClick={busy ? undefined : onPublished}
              />
              <span aria-hidden="true">Опубликовано</span>
            </span>
          ) : rendering !== null ? (
            <div className="ap-res-render">
              <div className="ap-res-render-row">
                <span>Рендер</span>
                <span className="mono">
                  кадр {rendering.done} из {rendering.total}
                </span>
              </div>
              <div className="bar" role="progressbar" aria-label={`Рендер: ${tile.label}`} aria-valuemin={0} aria-valuemax={rendering.total} aria-valuenow={rendering.done}>
                <span style={{ width: `${percentOf(rendering.done, rendering.total)}%` }} />
              </div>
            </div>
          ) : tile.state === "rendering" ? (
            <span className="ap-res-status ap-fg-act">рендерится</span>
          ) : tile.status !== null ? (
            <span className={`ap-res-status ap-res-status-${tile.status.tone}`}>{tile.status.text}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** «Журнал» of the launch: «Потрачено $S из $W′» (and «Правки сцен» apart), then the whole log newest first, «Показать раньше» for older lines. */
function Journal({ launch, log, nameOf, wide, shown, onMore }: { launch: LaunchView; log: Parameters<typeof journalRows>[0]; nameOf: (avatarId: string) => string; wide: boolean; shown: number; onMore: () => void }) {
  const ids = useId();
  const rows = journalRows(log, launch.draft.sceneReview, nameOf);
  const block = spentBlock(launch);
  const visible = rows.slice(0, shown);
  return (
    <aside className="card ap-journal" aria-labelledby={`${ids}-log`}>
      <div className="ap-journal-head">
        <h2 id={`${ids}-log`} className="ap-h2">
          Журнал
        </h2>
        <span className="mono faint">{journalCount(log.length, log.length >= MAX_LAUNCH_LOG_LINES)}</span>
      </div>
      <div className="ap-spent">
        <div className="ap-spent-row">
          <span className="muted">Потрачено</span>
          <span className="mono ap-spent-value">
            {block.spent !== null && `${block.spent} `}
            <span className="faint">{block.of}</span>
          </span>
        </div>
        {block.spent !== null && (
          <div className="bar ap-spent-bar" role="img" aria-label={block.label}>
            <span className="ap-spent-settled" style={{ width: `${block.settledPct}%` }} />
            <span className="ap-hatch" style={{ width: `${block.openPct}%` }} />
          </div>
        )}
        {block.reviewWrites !== null && (
          <div className="ap-spent-row">
            <span className="muted">Правки сцен</span>
            <span className="mono ap-spent-value">
              {block.reviewWrites} <span className="faint">отдельно</span>
            </span>
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="faint ap-journal-none">В журнале пока пусто.</p>
      ) : (
        <ol aria-label="Журнал запуска" className={wide ? "mono ap-log ap-log-wrap ap-journal-log" : "mono ap-log ap-log-wrap ap-log-n ap-journal-log"}>
          {visible.map((row) => (
            <li key={row.key} className={`ap-log-${row.tone}`}>
              <span className="faint">{row.at}</span>
              {wide ? <span className="ap-log-who" title={row.who}>{row.who}</span> : null}
              <span>{wide || row.who === "—" ? row.text : `${row.who} · ${row.text}`}</span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > visible.length && (
        <button type="button" className="btn btn-s ap-journal-more" onClick={onMore}>
          Показать раньше
        </button>
      )}
    </aside>
  );
}
