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
import type { ResolvedCopyOptions } from "../core/types";

/**
 * A spoofed copy claims to be an iPhone capture. Until this test existed it
 * also carried, inside the very same file: `Lavf60.3.100` on the container,
 * `Lavc60.3.100 libx264` as the compressor name, `FFMP` as the vendor, the
 * whole x264 option string as an SEI NAL in the H.264 stream, and `Lavc` once
 * more inside the first AAC frame. A file that says "iPhone 14, iOS 26.2" and
 * carries that is a stronger tell than a file that says nothing.
 *
 * The bytes are searched, not ffprobe's tag view: the SEI and the AAC FIL
 * element are inside the coded streams, where no tag reader looks.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

const SEED = 42;
const NOW_MS = 1_748_000_000_000; // fixed for determinism
const opts: ResolvedCopyOptions = {
  strength: 1.0,
  exportFormat: "square",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  identity: "iphone",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
};

let dir: string;
let output: string;
let bytes: Buffer;
const exec = new FfmpegExecutor();

interface Tags {
  format: Record<string, string>;
  video: Record<string, string>;
  audio: Record<string, string>;
}

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-spoofsig-"));
  const input = join(dir, "in.mp4");
  output = join(dir, "out.mov");
  makeTestClip(input);

  const info = await exec.probe(input);
  // Full pipeline: render, then the device identity pass, exactly as a shipped
  // copy goes through it.
  await exec.render(input, info, sampleRecipe(opts, SEED, 1), output);
  await exec.applyDeviceMetadata(output, sampleDeviceProfile(SEED, NOW_MS));
  bytes = readFileSync(output);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

test.each(["Lavf", "Lavc", "x264", "FFMP"])(
  "a spoofed copy carries no '%s' anywhere in its bytes, at any bit alignment",
  (needle) => {
    expect(findAtAnyBitShift(bytes, needle)).toBeNull();
  }
);

test("a spoofed copy carries no exiftool signature either", () => {
  // The identity pass goes through exiftool; it must not sign the file itself.
  expect(bytes.toString("latin1").toLowerCase()).not.toContain("exiftool");
});

test("a spoofed copy has no encoder tag on the container", () => {
  expect(probeTags(output).format).not.toHaveProperty("encoder");
});

test("a spoofed copy's ftyp minor version is 0, as an iPhone writes it", () => {
  expect(probeTags(output).format.minor_version).toBe("0");
  expect(bytes.readUInt32BE(12)).toBe(0);
});

test("a spoofed copy's video stream names its compressor H.264 with a zero vendor", () => {
  const { video } = probeTags(output);
  expect(video.encoder).toBe("H.264");
  expect(video.vendor_id).toBe("[0][0][0][0]");
});

test("a spoofed copy still carries the Core Media handler names", () => {
  const { video, audio } = probeTags(output);
  expect(video.handler_name).toBe("Core Media Video");
  expect(audio.handler_name).toBe("Core Media Audio");
});

test("a spoofed copy still carries the Apple make and the rest of the identity", () => {
  const { format } = probeTags(output);
  expect(format["com.apple.quicktime.make"]).toBe("Apple");
  expect(format["com.apple.quicktime.model"]).toContain("iPhone");
  expect(format["major_brand"]).toBe("qt  ");
});

test("a spoofed copy decodes end to end without a decoder complaint", () => {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", output, "-f", "null", "-"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stderr.trim()).toBe("");
});

test("a spoofed copy is still CFR at the recipe fps with in-sync audio", () => {
  // The SEI filter and bitexact touch nothing a decoder times by; the CFR and
  // A/V-sync tests elsewhere run spoof OFF, so this is the spoof-ON pin.
  const field = (stream: "v" | "a", entry: string): string =>
    spawnSync(
      FFPROBE,
      ["-v", "error", "-select_streams", stream, "-show_entries", entry, "-of", "default=nw=1:nk=1", output],
      { encoding: "utf8" }
    ).stdout.trim();
  const enc = sampleRecipe(opts, SEED, 1).video.find((o) => o.id === "encode")?.params ?? {};
  const [num, den] = field("v", "stream=r_frame_rate").split("/").map(Number);
  expect(num / den).toBe(Number(enc.fps));
  const vd = Number(field("v", "stream=duration"));
  const ad = Number(field("a", "stream=duration"));
  expect(vd).toBeGreaterThan(1.7);
  expect(Math.abs(vd - ad)).toBeLessThan(0.2);
});

test("a spoofed copy's H.264 stream carries no SEI NAL units at all", () => {
  // `trace_headers` prints every NAL it sees; type 6 is SEI. SPS/PPS (7/8)
  // and the slices must still be there — the filter removes one type only.
  const r = spawnSync(
    FFMPEG,
    ["-v", "trace", "-i", output, "-map", "0:v", "-c:v", "copy", "-bsf:v", "trace_headers", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  expect(r.status).toBe(0);
  const nalTypes = [...r.stderr.matchAll(/nal_unit_type: (\d+)\(/g)].map((m) => Number(m[1]));
  expect(nalTypes.length).toBeGreaterThan(0);
  expect(nalTypes).not.toContain(6);
  expect(nalTypes).toContain(7);
  expect(nalTypes).toContain(8);
  expect(nalTypes).toContain(5);
});
