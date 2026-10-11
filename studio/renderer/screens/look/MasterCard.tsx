import { useId, type ReactNode } from "react";
import type { AvatarSummary } from "../../../shared/engine";
import { errorText, settingsLinkLabel } from "../../lib/errors";
import { formatUsdTiered } from "../../lib/money";
import { useNavigate, type SettingsFocus } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { Notice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";
import { InlineAskBox, useInlineAsk } from "./InlineAsk";
import { likenessText, PORTRAIT_TEXT } from "./portraitModel";
import type { Portraits } from "./usePortraits";

// S5.3d: «Мастер-портрет», the card at the top of «Внешность»'s side column (.omc/stage5/design 15–23): the master in a 300 × 300 frame whose pill says
// what it is — the imported photo, or a portrait and its likeness to it — and under it only what can be done with it: the paid start (20, 21), the way
// back to the imported photo (21, 21b), and why the start is not offered (18b, 20b, 22). While the panel is open the card is the frame alone. A wizard
// avatar has no card: its master frame is today's.

/** A reason under a button, in the check card's held style (a warning icon, `--warn`). */
export function HeldLine({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="chk-held">
      <Icon name="alert" size={14} strokeWidth={2} />
      <span>{children}</span>
    </p>
  );
}

/**
 * The paid start: «Получить 5 вариантов» on the first line, its worst case on the second (the check card's `.btn-stack`), and under it the expected
 * cost or why it waits. The same click rules everywhere: the price on the button is what the click accepts.
 */
function StartBlock({ portraits: p, primary, blockedReason, settingsFocus }: { portraits: Portraits; primary: boolean; blockedReason: string | null; settingsFocus: SettingsFocus | null }) {
  const navigate = useNavigate();
  const whyId = useId();
  const sending = p.start.kind === "sending";
  const refused = p.start.kind === "refused" ? p.start.error.code : null;
  const priceChanged = p.previousWorst !== null && p.estimate !== null;

  let disabled = sending || p.estimate === null;
  let why: ReactNode = null;
  /** The line under the button says why it waits (then the button points at it), not what it costs. */
  let reason = true;
  if (sending) why = null;
  else if (blockedReason !== null) {
    disabled = true;
    why = (
      <>
        <p id={whyId} className="field-hint">
          {p.landingSkipped ? `${blockedReason} ${PORTRAIT_TEXT.notStarted}` : blockedReason}
        </p>
        {settingsFocus !== null && (
          <button type="button" className="btn btn-s chk-settings" onClick={() => navigate({ name: "settings", focus: settingsFocus })}>
            {settingsLinkLabel(settingsFocus)}
          </button>
        )}
      </>
    );
  } else if (refused === "MASTER_FACE_UNUSABLE") {
    // Review M5: it can never succeed on this photo, so it is not offered, in §3's own words.
    disabled = true;
    why = <HeldLine id={whyId}>{PORTRAIT_TEXT.noFace}</HeldLine>;
  } else if (p.held || refused === "IN_FLIGHT") {
    disabled = disabled || p.held;
    why = <HeldLine id={whyId}>{PORTRAIT_TEXT.held}</HeldLine>;
  } else if (p.estimate === null && !p.estimating && p.estimateError !== null) {
    why = (
      <p id={whyId} className="field-hint">
        {PORTRAIT_TEXT.priceUnknown}
      </p>
    );
  } else if (p.estimate !== null) {
    reason = false;
    why = (
      <p className="field-hint">
        ожидаемая ≈ <span className="mono">{formatUsdTiered(p.estimate.expectedMicros, "nearest")}</span> · 5 вариантов на выбор
      </p>
    );
  }
  // 20b: no price, no second line; «до …» while it is asked.
  const worst = p.estimate !== null ? `до ${formatUsdTiered(p.estimate.worstMicros, "up")}` : p.estimating ? "до …" : null;

  return (
    <>
      <button
        type="button"
        className={primary || priceChanged ? "btn btn-p btn-stack" : "btn btn-stack"}
        disabled={disabled}
        aria-busy={sending}
        aria-describedby={why !== null && reason ? whyId : undefined}
        onClick={() => p.startBatch()}
      >
        <span className="btn-stack-line">
          {sending && <Spin />}
          {sending ? "Запускаем…" : priceChanged ? "Подтвердить новую цену" : PORTRAIT_TEXT.start}
        </span>
        {!sending && worst !== null && (
          <>
            <span className="sr-only"> · </span>
            <span className="mono">{worst}</span>
          </>
        )}
      </button>
      {why}
    </>
  );
}

/** After a switch (21): the imported photo, kept, and the way back to it — asked first, since the paid portrait goes (21b). */
function SourceTile({ avatarId, portraits: p }: { avatarId: string; portraits: Portraits }) {
  const ask = useInlineAsk();
  const saving = p.revertPhase.kind === "saving";
  const refused = p.revertPhase.kind === "refused" ? p.revertPhase.error : null;
  const heldId = useId();
  const held = p.held || refused?.code === "IN_FLIGHT";
  const { sourcePhotoId } = p;
  if (sourcePhotoId === null) return null;
  return (
    <div className="source-tile">
      <div className="ph source-thumb" aria-hidden="true">
        <Portrait avatarId={avatarId} photoId={sourcePhotoId} label="Исходное фото" />
      </div>
      <div className="source-text">
        <span className="source-title">исходное фото</span>
        {ask.open ? (
          <InlineAskBox ask={ask} question={PORTRAIT_TEXT.revertAsk} confirm="Вернуть" busyLabel="Возвращаем…" busy={saving} onConfirm={() => p.revert()} />
        ) : (
          <button
            ref={ask.trigger}
            type="button"
            // Review L3: with the master's file gone, the way back is the primary action.
            className={p.masterMissing ? "btn btn-s btn-p" : "btn btn-s"}
            disabled={p.held}
            aria-describedby={held ? heldId : undefined}
            onClick={() => ask.ask()}
          >
            {PORTRAIT_TEXT.revert}
          </button>
        )}
        {held && <HeldLine id={heldId}>{PORTRAIT_TEXT.revertHeld}</HeldLine>}
        {refused !== null && refused.code !== "IN_FLIGHT" && <p className="field-hint danger-text">{errorText(refused)}</p>}
      </div>
    </div>
  );
}

export function MasterCard({
  avatar,
  portraits: p,
  blockedReason,
  settingsFocus,
}: {
  avatar: AvatarSummary;
  portraits: Portraits;
  /** Why no paid command can go now (no key, offline, a halt), or null. */
  blockedReason: string | null;
  /** Where in Settings that reason is fixed (the key, the money), if there. */
  settingsFocus: SettingsFocus | null;
}) {
  const titleId = useId();
  const frame = (pill: string) => (
    <div className="ph look-master">
      <Portrait avatarId={avatar.avatarId} photoId={avatar.masterPhotoId} label={`Мастер-портрет: ${avatar.name}`} />
      <span className="pill look-master-pill">{pill}</span>
    </div>
  );
  const { masterPhotoId } = avatar;

  // A wizard avatar (and any avatar until its portraits are read): today's bare master frame.
  if (p.sourcePhotoId === null) return frame("мастер-портрет");

  const pill =
    p.masterKind === "source"
      ? "исходное фото · сейчас мастер"
      : p.masterLikeness !== null
        ? `мастер-портрет · сходство ${likenessText(p.masterLikeness)}`
        : "мастер-портрет";
  const body =
    p.panelOpen || !p.actionable ? null : p.masterKind === "source" ? (
      <>
        <p className="master-why">{PORTRAIT_TEXT.why}</p>
        <StartBlock portraits={p} primary blockedReason={blockedReason} settingsFocus={settingsFocus} />
      </>
    ) : (
      <>
        {p.masterMissing && (
          <Notice tone="warn" role="status">
            {PORTRAIT_TEXT.masterMissing}
          </Notice>
        )}
        {/* Keyed by the master: a question left open about an earlier one is not about this one. */}
        <SourceTile key={masterPhotoId} avatarId={avatar.avatarId} portraits={p} />
        <StartBlock portraits={p} primary={false} blockedReason={blockedReason} settingsFocus={settingsFocus} />
      </>
    );

  return (
    <section className="card master-card" aria-labelledby={titleId}>
      {/* The pill names the frame on screen, as the bare frame does today; the heading is for a screen reader. */}
      <h2 id={titleId} ref={p.masterHeading} className="sr-only" tabIndex={-1}>
        Мастер-портрет
      </h2>
      {frame(pill)}
      {body !== null && <div className="master-body">{body}</div>}
    </section>
  );
}
