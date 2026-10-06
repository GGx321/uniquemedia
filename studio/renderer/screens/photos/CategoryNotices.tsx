import { useId, useState } from "react";
import type { CategoryInterrupted, EngineError, Estimate } from "../../../shared/engine";
import type { CategoryLibrary, CategoryLibraryView } from "../../engine/categoryLibrary";
import { useEngineView } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { Icon } from "../../ui/Icon";
import { busyElsewhere, categoryPrice, worstOf } from "./categoryParts";
import { hiddenFailureText, interruptedText } from "./categoryText";
import { paidBlockedReason } from "./runForm";

// CS.3: what the category calls leave under the generate card (the CategoryStates sheet): a create that failed while its dialog was hidden,
// and the creates a closed Studio left unanswered (L-m). The latter also stand at the top of «Мои категории».

/**
 * A create or a regenerate a closed Studio left (`categories.list`'s `interrupted`): what happened, what it is counted at, and «Создать
 * снова» / «Пересоздать снова» (a NEW request with its own price — category calls are not resumed — unavailable while paid calls are
 * stopped, until the reconcile), «Изменить описание», «Убрать» (free: forgets the record).
 */
export function InterruptedNotice({
  call,
  library,
  slice,
  onRetry,
  onEdit,
}: {
  call: CategoryInterrupted;
  library: CategoryLibrary;
  slice: CategoryLibraryView;
  /** A priced click on «Создать снова» / «Пересоздать снова»: the new request, at `accepted`. */
  onRetry: (accepted: Estimate) => void;
  /** «Изменить описание»: the dialog (or the regenerate box) with this text. */
  onEdit: () => void;
}) {
  const engine = useEngineView();
  const whyId = useId();
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const { title, text } = interruptedText(call);
  const { estimate } = categoryPrice(engine, slice);
  const composing = slice.call?.name ?? busyElsewhere(slice);
  const blocked = paidBlockedReason(engine) ?? (composing !== null ? `Сейчас составляется «${composing}». По одной категории за раз — дождитесь её.` : null);
  const canRetry = blocked === null && estimate !== null;

  async function dismiss(): Promise<void> {
    if (dismissing) return;
    setDismissing(true);
    setError(null);
    const reply = await library.dismissInterrupted(call.jobId);
    // The notice goes with its record; on a refusal it stays, and says why.
    if (!reply.ok) {
      setDismissing(false);
      setError(reply.error);
    }
  }

  return (
    <div className="notice notice-warn" role="alert" data-interrupted={call.jobId}>
      <span className="notice-icon">
        <Icon name="alert" size={16} />
      </span>
      <div className="notice-body">
        <p className="notice-title">{title}</p>
        <div className="notice-text">{text}</div>
        <div className="notice-actions">
          <button
            type="button"
            className="btn btn-s"
            disabled={!canRetry}
            aria-describedby={blocked !== null ? whyId : undefined}
            onClick={() => {
              if (canRetry && estimate !== null) onRetry(estimate);
            }}
          >
            {call.kind === "create" ? "Создать снова" : "Пересоздать снова"} · {worstOf(estimate)}
          </button>
          <button type="button" className="btn btn-s" onClick={onEdit}>
            Изменить описание
          </button>
          <button type="button" className="btn btn-s" aria-busy={dismissing} disabled={dismissing} onClick={() => void dismiss()}>
            Убрать
          </button>
        </div>
        {blocked !== null && (
          <p id={whyId} className="faint cat-why">
            {blocked}
          </p>
        )}
        {error !== null && <p className="field-error">{errorText(error)}</p>}
      </div>
    </div>
  );
}

/** The notices under the generate card: a hidden create that failed, and the creates a closed Studio left. */
export function CategoryCardNotices({
  library,
  slice,
  dialogOpen,
  onEdit,
  onRetryInterrupted,
  onEditInterrupted,
}: {
  library: CategoryLibrary;
  slice: CategoryLibraryView;
  /** The dialog shows its own outcome while it is open: the notice is for one that ended hidden. */
  dialogOpen: boolean;
  onEdit: () => void;
  onRetryInterrupted: (call: CategoryInterrupted, accepted: Estimate) => void;
  onEditInterrupted: (call: CategoryInterrupted) => void;
}) {
  const outcome = slice.outcomes.create;
  const failed = !dialogOpen && outcome?.ok === false ? outcome : null;
  const interrupted = slice.list.status === "ready" ? slice.list.interrupted.filter((c) => c.kind === "create") : [];
  return (
    <>
      {failed !== null && (
        <div className="notice notice-danger" role="alert">
          <span className="notice-icon">
            <Icon name="alert" size={16} />
          </span>
          <div className="notice-body">
            <div className="notice-text">{hiddenFailureText(failed.call.name, failed.error)}</div>
            <div className="notice-actions">
              <button type="button" className="btn btn-s" onClick={onEdit}>
                Изменить описание
              </button>
              <button type="button" className="btn btn-s" onClick={() => library.clearOutcome("create")}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
      {interrupted.map((call) => (
        <InterruptedNotice key={call.jobId} call={call} library={library} slice={slice} onRetry={(accepted) => onRetryInterrupted(call, accepted)} onEdit={() => onEditInterrupted(call)} />
      ))}
    </>
  );
}
