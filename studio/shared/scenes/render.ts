import type { PoolShot, ScenePose } from "../engine";
import { CUES, GAZE } from "./banks";
import type { Angle, Cue, Gaze, GazeKind, Level, MomentGaze } from "./banks/types";
import { captureOfShot, faceVisibleOf, isHandCapture, LEGS_CAPTURES, posesFor, shotOf, type Capture } from "./captures";
import { pick } from "./hash";
import { PHONE_WORDS, SELFIE_WORDS } from "./words";

// 5a.2 (S5.6a, plan s5a2 r1.2 §5.2): the template's rendering core, shared by the built-in banks (template.ts) and the custom-category adapter
// (custom.ts). The rules of coherence (I5.23) live here: which moments a slot may take, and which gaze kinds a capture and a pose may draw.

/** What the template reads of a slot: a plan slot, a scene-set scene, or a candidate the planner is weighing. */
export interface TemplateSlot {
  category: string;
  location?: string | undefined;
  activity?: string | undefined;
  outfit?: string | undefined;
  /** The legwear slot (I5.29, K-17), on an outfit that shows her legs. */
  legwear?: string | undefined;
  /** The stored shot (I5.27): it stays one of five; the capture rides on it. */
  shot: PoolShot;
  /** Who takes the photo (I5.32). Absent on a slot stored before captures: read from its shot. */
  capture?: Capture | undefined;
  pose: ScenePose;
  /** «Ножки» (5a.2c). */
  framing?: "legs" | undefined;
}

export interface TemplateContext {
  /** The slot's draw key: `slotKeyOf(runId, attemptIdBase)` for a run, `${sceneSetId}:${sceneId}:${k}` for a scene set's k-th write. */
  key: string;
  /** The custom categories the plan or the set holds a snapshot of. */
  snapshots?: readonly { ref: string }[] | undefined;
  /** «Подача» (5a.2b). Absent: ordinary. */
  level?: Level | undefined;
  /** The sentences already rendered in this run: an equal one is redrawn. */
  seen?: ReadonlySet<string> | undefined;
}

/** The redraws an equal sentence gets before the slot keeps it (I5.24). */
export const DEDUP_TRIES = 8;

/** The tags `momentAllowed` reads: a bank moment, or an old custom activity read through the adapter (which lists no captures: any fits). */
export interface MomentTags {
  captures?: readonly Capture[] | undefined;
  twoHanded: boolean;
  phone?: true | undefined;
  level?: "flirty" | undefined;
  angle?: Angle | undefined;
  gaze?: MomentGaze | undefined;
  legs?: { framing?: "legs" | undefined } | undefined;
}

/** The slot's capture: its own, or (a slot stored before captures) its shot's. Null when the two disagree. */
export function captureOfSlot(slot: Pick<TemplateSlot, "shot" | "capture">): Capture | null {
  if (slot.capture === undefined) return captureOfShot(slot.shot);
  return shotOf(slot.capture) === shotOf(captureOfShot(slot.shot)) ? slot.capture : null;
}

/**
 * The gaze kinds a slot may draw (the coherence table, plan s5a2 r1.2 §5.2). A frame whose face does not show (the phone over it, from behind) and a
 * moment that carries its own gaze (or looks at the viewer itself) take none. A mirror looks at her reflection or down; a selfie, from above or
 * prone, at the viewer or down; a candid and a profile never at the viewer. Only a moment whose hands are busy (`focus`) may take «her eyes on what
 * her hands do», and never on a hand-held capture.
 */
export function gazeKindsFor(capture: Capture, pose: ScenePose, gaze?: MomentGaze, framing?: "legs"): readonly GazeKind[] {
  if (faceVisibleOf({ capture, pose, framing }) === "no" || gaze === "own" || gaze === "viewer") return [];
  const shot = shotOf(capture);
  const kinds: GazeKind[] = shot === "mirror" ? ["mirror", "down"] : shot === "selfie" ? ["viewer", "down"] : capture === "candid" || pose === "profile" ? ["away", "down"] : ["viewer", "away", "down"];
  if (gaze === "focus" && !isHandCapture(capture)) kinds.push("hands");
  return kinds;
}

/**
 * Whether a slot of this capture, pose, level and framing may take the moment (I5.23; the planner draws the capture, then the pose, then a moment
 * this allows). The moment lists the capture. A hand-held capture faces the phone and has one hand on it: no profile or back, no two-handed or phone
 * moment. A moment with an angle needs that pose. A moment that looks at the viewer is never on a candid, a profile, a back or a face-hidden frame. A
 * flirty moment needs a flirty slot; a legs moment a legs slot, and a legs slot a legs moment (5a.2c).
 */
export function momentAllowed(moment: MomentTags, capture: Capture, pose: ScenePose, level: Level = "ordinary", framing?: "legs"): boolean {
  if (moment.captures !== undefined && !moment.captures.includes(capture)) return false;
  if ((moment.legs !== undefined) !== (framing === "legs")) return false;
  if (LEGS_CAPTURES.includes(capture) && framing !== "legs") return false;
  if (moment.level === "flirty" && level !== "flirty") return false;
  if (!posesFor(capture).includes(pose)) return false;
  if (moment.angle !== undefined && moment.angle !== pose) return false;
  if (isHandCapture(capture) && (moment.twoHanded || moment.phone === true)) return false;
  if (moment.gaze === "viewer" && (capture === "candid" || pose === "profile" || faceVisibleOf({ capture, pose, framing }) === "no")) return false;
  return true;
}

/** What a sentence is made of, once its place and moment are found. */
export interface SentenceParts {
  /** The locative phrase, as the bank or the adapter has it. */
  at: string;
  /** What follows «she»: the bank moment, or «is {activity}» for a custom one. */
  doing: string;
  /** The outfit, with « with {legwear}» when the slot has legwear. */
  wearing: string;
  /** The moment's gaze tag (custom: `viewer` when the activity looks at the camera, `own` when it names her phone). */
  gaze?: MomentGaze | undefined;
  /** The place's details for `with {detail}`; none for a room or a custom place. */
  details: readonly string[];
}

function byLevel<T extends { level?: "flirty" | undefined }>(items: readonly T[], level: Level): readonly T[] {
  const ordinary = items.filter((item) => item.level === undefined);
  if (level !== "flirty") return ordinary;
  const flirty = items.filter((item) => item.level === "flirty");
  return flirty.length > 0 ? flirty : ordinary;
}

function gazeOptions(capture: Capture, pose: ScenePose, gaze: MomentGaze | undefined, level: Level, framing: "legs" | undefined): readonly Gaze[] {
  const kinds = gazeKindsFor(capture, pose, gaze, framing);
  const fitting = GAZE.filter((g) => kinds.includes(g.kind));
  // A moment whose hands are busy keeps an ordinary gaze (plan s5a2 §5.2: «the row's kinds without flirty items»).
  return byLevel(fitting, gaze === "focus" ? "ordinary" : level);
}

function cueOptions(capture: Capture, level: Level): readonly Cue[] {
  return byLevel(
    CUES.filter((c) => c.captures === undefined || c.captures.includes(capture)),
    level,
  );
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface Frame {
  capture: Capture;
  pose: ScenePose;
  framing: "legs" | undefined;
  level: Level;
}

function draw(parts: SentenceParts, frame: Frame, key: string): string {
  const clauses = [capitalise(parts.at), `she ${parts.doing}`, `wearing ${parts.wearing}`];
  if (faceVisibleOf(frame) !== "no") {
    const gazes = gazeOptions(frame.capture, frame.pose, parts.gaze, frame.level, frame.framing);
    if (gazes.length > 0) clauses.push(pick(gazes, key, "gaze").text);
    const cues = cueOptions(frame.capture, frame.level);
    if (cues.length > 0) clauses.push(pick(cues, key, "cue").text);
  }
  if (parts.details.length > 0) clauses.push(`with ${pick(parts.details, key, "detail")}`);
  return `${clauses.join(", ")}.`;
}

/**
 * The sentence for the parts, deduplicated against the run's sentences: an equal one is redrawn on `${key}:dedup:${i}`, i = 1..8, and if every
 * redraw is taken too the slot keeps its first text. Null when a self-shot sentence (selfie, above, prone) would name a phone or say selfie (C1, S5.4).
 */
export function renderSentence(parts: SentenceParts, slot: { capture: Capture; pose: ScenePose; framing?: "legs" | undefined }, ctx: TemplateContext): string | null {
  const frame: Frame = { capture: slot.capture, pose: slot.pose, framing: slot.framing, level: ctx.level ?? "ordinary" };
  const first = draw(parts, frame, ctx.key);
  if (shotOf(slot.capture) === "selfie" && (PHONE_WORDS.test(first) || SELFIE_WORDS.test(first))) return null;
  if (ctx.seen === undefined || !ctx.seen.has(first)) return first;
  for (let i = 1; i <= DEDUP_TRIES; i++) {
    const again = draw(parts, frame, `${ctx.key}:dedup:${i}`);
    if (!ctx.seen.has(again)) return again;
  }
  return first;
}
