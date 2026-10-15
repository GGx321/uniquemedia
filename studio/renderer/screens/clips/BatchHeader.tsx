import { useId, type Ref } from "react";
import { nbDash } from "../../lib/format";
import { Icon, Spin } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import type { BatchTone, BatchView, MemberState } from "./batchModel";

// 5b.2, S5.WB4: the batch's header over the «Клипы» tiles (mockups 60–60f; README §S5.WBD decision 7). One line counting the members (`batchView`: by distinct `batchIndex`, so it survives `KEEP_FINISHED`
// and a restart), the second line a stop, a cancel, a restart or a photo gone says, a strip of the members' photos in turn order, and the one action: «Отменить оставшиеся» while members wait, else ✕
// (and 60e's «Отметить их снова»). It is not a live region (decision 13): after «Отменить оставшиеся» the focus goes to its line, which is read then.

/**
 * A strip cell per member state (the mockup's `.batch-cell-*`): made, at work, waiting, refused (and failed: no clip came), late, not shot; with no summary, a clip made and since deleted reads as made, and
 * a member nothing is left of is an empty cell.
 */
const CELL: Record<MemberState, string> = { done: "done", run: "run", wait: "wait", refused: "refused", failed: "refused", late: "late", off: "off", removed: "done", unknown: "off" };
const ICON: Record<BatchTone, "sparkle" | "check" | "info" | "alert"> = { run: "sparkle", ok: "check", info: "info", warn: "alert" };

export interface BatchHeaderProps {
  readonly avatarId: string;
  readonly batch: BatchView;
  /** «Отменить оставшиеся» was clicked and the engine has not answered yet: «Отменяем…». */
  readonly cancelling: boolean;
  readonly titleRef: Ref<HTMLHeadingElement>;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly onAgain: (photoIds: readonly string[]) => void;
}

/** 60b's money in mono, as the line's last part: «Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78». */
function Title({ text }: { text: string }) {
  const at = text.lastIndexOf(" · $");
  if (!text.startsWith("Пакет готов:") || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)} · <span className="mono">{text.slice(at + 3)}</span>
    </>
  );
}

export function BatchHeader({ avatarId, batch, cancelling, titleRef, onCancel, onClose, onAgain }: BatchHeaderProps) {
  const titleId = useId();
  const lineId = useId();
  const again = batch.again;
  return (
    <section className={`batch-head batch-head-${batch.tone}`} aria-labelledby={titleId}>
      <span className="batch-head-ic" aria-hidden="true">
        <Icon name={ICON[batch.tone]} size={16} strokeWidth={2} />
      </span>
      <div className="batch-head-text">
        <h3 ref={titleRef} id={titleId} className="batch-title" tabIndex={-1} aria-describedby={batch.line === null ? undefined : lineId}>
          <Title text={batch.title} />
        </h3>
        {batch.line !== null && (
          <p id={lineId} className="batch-line">
            {nbDash(batch.line)}
          </p>
        )}
      </div>
      <div className="batch-strip" aria-hidden="true">
        {batch.members.map((member) => (
          <span key={member.index} className={`batch-cell batch-cell-${CELL[member.state]}`}>
            {member.state !== "off" && member.photoId !== null && <Portrait avatarId={avatarId} photoId={member.photoId} label={`Клип ${member.index} из ${batch.size}`} />}
            {member.state === "run" && <span className="shim" />}
          </span>
        ))}
      </div>
      {batch.cancel && (
        <button type="button" className="btn btn-s batch-cancel" aria-busy={cancelling || undefined} aria-disabled={cancelling || undefined} onClick={() => !cancelling && onCancel()}>
          {cancelling ? <Spin /> : <Icon name="close" size={13} strokeWidth={2.2} />}
          {cancelling ? "Отменяем…" : "Отменить оставшиеся"}
        </button>
      )}
      {again !== null && (
        <button type="button" className="btn btn-s batch-again" onClick={() => onAgain(again)}>
          <Icon name="sparkle" size={13} strokeWidth={2} />
          Отметить их снова
        </button>
      )}
      {batch.close && (
        <button type="button" className="ibtn batch-close" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      )}
    </section>
  );
}
