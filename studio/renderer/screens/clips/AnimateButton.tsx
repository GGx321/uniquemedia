import { useEffect, useId, useRef, useState } from "react";
import { CLIP_REASONS_RU, type ClipUnsuitableReason, type PhotoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { NBSP, nbDash } from "../../lib/format";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { animateBlock, type AnimateBlock } from "./animate";
import { useClips } from "./clipsContext";
import { ClipSheet } from "./ClipSheet";

// Stage 5, 5b.1, S5.V8 (mockups 37, 37a–37d; plan s5b1 §6, R-10): «Оживить» in the photo viewer — the one way from a photo to a paid clip, and only through the sheet. It waits, with the
// reason under it (`.viewer-why`, its `aria-describedby`), while the account stops paid work (37c), another clip holds the paid slot (37b), or the engine finds the photo unsuitable (37a,
// 37d: its free `clips.options` answers the reason). A photo whose prices cannot be read opens the sheet anyway, which says so (38f).
// 5b.2 (S5.WB4, mockup 37e): while a batch runs it waits too, but stays a control (`aria-disabled`): it keeps the focus and reads its reason, whose «отмените оставшиеся» leads to «Клипы».

interface AnimateButtonProps {
  readonly photo: PhotoSummary;
  /** «Фото 7 из 46 · Дом»: the sheet's subtitle, as the viewer counts. */
  readonly subtitle: string;
  readonly frameLabel: string;
  /** The sheet opened or closed over the viewer: its own keys wait meanwhile. */
  readonly onSheet: (open: boolean) => void;
}

/**
 * 5b.2 (S5.WB4c): the «Клипы» tab of the avatar a batch is of — this screen's own tab when it is the avatar on show (the tab's heading takes the focus), else that avatar's screen opened on «Клипы».
 */
export function useShowBatchClips(): (avatarId: string) => void {
  const clips = useClips();
  const navigate = useNavigate();
  return (avatarId) => {
    if (clips !== null && clips.avatar.avatarId === avatarId) clips.showClips();
    else navigate({ name: "photos", avatarId, tab: "clips" });
  };
}

/**
 * What a waiting «Оживить» (or «Оживить выбранные», or the batch sheet) says: the reason's text; 37c's «Нужен ключ OpenRouter — Настройки.» with «Настройки» a link; 37e's batch reason with
 * «отмените оставшиеся» a link to the batch's avatar's «Клипы» — only while members still wait to be cancelled. A dash never starts a line.
 */
export function AnimateWhy({ why, onShowClips }: { why: AnimateBlock; onShowClips: (avatarId: string) => void }) {
  const navigate = useNavigate();
  if (why.kind === "nokey") {
    return (
      <>
        Нужен ключ OpenRouter{NBSP}—{" "}
        <button type="button" className="viewer-why-link" onClick={() => navigate({ name: "settings", focus: "key" })}>
          Настройки
        </button>
        .
      </>
    );
  }
  if (why.kind === "batch") {
    // The contract's words (`batch-running`), the way out made a link: «…дождитесь окончания или [отмените оставшиеся].»
    const link = "отмените оставшиеся";
    const at = why.text.lastIndexOf(link);
    if (at < 0 || !why.queued) return <>{nbDash(why.text)}</>;
    return (
      <>
        {nbDash(why.text.slice(0, at))}
        <button type="button" className="viewer-why-link" onClick={() => onShowClips(why.avatarId)}>
          {link}
        </button>
        {why.text.slice(at + link.length)}
      </>
    );
  }
  return <>{nbDash(why.text)}</>;
}

export function AnimateButton({ photo, subtitle, frameLabel, onSheet }: AnimateButtonProps) {
  const clips = useClips();
  const { client } = useEngine();
  const whyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [unsuitable, setUnsuitable] = useState<{ photoId: string; reason: ClipUnsuitableReason | null } | null>(null);
  const ready = clips?.view.phase === "ready";
  const avatarId = clips?.avatar.avatarId ?? null;
  const showBatchClips = useShowBatchClips();

  // The engine's own word on this photo (free): a photo it cannot bring to life says why before the sheet opens.
  useEffect(() => {
    if (!ready || avatarId === null) return;
    let alive = true;
    void client.request("clips.options", { avatarId, photoId: photo.photoId }).then((reply) => {
      if (!alive) return;
      setUnsuitable({ photoId: photo.photoId, reason: reply.ok && !reply.result.suitable ? reply.result.reason : null });
    });
    return () => {
      alive = false;
    };
  }, [ready, client, avatarId, photo.photoId]);

  if (clips === null) return null;
  const block = animateBlock(clips.view, clips.avatar.status === "active", clips.avatar.avatarId);
  const reason = unsuitable !== null && unsuitable.photoId === photo.photoId ? unsuitable.reason : null;
  const why: AnimateBlock | null = block !== null ? block : reason !== null ? { kind: "text", text: CLIP_REASONS_RU[reason] } : null;
  // 37e: a batch's wait is aria-disabled (the button keeps the focus and reads its reason); every other wait is as built (`disabled`).
  const batch = why?.kind === "batch";

  const show = (next: boolean): void => {
    setOpen(next);
    onSheet(next);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-s viewer-animate"
        aria-haspopup="dialog"
        aria-describedby={why === null ? undefined : whyId}
        disabled={why !== null && !batch}
        aria-disabled={batch || undefined}
        onClick={() => {
          if (!batch) show(true);
        }}
      >
        <Icon name="sparkle" size={14} strokeWidth={2} />
        Оживить
      </button>
      {why !== null && (
        <p id={whyId} className="viewer-why">
          <AnimateWhy why={why} onShowClips={showBatchClips} />
        </p>
      )}
      {open && (
        <ClipSheet
          avatarId={clips.avatar.avatarId}
          photoId={photo.photoId}
          subtitle={subtitle}
          frameLabel={frameLabel}
          onClose={() => show(false)}
          returnFocus={() => buttonRef.current}
          onStarted={(jobId) => {
            show(false);
            clips.started(jobId);
          }}
        />
      )}
    </>
  );
}
