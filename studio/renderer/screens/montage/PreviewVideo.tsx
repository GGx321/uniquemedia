import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { MontageDraft } from "../../../shared/engine";
import { FPS, type Rect, type Size } from "../../../shared/montage";
import { useEngine } from "../../engine/react";
import { ownVideoUrl } from "../../lib/media";
import { Icon } from "../../ui/Icon";
import type { VideoLookup } from "./ownVideos";
import type { PlayheadStore } from "./playhead";
import { storedFrames, videoCorrection, videoTarget } from "./videoSync";

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
}

export function PreviewVideo({ spec, playhead, mediaId, video, window, sourceFrame }: PreviewVideoProps) {
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
        <VideoElement url={url} spec={spec} playhead={playhead} mediaId={mediaId} frames={storedFrames(known.durationMs)} style={placed} onFail={() => setFailed(url)} />
      ) : video.state === "gone" ? (
        <VideoCard tone="warn" title="Файла больше нет" note="Это видео удалили из «Моих» — замените кадр." />
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
  readonly style: CSSProperties | undefined;
  readonly onFail: () => void;
}

/**
 * The `<video>` itself, kept on the playhead by videoSync.ts on every change of the clock and every `seeked` / `loadedmetadata` of its own. The stage
 * re-renders it on every frame of a playback: what changes then is read through refs, so the element is set up once per file.
 */
function VideoElement({ url, spec, playhead, mediaId, frames, style, onFail }: VideoElementProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const latest = useRef({ spec, frames, onFail });
  latest.current = { spec, frames, onFail };
  /** The element's sync while it is set up: an edit that moves the clip's frames (a new trim) is shown without the playhead moving. */
  const resync = useRef<(() => void) | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Never a sound: set as properties too (React's `muted` attribute alone is not the property on every engine).
    element.muted = true;
    element.defaultMuted = true;
    /** The element refused to play this file: no more seeks or tries until the file changes, only pauses. */
    let refused = false;
    const framesOf = (id: string): number | null => (id === mediaId ? latest.current.frames : null);
    const fail = (): void => latest.current.onFail();
    const sync = (): void => {
      const target = videoTarget(latest.current.spec, playhead.get(), framesOf);
      // The frame on screen is not this video's (the clip is going): it waits, paused.
      if (target === null || target.mediaId !== mediaId) {
        if (!element.paused) element.pause();
        return;
      }
      const action = videoCorrection(target, {
        currentTimeSec: element.currentTime,
        paused: element.paused,
        durationSec: element.duration,
        seeking: element.seeking,
        readyState: element.readyState,
        rate: element.playbackRate,
      });
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
    // A seek that ends, or the file's length and size becoming known, may leave the element short of the frame asked for last.
    element.addEventListener("seeked", sync);
    element.addEventListener("loadedmetadata", sync);
    element.addEventListener("error", fail);
    return () => {
      resync.current = null;
      stop();
      element.removeEventListener("seeked", sync);
      element.removeEventListener("loadedmetadata", sync);
      element.removeEventListener("error", fail);
      element.pause();
    };
  }, [playhead, url, mediaId]);

  // The draft changed (a trim, a reorder, an undo): the frame the playhead asks for may be another one now.
  useEffect(() => resync.current?.(), [spec, frames]);

  return <video ref={ref} className="pv-video" src={url} style={style} muted playsInline preload="auto" disablePictureInPicture tabIndex={-1} />;
}
