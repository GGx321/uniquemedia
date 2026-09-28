import { describe, expect, test } from "bun:test";
import type { PhotoSummary } from "../../shared/engine";
import { PhotoSidecarSchema, type GeneratedPhotoSource, type PhotoSidecar } from "./schemas";
import { finalizePhotoList, looksLikeRunPhoto, photoSummaryFrom } from "./photoRecords";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T8b: mapping the library's own photo sidecars into the contract's
// PhotoSummary (photos.list) — mirrors avatars/records.ts's own mapping for
// avatars.

function generatedSource(overrides: Partial<GeneratedPhotoSource> = {}): GeneratedPhotoSource {
  return {
    kind: "generated",
    model: "x-ai/grok-imagine-image-2.0",
    provider: "openrouter",
    jobId: "job-0001",
    attemptId: "run-00000001:slot-1#1",
    promptSha: "a".repeat(64),
    prompt: "A friend catches her mid-laugh at the kitchen counter.",
    slot: "slot-1",
    category: "home",
    costMicros: 50_000,
    ...overrides,
  };
}

function runPhotoSidecar(overrides: Partial<PhotoSidecar> = {}): PhotoSidecar {
  return {
    schemaVersion: 1,
    id: "photo-0002",
    avatarId: "avatar-0001",
    file: "photo-0002.png",
    mediaType: "image/png",
    width: 1024,
    height: 1365,
    bytes: 2048,
    sha256: "b".repeat(64),
    source: generatedSource(),
    qa: {},
    createdAt: "2026-09-24T11:00:00.000Z",
    ...overrides,
  };
}

function candidateSidecar(overrides: Partial<PhotoSidecar> = {}): PhotoSidecar {
  return runPhotoSidecar({
    source: generatedSource({
      attemptId: "candidate-1#1",
      prompt: "Head-and-shoulders portrait photo",
      slot: undefined,
      category: undefined, // a candidate, not a run photo.
    }),
    ...overrides,
  });
}

describe("looksLikeRunPhoto", () => {
  test("is true for a generated photo with a scene category", () => {
    expect(looksLikeRunPhoto(runPhotoSidecar())).toBe(true);
  });

  test("is false for a candidate (generated, no category)", () => {
    expect(looksLikeRunPhoto(candidateSidecar())).toBe(false);
  });

  test("is false for an imported photo", () => {
    const imported = runPhotoSidecar({ source: { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z", confirmedAiPersona: true } });
    expect(looksLikeRunPhoto(imported)).toBe(false);
  });
});

describe("photoSummaryFrom", () => {
  test("maps a run photo to the contract's shape", () => {
    expect(photoSummaryFrom(runPhotoSidecar())).toEqual({
      photoId: "photo-0002",
      avatarId: "avatar-0001",
      runId: "run-00000001",
      category: "home",
      createdAt: "2026-09-24T11:00:00.000Z",
    });
  });

  test("a legacy 2K run photo lists like any other, with no resolution in its summary (2K removed, 2026-09-29)", () => {
    const legacy = PhotoSidecarSchema.parse({ ...runPhotoSidecar(), resolution: "2k", width: 1584, height: 2816 });
    const summary = photoSummaryFrom(legacy);
    expect(summary?.photoId).toBe("photo-0002");
    expect(summary !== null && "resolution" in summary).toBe(false);
  });

  test("carries the face-similarity and age qa badges when the sidecar has them", () => {
    const withQa = runPhotoSidecar({ qa: { faceCos: 0.81, age: { adult: true, confidence: 0.95 } } });
    expect(photoSummaryFrom(withQa)?.qa).toEqual({ faceCos: 0.81, age: { adult: true, confidence: 0.95 } });
  });

  test("leaves qa unset when the sidecar carries none of the badge fields", () => {
    const withOtherQa = runPhotoSidecar({ qa: { pdq: "c".repeat(64), headRatio: 0.3 } });
    expect(photoSummaryFrom(withOtherQa)?.qa).toBeUndefined();
  });

  test("is null for a candidate: no scene category, not a gallery photo", () => {
    expect(photoSummaryFrom(candidateSidecar())).toBeNull();
  });

  test("is null for an imported photo", () => {
    const imported = runPhotoSidecar({ source: { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z", confirmedAiPersona: true } });
    expect(photoSummaryFrom(imported)).toBeNull();
  });

  test("is null for a corrupt sidecar: a category the contract no longer recognises", () => {
    const corrupt = runPhotoSidecar({ source: generatedSource({ category: "retired-category" }) });
    expect(photoSummaryFrom(corrupt)).toBeNull();
    expect(looksLikeRunPhoto(corrupt)).toBe(true); // the caller must still know this one is worth logging
  });

  test("is null for a corrupt sidecar: an attemptId whose prefix is not a valid id", () => {
    const corrupt = runPhotoSidecar({ source: generatedSource({ attemptId: "NOT-VALID:slot-1#1" }) });
    expect(photoSummaryFrom(corrupt)).toBeNull();
    expect(looksLikeRunPhoto(corrupt)).toBe(true);
  });
});

describe("finalizePhotoList", () => {
  function summaryAt(minute: number): PhotoSummary {
    return {
      photoId: `photo-${String(minute).padStart(4, "0")}`,
      avatarId: "avatar-0001",
      runId: "run-00000001",
      category: "home",
      createdAt: `2026-09-24T11:${String(minute).padStart(2, "0")}:00.000Z`,
    };
  }

  test("sorts newest first", () => {
    const photos = [summaryAt(1), summaryAt(3), summaryAt(2)];
    expect(finalizePhotoList(photos, 10).map((p) => p.photoId)).toEqual([summaryAt(3), summaryAt(2), summaryAt(1)].map((p) => p.photoId));
  });

  test("breaks a tied createdAt deterministically by photoId, descending", () => {
    const a = { ...summaryAt(1), photoId: "photo-aaaa" };
    const b = { ...summaryAt(1), photoId: "photo-bbbb" };
    expect(finalizePhotoList([a, b], 10).map((p) => p.photoId)).toEqual(["photo-bbbb", "photo-aaaa"]);
  });

  test("caps at the limit, keeping the newest", () => {
    const photos = [summaryAt(1), summaryAt(2), summaryAt(3)];
    expect(finalizePhotoList(photos, 2).map((p) => p.photoId)).toEqual([summaryAt(3), summaryAt(2)].map((p) => p.photoId));
  });

  test("the limit boundary: exactly at the limit keeps everything, one past it drops the oldest", () => {
    const photos = [summaryAt(1), summaryAt(2), summaryAt(3)];
    expect(finalizePhotoList(photos, 3)).toHaveLength(3);
    expect(finalizePhotoList(photos, 2)).toHaveLength(2);
  });
});
