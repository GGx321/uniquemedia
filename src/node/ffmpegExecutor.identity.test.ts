import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { sampleDeviceProfile } from "../core/deviceProfile";
import { IDENTITY_MODES } from "../core/types";
import type { CopyOptions, IdentityMode } from "../core/types";

/**
 * The three identity modes, rendered for real and read back as bytes.
 *
 * `engine` is the honest file: ffmpeg's `Lavf` on the container and `Lavc` as
 * the compressor name, exactly as before the modes existed. `iphone` replaces
 * that with Apple's handler names and QuickTime keys and scrubs every trace of
 * the encoder. `clean` scrubs the same traces and writes nothing in their
 * place: no Apple keys, the MP4 muxer's own default handler names, a blank
 * compressor name. The bytes are searched rather than ffprobe's tag view,
 * because the SEI and the AAC FIL element live inside the coded streams where
 * no tag reader looks — and at every bit alignment, because the FIL element is
 * bit-packed.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

const SEED = 42;
const NOW_MS = 1_748_000_000_000; // fixed for determinism
const ENCODER_STRINGS = ["Lavf", "Lavc", "x264", "FFMP"] as const;

const baseOpts: Omit<CopyOptions, "identity"> = {
  strength: 1.0,
  exportFormat: "square",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  edgeMode: "auto",
  blackFirstFrame: false,
};

interface Rendered {
  output: string;
  bytes: Buffer;
}

interface Tags {
  format: Record<string, string>;
  video: Record<string, string>;
  audio: Record<string, string>;
}

let dir: string;
const rendered = new Map<IdentityMode, Rendered>();
const exec = new FfmpegExecutor();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The string-valued entries of `value.tags`, or nothing when there are none. */
function tagsOf(value: unknown): Record<string, string> {
  const tags = isRecord(value) ? value.tags : undefined;
  if (!isRecord(tags)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Format and stream tags as ffprobe reads them back. */
function probeTags(file: string): Tags {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf8" }
  );
  expect(r.status).toBe(0);
  const parsed: unknown = JSON.parse(r.stdout);
  const streams = isRecord(parsed) && Array.isArray(parsed.streams) ? parsed.streams : [];
  const streamOf = (type: string): unknown =>
    streams.find((s: unknown) => isRecord(s) && s.codec_type === type);
  return {
    format: tagsOf(isRecord(parsed) ? parsed.format : undefined),
    video: tagsOf(streamOf("video")),
    audio: tagsOf(streamOf("audio")),
  };
}

/**
 * Where `needle` occurs in `buf` at ANY bit alignment: the AAC encoder's FIL
 * element is bit-packed, so its `Lavc` string need not start on a byte
 * boundary and a plain byte search could miss it. Reports the byte offset
 * and the bit shift of the first hit, or null.
 */
function findAtAnyBitShift(buf: Buffer, needle: string): { offset: number; shift: number } | null {
  const at0 = buf.indexOf(needle);
  if (at0 !== -1) return { offset: at0, shift: 0 };
  for (let shift = 1; shift < 8; shift++) {
    const shifted = Buffer.alloc(buf.length - 1);
    for (let i = 0; i < shifted.length; i++) {
      shifted[i] = ((buf[i] << shift) | (buf[i + 1] >> (8 - shift))) & 0xff;
    }
    const at = shifted.indexOf(needle);
    if (at !== -1) return { offset: at, shift };
  }
  return null;
}

function fileOf(mode: IdentityMode): Rendered {
  const r = rendered.get(mode);
  if (!r) throw new Error(`fixture missing for ${mode}`);
  return r;
}

const field = (file: string, stream: "v" | "a", entry: string): string =>
  spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry, "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  ).stdout.trim();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-identity-"));
  const input = join(dir, "in.mp4");
  makeTestClip(input);
  const info = await exec.probe(input);
  const profile = sampleDeviceProfile(SEED, NOW_MS);

  for (const identity of IDENTITY_MODES) {
    // The pipeline names every video copy `.mp4` whatever the mode; the iphone
    // branch forces the MOV muxer into that path and the others let the
    // extension decide. Same here, so the files are what actually ships.
    const output = join(dir, `out_${identity}.mp4`);
    await exec.render(input, info, sampleRecipe({ ...baseOpts, identity }, SEED, 1), output);
    await exec.applyIdentity(output, identity, profile);
    rendered.set(identity, { output, bytes: readFileSync(output) });
  }
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── engine ────────────────────────────────────────────────────────────────

test("engine: the file keeps ffmpeg's honest signature on the container and the stream", () => {
  // Today's "spoof off", byte for byte: this is the mode that must not move.
  const { bytes } = fileOf("engine");
  expect(bytes.includes("Lavf")).toBe(true);
  expect(bytes.includes("Lavc")).toBe(true);
});

test("engine: the container carries no Apple identity", () => {
  const { bytes, output } = fileOf("engine");
  expect(bytes.includes("com.apple")).toBe(false);
  expect(probeTags(output).format).not.toHaveProperty("com.apple.quicktime.make");
});

test("engine: the muxer's default handler names are left as they are", () => {
  const { video, audio } = probeTags(fileOf("engine").output);
  expect(video.handler_name).toBe("VideoHandler");
  expect(audio.handler_name).toBe("SoundHandler");
});

// ── iphone ────────────────────────────────────────────────────────────────

test.each([...ENCODER_STRINGS])(
  "iphone: no '%s' anywhere in the bytes, at any bit alignment",
  (needle) => {
    expect(findAtAnyBitShift(fileOf("iphone").bytes, needle)).toBeNull();
  }
);

test("iphone: carries the Core Media handler names and the Apple make", () => {
  const { format, video, audio } = probeTags(fileOf("iphone").output);
  expect(video.handler_name).toBe("Core Media Video");
  expect(audio.handler_name).toBe("Core Media Audio");
  expect(format["com.apple.quicktime.make"]).toBe("Apple");
  expect(format["com.apple.quicktime.model"]).toContain("iPhone");
  expect(format.major_brand).toBe("qt  ");
});

// ── clean ─────────────────────────────────────────────────────────────────

test.each([...ENCODER_STRINGS])(
  "clean: no '%s' anywhere in the bytes, at any bit alignment",
  (needle) => {
    expect(findAtAnyBitShift(fileOf("clean").bytes, needle)).toBeNull();
  }
);

test("clean: no Apple key anywhere in the bytes and no Core Media handler", () => {
  const { bytes, output } = fileOf("clean");
  expect(bytes.includes("com.apple")).toBe(false);
  expect(bytes.includes("Core Media")).toBe(false);
  const { format, video, audio } = probeTags(output);
  for (const key of Object.keys(format)) expect(key).not.toContain("apple");
  expect(video.handler_name).not.toContain("Core Media");
  expect(audio.handler_name).not.toContain("Core Media");
});

test("clean: the handler names are whatever the MP4 muxer defaults to", () => {
  // Pinned so the report can say what a clean file calls its tracks — and so
  // that a later change to "no handler name at all" is a deliberate one.
  const { video, audio } = probeTags(fileOf("clean").output);
  expect(video.handler_name).toBe("VideoHandler");
  expect(audio.handler_name).toBe("SoundHandler");
});

test("clean: stays in the MP4 container the output extension asks for", () => {
  const { format } = probeTags(fileOf("clean").output);
  expect(format.major_brand).toBe("isom");
});

test("clean: the ftyp minor version is zeroed, like the iphone copy's", () => {
  const { bytes, output } = fileOf("clean");
  expect(probeTags(output).format.minor_version).toBe("0");
  expect(bytes.readUInt32BE(12)).toBe(0);
});

test("clean: the video sample entry has a zero vendor and a blank compressor name", () => {
  // Under bitexact the MP4 muxer already zeroes the vendor; the compressor
  // name it still hardcodes (`Lavc libx264`) is blanked after the render, so
  // ffprobe reports no `encoder` on the stream at all.
  const { video } = probeTags(fileOf("clean").output);
  expect(video.vendor_id).toBe("[0][0][0][0]");
  expect(video).not.toHaveProperty("encoder");
});

test("clean: no encoder tag on the container and no exiftool signature", () => {
  const { bytes, output } = fileOf("clean");
  expect(probeTags(output).format).not.toHaveProperty("encoder");
  expect(bytes.toString("latin1").toLowerCase()).not.toContain("exiftool");
});

test("clean: decodes end to end without a decoder complaint", () => {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", fileOf("clean").output, "-f", "null", "-"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stderr.trim()).toBe("");
});

test("clean: is still CFR at the recipe fps with in-sync audio", () => {
  const { output } = fileOf("clean");
  const enc = sampleRecipe({ ...baseOpts, identity: "clean" }, SEED, 1).video.find((o) => o.id === "encode")?.params ?? {};
  const [num, den] = field(output, "v", "stream=r_frame_rate").split("/").map(Number);
  expect(num / den).toBe(Number(enc.fps));
  const vd = Number(field(output, "v", "stream=duration"));
  const ad = Number(field(output, "a", "stream=duration"));
  expect(vd).toBeGreaterThan(1.7);
  expect(Math.abs(vd - ad)).toBeLessThan(0.2);
});

test("clean: the H.264 stream carries no SEI NAL units at all", () => {
  const r = spawnSync(
    FFMPEG,
    ["-v", "trace", "-i", fileOf("clean").output, "-map", "0:v", "-c:v", "copy", "-bsf:v", "trace_headers", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  expect(r.status).toBe(0);
  const nalTypes = [...r.stderr.matchAll(/nal_unit_type: (\d+)\(/g)].map((m) => Number(m[1]));
  expect(nalTypes.length).toBeGreaterThan(0);
  expect(nalTypes).not.toContain(6);
  expect(nalTypes).toContain(7);
  expect(nalTypes).toContain(8);
});
