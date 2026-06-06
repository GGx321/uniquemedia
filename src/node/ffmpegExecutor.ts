import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { buildArgs } from "../core/filterGraph";
import type { RenderExecutor } from "../core/executor";
import type { MediaInfo, Recipe } from "../core/types";

const FFMPEG = ffmpegPath as string;
const FFPROBE = ffprobeStatic.path;

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

export class FfmpegExecutor implements RenderExecutor {
  async probe(input: string): Promise<MediaInfo> {
    const raw = await run(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input,
    ]);
    const json = JSON.parse(raw.toString());
    const v = json.streams.find((s: any) => s.codec_type === "video");
    const a = json.streams.find((s: any) => s.codec_type === "audio");
    return {
      durationSec: Number(json.format.duration) || 0,
      width: Number(v?.width) || 0,
      height: Number(v?.height) || 0,
      hasAudio: Boolean(a),
    };
  }

  async render(input: string, info: MediaInfo, recipe: Recipe, output: string): Promise<void> {
    await run(FFMPEG, ["-y", "-i", input, ...buildArgs(recipe, info), output]);
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
}
