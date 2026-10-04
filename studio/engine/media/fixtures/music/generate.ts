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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../../../../node/ffmpegBinary";

const here = dirname(fileURLToPath(import.meta.url));
const COMMON = ["-hide_banner", "-y", "-v", "error", "-nostdin"];
const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-flags:v", "+bitexact"];

/** The language of stream 0 that closes the stream line's own parenthesis and opens a second, forged one: `Stream #0:0(x): Video: png (attached pic): Audio: ...`. */
const SPOOF_LANGUAGE = ["-metadata:s:a:0", "language=x): Video: png (attached pic"];

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

const CONTAINERS: ReadonlySet<string> = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/**
 * The m4a with its time-to-sample table rewritten: every sample but the last lasts 1 tick, and the last lasts `tailSeconds`. The file's sample data is
 * untouched; only what the container SAYS about when each sample plays is a lie.
 */
export function lieAboutTimestamps(file: Uint8Array, tailSeconds: number): Uint8Array {
  const bytes = Uint8Array.from(file);
  const view = new DataView(bytes.buffer);
  const text = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  let mediaScale = 0;
  let movieScale = 0;
  let patched = false;
  const durations: { at: number; scale: "movie" | "media" }[] = [];
  const walk = (start: number, end: number): void => {
    for (let at = start; at + 8 <= end; ) {
      const size = view.getUint32(at);
      const type = text(at + 4);
      if (size < 8) return;
      if (type === "mvhd") {
        movieScale = view.getUint32(at + 20);
        durations.push({ at: at + 24, scale: "movie" });
      }
      if (type === "tkhd") durations.push({ at: at + 28, scale: "movie" });
      if (type === "mdhd") {
        mediaScale = view.getUint32(at + 20);
        durations.push({ at: at + 24, scale: "media" });
      }
      // The edit list would cut the lie off; as a `free` box it says nothing.
      if (type === "edts") bytes.set([0x66, 0x72, 0x65, 0x65], at + 4);
      if (CONTAINERS.has(type)) walk(at + 8, at + size);
      if (type === "stts") {
        const runs = view.getUint32(at + 12);
        let samples = 0;
        for (let i = 0; i < runs; i++) samples += view.getUint32(at + 16 + i * 8);
        view.setUint32(at + 12, 2);
        view.setUint32(at + 16, samples - 1);
        view.setUint32(at + 20, 1);
        view.setUint32(at + 24, 1);
        view.setUint32(at + 28, Math.round(tailSeconds * mediaScale));
        patched = true;
      }
      at += size;
    }
  };
  walk(0, bytes.length);
  if (!patched || mediaScale === 0 || movieScale === 0) throw new Error("no stts to lie about");
  for (const { at, scale } of durations) view.setUint32(at, Math.round(tailSeconds * (scale === "movie" ? movieScale : mediaScale)));
  return bytes;
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
  // An mp3 with NO Xing/LAME header (3f.4 review L4): a decoder cannot know the encoder's delay, so it emits about 1105 samples of priming (138 ms at 8 kHz)
  // before the tone. 111 frames of 576 samples at 8 kHz are 7.992 s of audio, which decodes as about 8.13 s.
  { file: "nolame-8k.mp3", make: (out) => ffmpeg([...sine(440, 8000, 7.99), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "16k", "-write_xing", "0", ...BITEXACT, out]) },
  // An m4a whose timestamps LIE (3f.4 review M1): twelve seconds of audio, but every `stts` delta is 1 tick except the last, which is 602 s. The header says ten
  // minutes and two seconds, every sample but the last sits at a timestamp near 0, and so an input `-t` never fires: only a count of samples bounds the work.
  { file: "stts-lie.m4a", make: (out) => {
      ffmpeg([...sine(440, 8000, 12), "-ac", "1", "-c:a", "aac", "-b:a", "8k", ...BITEXACT, "-f", "ipod", out]);
      writeFileSync(out, lieAboutTimestamps(readFileSync(out), 602));
    } },
  // Spoofs of the probe's reading (3f.4 review H1): an Ogg stream's language comes from the FILE's own comment and ffmpeg prints it verbatim, so a language of
  // `x): Video: png (attached pic` makes stream 0's line read as a cover picture. Stream 0 is a 440 Hz tone, the stream behind it a 3000 Hz one (or a real
  // Theora video), so a test can tell which one an import decoded.
  { file: "spoof-two-vorbis.ogg", make: (out) => ffmpeg([...sine(440, 44100, 0.4), ...sine(3000, 44100, 0.4), "-map", "0:a", "-map", "1:a", "-ac", "1", "-c:a", "libvorbis", "-q:a", "0", ...SPOOF_LANGUAGE, ...BITEXACT, out]) },
  { file: "spoof-two-opus.opus", make: (out) => ffmpeg([...sine(440, 48000, 0.4), ...sine(3000, 48000, 0.4), "-map", "0:a", "-map", "1:a", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", ...SPOOF_LANGUAGE, ...BITEXACT, out]) },
  { file: "spoof-theora.ogg", make: (out) => ffmpeg([...sine(440, 44100, 0.4), "-f", "lavfi", "-i", "testsrc=s=64x64:r=5:d=0.4", "-map", "0:a", "-map", "1:v", "-ac", "1", "-c:a", "libvorbis", "-q:a", "0", "-c:v", "libtheora", "-q:v", "3", ...SPOOF_LANGUAGE, ...BITEXACT, out]) },
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
