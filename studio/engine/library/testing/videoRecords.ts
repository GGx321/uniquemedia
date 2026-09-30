import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MontageSpec, RelativePath } from "../../../shared/engine";

// Test-only: video records written straight to disk, the way task 3a.8b's
// commit will leave them (`avatars/<avatarId>/videos/<videoId>.json`). Every
// spec is checked against the contract's own `MontageSpec`, so a fixture can
// never drift into a shape the contract would refuse.

interface SceneSpecOptions {
  /** One collage clip over 2 to 4 photos instead of one photo clip each. */
  collage?: boolean;
  /** An own-upload cell (slice 3f) placed in a clip of its own; it never counts as a scene photo. */
  ownMediaId?: string;
}

const cell = (photoId: string) => ({ photo: { source: "scene", photoId }, focus: { x: 0.5, y: 0.4 } });

/** A complete spec of the avatar's scene photos (and optionally one own upload), valid per `MontageSpec`. */
export function sceneSpec(avatarId: string, photoIds: readonly string[], options: SceneSpecOptions = {}): MontageSpec {
  const clipCount = photoIds.length + (options.ownMediaId === undefined ? 0 : 1);
  const clips: unknown[] = options.collage
    ? [{ clipId: "clip-00000001", kind: "collage", layout: `collage${photoIds.length}`, cells: photoIds.map(cell), motion: "static", stagger: false, durationMs: 6_000, transitionIn: "cut" }]
    : photoIds.map((photoId, i) => ({
        clipId: `clip-${String(i + 1).padStart(8, "0")}`,
        kind: "photo",
        cell: cell(photoId),
        motion: "kenburns",
        durationMs: Math.floor(15_000 / Math.max(clipCount, 1) / 100) * 100,
        transitionIn: "cut",
      }));
  if (options.ownMediaId !== undefined) {
    clips.push({
      clipId: "clip-00000099",
      kind: "photo",
      cell: { photo: { source: "own", mediaId: options.ownMediaId }, focus: null },
      motion: "static",
      durationMs: options.collage ? 5_000 : Math.floor(15_000 / clipCount / 100) * 100,
      transitionIn: "cut",
    });
  }
  const spec: unknown = { schemaVersion: 1, avatarId, clips, layers: [], music: null, seed: 7 };
  return MontageSpec.parse(spec);
}

/** The JSON of a record for `spec`, with the fields the plan's layout lists. */
export function videoRecordJson(videoId: string, spec: MontageSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: videoId,
    avatarId: spec.avatarId,
    file: {
      rootId: "root-00000001",
      relPath: RelativePath.parse("mia/2026-09-29_photo_001.mp4"),
      bytes: 1_000_000,
      sha256: "c".repeat(64),
    },
    durationMs: spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0),
    frames: 300,
    kind: "photo",
    spec,
    createdAt: "2026-09-29T10:00:00.000Z",
    ...extra,
  };
}

/** Writes `avatars/<avatarId>/videos/<videoId>.json` under the library root, creating the folder; returns the path. */
export async function writeVideoRecord(libraryRoot: string, videoId: string, spec: MontageSpec, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = join(libraryRoot, "avatars", spec.avatarId, "videos");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${videoId}.json`);
  await writeFile(path, `${JSON.stringify(videoRecordJson(videoId, spec, extra), null, 2)}\n`);
  return path;
}
