import { useEffect, useState } from "react";
import type { AvatarSummary, Draft } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../engine/store";
import { countOf, dateLabel, yearsOld } from "../lib/format";
import { ETHNICITIES } from "../lib/traits";
import { useNavigate } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { RadioChoices } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { Notice } from "../ui/Notice";
import { Portrait, PortraitPlaceholder } from "../ui/Portrait";
import { ScreenTitle } from "../ui/ScreenTitle";

type Filter = "active" | "archived";

const AVATAR_FORMS = ["аватар", "аватара", "аватаров"] as const;
const DRAFT_FORMS = ["черновик", "черновика", "черновиков"] as const;

function latestJobFor(jobs: readonly JobView[], avatarId: string): JobView | null {
  const own = jobs.filter((j) => j.avatarId === avatarId);
  return own[own.length - 1] ?? null;
}

function AvatarCard({ avatar, index }: { avatar: AvatarSummary; index: number }) {
  const titleId = `avatar-${avatar.avatarId}`;
  const archived = avatar.status === "archived";
  return (
    <article className="avatar-card" aria-labelledby={titleId} style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}>
      <div className="avatar-card-media">
        <Portrait avatarId={avatar.avatarId} photoId={avatar.masterPhotoId} label={`Мастер-портрет: ${avatar.name}`} />
        <span className={archived ? "pill pill-muted avatar-status" : "pill pill-ok avatar-status"}>
          {archived ? "В архиве" : "Активен"}
        </span>
      </div>
      <div className="avatar-card-body">
        <div className="avatar-card-row">
          <h2 id={titleId} className="avatar-name">
            {avatar.name}
          </h2>
          <span className="mono muted">{avatar.photoCount} фото</span>
        </div>
        <p className="avatar-descriptor" lang="en">
          {avatar.descriptor.text}
        </p>
        <span className="mono faint">{dateLabel(avatar.createdAt)}</span>
      </div>
    </article>
  );
}

function draftState(draft: Draft, job: JobView | null): { text: string; tone: "accent" | "ok" | "danger" | "muted" } {
  if (job && isActiveJob(job)) return { text: `Генерация · ${job.done} из ${job.total || 4}`, tone: "accent" };
  if (job?.status === "failed") return { text: "Ошибка генерации", tone: "danger" };
  if (draft.candidates.length > 0) return { text: `${countOf(draft.candidates.length, ["вариант", "варианта", "вариантов"])} — выберите`, tone: "ok" };
  return { text: "Черновик", tone: "muted" };
}

function DraftCard({ draft, job, index }: { draft: Draft; job: JobView | null; index: number }) {
  const navigate = useNavigate();
  const titleId = `draft-${draft.avatarId}`;
  const state = draftState(draft, job);
  const last = draft.candidates[draft.candidates.length - 1];
  const ethnicity = ETHNICITIES.find((e) => e.value === draft.traits.ethnicity)?.label ?? "";
  return (
    <article className="avatar-card avatar-card-draft" aria-labelledby={titleId} style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}>
      <div className="avatar-card-media">
        {last ? (
          <Portrait avatarId={last.avatarId} photoId={last.photoId} label="Последний вариант черновика" />
        ) : (
          <PortraitPlaceholder seed={draft.avatarId} label="Черновик без вариантов" />
        )}
        <span className={`pill pill-${state.tone} avatar-status`}>{state.text}</span>
      </div>
      <div className="avatar-card-body">
        <div className="avatar-card-row">
          <h2 id={titleId} className="avatar-name">
            Черновик
          </h2>
          <span className="mono muted">{yearsOld(draft.traits.age)}</span>
        </div>
        <p className="avatar-descriptor">{ethnicity} типаж</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => navigate({ name: "avatarNew", draftId: draft.avatarId })}
          aria-describedby={titleId}
        >
          Продолжить
        </button>
      </div>
    </article>
  );
}

function NewAvatarTile() {
  const navigate = useNavigate();
  return (
    <button type="button" className="new-tile" onClick={() => navigate({ name: "avatarNew", draftId: null })}>
      <span className="new-tile-icon">
        <Icon name="plus" size={22} strokeWidth={2.2} />
      </span>
      <span className="new-tile-title">Новый аватар</span>
      <span className="mono muted">4 варианта на выбор, цена — до запуска</span>
    </button>
  );
}

function EmptyLibrary({ view }: { view: EngineView }) {
  const navigate = useNavigate();
  const keyStored = view.settings?.apiKey.stored ?? false;
  return (
    <section className="empty" aria-labelledby="empty-title">
      <div className="empty-art" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2 id="empty-title" className="empty-title">
        Библиотека пуста
      </h2>
      <p className="empty-text">
        Аватар — это вымышленная взрослая девушка 21+ с постоянной внешностью. Опишите её, выберите лучший из четырёх
        портретов — и он станет мастер-кадром для всех будущих фото.
      </p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={() => navigate({ name: "avatarNew", draftId: null })}>
          <Icon name="plus" size={16} strokeWidth={2.2} />
          Создать первый аватар
        </button>
        {!keyStored && (
          <button type="button" className="btn" onClick={() => navigate({ name: "settings", focus: "key" })}>
            Сначала добавить ключ OpenRouter
          </button>
        )}
      </div>
    </section>
  );
}

function SkeletonGrid() {
  return (
    <div className="avatar-grid" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="avatar-card skeleton">
          <div className="avatar-card-media shimmer" />
          <div className="avatar-card-body">
            <span className="skeleton-line" />
            <span className="skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AvatarsScreen({ saved }: { saved?: string }) {
  const { store } = useEngine();
  const view = useEngineView();
  const [filter, setFilter] = useState<Filter>("active");
  const ready = view.phase === "ready";

  // The snapshot brings the avatars; `avatars.list` refreshes them whenever the screen opens.
  useEffect(() => {
    if (ready) void store.refreshAvatars();
  }, [ready, store]);

  const active = view.avatars.filter((a) => a.status === "active");
  const archived = view.avatars.filter((a) => a.status === "archived");
  const photoTotal = active.reduce((sum, a) => sum + a.photoCount, 0);
  const shown = filter === "active" ? active : archived;
  const drafts = filter === "active" ? view.drafts : [];
  const isEmpty = ready && view.avatars.length === 0 && view.drafts.length === 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <ScreenTitle>Аватары</ScreenTitle>
          {ready && !isEmpty && (
            <p className="page-sub mono">
              {countOf(active.length, AVATAR_FORMS)} · {photoTotal} фото
              {view.drafts.length > 0 && ` · ${countOf(view.drafts.length, DRAFT_FORMS)}`}
            </p>
          )}
        </div>
        {ready && !isEmpty && (
          <div className="page-actions">
            <RadioChoices<Filter>
              legend="Показать"
              legendHidden
              variant="segments"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "active", label: `Активные · ${active.length}` },
                { value: "archived", label: `Архив · ${archived.length}` },
              ]}
            />
          </div>
        )}
      </header>

      {saved && <Notice tone="ok">Аватар «{saved}» сохранён. Мастер-портрет готов для фото.</Notice>}
      {ready && <AccountBanner view={view} />}

      {view.phase === "connecting" && <SkeletonGrid />}

      {view.phase === "offline" && <EngineOffline view={view} />}

      {isEmpty && <EmptyLibrary view={view} />}

      {ready && !isEmpty && (
        <>
          {shown.length === 0 && drafts.length === 0 && filter === "archived" ? (
            <p className="muted empty-inline">В архиве пока никого нет.</p>
          ) : (
            <div className="avatar-grid">
              {drafts.map((d, i) => (
                <DraftCard key={d.avatarId} draft={d} job={latestJobFor(view.jobs, d.avatarId)} index={i} />
              ))}
              {shown.map((a, i) => (
                <AvatarCard key={a.avatarId} avatar={a} index={i + drafts.length} />
              ))}
              {filter === "active" && <NewAvatarTile />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
