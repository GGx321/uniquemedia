import { useState } from "react";
import type { AvatarBody, AvatarSummary } from "../../../shared/engine";
import type { EngineView } from "../../engine/store";
import { proposedBody } from "../../lib/body";
import { paidStop } from "../../lib/paidStop";
import type { LookLanding } from "../../navigation";
import { Notice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";
import { modelName, paidBlockedReason } from "../photos/runForm";
import { BodyCard } from "./BodyCard";
import { CheckCard, proposalOpen } from "./CheckCard";
import { DescriptionCard } from "./DescriptionCard";
import { avatarHeld, landingText, runDrawing } from "./lookModel";
import type { LookCheck } from "./useLookCheck";

// S5.0d: the avatar page's «Внешность» (.omc/stage5/design 07, 09–13; 05–06 and 11 after «Импортировать» and «Сохранить»). Left: the master portrait,
// and under it «Сверка с фото» — what is compared with what, at a glance. Right: «Описание», and (S5.2d, 05–08) «Тело» under it.

export function LookTab({
  avatar,
  view,
  look,
  landing,
  readFromPhoto,
}: {
  avatar: AvatarSummary;
  view: EngineView;
  look: LookCheck;
  landing: LookLanding | null;
  /** The description is still the one the import read (held by the screen: `useReadFromPhoto`). */
  readFromPhoto: boolean;
}) {
  const ready = view.phase === "ready";
  const { avatarId } = avatar;
  const text = avatar.descriptor.text;
  const key = view.settings?.apiKey;
  // The way to the key is offered only when the key is what stops the check: an engine away is said first (`paidBlockedReason`'s order).
  const keyMissing = paidStop(view)?.kind !== "offline" && (key === undefined || !key.stored || key.rejected);
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

  return (
    <>
      {landing !== null && <Notice tone="ok">{landingText(landing, avatar.name, bodyWaits)}</Notice>}
      <div className="look">
        <div className="look-side">
          <div className="ph look-master">
            <Portrait avatarId={avatarId} photoId={avatar.masterPhotoId} label={`Мастер-портрет: ${avatar.name}`} />
            <span className="pill look-master-pill">мастер-портрет</span>
          </div>
          <CheckCard
            look={look}
            currentText={text}
            model={view.settings === null ? null : modelName(view.settings.textModel)}
            blockedReason={paidBlockedReason(view)}
            keyMissing={keyMissing}
            held={avatarHeld(view, avatarId)}
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
