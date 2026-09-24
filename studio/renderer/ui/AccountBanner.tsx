import type { EngineView } from "../engine/store";
import { formatUsd } from "../lib/money";
import { useNavigate } from "../navigation";
import { Notice } from "./Notice";

/** The one thing that blocks paid work right now, if any: reconcile, a rejected key, or no key. */
export function AccountBanner({ view }: { view: EngineView }) {
  const navigate = useNavigate();
  const { money, settings, engineError } = view;

  if (money?.reconcileNeeded || engineError?.code === "SETTLE_ABOVE_WORST") {
    return (
      <Notice
        tone="warn"
        title="Нужна сверка расходов"
        actions={
          <button type="button" className="btn btn-sm" onClick={() => navigate({ name: "settings", focus: "money" })}>
            Перейти к сверке
          </button>
        }
      >
        Платные запросы остановлены до сверки.
        {money && money.unsettledCount > 0 && ` Незакрытые резервы считаются по худшей цене: до ${formatUsd(money.unsettledMicros, 2, "up")}.`}
      </Notice>
    );
  }
  if (settings?.apiKey.rejected) {
    return (
      <Notice
        tone="danger"
        title="OpenRouter отклонил ключ (401)"
        actions={
          <button type="button" className="btn btn-sm" onClick={() => navigate({ name: "settings", focus: "key" })}>
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
          <button type="button" className="btn btn-sm" onClick={() => navigate({ name: "settings", focus: "key" })}>
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
