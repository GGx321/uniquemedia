import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import ffmpegPath from "ffmpeg-static";

function ffmpeg(label: string, args: string[]): void {
  const r = spawnSync(ffmpegPath as string, args, { encoding: "buffer" });
  if (r.status !== 0) throw new Error(`${label} failed: ` + r.stderr.toString());
}

/** Creates a 320x240 test clip with a 440Hz tone at `path`, 2 s long unless
 *  `durationSec` says otherwise. */
export function makeTestClip(path: string, durationSec = 2): void {
  ffmpeg("makeTestClip", [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${durationSec}:size=320x240:rate=15`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    path,
  ]);
}

/** Same clip with no audio track — the case where "has an audio stream" cannot
 *  be what tells video apart from a still. */
export function makeSilentTestClip(path: string): void {
  ffmpeg("makeSilentTestClip", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
    path,
  ]);
}

/**
 * Creates a single-frame still at `path`. The container follows the extension
 * (`.jpg` -> mjpeg, `.png` -> png).
 *
 * `mandelbrot` rather than a flat pattern because PDQ is close to invariant
 * under tone and noise on detailed content: a smooth test image would make the
 * photo recipe look far more effective than it is. lavfi generates it from a
 * closed-form formula, so the same size always yields byte-identical output.
 */
export function makeTestPhoto(path: string, width = 640, height = 480): void {
  ffmpeg("makeTestPhoto", [
    "-y",
    "-f", "lavfi", "-i", `mandelbrot=size=${width}x${height}`,
    "-frames:v", "1", "-q:v", "2",
    path,
  ]);
}

/**
 * Positions of the four marks `makeTestStory` places near the frame edges, as
 * fractions of the frame. Exported so a test can ask whether they survived a
 * render without re-deriving them from the ffmpeg command.
 */
export const STORY_EDGE_MARKS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 32 / 1080, y: 960 / 1920 }, // left
  { x: 1048 / 1080, y: 960 / 1920 }, // right
  { x: 540 / 1080, y: 32 / 1920 }, // top
  { x: 540 / 1080, y: 1888 / 1920 }, // bottom
];

/**
 * Creates a story-shaped still: bright marks on pure black, with content that
 * runs to the frame edge, plus a detailed block in the middle for the hash to
 * work on.
 *
 * This is the shape the crop recipe was measured to damage — a 1080x1920 story
 * whose graphics sit at the edges, where a 4% off-centre crop window takes a
 * whole glyph off one side. The four marks sit inside that band, at the middle
 * of each side rather than in a corner so the vignette cannot dim them below a
 * threshold, and far enough from the centre block that a search around them
 * cannot mistake it for one of them.
 *
 * PNG rather than JPEG, in RGB: the background has to be exactly 0, which is
 * what makes it useful for checking that nothing lifts pure black, and lavfi's
 * `color` source is limited-range YUV (black = 16) unless the chain is taken
 * into RGB first.
 */
export function makeTestStory(path: string, width = 1080, height = 1920): void {
  const sx = (v: number) => Math.round((v / 1080) * width);
  const sy = (v: number) => Math.round((v / 1920) * height);
  const box = (x: number, y: number, w: number, h: number) =>
    `drawbox=x=${sx(x)}:y=${sy(y)}:w=${sx(w)}:h=${sy(h)}:color=white:t=fill`;
  const centre = Math.round(Math.min(width, height) * 0.55);
  ffmpeg("makeTestStory", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}`,
    "-f", "lavfi", "-i", `mandelbrot=size=${centre}x${centre}`,
    "-filter_complex",
    [
      "[0]format=rgb24[bg]",
      "[1]format=rgb24[fg]",
      `[bg][fg]overlay=${Math.round((width - centre) / 2)}:${Math.round((height - centre) / 2)},` +
        [
          box(20, 900, 24, 120), // left edge
          box(1036, 900, 24, 120), // right edge
          box(480, 20, 120, 24), // top edge
          box(480, 1876, 120, 24), // bottom edge
        ].join(","),
    ].join(";"),
    "-frames:v", "1", "-pix_fmt", "rgb24",
    path,
  ]);
}

/**
 * Writes a file carrying a genuine HEIF `ftyp` box (major brand `heic`, the
 * same compatible-brand list an iPhone capture carries). The bundled ffmpeg has
 * no HEIF demuxer, so nothing downstream can read past this header anyway — the
 * header is the entire input to kind detection, and a full HEIF payload would
 * test nothing extra while making the fixture platform-dependent.
 */
export function makeTestHeif(path: string): void {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size: 24
    Buffer.from("ftyp", "latin1"),
    Buffer.from("heic", "latin1"), // major brand
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // minor version
    Buffer.from("mif1", "latin1"), // compatible brands
  ]);
  writeFileSync(path, Buffer.concat([ftyp, Buffer.alloc(64)]));
}
