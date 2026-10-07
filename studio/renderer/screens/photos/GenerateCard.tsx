import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AvatarSummary, CategoryInterrupted, EngineError, Estimate, RunRequest, SceneSetView } from "../../../shared/engine";
import { useCategoryLibrary, useEngine } from "../../engine/react";
import type { SceneSetSliceView } from "../../engine/sceneSetSlice";
import type { EngineView, JobView } from "../../engine/store";
import { countOf } from "../../lib/format";
import { formatUsd } from "../../lib/money";
import { useNavigate } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { CategoryCreateDialog, type CreateDialogClose, type CreateDialogStart } from "./CategoryCreateDialog";
import { CategoryCardNotices } from "./CategoryNotices";
import { CategoryRow } from "./CategoryRow";
import { CategorySheet } from "./CategorySheet";
import { RecomposeDialog } from "./RecomposeDialog";
import {
  arrangeCategories,
  COUNT_MAX,
  COUNT_MIN,
  COUNT_STEP,
  modelName,
  paidBlockedReason,
  photosPerCategory,
  requestKey,
  type RunCategory,
  type RunForm,
  runRequest,
  sameCategories,
  toggleCategory,
} from "./runForm";
import { about, ceiling, paidButtonState, PriceChangedNotice, StackButton, Why } from "./scenePaid";
import { ReviewSwitch, SceneStrip, Step } from "./SceneStrip";
import { composeTitle } from "./sceneText";
import { SEEDREAM_FALLBACK_IMAGE_MODEL, useMounted } from "./shared";
import { usePaidAction } from "./usePaidAction";

/** A price for one exact request: the button may only ever send this request with this worst case. */
interface Priced {
  /** The request and the settings that move its price (the age check, the models): a price for any other is not shown. */
  key: string;
  request: RunRequest;
  estimate: Estimate;
}

/**
 * The mockup's shot types and their colours (Photos.dc.html's `shotBase`).
 * The share of each is the planner's own and is not in the contract yet, so
 * the legend names them without the mockup's percentages or bar.
 */
const SHOT_TYPES = [
  { label: "Подруга снимает", tone: "friend" },
  { label: "Селфи", tone: "selfie" },
  { label: "Зеркало", tone: "mirror" },
  { label: "Кэндид", tone: "candid" },
  { label: "Фотограф", tone: "photographer" },
] as const;

const PRICE_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "OpenRouter · 24 сент. 2026 г." for live prices, "резервные · 24 сент. 2026 г." for the dated fallback table (B5: the year, like the sheet's own). */
function priceSource(estimate: Estimate): string {
  const date = PRICE_DATE.format(Date.parse(`${estimate.pricesAsOf}T00:00:00Z`));
  return estimate.prices === "live" ? `OpenRouter · ${date}` : `резервные · ${date}`;
}

interface GenerateCardProps {
  avatar: AvatarSummary;
  view: EngineView;
  form: RunForm;
  onFormChange: (form: RunForm) => void;
  /** A run of this avatar is queued or running: the engine refuses a second one, so the button waits. */
  runActive: boolean;
  onStarted: (started: { runId: string; jobId: string }) => void;
  /** A paid runs.start or runs.resume is in flight for this avatar, from this card or any resume row (L5). */
  paidInFlight: boolean;
  onPaidInFlightChange: (inFlight: boolean) => void;
  /** CS.6: «Сцены на проверку», remembered per machine. */
  review: boolean;
  onReviewChange: (on: boolean) => void;
  /** CS.6: the avatar's scene set as the slice reads it: `undefined` while it is read, null with none, else the set (open, or used and read-only). */
  sceneSet: SceneSetView | null | undefined;
  sliceView: SceneSetSliceView;
  /** This avatar's scenes job, if one is queued or running. */
  scenesJob: JobView | null;
  /** The compose's price, for the column's «как это работает» to quote. */
  onComposePrice: (estimate: Estimate | null) => void;
  /** Scrolls the column to a scene and puts the focus on it (a reason's link). */
  onFocusScene: (sceneId: number) => void;
}

/**
 * The generation card: how many photos, in which
 * categories and poses, and the price before anything is spent. The free
 * `runs.estimate` is asked for on every change of the request; the button
 * carries its worst case («до $X») and sends exactly that as
 * `acceptedWorstMicros`, for exactly the request it was priced for.
 * PRICE_CHANGED keeps the button busy until a fresh price replaces the
 * refused one, which must then be confirmed by a new click; a failed
 * re-price leaves no price at all, only a retry.
 */
export function GenerateCard({
  avatar,
  view,
  form,
  onFormChange,
  runActive,
  onStarted,
  paidInFlight,
  onPaidInFlightChange,
  review,
  onReviewChange,
  sceneSet,
  sliceView,
  scenesJob,
  onComposePrice,
  onFocusScene,
}: GenerateCardProps) {
  const { client, store, sceneSets } = useEngine();
  const navigate = useNavigate();
  const ids = useId();
  const mounted = useMounted();
  const sending = useRef(false);
  /** The request's current key, live: `start`'s PRICE_CHANGED re-price must never overwrite a fresher key's own estimate (M1). */
  const keyRef = useRef<string | null>(null);

  const [priced, setPriced] = useState<Priced | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  // True from the click through runs.start and, on PRICE_CHANGED, the fresh estimate after it.
  const [busy, setBusy] = useState(false);
  // L2: the worst case actually sent to runs.start/resume, held while `busy`
  // (LOW-4) — state, not a ref, since what shows on the button while sending
  // must re-render with it: what is in flight, not a fresher key's own price
  // that landed in the meantime.
  const [busyWorst, setBusyWorst] = useState<number | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [retry, setRetry] = useState(0);

  // CS.3: the owner's own categories (the window's slice): chips after the built-ins in creation order, the create dialog and the sheet.
  const { library, view: categorySlice } = useCategoryLibrary();
  const customs = categorySlice.list.status === "ready" ? categorySlice.list.categories : null;
  const customOrder = useMemo(() => (customs ?? []).map((c) => c.categoryId), [customs]);
  // The run asks only for categories the library holds, the custom ones in creation order (a chip clicked last never takes a remainder
  // photo from one made earlier); a category deleted, or another library's, is not asked for at all.
  const categories = arrangeCategories(form.categories, customOrder);
  const listReady = customs !== null;
  useEffect(() => {
    // The form itself forgets them once the library is listed (not while it is being listed again: nothing is dropped meanwhile).
    if (listReady && !sameCategories(categories, form.categories)) onFormChange({ ...form, categories });
  }, [listReady, categories, form, onFormChange]);
  const [createOpen, setCreateOpen] = useState<CreateDialogStart | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const chipsRef = useRef<HTMLDivElement>(null);
  const ownCreate = categorySlice.call?.kind === "create" ? categorySlice.call : null;

  const request = runRequest(avatar.avatarId, { ...form, categories });
  // The engine prices a run with the age check and the models it has now: a
  // change to any of them (Settings, another window) asks again, and the old
  // price is not shown meanwhile.
  const settings = view.settings;
  const key = `${requestKey(request)}|${settings?.imageAgeCheck ?? ""}|${settings?.imageModel ?? ""}|${settings?.imageQuality ?? ""}|${settings?.textModel ?? ""}`;
  // LOW-10: a layout effect, not a render-body assignment — still committed
  // before `start`'s own async continuations can ever read it (they only
  // resume after an await, always later than any synchronous commit), but
  // without mutating a ref as a side effect of rendering itself.
  useLayoutEffect(() => {
    keyRef.current = key;
  }, [key]);
  const ready = view.phase === "ready";
  // A run of 0 photos is not a run: with review on, 0 is an empty set (no run price to ask for).
  const canPrice = ready && avatar.status === "active" && request.categories.length > 0 && form.count > 0;

  const current = priced !== null && priced.key === key ? priced : null;
  // LOW-5: derived from what is already known, not a separate state a step
  // behind it — a `setEstimating(true)` inside the effect below only ever
  // commits after this component's very first paint, which would otherwise
  // show "Сгенерировать N фото · до …" for one frame before "Считаем…".
  const estimating = canPrice && current === null && error === null;

  // The free price, asked again whenever the request changes. An answer for
  // a request that is gone by then is dropped (`alive`), so a quick run of
  // stepper clicks can never leave an older price on the button.
  useEffect(() => {
    if (!canPrice) {
      // Nothing to price (no category chosen, say, L12): an error from
      // before must not linger once there is no longer a request it is for.
      setError(null);
      return;
    }
    let alive = true;
    setError(null);
    void client.request("runs.estimate", request).then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setPriced({ key, request, estimate: reply.result.estimate });
        setPreviousWorst(null);
      } else {
        setPriced(null);
        setError(reply.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [canPrice, key, retry, client]); // `request` and the settings it is priced under are `key`'s own content

  async function start(accepted: Priced): Promise<void> {
    // A second click before React re-renders the disabled button must never send twice.
    if (sending.current) return;
    sending.current = true;
    setBusyWorst(accepted.estimate.worstMicros);
    setBusy(true);
    onPaidInFlightChange(true);
    setError(null);
    try {
      const reply = await client.request("runs.start", { ...accepted.request, acceptedWorstMicros: accepted.estimate.worstMicros });
      // The run is under way whether or not this screen is still open: the (window-wide) store learns of it either way.
      if (reply.ok) store.trackRunJob(reply.result.jobId, reply.result.runId, accepted.request.avatarId, accepted.request.count);
      if (!mounted.current) return;
      if (reply.ok) {
        setPreviousWorst(null);
        onStarted(reply.result);
        return;
      }
      if (reply.error.code !== "PRICE_CHANGED") {
        setError(reply.error);
        return;
      }
      // Still busy: the refused price stays on a disabled button until the new one replaces it.
      const fresh = await client.request("runs.estimate", accepted.request);
      if (!mounted.current) return;
      if (accepted.key !== keyRef.current) {
        // The key moved on while this re-price was in flight (a settings
        // change, another window's toggle): that key already has its own
        // estimate effect running or landed. Applying this stale reply here
        // would overwrite a fresher price with one stamped under the old
        // key, leaving `current` null and the button dead — drop it and let
        // the live key's own estimate stand.
        return;
      }
      if (fresh.ok) {
        setPriced({ ...accepted, estimate: fresh.result.estimate });
        setPreviousWorst(accepted.estimate.worstMicros);
        return;
      }
      // The refused price must not stay on the button: with none, a click only asks for a new one.
      setPriced(null);
      setPreviousWorst(null);
      setError(fresh.error);
    } finally {
      sending.current = false;
      onPaidInFlightChange(false);
      if (mounted.current) {
        setBusy(false);
        setBusyWorst(null);
      }
    }
  }

  // ---------- CS.6: «Сцены на проверку» ----------

  // The open set (writing, stopped, ready) collapses the card to the set's strip; a used one leaves the card composing again.
  const openSet = sceneSet !== undefined && sceneSet !== null && sceneSet.status !== "used" ? sceneSet : null;
  // An empty set draws from no category (ReviewEmpty: «без категорий — только свои сцены»).
  const composeRequest = { avatarId: avatar.avatarId, count: form.count, categories: form.count === 0 ? [] : request.categories, poses: request.poses };
  // Composed only once the slice says the avatar has no open set (a second one would be refused), at the request and the model it is priced for.
  const canCompose = review && ready && sceneSet !== undefined && openSet === null && avatar.status === "active" && (form.count === 0 || request.categories.length > 0);
  const compose = usePaidAction({
    key: canCompose ? `${requestKey(composeRequest)}|${settings?.textModel ?? ""}|${view.money?.reconcileNeeded === true ? "r" : ""}` : null,
    price: () => client.request("scenes.estimateCompose", composeRequest),
    send: (acceptedWorstMicros) => client.request("scenes.compose", { ...composeRequest, acceptedWorstMicros }),
    onSent: (result, accepted) => {
      if (result.jobId !== null) {
        store.trackScenesJob(result.jobId, result.sceneSetId, avatar.avatarId, composeRequest.count);
        sceneSets.trackJob(result.jobId, { sceneSetId: result.sceneSetId, kind: "compose", price: accepted, sceneIds: null, idea: null });
      }
      // An empty set has no job: it is read at once.
      sceneSets.reload(avatar.avatarId);
    },
    onPaidInFlightChange,
  });
  useEffect(() => onComposePrice(review ? compose.estimate : null), [review, compose.estimate, onComposePrice]);

  /** Off at fewer than five photos: the count goes to five (a run has no empty set). */
  function toggleReview(): void {
    if (review && form.count < COUNT_MIN) onFormChange({ ...form, count: COUNT_MIN });
    onReviewChange(!review);
  }
  const countMin = review ? 0 : COUNT_MIN;
  const stepCount = (delta: number): number => Math.min(COUNT_MAX, Math.max(countMin, form.count + delta));

  // «Пересоставить…»: asked first; a discard puts the focus on the card's «Составить» once the card composes again.
  // The set the dialog asks about, kept while it is open: the set may leave the view (its discard is announced) before the discard answers.
  const [recomposeSet, setRecomposeSet] = useState<SceneSetView | null>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const recomposeRef = useRef<HTMLButtonElement>(null);
  const [focusAfterRecompose, setFocusAfterRecompose] = useState<"go" | "link" | null>(null);
  useEffect(() => {
    if (focusAfterRecompose === "link") {
      recomposeRef.current?.focus();
      setFocusAfterRecompose(null);
    } else if (focusAfterRecompose === "go" && openSet === null) {
      goRef.current?.focus();
      setFocusAfterRecompose(null);
    }
  }, [focusAfterRecompose, openSet]);

  // Another paid command (a resume row's) is in flight for this avatar (L5): this card locks too, though it is not the one sending.
  const lockedByOther = paidInFlight && !busy;
  const locked = busy || lockedByOther;
  const perCategory = photosPerCategory(form.count, categories);
  const blockedReason =
    paidBlockedReason(view) ??
    (avatar.status !== "active"
      ? "Аватар в архиве — новые фото для него не создаются."
      : request.categories.length === 0
        ? "Выберите хотя бы одну категорию."
        : runActive
          ? "Дождитесь конца текущего запуска."
          : lockedByOther
            ? "Дождитесь окончания другого платного действия."
            : null);

  function toggle(category: RunCategory): void {
    onFormChange({ ...form, categories: toggleCategory(categories, category, customOrder) });
  }

  // ---------- the create dialog and the sheet ----------

  /** What opened the dialog: the focus goes back there when it is cancelled («+ Своя», or «Мои категории» for one opened from the sheet). */
  const createOpener = useRef<"add" | "sheet" | null>(null);

  /** Opens «Новая категория». A fresh one forgets the last outcome; `keep` keeps a failure the dialog is opened to show again. */
  function openCreate(start: CreateDialogStart, from: "add" | "sheet" | null, keep = false): void {
    if (!keep && categorySlice.call?.kind !== "create") library.clearOutcome("create");
    // A fresh list says whether another window composes a category now; a fresh price is the one the button offers.
    library.reload();
    library.refreshPrice();
    createOpener.current = from;
    setSheetOpen(false);
    setCreateOpen(start);
  }

  function openSheet(): void {
    library.reload();
    library.refreshPrice();
    setSheetOpen(true);
  }

  const rowControl = (name: "add" | "sheet"): HTMLElement | null =>
    chipsRef.current?.querySelector<HTMLElement>(name === "add" ? "[data-add-category]" : "[data-my-categories]") ?? null;

  function closeCreate(how: CreateDialogClose): void {
    setCreateOpen(null);
    // Seen in the dialog: not told again under the card. Hidden while the model works, the outcome is still to come.
    if (how !== "hide") library.clearOutcome("create");
  }

  /** «Создать снова» on a create a closed Studio left: a new request at the price the button showed, followed in the dialog. */
  function retryInterrupted(call: CategoryInterrupted, accepted: Estimate): void {
    library.clearOutcome("create");
    void library.create(call.name, call.description, accepted);
    createOpener.current = sheetOpen ? "sheet" : null;
    setSheetOpen(false);
    setCreateOpen({ name: call.name, description: call.description, focus: "name" });
  }

  // After «Скрыть» the chip with the spinner; after «Готово» the new chip; after a cancel what opened the dialog.
  const focusAfterCreate = (how: CreateDialogClose, categoryId: string | null): HTMLElement | null =>
    how === "hide"
      ? (chipsRef.current?.querySelector<HTMLElement>("[data-chip-wait]") ?? null)
      : how === "done" && categoryId !== null
        ? (chipsRef.current?.querySelector<HTMLElement>(`[data-category="${categoryId}"]`) ?? null)
        : createOpener.current !== null
          ? rowControl(createOpener.current)
          : null;

  // ---------- the button ----------

  // LOW-4: while sending, the price actually in flight (what was accepted at
  // click time) — never a fresher key's own price that happened to land in
  // the meantime, which is not what this send will actually be charged.
  const worst =
    busy && busyWorst !== null
      ? `до ${formatUsd(busyWorst, 2, "up")}`
      : current
        ? `до ${formatUsd(current.estimate.worstMicros, 2, "up")}`
        : null;
  let title: string;
  let onClick: (() => void) | null = null;
  let primary = true;
  // B2: whether the button offers (or would offer, once priced) a paid
  // start, so its second line's height never jumps between "no price yet"
  // and "a price is in". False when nothing is even being priced
  // (`canPrice`: no category, an archived avatar) — there is no placeholder
  // worth showing for a price that will never be asked for — and in the
  // free-retry branch below, which is not a paid start at all.
  let offersPaidStart = canPrice;
  if (busy) title = "Отправляем…";
  else if (estimating) title = "Считаем…";
  else if (current) {
    title = previousWorst !== null ? "Подтвердить новую цену" : `Сгенерировать ${form.count} фото`;
    if (blockedReason === null) onClick = () => void start(current);
  } else if (canPrice && error !== null) {
    // No price to accept: the only thing the button can do is ask for one again (free).
    title = "Повторить оценку";
    primary = false;
    offersPaidStart = false;
    onClick = () => setRetry((n) => n + 1);
  } else title = `Сгенерировать ${form.count} фото`;
  const buttonBusy = busy || estimating;

  const hintId = `${ids}-why`;
  const anglesLabel = `${ids}-angles`;
  const anglesHint = `${ids}-angles-hint`;
  const countLabel = `${ids}-count`;
  const imageModel = view.settings ? modelName(view.settings.imageModel) : null;
  // The engine's own route (runs/plan.ts's runRoute) sends the settings' image quality (null for a model with no quality knob) to the
  // settings' own image model, but none once that model already is the Seedream fallback — nothing lower to fall back to (L3).
  const imageQuality =
    view.settings && view.settings.imageQuality !== null && view.settings.imageModel !== SEEDREAM_FALLBACK_IMAGE_MODEL ? `${view.settings.imageQuality} · ` : "";

  // The compose mode's price column: step 1 the scenes (the compose's own estimate), step 2 the photos (the run's estimate less its writer), and the
  // whole run «без правок» (an own scene or another one raises its ceiling).
  const composeSteps = [
    {
      n: "1",
      state: "current" as const,
      label: "Сцены",
      value: form.count === 0 ? "бесплатно" : compose.estimate !== null ? about(compose.estimate.expectedMicros) : "≈ …",
    },
    {
      n: "2",
      state: "next" as const,
      label: form.count === 0 ? "фото" : countOf(form.count, ["фото", "фото", "фото"]),
      value: form.count === 0 ? "—" : current !== null && compose.estimate !== null ? about(Math.max(0, current.estimate.expectedMicros - compose.estimate.expectedMicros)) : "≈ …",
    },
  ];
  const composeBlocked =
    (form.count === 0 ? (view.phase === "offline" ? paidBlockedReason(view) : null) : paidBlockedReason(view)) ??
    (avatar.status !== "active"
      ? "Аватар в архиве — новые фото для него не создаются."
      : form.count > 0 && request.categories.length === 0
        ? "Выберите хотя бы одну категорию."
        : runActive
          ? "Дождитесь конца текущего запуска."
          : paidInFlight && !compose.sending
            ? "Дождитесь окончания другого платного действия."
            : null);
  const composeButton = paidButtonState(compose, composeTitle(form.count), composeBlocked !== null, form.count === 0);

  const fullCard = (
      <section className="card photos-gen" aria-label="Генерация фото">
        {/* Locked (and, unlike the wizard's frozen draft, visibly dimmed) while a paid start is on its way. */}
        <fieldset className="lock lock-dim photos-gen-main" disabled={locked}>
          <legend className="sr-only">Что сгенерировать</legend>
          <div className="photos-gen-fields">
            <div className="photos-gen-count">
              <span id={countLabel} className="lbl">
                Сколько фото
              </span>
              <div className="photos-stepper" role="group" aria-labelledby={countLabel}>
                <button
                  type="button"
                  className="ibtn"
                  aria-label="Меньше"
                  disabled={form.count <= countMin}
                  onClick={() => onFormChange({ ...form, count: stepCount(-COUNT_STEP) })}
                >
                  <Icon name="minus" size={14} strokeWidth={2.4} />
                </button>
                <output className="mono photos-count" aria-live="polite" aria-labelledby={countLabel}>
                  {form.count}
                </output>
                <button
                  type="button"
                  className="ibtn"
                  aria-label="Больше"
                  disabled={form.count >= COUNT_MAX}
                  onClick={() => onFormChange({ ...form, count: stepCount(COUNT_STEP) })}
                >
                  <Icon name="plus" size={14} strokeWidth={2.4} />
                </button>
              </div>
            </div>

            <CategoryRow
              rootRef={chipsRef}
              categories={categories}
              perCategory={perCategory}
              list={categorySlice.list}
              creating={ownCreate}
              outcome={categorySlice.outcomes.create}
              onToggle={toggle}
              onCreate={() => openCreate({ name: "", description: "", focus: "name" }, "add")}
              onReopen={() => {
                if (ownCreate === null) return;
                createOpener.current = "add";
                setCreateOpen({ name: ownCreate.name, description: ownCreate.description, focus: "name" });
              }}
              onSheet={openSheet}
              onRetry={() => library.reload()}
            />

            <div className="photos-gen-shots">
              <div className="photos-lbl-row">
                <span className="lbl">Тип кадра</span>
                <span className="tag">скоро</span>
              </div>
              <ul className="photos-shot-legend" aria-label="Типы кадра: доли пока не приходят от движка">
                {SHOT_TYPES.map((s) => (
                  <li key={s.tone}>
                    <span className={`photos-shot-dot shot-${s.tone}`} aria-hidden="true" />
                    {s.label}
                  </li>
                ))}
              </ul>
              {imageModel && (
                <span className="faint photos-note photos-shot-caption">
                  {imageModel} · {imageQuality}9:16 · референс — мастер-портрет
                </span>
              )}
            </div>
          </div>

          <div className="photos-angles">
            <span id={anglesLabel} className="lbl">
              Ракурсы
            </span>
            <div className="photos-chips-row" role="group" aria-labelledby={anglesLabel} aria-describedby={anglesHint}>
              {["Анфас", "Три четверти"].map((label) => (
                <button key={label} type="button" className="chip chip-on photos-chip-fixed" aria-pressed="true" aria-disabled="true">
                  <Icon name="lock" size={11} strokeWidth={2.4} />
                  {label}
                </button>
              ))}
              {(["profile", "back"] as const).map((pose) => {
                const on = form.poses[pose];
                return (
                  <button
                    key={pose}
                    type="button"
                    className={on ? "chip chip-on" : "chip"}
                    aria-pressed={on}
                    onClick={() => onFormChange({ ...form, poses: { ...form.poses, [pose]: !on } })}
                  >
                    {pose === "profile" ? "Профиль" : "Со спины"}
                  </button>
                );
              })}
            </div>
            <span id={anglesHint} className="faint photos-note photos-angles-hint">
              профиль и со спины — только если разрешите, без проверки сходства
            </span>
          </div>
        </fieldset>

        <div className="photos-gen-side">
          <div className="mono photos-cost-row">
            <span>Цены</span>
            {/* B5: faint like the sheet's own price-source row; warn-text stays for the dated fallback table. */}
            <span className={(current?.estimate ?? compose.estimate)?.prices === "fallback" ? "warn-text" : "faint"}>
              {current ? priceSource(current.estimate) : review && compose.estimate ? priceSource(compose.estimate) : "—"}
            </span>
          </div>
          {review && composeSteps.map((row) => <Step key={row.n} row={row} />)}
          <div className="mono photos-cost-row">
            <span>Проверка возраста</span>
            <span className={view.settings?.imageAgeCheck === "on" ? undefined : "faint"}>{view.settings?.imageAgeCheck === "on" ? "вкл." : "выкл."}</span>
          </div>
          <div className="mono photos-cost-row photos-cost-total">
            <span>{review && form.count > 0 ? "Весь запуск" : "Ожидаемая"}</span>
            <span aria-live="polite">{current ? (review ? about(current.estimate.expectedMicros) : `≈ ${formatUsd(current.estimate.expectedMicros)}`) : "—"}</span>
          </div>
          {review && form.count > 0 && current && <div className="mono faint scene-total-sub">{`${ceiling(current.estimate.worstMicros)} без правок`}</div>}
          <ReviewSwitch on={review} onToggle={toggleReview} labelId={`${ids}-sw`} />
          {review ? (
            <StackButton
              buttonRef={goRef}
              state={composeButton}
              describedBy={composeBlocked !== null && !composeButton.busy ? hintId : undefined}
              onClick={compose.click}
            />
          ) : (
            <button
              type="button"
              className={primary ? "btn btn-p btn-stack photos-go" : "btn btn-stack photos-go"}
              disabled={onClick === null || buttonBusy}
              aria-busy={buttonBusy}
              aria-describedby={blockedReason && !buttonBusy ? hintId : undefined}
              onClick={onClick ?? undefined}
            >
              <span className="btn-stack-line">
                {buttonBusy && <Spin />}
                {title}
              </span>
              {offersPaidStart && (
                <>
                  <span className="sr-only"> · </span>
                  <span className="mono">{worst ?? "до …"}</span>
                </>
              )}
            </button>
          )}
          {review
            ? composeBlocked !== null && !composeButton.busy && <Why id={hintId}>{composeBlocked}</Why>
            : blockedReason &&
              !buttonBusy && (
                <p id={hintId} className="field-hint">
                  {blockedReason}
                </p>
              )}
        </div>
      </section>
  );

  return (
    <>
      {review && openSet !== null ? (
        <SceneStrip
          avatar={avatar}
          view={view}
          set={openSet}
          sliceView={sliceView}
          scenesJob={scenesJob}
          runActive={runActive}
          paidInFlight={paidInFlight}
          onPaidInFlightChange={onPaidInFlightChange}
          onToggleReview={toggleReview}
          onOpenSheet={openSheet}
          myCategories={customs === null ? null : customs.length}
          onRecompose={() => setRecomposeSet(openSet)}
          onStarted={onStarted}
          onFocusScene={onFocusScene}
          goRef={goRef}
          recomposeRef={recomposeRef}
        />
      ) : (
        fullCard
      )}
      {recomposeSet !== null && (
        <RecomposeDialog
          set={recomposeSet}
          replaced={sliceView.fresh.get(recomposeSet.sceneSetId)?.size ?? 0}
          count={form.count}
          onCancel={() => {
            setRecomposeSet(null);
            setFocusAfterRecompose("link");
          }}
          onDiscarded={() => {
            setRecomposeSet(null);
            setFocusAfterRecompose("go");
          }}
        />
      )}
      {review && openSet === null && compose.previousWorst !== null && compose.estimate !== null && <PriceChangedNotice previousWorst={compose.previousWorst} estimate={compose.estimate} />}
      {review && openSet === null && compose.error !== null && <ErrorNotice error={compose.error} />}
      {!review && previousWorst !== null && current && (
        // PRICE_CHANGED means the price at the moment of refusal was higher
        // than what was accepted — not that the fresh one, fetched
        // afterwards, still is (L4): title on what is actually shown.
        <Notice tone="warn" title={current.estimate.worstMicros > previousWorst ? "Цена выросла" : "Цена изменилась"}>
          Было не больше <span className="mono">{formatUsd(previousWorst, 2, "up")}</span>, теперь не больше{" "}
          <span className="mono">{formatUsd(current.estimate.worstMicros, 2, "up")}</span>. Проверьте новую оценку и подтвердите снова — без
          подтверждения ничего не отправляется.
        </Notice>
      )}
      {error && (
        <ErrorNotice
          error={error}
          actions={
            error.code === "DESCRIPTOR_INVALID" ? (
              <button type="button" className="btn btn-s" onClick={() => navigate({ name: "avatars" })}>
                Переписать описание
              </button>
            ) : undefined
          }
        />
      )}
      <CategoryCardNotices
        library={library}
        slice={categorySlice}
        dialogOpen={createOpen !== null}
        onEdit={() => {
          const failed = categorySlice.outcomes.create;
          if (failed !== null) openCreate({ name: failed.call.name, description: failed.call.description, focus: "description" }, "add", true);
        }}
        onRetryInterrupted={retryInterrupted}
        onEditInterrupted={(call) => openCreate({ name: call.name, description: call.description, focus: "description" }, "add")}
      />
      {createOpen !== null && (
        <CategoryCreateDialog
          start={createOpen}
          onClose={closeCreate}
          onOpenSheet={() => {
            closeCreate("cancel");
            openSheet();
          }}
          focusAfter={focusAfterCreate}
        />
      )}
      {sheetOpen && (
        <CategorySheet
          onClose={() => setSheetOpen(false)}
          onCreate={(start) => openCreate(start, "sheet")}
          onRetryCreate={retryInterrupted}
          returnFocus={() => rowControl("sheet")}
        />
      )}
    </>
  );
}
