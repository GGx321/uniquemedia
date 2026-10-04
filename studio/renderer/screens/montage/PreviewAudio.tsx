import { useEffect, useRef } from "react";
import type { MontageDraft } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { ownTrackUrl, trackUrl } from "../../lib/media";
import { audioCorrection, audioTarget } from "./audioSync";
import { totalMs } from "./clipOps";
import type { PlayheadStore } from "./playhead";

// 3d.4: the montage's music in the preview: an `<audio>` element of the stored track (main's `studio-media://track/<id>`), played
// from `music.startMs` and kept in step with the playhead clock on every frame (audioSync.ts: nudged by its rate when a little
// off, moved when far off). An own track (3f.4) is the same element at main's `studio-media://media/<mediaId>`: main resolves the id through the
// media's record and serves the file with byte ranges, so the window sends an id and never a path. The dev mock stores no audio, so its preview is silent.

export function PreviewAudio({ spec, playhead }: { spec: MontageDraft; playhead: PlayheadStore }) {
  const { client } = useEngine();
  const music = spec.music;
  const src = music === null ? null : music.source === "trending" ? trackUrl(client, music.trackId) : ownTrackUrl(client, music.mediaId);
  const audio = useRef<HTMLAudioElement>(null);
  const latest = useRef({ music, total: totalMs(spec) });
  latest.current = { music, total: totalMs(spec) };

  useEffect(() => {
    const element = audio.current;
    if (element === null || src === null) return;
    /** The element refused to play this file (no decoder for it): no more seeks or tries until the track changes, only pauses. */
    let refused = false;
    const sync = (): void => {
      const { music: now, total } = latest.current;
      const action = audioCorrection(audioTarget(playhead.get(), now, total), {
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
    const stop = playhead.subscribe(sync);
    return () => {
      stop();
      element.pause();
    };
  }, [playhead, src]);

  if (src === null) return null;
  return <audio ref={audio} className="pv-audio" src={src} preload="auto" />;
}
