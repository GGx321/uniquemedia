import { useId } from "react";
import type { AvatarSummary, LaunchPreviewAvatar } from "../../../shared/engine";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { Portrait } from "../../ui/Portrait";
import { avatarRow } from "./planModel";

// S4.9a: column 1 of «Автопилот» (AutopilotS4.dc.html): the active avatars, each a button with aria-pressed, «Все» / «Никого», «N своб.» (free photos in
// the chosen categories, from the engine's plan) and a tag that says why an avatar will not go or will wait. While a launch runs the list is that launch's,
// read only: its rows are aria-disabled (the focus still walks them) and the ones not in it are dimmed.

export interface AvatarColumnProps {
  /** The active avatars, in the list's order; null while the engine is not ready yet. */
  readonly avatars: readonly AvatarSummary[] | null;
  readonly chosen: readonly string[];
  /** The plan's own lines for the chosen avatars, and the probe's for every active one. */
  readonly planned: ReadonlyMap<string, LaunchPreviewAvatar>;
  readonly probed: ReadonlyMap<string, LaunchPreviewAvatar>;
  /** The launch's settings shown read-only (a launch is unfinished), or the form locked while «Запустить» is on its way. */
  readonly readOnly: boolean;
  /** Dim the avatars a running launch does not take. */
  readonly running: boolean;
  /** Whether «своб.» can be shown at all (the counts are a plan's, and nothing is planned while a launch runs). */
  readonly showFree: boolean;
  readonly onToggle: (avatarId: string) => void;
  readonly onAll: () => void;
  readonly onNone: () => void;
  /**
   * S4.9c (ApFromMain): how many avatars «Автопилот для выбранных» brought from «Аватары», and whether they were held back because a launch is unfinished (the
   * form is that launch's then); null when the screen was opened otherwise.
   */
  readonly fromMain?: { readonly count: number; readonly held: boolean } | null;
}

export function AvatarColumn({ avatars, chosen, planned, probed, readOnly, running, showFree, onToggle, onAll, onNone, fromMain = null }: AvatarColumnProps) {
  const navigate = useNavigate();
  const ids = useId();
  const headId = `${ids}-head`;
  const chosenSet = new Set(chosen);
  const empty = avatars !== null && avatars.length === 0;
  return (
    <section className={running ? "card ap-col ap-avatars ap-locked" : "card ap-col ap-avatars"} aria-labelledby={headId}>
      <div className="ap-avatars-head">
        <h2 id={headId} className="fl ap-avatars-title">
          Аватары{" "}
          <span className="mono muted ap-avatars-count">
            {chosen.length} из {avatars?.length ?? 0}
          </span>
        </h2>
        {!running && avatars !== null && avatars.length > 0 && (
          <div className="ap-bulk">
            <button type="button" className="chip ap-bulk-chip" aria-disabled={readOnly || undefined} onClick={readOnly ? undefined : onAll}>
              Все
            </button>
            <button type="button" className="chip ap-bulk-chip" aria-disabled={readOnly || undefined} onClick={readOnly ? undefined : onNone}>
              Никого
            </button>
          </div>
        )}
      </div>
      {showFree && avatars !== null && avatars.length > 0 && <span className="faint ap-avatars-hint">своб. — свободные фото в выбранных категориях</span>}
      {fromMain !== null && !fromMain.held && !running && (
        <p className="ap-from-main" role="status">
          <Icon name="info" size={13} />
          <span>Выбраны на экране «Аватары»: {fromMain.count}. Поменять можно здесь.</span>
        </p>
      )}
      {fromMain !== null && fromMain.held && running && (
        <p className="ap-from-main" role="status">
          <Icon name="info" size={13} />
          <span>
            Выбранные на экране «Аватары» ({fromMain.count}) не подставлены: запуск не закончен, и здесь его настройки. Выберите их снова после «Стоп» или конца запуска.
          </span>
        </p>
      )}
      {empty ? (
        <div className="ap-avatars-empty">
          <span className="ap-empty-mark" aria-hidden="true">
            <Icon name="person" size={20} strokeWidth={1.9} />
          </span>
          <span className="ap-empty-title">Активных аватаров нет</span>
          <span className="faint ap-empty-text">Автопилот работает с активными аватарами. Архивные сюда не попадают.</span>
          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "avatars" })}>
            Открыть «Аватары»
          </button>
        </div>
      ) : (
        <div className="ap-avatar-list" role="group" aria-labelledby={headId}>
          {(avatars ?? []).map((avatar) => {
            const on = chosenSet.has(avatar.avatarId);
            const facts = avatarRow(avatar.name, on ? planned.get(avatar.avatarId) : undefined, probed.get(avatar.avatarId));
            const tagId = `${ids}-${avatar.avatarId}-tag`;
            const freeId = `${ids}-${avatar.avatarId}-free`;
            const free = showFree ? facts.free : null;
            const describedBy = [facts.tag !== null && tagId, free !== null && freeId].filter(Boolean).join(" ");
            const classes = ["ap-av", on && "ap-av-on", running && !on && "ap-av-out", facts.tag !== null && "ap-av-tagged"].filter(Boolean).join(" ");
            return (
              <button
                key={avatar.avatarId}
                type="button"
                className={classes}
                aria-pressed={on}
                aria-label={avatar.name}
                aria-describedby={describedBy === "" ? undefined : describedBy}
                aria-disabled={readOnly || undefined}
                onClick={readOnly ? undefined : () => onToggle(avatar.avatarId)}
              >
                <span className="ap-cb" aria-hidden="true">
                  {on && <Icon name="check" size={12} strokeWidth={3.2} />}
                </span>
                <span className="ph ap-av-face" aria-hidden="true">
                  <Portrait avatarId={avatar.avatarId} photoId={avatar.masterPhotoId} label="" />
                </span>
                <span className="ap-av-name">{avatar.name}</span>
                <span className="ap-av-side">
                  {facts.tag !== null && (
                    <span id={tagId} className={`tag ap-tag ap-tag-${facts.tag.tone}`} title={facts.tag.title}>
                      {facts.tag.text}
                    </span>
                  )}
                  {free !== null && (
                    <span id={freeId} className={facts.freeWarn ? "mono ap-av-free ap-av-free-warn" : "mono ap-av-free"}>
                      {free}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
