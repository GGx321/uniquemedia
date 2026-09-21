import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { exiftool, type Tags } from "exiftool-vendored";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestPhoto } from "./testClip";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { sampleDeviceProfile } from "../core/deviceProfile";
import { IDENTITY_MODES } from "../core/types";
import type { IdentityMode } from "../core/types";
import type { ResolvedPhotoOptions } from "../core/photo/types";

/**
 * The three identity modes on a still, judged on the raw JPEG segment list
 * rather than on what exiftool reports: a tag reader tells you what it could
 * parse, and the tell is the segment being there at all.
 *
 * ffmpeg's mjpeg encoder writes a JFIF APP0 segment and stamps `Lavc<ver>`
 * into a COM segment. `engine` keeps both. `iphone` adds an APP1 EXIF block
 * and drops the comment. `clean` drops APP0 and COM and adds nothing, so the
 * file is DQT/DHT/SOF/SOS and the entropy-coded data — the spec's verified
 * recipe, `-JFIF:all= -Comment=`.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");

const SEED = 42;
const NOW_MS = 1_748_000_000_000;

const OPTS: Omit<ResolvedPhotoOptions, "identity"> = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 30,
  edge: { mode: "crop" },
};

/** `readRaw` hands back group-qualified keys ("EXIF:Make") that `Tags` does
 *  not name, so widen it rather than reach past the typings. */
interface RawExif extends Tags {
  [key: string]: unknown;
}

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const COM = 0xfe;

/**
 * The marker of every segment from SOI up to and including SOS, in file
 * order. Stops at SOS because the entropy-coded data that follows is not
 * segmented, and no metadata can hide in it. Throws on anything that is not a
 * marker where a marker must be, rather than skipping ahead.
 */
function segmentMarkers(bytes: Buffer): number[] {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) throw new Error("not a JPEG: no SOI");
  const markers: number[] = [];
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error(`expected a marker at byte ${at}, found 0x${bytes[at].toString(16)}`);
    const marker = bytes[at + 1];
    markers.push(marker);
    if (marker === SOS) return markers;
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error("JPEG ends before SOS");
}

/** The payload of the first segment carrying `marker`, or null. */
function segmentPayload(bytes: Buffer, marker: number): Buffer | null {
  let at = 2;
  while (at < bytes.length) {
    const m = bytes[at + 1];
    const len = bytes.readUInt16BE(at + 2);
    if (m === marker) return bytes.subarray(at + 4, at + 2 + len);
    if (m === SOS) return null;
    at += 2 + len;
  }
  return null;
}

const hex = (m: number): string => m.toString(16);

interface Rendered {
  output: string;
  bytes: Buffer;
  markers: number[];
  tags: RawExif;
}

const exec = new PhotoExecutor();
let dir: string;
const rendered = new Map<IdentityMode, Rendered>();

function fileOf(mode: IdentityMode): Rendered {
  const r = rendered.get(mode);
  if (!r) throw new Error(`fixture missing for ${mode}`);
  return r;
}

const str = (t: RawExif, key: string): string => {
  const v = t[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-photo-identity-"));
  const input = join(dir, "in.jpg");
  makeTestPhoto(input, 640, 480);
  const info = await exec.probe(input);
  const profile = sampleDeviceProfile(SEED, NOW_MS);

  for (const identity of IDENTITY_MODES) {
    const output = join(dir, `out_${identity}.jpg`);
    await exec.render(input, info, samplePhotoRecipe({ ...OPTS, identity }, SEED, 1), output);
    await exec.applyIdentity(output, identity, profile);
    const bytes = readFileSync(output);
    rendered.set(identity, {
      output,
      bytes,
      markers: segmentMarkers(bytes),
      tags: await exiftool.readRaw<RawExif>(output, ["-n", "-G0"]),
    });
  }
}, 120_000);

// NOTE: do not call `exiftool.end()` — it is a process-wide singleton shared
// with the other test files and with the executors, and ending it is
// irreversible ("BatchCluster has ended, cannot enqueue").
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── engine ────────────────────────────────────────────────────────────────

test("engine: keeps the JFIF APP0 segment and the encoder's comment, as ffmpeg wrote them", () => {
  // Today's "spoof off": the executor touches nothing on this path.
  const { markers, bytes } = fileOf("engine");
  expect(markers.map(hex)).toContain(hex(APP0));
  expect(markers.map(hex)).toContain(hex(COM));
  expect(segmentPayload(bytes, COM)?.toString("latin1")).toMatch(/^Lavc/);
});

test("engine: carries no EXIF block and so no device identity", () => {
  const { markers, tags } = fileOf("engine");
  expect(markers.map(hex)).not.toContain(hex(APP1));
  expect(str(tags, "EXIF:Make")).toBe("");
});

// ── iphone ────────────────────────────────────────────────────────────────

test("iphone: carries an APP1 EXIF block that says Apple", () => {
  const { markers, tags } = fileOf("iphone");
  expect(markers.map(hex)).toContain(hex(APP1));
  expect(str(tags, "EXIF:Make")).toBe("Apple");
  expect(str(tags, "EXIF:Model")).toMatch(/^iPhone /);
});

test("iphone: the encoder's comment is gone", () => {
  const { markers, bytes } = fileOf("iphone");
  expect(markers.map(hex)).not.toContain(hex(COM));
  expect(bytes.includes("Lavc")).toBe(false);
});

// ── clean ─────────────────────────────────────────────────────────────────

test("clean: no APP0, no APP1 and no COM segment remain", () => {
  const { markers } = fileOf("clean");
  expect(markers.map(hex)).not.toContain(hex(APP0));
  expect(markers.map(hex)).not.toContain(hex(APP1));
  expect(markers.map(hex)).not.toContain(hex(COM));
});

test("clean: the file is tables, frame header and scan only", () => {
  // No APPn of any number (0xe0..0xef) either: exiftool must not have moved
  // anything into an APP segment of its own.
  const { markers } = fileOf("clean");
  const structural = new Set([0xdb, 0xc4, 0xc0, 0xc2, 0xdd, SOS]); // DQT DHT SOF0 SOF2 DRI SOS
  for (const m of markers) expect(structural.has(m)).toBe(true);
  expect(markers[markers.length - 1]).toBe(SOS);
});

test("clean: no encoder string anywhere in the bytes", () => {
  const { bytes } = fileOf("clean");
  expect(bytes.includes("Lavc")).toBe(false);
  expect(bytes.includes("JFIF")).toBe(false);
  expect(bytes.includes("Exif")).toBe(false);
});

test("clean: exiftool reads back no JFIF, no EXIF and no comment", () => {
  const { tags } = fileOf("clean");
  for (const key of Object.keys(tags)) {
    expect(key.startsWith("JFIF:")).toBe(false);
    expect(key.startsWith("EXIF:")).toBe(false);
  }
  expect(str(tags, "File:Comment")).toBe("");
});

test("clean: still decodes without a decoder complaint", () => {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", fileOf("clean").output, "-f", "null", "-"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stderr.trim()).toBe("");
});

test("clean: decodes to the same picture as the engine copy of the same seed", () => {
  // The photo graph has no clock-seeded op, so the two renders match byte for
  // byte before the identity pass; after it, only the segment list differs.
  const frames = (file: string): Buffer =>
    spawnSync(FFMPEG, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
      maxBuffer: 64 * 1024 * 1024,
    }).stdout;
  const engine = frames(fileOf("engine").output);
  expect(engine.length).toBe(640 * 480);
  expect(frames(fileOf("clean").output).equals(engine)).toBe(true);
});
