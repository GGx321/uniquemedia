import type { ClipFace } from "../../shared/engine";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import { sampleFrames as takeFrames } from "./frames";

// Stage 5, 5b.1, S5.V4b (plan s5b1 §5.11, I5.52): the clip's face check. It is free, and it only MARKS: it never deletes a clip, never re-rolls, never costs and never fails the job.
// The p75 (nearest rank: the ceil(0.75 n)-th smallest) of SFace's similarity over one frame every half second, against the master embedding taken when the job started, so a master
// switch during the clip does not move its verdict. The existing face worker does the SFace work (`WorkerFaceGate.check`, as the photo gate does); nothing here reimplements it.
//
// The ROLE comes in as an argument. V5's `frameFacts.ts` derives it from the photo's own gate (a clip is judged only when the photo was), and this file never derives it: a `profile`
// or `hidden` photo is `skipped` without taking a frame or calling the worker.
//
// `ClipFace.frames` is the number of frames that had exactly one face and so voted in the p75 (0 for a skipped role or a broken check).

/** The photo gate's line (0.55, C4); a clip below it reads «Лицо не совпало». Q22 is open: C3 rule 4 calibrates it, and the default ships here. */
export const CLIP_FACE_LINE = 0.55;
/** Fewer frames with one face than this is too little to say anything. */
export const MIN_FACE_FRAMES = 3;
const P75 = 0.75;

/** Whether the clip is judged, and if not why. `judged` only when the photo was. */
export type ClipFaceRole = { readonly kind: "judged" } | { readonly kind: "skipped"; readonly why: "hidden" | "profile" };

export interface CheckClipFaceOptions {
  readonly role: ClipFaceRole;
  readonly clipPath: string;
  readonly durationMs: number;
  /** A folder that exists, for the frames' temp folder (the clips folder). */
  readonly scratchDir: string;
  /** The master's SFace embedding, taken when the job started. */
  readonly masterEmbedding: Float32Array;
  /** The engine's face worker gate: only `check` is used. */
  readonly gate: Pick<WorkerFaceGate, "check">;
  /** Aborting rejects with the signal's reason: a cancel is not a verdict. */
  readonly signal: AbortSignal;
  /** Test seam: the frame sampler. */
  readonly sampleFrames?: typeof takeFrames;
  /** One line when the check could not run. It never carries the failure's message, only its kind. */
  readonly log?: (line: string) => void;
}

const skipped = (why: NonNullable<ClipFace["why"]>, frames = 0): ClipFace => ({ verdict: "skipped", frames, why });

/** The similarity of a frame that had one face, or null for every other answer (no face, several, marked, a pose skip, a kind this build does not know). */
function similarityOf(verdict: unknown): number | null {
  if (typeof verdict !== "object" || verdict === null || !("kind" in verdict)) return null;
  if (verdict.kind !== "match" && verdict.kind !== "mismatch") return null;
  if (!("similarity" in verdict) || typeof verdict.similarity !== "number" || !Number.isFinite(verdict.similarity)) return null;
  return Math.max(-1, Math.min(1, verdict.similarity));
}

/** Nearest rank: the ceil(0.75 n)-th smallest. `sorted` has at least one item. */
function p75Of(sorted: readonly number[]): number {
  return sorted[Math.ceil(P75 * sorted.length) - 1] ?? 0;
}

function failedKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The clip's face verdict. Rejects only when the signal aborts; a broken sampler or worker is a `skipped` check with `why: "worker"`. */
export async function checkClipFace(options: CheckClipFaceOptions): Promise<ClipFace> {
  const { role, signal } = options;
  if (signal.aborted) throw signal.reason;
  if (role.kind === "skipped") return skipped(role.why);
  const log = options.log ?? (() => {});
  const similarities: number[] = [];
  try {
    const frames = await (options.sampleFrames ?? takeFrames)({ clipPath: options.clipPath, durationMs: options.durationMs, scratchDir: options.scratchDir, signal });
    for (const bytes of frames) {
      if (signal.aborted) throw signal.reason;
      const similarity = similarityOf(await options.gate.check({ pose: "front", bytes, masterEmbedding: options.masterEmbedding }, signal));
      if (similarity !== null) similarities.push(similarity);
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    log(`[clip] the face check could not run (${failedKind(error)}); the clip is kept without a verdict`);
    return skipped("worker");
  }
  if (similarities.length < MIN_FACE_FRAMES) return skipped("few-faces", similarities.length);
  const p75 = p75Of([...similarities].sort((a, b) => a - b));
  return { verdict: p75 >= CLIP_FACE_LINE ? "match" : "mismatch", p75, frames: similarities.length };
}
