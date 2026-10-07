import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EngineError, SceneSetView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { FocusEdge } from "../../ui/FocusEdge";
import { Spin } from "../../ui/Icon";
import { ErrorNotice } from "../../ui/Notice";
import { useModalDialog } from "../../ui/useModalDialog";
import { recomposeAfter, recomposeLosses, recomposeSpent } from "./sceneText";
import { useMounted } from "./shared";

// CS.6: «Пересоставить сцены?» (ReviewRecompose, README decision 12). The set is discarded for free (`scenes.discard`) and the card opens for its
// settings again; a new compose is a click of its own, with its own price. The dialog says what goes with the set — the owner's own scenes (paid for), the
// scenes the model replaced (those this window saw), the hand edits and removals — and what the set already cost. The destructive button comes first,
// the focus starts on «Отмена» (DraftsScreen's own order); Escape cancels and the focus goes back to «Пересоставить…».

interface RecomposeDialogProps {
  set: SceneSetView;
  /** The scenes this window saw a rewrite replace. */
  replaced: number;
  /** The card's count: what «Составить N сцен» will offer next. */
  count: number;
  /** Closed without discarding: the focus goes back to «Пересоставить…». */
  onCancel: () => void;
  /** Discarded: the focus goes to the card's «Составить». */
  onDiscarded: () => void;
}

export function RecomposeDialog({ set, replaced, count, onCancel, onDiscarded }: RecomposeDialogProps) {
  const { client, sceneSets } = useEngine();
  const mounted = useMounted();
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const discarded = useRef(false);
  useModalDialog({
    dialog: dialogRef,
    initialFocus: cancelRef,
    onClose: () => {
      if (!busy) onCancel();
    },
    returnFocus: () => null,
  });

  const losses = recomposeLosses(set, replaced);
  const spent = recomposeSpent(set);

  async function discard(): Promise<void> {
    if (busy || discarded.current) return;
    setBusy(true);
    setError(null);
    const reply = await client.request("scenes.discard", { sceneSetId: set.sceneSetId });
    if (reply.ok) {
      discarded.current = true;
      sceneSets.reload(set.avatarId);
    }
    if (!mounted.current) return;
    setBusy(false);
    if (reply.ok) onDiscarded();
    else setError(reply.error);
  }

  return createPortal(
    <div className="cat-scrim cat-scrim-center" role="presentation">
      <section ref={dialogRef} className="cat-dlg scene-recompose" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <div className="scene-recompose-body">
          <h2 id={titleId} className="cat-dlg-title">
            Пересоставить сцены?
          </h2>
          <div id={textId} className="scene-recompose-text">
            <p>{losses.length > 0 ? "Набор удалится целиком. Пропадут:" : "Набор удалится целиком."}</p>
            {losses.length > 0 && (
              <ul>
                {losses.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {spent !== null && (
              <p>
                {spent.before}
                <span className="mono">{spent.amount}</span>
                {spent.after}
              </p>
            )}
            <p className="muted">{recomposeAfter(count)}</p>
          </div>
          {error !== null && <ErrorNotice error={error} />}
        </div>
        <footer className="scene-recompose-foot">
          <button type="button" className="btn btn-s btn-d" aria-busy={busy} disabled={busy} onClick={() => void discard()}>
            {busy && <Spin />}
            Удалить набор
          </button>
          <button ref={cancelRef} type="button" className="btn btn-s" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
