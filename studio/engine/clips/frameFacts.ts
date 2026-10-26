import { BOLD_CLIPS, GROK_FALLBACK, isBoldCategory, type BoldClipsMode, type ScenePose } from "../../shared/engine";
import type { Moment } from "../../shared/scenes/banks/types";
import { captureOfShot, faceVisibleOf, type FaceVisibility } from "../../shared/scenes/captures";
import { contentLevelOf, type ContentLevel } from "../../shared/scenes/contentLine";
import { momentOfSlot } from "../../shared/scenes/template";
import { runIdOfAttempt } from "../autopilot/legacyMarks";
import { passesAgeThreshold } from "../avatars/ageCheck";
import { looksLikeRunPhoto } from "../library/photoRecords";
import type { PhotoSidecar } from "../library/schemas";
import { facePoseOf } from "../runs/faceGate";
import type { RunPlan } from "../runs/plan";
import type { OwnPlanSlot, PlanSlot } from "../scenes/schema";
import type { ClipFaceRole } from "./faceRole";
import { provenCaptureOf, type ClipCapture } from "./videoLook";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.4, I5.52, I5.57): what a clip knows of its photo, read from the photo's sidecar, its run's plan.json and the banks, never from pixels.
//
// The chain is the one the restored marks (autopilot/legacyMarks.ts) and the template already walk: the sidecar's attempt id names its run (`runIdOfAttempt`), the sidecar's
// slot names the plan slot (`attemptIdBase`), and the bank moment is found by the template's own lookup (`momentOfSlot`), so a clip never animates a moment its photo's
// sentence did not name. A plan that cannot be read for ANY reason is no plan (logged), as for the restored marks: never a refusal of the photo.
//
// «Как в сцене» is offered only when the photo's own prompt still says «she {moment}» (the template writes «, she …», the plain sentence «She …»): an owner-edited scene that
// no longer says it gets code motions only, and no pose sentence, since the photo may not show that activity.

export interface FrameFacts {
  readonly photoId: string;
  /** Where the facts come from: a planned slot of the run, an own scene of a scene set, or nothing (no plan, a plan that does not read, or a slot it does not hold). */
  readonly plan: "slot" | "own" | "none";
  /** The slot's category (the planner's names), `own`, or without a plan the sidecar's category. */
  readonly category: string;
  /** The bank moment of a planned built-in slot whose place and moment the bank still has. */
  readonly moment: Moment | null;
  /** «Как в сцене» is offered: the moment exists and the photo's prompt still says «she {moment}». */
  readonly sceneMotion: boolean;
  /** The slot's activity, when the photo's prompt still carries it: the pose sentence's source. Null for an own scene and without a plan. */
  readonly activity: string | null;
  /** Who took the photo, as far as its own prompt proves it (S5.WP1, I5.69): a slot planned as pov-legs whose photo holds no shipped POV line is `unknown`. */
  readonly capture: ClipCapture;
  /**
   * Who the plan says took it, before the prompt proves anything: the slot's capture, an own scene's from its shot, `unknown` with no plan (S5.WC2). The camera line reads
   * `capture`; the phone rule reads both, because an old pov-legs photo that reads as unknown was still taken with the phone in her hand (C3 K1, a selfie from above).
   */
  readonly plannedCapture: ClipCapture;
  readonly pose: ScenePose;
  /** Whether her face shows (`faceVisibleOf`); without a plan, read from the photo's own face marks. */
  readonly face: FaceVisibility;
  /**
   * I5.52 (the type is V4b's `faceRole.ts`, its one definition): `judged` when the gate checked the photo's face (a front or a three-quarter pose), `profile` when it skipped
   * it by its pose, `hidden` when the photo was marked, never judged (mirror-hidden, pov-legs, back, low-feet, a legs framing) or, with no plan, carries no unmarked likeness.
   */
  readonly faceRole: ClipFaceRole;
  /** A «Ножки» frame (`framing: "legs"`). */
  readonly legs: boolean;
  /** The slot's own legwear, never on a `noLegwear` moment. */
  readonly legwear: string | null;
  /** A frame of «Смелая» (I5.57): the category is `nightwear` or `beach`, whatever the mix level. */
  readonly bold: boolean;
  /** The level the motion and the activity are held to (`contentLevelOf`): bold for «Смелая», ordinary for everything else. */
  readonly level: ContentLevel;
  /** The photo carries an age verdict that is not adult at the gallery's threshold (the rule of `eligible`). */
  readonly ageRefused: boolean;
}

export type FrameFactsResult = { readonly kind: "gallery"; readonly facts: FrameFacts } | { readonly kind: "not-a-gallery-photo" };

type GeneratedSource = Extract<PhotoSidecar["source"], { kind: "generated" }>;

/** Regex-safe text. */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `prompt` says `phrase` as whole words, in any case («, she lies …» from the template, «She lies …» from the plain sentence). */
function says(prompt: string, phrase: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped(phrase)}(?![\\p{L}\\p{N}])`, "iu").test(prompt);
}

/** A slot's text without the punctuation a stored text may end with (the plain sentence's `field`). */
const trimmed = (text: string): string => text.trim().replace(/[\s.,;:!]+$/, "");

/** The slot the photo was made for, in its run's plan, or null. */
function slotOf(source: GeneratedSource, plan: RunPlan | null): PlanSlot | OwnPlanSlot | null {
  if (plan === null || source.slot === undefined) return null;
  return plan.scenes.slots.find((slot) => slot.attemptIdBase === source.slot) ?? null;
}

function roleOf(pose: ReturnType<typeof facePoseOf>): ClipFaceRole {
  if (pose === "front" || pose === "three-quarter") return "judged";
  return pose === "profile" ? "profile" : "hidden";
}

function plannedFacts(photo: PhotoSidecar, source: GeneratedSource, slot: PlanSlot): Omit<FrameFacts, "ageRefused"> {
  const moment = momentOfSlot(slot) ?? null;
  const activity = trimmed(slot.activity);
  const carried = activity !== "" && says(source.prompt, activity);
  const level = contentLevelOf({ category: slot.category, level: slot.level, route: slot.route });
  const planned = slot.capture ?? captureOfShot(slot.shot);
  return {
    photoId: photo.id,
    plan: "slot",
    category: slot.category,
    moment,
    sceneMotion: moment !== null && says(source.prompt, `she ${moment.text}`),
    activity: carried ? activity : null,
    capture: provenCaptureOf(planned, source.prompt),
    plannedCapture: planned,
    pose: slot.pose,
    face: faceVisibleOf(slot),
    faceRole: roleOf(facePoseOf(slot)),
    legs: slot.framing === "legs",
    legwear: slot.legwear === undefined || moment?.noLegwear === true ? null : slot.legwear,
    bold: isBoldCategory(slot.category),
    level,
  };
}

function ownFacts(photo: PhotoSidecar, slot: OwnPlanSlot): Omit<FrameFacts, "ageRefused"> {
  return {
    photoId: photo.id,
    plan: "own",
    category: "own",
    moment: null,
    sceneMotion: false,
    activity: null,
    capture: captureOfShot(slot.shot),
    plannedCapture: captureOfShot(slot.shot),
    pose: slot.pose,
    face: faceVisibleOf(slot),
    faceRole: roleOf(facePoseOf(slot)),
    legs: false,
    legwear: null,
    bold: false,
    level: contentLevelOf({ category: slot.category, level: undefined, route: undefined }),
  };
}

/**
 * No plan: only the sidecar speaks. The capture is unknown and the pose front (§5.4 table). The photo was judged only when it carries a likeness and no mark (I5.52; a
 * restored legacy mark needs the plan, so there is none here); a marked photo hides her face, and one with neither is not known to show it.
 */
function planlessFacts(photo: PhotoSidecar, category: string): Omit<FrameFacts, "ageRefused"> {
  const judged = photo.qa.faceCos !== undefined && photo.qa.faceMarked !== true;
  // S5.BA6: the photo's own route (`photo.source.route`) joins here with `frameFacts.bold`; until then a category-only reading, as before.
  const level = contentLevelOf({ category, level: undefined, route: undefined });
  return {
    photoId: photo.id,
    plan: "none",
    category,
    moment: null,
    sceneMotion: false,
    activity: null,
    capture: "unknown",
    plannedCapture: "unknown",
    pose: "front",
    face: judged ? "yes" : photo.qa.faceMarked === true ? "no" : "maybe",
    faceRole: judged ? "judged" : "hidden",
    legs: false,
    legwear: null,
    bold: isBoldCategory(category),
    level,
  };
}

/** The facts of a photo, given its run's plan as read (null: no plan). Pure. Only a generated photo with a category is a gallery photo (`photoSummaryFrom`'s rule). */
export function frameFactsOf(photo: PhotoSidecar, plan: RunPlan | null): FrameFactsResult {
  const source = photo.source;
  if (!looksLikeRunPhoto(photo) || source.kind !== "generated" || source.category === undefined) return { kind: "not-a-gallery-photo" };
  const slot = slotOf(source, plan);
  const facts = slot === null ? planlessFacts(photo, source.category) : slot.category === "own" ? ownFacts(photo, slot) : plannedFacts(photo, source, slot);
  return { kind: "gallery", facts: { ...facts, ageRefused: !passesAgeThreshold(photo.qa.age) } };
}

/**
 * The facts of a photo, reading its run's plan with `readPlan` (the library's `readRun` with the strict `RunPlanSchema`). Any failure to read it (no run, unreadable,
 * strict-failing, any throw) is no plan, logged and never thrown; a photo whose attempt id names no run is never read for.
 */
export async function readFrameFacts(photo: PhotoSidecar, readPlan: (runId: string) => Promise<RunPlan>, log: (line: string) => void): Promise<FrameFactsResult> {
  const source = photo.source;
  if (source.kind !== "generated" || source.category === undefined) return frameFactsOf(photo, null);
  const runId = runIdOfAttempt(source.attemptId);
  let plan: RunPlan | null = null;
  if (runId !== null) {
    try {
      plan = await readPlan(runId);
    } catch (error) {
      log(`[clip] photo ${photo.id}: the plan of run ${runId} does not read, so the photo has no plan (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (plan !== null && slotOf(source, plan) === null) log(`[clip] photo ${photo.id}: run ${runId ?? "?"} holds no slot ${source.slot ?? "(none)"}, so the photo has no plan`);
  return frameFactsOf(photo, plan);
}

/**
 * `ClipOptions.fallback` for this photo (I5.47, I5.57): the engine's mode, or `none` for a frame of «Смелая» that `BOLD_CLIPS` keeps to Kling (`kling-only`; `off` sends nothing
 * at all). Such a frame never falls back and is never offered Grok: its worst is Kling's reserve alone. The money side reads the same rule in `clipAllowsAutoGrok`.
 */
export function clipFallbackOf(facts: FrameFacts, boldClips: BoldClipsMode = BOLD_CLIPS, mode: "auto" | "offer" = GROK_FALLBACK): "auto" | "offer" | "none" {
  return facts.bold && boldClips !== "with-fallback" ? "none" : mode;
}

/**
 * Why `clips.options` and `clips.create` refuse a gallery photo before its motions are looked at, in their order: an age verdict that is not adult, then a frame of «Смелая»
 * while `BOLD_CLIPS` is `off` (I5.57). The pixel checks (`photo-unreadable`, `not-vertical`) are the first frame's and sit between the two in `clips.create`'s order.
 */
export function frameRefusalOf(facts: FrameFacts, boldClips: BoldClipsMode): "age-unverified" | "bold-off" | null {
  if (facts.ageRefused) return "age-unverified";
  if (facts.bold && boldClips === "off") return "bold-off";
  return null;
}
