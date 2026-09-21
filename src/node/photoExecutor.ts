import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { exiftool } from "exiftool-vendored";
import { buildPhotoArgs } from "../core/photo/filterGraph";
import { edgePadColor } from "../core/photo/edges";
import { parseFfprobeJson } from "./ffprobeJson";
import type { RenderExecutor } from "../core/executor";
import type { IdentityMode, MediaInfo } from "../core/types";
import type { PhotoRecipe } from "../core/photo/types";
import type { DeviceProfile } from "../core/deviceProfile";

/** `ffmpeg-static` resolves to null when it ships no binary for the running
 *  platform, so this is a real failure mode rather than a type technicality —
 *  see the known missing arm64 ffprobe under bun. Failing here names the cause;
 *  casting the null away would surface it later as an unreadable spawn error. */
function resolveBinary(path: string | null, pkg: string): string {
  if (!path) throw new Error(`${pkg} resolved no binary for this platform.`);
  // Electron cannot execute a binary from inside the asar archive.
  return path.replace("app.asar", "app.asar.unpacked");
}

const FFMPEG = resolveBinary(ffmpegPath, "ffmpeg-static");
const FFPROBE = resolveBinary(ffprobeStatic.path, "ffprobe-static");

const GRAY_FRAME_BYTES = 64 * 64;
const RGB_FRAME_BYTES = 64 * 64 * 3;

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`))
    );
  });
}

/** "2026-06-05T13:06:22-0800" -> EXIF's own date form plus its offset form.
 *  Throws rather than guessing: a half-parsed timestamp would silently write a
 *  capture date that disagrees with the location beside it. */
function splitLocalStamp(creationLocal: string): { date: string; offset: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})([+-])(\d{2})(\d{2})$/.exec(creationLocal);
  if (!m) throw new Error(`Unrecognised profile timestamp: ${creationLocal}`);
  const [, year, month, day, time, sign, tzHour, tzMinute] = m;
  return {
    date: `${year}:${month}:${day} ${time}`, // EXIF uses colons in the date part
    offset: `${sign}${tzHour}:${tzMinute}`,
  };
}

/** FNV-1a. Used only to derive stable filler from a profile, never for hashing
 *  that anything depends on. */
function digest(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/** EXIF SubSecTime is 3 digits on an iPhone, not 6. The profile's timestamp has
 *  whole seconds by construction, so the fraction is derived from it — same
 *  profile, same sub-second, and no extra draw added to the generator. */
function subSecond(profile: DeviceProfile): string {
  return String(digest(`subsec:${profile.creationLocal}:${profile.model}`) % 1000).padStart(3, "0");
}

/** The profile carries no elevation — its ISO6709 string pins altitude at 0 for
 *  the video path. A flat 0 m is itself a tell, so a plausible ground elevation
 *  is derived deterministically from the same profile. */
function altitudeMetres(profile: DeviceProfile): number {
  return Math.round((2 + (digest(`alt:${profile.creationLocal}:${profile.model}`) % 2981) / 10) * 10) / 10;
}

/**
 * Still-image backend. Same shape as `FfmpegExecutor`, minus everything that
 * only exists because video has a time axis.
 */
export class PhotoExecutor implements RenderExecutor<PhotoRecipe> {
  private active = new Map<ReturnType<typeof spawn>, string>(); // child -> output path

  /** Same contract as `FfmpegExecutor.cancel`: the path removed is the one
   *  the child was writing, and during the post-pass that is a staged sibling,
   *  never a copy already reported done. */
  cancel(): void {
    for (const [child, out] of this.active) {
      child.kill("SIGKILL");
      try { rmSync(out, { force: true }); } catch { /* ignore */ }
    }
    this.active.clear();
  }

  /** See `FfmpegExecutor.replace`. */
  async replace(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async discard(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /**
   * A still has no time axis and no sound, so `durationSec` is 0 and `hasAudio`
   * false by construction rather than by measurement — ffprobe's image2 demuxer
   * reports a nominal 0.04s (one frame at 25fps), which is an artefact of the
   * demuxer and not a property of the image.
   */
  async probe(input: string): Promise<MediaInfo> {
    let stdout: string;
    try {
      stdout = (
        await run(FFPROBE, [
          "-v", "error", "-print_format", "json", "-show_streams", input,
        ])
      ).toString();
    } catch (err) {
      throw new Error(
        `Cannot probe ${input}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const video = parseFfprobeJson(stdout).streams.find((s) => s.codecType === "video");
    if (!video || video.width === null || video.height === null) {
      throw new Error(`Cannot probe ${input}: no image stream with usable dimensions.`);
    }
    return {
      kind: "photo",
      durationSec: 0,
      width: video.width,
      height: video.height,
      hasAudio: false,
    };
  }

  /**
   * One ffmpeg invocation, one frame out. `-frames:v 1` is the executor's
   * concern rather than the filter graph's: it pins the output to a single
   * image, which is what stops an animated source (a multi-frame WebP, say)
   * from being treated as an image sequence.
   *
   * There is no progress stream to sample — the render is a single shot — so
   * the contract is one `onProgress(1)` on success and none on failure.
   */
  render(
    input: string,
    info: MediaInfo,
    recipe: PhotoRecipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    const args = ["-y", "-i", input, ...buildPhotoArgs(recipe, info), "-frames:v", "1", output];

    return new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG, args);
      this.active.set(child, output);
      const err: Buffer[] = [];
      child.stderr.on("data", (d) => err.push(d));
      child.on("error", (e) => { this.active.delete(child); reject(e); });
      child.on("close", (code) => {
        this.active.delete(child);
        if (code === 0) {
          onProgress?.(1);
          resolve();
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
        }
      });
    });
  }

  /**
   * Always returns exactly ONE frame, whatever `count` asks for: a still has a
   * single frame, and handing the pipeline N copies of it would inflate the
   * verification metric with N identical comparisons rather than measure
   * anything extra. `count` is kept only to satisfy `RenderExecutor`; configure
   * the pipeline with `framesPerCopy: 1` so the two agree.
   */
  async extractGrayFrames(input: string, _count: number): Promise<Uint8Array[]> {
    const buf = await run(FFMPEG, [
      "-i", input, "-frames:v", "1",
      "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "-",
    ]);
    if (buf.length < GRAY_FRAME_BYTES) {
      throw new Error(
        `extractGrayFrames: expected ${GRAY_FRAME_BYTES} bytes from ${input}, got ${buf.length}`
      );
    }
    return [new Uint8Array(buf.subarray(0, GRAY_FRAME_BYTES))];
  }

  /**
   * The colour `fitpad` should fill its margin with, read off the image.
   *
   * A second decode, so a batch pays for it once and only when it is going to
   * pad at all — the route calls this before sampling, not per copy. 64x64
   * rather than the 8x8 first proposed: on a 1080-wide story each 8x8 pixel
   * averages 135 px of width, which mixes the graphics that touch the edge into
   * the background and turned a pure-black border into a dark olive one.
   */
  async sampleEdgeColor(input: string): Promise<string> {
    const buf = await run(FFMPEG, [
      "-i", input, "-frames:v", "1",
      "-vf", "scale=64:64,format=rgb24", "-f", "rawvideo", "-",
    ]);
    if (buf.length < RGB_FRAME_BYTES) {
      throw new Error(
        `sampleEdgeColor: expected ${RGB_FRAME_BYTES} bytes from ${input}, got ${buf.length}`
      );
    }
    return edgePadColor(new Uint8Array(buf.subarray(0, RGB_FRAME_BYTES)));
  }

  async extractThumbnail(input: string): Promise<string> {
    const buf = await run(FFMPEG, [
      "-i", input, "-frames:v", "1",
      "-vf", "scale=-2:180", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
    ]);
    return "data:image/jpeg;base64," + buf.toString("base64");
  }

  /**
   * Pays the first-spawn cost of the two static binaries up front — on macOS
   * that includes Gatekeeper verifying an unsigned executable, which is seconds
   * the user would otherwise wait for on their first Run. `allSettled`, not
   * `all`: a host calls this at startup and discards the result, so a warmup
   * that rejected would surface as an unhandled rejection and tell no one
   * anything the first real render would not report better.
   */
  async warmup(): Promise<void> {
    await Promise.allSettled([
      run(FFMPEG, ["-version"]),
      run(FFPROBE, ["-version"]),
    ]);
  }

  /**
   * What each identity mode does to a rendered still. The graph has already
   * stripped the source's metadata (`-map_metadata -1`); what is left is what
   * ffmpeg's mjpeg encoder adds of its own — a JFIF APP0 segment and a
   * `Lavc<ver>` comment:
   *
   *  - `engine`: nothing. Both stay.
   *  - `iphone`: the EXIF identity of the profile's handset; the comment goes,
   *    in `applyDeviceMetadata`.
   *  - `clean`: the JFIF segment and the comment go and nothing is added, so
   *    the file is DQT/DHT/SOF/SOS and the scan. The spec's verified recipe;
   *    the output still decodes because none of that is needed to decode.
   */
  async applyIdentity(output: string, identity: IdentityMode, profile: DeviceProfile): Promise<void> {
    if (identity === "iphone") {
      await this.applyDeviceMetadata(output, profile);
    } else if (identity === "clean") {
      await exiftool.write(output, {}, { writeArgs: ["-JFIF:all=", "-Comment=", "-overwrite_original"] });
    }
  }

  /**
   * Writes the iPhone EXIF identity onto an already-rendered still.
   *
   * Tag values go through exiftool's raw-write form (`-Tag#=value`) wherever the
   * tag has a PrintConv table. Without the `#`, exiftool tries to parse the
   * number as a human-readable label: `-EXIF:Orientation=1` was measured to
   * store 3 ("Rotate 180"), and ExposureProgram/WhiteBalance/MeteringMode/Flash
   * were dropped outright with a "not in PrintConv" warning.
   */
  async applyDeviceMetadata(output: string, profile: DeviceProfile): Promise<void> {
    const { date, offset } = splitLocalStamp(profile.creationLocal);
    const { camera, exposure } = profile;
    const subSec = subSecond(profile);

    // APEX encodings are COMPUTED from the values beside them, never stored on
    // the profile, so the pair can never drift apart.
    const apertureValue = 2 * Math.log2(camera.fNumber);
    const shutterSpeedValue = -Math.log2(exposure.exposureTimeSec);

    const writeArgs = [
      `-EXIF:Make=${profile.make}`,
      `-EXIF:Model=${profile.model}`,
      // Present straight out of the Camera app, and a duplicate of Model. Its
      // absence is as much a tell as a wrong value.
      `-EXIF:HostComputer=${profile.model}`,
      `-EXIF:Software=${profile.software}`,

      `-EXIF:DateTimeOriginal=${date}`,
      `-EXIF:CreateDate=${date}`,
      `-EXIF:ModifyDate=${date}`,
      `-EXIF:OffsetTime=${offset}`,
      `-EXIF:OffsetTimeOriginal=${offset}`,
      `-EXIF:OffsetTimeDigitized=${offset}`,
      `-EXIF:SubSecTimeOriginal=${subSec}`,
      `-EXIF:SubSecTimeDigitized=${subSec}`,

      // EXIF stores an unsigned magnitude plus a hemisphere Ref.
      `-EXIF:GPSLatitude=${Math.abs(profile.lat)}`,
      `-EXIF:GPSLatitudeRef=${profile.lat >= 0 ? "N" : "S"}`,
      `-EXIF:GPSLongitude=${Math.abs(profile.lon)}`,
      `-EXIF:GPSLongitudeRef=${profile.lon >= 0 ? "E" : "W"}`,
      `-EXIF:GPSAltitude=${altitudeMetres(profile)}`,
      `-EXIF:GPSAltitudeRef#=0`, // above sea level

      `-EXIF:LensMake=Apple`,
      `-EXIF:LensModel=${camera.lensModel}`,
      `-EXIF:FocalLength=${camera.focalMm}`,
      `-EXIF:FocalLengthIn35mmFormat=${camera.focal35}`,
      `-EXIF:FNumber=${camera.fNumber}`,
      `-EXIF:ApertureValue=${apertureValue}`,
      `-EXIF:ExposureTime=${exposure.exposureTimeSec}`,
      `-EXIF:ShutterSpeedValue=${shutterSpeedValue}`,
      `-EXIF:ISO=${exposure.isoSpeed}`,

      // Uncalibrated (0xFFFF), NOT sRGB: iOS captures are Display P3 and put
      // the real profile in the ICC block. A literal sRGB here is the clearest
      // signal that a file went through someone's editor.
      `-EXIF:ColorSpace#=${0xffff}`,
      `-EXIF:ExposureProgram#=2`, // Program AE
      `-EXIF:WhiteBalance#=0`, // Auto
      `-EXIF:MeteringMode#=5`, // Multi-segment
      `-EXIF:Flash#=${0x10}`, // off, did not fire
      `-EXIF:Orientation#=1`, // horizontal (normal)

      // ffmpeg's mjpeg encoder stamps "Lavc<version>" into the JFIF comment.
      // `-map_metadata -1` does not reach it, and an ffmpeg signature sitting
      // beside an Apple EXIF block contradicts the whole identity, so clear it.
      `-Comment=`,

      "-overwrite_original",
    ];

    await exiftool.write(output, {}, { writeArgs });
  }
}
