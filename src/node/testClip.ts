import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

/** Creates a 2s 320x240 test clip with a 440Hz tone at `path`. */
export function makeTestClip(path: string): void {
  const r = spawnSync(
    ffmpegPath as string,
    [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      path,
    ],
    { encoding: "buffer" }
  );
  if (r.status !== 0) throw new Error("makeTestClip failed: " + r.stderr.toString());
}
