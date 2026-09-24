import { describe, expect, test } from "bun:test";
import { isLibraryId } from "./ids";
import { AvatarManifestSchema, PhotoSidecarSchema } from "./schemas";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "avatar-0001",
    name: "Mia",
    language: "en",
    age: 25,
    traits: { hair: "chestnut", eyes: "hazel" },
    descriptor: "a 25-year-old woman with hazel eyes and chestnut hair",
    masterPhotoId: "photo-0001",
    status: "active",
    createdAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

function validSidecar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "photo-0001",
    avatarId: "avatar-0001",
    file: "photo-0001.png",
    mediaType: "image/png",
    width: 1024,
    height: 1365,
    bytes: 2048,
    sha256: "b".repeat(64),
    source: {
      kind: "generated",
      model: "x-ai/grok-imagine-image-2.0",
      provider: "xai",
      jobId: "job-1",
      attemptId: "slot#1",
      promptSha: "a".repeat(64),
      prompt: "Head-and-shoulders portrait photo",
      costMicros: 50_000,
    },
    qa: {},
    createdAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

function sourceWith(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = validSidecar().source;
  if (typeof base !== "object" || base === null) throw new Error("fixture source must be an object");
  return { ...base, ...overrides };
}

describe("isLibraryId", () => {
  test("accepts lowercase letters, digits and dashes of 8 to 64 chars", () => {
    expect(isLibraryId("abcd-123")).toBe(true);
    expect(isLibraryId("a".repeat(64))).toBe(true);
    expect(isLibraryId("0b8f0e9c-7d7e-4c55-9a51-2f0d4c1b8e3a")).toBe(true);
  });

  test("rejects ids that are one char too short or too long", () => {
    expect(isLibraryId("abcd-12")).toBe(false);
    expect(isLibraryId("a".repeat(65))).toBe(false);
  });

  test("rejects uppercase, dots, slashes and empty strings", () => {
    expect(isLibraryId("ABCD-1234")).toBe(false);
    expect(isLibraryId("../abcdefgh")).toBe(false);
    expect(isLibraryId("abcd/efgh")).toBe(false);
    expect(isLibraryId("abcdefgh.png")).toBe(false);
    expect(isLibraryId("")).toBe(false);
  });
});

describe("AvatarManifestSchema", () => {
  test("accepts a valid manifest unchanged", () => {
    expect<unknown>(AvatarManifestSchema.parse(validManifest())).toEqual(validManifest());
  });

  test("accepts the age bounds 21 and 35", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ age: 21 })).success).toBe(true);
    expect(AvatarManifestSchema.safeParse(validManifest({ age: 35 })).success).toBe(true);
  });

  test("rejects age 20, one below the adult floor", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ age: 20 })).success).toBe(false);
  });

  test("rejects age 36, one above the ceiling", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ age: 36 })).success).toBe(false);
  });

  test("rejects a fractional age", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ age: 25.5 })).success).toBe(false);
  });

  test("rejects a language other than en or ru", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ language: "de" })).success).toBe(false);
  });

  test("rejects an id that breaks the id pattern", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ id: "Avatar-0001" })).success).toBe(false);
  });

  test("accepts a draft that has no master yet", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ status: "draft", masterPhotoId: null })).success).toBe(true);
  });

  test("rejects an active or archived avatar without a master", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ status: "active", masterPhotoId: null })).success).toBe(false);
    expect(AvatarManifestSchema.safeParse(validManifest({ status: "archived", masterPhotoId: null })).success).toBe(false);
  });

  test("rejects an unknown status", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ status: "pending" })).success).toBe(false);
  });

  test("rejects an unknown schema version", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ schemaVersion: 2 })).success).toBe(false);
  });
});

describe("PhotoSidecarSchema", () => {
  test("accepts a valid sidecar unchanged", () => {
    expect<unknown>(PhotoSidecarSchema.parse(validSidecar())).toEqual(validSidecar());
  });

  test("accepts optional slot, category and qa fields", () => {
    const sidecar = validSidecar({
      source: sourceWith({ slot: "slot-3", category: "glamour" }),
      qa: { age: { adult: true, confidence: 0.97 }, pdq: "f".repeat(64), faceCos: 0.77, headRatio: 0.21 },
    });
    expect<unknown>(PhotoSidecarSchema.parse(sidecar)).toEqual(sidecar);
  });

  test("rejects a source kind other than generated", () => {
    const sidecar = validSidecar({ source: sourceWith({ kind: "user" }) });
    expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
  });

  test("rejects a fractional costMicros", () => {
    const sidecar = validSidecar({ source: sourceWith({ costMicros: 0.5 }) });
    expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
  });

  test("rejects a negative costMicros", () => {
    const sidecar = validSidecar({ source: sourceWith({ costMicros: -1 }) });
    expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
  });

  test("rejects a media type outside the image allowlist", () => {
    expect(PhotoSidecarSchema.safeParse(validSidecar({ mediaType: "image/svg+xml" })).success).toBe(false);
  });

  test("rejects a file name that does not match the id and media type", () => {
    expect(PhotoSidecarSchema.safeParse(validSidecar({ file: "photo-0002.png" })).success).toBe(false);
    expect(PhotoSidecarSchema.safeParse(validSidecar({ file: "photo-0001.jpg" })).success).toBe(false);
  });

  test("rejects a sidecar without the image's sha256", () => {
    const { sha256: _omitted, ...rest } = validSidecar();
    expect(PhotoSidecarSchema.safeParse(rest).success).toBe(false);
  });

  test("rejects a sha256 that is not 64 lowercase hex chars", () => {
    expect(PhotoSidecarSchema.safeParse(validSidecar({ sha256: "B".repeat(64) })).success).toBe(false);
  });

  test("rejects a pdq hash that is not 64 lowercase hex chars", () => {
    expect(PhotoSidecarSchema.safeParse(validSidecar({ qa: { pdq: "xyz" } })).success).toBe(false);
  });

  test("rejects a promptSha that is not a sha256 hex digest", () => {
    const sidecar = validSidecar({ source: sourceWith({ promptSha: "abc" }) });
    expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
  });
});
