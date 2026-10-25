import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { sampleDeviceProfile } from "../core/deviceProfile";
import type { DeviceProfile } from "../core/deviceProfile";
import ffprobeStatic from "ffprobe-static";

/**
 * The `iphone` video identity replicates a real iPhone clip that was re-exported
 * through CapCut: no Make, Model, Software or GPS (the export stripped them), and
 * an iPhone's feel carried by the container instead — `qt  ` brand, Apple handler
 * fields, real creation times, a 600 video timescale. These tests render the
 * whole pass for real and read it back with ffprobe and the bundled exiftool.
 */

const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");
const EXIFTOOL = resolve(import.meta.dir, "../../node_modules/exiftool-vendored.pl/bin/exiftool");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

interface Probed {
  format: Record<string, string>;
  video: Record<string, string>;
  audio: Record<string, string>;
  videoTimeBase: string;
}

function tagsOf(value: unknown): Record<string, string> {
  const tags = isRecord(value) ? value.tags : undefined;
  if (!isRecord(tags)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (typeof v === "string") out[k] = v;
  return out;
}

function ffprobe(path: string): Probed {
  const r = spawnSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], {
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  const parsed: unknown = JSON.parse(r.stdout);
  const streams = isRecord(parsed) && Array.isArray(parsed.streams) ? parsed.streams : [];
  const streamOf = (type: string): unknown => streams.find((s: unknown) => isRecord(s) && s.codec_type === type);
  const video = streamOf("video");
  return {
    format: tagsOf(isRecord(parsed) ? parsed.format : undefined),
    video: tagsOf(video),
    audio: tagsOf(streamOf("audio")),
    videoTimeBase: isRecord(video) && typeof video.time_base === "string" ? video.time_base : "",
  };
}

/** `[Group] Tag : value` lines for the named tags, every occurrence (`-a`), grouped by family 1. */
function exif(path: string, ...tags: string[]): { group: string; tag: string; value: string }[] {
  const r = spawnSync(EXIFTOOL, ["-a", "-s", "-G1", ...tags.map((t) => `-${t}`), path], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout
    .split("\n")
    .map((line) => /^\[([^\]]+)\]\s+(\S+)\s+:\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ group: m[1], tag: m[2], value: m[3] }));
}

/** Every Track<N> group's values for one tag. */
const perTrack = (path: string, tag: string): { group: string; value: string }[] =>
  exif(path, tag).filter((e) => e.tag === tag && /^Track\d+$/.test(e.group));

let dir: string;
const exec = new FfmpegExecutor();

const NOW_MS = 1_748_000_000_000; // fixed for determinism
const SEED_A = 42;
const SEED_B = 43;

interface Copy {
  output: string;
  profile: DeviceProfile;
  probed: Probed;
}
const copies = new Map<number, Copy>();

function copyOf(seed: number): Copy {
  const c = copies.get(seed);
  if (!c) throw new Error(`fixture missing for seed ${seed}`);
  return c;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-meta-"));
  const input = join(dir, "in.mp4");
  makeTestClip(input);
  const info = await exec.probe(input);
  for (const seed of [SEED_A, SEED_B]) {
    const output = join(dir, `out_${seed}.mov`);
    const recipe = sampleRecipe(
      {
        strength: 1.0,
        exportFormat: "square",
        keepTrendAudio: false,
        allowMirror: false,
        targetDistance: 90,
        identity: "iphone",
        edgeMode: "auto",
        firstFrame: { mode: "off" },
      },
      seed,
      1
    );
    const profile = sampleDeviceProfile(seed, NOW_MS);
    await exec.render(input, info, recipe, output);
    await exec.applyIdentity(output, "iphone", profile, false);
    copies.set(seed, { output, profile, probed: ffprobe(output) });
  }
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── what the reference does not carry ─────────────────────────────────────

test("the video carries no make, model, software or location", () => {
  const { output, probed } = copyOf(SEED_A);
  for (const tags of [probed.format, probed.video, probed.audio]) {
    for (const k of Object.keys(tags)) expect(k).not.toMatch(/make|model|software|location|gps/i);
  }
  expect(exif(output, "Make", "Model", "Software", "GPSCoordinates")).toEqual([]);
});

test("the video has no meta/Keys box at all", () => {
  const bytes = readFileSync(copyOf(SEED_A).output);
  expect(bytes.includes("keys")).toBe(false);
  expect(bytes.includes("mdta")).toBe(false);
  expect(bytes.includes("com.apple")).toBe(false);
});

// ── creation time ─────────────────────────────────────────────────────────

test.each(["format", "video", "audio"] as const)("%s creation_time is the profile's instant, not the zero date", (where) => {
  const { profile, probed } = copyOf(SEED_A);
  const created = probed[where].creation_time;
  expect(created).toBeDefined();
  expect(created?.startsWith("0000")).toBe(false);
  expect(Date.parse(created ?? "")).toBe(Math.floor(profile.creationUtcMs / 1000) * 1000);
});

test("modify time is the create time plus two seconds in mvhd, tkhd and mdhd", () => {
  const { output, profile } = copyOf(SEED_A);
  const created = new Date(profile.creationUtcMs);
  const modified = new Date(profile.creationUtcMs + 2000);
  const fmt = (d: Date): string => d.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
  const all = exif(output, "CreateDate", "ModifyDate", "TrackCreateDate", "TrackModifyDate", "MediaCreateDate", "MediaModifyDate");
  expect(all.length).toBe(2 + 2 * 2 * 2); // mvhd + (tkhd + mdhd) x 2 tracks, create + modify each
  for (const e of all) {
    expect(e.value.startsWith(fmt(/Create/.test(e.tag) ? created : modified))).toBe(true);
  }
});

test("two copies carry two different creation times", () => {
  const a = copyOf(SEED_A).probed.format.creation_time;
  const b = copyOf(SEED_B).probed.format.creation_time;
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect(a).not.toBe(b);
});

// ── container identity ────────────────────────────────────────────────────

test("the container is a qt file with minor version 0", () => {
  const { format } = copyOf(SEED_A).probed;
  expect(format.major_brand).toBe("qt  ");
  expect(format.minor_version).toBe("0");
  expect(format.compatible_brands).toBe("qt  ");
});

test("the video stream says H.264, a zero vendor and Core Media Video", () => {
  const { video } = copyOf(SEED_A).probed;
  expect(video.handler_name).toBe("Core Media Video");
  expect(video.encoder).toBe("H.264");
  expect(video.vendor_id).toBe("[0][0][0][0]");
});

test("the audio stream says Core Media Audio", () => {
  expect(copyOf(SEED_A).probed.audio.handler_name).toBe("Core Media Audio");
});

test.each(["video", "audio"] as const)("%s language is und, not the muxer's Unknown", (where) => {
  expect(copyOf(SEED_A).probed[where].language).toBe("und");
});

test("every handler box of both tracks names Apple as its vendor", () => {
  const vendors = perTrack(copyOf(SEED_A).output, "HandlerVendorID");
  // media handler + data handler, for each of the two tracks
  expect(vendors.length).toBe(4);
  for (const v of vendors) expect(v.value).toBe("Apple");
});

test("the video header uses ditherCopy with an 0x8000 OpColor", () => {
  const { output } = copyOf(SEED_A);
  const modes = perTrack(output, "GraphicsMode");
  expect(modes.length).toBe(1);
  expect(modes[0].value).toBe("ditherCopy");
  const colours = perTrack(output, "OpColor");
  expect(colours.map((c) => c.value)).toEqual(["32768 32768 32768"]);
});

test("the video media timescale is 600", () => {
  const { output, probed } = copyOf(SEED_A);
  expect(probed.videoTimeBase).toBe("1/600");
  expect(perTrack(output, "MediaTimeScale").some((t) => t.value === "600")).toBe(true);
});
