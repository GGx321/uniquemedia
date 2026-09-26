import { ENGINE_GONE_DETAIL } from "../../shared/engine";
import { useEngine } from "../engine/react";
import type { EngineView } from "../engine/store";
import { errorText } from "../lib/errors";
import { Notice } from "./Notice";

/** The engine cannot be reached: missing from the build (no retry helps), dead for good (M5, no retry helps either), or merely not answering yet (retry). */
export function EngineOffline({ view }: { view: EngineView }) {
  const { client, store } = useEngine();
  if (client.kind === "unavailable") {
    return (
      <Notice tone="danger" title="Движок недоступен">
        Эта сборка Studio не нашла свой движок, поэтому ничего не загружается и ничего не тратится. Перезапустите
        приложение; если не поможет — переустановите его.
      </Notice>
    );
  }
  // main's EngineHost stamps every answer with this detail once it has given
  // up restarting the engine (ENGINE_GONE_DETAIL, engineHost.ts): "Повторить"
  // would just fail the exact same way again, so it is not offered at all.
  if (view.failure?.detail === ENGINE_GONE_DETAIL) {
    return (
      <Notice tone="danger" title="Движок не отвечает">
        Движок Studio остановился и не будет перезапущен. Перезапустите приложение.
      </Notice>
    );
  }
  return (
    <Notice
      tone="danger"
      title="Движок не отвечает"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => store.reload()}>
          Повторить
        </button>
      }
    >
      {view.failure ? errorText(view.failure) : "Не удалось получить состояние движка."}
    </Notice>
  );
}
