import { describe, expect, test } from "bun:test";
import { isLibraryId } from "./ids";
import { AvatarManifestSchema, PhotoSidecarSchema } from "./schemas";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "avatar-0001",
    name: "Mia",
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

  test("accepts an optional bodyProposal (S5.2a) and keeps a manifest without one valid", () => {
    const bodyProposal = { values: { bust: "full", bodyMarks: ["mole-back"] }, seen: { bust: "photo" }, at: "2026-10-10T10:00:00.000Z" };
    expect(AvatarManifestSchema.safeParse(validManifest({ bodyProposal })).success).toBe(true);
    expect("bodyProposal" in AvatarManifestSchema.parse(validManifest())).toBe(false);
  });

  test("rejects a bodyProposal with an extra key, a bad timestamp or no timestamp", () => {
    const good = { values: {}, seen: {}, at: "2026-10-10T10:00:00.000Z" };
    expect(AvatarManifestSchema.safeParse(validManifest({ bodyProposal: { ...good, note: "x" } })).success).toBe(false);
    expect(AvatarManifestSchema.safeParse(validManifest({ bodyProposal: { ...good, at: "yesterday" } })).success).toBe(false);
    expect(AvatarManifestSchema.safeParse(validManifest({ bodyProposal: { values: {}, seen: {} } })).success).toBe(false);
  });

  test("rejects a manifest that still carries a language key", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ language: "en" })).success).toBe(false);
  });

  test("rejects any key the schema does not define", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ nickname: "M" })).success).toBe(false);
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
    expect(AvatarManifestSchema.safeParse(validManifest({ schemaVersion: 3 })).success).toBe(false);
  });

  test("a v2 manifest keeps trait values in their JSON types: a list, a number, text", () => {
    const traits = { marks: ["freckles", "mole"], heightCm: 170, vibe: "coffee, travel" };
    expect(AvatarManifestSchema.parse(validManifest({ schemaVersion: 2, traits })).traits).toEqual(traits);
  });

  test("a v1 manifest with text-only traits is still read", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ schemaVersion: 1 })).success).toBe(true);
  });

  test("rejects a v1 manifest whose traits hold a list: v1 traits were text only", () => {
    expect(AvatarManifestSchema.safeParse(validManifest({ schemaVersion: 1, traits: { marks: ["mole"] } })).success).toBe(false);
  });

  test.each([[{ nested: { a: "b" } }], [{ none: null }], [{ mixed: ["mole", 3] }]])("rejects the trait values %p", (traits) => {
    expect(AvatarManifestSchema.safeParse(validManifest({ schemaVersion: 2, traits })).success).toBe(false);
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

  test("keeps a custom category's categoryName, and a sidecar without one parses unchanged", () => {
    const labelled = validSidecar({ source: sourceWith({ category: "cat-paris-cafes", categoryName: "Кофейни Парижа" }) });
    expect<unknown>(PhotoSidecarSchema.parse(labelled)).toEqual(labelled);
    expect(PhotoSidecarSchema.safeParse(validSidecar({ source: sourceWith({ category: "home" }) })).success).toBe(true);
  });

  test("rejects an empty categoryName", () => {
    expect(PhotoSidecarSchema.safeParse(validSidecar({ source: sourceWith({ category: "cat-paris-cafes", categoryName: "" }) })).success).toBe(false);
  });

  // Owner decision 2026-09-29: 2K removed. A sidecar written while runs still
  // chose a resolution carries a `resolution` field; it must keep loading.
  describe("legacy resolution (2K removed)", () => {
    test.each(["1k", "2k"])("a sidecar carrying resolution %p still parses, and the field is dropped", (legacy) => {
      const parsed = PhotoSidecarSchema.parse({ ...validSidecar(), resolution: legacy });
      expect<unknown>(parsed).toEqual(validSidecar());
      expect("resolution" in parsed).toBe(false);
    });
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

  // T6c: the owner's own imported photo, not a generated frame (invariant 9
  // widens to "generated, or the owner's import"). Backward compatible: every
  // existing "generated" sidecar above still parses unchanged, since this
  // widens the source to a union instead of replacing it.
  describe("an imported source (T6c)", () => {
    function importedSidecar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return validSidecar({ source: { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z" }, ...overrides });
    }

    test("accepts a minimal imported source unchanged: only kind and importedAt, no confirmation, no age verdict", () => {
      expect<unknown>(PhotoSidecarSchema.parse(importedSidecar())).toEqual(importedSidecar());
    });

    // Owner decision 2026-10-05: new imports write neither, but sidecars an
    // older build wrote (the AI-persona confirmation and the one-time age
    // verdict) must keep reading exactly as they did.
    describe("a sidecar written before the 2026-10-05 removal still reads", () => {
      const legacy = importedSidecar({
        source: { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z", confirmedAiPersona: true },
        qa: { age: { adult: true, confidence: 0.92 } },
      });

      test("an imported source carrying confirmedAiPersona: true and a qa.age verdict parses, both kept as read", () => {
        expect<unknown>(PhotoSidecarSchema.parse(legacy)).toEqual(legacy);
      });

      test("a legacy confirmedAiPersona: false is still refused — the field only ever recorded a true confirmation", () => {
        const sidecar = importedSidecar({ source: { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z", confirmedAiPersona: false } });
        expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
      });
    });

    test("rejects an imported source missing importedAt", () => {
      const sidecar = validSidecar({ source: { kind: "imported" } });
      expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
    });

    test("rejects an imported source that also carries generated-only fields it should not need", () => {
      // Not required, but must not silently smuggle a fabricated cost/model in: the union is strict per branch.
      const sidecar = validSidecar({ source: { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z", costMicros: 1 } });
      expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
    });

    test("rejects importedAt that is not an ISO datetime", () => {
      const sidecar = validSidecar({ source: { kind: "imported", importedAt: "not-a-date" } });
      expect(PhotoSidecarSchema.safeParse(sidecar).success).toBe(false);
    });
  });
});
