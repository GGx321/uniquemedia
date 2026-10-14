import { useEffect, useState } from "react";
import { CLIP_RESTART_BANNER, clipReconcileWaitText } from "../../shared/engine/clipRestartTexts";
import type { EngineView } from "../engine/store";
import { formatUsdTiered } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { useNavigate } from "../navigation";
import { Notice } from "./Notice";

/**
 * Stage 5, 5b.1 (S5.V8; plan s5b1 §5.12, §6 46): the restart's line is said while the reconcile waits no longer than a restart's own quiet rule — about five minutes, as the line itself
 * says. A wait beyond it is a clip that may still bill (I5.48), said with its time.
 */
const RESTART_WAIT_MS = 5 * 60_000;

/**
 * When the reconcile can run, while that is still ahead (the engine's `MoneyStatus.reconcileAvailableAt`: the quiet rule and the clip holds), else null. Shown again when that time
 * comes, since nothing else may tell the window (the quiet rule moves no event).
 */
function useReconcileWait(view: EngineView): number | null {
  const at = view.money?.ledger === "open" && view.money.reconcileAvailableAt !== undefined ? Date.parse(view.money.reconcileAvailableAt) : null;
  const [, setPassed] = useState(0);
  // The clock is read on every render (the engine dates by the same clock); the effect only draws the banner again when that time may have come.
  const ahead = at !== null && at > Date.now();
  useEffect(() => {
    if (at === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A timer that fires while the date is still ahead (a clock set back, a drifting timer) is armed again; the page coming back to the front looks at the clock too (a sleep stops timers).
    const check = (): void => {
      clearTimeout(timer);
      setPassed((n) => n + 1);
      const wait = at - Date.now();
      if (wait > 0) timer = setTimeout(check, Math.min(wait + 50, 2 ** 31 - 1));
    };
    const wait = at - Date.now();
    if (wait > 0) timer = setTimeout(check, Math.min(wait + 50, 2 ** 31 - 1));
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [at]);
  return ahead ? at : null;
}

/** The one thing that blocks paid work right now, if any: the ledger, reconcile, a rejected key, or no key. */
export function AccountBanner({ view }: { view: EngineView }) {
  const navigate = useNavigate();
  const { money, settings } = view;
  const stop = paidStop(view);
  const waitUntil = useReconcileWait(view);

  if (stop?.kind === "restart") {
    return (
      <Notice
        tone="danger"
        title="Платные запросы остановлены"
        actions={
          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus: "money" })}>
            Открыть Настройки
          </button>
        }
      >
        {restartStopText(stop.code)}
      </Notice>
    );
  }
  if (stop?.kind === "reconcile") {
    // S5.V8 (mockups 40 #late, 46; review M6): while the reconcile cannot run yet, «Перейти к сверке» would only meet «сверка через N мин»: it is not offered, and the clip's line says
    // until when. A clip that was in work when Studio closed (a recovery job this window saw) says so for the restart's first minutes.
    const restarted = view.jobs.some((job) => job.clip?.recovery === true);
    const clipLine = waitUntil === null ? null : restarted && waitUntil - Date.now() <= RESTART_WAIT_MS ? CLIP_RESTART_BANNER : clipReconcileWaitText(waitUntil);
    return (
      <Notice
        tone="warn"
        title="Нужна сверка расходов"
        actions={
          waitUntil === null ? (
            <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus: "money" })}>
              Перейти к сверке
            </button>
          ) : undefined
        }
      >
        Платные запросы остановлены до сверки.
        {/* CS.6: by «Деньги на экране» like every price beside it — three decimals below $0.10 («до $0.038», not «до $0.04»), a ceiling up; CS.7 V5: in mono. */}
        {money?.ledger === "open" && money.unsettledCount > 0 && (
          <>
            {" Незакрытые резервы считаются по худшей цене: до "}
            <span className="mono">{formatUsdTiered(money.unsettledMicros, "up")}</span>.
          </>
        )}
        {clipLine !== null && <span className="notice-clip">{clipLine}</span>}
      </Notice>
    );
  }
  if (settings?.apiKey.rejected) {
    return (
      <Notice
        tone="danger"
        title="OpenRouter отклонил ключ (401)"
        actions={
          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus: "key" })}>
            Заменить ключ
          </button>
        }
      >
        Генерация остановлена и не повторяется, пока ключ не заменён.
      </Notice>
    );
  }
  if (settings && !settings.apiKey.stored) {
    return (
      <Notice
        tone="info"
        title="Добавьте ключ OpenRouter"
        actions={
          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus: "key" })}>
            Открыть Настройки
          </button>
        }
      >
        Без ключа аватары не создаются.
      </Notice>
    );
  }
  return null;
}
