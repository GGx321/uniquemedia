import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { exiftool } from "exiftool-vendored";
import { buildArgs } from "../core/filterGraph";
import { parseFfprobeJson, type ProbeResult } from "./ffprobeJson";
import type { RenderExecutor } from "../core/executor";
import type { IdentityMode, MediaInfo, Recipe } from "../core/types";
import type { DeviceProfile } from "../core/deviceProfile";
import { parseProgressFraction } from "./ffmpegProgress";
import { scrubMovSignature } from "./movSignature";

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

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

/**
 * Turns a parsed ffprobe payload into the `MediaInfo` the video pipeline runs
 * on, or says which file it could not make sense of.
 *
 * Separate from `probe` because it is the half worth testing: the shapes that
 * hurt (no streams, a truncated payload, a stream with no dimensions, a "N/A"
 * duration) are exactly the ones a spawned ffprobe will not produce on demand.
 * It reads a `ProbeResult` rather than raw JSON, so nothing here has to assume
 * a shape — that job belongs to `parseFfprobeJson`, and it does it defensively.
 *
 * `durationSec` comes from the format block alone, NOT from `longestDuration`.
 * The frame sampler places its PDQ probes at fractions of this number, so
 * taking the longest stream instead would move every sample point and shift the
 * verification metric of footage whose bytes have not changed.
 */
export function videoInfoFromProbe(probe: ProbeResult, input: string): MediaInfo {
  const video = probe.streams.find((s) => s.codecType === "video");
  if (!video || video.width === null || video.height === null) {
    throw new Error(`Cannot probe ${input}: no video stream with usable dimensions.`);
  }
  return {
    kind: "video",
    durationSec: probe.formatDurationSec ?? 0,
    width: video.width,
    height: video.height,
    hasAudio: probe.streams.some((s) => s.codecType === "audio"),
  };
}

export class FfmpegExecutor implements RenderExecutor {
  private active = new Map<ReturnType<typeof spawn>, string>(); // child -> output path

  cancel(): void {
    for (const [child, out] of this.active) {
      child.kill("SIGKILL");
      try { rmSync(out, { force: true }); } catch { /* ignore */ }
    }
    this.active.clear();
  }

  async probe(input: string): Promise<MediaInfo> {
    const raw = await run(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input,
    ]);
    return videoInfoFromProbe(parseFfprobeJson(raw.toString()), input);
  }

  render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    const args = ["-y", "-i", input, ...buildArgs(recipe, info)];
    if (onProgress) args.push("-progress", "pipe:1", "-nostats");
    args.push(output);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG, args);
      this.active.set(child, output);
      const err: Buffer[] = [];
      child.stderr.on("data", (d) => err.push(d));
      if (onProgress) {
        child.stdout.on("data", (d) => {
          const f = parseProgressFraction(d.toString(), info.durationSec);
          if (f !== null) onProgress(f);
        });
      }
      child.on("error", (e) => { this.active.delete(child); reject(e); });
      child.on("close", (code) => {
        this.active.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
      });
    });
  }

  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const { durationSec } = await this.probe(input);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const t = (durationSec * (i + 0.5)) / count;
      const buf = await run(FFMPEG, [
        "-ss", t.toFixed(3), "-i", input, "-frames:v", "1",
        "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "-",
      ]);
      if (buf.length < 64 * 64) {
        throw new Error(
          `extractGrayFrames: expected 4096 bytes at t=${t.toFixed(3)}s, got ${buf.length}`
        );
      }
      frames.push(new Uint8Array(buf.subarray(0, 64 * 64)));
    }
    return frames;
  }

  async extractThumbnail(input: string): Promise<string> {
    const buf = await run(FFMPEG, [
      "-ss", "0.5", "-i", input, "-frames:v", "1",
      "-vf", "scale=-2:180", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
    ]);
    return "data:image/jpeg;base64," + buf.toString("base64");
  }

  async warmup(): Promise<void> {
    await Promise.allSettled([
      run(FFMPEG, ["-version"]),
      run(FFPROBE, ["-version"]),
    ]);
  }

  /**
   * What each identity mode does to a rendered clip, after the graph has
   * already stripped the source's metadata and (for every mode but `engine`)
   * turned off the encoder's signature at encode time:
   *
   *  - `engine`: nothing. The container is ffmpeg's honest MP4.
   *  - `iphone`: the QuickTime keys of the profile's handset, then the MOV
   *    fields the muxer hardcodes, in `applyDeviceMetadata`.
   *  - `clean`: only those hardcoded fields — in MP4 mode the `avc1` vendor is
   *    already zeros, so that is the `ftyp` minor version and the compressor
   *    name `Lavc libx264`, which no encode-time flag reaches.
   */
  async applyIdentity(output: string, identity: IdentityMode, profile: DeviceProfile): Promise<void> {
    if (identity === "iphone") await this.applyDeviceMetadata(output, profile);
    else if (identity === "clean") await scrubMovSignature(output);
  }

  async applyDeviceMetadata(output: string, profile: DeviceProfile): Promise<void> {
    // GPS decimal string "lat, lon, 0" — exiftool converts this to the ISO6709
    // format that ffprobe reads back as com.apple.quicktime.location.ISO6709.
    // Writing to Keys: produces com.apple.quicktime.location.ISO6709;
    // writing to ItemList: additionally produces the top-level "location" tag.
    const gpsDecimal = `${profile.lat}, ${profile.lon}, 0`;
    await exiftool.write(
      output,
      {
        "Keys:Make": profile.make,
        "Keys:Model": profile.model,
        "Keys:Software": profile.software,
        "Keys:CreationDate": profile.creationLocal,
        "Keys:GPSCoordinates": gpsDecimal,
        "ItemList:GPSCoordinates": gpsDecimal,
      } as Record<string, string>,
      { writeArgs: ["-overwrite_original"] }
    );
    // AFTER exiftool, which rewrites the file and moves every offset: the
    // `ftyp` minor version and the `avc1` vendor are hardcoded by the muxer
    // (0x200 and `FFMP`), exiftool accepts a write to either and changes
    // nothing, so they are zeroed in place here. The compressor name is
    // `H.264` on this path (set at encode time) and is left alone.
    await scrubMovSignature(output);
  }
}
