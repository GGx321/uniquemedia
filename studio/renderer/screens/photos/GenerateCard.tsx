import { useEffect, useId, useRef, useState } from "react";
import { SceneCategory, type AvatarSummary, type EngineError, type Estimate, type RunRequest } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { EngineView } from "../../engine/store";
import { formatUsd } from "../../lib/money";
import { useNavigate } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import {
  CATEGORY_LABEL,
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
} from "./runForm";
import { useMounted } from "./shared";

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

const PRICE_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** "OpenRouter · 24 сент." for live prices, "резервные · 24 сент." for the dated fallback table. */
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
}

/**
 * The generation card: how many photos, at what resolution, in which
 * categories and poses, and the price before anything is spent. The free
 * `runs.estimate` is asked for on every change of the request; the button
 * carries its worst case («до $X») and sends exactly that as
 * `acceptedWorstMicros`, for exactly the request it was priced for.
 * PRICE_CHANGED keeps the button busy until a fresh price replaces the
 * refused one, which must then be confirmed by a new click; a failed
 * re-price leaves no price at all, only a retry.
 */
export function GenerateCard({ avatar, view, form, onFormChange, runActive, onStarted }: GenerateCardProps) {
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const ids = useId();
  const mounted = useMounted();
  const sending = useRef(false);

  const [priced, setPriced] = useState<Priced | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  // True from the click through runs.start and, on PRICE_CHANGED, the fresh estimate after it.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const [retry, setRetry] = useState(0);

  const request = runRequest(avatar.avatarId, form);
  // The engine prices a run with the age check and the models it has now: a
  // change to any of them (Settings, another window) asks again, and the old
  // price is not shown meanwhile.
  const settings = view.settings;
  const key = `${requestKey(request)}|${settings?.imageAgeCheck ?? ""}|${settings?.imageModel ?? ""}|${settings?.textModel ?? ""}`;
  const ready = view.phase === "ready";
  const canPrice = ready && avatar.status === "active" && request.categories.length > 0;

  // The free price, asked again whenever the request changes. An answer for
  // a request that is gone by then is dropped (`alive`), so a quick run of
  // stepper clicks can never leave an older price on the button.
  useEffect(() => {
    if (!canPrice) {
      setEstimating(false);
      return;
    }
    let alive = true;
    setEstimating(true);
    setError(null);
    void client.request("runs.estimate", request).then((reply) => {
      if (!alive) return;
      setEstimating(false);
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

  const current = priced !== null && priced.key === key ? priced : null;

  async function start(accepted: Priced): Promise<void> {
    // A second click before React re-renders the disabled button must never send twice.
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const reply = await client.request("runs.start", { ...accepted.request, acceptedWorstMicros: accepted.estimate.worstMicros });
      // The run is under way whether or not this screen is still open: the (window-wide) store learns of it either way.
      if (reply.ok) store.trackRunJob(reply.result.jobId, accepted.request.avatarId, accepted.request.count);
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
      if (mounted.current) setBusy(false);
    }
  }

  const locked = busy;
  const perCategory = photosPerCategory(form.count, form.categories);
  const blockedReason =
    paidBlockedReason(view) ??
    (avatar.status !== "active"
      ? "Аватар в архиве — новые фото для него не создаются."
      : request.categories.length === 0
        ? "Выберите хотя бы одну категорию."
        : runActive
          ? "Дождитесь конца текущего запуска."
          : null);

  function toggleCategory(category: RunCategory): void {
    const on = form.categories.includes(category);
    onFormChange({ ...form, categories: on ? form.categories.filter((c) => c !== category) : [...form.categories, category] });
  }

  // ---------- the button ----------

  const worst = current ? `до ${formatUsd(current.estimate.worstMicros, 2, "up")}` : null;
  let title: string;
  let onClick: (() => void) | null = null;
  let primary = true;
  if (busy) title = "Отправляем…";
  else if (estimating) title = "Считаем…";
  else if (current) {
    title = previousWorst !== null ? "Подтвердить новую цену" : `Сгенерировать ${form.count} фото`;
    if (blockedReason === null) onClick = () => void start(current);
  } else if (canPrice && error !== null) {
    // No price to accept: the only thing the button can do is ask for one again (free).
    title = "Повторить оценку";
    primary = false;
    onClick = () => setRetry((n) => n + 1);
  } else title = `Сгенерировать ${form.count} фото`;
  const buttonBusy = busy || estimating;

  const hintId = `${ids}-why`;
  const anglesLabel = `${ids}-angles`;
  const anglesHint = `${ids}-angles-hint`;
  const countLabel = `${ids}-count`;
  const resLabel = `${ids}-res`;
  const catsLabel = `${ids}-cats`;
  const reviewLabel = `${ids}-review`;
  const reviewSoon = `${ids}-review-soon`;
  const imageModel = view.settings ? modelName(view.settings.imageModel) : null;

  return (
    <>
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
                  disabled={form.count <= COUNT_MIN}
                  onClick={() => onFormChange({ ...form, count: Math.max(COUNT_MIN, form.count - COUNT_STEP) })}
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
                  onClick={() => onFormChange({ ...form, count: Math.min(COUNT_MAX, form.count + COUNT_STEP) })}
                >
                  <Icon name="plus" size={14} strokeWidth={2.4} />
                </button>
              </div>
              <span id={resLabel} className="lbl photos-lbl-gap">
                Разрешение
              </span>
              <div className="seg photos-res" role="group" aria-labelledby={resLabel}>
                {(["1k", "2k"] as const).map((res) => (
                  <button
                    key={res}
                    type="button"
                    className={form.resolution === res ? "on" : undefined}
                    aria-pressed={form.resolution === res}
                    onClick={() => onFormChange({ ...form, resolution: res })}
                  >
                    {res === "1k" ? "1K" : "2K"}
                  </button>
                ))}
              </div>
            </div>

            <div className="photos-gen-cats">
              <span id={catsLabel} className="lbl">
                Категории · фото в каждой
              </span>
              <div className="photos-chips" role="group" aria-labelledby={catsLabel}>
                {SceneCategory.options.map((category) => {
                  const on = form.categories.includes(category);
                  const n = perCategory.get(category);
                  return (
                    <button
                      key={category}
                      type="button"
                      className={on ? "chip chip-on" : "chip"}
                      aria-pressed={on}
                      aria-label={on && n !== undefined ? `${CATEGORY_LABEL[category]}: ${n} фото` : CATEGORY_LABEL[category]}
                      onClick={() => toggleCategory(category)}
                    >
                      {CATEGORY_LABEL[category]}
                      {/* Always present, like the mockup's: an off chip keeps the same 6px gap after its label. */}
                      <span className="mono photos-chip-n" aria-hidden="true">
                        {on && n !== undefined ? n : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
              {form.categories.includes("glam") && <span className="faint photos-note photos-cats-note">Гламур — только неоткровенные наряды: мини, корсет, облегающее платье.</span>}
            </div>

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
              {imageModel && <span className="faint photos-note photos-shot-caption">{imageModel} · low · 9:16 · референс — мастер-портрет</span>}
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
            <span className={current?.estimate.prices === "fallback" ? "warn-text" : undefined}>{current ? priceSource(current.estimate) : "—"}</span>
          </div>
          <div className="mono photos-cost-row">
            <span>Проверка возраста</span>
            <span className={view.settings?.imageAgeCheck === "on" ? undefined : "faint"}>{view.settings?.imageAgeCheck === "on" ? "вкл." : "выкл."}</span>
          </div>
          <div className="mono photos-cost-row photos-cost-total">
            <span>Ожидаемая</span>
            <span aria-live="polite">{current ? `≈ ${formatUsd(current.estimate.expectedMicros)}` : "—"}</span>
          </div>
          <div className="photos-review">
            <button type="button" className="sw" role="switch" aria-checked="false" aria-labelledby={reviewLabel} aria-describedby={reviewSoon} disabled />
            <span id={reviewLabel}>Сцены на проверку</span>
            <span id={reviewSoon} className="tag">
              скоро
            </span>
          </div>
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
            {worst && !estimating && (
              <>
                <span className="sr-only"> · </span>
                <span className="mono">{worst}</span>
              </>
            )}
          </button>
          {blockedReason && !buttonBusy && (
            <p id={hintId} className="field-hint">
              {blockedReason}
            </p>
          )}
        </div>
      </section>

      {previousWorst !== null && current && (
        <Notice tone="warn" title="Цена выросла">
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
    </>
  );
}
