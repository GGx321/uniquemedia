import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTRAIT_MIN_LIKENESS } from "../../shared/engine";
import { defaultFaceGateConfig } from "../face/config";
import { isPickablePortrait, isPortraitPhoto } from "./portraits";
import type { PhotoSidecar, PhotoQa } from "./schemas";
import { SAMPLE_SOURCE } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, S5.3a: what makes a photo a «portrait» (a generated reference portrait drawn from an imported photo) and when one may become the master (I5.17).

function sidecar(source: PhotoSidecar["source"], qa: PhotoQa = {}): PhotoSidecar {
  return {
    schemaVersion: 1,
    id: "photo-0001",
    avatarId: "avatar-0001",
    file: "photo-0001.png",
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: 1,
    sha256: "a".repeat(64),
    source,
    qa,
    createdAt: "2026-10-11T10:00:00.000Z",
  };
}

const generated = (extra: Partial<typeof SAMPLE_SOURCE>) => sidecar({ ...SAMPLE_SOURCE, ...extra });
const portrait = (faceCos: number | undefined, qa: PhotoQa = {}) => sidecar({ ...SAMPLE_SOURCE, slot: "portrait-1" }, faceCos === undefined ? qa : { faceCos, ...qa });

describe("isPortraitPhoto", () => {
  test.each(["portrait-1", "portrait-2", "portrait-3", "portrait-4", "portrait-5"])("accepts a generated photo in the slot %s", (slot) => {
    expect(isPortraitPhoto(generated({ slot }))).toBe(true);
  });

  test.each(["portrait-0", "portrait-6", "portrait-10", "portrait-", "portrait-1x", "xportrait-1", "Portrait-1", "candidate-1", "slot-1"])("refuses the slot %s", (slot) => {
    expect(isPortraitPhoto(generated({ slot }))).toBe(false);
  });

  test("refuses a generated photo with no slot", () => {
    expect(isPortraitPhoto(generated({}))).toBe(false);
  });

  test("refuses a run photo, even one whose slot reads like a portrait's", () => {
    expect(isPortraitPhoto(generated({ slot: "portrait-2", category: "cafe" }))).toBe(false);
  });

  test("refuses an imported photo", () => {
    expect(isPortraitPhoto(sidecar({ kind: "imported", importedAt: "2026-10-11T10:00:00.000Z" }))).toBe(false);
  });
});

describe("isPickablePortrait (I5.17)", () => {
  test("accepts a portrait at exactly the gate", () => {
    expect(isPickablePortrait(portrait(PORTRAIT_MIN_LIKENESS))).toBe(true);
  });

  test("refuses a portrait one step under the gate", () => {
    expect(isPickablePortrait(portrait(0.5499))).toBe(false);
  });

  test("accepts a portrait at likeness 1", () => {
    expect(isPickablePortrait(portrait(1))).toBe(true);
  });

  test("refuses a portrait with no stored likeness", () => {
    expect(isPickablePortrait(portrait(undefined))).toBe(false);
  });

  test("refuses a portrait whose stored age verdict fails today's threshold", () => {
    expect(isPickablePortrait(portrait(0.8, { age: { adult: false, confidence: 0.99 } }))).toBe(false);
  });

  test("accepts a portrait whose stored age verdict passes", () => {
    expect(isPickablePortrait(portrait(0.8, { age: { adult: true, confidence: 1 } }))).toBe(true);
  });

  test("refuses a photo that is not a portrait, whatever its likeness", () => {
    expect(isPickablePortrait(sidecar({ ...SAMPLE_SOURCE, slot: "candidate-1" }, { faceCos: 0.9 }))).toBe(false);
  });
});

describe("the gate", () => {
  test("the contract's PORTRAIT_MIN_LIKENESS is the face gate's own fixed threshold", () => {
    expect(defaultFaceGateConfig().identity.strategy).toEqual({ kind: "fixed-threshold", threshold: PORTRAIT_MIN_LIKENESS });
  });
});

describe("the source photo has one writer (I5.16)", () => {
  const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

  function productionFiles(): string[] {
    return readdirSync(ENGINE_DIR, { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => join(ENGINE_DIR, f))
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".node-test.ts") && !f.split(sep).includes("testing"));
  }

  test("only engine.ts writes a photo of kind imported, and once", () => {
    const writers = productionFiles().flatMap((file) => {
      const count = [...readFileSync(file, "utf8").matchAll(/kind:\s*"imported"/g)].length;
      return count === 0 ? [] : [`${file.slice(ENGINE_DIR.length + 1)}:${count}`];
    });
    expect(writers).toEqual(["engine.ts:1"]);
  });
});
