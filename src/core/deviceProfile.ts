import { makeRng, rngPick, rngInt } from "./rng";

/** Main back-lens geometry plus the `LensModel` string iOS writes for it.
 *  Video ignores this block; only the EXIF path reads it. */
export interface CameraProfile {
  lensModel: string; // "iPhone 15 Pro back triple camera 6.765mm f/1.78"
  focalMm: number; // physical focal length of the main lens
  focal35: number; // 35mm-equivalent focal length
  fNumber: number; // main-lens aperture
}

/** A plausible daylight handheld exposure. `ApertureValue`/`ShutterSpeedValue`
 *  are APEX encodings of `fNumber`/`exposureTimeSec` and are deliberately NOT
 *  stored: they are computed where they are written, so the two can never
 *  disagree. */
export interface ExposureProfile {
  isoSpeed: number; // 20..64
  exposureTimeSec: number; // 1/2000 .. 1/120 s
}

/** A spoofed "shot on iPhone" identity, consistent across model/iOS/location/timezone/date. */
export interface DeviceProfile {
  make: string; // "Apple"
  model: string; // e.g. "iPhone 15 Pro Max"
  software: string; // e.g. "26.4"
  creationLocal: string; // "2026-06-05T13:06:22-0800" (local time + tz, for com.apple.quicktime.creationdate)
  creationUtc: string; // "2026-06-05T21:06:22.000000Z" (for creation_time)
  gpsISO6709: string; // "+34.0522-118.2437+000.000/" (for com.apple.quicktime.location.ISO6709)
  lat: number; // decimal latitude, e.g. 34.0522
  lon: number; // decimal longitude, e.g. -118.2437
  camera: CameraProfile;
  exposure: ExposureProfile;
}

// iPhone 11 .. 17 Pro Max — human-readable model strings as written by iOS.
const MODELS = [
  "iPhone 11", "iPhone 11 Pro", "iPhone 11 Pro Max",
  "iPhone 12 mini", "iPhone 12", "iPhone 12 Pro", "iPhone 12 Pro Max",
  "iPhone 13 mini", "iPhone 13", "iPhone 13 Pro", "iPhone 13 Pro Max",
  "iPhone 14", "iPhone 14 Plus", "iPhone 14 Pro", "iPhone 14 Pro Max",
  "iPhone 15", "iPhone 15 Plus", "iPhone 15 Pro", "iPhone 15 Pro Max",
  "iPhone 16", "iPhone 16 Plus", "iPhone 16 Pro", "iPhone 16 Pro Max",
  "iPhone 17", "iPhone 17 Pro", "iPhone 17 Pro Max",
] as const;

type Model = (typeof MODELS)[number];

/** "dual wide" for two-lens phones, "triple" for three. The word appears
 *  verbatim in `LensModel`. Apple's "Fusion" branding never reaches EXIF. */
type LensCount = "dual wide" | "triple";

interface LensSpec {
  focalMm: number;
  focal35: number;
  fNumber: number;
}

// Main-lens optics per hardware generation.
//
// Provenance for 6.765mm: that is the current-iOS value reported by every
// 48MP Pro-tier main lens. Apple's iOS 17.4 calibration update changed the
// reported figure for the same physical lens from 6.86mm, which broke
// Lightroom's lens-profile matching. `sampleDeviceProfile` only ever writes
// current iOS versions (see IOS_VERSIONS), so 6.765 is correct throughout;
// 6.86 would be right only for a 14 Pro/Pro Max pinned to iOS <= 17.3.
//
// UNVERIFIED: the focal length for iPhone 15 / 15 Plus and for the base
// iPhone 17 is inferred from the iPhone 16 pattern, not read off a real
// capture. Treat those three as a plausible guess, not a measurement.
const LENS_11: LensSpec = { focalMm: 4.25, focal35: 26, fNumber: 1.8 };
const LENS_12: LensSpec = { focalMm: 4.2, focal35: 26, fNumber: 1.6 };
const LENS_12_PRO_MAX: LensSpec = { focalMm: 5.1, focal35: 26, fNumber: 1.6 };
const LENS_13: LensSpec = { focalMm: 5.1, focal35: 26, fNumber: 1.6 };
const LENS_13_PRO: LensSpec = { focalMm: 5.7, focal35: 26, fNumber: 1.5 };
const LENS_48MP_PRO: LensSpec = { focalMm: 6.765, focal35: 24, fNumber: 1.78 };
const LENS_15_16_BASE: LensSpec = { focalMm: 5.96, focal35: 26, fNumber: 1.6 };

/** Every model in MODELS, checked at compile time: dropping an entry (or adding
 *  a model without one) is a type error, not a runtime `undefined`. */
const CAMERAS: Record<Model, { lens: LensSpec; lenses: LensCount }> = {
  "iPhone 11": { lens: LENS_11, lenses: "dual wide" },
  "iPhone 11 Pro": { lens: LENS_11, lenses: "triple" },
  "iPhone 11 Pro Max": { lens: LENS_11, lenses: "triple" },
  "iPhone 12 mini": { lens: LENS_12, lenses: "dual wide" },
  "iPhone 12": { lens: LENS_12, lenses: "dual wide" },
  "iPhone 12 Pro": { lens: LENS_12, lenses: "triple" },
  "iPhone 12 Pro Max": { lens: LENS_12_PRO_MAX, lenses: "triple" },
  "iPhone 13 mini": { lens: LENS_13, lenses: "dual wide" },
  "iPhone 13": { lens: LENS_13, lenses: "dual wide" },
  "iPhone 13 Pro": { lens: LENS_13_PRO, lenses: "triple" },
  "iPhone 13 Pro Max": { lens: LENS_13_PRO, lenses: "triple" },
  "iPhone 14": { lens: LENS_13_PRO, lenses: "dual wide" },
  "iPhone 14 Plus": { lens: LENS_13_PRO, lenses: "dual wide" },
  "iPhone 14 Pro": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 14 Pro Max": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 15": { lens: LENS_15_16_BASE, lenses: "dual wide" },
  "iPhone 15 Plus": { lens: LENS_15_16_BASE, lenses: "dual wide" },
  "iPhone 15 Pro": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 15 Pro Max": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 16": { lens: LENS_15_16_BASE, lenses: "dual wide" },
  "iPhone 16 Plus": { lens: LENS_15_16_BASE, lenses: "dual wide" },
  "iPhone 16 Pro": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 16 Pro Max": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 17": { lens: LENS_15_16_BASE, lenses: "dual wide" },
  "iPhone 17 Pro": { lens: LENS_48MP_PRO, lenses: "triple" },
  "iPhone 17 Pro Max": { lens: LENS_48MP_PRO, lenses: "triple" },
};

/** Verified pattern: `iPhone <Model> back <dual wide|triple> camera <f>mm f/<N>`. */
function cameraFor(model: Model): CameraProfile {
  const { lens, lenses } = CAMERAS[model];
  return {
    lensModel: `${model} back ${lenses} camera ${lens.focalMm}mm f/${lens.fNumber}`,
    focalMm: lens.focalMm,
    focal35: lens.focal35,
    fNumber: lens.fNumber,
  };
}

const IOS_VERSIONS = ["26.0", "26.0.1", "26.1", "26.2", "26.3", "26.3.1", "26.4"];

// US cities with coordinates and standard UTC offset (hours).
const CITIES = [
  { lat: 34.0522, lon: -118.2437, tz: -8 }, // Los Angeles
  { lat: 40.7128, lon: -74.006, tz: -5 }, // New York
  { lat: 41.8781, lon: -87.6298, tz: -6 }, // Chicago
  { lat: 25.7617, lon: -80.1918, tz: -5 }, // Miami
  { lat: 29.7604, lon: -95.3698, tz: -6 }, // Houston
  { lat: 47.6062, lon: -122.3321, tz: -8 }, // Seattle
  { lat: 39.7392, lon: -104.9903, tz: -7 }, // Denver
  { lat: 33.749, lon: -84.388, tz: -5 }, // Atlanta
];

const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");

/** Signed fixed-width ISO6709 component, e.g. signFixed(-118.2437,3,4) => "-118.2437". */
function signFixed(v: number, intDigits: number, frac: number): string {
  const sign = v < 0 ? "-" : "+";
  const [int, dec] = Math.abs(v).toFixed(frac).split(".");
  return sign + int.padStart(intDigits, "0") + "." + dec;
}

function stamp(d: Date, tzSuffix: string): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${tzSuffix}`
  );
}

/**
 * Deterministically derive a plausible iPhone identity from a seed.
 * `nowMs` is supplied by the host (kept out of core for determinism); the
 * creation date is placed 1..45 days before it.
 */
export function sampleDeviceProfile(seed: number, nowMs: number): DeviceProfile {
  const rng = makeRng(seed);
  const model = rngPick(rng, MODELS);
  const software = rngPick(rng, IOS_VERSIONS);
  const city = rngPick(rng, CITIES);

  const ageMs = rngInt(rng, 1, 45) * 86_400_000 + rngInt(rng, 0, 86_399) * 1000;
  const utcMs = nowMs - ageMs;
  const utc = new Date(utcMs);
  const local = new Date(utcMs + city.tz * 3_600_000);

  const tzSuffix = (city.tz < 0 ? "-" : "+") + pad(city.tz) + "00";

  // Drawn LAST, on purpose: the video path shipped before these fields existed,
  // and every draw above must keep yielding exactly what it yielded then.
  // Appending here leaves make/model/software/dates/GPS bit-identical.
  const isoSpeed = rngInt(rng, 20, 64);
  // Drawn as a shutter denominator rather than as seconds, so the value is a
  // clean 1/N — which is what a camera reports and what EXIF stores.
  const exposureTimeSec = 1 / rngInt(rng, 120, 2000);

  return {
    make: "Apple",
    model,
    software,
    creationLocal: stamp(local, tzSuffix),
    creationUtc: stamp(utc, ".000000Z"),
    gpsISO6709: signFixed(city.lat, 2, 4) + signFixed(city.lon, 3, 4) + signFixed(0, 3, 3) + "/",
    lat: city.lat,
    lon: city.lon,
    camera: cameraFor(model),
    exposure: { isoSpeed, exposureTimeSec },
  };
}
