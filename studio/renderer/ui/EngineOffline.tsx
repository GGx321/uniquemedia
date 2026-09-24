import { useEngine } from "../engine/react";
import type { EngineView } from "../engine/store";
import { errorText } from "../lib/errors";
import { Notice } from "./Notice";

/** The engine cannot be reached: missing from the build (no retry helps) or not answering (retry). */
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
