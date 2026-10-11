// What the E2E smoke (smoke-engine.ts) decides about the face gate in its photo run, as functions with no Electron in them: they are held by runFaceSmoke.test.ts.
// The plan is seeded per run and holds face-hidden and body frames (a phone over her face, her legs, a back view) the gate only MARKS, never retries,
// so which slot an induced mismatch lands on, and which photos carry a judged faceCos, are read from the run's own plan, never assumed.
import { faceVisibleOf } from "../shared/scenes/captures";
import { FACE_GATE_NAME } from "../engine/runs/faceGate";
import type { RunEvent } from "../engine/runs/journal";
import type { RunSlot } from "../engine/scenes";

/** The hybrid threshold the gate judges a face-visible photo by (face/config.ts), as the smoke asserts it. */
export const FACE_PASS_COSINE = 0.55;

/** Whether the gate judges (and may retry) this slot: its face shows. Every other slot is checked as `body`: its likeness is marked only. */
export function isFaceJudged(slot: RunSlot): boolean {
  return faceVisibleOf(slot) === "yes";
}

/** The slot the induced "no face detected" image must land on, and the prompt that identifies its image request. */
export interface MismatchTarget {
  slotIndex: number;
  prompt: string;
}

/** The first face-judged slot (in slot order) that has a prompt: a faceless image on any other slot is only marked, so it would never retry. Null when there is none. */
export function pickMismatchTarget(slots: readonly RunSlot[], prompts: ReadonlyMap<number, string>): MismatchTarget | null {
  for (const slot of slots) {
    const prompt = prompts.get(slot.slotIndex);
    if (prompt !== undefined && isFaceJudged(slot)) return { slotIndex: slot.slotIndex, prompt };
  }
  return null;
}

export interface StoredPhotoFacts {
  id: string;
  faceCos: number | undefined;
}

/** The slot each stored photo belongs to, from the journal's own slot ends (both jobs of a resumed run). */
export function slotIndexByPhoto(events: readonly RunEvent[]): Map<string, number> {
  const bySlot = new Map<string, number>();
  for (const e of events) if (e.type === "slot" && e.status === "done" && e.photoId !== undefined) bySlot.set(e.photoId, e.slotIndex);
  return bySlot;
}

/**
 * Every photo of a face-judged slot carries qa.faceCos >= 0.55, and at least one such photo exists (so the real models and ORT ran for real); every photo of a
 * face-hidden or body slot carries a faceCos too (the marked outcome: its likeness stored, never judged). Empty when right; otherwise one line per fault.
 */
export function faceScoreProblems(slots: readonly RunSlot[], photos: readonly StoredPhotoFacts[], photoSlots: ReadonlyMap<string, number>): string[] {
  const problems: string[] = [];
  const slotOf = new Map(slots.map((s) => [s.slotIndex, s]));
  let judged = 0;
  for (const photo of photos) {
    const index = photoSlots.get(photo.id);
    const slot = index === undefined ? undefined : slotOf.get(index);
    if (slot === undefined) {
      problems.push(`photo ${photo.id} belongs to no planned slot`);
      continue;
    }
    if (isFaceJudged(slot)) {
      judged++;
      if (photo.faceCos === undefined || photo.faceCos < FACE_PASS_COSINE) problems.push(`slot ${index} (face visible) photo ${photo.id} has faceCos ${String(photo.faceCos)}, not >= ${FACE_PASS_COSINE}`);
    } else if (photo.faceCos === undefined) {
      problems.push(`slot ${index} (face hidden or body) photo ${photo.id} has no faceCos: it should be marked, not skipped`);
    }
  }
  if (judged === 0) problems.push("no stored photo is on a face-visible slot, so nothing proves the face gate judged a face");
  return problems;
}

/** Whether this journal event is a retry the FACE gate asked for (a qa-retry attempt whose error names the gate). */
export function isFaceRetry(e: RunEvent): boolean {
  return e.type === "attempt" && e.outcome === "qa-retry" && (e.error?.detail ?? "").includes(`"${FACE_GATE_NAME}"`);
}

/** The induced mismatch made its own slot retry through the face gate, and the gate never retried a face-hidden or body slot. Empty when right. */
export function faceRetryProblems(slots: readonly RunSlot[], events: readonly RunEvent[], target: MismatchTarget): string[] {
  const problems: string[] = [];
  const retried = events.filter(isFaceRetry);
  if (!retried.some((e) => e.type === "attempt" && e.slotIndex === target.slotIndex)) problems.push(`the mismatch slot ${target.slotIndex} has no face-gate qa-retry in the journal`);
  const slotOf = new Map(slots.map((s) => [s.slotIndex, s]));
  for (const e of retried) {
    if (e.type !== "attempt") continue;
    const slot = slotOf.get(e.slotIndex);
    if (slot !== undefined && !isFaceJudged(slot)) problems.push(`the face gate retried slot ${e.slotIndex}, whose face is hidden (it must only be marked)`);
  }
  return problems;
}
