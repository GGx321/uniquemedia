import type { EngineError, PhotoSummary } from "../../../shared/engine";
import { FACE_GATE_THRESHOLD } from "./shared";

// What a gallery photo shows of its state, wherever it is shown (its tile, the photo viewer): the face score, how a video or
// a render holds it, the owner's reject mark, whether a montage may take it, and what its reject button does.

/**
 * Why a photo cannot be picked for a montage, or null when it can: one photo goes into one video (the owner's Q1),
 * so a photo already in a video or held by a render in flight is not offered, nor a rejected or ineligible one.
 */
export function montagePickRefusal(photo: PhotoSummary): string | null {
  if (photo.rejected) return "Фото отклонено — в монтаж не попадает";
  if (photo.used || photo.usedIn.length > 0) return "Фото уже в видео: одно фото — одно видео";
  if (photo.reserved) return "Фото занято: в рендере или ждёт незавершённое видео";
  if (!photo.eligible) return "Это фото не подходит для видео";
  return null;
}

/** A mark the engine refused: on which photo, and why. */
export interface MarkFailure {
  readonly photoId: string;
  readonly error: EngineError;
}

/** The owner's own «do not use» mark (3e.2): what the tile's button does, and why it cannot when it cannot. */
export interface MarkControl {
  /** Photos whose mark is being set now. */
  readonly marking: ReadonlySet<string>;
  /** Why no mark can be set right now (the marks themselves cannot be read), or null. */
  readonly blocked: string | null;
  /** The last mark the engine refused, until the next one is asked or the notice is closed; null when there is none. */
  readonly failure: MarkFailure | null;
  readonly onMark: (photo: PhotoSummary, rejected: boolean) => void;
}

/** How a video or a render holds the photo (one photo, one video, Q1): «в 2 видео», «в видео», «занято» (a render holds it, or an unfinished video does), or null. */
export function heldLabel(photo: PhotoSummary): string | null {
  const inVideos = photo.usedIn.length;
  return inVideos > 0 ? `в ${inVideos} видео` : photo.used ? "в видео" : photo.reserved ? "занято" : null;
}

/** "лицо 0.86": the similarity to the master portrait, rounded to what the badge shows. */
function faceLabel(faceCos: number): string {
  return `лицо ${faceCos.toFixed(2)}`;
}

/**
 * The photo's badges: its face score (or «лицо не проверялось»), how it is held, and the reject mark. The caller places
 * them (a column over the tile, a row in the viewer).
 */
export function PhotoBadges({ photo }: { photo: PhotoSummary }) {
  const faceCos = photo.qa?.faceCos;
  // Compared on the same rounded value the badge displays (L2): a raw score
  // just under the line that rounds up to the line itself (0.549 shows
  // «0.55») must read the same as the line, never as low.
  const low = faceCos !== undefined && Number(faceCos.toFixed(2)) < FACE_GATE_THRESHOLD;
  const held = heldLabel(photo);
  return (
    <>
      {faceCos !== undefined ? (
        <span className={low ? "pill mono photo-badge photo-face photo-face-low" : "pill mono photo-badge photo-face"}>{faceLabel(faceCos)}</span>
      ) : (
        <span className="pill mono photo-badge photo-face-none">лицо не проверялось</span>
      )}
      {held !== null && <span className="pill mono photo-badge photo-held">{held}</span>}
      {photo.rejected && <span className="pill mono photo-badge photo-rejected">отклонено</span>}
    </>
  );
}
