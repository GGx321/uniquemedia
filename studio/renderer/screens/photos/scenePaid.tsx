import { type ReactNode, type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EngineError, Estimate, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { EngineView } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { afterColon } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { Spin } from "../../ui/Icon";
import { Notice } from "../../ui/Notice";
import type { PaidAction, Reply } from "./usePaidAction";

// CS.6: the review's paid buttons drawn alike — the card's stacked one («Отрисовать 19 фото / до $2.85») and the small inline ones of the popover, the
// idea form and the column's notices («Заменить · до $0.075») — and the free prices they lean on.

export const ceiling = (micros: number): string => `до ${formatUsdTiered(micros, "up")}`;
export const about = (micros: number): string => `≈ ${formatUsdTiered(micros, "nearest")}`;

/** What a paid button shows and does now, from its action: the price it sends (or the one it is sending), busy, and whether a click goes. */
export interface PaidButtonState {
  readonly title: string;
  readonly price: string | null;
  readonly busy: boolean;
  readonly clickable: boolean;
  readonly confirm: boolean;
}

/**
 * The button's face for `action`: «Подтвердить новую цену» after PRICE_CHANGED; the price being sent while it sends; «до …» while the price is asked;
 * `free` names a send that costs nothing («бесплатно»). `blocked` keeps it from sending (the reason is shown next to it).
 */
export function paidButtonState(action: PaidAction, title: string, blocked: boolean, free = false): PaidButtonState {
  const confirm = action.previousWorst !== null && action.estimate !== null;
  const shown = action.sending && action.sentWorst !== null ? action.sentWorst : (action.estimate?.worstMicros ?? null);
  const price = free ? "бесплатно" : shown === null ? "до …" : ceiling(shown);
  return {
    title: confirm ? "Подтвердить новую цену" : title,
    price,
    busy: action.sending || action.estimating,
    clickable: !blocked && !action.sending && action.estimate !== null,
    confirm,
  };
}

/** The card's stacked button: its title, then its price on a second line (one accessible name: «Отрисовать 19 фото · до $2.85»). */
export function StackButton({
  state,
  onClick,
  describedBy,
  buttonRef,
  className = "photos-go",
}: {
  state: { title: string; price: string | null; busy: boolean; clickable: boolean };
  onClick: () => void;
  describedBy?: string | undefined;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`btn btn-p btn-stack ${className}`}
      disabled={!state.clickable}
      aria-busy={state.busy}
      aria-describedby={describedBy}
      onClick={onClick}
    >
      <span className="btn-stack-line">
        {state.busy && <Spin />}
        {state.title}
      </span>
      {state.price !== null && (
        <>
          <span className="sr-only"> · </span>
          <span className="mono">{state.price}</span>
        </>
      )}
    </button>
  );
}

/** A small paid button on one line: «Заменить · до $0.075». */
export function InlinePaidButton({
  state,
  onClick,
  primary = true,
  describedBy,
  buttonRef,
}: {
  state: PaidButtonState;
  onClick: () => void;
  primary?: boolean;
  describedBy?: string | undefined;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={primary ? "btn btn-p btn-s" : "btn btn-s"}
      disabled={!state.clickable}
      aria-busy={state.busy}
      aria-describedby={describedBy}
      onClick={onClick}
    >
      {state.busy && <Spin />}
      {/* One run of text, so the button's gap does not space the « · » out. */}
      <span>
        {state.title}
        {state.price !== null && (
          <>
            <span aria-hidden="true">{" · "}</span>
            <span className="sr-only"> · </span>
            <span className="nowrap">{state.price}</span>
          </>
        )}
      </span>
    </button>
  );
}

/** PRICE_CHANGED told in full, as the generate card tells it: the price refused and the fresh one, which needs a new click. */
export function PriceChangedNotice({ previousWorst, estimate }: { previousWorst: number; estimate: Estimate }) {
  return (
    <Notice tone="warn" title={estimate.worstMicros > previousWorst ? "Цена выросла" : "Цена изменилась"}>
      Было не больше <span className="mono">{formatUsdTiered(previousWorst, "up")}</span>, теперь не больше{" "}
      <span className="mono">{formatUsdTiered(estimate.worstMicros, "up")}</span>. Проверьте новую оценку и подтвердите снова — без подтверждения ничего не
      отправляется.
    </Notice>
  );
}

/**
 * The images alone for `photos` photos at the current Settings, for a set whose «Отрисовать» is not yet possible (an active scene without text, a write
 * running, a stop): `runs.estimateFromScenes` refuses those, so the image price is told by the run's own estimate less its writer (the compose's estimate
 * for the same count) — both free, both priced by the count and the settings alone (engine/runs/plan.ts `runEstimate`). It is shown, never sent.
 */
export function useImagesPrice(avatarId: string, photos: number, view: EngineView): Estimate | null {
  const { client } = useEngine();
  const settings = view.settings;
  const key = photos >= 1 && photos <= 100 && settings !== null ? `${avatarId}|${photos}|${settings.imageModel}|${settings.imageQuality ?? ""}|${settings.imageAgeCheck}|${settings.textModel}` : null;
  const [shown, setShown] = useState<{ key: string; estimate: Estimate } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    // Any built-in category: the price does not depend on which.
    const request = { avatarId, count: photos, categories: ["home" as const], poses: { profile: false, back: false } };
    void Promise.all([client.request("runs.estimate", request), client.request("scenes.estimateCompose", request)]).then(([run, writer]) => {
      if (!alive || !run.ok || !writer.ok) return;
      const r = run.result.estimate;
      const w = writer.result.estimate;
      setShown({
        key,
        estimate: { ...r, expectedMicros: Math.max(0, r.expectedMicros - w.expectedMicros), worstMicros: Math.max(0, r.worstMicros - w.worstMicros) },
      });
    });
    return () => {
      alive = false;
    };
  }, [client, key, avatarId, photos]);
  return shown !== null && shown.key === key ? shown.estimate : null;
}

/** The free price of a review write, asked for one key; null while asked or refused (the refusal is answered). */
export function useWritePrice(key: string | null, ask: () => Promise<Reply<{ estimate: Estimate }>>): { estimate: Estimate | null; error: EngineError | null } {
  const [shown, setShown] = useState<{ key: string; estimate: Estimate | null; error: EngineError | null } | null>(null);
  const latest = useRef(ask);
  useLayoutEffect(() => {
    latest.current = ask;
  });
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void latest.current().then((reply) => {
      if (alive) setShown(reply.ok ? { key, estimate: reply.result.estimate, error: null } : { key, estimate: null, error: reply.error });
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return shown === null || shown.key !== key ? { estimate: null, error: null } : { estimate: shown.estimate, error: shown.error };
}

/** The set's settings key: what moves the price of its writes (the set's own text model) and of its run (the current Settings' image side). */
export function setPriceKey(set: SceneSetView, view: EngineView): string {
  const s = view.settings;
  return `${set.sceneSetId}|${set.revision}|${s?.imageModel ?? ""}|${s?.imageQuality ?? ""}|${s?.imageAgeCheck ?? ""}|${set.textModel}|${view.money?.reconcileNeeded === true ? "r" : ""}`;
}

/** A reason line under a paid control, its id for `aria-describedby`. */
export function Why({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="field-hint scene-why">
      {children}
    </p>
  );
}

/** The ids a control is described by, the lines not shown left out; undefined when none is. */
export function describedBy(...ids: readonly (string | null | false | undefined)[]): string | undefined {
  const shown = ids.filter((id): id is string => typeof id === "string" && id !== "");
  return shown.length === 0 ? undefined : shown.join(" ");
}

/** Whether the focus is nowhere a person put it: on the page itself, or on an element that has left it. */
export function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * CS.7 M2: the free price of a paid control could not be had — why, and «Повторить» (decision 16: a paid control that cannot send says why), in the words of
 * CS.3's create dialog: «Цену не узнать: … · Повторить». «Повторить» asks again (free). Once the price comes this line goes, and a focus it held goes to
 * `after` — the paid control, priced now — instead of to the page.
 */
export function PriceFailed({ id, error, onRetry, after }: { id: string; error: EngineError; onRetry: () => void; after: () => HTMLElement | null }) {
  const [asking, setAsking] = useState(false);
  const retried = useRef(false);
  const latestAfter = useRef(after);
  useLayoutEffect(() => {
    latestAfter.current = after;
  });
  // A fresh refusal ends the ask: the line says why again.
  useEffect(() => setAsking(false), [error]);
  useEffect(
    () => () => {
      if (retried.current && focusLost()) latestAfter.current()?.focus();
    },
    [],
  );
  return (
    <p id={id} className="price-failed">
      <span className={asking ? "faint" : "danger-text"}>{asking ? "Узнаём цену…" : `Цену не узнать: ${afterColon(errorText(error))}`}</span>
      <button
        type="button"
        className="link-btn"
        aria-disabled={asking}
        onClick={() => {
          if (asking) return;
          retried.current = true;
          setAsking(true);
          onRetry();
        }}
      >
        Повторить
      </button>
    </p>
  );
}
