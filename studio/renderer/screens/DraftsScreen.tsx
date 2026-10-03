import { useEffect, useId, useRef, useState } from "react";
import type { AvatarSummary, EngineError, MontageListItem, PhotoSummary } from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import { useEngine, useEngineView } from "../engine/react";
import { latestRenderOf, percentOf, renderPhase } from "../engine/renderJobs";
import { isActiveJob, type JobView } from "../engine/store";
import { countOf, NBSP, plural } from "../lib/format";
import { useNavigate } from "../navigation";
import { EngineOffline } from "../ui/EngineOffline";
import { Icon, Spin } from "../ui/Icon";
import { ErrorNotice } from "../ui/Notice";
import { ScreenTitle } from "../ui/ScreenTitle";
import { ClipPoster } from "./montage/ClipPoster";
import { draftMeta, draftTitle, whenLabel } from "./montage/labels";
import { photoProblems } from "./montage/renderBlock";
import { useMounted } from "./photos/shared";

// 3d.2: the drafts screen (EditorEmpty.dc.html, «Монтаж · черновики»), where the sidebar's «Монтаж» leads. The
// "how to start" card is always on top (AM3); the drafts below, newest first (`montages.list`), each with its
// poster, summary, a running render and what stops its render; «Пустой ролик» and the «Новый ролик» tile.

type PhotoIndex = ReadonlyMap<string, ReadonlyMap<string, PhotoSummary>>;

interface DraftList {
  readonly items: readonly MontageListItem[];
  readonly total: number;
  readonly skippedTotal: number;
  /** Per avatar whose drafts have a refused photo: its photos by id, to say why (rejected, in a video). */
  readonly photos: PhotoIndex;
}

const DRAFT_FORMS = ["черновик", "черновика", "черновиков"] as const;
const RENDER_FORMS = ["рендер идёт", "рендера идут", "рендеров идут"] as const;
const SKIPPED_FORMS = ["черновик не читается", "черновика не читаются", "черновиков не читаются"] as const;

/** The drafts, and the photos of the avatars whose drafts the engine flagged (a failed photos.list only loses the wording). */
async function loadDrafts(client: EngineClient): Promise<{ ok: true; list: DraftList } | { ok: false; error: EngineError }> {
  const reply = await client.request("montages.list", {});
  if (!reply.ok) return reply;
  const flagged = [...new Set(reply.result.items.filter((i) => i.issues.some((x) => x.code === "photo-unavailable")).map((i) => i.montage.spec.avatarId))];
  const answers = await Promise.all(flagged.map(async (avatarId) => ({ avatarId, reply: await client.request("photos.list", { avatarId }) })));
  const photos = new Map<string, ReadonlyMap<string, PhotoSummary>>();
  for (const { avatarId, reply: listed } of answers) if (listed.ok) photos.set(avatarId, new Map(listed.result.photos.map((p) => [p.photoId, p])));
  return { ok: true, list: { items: reply.result.items, total: reply.result.total, skippedTotal: reply.result.skippedTotal, photos } };
}

/** The render of this draft still queued or running, the newest if several. */
function activeRenderOf(jobs: readonly JobView[], montageId: string): JobView | null {
  const latest = latestRenderOf(jobs, montageId);
  return latest !== null && isActiveJob(latest) ? latest : null;
}

/**
 * The one note under a draft's summary (D14, D15). A photo the engine refuses for a reason the owner can fix comes
 * first, in amber; then «✓ уже N видео из этого черновика». A photo held by a render in flight is not a note: the
 * render shows.
 */
function cardNote(item: MontageListItem, photos: ReadonlyMap<string, PhotoSummary>): { text: string; warn: boolean } | null {
  const flagged = photoProblems(item.montage.spec, { spec: item.montage.spec, issues: item.issues }, photos);
  const fixable = flagged.find((f) => f.problem === "rejected" || f.problem === "unavailable");
  if (fixable) {
    const what = fixable.problem === "rejected" ? "фото отклонено" : "фото недоступно";
    return { text: `Кадр ${fixable.clip + 1}: ${what} — замените его, иначе рендер недоступен`, warn: true };
  }
  if (item.videoCount > 0) return { text: `✓ уже ${item.videoCount}${NBSP}видео из этого черновика`, warn: false };
  const used = flagged.find((f) => f.problem === "used");
  if (used) return { text: `Кадр ${used.clip + 1}: фото уже в другом видео — замените его, иначе рендер недоступен`, warn: true };
  return null;
}

function DraftCard({ item, avatar, photos, job, now }: { item: MontageListItem; avatar: AvatarSummary | null; photos: ReadonlyMap<string, PhotoSummary>; job: JobView | null; now: Date }) {
  const { client } = useEngine();
  const navigate = useNavigate();
  const mounted = useMounted();
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const { montage } = item;
  const title = draftTitle(avatar?.name ?? null, montage.name);
  const note = cardNote(item, photos);
  const first = montage.spec.clips[0];
  const phase = job === null ? null : renderPhase(job);
  const percent = job === null ? 0 : percentOf(job.done, job.total);

  async function remove(): Promise<void> {
    setDeleting(true);
    setError(null);
    const reply = await client.request("montages.delete", { montageId: montage.montageId });
    if (!mounted.current) return;
    setDeleting(false);
    // Deleted: the list drops the card on its own (montage.changed removed refetches it).
    if (!reply.ok) setError(reply.error);
    else setConfirming(false);
  }

  return (
    <article className={note?.warn ? "card draft-card draft-card-warn" : "card draft-card"} aria-labelledby={titleId}>
      <div className={first === undefined ? "ph draft-poster draft-poster-empty" : "ph draft-poster"} aria-hidden="true">
        {first === undefined ? <Icon name="plus" size={18} /> : <ClipPoster clip={first} avatarId={montage.spec.avatarId} />}
        {job !== null && <div className="shim" />}
      </div>
      <div className="draft-body">
        <div className="draft-top">
          <div className="draft-heading">
            <h3 id={titleId} className="draft-name">
              {title}
            </h3>
            <span className="mono faint draft-when">{whenLabel(montage.updatedAt, now)}</span>
          </div>
          <button type="button" className="ibtn draft-delete" aria-label={`Удалить черновик ${title}`} disabled={confirming || deleting} onClick={() => setConfirming(true)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
        <span className="mono muted">{draftMeta(montage.spec)}</span>
        <div className="draft-tags">
          {avatar !== null && <span className="tag">{avatar.name}</span>}
          {montage.spec.music !== null && (
            <span className="tag draft-tag-music">
              <Icon name="music" size={10} strokeWidth={2.4} />
              трек
            </span>
          )}
        </div>
        {job !== null && (
          <div className="draft-render">
            <div className="draft-render-row">
              <span>{phase === "queued" ? "В очереди" : phase === "saving" ? "Сохранение…" : "Рендер"}</span>
              {phase === "rendering" && <span className="mono">{percent}{NBSP}%</span>}
            </div>
            <div className="bar" role="progressbar" aria-label={`Рендер: ${title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        {note !== null && <span className={note.warn ? "draft-note warn-text" : "draft-note draft-note-ok"}>{note.text}</span>}
        {error !== null && <ErrorNotice error={error} />}
        {confirming ? (
          <div className="draft-confirm" role="alert">
            <span>
              Удалить черновик?{" "}
              {job !== null ? "Рендер из него продолжится, видео сохранится." : "Видео из него останутся в «Готовых видео»."}
            </span>
            <div className="draft-actions">
              <button type="button" className="btn btn-s btn-d" aria-busy={deleting} disabled={deleting} onClick={() => void remove()}>
                {deleting && <Spin />}
                Удалить
              </button>
              <button type="button" className="btn btn-s" disabled={deleting} onClick={() => setConfirming(false)}>
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <div className="draft-actions">
            <button type="button" className="btn btn-s" onClick={() => navigate({ name: "editor", montageId: montage.montageId })}>
              Открыть
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

/** The schematic on the hint card, as drawn: a dashed collage, a few lines of text, and the timeline waiting for its clips. */
function HintSketch() {
  return (
    <div className="drafts-sketch" aria-hidden="true">
      <div className="drafts-sketch-frame">
        <div />
        <div />
        <div />
      </div>
      <div className="drafts-sketch-lines">
        <div />
        <div />
        <div />
      </div>
      <div className="drafts-sketch-tracks">
        <div className="drafts-sketch-track">
          <div className="drafts-sketch-text" />
        </div>
        <div className="drafts-sketch-clips">кадры появятся здесь</div>
        <div className="drafts-sketch-track" />
      </div>
      <div className="drafts-sketch-playhead" />
    </div>
  );
}

/** «Пустой ролик»: straight away for one avatar; under «Все» with several avatars, a small list to pick one (AM1). */
function EmptyDraftButton({ avatars, filter, busy, onCreate }: { avatars: readonly AvatarSummary[]; filter: string | null; busy: boolean; onCreate: (avatarId: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const active = avatars.filter((a) => a.status === "active");
  const chosen = filter !== null ? (active.find((a) => a.avatarId === filter) ?? null) : active.length === 1 ? (active[0] ?? null) : null;
  const archived = filter !== null && chosen === null;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !wrap.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);

  const reason = active.length === 0 ? "Сначала нужен аватар" : archived ? "Аватар в архиве — новые ролики для него не создаются" : undefined;
  return (
    <div className="drafts-new" ref={wrap}>
      <button
        type="button"
        className="btn"
        aria-busy={busy}
        disabled={busy || reason !== undefined}
        title={reason}
        aria-haspopup={chosen === null ? "menu" : undefined}
        aria-expanded={chosen === null ? open : undefined}
        aria-controls={chosen === null && open ? menuId : undefined}
        onClick={() => (chosen !== null ? onCreate(chosen.avatarId) : setOpen((o) => !o))}
      >
        {busy ? <Spin /> : <Icon name="plus" size={16} strokeWidth={2.2} />}
        Пустой ролик
      </button>
      {open && chosen === null && (
        <ul id={menuId} className="drafts-menu" role="menu" aria-label="Для какого аватара">
          {active.map((a) => (
            <li key={a.avatarId} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onCreate(a.avatarId);
                }}
              >
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DraftsScreen({ lastAvatarId }: { lastAvatarId: string | null }) {
  const view = useEngineView();
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const mounted = useMounted();
  const hintId = useId();
  const listId = useId();
  const ready = view.phase === "ready";
  const [list, setList] = useState<DraftList | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<EngineError | null>(null);

  // Listed again whenever a draft changes, an avatar changes (a render's end or a reject changes what a draft can
  // use: the engine's issues are refetched, never guessed), or the window comes back.
  useEffect(() => store.subscribeMontages(() => setRefresh((n) => n + 1)), [store]);
  useEffect(() => {
    const again = (): void => setRefresh((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void loadDrafts(client).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setList(result.list);
        setError(null);
      } else setError(result.error);
    });
    return () => {
      alive = false;
    };
  }, [ready, client, refresh, view.avatars]);

  async function createEmpty(avatarId: string): Promise<void> {
    setCreating(true);
    setCreateError(null);
    const reply = await client.request("montages.create", { avatarId, photoIds: [] });
    if (!mounted.current) return;
    setCreating(false);
    if (reply.ok) navigate({ name: "editor", montageId: reply.result.montage.montageId, created: true });
    else setCreateError(reply.error);
  }

  const avatarOf = (avatarId: string): AvatarSummary | null => view.avatars.find((a) => a.avatarId === avatarId) ?? null;
  const items = (list?.items ?? []).filter((i) => filter === null || i.montage.spec.avatarId === filter);
  const withDrafts = view.avatars.filter((a) => a.avatarId === filter || (list?.items ?? []).some((i) => i.montage.spec.avatarId === a.avatarId));
  const renders = view.jobs.filter((j) => j.kind === "render" && isActiveJob(j) && (filter === null || j.avatarId === filter)).length;
  const count = filter === null ? (list?.total ?? 0) : items.length;
  const photosAvatar = (filter !== null ? avatarOf(filter) : null) ?? (lastAvatarId !== null ? avatarOf(lastAvatarId) : null) ?? view.avatars.find((a) => a.status === "active") ?? null;
  const now = new Date();

  return (
    <div className="page drafts-page">
      <header className="page-head">
        <div>
          <ScreenTitle>Монтаж</ScreenTitle>
          <p className="mono muted page-sub">
            {list === null ? "…" : countOf(count, DRAFT_FORMS)}
            {renders > 0 && ` · ${renders}${NBSP}${plural(renders, RENDER_FORMS)}`}
          </p>
        </div>
        <div className="page-actions">
          {withDrafts.length > 0 && (
            <div className="seg seg-l" role="group" aria-label="Аватар">
              <button type="button" className={filter === null ? "on" : undefined} aria-pressed={filter === null} onClick={() => setFilter(null)}>
                Все
              </button>
              {withDrafts.map((a) => (
                <button key={a.avatarId} type="button" className={filter === a.avatarId ? "on" : undefined} aria-pressed={filter === a.avatarId} onClick={() => setFilter(a.avatarId)}>
                  {a.name}
                </button>
              ))}
            </div>
          )}
          <EmptyDraftButton avatars={view.avatars} filter={filter} busy={creating} onCreate={(id) => void createEmpty(id)} />
        </div>
      </header>

      {view.phase === "offline" && <EngineOffline view={view} />}
      {createError !== null && <ErrorNotice error={createError} />}

      <section className="card drafts-hint" aria-labelledby={hintId}>
        <HintSketch />
        <div className="drafts-hint-body">
          <div className="drafts-hint-text">
            <h2 id={hintId} className="drafts-hint-title">
              Фото для нового ролика ещё не выбраны
            </h2>
            <p className="muted">
              Ролик собирается из фото аватара. Отметьте их на экране «Фото» — выбранные встанут на таймлайн кадрами по порядку. Дальше добавьте текст, стикеры и трек
              из трендов. Или откройте черновик ниже.
            </p>
          </div>
          <ol className="drafts-steps" aria-label="Как начать">
            <li>
              <span className="mono drafts-step-num">1</span>Откройте аватара
            </li>
            <li className="drafts-step-line" aria-hidden="true" />
            <li>
              <span className="mono drafts-step-num">2</span>Отметьте фото
            </li>
            <li className="drafts-step-line" aria-hidden="true" />
            <li className="drafts-step-now">
              <span className="mono drafts-step-num">3</span>«Монтаж из выбранных»
            </li>
          </ol>
          <div className="drafts-hint-actions">
            {photosAvatar !== null && (
              <button type="button" className="btn btn-p" onClick={() => navigate({ name: "photos", avatarId: photosAvatar.avatarId })}>
                Открыть фото {photosAvatar.name}
              </button>
            )}
            <span className="faint drafts-hint-rule">Фото из «Отклонённых» в монтаж не попадают.</span>
          </div>
        </div>
      </section>

      <section className="drafts-list" aria-labelledby={listId} aria-busy={list === null && error === null}>
        <div className="drafts-list-head">
          <h2 id={listId} className="card-title">
            Черновики
          </h2>
          <span className="mono muted">{list === null ? "…" : `${items.length} · сохраняются сами`}</span>
          {list !== null && list.skippedTotal > 0 && <span className="mono faint">ещё {countOf(list.skippedTotal, SKIPPED_FORMS)}</span>}
        </div>
        {error !== null && (
          <ErrorNotice
            error={error}
            actions={
              <button type="button" className="btn btn-s" onClick={() => setRefresh((n) => n + 1)}>
                Повторить
              </button>
            }
          />
        )}
        <div className="drafts-grid">
          {list === null && error === null
            ? Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="card draft-card draft-card-loading" aria-hidden="true">
                  <div className="ph draft-poster">
                    <div className="shim" />
                  </div>
                  <div className="draft-body">
                    <span className="skeleton-line" />
                    <span className="skeleton-line" />
                  </div>
                </div>
              ))
            : items.map((item) => (
                <DraftCard
                  key={item.montage.montageId}
                  item={item}
                  avatar={avatarOf(item.montage.spec.avatarId)}
                  photos={list?.photos.get(item.montage.spec.avatarId) ?? new Map()}
                  job={activeRenderOf(view.jobs, item.montage.montageId)}
                  now={now}
                />
              ))}
          <button type="button" className="drafts-new-tile" onClick={() => navigate({ name: "photos", avatarId: photosAvatar?.avatarId ?? null })}>
            <span className="tile-icon drafts-new-icon" aria-hidden="true">
              <Icon name="plus" size={20} strokeWidth={2.2} />
            </span>
            <span className="new-tile-title">Новый ролик</span>
            <span className="mono muted">из фото аватара · бесплатно</span>
          </button>
        </div>
      </section>
    </div>
  );
}
