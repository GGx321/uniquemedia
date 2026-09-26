import { useEffect, useRef, useState } from "react";
import type { AvatarSummary, Draft, EngineError, Estimate, UnreadableAvatar } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../engine/store";
import { countOf, dateLabel, yearsOld } from "../lib/format";
import { estimateLine, formatUsd } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { ETHNICITIES } from "../lib/traits";
import { useNavigate } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { RadioChoices } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { ErrorNotice, Notice } from "../ui/Notice";
import { Portrait, PortraitPlaceholder } from "../ui/Portrait";
import { ScreenTitle } from "../ui/ScreenTitle";

type Filter = "active" | "archived";

const AVATAR_FORMS = ["аватар", "аватара", "аватаров"] as const;
const DRAFT_FORMS = ["черновик", "черновика", "черновиков"] as const;

/** Never the raw `detail` (contract text, not user copy) — a fixed Russian line per reason instead. */
const UNREADABLE_REASON_LABEL: Record<UnreadableAvatar["reason"], string> = {
  "manifest-unreadable": "Файл повреждён",
  "descriptor-invalid": "Описание устарело",
  "contract-mismatch": "Старый формат",
};

const UNREADABLE_REASON_TEXT: Record<UnreadableAvatar["reason"], string> = {
  "manifest-unreadable": "Файл записи не удалось прочитать или разобрать. Он перемещён в карантин при запуске движка.",
  "descriptor-invalid": "Описание аватара не проходит текущую проверку возраста. Его можно переписать заново — портрет, кандидаты и имя останутся как есть.",
  "contract-mismatch": "Запись сохранена в формате, который сегодняшняя версия Studio больше не читает.",
};

/**
 * A React key per unreadable entry: its `avatarId` when the engine could
 * recover one, otherwise its reason plus that entry's own position within
 * just that reason — stable across a reordering of the list itself (a fresh
 * snapshot, say), unlike the overall array index.
 */
function unreadableKeys(list: readonly UnreadableAvatar[]): string[] {
  const seenPerReason = new Map<UnreadableAvatar["reason"], number>();
  return list.map((u) => {
    if (u.avatarId !== null) return u.avatarId;
    const n = seenPerReason.get(u.reason) ?? 0;
    seenPerReason.set(u.reason, n + 1);
    return `${u.reason}-${n}`;
  });
}

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

type RewriteBusy = "estimate" | "rewrite" | null;

/**
 * A grid tile for a record the engine could not read into the normal lists
 * (`unreadableAvatars`). `descriptor-invalid` is the one recoverable reason:
 * its «Переписать описание» goes through the same estimate-then-accept
 * pattern as the wizard's EstimateCard (avatars.estimateRewriteDescriptor,
 * then avatars.rewriteDescriptor with that estimate's own worst case). On
 * success the tile disappears on its own — avatar.changed/draft.changed lists
 * the id normally and the store drops it from unreadableAvatars there.
 */
function UnreadableTile({ entry, view, index }: { entry: UnreadableAvatar; view: EngineView; index: number }) {
  const { client } = useEngine();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [busy, setBusy] = useState<RewriteBusy>(null);
  const [error, setError] = useState<EngineError | null>(null);
  // False once this tile is gone (a rewrite elsewhere lists the avatar, or the grid re-renders past it):
  // a paid step already under way must not set state on an unmounted component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const avatarId = entry.avatarId;
  const rewritable = entry.reason === "descriptor-invalid" && avatarId !== null;
  const titleId = `unreadable-${index}`;

  const key = view.settings?.apiKey;
  const keyUsable = key !== undefined && key.stored && !key.rejected;
  const stop = paidStop(view);
  const offline = view.phase === "offline";
  let blockedReason: string | null = null;
  if (offline) blockedReason = "Нет связи с движком — дождитесь, пока он снова ответит.";
  else if (!keyUsable) blockedReason = "Нужен рабочий ключ OpenRouter — добавьте его в Настройках.";
  else if (stop?.kind === "reconcile") blockedReason = "Платные запросы остановлены до сверки расходов.";
  else if (stop?.kind === "restart") blockedReason = restartStopText(stop.code);

  async function startEstimate(): Promise<void> {
    if (avatarId === null) return;
    setBusy("estimate");
    setError(null);
    const reply = await client.request("avatars.estimateRewriteDescriptor", { avatarId });
    if (!mounted.current) return;
    setBusy(null);
    if (reply.ok) {
      setEstimate(reply.result);
      setPreviousWorst(null);
    } else setError(reply.error);
  }

  /**
   * Stays busy through the whole PRICE_CHANGED chain, not just the first
   * request: clearing `busy` before the re-estimate lands would re-enable the
   * button while it still shows the old, rejected price, letting a second
   * click resend `rewriteDescriptor` with a stale `acceptedWorstMicros`
   * (refused by the engine, but still a double submit). Mirrors
   * AvatarWizard.tsx's `refused()`.
   */
  async function confirmRewrite(accepted: Estimate): Promise<void> {
    if (avatarId === null) return;
    setBusy("rewrite");
    setError(null);
    const reply = await client.request("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: accepted.worstMicros });
    if (!mounted.current) return;
    if (reply.ok) {
      setBusy(null);
      return; // avatar.changed/draft.changed drops this tile by itself.
    }
    if (reply.error.code === "PRICE_CHANGED") {
      const fresh = await client.request("avatars.estimateRewriteDescriptor", { avatarId });
      if (!mounted.current) return;
      setBusy(null);
      if (fresh.ok) {
        setEstimate(fresh.result);
        setPreviousWorst(accepted.worstMicros);
        return;
      }
      setError(fresh.error);
      return;
    }
    setBusy(null);
    setError(reply.error);
  }

  return (
    <article className="avatar-card avatar-card-unreadable" aria-labelledby={titleId}>
      <div className="avatar-card-media avatar-card-unreadable-media">
        <Icon name="alert" size={26} strokeWidth={1.6} />
      </div>
      <div className="avatar-card-body">
        <div className="avatar-card-row">
          <h2 id={titleId} className="avatar-name">
            Не читается
          </h2>
          <span className="pill pill-danger">{UNREADABLE_REASON_LABEL[entry.reason]}</span>
        </div>
        <p className="avatar-descriptor">{UNREADABLE_REASON_TEXT[entry.reason]}</p>

        {rewritable &&
          (estimate ? (
            <>
              <p className="mono faint">{estimateLine(estimate)}</p>
              {previousWorst !== null && (
                <Notice tone="warn" title="Цена выросла">
                  Было не больше {formatUsd(previousWorst, 2, "up")}, теперь не больше {formatUsd(estimate.worstMicros, 2, "up")}.
                </Notice>
              )}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy !== null || blockedReason !== null}
                aria-busy={busy === "rewrite"}
                onClick={() => void confirmRewrite(estimate)}
              >
                {busy === "rewrite"
                  ? "Переписываем…"
                  : previousWorst !== null
                    ? `Подтвердить новую цену · до ${formatUsd(estimate.worstMicros, 2, "up")}`
                    : `Переписать · до ${formatUsd(estimate.worstMicros, 2, "up")}`}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null || blockedReason !== null}
              aria-busy={busy === "estimate"}
              onClick={() => void startEstimate()}
            >
              {busy === "estimate" ? "Считаем…" : "Переписать описание"}
            </button>
          ))}
        {rewritable && blockedReason && <p className="field-hint">{blockedReason}</p>}
        {rewritable && error && <ErrorNotice error={error} />}
      </div>
    </article>
  );
}

/** How many unreadable records the bounded list left out (`unreadableTotal` never itself is cut). */
function UnreadableMoreTile({ count }: { count: number }) {
  return (
    <article className="avatar-card unreadable-more-tile" aria-label="Показаны не все нечитаемые записи">
      <div className="avatar-card-media avatar-card-unreadable-media">
        <Icon name="alert" size={22} strokeWidth={1.6} />
      </div>
      <div className="avatar-card-body">
        <p className="muted">Показаны не все нечитаемые записи</p>
        <p className="field-hint">Ещё {countOf(count, ["запись не читается", "записи не читаются", "записей не читаются"])}.</p>
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
  // Unreadable records sit with the other to-dos on the active tab; the archive filter is only for browsing archived avatars.
  const unreadable = filter === "active" ? view.unreadableAvatars : [];
  const unreadableKeyList = unreadableKeys(unreadable);
  const unreadableMore = filter === "active" ? Math.max(0, view.unreadableTotal - view.unreadableAvatars.length) : 0;
  const isEmpty = ready && view.avatars.length === 0 && view.drafts.length === 0 && view.unreadableTotal === 0;

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
              {unreadable.map((u, i) => (
                <UnreadableTile key={unreadableKeyList[i]} entry={u} view={view} index={i} />
              ))}
              {unreadableMore > 0 && <UnreadableMoreTile count={unreadableMore} />}
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
