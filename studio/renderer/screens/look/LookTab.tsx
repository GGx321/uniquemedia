import { useState } from "react";
import { bodyPhrase, type AvatarBody, type AvatarSummary } from "../../../shared/engine";
import type { EngineView } from "../../engine/store";
import { proposedBody } from "../../lib/body";
import { errorSettingsFocus, errorText, settingsLinkLabel } from "../../lib/errors";
import { formatUsdTiered } from "../../lib/money";
import { useNavigate, type LookLanding } from "../../navigation";
import { Notice } from "../../ui/Notice";
import { modelName, paidBlockedReason } from "../photos/runForm";
import { BodyCard } from "./BodyCard";
import { CheckCard, proposalOpen } from "./CheckCard";
import { DescriptionCard } from "./DescriptionCard";
import { avatarHeld, landingText, paidSettingsFocus, runDrawing } from "./lookModel";
import { MasterCard } from "./MasterCard";
import { PORTRAIT_TEXT, refusalLine } from "./portraitModel";
import { PortraitsPanel } from "./PortraitsPanel";
import type { LookCheck } from "./useLookCheck";
import type { Portraits } from "./usePortraits";

// S5.0d: the avatar page's «Внешность» (.omc/stage5/design 07, 09–13; 05–06 and 11 after «Импортировать» and «Сохранить»). Left: the master portrait,
// and under it «Сверка с фото» — what is compared with what, at a glance. Right: «Описание», and (S5.2d, 05–08) «Тело» under it.
// S5.3d (14–23): for an imported avatar the master is the «Мастер-портрет» card, and «Варианты мастер-портрета» spans the page over both columns while a
// batch runs or portraits wait.

/**
 * 18b: the paid start refused before anything was paid, under the landing line: the app's text for the code and that nothing was started. A face the
 * imported photo lacks and a hold are said at the button instead, and a price that rose is the check card's «Цена выросла».
 */
function StartRefusal({ portraits: p }: { portraits: Portraits }) {
  const navigate = useNavigate();
  if (p.start.kind !== "refused") return null;
  const { error } = p.start;
  if (error.code === "MASTER_FACE_UNUSABLE" || error.code === "IN_FLIGHT") return null;
  if (error.code === "PRICE_CHANGED" && p.previousWorst !== null && p.estimate !== null) {
    return (
      <Notice tone="warn" title="Цена выросла">
        Было не больше {formatUsdTiered(p.previousWorst, "up")}, теперь не больше {formatUsdTiered(p.estimate.worstMicros, "up")}. Подтвердите новую цену.{" "}
        {PORTRAIT_TEXT.notStarted}
      </Notice>
    );
  }
  const focus = errorSettingsFocus(error.code);
  return (
    <Notice
      tone="danger"
      actions={
        focus === null ? undefined : (
          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus })}>
            {settingsLinkLabel(focus)}
          </button>
        )
      }
    >
      {refusalLine(errorText(error))}
    </Notice>
  );
}

export function LookTab({
  avatar,
  view,
  look,
  portraits,
  landing,
  readFromPhoto,
}: {
  avatar: AvatarSummary;
  view: EngineView;
  look: LookCheck;
  /** S5.3d: the reference portrait, held by the screen (`usePortraits`). */
  portraits: Portraits;
  landing: LookLanding | null;
  /** The description is still the one the import read (held by the screen: `useReadFromPhoto`). */
  readFromPhoto: boolean;
}) {
  const ready = view.phase === "ready";
  const { avatarId } = avatar;
  const text = avatar.descriptor.text;
  // The way to the key is offered only when the key is what stops the check: an engine away is said first (`paidBlockedReason`'s order).
  const settingsFocus = paidSettingsFocus(view);
  const keyMissing = settingsFocus === "key";
  const blockedReason = paidBlockedReason(view);
  const checking = look.phase.kind === "running";
  const drawing = runDrawing(view, avatarId);
  /**
   * S5.R2: right after an import whose photo gave no body (no proposal is stored then, and she has none): the body is still to choose, and «Тело» says
   * the photo did not read it (mockup 05).
   */
  const unread = landing?.kind === "imported" && avatar.bodyProposal === undefined && avatar.body === undefined;
  /**
   * S5.2d: the body «Изменить тело» is editing (null: the summary). Held here, so «Описание» previews the phrase it would write. An import opens it at
   * once: with its proposal (06), or empty when the photo gave none (05, S5.R2); «Позже» closes it, and a proposal waits in the card.
   */
  const [bodyDraft, setBodyDraft] = useState<AvatarBody | null>(() =>
    avatar.bodyProposal !== undefined ? proposedBody(avatar.body, avatar.bodyProposal) : unread ? {} : null,
  );
  // The body is left to do after an import while its proposal waits or she has none (S5.R2).
  const bodyWaits = avatar.bodyProposal !== undefined || avatar.body === undefined;
  const { sourcePhotoId } = portraits;

  return (
    <>
      {/* 19: once a portrait is the master, what that changes takes the landing line's place. */}
      {portraits.saved ? (
        <Notice tone="ok">{PORTRAIT_TEXT.saved}</Notice>
      ) : (
        landing !== null && <Notice tone="ok">{landingText(landing, avatar.name, bodyWaits, portraits.landing)}</Notice>
      )}
      <StartRefusal portraits={portraits} />
      {portraits.panelOpen && <PortraitsPanel portraits={portraits} blockedReason={blockedReason} />}
      <div className="look">
        <div className="look-side">
          <MasterCard avatar={avatar} portraits={portraits} blockedReason={blockedReason} settingsFocus={settingsFocus} />
          <CheckCard
            look={look}
            currentText={text}
            currentBodyPhrase={avatar.body === undefined ? undefined : bodyPhrase(avatar.body)}
            model={view.settings === null ? null : modelName(view.settings.textModel)}
            blockedReason={blockedReason}
            keyMissing={keyMissing}
            held={avatarHeld(view, avatarId)}
            source={sourcePhotoId === null ? null : { avatarId, photoId: sourcePhotoId }}
          />
        </div>
        <div className="look-main">
          <DescriptionCard
            avatar={avatar}
            look={look}
            proposal={proposalOpen(look, text)}
            ready={ready}
            editHeld={checking}
            runDrawing={drawing}
            fresh={readFromPhoto}
            bodyDraft={bodyDraft}
          />
          <BodyCard avatar={avatar} draft={bodyDraft} onDraft={setBodyDraft} ready={ready} held={checking} runDrawing={drawing} unread={unread} />
        </div>
      </div>
    </>
  );
}
