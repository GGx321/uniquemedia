import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaOrigin } from "../shared/engine";
import { clipAttemptId } from "../engine/clips/journal";
import type { ClipRecord } from "../engine/clips/schemas";
import { clipFilePath, ensureClipsDir, posterPath, writeClipRecord } from "../engine/clips/store";
import type { Probed } from "../engine/render/ffmpeg.testkit";
import { ffmpegPath } from "../node/ffmpegBinary";
import type { RenderedFileExpectation } from "./renderSmokeChecks";

// What the smoke checks of «Клипы в монтаже» (Stage 5, 5b.2, S5.WA3), as functions with no Electron in them. Two runs use them: clipMontageSmoke.engine.test.ts plays the scenario against the REAL
// engine (the real video importer, the real render, the real verifier, the bundled ffmpeg) with no network, and the packaged smoke (smoke-engine.ts, `--only clipmontage`) plays the very same steps
// in the packaged app on CI. The scenario: a fixture clip made by ffmpeg (24 fps H.264 and AAC, 2 s, 720 x 1280) is planted as TWO ready clips of two photos; each is imported as its copy; a Reel of
// ONE photo and the TWO copies is rendered for real and judged by the render verifier at 1080 x 1920, 30 fps, with the exact number of frames. The provider's files are never rewritten.

/** The fixture clip and the Reel made of it. */
export const MONTAGE_SMOKE = {
  clipWidth: 720,
  clipHeight: 1280,
  clipFps: 24,
  /** The clip's length, and the length each cell of the Reel takes (a copy plays whole). */
  clipMs: 2_000,
  sceneMs: 2_000,
  /** The frame of every Reel. */
  frameWidth: 1080,
  frameHeight: 1920,
  frameFps: 30,
} as const;

/** The Reel is one scene photo and two copies, 2 s each. */
export function montageSmokeExpectation(): RenderedFileExpectation {
  const durationMs = MONTAGE_SMOKE.sceneMs + 2 * MONTAGE_SMOKE.clipMs;
  return { frames: (durationMs * MONTAGE_SMOKE.frameFps) / 1000, durationMs };
}

/** ffmpeg's argv for the fixture clip: a moving test picture (24 fps, 720 x 1280, H.264 yuv420p tagged BT.709) and a tone (AAC), 2 s. */
export function fixtureClipArgv(output: string): string[] {
  const { clipWidth, clipHeight, clipFps, clipMs } = MONTAGE_SMOKE;
  const seconds = String(clipMs / 1000);
  return [
    ...["-f", "lavfi", "-i", `testsrc2=size=${clipWidth}x${clipHeight}:rate=${clipFps}:duration=${seconds}`],
    ...["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"],
    ...["-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", output],
  ];
}

/** ffmpeg's argv for the clip's poster: the first frame as a JPEG. */
export function fixturePosterArgv(clip: string, output: string): string[] {
  return ["-i", clip, "-frames:v", "1", output];
}

/** Runs the bundled ffmpeg with an argv; throws with the stderr tail when it fails. */
export async function runFixtureFfmpeg(argv: readonly string[]): Promise<void> {
  const proc = Bun.spawn([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...argv], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`);
}

/** A ready clip planted into an avatar's clips folder. */
export interface PlantedSmokeClip {
  readonly clipId: string;
  readonly avatarId: string;
  readonly photoId: string;
  /** The library's mp4, and its sha256 at the time it was planted. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Plants a READY clip of `photoId` into the avatar's clips folder: the fixture mp4 (a copy of `source`), its poster and a record that names the file's real sha256, exactly as the clip job
 * would have committed them. No provider and no money are involved.
 */
export async function plantSmokeClip(libraryRoot: string, avatarId: string, photoId: string, clipId: string, source: string, poster: string): Promise<PlantedSmokeClip> {
  const clipsDir = join(libraryRoot, "avatars", avatarId, "clips");
  await ensureClipsDir(clipsDir);
  const file = clipFilePath(clipsDir, clipId);
  await copyFile(source, file);
  await copyFile(poster, posterPath(clipsDir, clipId));
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const record: ClipRecord = {
    schemaVersion: 1,
    id: clipId,
    avatarId,
    sourcePhotoId: photoId,
    createdAt: "2026-10-15T10:00:00.000Z",
    seen: false,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    provider: { model: "kling-std", attempts: [{ attemptId: clipAttemptId(clipId, 1), providerJobId: `gen-${clipId}`, outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
    recovered: false,
    exports: [],
    outcome: {
      status: "ready",
      file: `${clipId}.mp4`,
      posterFile: `${clipId}.poster.jpg`,
      width: MONTAGE_SMOKE.clipWidth,
      height: MONTAGE_SMOKE.clipHeight,
      durationMs: MONTAGE_SMOKE.clipMs,
      fps: MONTAGE_SMOKE.clipFps,
      bytes: bytes.length,
      sha256,
      face: { verdict: "match", p75: 0.7, frames: 10 },
    },
  };
  await writeClipRecord(clipsDir, record);
  return { clipId, avatarId, photoId, file, sha256, bytes: bytes.length };
}

/** The Reel's spec: one scene photo and the two copies, each for 2 s. */
export function montageSmokeSpec(avatarId: string, scenePhotoId: string, copyIds: readonly [string, string]): unknown {
  const { sceneMs, clipMs } = MONTAGE_SMOKE;
  return {
    schemaVersion: 1,
    avatarId,
    layers: [],
    music: null,
    seed: 7,
    clips: [
      { clipId: "clip-0000001", kind: "photo", cell: { photo: { source: "scene", photoId: scenePhotoId }, focus: null }, motion: "static", durationMs: sceneMs, transitionIn: "cut" },
      { clipId: "clip-0000002", kind: "video", mediaId: copyIds[0], trimStartMs: 0, focus: null, durationMs: clipMs, transitionIn: "cut" },
      { clipId: "clip-0000003", kind: "video", mediaId: copyIds[1], trimStartMs: 0, focus: null, durationMs: clipMs, transitionIn: "cut" },
    ],
  };
}

/** What the engine says of a copy, as far as the smoke reads it (`MediaSummary`). */
export interface CopySummaryFacts {
  readonly kind: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly sourceFps: number | null;
  readonly origin?: MediaOrigin | undefined;
}

/** The copy of a planted clip: a video with the clip's origin, the clip's size (inside the frame, never upscaled), its length within a frame of the encode, and the 24 fps it came from. */
export function copySummaryProblems(copy: CopySummaryFacts | undefined, clip: Pick<PlantedSmokeClip, "clipId" | "avatarId" | "photoId">): string[] {
  if (copy === undefined) return [`the copy of ${clip.clipId} is not in the library`];
  const problems: string[] = [];
  if (copy.kind !== "video") problems.push(`the copy of ${clip.clipId} is a ${copy.kind}, not a video`);
  if (copy.origin?.kind !== "clip" || copy.origin.clipId !== clip.clipId || copy.origin.avatarId !== clip.avatarId || copy.origin.photoId !== clip.photoId) {
    problems.push(`the copy of ${clip.clipId} does not say where it comes from: ${JSON.stringify(copy.origin ?? null)}`);
  }
  if (copy.width !== MONTAGE_SMOKE.clipWidth || copy.height !== MONTAGE_SMOKE.clipHeight) problems.push(`the copy is ${String(copy.width)} x ${String(copy.height)}, not ${MONTAGE_SMOKE.clipWidth} x ${MONTAGE_SMOKE.clipHeight} (never upscaled)`);
  const one = 1000 / MONTAGE_SMOKE.frameFps;
  if (copy.durationMs === null || Math.abs(copy.durationMs - MONTAGE_SMOKE.clipMs) > 2 * one) problems.push(`the copy lasts ${String(copy.durationMs)} ms, not ${MONTAGE_SMOKE.clipMs} ms`);
  if (copy.sourceFps === null || Math.abs(copy.sourceFps - MONTAGE_SMOKE.clipFps) > 0.01) problems.push(`the copy says it came from ${String(copy.sourceFps)} fps, not ${MONTAGE_SMOKE.clipFps}`);
  return problems;
}

/** The stored copy as ffprobe finds it: the importer's mezzanine, H.264 at 30 fps constant, no audio, inside the frame, and as many frames as 30 fps makes of its length. */
export function storedCopyProblems(probe: Probed): string[] {
  const problems: string[] = [];
  const video = probe.streams.filter((s) => s.codec_type === "video");
  const others = probe.streams.filter((s) => s.codec_type !== "video");
  if (video.length !== 1) problems.push(`the stored copy has ${video.length} video streams, not one`);
  if (others.length > 0) problems.push(`the stored copy has ${others.map((s) => s.codec_type).join(", ")}: a copy carries no audio and nothing else`);
  const stream = video[0];
  if (stream === undefined) return problems;
  if (stream.codec_name !== "h264") problems.push(`the stored copy is ${String(stream.codec_name)}, not h264`);
  if (stream.r_frame_rate !== "30/1" || stream.avg_frame_rate !== "30/1") problems.push(`the stored copy is ${String(stream.r_frame_rate)} (average ${String(stream.avg_frame_rate)}), not 30/1 constant`);
  if ((stream.width ?? 0) > MONTAGE_SMOKE.frameWidth || (stream.height ?? 0) > MONTAGE_SMOKE.frameHeight) problems.push(`the stored copy is ${String(stream.width)} x ${String(stream.height)}, outside the frame`);
  const frames = Number(stream.nb_read_frames);
  const wanted = (MONTAGE_SMOKE.clipMs * MONTAGE_SMOKE.frameFps) / 1000;
  if (frames !== wanted) problems.push(`the stored copy holds ${frames} frames, not ${wanted}`);
  return problems;
}

/** I5.54: the provider's file is read, never written: its bytes before and after are one sha256. */
export function providerFileProblems(clipId: string, before: string, after: string): string[] {
  return before === after ? [] : [`the provider's file of ${clipId} was rewritten (${before.slice(0, 12)} became ${after.slice(0, 12)})`];
}

/** What the Reel did to the clips and the photos (Q-F = 1, one frame): both clips are used `inVideo: clip`, and the three frames carry the video's used mark and no reservation. */
export function frameUseProblems(
  clips: readonly { clipId: string; use?: { inVideo?: string } | undefined }[],
  clipIds: readonly string[],
  photos: readonly { photoId: string; used: boolean; reserved: boolean }[],
  photoIds: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const clipId of clipIds) {
    const use = clips.find((c) => c.clipId === clipId)?.use;
    if (use?.inVideo !== "clip") problems.push(`${clipId} is not used in the video as a clip (${JSON.stringify(use ?? null)})`);
  }
  for (const photoId of photoIds) {
    const photo = photos.find((p) => p.photoId === photoId);
    if (photo === undefined) problems.push(`${photoId} is not listed`);
    else if (!photo.used || photo.reserved) problems.push(`${photoId} is ${photo.used ? "used" : "not used"} and ${photo.reserved ? "still reserved" : "not reserved"}: the Reel's frame is used and free of its reservation`);
  }
  return problems;
}
