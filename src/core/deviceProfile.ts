import { makeRng, rngPick, rngInt } from "./rng";

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
];

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

  return {
    make: "Apple",
    model,
    software,
    creationLocal: stamp(local, tzSuffix),
    creationUtc: stamp(utc, ".000000Z"),
    gpsISO6709: signFixed(city.lat, 2, 4) + signFixed(city.lon, 3, 4) + signFixed(0, 3, 3) + "/",
    lat: city.lat,
    lon: city.lon,
  };
}
