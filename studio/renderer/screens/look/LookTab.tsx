import { useState } from "react";
import type { AvatarSummary } from "../../../shared/engine";
import type { EngineView } from "../../engine/store";
import type { LookLanding } from "../../navigation";
import { Notice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";
import { modelName, paidBlockedReason } from "../photos/runForm";
import { CheckCard, proposalOpen } from "./CheckCard";
import { DescriptionCard } from "./DescriptionCard";
import { avatarHeld, runDrawing } from "./lookModel";
import type { LookCheck } from "./useLookCheck";

// S5.0d: the avatar page's «Внешность» (.omc/stage5/design 07, 09–13; 05–06 and 11 after «Импортировать» and «Сохранить»). Left: the master portrait,
// and under it «Сверка с фото» — what is compared with what, at a glance. Right: «Описание». The «Тело» card of the mockup is S5.2d's.

/** The line over the tab right after the avatar was made, as the mockup's 05, 06 and 11 say it. */
function landingText(landing: LookLanding, name: string): string {
  if (landing.kind === "created") return `Аватар «${name}» сохранён. Мастер-портрет готов для фото.`;
  const { check } = landing;
  if (check === null) return `Аватар «${name}» импортирован. Описание прочитано с фото.`;
  return check.matches ? `Аватар «${name}» импортирован. Описание прочитано с фото и сверено с ним.` : `Аватар «${name}» импортирован. Описание прочитано с фото — проверьте сверку.`;
}

export function LookTab({ avatar, view, look, landing }: { avatar: AvatarSummary; view: EngineView; look: LookCheck; landing: LookLanding | null }) {
  const ready = view.phase === "ready";
  const { avatarId } = avatar;
  const text = avatar.descriptor.text;
  // The text the import read, kept so «прочитано с фото» goes once the owner (or a proposal) changes it.
  const [readAtImport] = useState(() => (landing?.kind === "imported" ? text : null));
  const key = view.settings?.apiKey;
  const keyMissing = key === undefined || !key.stored || key.rejected;
  const checking = look.phase.kind === "running";

  return (
    <>
      {landing !== null && <Notice tone="ok">{landingText(landing, avatar.name)}</Notice>}
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
            runDrawing={runDrawing(view, avatarId)}
            fresh={readAtImport !== null && readAtImport === text}
          />
        </div>
      </div>
    </>
  );
}
