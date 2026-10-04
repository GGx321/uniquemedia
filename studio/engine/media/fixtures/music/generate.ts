// Makes the music fixtures of the own-music importer (Stage 3, 3f.4) with the BUNDLED ffmpeg, from sine tones and a flat colour: no third-party audio,
// nothing downloaded. Run it with `bun studio/engine/media/fixtures/music/generate.ts` (it needs an ffmpeg with libmp3lame, libvorbis and libopus,
// which the macOS build in `ffmpeg-static` has; the committed files are what the tests read, so no CI machine needs those encoders).
//
// The output is deterministic: every command carries `-fflags +bitexact` (no encoder string, a fixed Ogg serial), `-map_metadata -1` and fixed
// seeds, and `index.ts` pins each file's size and sha256 (`fixtures.test.ts` checks them). A new encoder build may change a byte: regenerate,
// read the diff in `index.ts`, and say why in the commit.
//
// Every file is a few KB: a 0.3 to 0.6 second tone, in the shape its name says.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../../../../node/ffmpegBinary";

const here = dirname(fileURLToPath(import.meta.url));
const COMMON = ["-hide_banner", "-y", "-v", "error", "-nostdin"];
const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-flags:v", "+bitexact"];

const sine = (hz: number, rate: number, seconds: number): string[] => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=${rate}:duration=${seconds}`];

function ffmpeg(args: readonly string[]): void {
  const run = spawnSync(ffmpegPath(), [...COMMON, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${run.stderr}`);
}

interface Entry {
  readonly file: string;
  /** Makes the file at `out`; `scratch` is a folder for the parts it is made of. */
  readonly make: (out: string, scratch: string) => void;
}

/** An 8x8 red JPEG, the cover art of the tagged files. */
function cover(scratch: string): string {
  const path = join(scratch, "cover.jpg");
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=16x16:d=1", "-frames:v", "1", "-flags:v", "+bitexact", path]);
  return path;
}

export const ENTRIES: readonly Entry[] = [
  { file: "tone.mp3", make: (out) => ffmpeg([...sine(440, 44100, 0.6), "-ac", "2", "-c:a", "libmp3lame", "-b:a", "48k", ...BITEXACT, out]) },
  { file: "tone.m4a", make: (out) => ffmpeg([...sine(440, 44100, 0.6), "-ac", "2", "-c:a", "aac", "-b:a", "48k", ...BITEXACT, "-f", "ipod", out]) },
  { file: "tone.aac", make: (out) => ffmpeg([...sine(440, 44100, 0.6), "-ac", "2", "-c:a", "aac", "-b:a", "48k", ...BITEXACT, "-f", "adts", out]) },
  { file: "tone.wav", make: (out) => ffmpeg([...sine(440, 8000, 0.6), "-ac", "1", "-c:a", "pcm_s16le", ...BITEXACT, out]) },
  { file: "tone.flac", make: (out) => ffmpeg([...sine(440, 8000, 0.3), "-ac", "1", "-c:a", "flac", ...BITEXACT, out]) },
  { file: "tone.alac.m4a", make: (out) => ffmpeg([...sine(440, 22050, 0.4), "-ac", "2", "-c:a", "alac", ...BITEXACT, "-f", "ipod", out]) },
  { file: "tone.ogg", make: (out) => ffmpeg([...sine(440, 44100, 0.6), "-ac", "2", "-c:a", "libvorbis", "-q:a", "0", ...BITEXACT, out]) },
  { file: "tone.opus", make: (out) => ffmpeg([...sine(440, 48000, 0.6), "-ac", "2", "-c:a", "libopus", "-b:a", "32k", ...BITEXACT, out]) },
  // A music-only MP4 (brand `isom`, not `M4A `): the sniff cannot tell it from a video, the importer settles it from the streams.
  { file: "tone.isom.mp4", make: (out) => ffmpeg([...sine(440, 44100, 0.6), "-ac", "2", "-c:a", "aac", "-b:a", "48k", ...BITEXACT, "-f", "mp4", out]) },
  // The other shapes a source takes: 5.1 and 24-bit samples.
  { file: "surround.flac", make: (out) => ffmpeg([...sine(440, 8000, 0.15), "-af", "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0", "-c:a", "flac", ...BITEXACT, out]) },
  { file: "tone24.wav", make: (out) => ffmpeg([...sine(440, 8000, 0.3), "-ac", "1", "-c:a", "pcm_s24le", ...BITEXACT, out]) },
  // Tags and cover art: the values must not survive an import.
  {
    file: "tagged-cover.mp3",
    make: (out, scratch) =>
      ffmpeg([...sine(440, 44100, 0.6), "-i", cover(scratch), "-map", "0:a", "-map", "1:v", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "48k", "-c:v", "copy", "-id3v2_version", "3", "-metadata", "title=SecretTitle-XYZ-1234", "-metadata", "artist=SecretArtist-XYZ-5678", "-metadata:s:v", "title=Album cover", "-disposition:v", "attached_pic", "-fflags", "+bitexact", "-flags:a", "+bitexact", out]),
  },
  {
    file: "tagged-cover.m4a",
    make: (out, scratch) =>
      ffmpeg([...sine(440, 44100, 0.6), "-i", cover(scratch), "-map", "0:a", "-map", "1:v", "-ac", "2", "-c:a", "aac", "-b:a", "48k", "-c:v", "copy", "-disposition:v", "attached_pic", "-metadata", "title=SecretTitle-XYZ-1234", "-metadata", "artist=SecretArtist-XYZ-5678", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "ipod", out]),
  },
  // Not music: an M4A that holds a real video stream beside the audio, and a WAV in a codec the importer does not take.
  {
    file: "m4a-with-video.m4a",
    make: (out) => ffmpeg([...sine(440, 44100, 0.4), "-f", "lavfi", "-i", "testsrc=s=32x32:r=5:d=0.4", "-map", "0:a", "-map", "1:v", "-ac", "2", "-c:a", "aac", "-b:a", "48k", "-c:v", "mpeg4", "-q:v", "10", ...BITEXACT, "-brand", "M4A ", "-f", "ipod", out]),
  },
  { file: "adpcm.wav", make: (out) => ffmpeg([...sine(440, 8000, 0.3), "-ac", "1", "-c:a", "adpcm_ms", ...BITEXACT, out]) },
];

export function generate(into: string = here): Record<string, { bytes: number; sha256: string }> {
  mkdirSync(into, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "studio-music-fixtures-"));
  const made: Record<string, { bytes: number; sha256: string }> = {};
  try {
    for (const entry of ENTRIES) {
      const out = join(into, entry.file);
      entry.make(out, scratch);
      const bytes = readFileSync(out);
      made[entry.file] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return made;
}

if (import.meta.main) {
  const made = generate();
  for (const [file, { bytes, sha256 }] of Object.entries(made)) console.log(`${file.padEnd(22)} ${String(bytes).padStart(7)}  ${sha256}`);
}
