import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exiftool, type Tags } from "exiftool-vendored";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestPhoto } from "./testClip";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { sampleDeviceProfile, type DeviceProfile } from "../core/deviceProfile";
import type { ResolvedPhotoOptions } from "../core/photo/types";

/** `readRaw` hands back group-qualified keys ("EXIF:Make") that the `Tags`
 *  interface does not name, so widen it rather than reach past the typings. */
interface RawExif extends Tags {
  [key: string]: unknown;
}

const NOW_MS = 1_748_000_000_000; // fixed for determinism
const SEEDS = [42, 7, 3]; // different models, lens counts and cities

const OPTS: ResolvedPhotoOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 30,
  spoofMetadata: true,
  // These predate the edge option and pin the crop behaviour they were
  // written against; the fit direction has its own tests.
  edge: { mode: "crop" },
};

/** The UTC offset each generator city sits at, keyed by latitude. Independent
 *  of deviceProfile's own table on purpose: if the two ever disagree, the
 *  timestamp and the location disagree, which is exactly the tell to catch. */
const CITY_OFFSET_BY_LAT: Record<string, string> = {
  "34.0522": "-08:00", // Los Angeles
  "40.7128": "-05:00", // New York
  "41.8781": "-06:00", // Chicago
  "25.7617": "-05:00", // Miami
  "29.7604": "-06:00", // Houston
  "47.6062": "-08:00", // Seattle
  "39.7392": "-07:00", // Denver
  "33.749": "-05:00", // Atlanta
};

const exec = new PhotoExecutor();
let dir: string;
const profiles = new Map<number, DeviceProfile>();
const tags = new Map<number, RawExif>();
const outputs: Record<number, string> = {};

/** The EXIF as actually stored: `-n` defeats PrintConv so the assertions see
 *  the written value, not exiftool's prettied rendering of it. */
function str(t: RawExif, key: string): string {
  const v = t[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function num(t: RawExif, key: string): number {
  const v = t[key];
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-exif-"));
  const input = join(dir, "in.jpg");
  makeTestPhoto(input, 640, 480);
  const info = await exec.probe(input);

  for (const seed of SEEDS) {
    const profile = sampleDeviceProfile(seed, NOW_MS);
    const out = join(dir, `copy_${seed}.jpg`);
    await exec.render(input, info, samplePhotoRecipe(OPTS, seed, 1), out);
    await exec.applyDeviceMetadata(out, profile);
    outputs[seed] = out;
    profiles.set(seed, profile);
    tags.set(seed, await exiftool.readRaw<RawExif>(out, ["-n", "-G0"]));
  }
}, 120_000);

// NOTE: do not call `exiftool.end()` here. `exiftool` is a process-wide
// singleton shared with every other test file and with the executors
// themselves, and ending it is irreversible — the next write anywhere fails
// with "BatchCluster has ended, cannot enqueue". Bun exits cleanly without it.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `check` against every seed, so a passing assertion is not an accident
 *  of one model or one city. */
function forEachProfile(check: (t: RawExif, p: DeviceProfile, seed: number) => void): void {
  for (const seed of SEEDS) {
    const t = tags.get(seed);
    const p = profiles.get(seed);
    if (!t || !p) throw new Error(`fixture missing for seed ${seed}`);
    check(t, p, seed);
  }
}

test("Make is Apple and Model is the profile's iPhone", () => {
  forEachProfile((t, p) => {
    expect(str(t, "EXIF:Make")).toBe("Apple");
    expect(str(t, "EXIF:Model")).toBe(p.model);
  });
});

test("HostComputer duplicates Model, as a Camera-app capture does", () => {
  forEachProfile((t, p) => {
    expect(str(t, "EXIF:HostComputer")).toBe(p.model);
    expect(str(t, "EXIF:HostComputer")).toBe(str(t, "EXIF:Model"));
  });
});

test("Software is the bare iOS version", () => {
  // Asserted against the stored bytes, not the JSON readback: exiftool's -json
  // emits a numeric-looking string as a JSON number, so "26.0" comes back as
  // 26 and a correct write would look like a bug. The ASCII EXIF field is
  // NUL-terminated, so this pins the exact string including its trailing zero.
  forEachProfile((_t, p, seed) => {
    expect(p.software).toMatch(/^\d+(\.\d+)*$/);
    const bytes = readFileSync(outputs[seed]);
    expect(bytes.includes(Buffer.from(`${p.software}\0`, "latin1"))).toBe(true);
  });
});

test("ColorSpace is Uncalibrated, not sRGB", () => {
  // iOS captures are Display P3 and carry the real profile in the ICC block.
  // A literal sRGB here is the single clearest "this file was processed" tell.
  forEachProfile((t) => {
    expect(num(t, "EXIF:ColorSpace")).toBe(0xffff);
    expect(num(t, "EXIF:ColorSpace")).not.toBe(1); // 1 == sRGB
  });
});

test("all three timestamps carry the profile's local capture time", () => {
  forEachProfile((t, p) => {
    // "2026-04-27T09:14:57-0700" -> "2026:04:27 09:14:57"
    const expected = p.creationLocal.slice(0, 19).replace(/-/g, ":").replace("T", " ");
    expect(str(t, "EXIF:DateTimeOriginal")).toBe(expected);
    expect(str(t, "EXIF:CreateDate")).toBe(expected);
    expect(str(t, "EXIF:ModifyDate")).toBe(expected);
  });
});

test("timestamps use the EXIF colon-separated date form", () => {
  forEachProfile((t) => {
    expect(str(t, "EXIF:DateTimeOriginal")).toMatch(/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

test("the UTC offset agrees with the city the profile picked", () => {
  forEachProfile((t, p) => {
    const expected = CITY_OFFSET_BY_LAT[String(p.lat)];
    expect(expected).toBeDefined();
    expect(str(t, "EXIF:OffsetTime")).toBe(expected);
    expect(str(t, "EXIF:OffsetTimeOriginal")).toBe(expected);
    expect(str(t, "EXIF:OffsetTimeDigitized")).toBe(expected);
  });
});

test("the UTC offset also agrees with the profile's own local timestamp", () => {
  forEachProfile((t, p) => {
    // "…-0700" -> "-07:00". A mismatch here means the date and the offset were
    // derived from different places.
    const suffix = p.creationLocal.slice(-5);
    expect(str(t, "EXIF:OffsetTime")).toBe(`${suffix.slice(0, 3)}:${suffix.slice(3)}`);
  });
});

test("SubSecTime is three digits, not six", () => {
  forEachProfile((t) => {
    expect(str(t, "EXIF:SubSecTimeOriginal")).toMatch(/^\d{3}$/);
    expect(str(t, "EXIF:SubSecTimeDigitized")).toMatch(/^\d{3}$/);
    expect(str(t, "EXIF:SubSecTimeOriginal")).toBe(str(t, "EXIF:SubSecTimeDigitized"));
  });
});

test("GPS coordinates are the profile's city, as magnitude plus Ref", () => {
  forEachProfile((t, p) => {
    // EXIF stores an unsigned magnitude and puts the hemisphere in the Ref tag.
    expect(num(t, "EXIF:GPSLatitude")).toBeCloseTo(Math.abs(p.lat), 4);
    expect(num(t, "EXIF:GPSLongitude")).toBeCloseTo(Math.abs(p.lon), 4);
    expect(str(t, "EXIF:GPSLatitudeRef")).toBe(p.lat >= 0 ? "N" : "S");
    expect(str(t, "EXIF:GPSLongitudeRef")).toBe(p.lon >= 0 ? "E" : "W");
  });
});

test("GPSAltitude is present and above sea level", () => {
  forEachProfile((t) => {
    expect(Number.isFinite(num(t, "EXIF:GPSAltitude"))).toBe(true);
    expect(num(t, "EXIF:GPSAltitude")).toBeGreaterThan(0);
    expect(num(t, "EXIF:GPSAltitudeRef")).toBe(0); // 0 == above sea level
  });
});

test("LensMake is Apple and LensModel is the profile's lens string", () => {
  forEachProfile((t, p) => {
    expect(str(t, "EXIF:LensMake")).toBe("Apple");
    expect(str(t, "EXIF:LensModel")).toBe(p.camera.lensModel);
  });
});

test("focal length and aperture match the camera the lens string names", () => {
  forEachProfile((t, p) => {
    expect(num(t, "EXIF:FocalLength")).toBeCloseTo(p.camera.focalMm, 4);
    expect(num(t, "EXIF:FocalLengthIn35mmFormat")).toBe(p.camera.focal35);
    expect(num(t, "EXIF:FNumber")).toBeCloseTo(p.camera.fNumber, 4);
    // The lens string must not contradict the numeric tags beside it.
    expect(str(t, "EXIF:LensModel")).toContain(`${p.camera.focalMm}mm`);
    expect(str(t, "EXIF:LensModel")).toContain(`f/${p.camera.fNumber}`);
  });
});

test("ApertureValue is the APEX encoding of FNumber, not FNumber again", () => {
  forEachProfile((t, p) => {
    const expected = 2 * Math.log2(p.camera.fNumber);
    expect(num(t, "EXIF:ApertureValue")).toBeCloseTo(expected, 3);
    // An APEX 1.78-aperture reads 1.66; writing 1.78 into both would be the bug.
    expect(num(t, "EXIF:ApertureValue")).not.toBeCloseTo(p.camera.fNumber, 3);
  });
});

test("ShutterSpeedValue is the APEX encoding of ExposureTime", () => {
  forEachProfile((t, p) => {
    const expected = -Math.log2(p.exposure.exposureTimeSec);
    expect(num(t, "EXIF:ShutterSpeedValue")).toBeCloseTo(expected, 3);
  });
});

test("ExposureTime keeps the profile's shutter denominator", () => {
  forEachProfile((t, p) => {
    const written = num(t, "EXIF:ExposureTime");
    expect(Math.round(1 / written)).toBe(Math.round(1 / p.exposure.exposureTimeSec));
    expect(written).toBeGreaterThanOrEqual(1 / 2000 - 1e-9);
    expect(written).toBeLessThanOrEqual(1 / 120 + 1e-9);
  });
});

test("ISO is the profile's daylight ISO", () => {
  forEachProfile((t, p) => {
    expect(num(t, "EXIF:ISO")).toBe(p.exposure.isoSpeed);
  });
});

test("the fixed capture-mode tags match an iPhone auto exposure", () => {
  forEachProfile((t) => {
    expect(num(t, "EXIF:ExposureProgram")).toBe(2); // Program AE
    expect(num(t, "EXIF:WhiteBalance")).toBe(0); // Auto
    expect(num(t, "EXIF:MeteringMode")).toBe(5); // Multi-segment
    expect(num(t, "EXIF:Flash")).toBe(0x10); // off, did not fire
    expect(num(t, "EXIF:Orientation")).toBe(1); // horizontal / normal
  });
});

test("the sub-second composite ties date, sub-second and offset together", () => {
  // exiftool only builds this if DateTimeOriginal, SubSecTimeOriginal and
  // OffsetTimeOriginal are all present and mutually consistent.
  forEachProfile((t) => {
    expect(str(t, "Composite:SubSecDateTimeOriginal")).toMatch(
      /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/
    );
  });
});

test("writing the same profile twice produces the same EXIF", async () => {
  const input = join(dir, "in.jpg");
  const info = await exec.probe(input);
  const profile = sampleDeviceProfile(42, NOW_MS);
  const written: string[] = [];
  for (const n of [1, 2]) {
    const out = join(dir, `determinism_${n}.jpg`);
    await exec.render(input, info, samplePhotoRecipe(OPTS, 42, 1), out);
    await exec.applyDeviceMetadata(out, profile);
    const t = await exiftool.readRaw<RawExif>(out, ["-n", "-G0"]);
    written.push(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(t)
            .filter(([k]) => k.startsWith("EXIF:"))
            .sort(([a], [b]) => a.localeCompare(b))
        )
      )
    );
  }
  // Two empty tag sets would also be equal, so require real content first.
  expect(written[0].length).toBeGreaterThan(200);
  expect(written[0]).toContain("EXIF:Make");
  expect(written[0]).toBe(written[1]);
}, 60_000);

test("no residual encoder identity survives anywhere in the file", () => {
  // An Apple EXIF block sitting next to ffmpeg's own signature is worse than no
  // spoofing at all: the two contradict each other in the same file.
  forEachProfile((t) => {
    for (const key of Object.keys(t)) {
      const value = str(t, key);
      expect(value).not.toContain("Lavc");
      expect(value).not.toContain("Lavf");
    }
  });
});
