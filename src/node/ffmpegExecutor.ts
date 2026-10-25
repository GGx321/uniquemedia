import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { buildArgs } from "../core/filterGraph";
import { sourceToBt709 } from "../core/colour";
import { parseFfprobeJson, type ProbeResult } from "./ffprobeJson";
import type { RenderExecutor } from "../core/executor";
import type { IdentityMode, MediaInfo, Recipe } from "../core/types";
import type { DeviceProfile } from "../core/deviceProfile";
import { parseProgressFraction } from "./ffmpegProgress";
import { exiftool } from "exiftool-vendored";
import { capcutArtworkJson, capcutVideoId } from "./capcutMark";
import { markAppleContainer, scrubMovSignature, stampMovCreationTimes } from "./movSignature";

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
    color: {
      pixFmt: video.pixFmt,
      space: video.colorSpace,
      transfer: video.colorTransfer,
      primaries: video.colorPrimaries,
      range: video.colorRange,
    },
  };
}

/**
 * Filter names off `ffmpeg -filters` output, asked through `list`, remembered
 * once an answer comes. A failed listing reports none for that call and is
 * forgotten, so one failed spawn does not leave the process believing the
 * filters are missing. Separate from the binary so this can be tested without
 * one.
 */
export function cachedFilters(list: () => Promise<Buffer>): () => Promise<Set<string>> {
  let names: Promise<Set<string>> | null = null;
  return () => {
    names ??= list().then(
      (out) => new Set(out.toString().split("\n").map((line) => line.trim().split(/\s+/)[1] ?? "")),
      () => {
        names = null;
        return new Set<string>();
      }
    );
    return names;
  };
}

/**
 * The filters the running ffmpeg has, asked once per process. Both bundled
 * builds have zscale and tonemap (libzimg), and a test pins that; this is for
 * the build that does not, so it degrades as `sourceToBt709` says instead of
 * failing on an unknown filter name. A binary that cannot even list its
 * filters reports none, and its render fails on its own.
 */
export const ffmpegFilters = cachedFilters(() => run(FFMPEG, ["-hide_banner", "-filters"]));

const hasZscale = async (): Promise<boolean> => (await ffmpegFilters()).has("zscale");

export class FfmpegExecutor implements RenderExecutor {
  private active = new Map<ReturnType<typeof spawn>, string>(); // child -> output path

  /**
   * Kills whatever is rendering and removes the file it was writing. The path
   * is always the one handed to `render`, and the pipeline guarantees that a
   * copy already reported done is never that path: during the inter-copy
   * post-pass the child writes a staged sibling (see `replace`), so Stop can
   * only ever take a half-written file with it.
   */
  cancel(): void {
    for (const [child, out] of this.active) {
      child.kill("SIGKILL");
      try { rmSync(out, { force: true }); } catch { /* ignore */ }
    }
    this.active.clear();
  }

  /** The post-pass swap: a verified regeneration over the copy it replaces.
   *  `rename` is atomic on one volume, and the staged file is a sibling by
   *  construction, so the finished copy is either the old one or the new one —
   *  never a partial. */
  async replace(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async discard(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async probe(input: string): Promise<MediaInfo> {
    const raw = await run(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input,
    ]);
    const info = videoInfoFromProbe(parseFfprobeJson(raw.toString()), input);
    // Here rather than at the first render: a source this ffmpeg cannot bring
    // to BT.709 (HDR without zscale) stops the batch before any copy starts.
    // It also settles the filter list before `render` reads it.
    sourceToBt709(info, await hasZscale());
    return info;
  }

  async render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    const args = ["-y", "-i", input, ...buildArgs(recipe, info, await hasZscale())];
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
   *  - `iphone`: no handset keys (the reference has none), but the profile's
   *    own creation time and the MOV fields an iPhone file carries and the
   *    muxer does not, in `applyDeviceMetadata`.
   *  - `clean`: the real export time as creation time, and only those hardcoded fields — in MP4 mode the `avc1` vendor is
   *    already zeros, so that is the `ftyp` minor version and the compressor
   *    name `Lavc libx264`, which no encode-time flag reaches.
   */
  async applyIdentity(output: string, identity: IdentityMode, profile: DeviceProfile, capcutMark: boolean): Promise<void> {
    if (identity === "iphone") await this.applyDeviceMetadata(output, profile, capcutMark);
    else if (identity === "clean") {
      await scrubMovSignature(output);
      // The export time, UTC, in mvhd/tkhd/mdhd: bitexact leaves them at zero.
      await stampMovCreationTimes(output);
    }
  }

  async applyDeviceMetadata(output: string, profile: DeviceProfile, capcutMark = false): Promise<void> {
    // Without the CapCut mark there is no exiftool pass: the reference this mode replicates carries no Make,
    // Model, Software or GPS (the CapCut export stripped them), so there is
    // nothing to write — and exiftool would add a Keys/meta box the reference
    // does not have. With the mark, exiftool runs FIRST: it rewrites and
    // reorders the file (and adds the Keys/meta box), so the byte patches must
    // come after it. Everything below is an in-place byte patch with no reflow,
    // so the three are independent of each other.
    //
    // The `ftyp` minor version and the `avc1` vendor are hardcoded by the muxer
    // (0x200 and `FFMP`) and are zeroed. The compressor name is `H.264` on this
    // path (set at encode time) and is left alone.
    if (capcutMark) {
      await exiftool.write(
        output,
        {},
        { writeArgs: ["-overwrite_original", `-Keys:Artwork=${capcutArtworkJson(capcutVideoId(profile.creationUtcMs))}`] }
      );
    }
    await scrubMovSignature(output);
    // bitexact left the header times at zero; each copy gets its own capture
    // time, and the modification a couple of seconds after it.
    const created = new Date(profile.creationUtcMs);
    await stampMovCreationTimes(output, created, new Date(created.getTime() + 2000));
    // Apple handler vendor, `und` language, ditherCopy video header.
    await markAppleContainer(output);
  }
}
