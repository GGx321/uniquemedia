import type { Clip } from "../../../shared/engine";
import { clipCellRects, FRAME_H, FRAME_W } from "../../../shared/montage";
import { Icon } from "../../ui/Icon";
import { OwnPortrait, Portrait } from "../../ui/Portrait";

const pct = (value: number, of: number): string => `${(value / of) * 100}%`;

/**
 * A clip as a still frame: its cells where the render puts them (the shared collage geometry, gutters included)
 * with each photo, a scene one or an own one from «Мои» (3-H1), cover-cropped into its cell. The drafts screen's
 * poster (D8) and a video card's; no motion, no focus drag, no layers. An own video clip is a neutral surface: a
 * poster would hold a video decoder per card.
 */
export function ClipPoster({ clip, avatarId, emptyCells = false }: { clip: Clip; avatarId: string; emptyCells?: boolean }) {
  const rects = clipCellRects(clip);
  const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
  return (
    <div className="clip-poster">
      {rects.map((rect, i) => {
        const photo = cells[i]?.photo ?? null;
        return (
          <div
            key={i}
            className="ph clip-poster-cell"
            style={{ left: pct(rect.x, FRAME_W), top: pct(rect.y, FRAME_H), width: pct(rect.w, FRAME_W), height: pct(rect.h, FRAME_H) }}
          >
            {photo?.source === "scene" ? (
              <Portrait avatarId={avatarId} photoId={photo.photoId} label={`Кадр: фото ${i + 1}`} />
            ) : photo?.source === "own" ? (
              <OwnPortrait mediaId={photo.mediaId} label={`Кадр: своё фото ${i + 1}`} />
            ) : clip.kind === "video" ? (
              <div className="clip-poster-own" />
            ) : (
              emptyCells && (
                <div className="clip-poster-empty">
                  <Icon name="plus" size={18} />
                  перетащите фото
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
