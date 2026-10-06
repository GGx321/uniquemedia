import { describe, expect, test } from "bun:test";
import { EngineInit } from "../control";
import { resolveMusicCdnBase } from "./cdnOverride";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The E2E-only mock CDN (invariant 31, S11): honoured by an E2E build, inert in every other, whatever main sends.

describe("resolveMusicCdnBase", () => {
  test("a build without the E2E flag never has a mock CDN, whatever main asked for", () => {
    expect(resolveMusicCdnBase("http://127.0.0.1:5555", false)).toBeNull();
    expect(resolveMusicCdnBase("https://evil.example", false)).toBeNull();
    expect(resolveMusicCdnBase(undefined, false)).toBeNull();
  });

  test("an E2E build takes the requested mock, and none when none is asked for", () => {
    expect(resolveMusicCdnBase("http://127.0.0.1:5555", true)).toBe("http://127.0.0.1:5555");
    expect(resolveMusicCdnBase(undefined, true)).toBeNull();
  });
});

describe("the init message's mock CDN field", () => {
  const base = {
    kind: "control",
    type: "init",
    ledgerPath: "/tmp/u/ledger.jsonl",
    defaultLibraryPath: "/tmp/u/library",
    rawDir: "/tmp/u/raw",
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: "/tmp/library",
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
      imageAgeCheck: "on",
      imageQuality: "low",
      cameraRealism: false,
      exportPath: "/tmp/export",
      renderConcurrency: "auto",
    },
    encryptionAvailable: true,
    notices: [],
  };

  test("is optional", () => {
    expect(EngineInit.safeParse(base).success).toBe(true);
  });

  test("takes an http or https URL", () => {
    expect(EngineInit.safeParse({ ...base, musicCdnBaseUrl: "http://127.0.0.1:5555" }).success).toBe(true);
    expect(EngineInit.safeParse({ ...base, musicCdnBaseUrl: "https://127.0.0.1:5555" }).success).toBe(true);
  });

  test.each(["file:///etc/passwd", "ftp://127.0.0.1", "not a url", ""])("refuses %j", (value) => {
    expect(EngineInit.safeParse({ ...base, musicCdnBaseUrl: value }).success).toBe(false);
  });
});
