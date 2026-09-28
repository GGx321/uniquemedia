import type { ReactNode } from "react";
import type { EngineError, Estimate, ImageAgeCheck } from "../../../shared/engine";
import { dateLabel } from "../../lib/format";
import { formatUsd } from "../../lib/money";
import { Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";

export interface EstimateAction {
  label: string;
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  /** `.btn-p` when this is the screen's main action; another batch for a draft is secondary (the screen's main one is «Сохранить»). */
  primary: boolean;
}

interface EstimateCardProps {
  estimate: Estimate | null;
  /** The worst case the user had accepted before PRICE_CHANGED; the new estimate must be confirmed again. */
  previousWorst: number | null;
  estimating: boolean;
  action: EstimateAction | null;
  /** Why the action is unavailable, shown under it. */
  blockedReason: string | null;
  error: EngineError | null;
  /** Extra action next to a non-PRICE_CHANGED error, e.g. a pointer to fix it elsewhere (DESCRIPTOR_INVALID → the rewrite recovery). */
  errorActions?: ReactNode;
  /** Another batch for an existing draft: its descriptor is not written again. */
  repeat: boolean;
  /** Whether the image age check is on, so the caption mentions it only when it actually runs (owner's decision, 2026-09-27: off by default). Irrelevant, and so optional, for `variant: "import"` — its own age check is always mandatory, never toggle-dependent. */
  imageAgeCheck?: ImageAgeCheck;
  /**
   * T6c (review round 2, M1): the import screen's own caption and empty
   * state — its mandatory one-time age check runs whatever `imageAgeCheck`
   * says (never optional, unlike a generated avatar's own toggle-able one),
   * and there is no separate "Оценить стоимость" button to point to: the
   * estimate appears on its own, right after a photo is picked. Defaults to
   * the avatar-creation/next-batch wording every other screen already used.
   */
  variant?: "avatar" | "import";
}

function caption(variant: "avatar" | "import", repeat: boolean, imageAgeCheck: ImageAgeCheck | undefined): string {
  if (variant === "import") return "Обязательная проверка возраста и описание по фото (до 2 попыток). Худшая цена — это предел: дороже этот шаг не выйдет.";
  // Another batch: the descriptor is already paid for and this price is the
  // batch alone (avatars.estimateCandidates / the draft's own estimate) — not
  // the whole avatar's price used as a loose upper bound, so the caption must
  // not claim that anymore.
  if (repeat) {
    return imageAgeCheck === "on"
      ? "Ещё 4 портрета и проверка возраста каждого. Дескриптор уже готов и не пересоздаётся — в эту цену он не входит."
      : "Ещё 4 портрета. Дескриптор уже готов и не пересоздаётся — в эту цену он не входит.";
  }
  return imageAgeCheck === "on"
    ? "Дескриптор, 4 портрета и проверка возраста каждого. Худшая цена — это предел: дороже этот шаг не выйдет."
    : "Дескриптор и 4 портрета. Худшая цена — это предел: дороже этот шаг не выйдет.";
}

/** The price before anything is spent — its limit «до $X» first, the expected cost under it — and the button that accepts it. */
export function EstimateCard({ estimate, previousWorst, estimating, action, blockedReason, error, errorActions, repeat, imageAgeCheck, variant = "avatar" }: EstimateCardProps) {
  return (
    <section className="card estimate-card" aria-labelledby="estimate-title" aria-busy={estimating}>
      <div className="card-head">
        <h2 id="estimate-title" className="card-title">
          Оценка
        </h2>
        {estimate && (
          <span className={estimate.prices === "live" ? "mono faint" : "mono warn-text"}>
            {estimate.prices === "live"
              ? `цены OpenRouter · ${dateLabel(`${estimate.pricesAsOf}T00:00:00Z`)}`
              : `резервная таблица цен от ${dateLabel(`${estimate.pricesAsOf}T00:00:00Z`)}`}
          </span>
        )}
      </div>

      {estimate === null ? (
        <p className="estimate-empty">
          {estimating
            ? "Считаем стоимость…"
            : variant === "import"
              ? "Сначала выберите фото — оценка появится сама. Деньги не тратятся, пока вы не подтвердите сумму."
              : "Сначала цена, потом расходы: заполните внешность и нажмите «Оценить стоимость». Деньги не тратятся, пока вы не подтвердите сумму."}
        </p>
      ) : (
        <div className="estimate-figure" aria-live="polite">
          <div className="estimate-price">
            <p className="mono estimate-worst">
              <span>до</span> <span>{formatUsd(estimate.worstMicros, 2, "up")}</span>
            </p>
            <p className="mono estimate-expected">ожидаемая ≈ {formatUsd(estimate.expectedMicros)}</p>
          </div>
          <p className="estimate-caption">
            {caption(variant, repeat, imageAgeCheck)}
            {estimate.prices === "fallback" && " OpenRouter не ответил, поэтому цены взяты из резервной таблицы."}
          </p>
        </div>
      )}

      {previousWorst !== null && estimate && (
        <Notice tone="warn" title="Цена выросла">
          Было не больше <span className="mono">{formatUsd(previousWorst, 2, "up")}</span>, теперь не больше{" "}
          <span className="mono">{formatUsd(estimate.worstMicros, 2, "up")}</span>. Проверьте новую оценку и подтвердите снова — без
          подтверждения ничего не отправляется.
        </Notice>
      )}

      {error && error.code !== "PRICE_CHANGED" && <ErrorNotice error={error} actions={errorActions} />}

      {action && (
        <div className="estimate-actions">
          <button
            type="button"
            className={action.primary ? "btn btn-p" : "btn"}
            disabled={action.disabled}
            onClick={action.onClick}
            aria-busy={action.busy}
          >
            {action.busy ? (
              <>
                <Spin />
                Отправляем…
              </>
            ) : (
              action.label
            )}
          </button>
          {blockedReason && <p className="field-hint">{blockedReason}</p>}
        </div>
      )}
    </section>
  );
}
