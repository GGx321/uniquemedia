import type { ReactNode } from "react";
import type { EngineError, Estimate } from "../../../shared/engine";
import { dateLabel } from "../../lib/format";
import { formatUsd } from "../../lib/money";
import { ErrorNotice, Notice } from "../../ui/Notice";

export interface EstimateAction {
  label: string;
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
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
}

/** Step 2: the price before anything is spent, and the button that accepts it. */
export function EstimateCard({ estimate, previousWorst, estimating, action, blockedReason, error, errorActions, repeat }: EstimateCardProps) {
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
        <p className="muted estimate-empty">
          {estimating
            ? "Считаем стоимость…"
            : "Сначала цена, потом расходы: заполните внешность и нажмите «Оценить стоимость». Деньги не тратятся, пока вы не подтвердите сумму."}
        </p>
      ) : (
        <div className="estimate-body" aria-live="polite">
          <p className="estimate-figure">
            <span className="estimate-expected">≈ {formatUsd(estimate.expectedMicros)}</span>
            <span className="estimate-sep">, </span>
            <span className="estimate-worst">
              не больше <b>{formatUsd(estimate.worstMicros, 2, "up")}</b>
            </span>
          </p>
          <p className="estimate-caption">
            {repeat
              // The descriptor is already paid for and this price is the
              // batch alone (avatars.estimateCandidates / the draft's own
              // estimate) — not the whole avatar's price used as a loose
              // upper bound, so the caption must not claim that anymore.
              ? "Ещё 4 портрета и проверка возраста каждого. Дескриптор уже готов и не пересоздаётся — в эту цену он не входит."
              : "Дескриптор, 4 портрета и проверка возраста каждого. Худшая цена — это предел: дороже этот шаг не выйдет."}
            {estimate.prices === "fallback" && " OpenRouter не ответил, поэтому цены взяты из резервной таблицы."}
          </p>
        </div>
      )}

      {previousWorst !== null && estimate && (
        <Notice tone="warn" title="Цена выросла">
          Было не больше {formatUsd(previousWorst, 2, "up")}, теперь не больше {formatUsd(estimate.worstMicros, 2, "up")}. Проверьте
          новую оценку и подтвердите снова — без подтверждения ничего не отправляется.
        </Notice>
      )}

      {error && error.code !== "PRICE_CHANGED" && <ErrorNotice error={error} actions={errorActions} />}

      {action && (
        <div className="estimate-actions">
          <button type="button" className="btn btn-primary btn-wide" disabled={action.disabled} onClick={action.onClick} aria-busy={action.busy}>
            {action.busy ? "Отправляем…" : action.label}
          </button>
          {blockedReason && <p className="field-hint">{blockedReason}</p>}
        </div>
      )}
    </section>
  );
}
