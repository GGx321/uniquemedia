import { useId, type ReactNode } from "react";
import { PORTRAITS_PER_BATCH } from "../../../shared/engine";
import { formatUsdTiered } from "../../lib/money";
import { countOf } from "../../lib/format";
import { Icon, Spin } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { CandidatesCard } from "../wizard/CandidatesCard";
import { InlineAskBox, useInlineAsk } from "./InlineAsk";
import { HeldLine } from "./MasterCard";
import {
  ageRejectedLine,
  batchFits,
  capReason,
  DISCARD_ASK,
  goneTiles,
  NONE_PASSED,
  paidFailureLine,
  PICK_HINT,
  PORTRAIT_TEXT,
  RESET_LABEL,
  VARIANT_FORMS,
} from "./portraitModel";
import type { Portraits } from "./usePortraits";

// S5.3d: «Варианты мастер-портрета», the full-width panel over «Внешность» while a batch runs or portraits wait (.omc/stage5/design 15–23): the wizard's
// CandidatesCard with five slots and a likeness badge, and an action rail beside the grid — the free pick, another paid batch, and the reset, which asks
// first because the waiting portraits go (M3).

/** «Ещё 5 вариантов · до $0.30»: another batch at the price on the button, or why it is not offered. */
function AgainButton({ portraits: p, blockedReason, describedBy }: { portraits: Portraits; blockedReason: string | null; describedBy: string | undefined }) {
  const sending = p.start.kind === "sending";
  const priceChanged = p.previousWorst !== null && p.estimate !== null;
  const off =
    sending ||
    p.estimate === null ||
    blockedReason !== null ||
    p.held ||
    p.pickPhase.kind === "saving" ||
    !batchFits(p.pending.length) ||
    (p.start.kind === "refused" && p.start.error.code === "MASTER_FACE_UNUSABLE");
  return (
    <button type="button" className={priceChanged ? "btn btn-p" : "btn"} disabled={off} aria-busy={sending} aria-describedby={describedBy} onClick={() => p.startBatch()}>
      {sending ? (
        <>
          <Spin />
          Запускаем…
        </>
      ) : (
        <>
          {priceChanged ? "Подтвердить новую цену" : `Ещё ${PORTRAITS_PER_BATCH} вариантов`}
          {p.estimate !== null && (
            <>
              {" · "}
              <span className="mono">до {formatUsdTiered(p.estimate.worstMicros, "up")}</span>
            </>
          )}
        </>
      )}
    </button>
  );
}

function Rail({ portraits: p, blockedReason }: { portraits: Portraits; blockedReason: string | null }) {
  const pickId = useId();
  const againId = useId();
  const resetId = useId();
  const ask = useInlineAsk();
  if (p.running) {
    return (
      <div className="portraits-rail">
        <p className="portraits-note">
          <Icon name="info" size={14} strokeWidth={2} />
          <span>{PORTRAIT_TEXT.running}</span>
        </p>
      </div>
    );
  }

  const saving = p.pickPhase.kind === "saving";
  const discarding = p.discardPhase.kind === "saving";
  const pickRefused = p.pickPhase.kind === "refused" ? p.pickPhase.error : null;
  const discardRefused = p.discardPhase.kind === "refused" ? p.discardPhase.error : null;
  const fits = batchFits(p.pending.length);
  // Why «Ещё 5» waits: the engine's own stop first, then the limit, then a price that could not be had.
  const againWhy: string | null =
    blockedReason ??
    (p.start.kind === "refused" && p.start.error.code === "MASTER_FACE_UNUSABLE"
      ? PORTRAIT_TEXT.noFace
      : !fits
        ? capReason(p.pending.length)
        : p.estimate === null && !p.estimating && p.estimateError !== null
          ? PORTRAIT_TEXT.priceUnknown
          : null);
  const againReason = againWhy !== null && !p.held ? (
    <p id={againId} className="field-hint">
      {againWhy}
    </p>
  ) : null;
  const heldLine = p.held ? <HeldLine id={againId}>{PORTRAIT_TEXT.held}</HeldLine> : null;
  const again = <AgainButton portraits={p} blockedReason={blockedReason} describedBy={againReason !== null || heldLine !== null ? againId : undefined} />;

  if (p.pending.length === 0) {
    // 17, and a batch that failed or was cancelled before it drew anything: no portrait waits, so the reset only closes the panel.
    return (
      <div className="portraits-rail">
        {again}
        {againReason}
        <button type="button" className="btn" disabled={p.start.kind === "sending"} onClick={() => p.closePanel()}>
          {RESET_LABEL[p.masterKind]}
        </button>
        {heldLine}
      </div>
    );
  }

  const pickHeld = p.held || pickRefused?.code === "IN_FLIGHT";
  const discardHeld = discardRefused?.code === "IN_FLIGHT";
  // 16c: at the limit the reset is the way on, and says what it does.
  const resetLabel = fits ? RESET_LABEL[p.masterKind] : "Удалить варианты";
  return (
    <div className="portraits-rail">
      <button
        type="button"
        className="btn btn-p"
        disabled={p.held || saving || discarding || p.picked === null || p.start.kind === "sending"}
        aria-busy={saving}
        aria-describedby={pickId}
        onClick={() => p.pick()}
      >
        {saving ? (
          <>
            <Spin />
            Сохраняем…
          </>
        ) : (
          PORTRAIT_TEXT.pick
        )}
      </button>
      {pickHeld ? (
        <HeldLine id={pickId}>{PORTRAIT_TEXT.pickHeld}</HeldLine>
      ) : (
        <p id={pickId} className="field-hint">
          {PICK_HINT[p.masterKind]}
        </p>
      )}
      <span className="portraits-rail-sep" aria-hidden="true" />
      {again}
      {againReason}
      <div className="rail-reset">
        {ask.open ? (
          <InlineAskBox ask={ask} question={DISCARD_ASK[p.masterKind]} confirm="Удалить" busyLabel="Удаляем…" busy={discarding} onConfirm={() => p.discard()} />
        ) : (
          <>
            <button
              ref={ask.trigger}
              type="button"
              className="btn"
              disabled={p.held || saving || p.start.kind === "sending"}
              aria-describedby={resetId}
              onClick={() => ask.ask()}
            >
              {resetLabel}
            </button>
            {discardHeld ? (
              <HeldLine id={resetId}>{PORTRAIT_TEXT.discardHeld}</HeldLine>
            ) : (
              <p id={resetId} className="field-hint">
                {PORTRAIT_TEXT.discardHint}
              </p>
            )}
          </>
        )}
      </div>
      {heldLine}
    </div>
  );
}

export function PortraitsPanel({ portraits: p, blockedReason }: { portraits: Portraits; blockedReason: string | null }) {
  const { job, pending, running } = p;
  const result = job !== null && job.status === "done" && job.result?.kind === "avatar.portraits" ? job.result : null;
  const failedSlots = result?.failedSlots ?? [];
  const noneCame = result !== null && result.candidates.length === 0 && pending.length === 0;

  const lines: ReactNode[] = [];
  const age = ageRejectedLine(failedSlots.filter((f) => f.reason === "age-rejected").length);
  if (age !== null) lines.push(<Notice key="age" tone="info">{age}</Notice>);
  const paid = paidFailureLine(failedSlots);
  if (paid !== null) lines.push(<Notice key="paid" tone="warn">{paid}</Notice>);
  if (noneCame) lines.push(<Notice key="none" tone="warn">{NONE_PASSED}</Notice>);
  if (p.pickPhase.kind === "refused" && p.pickPhase.error.code !== "IN_FLIGHT") lines.push(<ErrorNotice key="pick" error={p.pickPhase.error} />);
  if (p.discardPhase.kind === "refused" && p.discardPhase.error.code !== "IN_FLIGHT") lines.push(<ErrorNotice key="discard" error={p.discardPhase.error} />);
  if (p.cancelError !== null) lines.push(<ErrorNotice key="cancel" error={p.cancelError} />);

  const meta = running ? null : pending.length > 0 ? `${countOf(pending.length, VARIANT_FORMS)} · выберите один` : noneCame ? "ни один не подошёл" : null;

  return (
    <CandidatesCard
      candidates={pending}
      job={job}
      picked={p.picked}
      onPick={(photoId) => p.choose(photoId)}
      onCancel={() => p.cancel()}
      cancelling={p.cancelling}
      headingRef={p.panelHeading}
      hiddenBelowThreshold={0}
      slots={PORTRAITS_PER_BATCH}
      portrait={{
        best: p.best,
        gone: result === null ? [] : goneTiles(failedSlots),
        meta,
        notices: lines.length > 0 ? <>{lines}</> : null,
        keptOnCancel: pending.length > 0,
        rail: <Rail portraits={p} blockedReason={blockedReason} />,
        busy: p.pickPhase.kind === "saving",
      }}
    />
  );
}
