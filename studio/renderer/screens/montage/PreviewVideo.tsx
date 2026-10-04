import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { MontageDraft } from "../../../shared/engine";
import { FPS, type Rect, type Size } from "../../../shared/montage";
import { useEngine } from "../../engine/react";
import { ownVideoUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import type { VideoLookup } from "./ownVideos";
import type { PlayheadStore } from "./playhead";
import { peekTarget, storedFrames, videoCorrection, videoTarget } from "./videoSync";

// 3f.3b: an own video clip in the preview (EditorMine.dc.html's centre, V4). A `<video>` of the clip's mezzanine, the very file the render cuts from, at
// main's `studio-media://media/<mediaId>` (`ownVideoUrl`: the window names an id and never a path): ALWAYS muted (V4: the video's sound is never used),
// cropped exactly as the render crops it (`videoClipCrop` on the record's stored size, the clip's focus), and kept on the playhead's frame by
// videoSync.ts: paused on the exact stored frame at rest and while scrubbing, playing in step while the montage plays (the music's discipline: no
// fighting a seek, no spinning on a refused `play()`, hysteresis). Its pixels are never read (no canvas, no CORS: 3d.4's rule).
//
// Where there is no picture, a stand-in of the same geometry is drawn instead, never a broken element: the dev mock (it stores no video: `ownVideoUrl` is
// null there) gets a poster with the file's name, its stored size and the frame on screen; a video whose record is not known yet gets the bare ground;
// a video the library no longer holds, or one the element cannot open, says so. The ground also sits under the `<video>` until its first frame is drawn.
// The element is keyed by the media (PreviewStage), so the two parts of a split clip play on one element without a reload.

const pct = (value: number, of: number): string => `${(value / of) * 100}%`;

/** The whole stored video placed so the frame shows `window` of it: the render's crop, filling the frame. */
const sourceStyle = (window: Rect, source: Size): CSSProperties => ({
  left: pct(-window.x, window.w),
  top: pct(-window.y, window.h),
  width: pct(source.w, window.w),
  height: pct(source.h, window.h),
});

/** «0:03.6»: a time in the stored video, to the tenth. */
function sourceClock(frame: number): string {
  const tenths = Math.floor((frame * 10) / FPS);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

export interface PreviewVideoProps {
  readonly spec: MontageDraft;
  readonly playhead: PlayheadStore;
  readonly mediaId: string;
  /** What the window knows of the video (its record). */
  readonly video: VideoLookup;
  /** The part of the stored video the frame shows (the render's crop); null until its size is known. */
  readonly window: Rect | null;
  /** The stored video's frame on screen: what the stand-in says. */
  readonly sourceFrame: number;
  /** A frame «Обрезка» is dragging to (fix round 1, L8): shown at rest while the drag lasts, whatever the playhead. */
  readonly peekFrame: number | null;
}

export function PreviewVideo({ spec, playhead, mediaId, video, window, sourceFrame, peekFrame }: PreviewVideoProps) {
  const { client } = useEngine();
  const url = ownVideoUrl(client, mediaId);
  const [failed, setFailed] = useState<string | null>(null);
  const known = video.state === "known" ? video.video : null;
  const source: Size | null = known === null ? null : { w: known.width, h: known.height };
  const placed = window !== null && source !== null ? sourceStyle(window, source) : undefined;
  const playable = url !== null && known !== null && failed !== url;

  return (
    <span className="pv-video-wrap" aria-hidden="true">
      <span className="pv-video-ground" style={placed} />
      {playable ? (
        <VideoElement url={url} spec={spec} playhead={playhead} mediaId={mediaId} frames={storedFrames(known.durationMs)} peekFrame={peekFrame} style={placed} onFail={() => setFailed(url)} />
      ) : video.state === "gone" ? (
        <VideoCard tone="warn" title="Файла больше нет" note="Это видео удалили из «Моих» — уберите этот кадр." />
      ) : failed !== null && failed === url ? (
        <VideoCard tone="warn" title="Видео не открылось" note={known?.name ?? null} />
      ) : (
        known !== null && (
          <VideoCard
            tone="plain"
            title={known.name}
            facts={`${known.width}×${known.height} · ${sourceClock(sourceFrame)}`}
            note="Картинка видео — только в приложении"
          />
        )
      )}
    </span>
  );
}

function VideoCard({ tone, title, facts, note }: { tone: "plain" | "warn"; title: string; facts?: string; note: string | null }) {
  return (
    <span className={tone === "warn" ? "pv-video-card pv-video-card-warn" : "pv-video-card"}>
      <span className="pv-video-badge">
        <Icon name={tone === "warn" ? "alert" : "film"} size={16} />
      </span>
      <span className="pv-video-title">{title}</span>
      {facts !== undefined && <span className="mono pv-video-facts">{facts}</span>}
      {note !== null && <span className="pv-video-note">{note}</span>}
    </span>
  );
}

interface VideoElementProps {
  readonly url: string;
  readonly spec: MontageDraft;
  readonly playhead: PlayheadStore;
  readonly mediaId: string;
  /** The stored video's frames, from its record: a clip asking past them shows the last. */
  readonly frames: number;
  /** A frame «Обрезка» is dragging to (fix round 1, L8): shown at rest instead of the playhead's while it lasts. */
  readonly peekFrame: number | null;
  readonly style: CSSProperties | undefined;
  readonly onFail: () => void;
}

/**
 * The `<video>` itself, kept on the playhead by videoSync.ts on every change of the clock and every `seeked` / `loadedmetadata` of its own. The stage
 * re-renders it on every frame of a playback: what changes then is read through refs, so the element is set up once per file. The effect owns the
 * element's source: it sets it, and on the way out takes it away and loads again, so the decoder is let go at once (fix round 1, L2; and a remount,
 * as React's StrictMode makes, sets it again).
 */
function VideoElement({ url, spec, playhead, mediaId, frames, peekFrame, style, onFail }: VideoElementProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const latest = useRef({ spec, frames, peekFrame, onFail });
  latest.current = { spec, frames, peekFrame, onFail };
  /** The element's sync while it is set up: an edit that moves the clip's frames (a new trim) is shown without the playhead moving. */
  const resync = useRef<(() => void) | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Never a sound: set as properties too (React's `muted` attribute alone is not the property on every engine).
    element.muted = true;
    element.defaultMuted = true;
    element.setAttribute("src", url);
    // An element that failed before anything could hear it (a fast 404, fix round 1, L1) is a stand-in at once; a later failure is `onError`'s.
    if (element.error !== null) {
      latest.current.onFail();
      return;
    }
    /** The element refused to play this file: no more seeks or tries until the file changes, only pauses. */
    let refused = false;
    /** The offset in the video's time the element was put on last (fix round 1, M2): a different one while playing is a jump to seek to. */
    let anchor: number | null = null;
    /** How long the last seek made while playing took, in seconds: the next one is led by as much (a slow decoder, `MAX_SEEK_LEAD_SEC`). */
    let lead = 0;
    let seekStarted: number | null = null;
    /** A led seek is out (fix round 2): the first look after it lands may settle once; a settling seek never arms it again. */
    let armed = false;
    const seeking = (): void => {
      seekStarted = element.paused ? null : performance.now();
    };
    const seeked = (): void => {
      if (seekStarted !== null) lead = (performance.now() - seekStarted) / 1000;
      seekStarted = null;
    };
    const framesOf = (id: string): number | null => (id === mediaId ? latest.current.frames : null);
    const sync = (): void => {
      const { spec: current, peekFrame: peek } = latest.current;
      const onScreen = videoTarget(current, playhead.get(), framesOf);
      // A frame «Обрезка» is dragging to wins over the playhead's, at rest.
      const target = peek === null ? onScreen : peekTarget(onScreen, mediaId, peek);
      // The frame on screen is not this video's (the clip is going): it waits, paused.
      if (target === null || target.mediaId !== mediaId) {
        if (!element.paused) element.pause();
        return;
      }
      // The first look after a led seek has landed may settle it, once.
      const settle = armed && !element.seeking;
      const action = videoCorrection(
        target,
        {
          currentTimeSec: element.currentTime,
          paused: element.paused,
          durationSec: element.duration,
          seeking: element.seeking,
          readyState: element.readyState,
          rate: element.playbackRate,
        },
        anchor,
        lead,
        settle,
      );
      if (settle) armed = false;
      else if (target.play && action.seekSec !== null && lead > 0) armed = true;
      anchor = action.anchorMs;
      if (action.play === false) element.pause();
      if (refused) return;
      if (action.seekSec !== null) element.currentTime = action.seekSec;
      if (element.playbackRate !== action.rate) element.playbackRate = action.rate;
      if (action.play === true) {
        Promise.resolve(element.play()).catch((error: unknown) => {
          // A pause before the start lands (AbortError) is the clock's own doing; anything else is the file.
          if (!(error instanceof DOMException && error.name === "AbortError")) refused = true;
        });
      }
    };
    sync();
    resync.current = sync;
    const stop = playhead.subscribe(sync);
    // A seek that ends, or the file's length and size becoming known, may leave the element short of the frame asked for last. A seek's own time is
    // measured first, so the sync that follows it already leads by it.
    element.addEventListener("seeking", seeking);
    element.addEventListener("seeked", seeked);
    element.addEventListener("seeked", sync);
    element.addEventListener("loadedmetadata", sync);
    return () => {
      resync.current = null;
      stop();
      element.removeEventListener("seeking", seeking);
      element.removeEventListener("seeked", seeked);
      element.removeEventListener("seeked", sync);
      element.removeEventListener("loadedmetadata", sync);
      element.pause();
      // The decoder and the file's ranges are let go now, not when the element is collected.
      element.removeAttribute("src");
      element.load();
    };
  }, [playhead, url, mediaId]);

  // The draft changed (a trim, a reorder, an undo), or «Обрезка» drags to another frame: the frame to show may be another one now.
  useEffect(() => resync.current?.(), [spec, frames, peekFrame]);

  return <video ref={ref} className="pv-video" style={style} muted playsInline preload="auto" disablePictureInPicture tabIndex={-1} onError={() => latest.current.onFail()} />;
}
