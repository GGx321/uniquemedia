import { memo } from "react";
import type { ClipSummary, EngineError } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { ClipJobInfo } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { clipPosterUrl } from "../../lib/media";
import { Icon, Spin } from "../../ui/Icon";
import { Portrait, PortraitPlaceholder } from "../../ui/Portrait";
import { useMediaRetry } from "../../ui/useMediaRetry";
import { ClipSteps } from "./ClipSteps";
import { clipLength, faceBadge, failedTile, readyMeta, readyTags, savedExport, type FaceBadge, type PhaseLine } from "./clipModel";
import { clipUsedBadge } from "./clipUse";

// Stage 5, 5b.1, S5.V8: the «Клипы» tab's tiles (mockups 40, 41, 42, 46; README §S5.VD decisions 4–6): the gallery's tile shape, the poster a 9:16 frame. A clip that came opens the clip
// viewer; one at work shows its phase, its steps and the money that may still go; one that did not come says why in the tone of its money, with what can be done about it, and its trash
// removes it at once (it has no file and no copy; its money line stays in the spending history).

type Ready = Extract<ClipSummary, { status: "ready" }>;
type Failed = Extract<ClipSummary, { status: "failed" }>;

/** The app's PlayIcon: a filled triangle, not a stroke. */
function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function FaceBadgeView({ badge }: { badge: FaceBadge }) {
  if (badge.kind === "none") return <span className="pill mono photo-badge photo-face-none">{badge.text}</span>;
  if (badge.kind === "low") return <span className="pill photo-badge clip-face-low">{badge.text}</span>;
  return <span className="pill mono photo-badge photo-face">{badge.text}</span>;
}

function Pills({ length, tags }: { length: string | null; tags: readonly string[] }) {
  if (length === null && tags.length === 0) return null;
  return (
    <div className="clip-pills">
      {length !== null && <span className={length === "0:10" ? "pill mono clip-len clip-len-long" : "pill mono clip-len"}>{length}</span>}
      {tags.map((tag) => (
        <span key={tag} className="pill clip-tag">
          {tag}
        </span>
      ))}
    </div>
  );
}

/**
 * A ready clip's poster (the frame at 0.5 s, through main's `clipposter` route), or the placeholder: in the dev mock (no files), and when the file will not load — a poster gone from the library included.
 * 5b.2 (S5.WA4): the editor's «Клипы» tab draws the same poster.
 */
export function Poster({ clip }: { clip: Ready }) {
  const { client } = useEngine();
  const src = clipPosterUrl(clip.avatarId, clip.clipId);
  const retry = useMediaRetry(src);
  if (client.kind === "mock" || src === null || retry.failed || retry.waiting) return <PortraitPlaceholder seed={clip.clipId} label={`Постер клипа «${clip.motion.label}»`} />;
  return <img key={retry.key} className="clip-poster-img" src={src} alt="" decoding="async" onError={retry.onError} />;
}

export const ReadyTile = memo(function ReadyTile({ clip, nowMs, onOpen }: { clip: Ready; nowMs: number; onOpen: (clipId: string) => void }) {
  const length = clipLength(clip.durationMs);
  const meta = readyMeta(clip, nowMs);
  // 5b.2 (41e): the clip's frame is in a finished video, through the clip or its photo: one badge, the title tells which.
  const used = clipUsedBadge(clip.use);
  return (
    // S5.WAR L8: the badge's reason is in the tile's name too — its title alone reaches only a pointer.
    <article className="clip-tile" aria-label={used === null ? `Клип: ${clip.motion.label}` : `Клип: ${clip.motion.label} · ${used.title}`}>
      <div className="ph clip-tile-poster">
        <Poster clip={clip} />
        <button type="button" className="clip-open" data-clip-id={clip.clipId} aria-haspopup="dialog" aria-label={`Открыть клип «${clip.motion.label}», ${length}`} onClick={() => onOpen(clip.clipId)}>
          <span className="clip-play">
            <PlayIcon />
          </span>
        </button>
        <div className="clip-badges">
          {!clip.seen && <span className="pill clip-new">новый</span>}
          <FaceBadgeView badge={faceBadge(clip.face)} />
          {used !== null && (
            <span className="pill clip-used" title={used.title}>
              <Icon name="film" size={11} strokeWidth={2.2} />
              {used.label}
            </span>
          )}
        </div>
        <Pills length={length} tags={readyTags(clip)} />
      </div>
      <div className="clip-cap">
        <div className="clip-cap-top">
          <h3 className="clip-name" title={clip.motion.label}>
            {clip.motion.label}
          </h3>
        </div>
        {meta.line !== null && <p className="clip-line">{meta.line}</p>}
        <p className="mono faint clip-meta">{meta.meta}</p>
        {savedExport(clip) !== null && (
          <p className="clip-saved-mark">
            <Icon name="check" size={11} strokeWidth={3} />
            сохранён в папку
          </p>
        )}
      </div>
    </article>
  );
});

export interface WorkTileProps {
  readonly motion: string;
  /** The source photo, when this window knows it (it started the clip). */
  readonly avatarId: string;
  readonly photoId: string | null;
  readonly clip: ClipJobInfo;
  readonly line: PhaseLine;
  readonly done: number;
  readonly total: number;
  /** The length's pill: the request's seconds when known (a restart's recovery of a clip this window did not start knows none). */
  readonly length: string | null;
  readonly money: string | null;
  readonly cancelling: boolean;
  readonly onCancel: (() => void) | null;
  /** 5b.2 (S5.WB4): a batch member's place, the pill «6/10» at the poster's top right («Клип 6 из 10 в пакете»). */
  readonly place?: { readonly index: number; readonly size: number };
  /** 5b.2 (60): a member waiting its turn — calm: no shimmer, no spinner, no step under way; nothing is spent while it waits (README decision 10). */
  readonly waiting?: boolean;
  /** 5b.2 (README decision 13, review L5): the tab's one live region — false for a second clip at work (a member saving its file while the next one prepares). */
  readonly live?: boolean;
}

/** A clip at work (§6 40): the source photo dimmed, the phase with a spinner, the steps, the money that may still go; «Отменить» only before the POST. */
export function WorkTile({ motion, avatarId, photoId, clip, line, done, total, length, money, cancelling, onCancel, place, waiting = false, live = true }: WorkTileProps) {
  const grok = clip.model === "grok";
  return (
    <article className={waiting ? "clip-tile clip-tile-work clip-tile-queued" : "clip-tile clip-tile-work"} aria-label={`${waiting ? "Клип в очереди" : "Клип в работе"}: ${motion}`} aria-busy={waiting ? undefined : "true"}>
      <div className="ph clip-tile-poster">
        {photoId === null ? <PortraitPlaceholder seed={clip.clipId} label={`Кадр клипа «${motion}»`} /> : <Portrait avatarId={avatarId} photoId={photoId} label={`Кадр клипа «${motion}»`} />}
        <span className="clip-dim" />
        {line.tone === "work" && !waiting && <div className="shim" />}
        <div className="clip-badges">
          <span className={`pill clip-state clip-state-${line.tone}`}>{line.pill}</span>
        </div>
        {place !== undefined && (
          <span className="pill mono batch-index" title={`Клип ${place.index} из ${place.size} в пакете`}>
            {place.index}/{place.size}
          </span>
        )}
        <Pills length={length} tags={grok ? ["Grok"] : []} />
      </div>
      <div className="clip-cap">
        <div className="clip-cap-top">
          <h3 className="clip-name" title={motion}>
            {motion}
          </h3>
        </div>
        {waiting ? (
          // Not a live region: only the clip at work speaks (decision 13).
          <p className="clip-phase clip-phase-wait">
            <span className="wait-dot" aria-hidden="true" />
            <span>{line.text}</span>
          </p>
        ) : (
          <p className={line.tone === "warn" ? "clip-phase clip-phase-warn" : line.tone === "quiet" ? "clip-phase clip-phase-quiet" : "clip-phase"} role={live ? "status" : undefined}>
            <span className="spin" aria-hidden="true" />
            <span>{line.text}</span>
          </p>
        )}
        <ClipSteps done={done} total={total} warn={line.tone === "warn"} idle={waiting} />
        {money !== null && <p className="mono faint clip-meta">{money}</p>}
        {line.cancel && onCancel !== null && (
          <div className="clip-actions">
            <button type="button" className="btn btn-s clip-btn" aria-busy={cancelling || undefined} aria-disabled={cancelling || undefined} onClick={() => !cancelling && onCancel()}>
              {cancelling && <Spin />}
              {cancelling ? "Отменяем…" : "Отменить"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export interface FailedTileProps {
  readonly clip: Failed;
  readonly nowMs: number;
  /** The source photo is a frame of «Смелая» kept to Kling (42q). */
  readonly bold: boolean;
  readonly busy: boolean;
  readonly onAgain: (clip: Failed) => void;
  readonly onRedownload: (clip: Failed) => void;
  readonly onGrok: (clip: Failed) => void;
  readonly onRemove: (clip: Failed) => void;
  /** 5b.2 (60 #rate-limit): a batch member's first 429 whose retry is on its way — «…снимем ещё раз в конце пакета.», no «Оживить снова…». */
  readonly batchRetry?: boolean;
}

export function FailedTile({ clip, nowMs, bold, busy, onAgain, onRedownload, onGrok, onRemove, batchRetry = false }: FailedTileProps) {
  const model = failedTile(clip, { nowMs, bold, batchRetry });
  const name = clip.motion.label;
  return (
    <article className={`clip-tile clip-tile-failed clip-fail-${model.tone}`} aria-label={`Клип не получился: ${name}`}>
      <div className="ph clip-tile-poster">
        <Portrait avatarId={clip.avatarId} photoId={clip.photoId} label={`Кадр клипа «${name}»`} />
        <span className="clip-dim clip-dim-strong" />
        <span className="clip-alert" aria-hidden="true">
          <span className="clip-alert-dot">
            <Icon name={model.tone === "free" ? "info" : "alert"} size={18} strokeWidth={2} />
          </span>
        </span>
        <Pills length={clipLength(clip.request.seconds * 1000)} tags={clip.model === "grok" ? ["Grok"] : []} />
      </div>
      <div className="clip-cap">
        <div className="clip-cap-top">
          <h3 className="clip-name" title={name}>
            {name}
          </h3>
          <button type="button" className="ibtn clip-trash" aria-label={`Удалить клип «${name}»`} title="Удалить" aria-disabled={busy || undefined} onClick={() => !busy && onRemove(clip)}>
            {busy ? <Spin /> : <Icon name="trash" size={13} />}
          </button>
        </div>
        <p className="clip-fail-text">{model.text}</p>
        {model.money !== null && <p className="mono faint clip-meta">{model.money}</p>}
        {model.actions.length > 0 && (
          <div className="clip-actions">
            {model.actions.map((action) =>
              action === "again" ? (
                <button key={action} type="button" className="btn btn-s clip-btn" aria-haspopup="dialog" onClick={() => onAgain(clip)}>
                  Оживить снова…
                </button>
              ) : action === "redownload" ? (
                <button key={action} type="button" className="btn btn-s btn-stack clip-btn clip-btn-stack" aria-disabled={busy || undefined} onClick={() => !busy && onRedownload(clip)}>
                  <span className="btn-stack-line">Скачать снова</span>
                  <span className="sr-only"> · </span>
                  <span className="mono">до {model.retryUntil}</span>
                </button>
              ) : (
                <button key={action} type="button" className="btn btn-s btn-stack clip-btn clip-btn-stack" aria-disabled={busy || undefined} onClick={() => !busy && onGrok(clip)}>
                  <span className="btn-stack-line">Снять на Grok</span>
                  <span className="sr-only"> · </span>
                  <span className="mono">до {model.grokWorst}</span>
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * A clip job that ended `job.failed` with no record (plan s5b1 §5.1: a refusal before anything was sent — its reserve refused, the photo's file unreadable): the owner still sees that
 * the clip was not made, and why, in the engine's own words. It has nothing on disk: «Убрать» only puts the tile away in this window.
 */
export function FailedJobTile({ motion, avatarId, photoId, clipId, error, onDismiss }: { motion: string; avatarId: string; photoId: string | null; clipId: string; error: EngineError; onDismiss: () => void }) {
  return (
    <article className="clip-tile clip-tile-failed clip-fail-free" aria-label={`Клип не получился: ${motion}`}>
      <div className="ph clip-tile-poster">
        {photoId === null ? <PortraitPlaceholder seed={clipId} label={`Кадр клипа «${motion}»`} /> : <Portrait avatarId={avatarId} photoId={photoId} label={`Кадр клипа «${motion}»`} />}
        <span className="clip-dim clip-dim-strong" />
        <span className="clip-alert" aria-hidden="true">
          <span className="clip-alert-dot">
            <Icon name="info" size={18} strokeWidth={2} />
          </span>
        </span>
      </div>
      <div className="clip-cap">
        <div className="clip-cap-top">
          <h3 className="clip-name" title={motion}>
            {motion}
          </h3>
          <button type="button" className="ibtn clip-trash" aria-label={`Убрать «${motion}»`} title="Убрать" onClick={onDismiss}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <p className="clip-fail-text">Клип не снят</p>
        <p className="clip-fail-why">{errorText(error)}</p>
      </div>
    </article>
  );
}
