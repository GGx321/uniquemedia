import { useEffect, useId, useRef, useState } from "react";
import { CLIP_REASONS_RU, type ClipUnsuitableReason, type PhotoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { animateBlock } from "./animate";
import { useClips } from "./clipsContext";
import { ClipSheet } from "./ClipSheet";

// Stage 5, 5b.1, S5.V8 (mockups 37, 37a–37d; plan s5b1 §6, R-10): «Оживить» in the photo viewer — the one way from a photo to a paid clip, and only through the sheet. It waits, with the
// reason under it (`.viewer-why`, its `aria-describedby`), while the account stops paid work (37c), another clip holds the paid slot (37b), or the engine finds the photo unsuitable (37a,
// 37d: its free `clips.options` answers the reason). A photo whose prices cannot be read opens the sheet anyway, which says so (38f).

interface AnimateButtonProps {
  readonly photo: PhotoSummary;
  /** «Фото 7 из 46 · Дом»: the sheet's subtitle, as the viewer counts. */
  readonly subtitle: string;
  readonly frameLabel: string;
  /** The sheet opened or closed over the viewer: its own keys wait meanwhile. */
  readonly onSheet: (open: boolean) => void;
}

export function AnimateButton({ photo, subtitle, frameLabel, onSheet }: AnimateButtonProps) {
  const clips = useClips();
  const { client } = useEngine();
  const navigate = useNavigate();
  const whyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [unsuitable, setUnsuitable] = useState<{ photoId: string; reason: ClipUnsuitableReason | null } | null>(null);
  const ready = clips?.view.phase === "ready";
  const avatarId = clips?.avatar.avatarId ?? null;

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
  const block = animateBlock(clips.view, clips.avatar.status === "active");
  const reason = unsuitable !== null && unsuitable.photoId === photo.photoId ? unsuitable.reason : null;
  const why = block !== null ? block : reason !== null ? ({ kind: "text", text: CLIP_REASONS_RU[reason] } as const) : null;

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
        disabled={why !== null}
        onClick={() => show(true)}
      >
        <Icon name="sparkle" size={14} strokeWidth={2} />
        Оживить
      </button>
      {why !== null && (
        <p id={whyId} className="viewer-why">
          {why.kind === "nokey" ? (
            <>
              Нужен ключ OpenRouter —{" "}
              <button type="button" className="viewer-why-link" onClick={() => navigate({ name: "settings", focus: "key" })}>
                Настройки
              </button>
              .
            </>
          ) : (
            why.text
          )}
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
          onStarted={(jobId, intent) => {
            show(false);
            clips.started(jobId, intent);
          }}
        />
      )}
    </>
  );
}
