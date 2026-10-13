import { describe, expect, test } from "bun:test";
import { PhotoSummary } from "../../shared/engine";
import type { PhotoState } from "./eligibility";
import { photoSummaryFrom } from "./photoRecords";
import { PhotoSidecarSchema, type GeneratedPhotoSource, type PhotoSidecar } from "./schemas";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, gap A): the viewer's «Seedream 5 Pro · 2K» tag has one source, the sidecar's `source.route`, written only for a slot planned on the Seedream route.
// The model id cannot say it: Seedream 5 Pro also draws the 1K moderation fallback. A photo with no `route` shows no tag.

const STATE: PhotoState = { usedIn: [], rejected: false, reserved: false, eligible: true };

function sidecar(source: Partial<GeneratedPhotoSource>): PhotoSidecar {
  return {
    schemaVersion: 1,
    id: "photo-0002",
    avatarId: "avatar-0001",
    file: "photo-0002.png",
    mediaType: "image/png",
    width: 1152,
    height: 2048,
    bytes: 2048,
    sha256: "b".repeat(64),
    source: {
      kind: "generated",
      model: "bytedance-seed/seedream-5-0-pro",
      provider: "openrouter",
      jobId: "job-0001",
      attemptId: "run-00000001:slot-1#1",
      promptSha: "a".repeat(64),
      prompt: "A friend catches her mid-laugh on the beach.",
      slot: "slot-1",
      category: "beach",
      costMicros: 45_000,
      ...source,
    },
    qa: {},
    createdAt: "2026-10-12T11:00:00.000Z",
  };
}

describe("photoSummaryFrom and the Seedream route", () => {
  test("carries the route of a photo drawn on it", () => {
    expect(photoSummaryFrom(sidecar({ route: "seedream" }), STATE)?.route).toBe("seedream");
  });

  test("shows no route on a photo the 1K moderation fallback drew, although its model is Seedream", () => {
    const summary = photoSummaryFrom(sidecar({}), STATE);
    expect(summary !== null && "route" in summary).toBe(false);
  });

  test("shows no route on a photo made before 5a.3", () => {
    const summary = photoSummaryFrom(sidecar({ model: "x-ai/grok-imagine-image-2.0", category: "home" }), STATE);
    expect(summary !== null && "route" in summary).toBe(false);
  });

  test("the summary it makes is a valid PhotoSummary", () => {
    expect(PhotoSummary.safeParse(photoSummaryFrom(sidecar({ route: "seedream" }), STATE)).success).toBe(true);
  });

  test("a sidecar with the route round-trips through the sidecar schema", () => {
    const written = sidecar({ route: "seedream" });
    expect(PhotoSidecarSchema.parse(written)).toEqual(written);
  });

  test("a sidecar with any other route is not a sidecar", () => {
    expect(PhotoSidecarSchema.safeParse(sidecar({ route: "grok" as never })).success).toBe(false);
  });
});
