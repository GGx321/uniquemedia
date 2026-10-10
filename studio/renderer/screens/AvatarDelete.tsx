import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AvatarDeletePreview, AvatarDeleteResult, EngineError, LaunchView } from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { countOf } from "../lib/format";
import { errorText } from "../lib/errors";
import { useNavigate } from "../navigation";
import { isUnfinished } from "./autopilot/planModel";
import { useMounted } from "./photos/shared";
import { Icon, Spin } from "../ui/Icon";
import { cancelOnEscape, useConfirmFocus } from "../ui/useConfirmFocus";

// «Удалить аватар» (owner request 2026-10-05) on an avatar's card: the avatar, its photos, candidates, master, drafts and finished videos go to the system
// Trash (macOS Trash, Windows Recycle Bin), where the owner can restore them. A confirmation on the card itself, as a draft's delete has: the focus goes to
// «Отмена», Escape cancels, and a cancel gives the focus back to the trash button. Pressing the trash asks the engine what would go (`avatars.deletePreview`,
// free), and «Удалить» is main's `avatars.delete`; the card leaves with the engine's `avatar.removed`.

/** The one sentence the owner reads before deleting. */
export const TRASH_SENTENCE = "Аватар, его фото, черновики и готовые видео уйдут в Корзину — оттуда их можно вернуть.";

/** How to get it back, in one line: the Trash holds the avatar's folder and each video file as separate things, and Studio shows the avatar again after a restart. */
export const RESTORE_LINE = "Вернуть можно из Корзины: аватар и каждый видеофайл лежат там отдельными объектами, а чтобы аватар снова появился в Studio, после возврата перезапустите Studio.";

const PHOTOS = ["фото", "фото", "фото"] as const;
const CANDIDATES = ["вариант портрета", "варианта портрета", "вариантов портрета"] as const;
const DRAFTS = ["черновик монтажа", "черновика монтажа", "черновиков монтажа"] as const;
const VIDEOS = ["видео", "видео", "видео"] as const;

/** «Уйдут в Корзину: 22 фото, 2 черновика монтажа.» — only what there is to go, the videos apart (`filesText`). */
export function goesText(preview: AvatarDeletePreview): string {
  const parts = [
    preview.photos > 0 ? countOf(preview.photos, PHOTOS) : null,
    preview.candidates > 0 ? countOf(preview.candidates, CANDIDATES) : null,
    preview.drafts > 0 ? countOf(preview.drafts, DRAFTS) : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Кроме самого аватара, у него пока ничего нет." : `Уйдут в Корзину: ${parts.join(", ")}.`;
}

/**
 * The videos in one line: how many there are, how many of their files are in «Готовые видео» now and go with the avatar, and what stays where it is: the files
 * that are not in the folder, and the ones that could not be checked in time.
 */
export function filesText(preview: AvatarDeletePreview): string | null {
  if (preview.videos === 0) return null;
  const { videos, videoFilesFound: found, videoFilesUnchecked: unchecked } = preview;
  const absent = Math.max(0, videos - found - unchecked);
  if (found === 0) {
    // Nothing goes: it is not said that anything does.
    const why = [absent > 0 ? `${absent} нет в «Готовые видео»` : null, unchecked > 0 ? `${unchecked} не успели проверить` : null].filter((part): part is string => part !== null);
    return `Видео: ${videos}. Их файлы в Корзину не уйдут: ${why.join(", ")} — они останутся как есть.`;
  }
  const parts = [`Видео: ${videos}. Файлов в «Готовые видео» найдено ${found} из ${videos} — они уйдут в Корзину.`];
  if (absent > 0) parts.push(`${absent} там нет — они останутся как есть.`);
  if (unchecked > 0) parts.push(`${unchecked} не успели проверить — они тоже останутся на месте.`);
  return parts.join(" ");
}

/** What the owner is told when video files stayed behind after the avatar went: the ones the Trash refused, and the ones that could not be checked. */
export function keptText({ kept, unchecked, folder }: { kept: number; unchecked: number; folder: string | null }): string {
  const parts = [kept > 0 ? `${countOf(kept, VIDEOS)} не удалось переместить в Корзину` : null, unchecked > 0 ? `${countOf(unchecked, VIDEOS)} не успели проверить` : null].filter(
    (part): part is string => part !== null,
  );
  return `${parts.join(", ")} — они остались в папке «Готовые видео${folder === null ? "" : `/${folder}`}».`;
}

type Phase =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly preview: AvatarDeletePreview; readonly failure: EngineError | null }
  | { readonly kind: "deleting"; readonly preview: AvatarDeletePreview }
  /** The preview was refused or could not be made: nothing to confirm. */
  | { readonly kind: "refused"; readonly error: EngineError }
  /** The preview or the delete was refused because an unfinished launch holds the avatar (M1): its start, said with «Открыть «Автопилот»» and «Понятно». */
  | { readonly kind: "in-launch"; readonly launchAt: string };

/**
 * What to do when the Trash refuses, on this system (`platform` is the window's `navigator.platform`): Windows keeps a Recycle Bin per volume, and a volume that has
 * never recycled anything, or a network drive, has none; macOS has none on some external and network volumes; elsewhere the advice names neither.
 */
export function trashHint(platform: string): string {
  if (/^win/i.test(platform)) return "Если на диске нет Корзины, удалите любой файл с него в Корзину один раз или перенесите библиотеку на другой диск.";
  if (/^mac/i.test(platform)) return "Корзина есть не на каждом внешнем или сетевом томе: перенесите библиотеку на внутренний диск или удалите папку аватара вручную в Finder.";
  return "Корзина есть не на каждом внешнем или сетевом томе: перенесите библиотеку на внутренний диск.";
}

const LAUNCH_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * S4.10 fix C (M1, HostStates «Другие экраны»): «Sofia в запуске автопилота от 8 окт., 14:02 — удалить её можно после «Стоп» или конца запуска.» The day and
 * time are the launch's start, in the viewer's own zone.
 */
export function inLaunchText(name: string, createdAt: string): string {
  const at = Date.parse(createdAt);
  return `${name} в запуске автопилота от ${Number.isNaN(at) ? createdAt : LAUNCH_DATE.format(at)} — удалить её можно после «Стоп» или конца запуска.`;
}

/**
 * The unfinished launch that holds the avatar (`draft.avatarIds`, paused included), whose start the refusal names; null when none does. The engine refuses
 * such an avatar with IN_FLIGHT (`#deleteBusy`) until «Стоп» or the end of the launch.
 */
function launchHolding(launch: LaunchView | null, avatarId: string): string | null {
  return isUnfinished(launch) && launch.draft.avatarIds.includes(avatarId) ? launch.createdAt : null;
}

/** The refusal of a preview or a delete, in words: a busy avatar says what to wait for; a Trash that refused says what to do here; every other code has its fixed Russian text. */
function failureText(error: EngineError): string {
  if (error.code === "TRASH_UNAVAILABLE") return `${errorText(error)} ${trashHint(typeof navigator === "undefined" ? "" : navigator.platform)}`;
  return error.code === "IN_FLIGHT"
    ? "Аватар сейчас занят: идёт генерация, рендер или сохранение, удаляется другой аватар или меняется папка библиотеки. Дождитесь окончания и повторите."
    : errorText(error);
}

/** Who was deleted, for what is said afterwards: a draft has no name of its own. */
export interface DeletedAvatar {
  readonly name: string;
  readonly draft: boolean;
}

export interface AvatarDelete {
  /** The trash button, for the card's header. */
  readonly trash: ReactNode;
  /** The open confirmation, for the card's body; null while nothing is asked. */
  readonly confirmation: ReactNode;
}

/**
 * `label` names the avatar in the button's name («Удалить аватар Mia»); `draft` words it for a draft. `onDeleted` is told once `avatars.delete` answered ok
 * (the card goes with `avatar.removed`): the screen moves the focus off the card and says what stayed behind.
 */
export function useAvatarDelete({ avatarId, label, draft, onDeleted }: { avatarId: string; label: string; draft: boolean; onDeleted: (who: DeletedAvatar, result: AvatarDeleteResult) => void }): AvatarDelete {
  const { client } = useEngine();
  const launch = useEngineView().autopilot;
  const navigate = useNavigate();
  const mounted = useMounted();
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const focus = useConfirmFocus();
  const trashRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  /** Which question is current: an answer to an older one (the owner cancelled and asked again) is dropped. */
  const asked = useRef(0);
  /** The library's launch as of the latest render: a refusal is read against it when it comes, and its words are kept (the launch may end while they are open). */
  const launchNow = useRef(launch);
  useEffect(() => {
    launchNow.current = launch;
  });
  const who: DeletedAvatar = { name: label, draft };

  /** An IN_FLIGHT the engine gives for an avatar an unfinished launch holds (M1): the launch's own words, the focus on «Понятно». */
  const heldByLaunch = useCallback(
    (error: EngineError): boolean => {
      const launchAt = error.code === "IN_FLIGHT" ? launchHolding(launchNow.current, avatarId) : null;
      if (launchAt === null) return false;
      setPhase({ kind: "in-launch", launchAt });
      focus.opened();
      return true;
    },
    [avatarId, focus],
  );

  const ask = useCallback((): void => {
    if (phase.kind !== "closed") return;
    const mine = ++asked.current;
    setPhase({ kind: "loading" });
    focus.opened();
    void client.request("avatars.deletePreview", { avatarId }).then((reply) => {
      if (!mounted.current || asked.current !== mine) return;
      if (!reply.ok && heldByLaunch(reply.error)) return;
      setPhase(reply.ok ? { kind: "ready", preview: reply.result, failure: null } : { kind: "refused", error: reply.error });
    });
  }, [phase.kind, client, avatarId, mounted, focus, heldByLaunch]);

  const cancel = useCallback((): void => {
    asked.current += 1;
    setPhase({ kind: "closed" });
    focus.moveTo(() => trashRef.current);
  }, [focus]);

  // The card leaves while the question is open (`avatar.removed`): nothing is left to answer to.
  useEffect(
    () => () => {
      asked.current += 1;
    },
    [],
  );

  async function remove(preview: AvatarDeletePreview): Promise<void> {
    setPhase({ kind: "deleting", preview });
    // The buttons are off while it runs and would drop the focus to the body: the question itself holds it.
    focus.moveTo(() => confirmRef.current);
    const reply = await client.request("avatars.delete", { avatarId });
    if (!mounted.current) {
      // The card is already gone (the event came first): the screen still hears the answer.
      if (reply.ok) onDeleted(who, reply.result);
      return;
    }
    if (reply.ok) {
      setPhase({ kind: "closed" });
      onDeleted(who, reply.result);
      return;
    }
    // A launch began meanwhile and holds the avatar: «Удалить» would be refused again until it ends, so it is not offered.
    if (heldByLaunch(reply.error)) return;
    // Refused: the question stays open with what went wrong, and its buttons, off while it was asked, take the focus back.
    setPhase({ kind: "ready", preview, failure: reply.error });
    focus.opened();
  }

  const open = phase.kind !== "closed";
  const deleting = phase.kind === "deleting";
  const trash = (
    <button
      ref={trashRef}
      type="button"
      className="ibtn avatar-delete"
      aria-label={draft ? "Удалить черновик аватара" : `Удалить аватар ${label}`}
      title={draft ? "Удалить черновик аватара" : "Удалить аватар"}
      aria-disabled={open}
      onClick={ask}
    >
      <Icon name="trash" size={13} />
    </button>
  );

  const preview = phase.kind === "ready" || phase.kind === "deleting" ? phase.preview : null;
  const failure = phase.kind === "ready" ? phase.failure : phase.kind === "refused" ? phase.error : null;
  const files = preview === null ? null : filesText(preview);
  const confirmation = !open ? null : (
    <div ref={confirmRef} tabIndex={-1} className="avatar-confirm" role="alert" onKeyDown={(e) => cancelOnEscape(e, cancel, deleting)}>
      {phase.kind === "loading" && (
        <span className="avatar-confirm-wait">
          <Spin /> Смотрим, что уйдёт…
        </span>
      )}
      {preview !== null && (
        <>
          <span>{goesText(preview)}</span>
          {files !== null && <span>{files}</span>}
          <span>{TRASH_SENTENCE}</span>
          <span className="faint">{RESTORE_LINE}</span>
          <span className="faint">Файлы из «Мои» (свои фото, видео, музыка и стикеры) останутся на месте.</span>
        </>
      )}
      {failure !== null && <span className="avatar-confirm-error">{failureText(failure)}</span>}
      {phase.kind === "in-launch" && <span>{inLaunchText(label, phase.launchAt)}</span>}
      <div className="draft-actions">
        {preview !== null && (
          <button type="button" className="btn btn-s btn-d" aria-busy={deleting} disabled={deleting} onClick={() => void remove(preview)}>
            {deleting && <Spin />}
            Удалить
          </button>
        )}
        {phase.kind === "in-launch" && (
          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "section", id: "autopilot" })}>
            Открыть «Автопилот»
          </button>
        )}
        <button ref={focus.cancelRef} type="button" className="btn btn-s" disabled={deleting} onClick={cancel}>
          {phase.kind === "in-launch" ? "Понятно" : "Отмена"}
        </button>
      </div>
    </div>
  );
  return { trash, confirmation };
}
