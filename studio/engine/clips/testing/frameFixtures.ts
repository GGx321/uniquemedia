import { BANKS } from "../../../shared/scenes/banks";
import type { BankCategory, BankPlace, Moment } from "../../../shared/scenes/banks/types";
import { captureOfShot, shotOf, type Capture } from "../../../shared/scenes/captures";
import { plainSentence } from "../../../shared/scenes/plain";
import { templateSentence } from "../../../shared/scenes/template";
import { isCustomCategory, type CategorySnapshot, type ScenePose } from "../../../shared/engine";
import { wholeBodyOf } from "../../scenes/assembler";
import { captureLineOf, slotKeyOf } from "../../scenes/phoneLook";
import { customSnapshot } from "../../scenes/testing/customPool";
import { PhotoSidecarSchema, type PhotoSidecar } from "../../library/schemas";
import { buildSceneRunPlan, type RunPlan } from "../../runs/plan";
import type { OwnPlanSlot, PlanSlot } from "../../scenes/schema";

// Stage 5, 5b.1, S5.V5: test-only builders for the clip's frame facts and prompts. Slots are made from the banks' own data (a moment is picked by its tags, never by
// its words), and a photo's sidecar is what a run writes: its attempt id, its slot and the prompt its sentence went into.

export const AVATAR = "avatar-0001";
export const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };

export interface Picked {
  category: BankCategory;
  place: BankPlace;
  moment: Moment;
}

/** The first (place, moment) of a bank that `test` accepts, in bank order. Throws when the bank has none, so a test never passes on nothing. */
export function pick(category: BankCategory, test: (moment: Moment, place: BankPlace) => boolean): Picked {
  for (const place of BANKS[category].places) {
    const moment = place.moments.find((m) => test(m, place));
    if (moment !== undefined) return { category, place, moment };
  }
  throw new Error(`no ${category} moment for this fixture`);
}

/** Every (category, place, moment) of the 7 banks, in bank order. */
export function everyMoment(): Picked[] {
  return (Object.keys(BANKS) as BankCategory[]).flatMap((category) => BANKS[category].places.flatMap((place) => place.moments.map((moment) => ({ category, place, moment }))));
}

/** The outfit the slot wears: the moment's pinned one, else the bank's first outfit at the moment's level or below. */
export function outfitOf(picked: Picked): string {
  const pinned = picked.moment.outfits?.[0];
  if (pinned !== undefined) return pinned;
  const bank = BANKS[picked.category];
  const fits = bank.outfits.find((o) => o.pinOnly !== true && (o.level === undefined || picked.moment.level === "bold" || (o.level === "flirty" && picked.moment.level === "flirty")));
  return (fits ?? bank.outfits[0])?.text ?? "a plain outfit";
}

/** A plan slot for a picked moment on one of its captures. The level follows the moment's (a bold moment's slot is bold); a legs moment frames the legs. */
export function slotOf(picked: Picked, capture: Capture, pose: ScenePose = "front", extra: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: picked.category,
    location: picked.place.name,
    timeOfDay: picked.place.times[0] ?? "morning",
    activity: picked.moment.text,
    outfit: outfitOf(picked),
    shot: shotOf(capture),
    pose,
    attemptIdBase: "slot-1",
    repeatedPair: false,
    capture,
    ...(picked.moment.level === undefined ? {} : { level: picked.moment.level }),
    ...(picked.moment.legs?.framing === "legs" ? { framing: "legs" as const } : {}),
    ...extra,
  };
}

/** The sentence a run gives a built-in slot: the template's, else the plain sentence (the writer's last resort). An own scene's is its own. */
export function sentenceOf(runId: string, slot: PlanSlot | OwnPlanSlot): string {
  if (slot.category === "own") return slot.sentence;
  if (slot.sentence !== undefined) return slot.sentence;
  return templateSentence(slot, { key: `${runId}:${slot.attemptIdBase}`, ...(slot.level === undefined ? {} : { level: slot.level }) }) ?? plainSentence(slot);
}

/** A run made from a scene set of these slots (each with its sentence), numbered 1..M. */
export function sceneRun(runId: string, slots: readonly (PlanSlot | { kind: "own"; shot: PlanSlot["shot"]; pose: PlanSlot["pose"]; text: string })[]): RunPlan {
  // A custom category's slot needs the category's snapshot in the plan (RunPlanSchema): the test kit's own one, under the slot's id.
  const custom = [...new Set(slots.flatMap((slot) => ("kind" in slot || !isCustomCategory(slot.category) ? [] : [slot.category])))];
  return buildSceneRunPlan({
    ...(custom.length === 0 ? {} : { categories: custom.map((ref) => ({ ...customSnapshot(), ref: ref as CategorySnapshot["ref"] })) }),
    runId,
    avatarId: AVATAR,
    createdAt: "2026-10-13T10:00:00.000Z",
    sceneSetId: "set-00000001",
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 1_000_000,
    plannedWorstMicros: 1_000_000,
    scenes: slots.map((slot, i) =>
      "kind" in slot
        ? { sceneId: i + 1, text: slot.text, slot: { kind: "own" as const, shot: slot.shot, pose: slot.pose } }
        : { sceneId: i + 1, text: slot.sentence ?? sentenceOf(runId, { ...slot, attemptIdBase: `slot-${i + 1}` }), slot },
    ),
  });
}

let photoCounter = 0;

/**
 * The capture line the real assembler opens the photo's prompt with (engine/scenes/assembler.ts `assembleSlot`): the slot's capture (an own scene's from its shot), keyed by
 * `${runId}:${attemptIdBase}`, with the assembler's own whole-body framing (`wholeBodyOf`). S5.WP1 (plan s5b2 I5.69, M2): a clip reads which capture line its photo
 * holds, so the kit's photo holds the one a run writes.
 */
export function photoCaptureLineOf(runId: string, slot: PlanSlot | OwnPlanSlot): string {
  const capture = slot.category === "own" ? captureOfShot(slot.shot) : (slot.capture ?? captureOfShot(slot.shot));
  return captureLineOf(capture, slotKeyOf(runId, slot.attemptIdBase), { wholeBody: wholeBodyOf(slot) });
}

/**
 * A gallery photo of a run's slot, as the run's `photoMeta` writes it: the slot's first attempt id, the slot, the category, and a prompt that opens with the slot's capture
 * line and carries the sentence.
 */
export function photoOf(run: RunPlan, slot: PlanSlot | OwnPlanSlot, extra: { prompt?: string; qa?: PhotoSidecar["qa"]; category?: string } = {}): PhotoSidecar {
  photoCounter++;
  const id = `photo-${String(photoCounter).padStart(6, "0")}`;
  const sentence = sentenceOf(run.runId, slot);
  return PhotoSidecarSchema.parse({
    schemaVersion: 1,
    id,
    avatarId: AVATAR,
    file: `${id}.png`,
    mediaType: "image/png",
    width: 720,
    height: 1280,
    bytes: 1000,
    sha256: "c".repeat(64),
    source: {
      kind: "generated",
      model: MODELS.imageModel,
      provider: "openrouter",
      jobId: run.runId,
      attemptId: `${run.runId}:${slot.attemptIdBase}#1`,
      promptSha: "d".repeat(64),
      prompt: extra.prompt ?? `${photoCaptureLineOf(run.runId, slot)} ${sentence}. She is an adult woman.`,
      slot: slot.attemptIdBase,
      category: extra.category ?? photoCategory(slot.category),
      costMicros: 40_000,
    },
    qa: extra.qa ?? { faceCos: 0.71 },
    createdAt: "2026-10-13T10:00:00.000Z",
  });
}

/** The contract name a sidecar stores for a planner category (photoCategoryOf): the five are renamed, the «Смелая» two and a custom id stay. */
function photoCategory(category: string): string {
  const renamed: Record<string, string> = { photoshoot: "shoot", glamour: "glam", fitness: "fit" };
  return renamed[category] ?? category;
}

/** A gallery photo with no run plan to read (an attempt id with no run, or a deleted plan): only its sidecar speaks. */
export function planlessPhoto(category: string, qa: PhotoSidecar["qa"], attemptId = "run-00000099:slot-1#1"): PhotoSidecar {
  photoCounter++;
  const id = `photo-${String(photoCounter).padStart(6, "0")}`;
  return PhotoSidecarSchema.parse({
    schemaVersion: 1,
    id,
    avatarId: AVATAR,
    file: `${id}.png`,
    mediaType: "image/png",
    width: 720,
    height: 1280,
    bytes: 1000,
    sha256: "c".repeat(64),
    source: { kind: "generated", model: MODELS.imageModel, provider: "openrouter", jobId: "run-00000099", attemptId, promptSha: "d".repeat(64), prompt: "A photo.", slot: "slot-1", category, costMicros: 40_000 },
    qa,
    createdAt: "2026-10-13T10:00:00.000Z",
  });
}
