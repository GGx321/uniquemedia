// Regenerates the video fixtures of Stage 3's 3f.3a: `bun --no-env-file studio/engine/media/video/testing/fixtures/generate.ts`.
// They are committed (and pinned by size and sha256 in `index.ts`), because libx265 and prores_ks are not among the encoders the CI
// facts probe (SP3) requires on both platforms: the tests only need the DECODERS, which are. Run this on a machine whose bundled ffmpeg
// has them (the macOS build does), and update `index.ts` with the numbers it prints.
//
// Every clip is a few frames of the 192 x 96 colour chart (`../chart.ts`) or a flat picture, made from raw frames written here, so the
// patch values are exact and nothing depends on a test source filter that differs between ffmpeg builds.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../../../../../node/ffmpegBinary";
import { CHART, chartFrame, HLG_OUT_OF_CUBE_CODES, P3_SDR_CODES } from "../chart";
import { withClaimedSize, withEntryBox, withRotation, withTrackMeta } from "../mp4Patch";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "studio-video-fixtures-"));

function ffmpeg(args: string[], input?: Uint8Array): void {
  const run = spawnSync(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { input, maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
}

const repeat = (frame: Uint8Array, times: number): Uint8Array => {
  const out = new Uint8Array(frame.byteLength * times);
  for (let i = 0; i < times; i++) out.set(frame, i * frame.byteLength);
  return out;
};

/** Seconds -> the presentation time of each frame of the variable-rate clips: 30 fps, then 10 fps, then 30 fps again (units of 1/600 s). */
const VFR_SETPTS = "setpts='(if(lt(N,5),N*20,if(lt(N,9),80+(N-4)*60,320+(N-8)*20)))/(600*TB)'";
const VFR_FRAMES = 14;
const SIZE = `${CHART.width}x${CHART.height}`;

// `bun generate.ts [name ...]` writes only the named fixtures (all of them with no names): an encoder newer than the one that made the committed
// bytes would change the others, and they are pinned.
const only = process.argv.slice(2);
const out: Record<string, string> = {};
const emit = (name: string, from: string): void => {
  if (only.length > 0 && !only.includes(name)) return;
  const bytes = readFileSync(from);
  writeFileSync(join(here, name), bytes);
  out[name] = `${bytes.byteLength} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}`;
};

try {
  mkdirSync(here, { recursive: true });
  const hlg420 = chartFrame({ matrix: "bt2020", bits: 10, chroma: "420" });
  const sdr420 = chartFrame({ matrix: "bt709", bits: 8, chroma: "420" });
  const sdr422 = chartFrame({ matrix: "bt709", bits: 10, chroma: "422" });
  const hlgTags = ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-color_range", "tv"];
  const sdrTags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
  const x265 = (extra = ""): string[] => ["-c:v", "libx265", "-preset", "medium", "-tag:v", "hvc1", "-x265-params", `crf=4:pools=1:frame-threads=1:log-level=error${extra}`];
  const rawIn = (pix: string, rate = "30"): string[] => ["-f", "rawvideo", "-pix_fmt", pix, "-s", SIZE, "-r", rate, "-i", "-"];

  // 1. HEVC HLG, BT.2020, 10-bit: what an iPhone records. moov AFTER mdat (no faststart), so a box can be added to the sample entry.
  ffmpeg([...rawIn("yuv420p10le"), ...x265(), "-pix_fmt", "yuv420p10le", ...hlgTags, "-an", join(work, "hlg.mp4")], repeat(hlg420, 3));
  emit("hevc-hlg-chart.mp4", join(work, "hlg.mp4"));

  // 2. H.264 SDR BT.709 with an AAC track and every kind of metadata a phone writes: the importer must drop all of it.
  ffmpeg(
    [
      ...rawIn("yuv420p"),
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.2",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "4",
      "-x264-params",
      "threads=1",
      "-pix_fmt",
      "yuv420p",
      ...sdrTags,
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-metadata",
      "title=SecretTitle",
      "-metadata",
      "location=+50.4501+030.5234/",
      "-metadata",
      "creation_time=2020-01-02T03:04:05Z",
      "-metadata:s:v:0",
      "handler_name=SecretHandler",
      "-movflags",
      "+use_metadata_tags",
      join(work, "sdr.mp4"),
    ],
    repeat(sdr420, 5),
  );
  emit("h264-sdr-chart.mp4", join(work, "sdr.mp4"));

  // 3. H.264 with timestamps 30 fps, then 10 fps, then 30 fps again (14 frames over 0.733 s).
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=128x72:r=30,trim=end_frame=${VFR_FRAMES},${VFR_SETPTS}`, "-c:v", "libx264", "-crf", "12", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-video_track_timescale", "600", join(work, "vfr.mp4")]);
  emit("h264-vfr.mp4", join(work, "vfr.mp4"));

  // 4. ProRes 422 HQ, 10-bit 4:2:2, QuickTime (its colour box is the older `nclc`).
  ffmpeg([...rawIn("yuv422p10le"), "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le", ...sdrTags, "-an", join(work, "prores.mov")], repeat(sdr422, 3));
  emit("prores-hq-chart.mov", join(work, "prores.mov"));

  // 5. The all-in-one: HEVC HLG, variable rate, turned a quarter turn (an iPhone held upright), QuickTime.
  ffmpeg([...rawIn("yuv420p10le"), "-vf", VFR_SETPTS, ...x265(), "-pix_fmt", "yuv420p10le", ...hlgTags, "-fps_mode", "passthrough", "-video_track_timescale", "600", "-an", join(work, "all.mov")], repeat(hlg420, VFR_FRAMES));
  writeFileSync(join(work, "all-rotated.mov"), withRotation(readFileSync(join(work, "all.mov")), 90));
  emit("hevc-hlg-rotated-vfr.mov", join(work, "all-rotated.mov"));

  // 6. A flat 4096 x 2160 HEVC HLG picture (two frames, a few KB): the largest size the importer takes, to prove a real decode fits the allocation cap.
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=4096x2160:r=30:d=0.0667", "-vf", "format=yuv420p10le", ...x265().slice(0, -1), "crf=24:pools=1:frame-threads=1:log-level=error", "-pix_fmt", "yuv420p10le", ...hlgTags, "-an", join(work, "4k.mp4")]);
  emit("hevc-hlg-flat-4k.mp4", join(work, "4k.mp4"));

  // 7. Two video streams: MPEG-4 Part 2 (a codec the importer does not take) first, H.264 second. The review's track-bypass tests hide the first
  // from the walker by patching its `hdlr` or moving it out of `moov`; ffmpeg still sees it. moov after mdat, so tracks can be moved.
  ffmpeg(["-f", "lavfi", "-i", "color=red:s=320x240:r=30:d=0.2", "-f", "lavfi", "-i", "color=blue:s=64x64:r=30:d=0.2", "-map", "0", "-map", "1", "-c:v:0", "mpeg4", "-c:v:1", "libx264", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", join(work, "two.mp4")]);
  emit("mpeg4-then-h264-two-video-tracks.mp4", join(work, "two.mp4"));

  // 8. H.264 whose bitstream is 4224 x 2176 (9.2 MP, past 4K) while `tkhd` and the sample entry claim 1920 x 1080: the walker is lied to, and
  // `-max_pixels` has to be what stops the decode.
  ffmpeg(["-f", "lavfi", "-i", "color=gray:s=4224x2176:r=30:d=0.1", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", join(work, "big.mp4")]);
  writeFileSync(join(work, "big-claims-1080p.mp4"), withClaimedSize(readFileSync(join(work, "big.mp4")), 1920, 1080));
  emit("h264-sps-4224x2176-claims-1080p.mp4", join(work, "big-claims-1080p.mp4"));

  // 9. Clips trimmed WITHOUT re-encoding (`-c copy`, what an editor that does not re-encode writes): a 10 s clip with a keyframe every 2 s, cut
  // at 0.5, 1.0 and 1.9 s for 3 s. The samples run from the keyframe before the cut, and an edit list (`elst`) cuts into them: `stts` says 3.5,
  // 4.0 and 4.9 s, the picture is 3.0 s. ffmpeg honours the edit.
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=10", "-c:v", "libx264", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-bf", "0", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", join(work, "gop2.mp4")]);
  for (const ss of ["0.5", "1.0", "1.9"]) {
    ffmpeg(["-ss", ss, "-i", join(work, "gop2.mp4"), "-t", "3", "-c", "copy", "-fflags", "+bitexact", join(work, `trim${ss}.mp4`)]);
    emit(`h264-copy-trim-ss${ss}.mp4`, join(work, `trim${ss}.mp4`));
  }

  // 10. B-frames, as x264 and x265 write them to MP4: a `ctts` (composition offsets) and an `elst` whose media time compensates the delay.
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=2", "-c:v", "libx264", "-bf", "3", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", join(work, "bf.mp4")]);
  emit("h264-bframes.mp4", join(work, "bf.mp4"));
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=2", "-c:v", "libx265", "-x265-params", "bframes=4:pools=1:frame-threads=1:log-level=error", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", join(work, "hbf.mp4")]);
  emit("hevc-bframes.mp4", join(work, "hbf.mp4"));

  // 11. A variable-rate clip (a screen recording) whose last frame is HELD for two seconds, re-encoded by x264 with B-frames: the hold lives in the
  // composition times (`ctts`), so the samples (`stts`) say about one second and the picture shows three.
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=1", "-vf", "setpts='if(lt(N,29),N/30,3)/TB'", "-fps_mode", "vfr", "-c:v", "libx264", "-bf", "3", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", join(work, "held.mp4")]);
  emit("h264-vfr-held-last-frame-bframes.mp4", join(work, "held.mp4"));

  // 12. HEVC HLG whose Y'CbCr is OUTSIDE the RGB cube (R'G'B' down to -0.9 and up to 1.6: `HLG_OUT_OF_CUBE_CODES`), lossless so the codes the chain sees
  // are exactly those. The first stage of the HDR chain must clip the signal in 16-bit integers before any transfer function is applied.
  ffmpeg([...rawIn("yuv420p10le"), ...x265().slice(0, -1), "lossless=1:pools=1:frame-threads=1:log-level=error", "-pix_fmt", "yuv420p10le", ...hlgTags, "-an", join(work, "oc.mp4")], repeat(chartFrame({ matrix: "bt2020", bits: 10, chroma: "420", codes: HLG_OUT_OF_CUBE_CODES }), 3));
  emit("hevc-hlg-out-of-cube.mp4", join(work, "oc.mp4"));

  // 13. H.264 SDR in Display P3 (primaries smpte432, sRGB transfer, BT.709 matrix, limited): twelve greys, six colours at the edge of P3's gamut
  // (outside BT.709's: after the primaries conversion one channel of linear light is negative) and six Y'CbCr codes outside the RGB cube.
  const p3Codes = P3_SDR_CODES;
  const p3Tags = ["-color_primaries", "smpte432", "-color_trc", "iec61966-2-1", "-colorspace", "bt709", "-color_range", "tv"];
  ffmpeg([...rawIn("yuv420p"), "-c:v", "libx264", "-preset", "medium", "-crf", "4", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", ...p3Tags, "-an", join(work, "p3.mp4")], repeat(chartFrame({ matrix: "bt709", bits: 8, chroma: "420", codes: p3Codes }), 5));
  emit("h264-p3-saturated.mp4", join(work, "p3.mp4"));

  // 14, 15. What Apple's writer does (review round 5): a 32-bit zero, QuickTime's old list terminator, at the END of the video sample entry. HEVC HLG
  // and H.264 SDR, both in a QuickTime file with moov after mdat. They are real ffmpeg output with four zero bytes added inside the entry (the sizes
  // of the boxes above it grow), because no encoder here writes them; the real Apple files cannot be committed (they are Apple's).
  ffmpeg([...rawIn("yuv420p10le"), ...x265(), "-pix_fmt", "yuv420p10le", ...hlgTags, "-an", "-f", "mov", join(work, "hevc.mov")], repeat(hlg420, 3));
  writeFileSync(join(work, "hevc-term.mov"), withEntryBox(readFileSync(join(work, "hevc.mov")), new Uint8Array(4)));
  emit("hevc-hlg-entry-terminator.mov", join(work, "hevc-term.mov"));
  ffmpeg([...rawIn("yuv420p"), "-c:v", "libx264", "-preset", "medium", "-crf", "4", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", ...sdrTags, "-an", "-f", "mov", join(work, "avc.mov")], repeat(sdr420, 5));
  writeFileSync(join(work, "avc-term.mov"), withEntryBox(readFileSync(join(work, "avc.mov")), new Uint8Array(4)));
  emit("h264-entry-terminator.mov", join(work, "avc-term.mov"));

  // 16. Per-track metadata the way AVFoundation writes it: a `trak/meta` box with an `mdta` handler at the end of the video track. H.264 SDR MP4.
  ffmpeg([...rawIn("yuv420p"), "-c:v", "libx264", "-preset", "medium", "-crf", "4", "-x264-params", "threads=1", "-pix_fmt", "yuv420p", ...sdrTags, "-an", join(work, "plain.mp4")], repeat(sdr420, 5));
  writeFileSync(join(work, "track-meta.mp4"), withTrackMeta(readFileSync(join(work, "plain.mp4")), "mdta"));
  emit("h264-track-meta-mdta.mp4", join(work, "track-meta.mp4"));

  // 17. A coded size an owner's phone would only DISPLAY at an odd one (3f.6 review, round 3): HEVC 4:2:0 crops to even sizes, so Apple writes 459 x 940 in `stsd` and `tkhd` over a
  // bitstream of 460 x 940, and ffmpeg's stream line says 460 x 940. This is the coded 460 x 940 (flat grey, BT.709 SDR, three frames); a test makes the display size by
  // `withClaimedSize` (what Apple's boxes say), which is all that differs.
  const flat460 = new Uint8Array(460 * 940 + 2 * 230 * 470).fill(110);
  ffmpeg(["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "460x940", "-r", "30", "-i", "-", ...x265(), "-pix_fmt", "yuv420p", ...sdrTags, "-an", join(work, "odd.mp4")], repeat(flat460, 3));
  emit("hevc-sdr-460x940.mp4", join(work, "odd.mp4"));

  console.log(JSON.stringify(out, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
