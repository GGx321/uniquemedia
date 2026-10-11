import { useId, type ReactNode } from "react";
import { PORTRAITS_PER_BATCH } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
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
  freeFailureLine,
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
    p.capRefused ||
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

/**
 * The reset: every waiting portrait goes (`avatars.discardPortraits`), the master stays. It asks first (M3); a hold says so under it, and in its open
 * question (review L2).
 */
function ResetBlock({ portraits: p, label }: { portraits: Portraits; label: string }) {
  const resetId = useId();
  const ask = useInlineAsk();
  const saving = p.pickPhase.kind === "saving";
  const discarding = p.discardPhase.kind === "saving";
  const discardRefused = p.discardPhase.kind === "refused" ? p.discardPhase.error : null;
  const held = p.held || discardRefused?.code === "IN_FLIGHT";
  const wait = <HeldLine id={resetId}>{PORTRAIT_TEXT.discardHeld}</HeldLine>;
  return (
    <div className="rail-reset">
      {ask.open ? (
        <>
          <InlineAskBox ask={ask} question={DISCARD_ASK[p.masterKind]} confirm="Удалить" busyLabel="Удаляем…" busy={discarding} onConfirm={() => p.discard()} />
          {held && wait}
        </>
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
            {label}
          </button>
          {held ? (
            wait
          ) : (
            <p id={resetId} className="field-hint">
              {PORTRAIT_TEXT.discardHint}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Rail({ portraits: p, blockedReason }: { portraits: Portraits; blockedReason: string | null }) {
  const pickId = useId();
  const againId = useId();
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
  // The limit: what the window sees, or (review L4) what the engine counted and refused at.
  const fits = batchFits(p.pending.length) && !p.capRefused;
  // Why «Ещё 5» waits: the engine's own stop first, then a face the imported photo lacks, then a hold (known, or met as IN_FLIGHT: review L1), then the
  // limit (the engine's refusal in its words, else the count the window sees), then a price that could not be had. A wait is said in the held style.
  const startRefused = p.start.kind === "refused" ? p.start.error : null;
  const againWhy: { readonly text: string; readonly held: boolean } | null =
    blockedReason !== null
      ? { text: blockedReason, held: false }
      : startRefused?.code === "MASTER_FACE_UNUSABLE"
        ? { text: PORTRAIT_TEXT.noFace, held: true }
        : p.held || startRefused?.code === "IN_FLIGHT"
          ? { text: PORTRAIT_TEXT.held, held: true }
          : p.capRefused && startRefused !== null
            ? { text: errorText(startRefused), held: false }
            : !fits
              ? { text: capReason(p.pending.length), held: false }
              : p.estimate === null && !p.estimating && p.estimateError !== null
                ? { text: PORTRAIT_TEXT.priceUnknown, held: false }
                : null;
  const againReason =
    againWhy === null ? null : againWhy.held ? (
      <HeldLine id={againId}>{againWhy.text}</HeldLine>
    ) : (
      <p id={againId} className="field-hint">
        {againWhy.text}
      </p>
    );
  const again = <AgainButton portraits={p} blockedReason={blockedReason} describedBy={againReason !== null ? againId : undefined} />;

  if (p.pending.length === 0) {
    // 17, and a batch that failed or was cancelled before it drew anything: no portrait waits, so the reset only closes the panel. At the limit the
    // engine counted (review L4), the waiting portraits are hidden from the list: «Удалить варианты» clears them.
    return (
      <div className="portraits-rail">
        {again}
        {againReason}
        {p.capRefused ? (
          <ResetBlock portraits={p} label="Удалить варианты" />
        ) : (
          <button type="button" className="btn" disabled={p.start.kind === "sending"} onClick={() => p.closePanel()}>
            {RESET_LABEL[p.masterKind]}
          </button>
        )}
      </div>
    );
  }

  const pickHeld = p.held || pickRefused?.code === "IN_FLIGHT";
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
      {/* 16c: at the limit the reset is the way on, and says what it does. */}
      <ResetBlock portraits={p} label={fits ? RESET_LABEL[p.masterKind] : "Удалить варианты"} />
    </div>
  );
}

export function PortraitsPanel({ portraits: p, blockedReason }: { portraits: Portraits; blockedReason: string | null }) {
  const { job, pending, running } = p;
  const result = job !== null && job.status === "done" && job.result?.kind === "avatar.portraits" ? job.result : null;
  const failedSlots = result?.failedSlots ?? [];
  // Review M2: what a failed slot cost depends on the age check (its check comes after a paid image). The settings' mode now, or «on» when the batch
  // itself shows a slot the check dropped.
  const ageCheck = p.ageCheck === "on" || failedSlots.some((f) => f.reason === "age-rejected") ? "on" : "off";
  const noneCame = result !== null && result.candidates.length === 0 && pending.length === 0;

  const lines: ReactNode[] = [];
  const age = ageRejectedLine(failedSlots.filter((f) => f.reason === "age-rejected").length);
  if (age !== null) lines.push(<Notice key="age" tone="info">{age}</Notice>);
  const paid = paidFailureLine(ageCheck, failedSlots);
  if (paid !== null) lines.push(<Notice key="paid" tone="warn">{paid}</Notice>);
  const free = freeFailureLine(ageCheck, failedSlots);
  if (free !== null) lines.push(<Notice key="free" tone="info">{free}</Notice>);
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
        gone: result === null ? [] : goneTiles(ageCheck, failedSlots),
        meta,
        notices: lines.length > 0 ? <>{lines}</> : null,
        keptOnCancel: pending.length > 0,
        rail: <Rail portraits={p} blockedReason={blockedReason} />,
        busy: p.pickPhase.kind === "saving",
      }}
    />
  );
}
