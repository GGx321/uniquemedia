import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaOrigin, MediaSummary, ResponseMessage } from "../../../shared/engine";
import { openFileSource } from "../../media/video/fileSource";
import { probeVideo, type VideoInfo } from "../../media/video/videoProbe";
import type { ClipRecord } from "../schemas";
import { clipFilePath, clipRecordPath, ensureClipsDir, posterPath, writeClipRecord } from "../store";
import { clipAttemptId } from "../journal";
import { command, photoJpeg, type ClipEngine } from "./engineClipKit";

// Test-only (5b.2, S5.WA2): a READY clip planted straight into an avatar's clips folder (a real small MP4 made by the bundled ffmpeg, a poster, a record that names the file's real sha256), so
// the montage-copy tests need neither a fake provider nor money. Plus the few reads they all make: the avatar's copies, a stored file's facts.

let planted = 0;

export interface PlantedClip {
  readonly clipId: string;
  readonly avatarId: string;
  readonly photoId: string;
  /** The library's mp4: the provider's bytes as planted. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PlantOptions {
  readonly clipId?: string;
  readonly createdAt?: string;
  /** What the record says about the picture; the real file is whatever `source` is. */
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly fps?: number;
}

export async function plantReadyClip(libraryDir: string, avatarId: string, photoId: string, source: string, options: PlantOptions = {}): Promise<PlantedClip> {
  const clipId = options.clipId ?? `clip-${String(++planted).padStart(7, "0")}`;
  const clipsDir = join(libraryDir, "avatars", avatarId, "clips");
  await ensureClipsDir(clipsDir);
  const file = clipFilePath(clipsDir, clipId);
  await copyFile(source, file);
  await writeFile(posterPath(clipsDir, clipId), await photoJpeg(72, 128));
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const record: ClipRecord = {
    schemaVersion: 1,
    id: clipId,
    avatarId,
    sourcePhotoId: photoId,
    createdAt: options.createdAt ?? "2026-10-13T10:00:00.000Z",
    seen: false,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    provider: { model: "kling-std", attempts: [{ attemptId: clipAttemptId(clipId, 1), providerJobId: "gen-abc123", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
    recovered: false,
    exports: [],
    outcome: {
      status: "ready",
      file: `${clipId}.mp4`,
      posterFile: `${clipId}.poster.jpg`,
      width: options.width ?? 720,
      height: options.height ?? 1280,
      durationMs: options.durationMs ?? 5_000,
      fps: options.fps ?? 24,
      bytes: bytes.length,
      sha256,
      face: { verdict: "match", p75: 0.7, frames: 10 },
    },
  };
  await writeClipRecord(clipsDir, record);
  return { clipId, avatarId, photoId, file, sha256, bytes: bytes.length };
}

/** The record of a planted clip as it is on disk, rewritten by `edit` (a test that needs a clip that is not ready, or one that carries an export). */
export async function rewriteClipRecord(libraryDir: string, avatarId: string, clipId: string, edit: (record: ClipRecord) => ClipRecord): Promise<void> {
  const clipsDir = join(libraryDir, "avatars", avatarId, "clips");
  const current = JSON.parse(await readFile(clipRecordPath(clipsDir, clipId), "utf8")) as ClipRecord;
  await writeClipRecord(clipsDir, edit(current));
}

export function importClipCommand(avatarId: string, clipId: string): unknown {
  return command("media.importClip", { avatarId, clipId });
}

export type ImportClipAnswer = { mediaId: string } | { jobId: string };

export function answerOf(response: ResponseMessage): ImportClipAnswer {
  if (!response.ok || response.type !== "media.importClip") throw new Error(`expected a media.importClip answer, got ${JSON.stringify(response)}`);
  return response.result;
}

/** Every video of the library's own media, newest first. */
export async function videosOf(started: ClipEngine): Promise<MediaSummary[]> {
  const answer = await started.engine.handle(command("media.list", { kind: "video" }));
  if (!answer.ok || answer.type !== "media.list") throw new Error(`expected a media.list answer, got ${JSON.stringify(answer)}`);
  return answer.result.media;
}

/** The montage copies among them (the media whose `origin` is set). */
export async function copiesOf(started: ClipEngine): Promise<(MediaSummary & { origin: MediaOrigin })[]> {
  return (await videosOf(started)).flatMap((media) => (media.origin === undefined ? [] : [{ ...media, origin: media.origin }]));
}

/** What the stored mezzanine says it is, as the import's own walker reads it. */
export async function factsOfFile(path: string): Promise<VideoInfo> {
  const opened = await openFileSource(path);
  try {
    const probe = await probeVideo(opened.source);
    if (!probe.ok) throw new Error(`the file does not probe: ${probe.reason}`);
    return probe.info;
  } finally {
    await opened.close();
  }
}

export const sizeOf = async (path: string): Promise<number> => (await stat(path)).size;
