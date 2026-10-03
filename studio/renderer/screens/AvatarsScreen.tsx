import { useEffect, useId, useRef, useState } from "react";
import { IMPORT_FALLBACK_PRICE, type AvatarSummary, type Draft, type EngineError, type Estimate, type UnreadableAvatar } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../engine/store";
import { countOf, groupNumber, NBSP, yearsOld } from "../lib/format";
import { formatUsd, formatUsdRange } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { DEFAULT_TRAITS, ETHNICITIES } from "../lib/traits";
import { useNavigate } from "../navigation";
import { AccountBanner } from "../ui/AccountBanner";
import { EngineOffline } from "../ui/EngineOffline";
import { RadioChoices } from "../ui/Choice";
import { Icon, Spin } from "../ui/Icon";
import { ErrorNotice, Notice } from "../ui/Notice";
import { Portrait, PortraitPlaceholder, Silhouette } from "../ui/Portrait";
import { ScreenTitle } from "../ui/ScreenTitle";

type Filter = "all" | "active" | "archived";

const AVATAR_FORMS = ["аватар", "аватара", "аватаров"] as const;

/** A short name per reason, for the tile's warning badge (screen readers only: the line under the name says it in full). */
const UNREADABLE_REASON_LABEL: Record<UnreadableAvatar["reason"], string> = {
  "manifest-unreadable": "файл повреждён",
  "descriptor-invalid": "описание устарело",
  "contract-mismatch": "старый формат",
};

/** Never the raw `detail` (contract text, not user copy) — a fixed Russian line per reason instead. */
const UNREADABLE_REASON_TEXT: Record<UnreadableAvatar["reason"], string> = {
  "manifest-unreadable": "файл записи не читается — при запуске движок перенёс его в карантин",
  "descriptor-invalid": "описание не проходит текущую проверку",
  "contract-mismatch": "запись в старом формате — эта версия Studio её не читает",
};

/** Status colours of a pill on a photo: the text carries the status, the background stays the scrim. */
const PILL_TONE = {
  drawing: "var(--link)",
  ok: "var(--ok)",
  danger: "var(--danger)",
  muted: "var(--muted)",
} as const;

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

function photosLabel(count: number): string {
  return `${groupNumber(count)}${NBSP}фото`;
}

/**
 * A saved avatar. The sheet's tile also carries «N новых» and category tags;
 * the contract has neither, so the name, the photo count and (3e.2) the video
 * count are drawn, the last opening the avatar's «Видео» tab.
 */
function AvatarCard({ avatar }: { avatar: AvatarSummary }) {
  const navigate = useNavigate();
  const titleId = `avatar-${avatar.avatarId}`;
  return (
    <article className="card avatar-card" aria-labelledby={titleId}>
      <div className="ph">
        <Portrait avatarId={avatar.avatarId} photoId={avatar.masterPhotoId} label={`Мастер-портрет: ${avatar.name}`} />
        {avatar.status === "archived" && (
          <span className="pill avatar-pill" style={{ color: PILL_TONE.muted }}>
            В архиве
          </span>
        )}
      </div>
      <div className="avatar-body">
        <div className="avatar-row">
          <h2 id={titleId} className="avatar-name">
            {/* The sheet's name is a link to the avatar's photos (Main.dc.html → Photos.dc.html), drawn as the plain name. */}
            <button type="button" className="avatar-link" onClick={() => navigate({ name: "photos", avatarId: avatar.avatarId })}>
              {avatar.name}
            </button>
          </h2>
        </div>
        <span className="mono muted avatar-counts">
          {photosLabel(avatar.photoCount)} ·{" "}
          <button type="button" className="avatar-link avatar-videos" aria-label={`Видео аватара ${avatar.name}: ${avatar.videoCount}`} onClick={() => navigate({ name: "photos", avatarId: avatar.avatarId, tab: "videos" })}>
            {groupNumber(avatar.videoCount)}
            {NBSP}видео
          </button>
        </span>
      </div>
    </article>
  );
}

function draftState(draft: Draft, job: JobView | null): { text: string; tone: keyof typeof PILL_TONE; drawing: boolean } {
  if (job && isActiveJob(job)) return { text: `Генерация · ${job.done} из ${job.total || 4}`, tone: "drawing", drawing: true };
  if (job?.status === "failed") return { text: "Ошибка генерации", tone: "danger", drawing: false };
  if (draft.candidates.length > 0) return { text: `${countOf(draft.candidates.length, ["вариант", "варианта", "вариантов"])} — выберите`, tone: "ok", drawing: false };
  return { text: "Черновик", tone: "muted", drawing: false };
}

function DraftCard({ draft, job }: { draft: Draft; job: JobView | null }) {
  const navigate = useNavigate();
  const titleId = `draft-${draft.avatarId}`;
  const state = draftState(draft, job);
  const last = draft.candidates[draft.candidates.length - 1];
  const ethnicity = ETHNICITIES.find((e) => e.value === draft.traits.ethnicity)?.label ?? "";
  return (
    <article className="card avatar-card avatar-card-draft" aria-labelledby={titleId}>
      <div className="ph">
        {last ? (
          <Portrait avatarId={last.avatarId} photoId={last.photoId} label="Последний вариант черновика" />
        ) : (
          <PortraitPlaceholder seed={draft.avatarId} label="Черновик без вариантов" />
        )}
        {state.drawing && <div className="shim" aria-hidden="true" />}
        <span className="pill avatar-pill" style={{ color: PILL_TONE[state.tone] }}>
          {state.text}
        </span>
      </div>
      <div className="avatar-body">
        <div className="avatar-row">
          <h2 id={titleId} className="avatar-name">
            Черновик
          </h2>
          <span className="mono muted">{yearsOld(draft.traits.age)}</span>
        </div>
        <p className="avatar-note">{ethnicity} типаж</p>
        <button
          type="button"
          className="btn btn-s"
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
 * (`unreadableAvatars`). `descriptor-invalid` is the one recoverable reason.
 * Its price is asked for as soon as the tile is shown
 * (avatars.estimateRewriteDescriptor, free), so the one «Переписать описание»
 * button carries it — «до $X» on its second line — and a click accepts
 * exactly that shown worst case (avatars.rewriteDescriptor with that
 * estimate's own `acceptedWorstMicros`). Nothing paid is sent before that
 * click. PRICE_CHANGED shows the new price and asks again. If the price could
 * not be fetched, the button asks for it instead and only then offers the
 * rewrite. On success the tile disappears on its own — avatar.changed /
 * draft.changed lists the id normally and the store drops it from
 * unreadableAvatars there.
 */
function UnreadableTile({ entry, view, index, hidden }: { entry: UnreadableAvatar; view: EngineView; index: number; hidden: boolean }) {
  const { client } = useEngine();
  const avatarId = entry.avatarId;
  const rewritable = entry.reason === "descriptor-invalid" && avatarId !== null;
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  // Busy from the very first frame for a rewritable tile: its price is on its way before the button can ever be clicked.
  const [busy, setBusy] = useState<RewriteBusy>(() => (rewritable ? "estimate" : null));
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

  const titleId = `unreadable-${index}`;
  const hintId = useId();

  // The free price, fetched once when the tile first shows (the grid itself
  // is only drawn while the engine is ready). Never a paid call — that waits
  // for the button.
  useEffect(() => {
    if (!rewritable || avatarId === null) return;
    let alive = true;
    setBusy("estimate");
    setError(null);
    void client.request("avatars.estimateRewriteDescriptor", { avatarId }).then((reply) => {
      if (!alive) return;
      setBusy(null);
      if (reply.ok) {
        setEstimate(reply.result);
        setPreviousWorst(null);
      } else setError(reply.error);
    });
    return () => {
      alive = false;
    };
  }, [rewritable, avatarId, client]);

  const key = view.settings?.apiKey;
  const keyUsable = key !== undefined && key.stored && !key.rejected;
  const stop = paidStop(view);
  let blockedReason: string | null = null;
  if (stop?.kind === "offline") blockedReason = "Нет связи с движком — дождитесь, пока он снова ответит.";
  else if (!keyUsable) blockedReason = "Нужен рабочий ключ OpenRouter — добавьте его в Настройках.";
  else if (stop?.kind === "reconcile") blockedReason = "Платные запросы остановлены до сверки расходов.";
  else if (stop?.kind === "restart") blockedReason = restartStopText(stop.code);

  /** The retry when the tile's own price could not be fetched: the button then asks for it, and only a second click spends. */
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
      // The price just refused must not stay on the button: with none, a click only asks for a new one.
      setEstimate(null);
      setPreviousWorst(null);
      setError(fresh.error);
      return;
    }
    setBusy(null);
    setError(reply.error);
  }

  const title =
    busy === "estimate" ? "Считаем…" : busy === "rewrite" ? "Переписываем…" : previousWorst !== null ? "Подтвердить новую цену" : "Переписать описание";
  const price = estimate ? `до ${formatUsd(estimate.worstMicros, 2, "up")}` : null;
  // The engine's own last word on whether this record can be fixed at all
  // (#assertRewritable in engine.ts): never guessed client-side from `reason`
  // alone, since `isRewritable` can reject a record the snapshot still shows
  // as `descriptor-invalid` (e.g. a name over 60 chars beyond the descriptor).
  const notRewritable = rewritable && error?.code === "VALIDATION";

  return (
    <article className="card avatar-card avatar-card-unreadable" aria-labelledby={titleId} hidden={hidden}>
      <div className="ph unreadable-ph">
        <Silhouette />
        <span className="flag" role="img" aria-label={`Не читается: ${UNREADABLE_REASON_LABEL[entry.reason]}`}>
          <Icon name="alert" size={15} />
        </span>
      </div>
      <div className="avatar-body">
        <h2 id={titleId} className="avatar-name">
          {entry.name ?? "Без имени"}
        </h2>
        <p className="avatar-note">{UNREADABLE_REASON_TEXT[entry.reason]}</p>

        {rewritable && !notRewritable && previousWorst !== null && estimate && (
          <Notice tone="warn" title="Цена выросла">
            Было не больше {formatUsd(previousWorst, 2, "up")}, теперь не больше {formatUsd(estimate.worstMicros, 2, "up")}.
          </Notice>
        )}
        {rewritable && !notRewritable && (
          <button
            type="button"
            className={previousWorst !== null ? "btn btn-p btn-stack" : "btn btn-stack"}
            disabled={busy !== null || blockedReason !== null}
            aria-busy={busy !== null}
            aria-describedby={blockedReason ? hintId : undefined}
            onClick={() => void (estimate ? confirmRewrite(estimate) : startEstimate())}
          >
            <span className="btn-stack-line">
              {busy !== null && <Spin />}
              {title}
            </span>
            {price && (
              <>
                <span className="sr-only"> · </span>
                <span className="mono">{price}</span>
              </>
            )}
          </button>
        )}
        {notRewritable && <p className="field-hint">Эту запись переписать нельзя</p>}
        {rewritable && !notRewritable && blockedReason && (
          <p id={hintId} className="field-hint">
            {blockedReason}
          </p>
        )}
        {rewritable && !notRewritable && error && <ErrorNotice error={error} />}
      </div>
    </article>
  );
}

/** How many unreadable records the bounded list left out (`unreadableTotal` never itself is cut). */
function UnreadableMoreTile({ count }: { count: number }) {
  return (
    <article className="card avatar-card avatar-card-unreadable" aria-label="Показаны не все нечитаемые записи">
      <div className="ph unreadable-ph">
        <Silhouette />
        <span className="flag" aria-hidden="true">
          <Icon name="alert" size={15} />
        </span>
      </div>
      <div className="avatar-body">
        <p className="avatar-note">Показаны не все нечитаемые записи</p>
        <p className="field-hint">Ещё {countOf(count, ["запись не читается", "записи не читаются", "записей не читаются"])}.</p>
      </div>
    </article>
  );
}

/** «4 портрета · до $X»: the engine's own free estimate (its traits do not change the price); a plain promise until it arrives. */
function NewAvatarTile({ estimate }: { estimate: Estimate | null }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="new-tile" onClick={() => navigate({ name: "avatarNew", draftId: null })}>
      <span className="tile-icon">
        <Icon name="plus" size={22} strokeWidth={2.2} />
      </span>
      <span className="new-tile-title">Новый аватар</span>
      <span className="mono">4 портрета · {estimate ? `до ${formatUsd(estimate.worstMicros, 2, "up")}` : "цена до запуска"}</span>
    </button>
  );
}

// L8: no hard-coded money — the worst case plan.ts's importJobEstimate and the
// renderer's mock both use (IMPORT_FALLBACK_PRICE). «до» means a hard cap
// everywhere else in the app, but this is only the dated fallback table (used
// when OpenRouter did not answer) — the live price can be higher — so this is
// «≈» (nearest, not rounded up): a range from the expected price to the worst
// case, not the worst case alone prefixed with «≈» (which overstated the
// approximate cost about sevenfold here) — formatted the same way every other
// price in the app is (lib/money.ts).
const IMPORT_TILE_PRICE = `≈ ${formatUsdRange(IMPORT_FALLBACK_PRICE.whole.expectedMicros, IMPORT_FALLBACK_PRICE.whole.worstMicros, 2)}`;

/** T6c: one photo the owner already has, instead of generating one from a prompt. */
function ImportAvatarTile() {
  const navigate = useNavigate();
  return (
    <button type="button" className="new-tile" onClick={() => navigate({ name: "avatarImport" })}>
      <span className="tile-icon">
        <Icon name="upload" size={22} strokeWidth={2.2} />
      </span>
      <span className="new-tile-title">Импортировать аватара</span>
      <span className="mono">1 фото · {IMPORT_TILE_PRICE}</span>
    </button>
  );
}

function EmptyLibrary({ view }: { view: EngineView }) {
  const navigate = useNavigate();
  const keyStored = view.settings?.apiKey.stored ?? false;
  return (
    <section className="card empty" aria-labelledby="empty-title">
      <span className="tile-icon" aria-hidden="true">
        <Icon name="plus" size={22} strokeWidth={2.2} />
      </span>
      <h2 id="empty-title" className="empty-title">
        Библиотека пуста
      </h2>
      <p className="empty-text">
        Аватар — это вымышленная взрослая девушка 21+ с постоянной внешностью. Опишите её, выберите лучший из четырёх
        портретов — и он станет мастер-кадром для всех будущих фото.
      </p>
      <div className="empty-actions">
        <button type="button" className="btn btn-p" onClick={() => navigate({ name: "avatarNew", draftId: null })}>
          <Icon name="plus" size={16} strokeWidth={2.2} />
          Создать первый аватар
        </button>
        <button type="button" className="btn" onClick={() => navigate({ name: "avatarImport" })}>
          <Icon name="upload" size={16} strokeWidth={2.2} />
          Импортировать аватара
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
        <div key={i} className="card avatar-card">
          <div className="ph">
            <div className="shim" />
          </div>
          <div className="avatar-body">
            <span className="skeleton-line" />
            <span className="skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

function matches(name: string | null, query: string): boolean {
  return query === "" || (name ?? "").toLocaleLowerCase("ru-RU").includes(query);
}

export function AvatarsScreen({ saved }: { saved?: string }) {
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const view = useEngineView();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  // The «Новый аватар» tile's price, remembered with the age-check mode it was asked under.
  const [newAvatarPrice, setNewAvatarPrice] = useState<{ estimate: Estimate; imageAgeCheck: string | undefined } | null>(null);
  const ready = view.phase === "ready";

  // The snapshot brings the avatars; `avatars.list` refreshes them whenever the screen opens.
  useEffect(() => {
    if (ready) void store.refreshAvatars();
  }, [ready, store]);

  const active = view.avatars.filter((a) => a.status === "active");
  const archived = view.avatars.filter((a) => a.status === "archived");
  const photoTotal = active.reduce((sum, a) => sum + a.photoCount, 0);
  const isEmpty = ready && view.avatars.length === 0 && view.drafts.length === 0 && view.unreadableTotal === 0;
  const withTodo = filter !== "archived";
  const showTiles = ready && !isEmpty && withTodo;

  // The «Новый аватар» tile's «до $X»: the free new-avatar estimate, asked
  // once, and again only when the age-check toggle (which does change the
  // price) has moved since — the old price is dropped meanwhile.
  const imageAgeCheck = view.settings?.imageAgeCheck;
  const priceIsCurrent = newAvatarPrice !== null && newAvatarPrice.imageAgeCheck === imageAgeCheck;
  useEffect(() => {
    if (!showTiles || priceIsCurrent) return;
    let alive = true;
    setNewAvatarPrice(null);
    void client.request("avatars.estimate", { traits: DEFAULT_TRAITS }).then((reply) => {
      if (alive) setNewAvatarPrice(reply.ok ? { estimate: reply.result, imageAgeCheck } : null);
    });
    return () => {
      alive = false;
    };
  }, [showTiles, priceIsCurrent, imageAgeCheck, client]);

  const query = search.trim().toLocaleLowerCase("ru-RU");
  const shownAvatars = (filter === "all" ? view.avatars : filter === "active" ? active : archived).filter((a) => matches(a.name, query));
  // Drafts and unreadable records are to-dos: with the saved avatars, not in the archive; a search by name has none to match.
  const drafts = withTodo && query === "" ? view.drafts : [];
  // Unreadable tiles stay mounted whatever the filter or search — only hidden —
  // so a rewrite already on its way keeps its busy button instead of coming
  // back as a fresh, clickable tile while the paid call is still in flight.
  const unreadableShown = (u: UnreadableAvatar): boolean => withTodo && matches(u.name, query);
  const unreadableKeyList = unreadableKeys(view.unreadableAvatars);
  const unreadableMore = withTodo && query === "" ? Math.max(0, view.unreadableTotal - view.unreadableAvatars.length) : 0;
  const nothingShown = shownAvatars.length === 0 && drafts.length === 0 && !view.unreadableAvatars.some(unreadableShown);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <ScreenTitle>Аватары</ScreenTitle>
          {ready && !isEmpty && (
            <p className="page-sub mono">
              {countOf(active.length, AVATAR_FORMS)} · {photosLabel(photoTotal)}
            </p>
          )}
        </div>
        {ready && !isEmpty && (
          <div className="page-actions">
            <label className="search">
              <span className="sr-only">Поиск</span>
              <Icon name="search" size={16} />
              <input
                className="in"
                type="search"
                value={search}
                placeholder="Имя аватара"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
            </label>
            <RadioChoices<Filter>
              legend="Показать"
              legendHidden
              variant="segments"
              large
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "Все" },
                { value: "active", label: "Активные" },
                { value: "archived", label: "Архив" },
              ]}
            />
            <button type="button" className="btn btn-p" onClick={() => navigate({ name: "avatarNew", draftId: null })}>
              <Icon name="plus" size={16} strokeWidth={2.2} />
              Новый аватар
            </button>
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
          {nothingShown && filter === "archived" && (
            <p className="muted empty-inline">{query === "" ? "В архиве пока никого нет." : "В архиве никого с таким именем."}</p>
          )}
          <div className="avatar-grid">
            {view.unreadableAvatars.map((u, i) => (
              <UnreadableTile key={unreadableKeyList[i]} entry={u} view={view} index={i} hidden={!unreadableShown(u)} />
            ))}
            {unreadableMore > 0 && <UnreadableMoreTile count={unreadableMore} />}
            {drafts.map((d) => (
              <DraftCard key={d.avatarId} draft={d} job={latestJobFor(view.jobs, d.avatarId)} />
            ))}
            {shownAvatars.map((a) => (
              <AvatarCard key={a.avatarId} avatar={a} />
            ))}
            {showTiles && (
              <>
                <NewAvatarTile estimate={priceIsCurrent ? newAvatarPrice.estimate : null} />
                <ImportAvatarTile />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
