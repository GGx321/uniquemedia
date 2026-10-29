import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { capcutVideoId } from "./capcutMark";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { sampleDeviceProfile } from "../core/deviceProfile";
import ffprobeStatic from "ffprobe-static";

/**
 * The optional CapCut mark adds a `com.apple.quicktime.artwork` Keys entry to
 * the `iphone` video output. exiftool has to write it (it creates the meta
 * box) and it rewrites the file, so it runs before the byte patches; these
 * tests render for real and check both the mark and that the patches survived.
 */

const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");
const EXIFTOOL = resolve(import.meta.dir, "../../node_modules/exiftool-vendored.pl/bin/exiftool");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOW_MS = 1_748_000_000_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function exifLines(path: string, ...tags: string[]): { group: string; tag: string; value: string }[] {
  const r = spawnSync(EXIFTOOL, ["-a", "-s", "-G1", ...tags.map((t) => `-${t}`), path], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout
    .split("\n")
    .map((line) => /^\[([^\]]+)\]\s+(\S+)\s+:\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ group: m[1], tag: m[2], value: m[3] }));
}

/** The parsed Keys:Artwork JSON of a file, or undefined when the tag is absent. */
function artworkOf(path: string): Record<string, unknown> | undefined {
  const hit = exifLines(path, "Keys:Artwork").find((e) => e.tag === "Artwork");
  if (!hit) return undefined;
  const parsed: unknown = JSON.parse(hit.value);
  return isRecord(parsed) ? parsed : undefined;
}

function videoIdOf(path: string): string {
  const data = artworkOf(path)?.data;
  return isRecord(data) && typeof data.videoId === "string" ? data.videoId : "";
}

function probeTags(path: string, scope: "format" | "video"): Record<string, string> {
  const r = spawnSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], {
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  const parsed: unknown = JSON.parse(r.stdout);
  if (!isRecord(parsed)) return {};
  const holder = scope === "format"
    ? parsed.format
    : Array.isArray(parsed.streams) ? parsed.streams.find((s: unknown) => isRecord(s) && s.codec_type === "video") : undefined;
  const tags = isRecord(holder) ? holder.tags : undefined;
  const out: Record<string, string> = {};
  if (isRecord(tags)) for (const [k, v] of Object.entries(tags)) if (typeof v === "string") out[k] = v;
  return out;
}

let dir: string;
const exec = new FfmpegExecutor();
const outputs = new Map<string, string>();

/** Renders one copy and applies the identity; key defaults to `<seed>-<on|off>`, reused across tests. */
async function build(input: string, seed: number, capcut: boolean, key = `${seed}-${capcut ? "on" : "off"}`): Promise<void> {
  const info = await exec.probe(input);
  const output = join(dir, `out_${seed}_${capcut ? "on" : "off"}_${outputs.size}.mov`);
  const recipe = sampleRecipe(
    {
      strength: 1.0,
      exportFormat: "square",
      keepTrendAudio: false,
      allowMirror: false,
      targetDistance: 90,
      identity: "iphone",
      edgeMode: "auto",
      distortion: false,
      distortionAxis: "h",
      distortionStrength: 0,
      firstFrame: { mode: "off" },
    },
    seed,
    1
  );
  await exec.render(input, info, recipe, output);
  await exec.applyIdentity(output, "iphone", sampleDeviceProfile(seed, NOW_MS), capcut);
  outputs.set(key, output);
}

const outOf = (key: string): string => {
  const o = outputs.get(key);
  if (!o) throw new Error(`fixture missing for ${key}`);
  return o;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-capcut-"));
  const input = join(dir, "in.mp4");
  makeTestClip(input);
  await build(input, 42, true);
  await build(input, 43, true);
  await build(input, 42, false);
  await build(input, 42, true, "42-on-again");
}, 180_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("with the mark on, Keys:Artwork is a CapCut-on-mac vicut mark", () => {
  const art = artworkOf(outOf("42-on"));
  expect(art).toMatchObject({ source_type: "vicut", source_platform: "desktop", data: { product: "vicut", os: "mac" } });
});

test("with the mark on, the video id is a UUID v4", () => {
  expect(videoIdOf(outOf("42-on"))).toMatch(UUID_V4);
});

test("two copies with different seeds carry different video ids", () => {
  expect(videoIdOf(outOf("42-on"))).not.toBe(videoIdOf(outOf("43-on")));
});

test("the same seed reproduces the same video id", () => {
  expect(videoIdOf(outOf("42-on"))).toBe(videoIdOf(outOf("42-on-again")));
  expect(videoIdOf(outOf("42-on"))).toBe(capcutVideoId(sampleDeviceProfile(42, NOW_MS).creationUtcMs));
});

test("with the mark off there is no Keys box and no artwork tag", () => {
  const bytes = readFileSync(outOf("42-off"));
  expect(bytes.includes("keys")).toBe(false);
  expect(bytes.includes("mdta")).toBe(false);
  expect(bytes.includes("com.apple")).toBe(false);
  expect(artworkOf(outOf("42-off"))).toBeUndefined();
});

// exiftool rewrote the file; the byte patches ran after it and must all hold.

test("with the mark on, creation_time is still the profile's instant", () => {
  const created = probeTags(outOf("42-on"), "format").creation_time ?? "";
  expect(created.startsWith("0000")).toBe(false);
  expect(Date.parse(created)).toBe(Math.floor(sampleDeviceProfile(42, NOW_MS).creationUtcMs / 1000) * 1000);
});

test("with the mark on, the video stream keeps language und and a zero vendor", () => {
  const video = probeTags(outOf("42-on"), "video");
  expect(video.language).toBe("und");
  expect(video.vendor_id).toBe("[0][0][0][0]");
});

test("with the mark on, exactly four track handlers name Apple and the meta handler does not", () => {
  const vendors = exifLines(outOf("42-on"), "HandlerVendorID");
  const onTracks = vendors.filter((e) => /^Track\d+$/.test(e.group));
  expect(onTracks.length).toBe(4);
  for (const v of onTracks) expect(v.value).toBe("Apple");
  expect(vendors.filter((e) => e.value === "Apple").length).toBe(4);
});

test("with the mark on, the video header still uses ditherCopy with an 0x8000 OpColor", () => {
  const modes = exifLines(outOf("42-on"), "GraphicsMode").filter((e) => /^Track\d+$/.test(e.group));
  expect(modes.map((m) => m.value)).toEqual(["ditherCopy"]);
  const colours = exifLines(outOf("42-on"), "OpColor").filter((e) => /^Track\d+$/.test(e.group));
  expect(colours.map((c) => c.value)).toEqual(["32768 32768 32768"]);
});
