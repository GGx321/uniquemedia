import { rm } from "node:fs/promises";
import type { ClipFace } from "../../shared/engine";
import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import { isNoSpaceError } from "../freeBytes";
import { fsyncDir, fsyncFile } from "../library/durableFs";
import { renameWithRetry } from "../library/renameRetry";
import type { ClipDownload } from "./download";
import type { CheckClipFaceOptions } from "./faceCheck";
import type { ClipFaceRole } from "./faceRole";
import type { MakePosterOptions } from "./frames";
import type { ClipRecord } from "./schemas";
import { posterPath, posterTempPath } from "./store";
import type { ClipColour } from "./validate";

// Stage 5, 5b.1 (S5.V4a1, S5.V4a2, S5.V6): the tail every path that holds a validated clip file shares on its way to a ready record: the create job (job.ts), the download retry (records.ts)
// and the restart's recovery (recover.ts). One implementation each of the poster (and what its failure proves about the paid file), the face check's decision, and the ready outcome. What a
// caller does when the poster fails or a stop comes stays the caller's: the create removes an undecodable file and records `invalid-file`, the retry keeps the record as it was, the recovery keeps
// the file whatever ffmpeg said.

/** What ffmpeg says about the file it WRITES, not the one it reads: such an error proves nothing about the clip. Only the C library's fixed phrases are looked for. */
const OUTPUT_SIDE_ERROR = /Input\/output error|Read-only file system|Permission denied|Operation not permitted/i;

/**
 * Whether a failed poster PROVES ffmpeg cannot decode the paid file: ffmpeg ran and exited on its own with an error code (not a timeout, not a kill we did not send: `exitCode` null), and the
 * error is not about its own output (a full disk, EIO, a read-only or forbidden folder). Only then may the file be removed; any other failure keeps it.
 */
export function posterProvesUndecodable(error: unknown): boolean {
  if (!(error instanceof FfmpegError) || error instanceof FfmpegTimeoutError || error.exitCode === null) return false;
  return !isNoSpaceError(error) && !OUTPUT_SIDE_ERROR.test(error.stderrTail);
}

export interface DrawPosterInput {
  readonly makePoster: (options: MakePosterOptions) => Promise<void>;
  readonly clipPath: string;
  readonly colour: ClipColour;
  readonly clipsDir: string;
  readonly clipId: string;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

export type DrawnPoster = { readonly drawn: true } | { readonly drawn: false; readonly error: unknown; readonly undecodable: boolean };

/**
 * The poster under a fresh temp name, made durable and renamed onto `<clipId>.poster.jpg` (ffmpeg never overwrites a file). On a failure the temp is removed and the answer says whether ffmpeg
 * proved the file undecodable (`posterProvesUndecodable`). Never rejects.
 */
export async function drawPoster(input: DrawPosterInput): Promise<DrawnPoster> {
  const temp = posterTempPath(input.clipsDir, input.clipId);
  try {
    await input.makePoster({ clipPath: input.clipPath, colour: input.colour, log: input.log, outPath: temp, signal: input.signal });
    await fsyncFile(temp);
    await renameWithRetry(temp, posterPath(input.clipsDir, input.clipId));
    await fsyncDir(input.clipsDir);
    return { drawn: true };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return { drawn: false, error, undecodable: posterProvesUndecodable(error) };
  }
}

export interface ClipFaceInput {
  /** The role the clip's photo had at the gate (I5.52), or null when it cannot be known (the photo is gone): the clip is then kept unchecked. */
  readonly role: ClipFaceRole | null;
  /** The face worker's check, or null when the engine has none or it is broken. */
  readonly gate: Pick<WorkerFaceGate, "check"> | null;
  /** The master's embedding, asked only for a judged clip; null when it cannot be taken. */
  readonly masterEmbedding: () => Promise<Float32Array | null>;
  readonly check: (options: CheckClipFaceOptions) => Promise<ClipFace>;
  readonly clipPath: string;
  readonly colour: ClipColour;
  readonly durationMs: number;
  readonly scratchDir: string;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

const UNCHECKED: ClipFace = { verdict: "skipped", frames: 0, why: "worker" };
const NO_GATE: Pick<WorkerFaceGate, "check"> = { check: () => Promise.reject(new Error("no face gate")) };

/** The face check (I5.52): it marks and never fails the clip. An unknown role, and a judged clip without a gate or a master embedding, are kept unchecked (`worker`), never checked against nothing. */
export async function clipFaceOf(input: ClipFaceInput): Promise<ClipFace> {
  const { role, gate } = input;
  if (role === null) return UNCHECKED;
  let embedding: Float32Array | null = null;
  if (role === "judged") {
    if (gate === null) return UNCHECKED;
    embedding = await input.masterEmbedding();
    if (embedding === null) return UNCHECKED;
  }
  return input.check({
    role,
    clipPath: input.clipPath,
    colour: input.colour,
    durationMs: input.durationMs,
    scratchDir: input.scratchDir,
    masterEmbedding: embedding ?? new Float32Array(0),
    gate: gate ?? NO_GATE,
    signal: input.signal,
    log: input.log,
  });
}

/** The ready outcome of a clip whose file is on disk, validated, as `<clipId>.mp4`. The record names `<clipId>.poster.jpg` even when the poster could not be drawn (the strict schema fixes it). */
export function readyOutcomeOf(clipId: string, file: Extract<ClipDownload, { kind: "saved" }>, face: ClipFace): Extract<ClipRecord["outcome"], { status: "ready" }> {
  return {
    status: "ready",
    file: `${clipId}.mp4`,
    posterFile: `${clipId}.poster.jpg`,
    width: file.clip.width,
    height: file.clip.height,
    durationMs: Math.max(1, Math.round(file.clip.durationMs)),
    fps: file.clip.fps,
    bytes: file.clip.bytes,
    sha256: file.sha256,
    face,
  };
}
