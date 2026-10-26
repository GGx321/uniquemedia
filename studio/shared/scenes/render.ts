import type { PoolShot, SceneRoute, ScenePose } from "../engine";
// S5.9b2: the gaze and cue lists straight from their module, so the bank schema (banks/schema.ts) can read `momentAllowed` without an import cycle through banks/index.ts.
import { CUES, GAZE } from "./banks/looks";
import type { Angle, Cue, Gaze, GazeKind, Level, MomentGaze } from "./banks/types";
import { captureOfShot, faceVisibleOf, isHandCapture, LEGS_CAPTURES, posesFor, shotOf, type Capture } from "./captures";
import { pick } from "./hash";
import { atOrBelow } from "./level";
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
  /** «Подача» of this slot (S5.7b): a slot's own level wins over the context's, since a run mixes flirty and ordinary slots. Absent: the context's, else ordinary. */
  level?: Level | undefined;
  /** 5a.4 (S5.BA3, I5.73): the Seedream route, the marker of a «Смелая» frame of any category. With it the five read their companion bank; absent (a slot stored before 5a.4): the bank they always read. */
  route?: SceneRoute | undefined;
}

export interface TemplateContext {
  /** The slot's draw key: `slotKeyOf(runId, attemptIdBase)` for a run, `${sceneSetId}:${sceneId}:${k}` for a scene set's k-th write. */
  key: string;
  /** The custom categories the plan or the set holds a snapshot of. */
  snapshots?: readonly { ref: string }[] | undefined;
  /** «Подача» (5a.2b). Absent: ordinary. */
  level?: Level | undefined;
  /**
   * 5a.4 (S5.BA1, plan s5a4 I5.74, M7): the render's origin input. True only for an avatar created in Studio (`studioCreated`, S5.BA5): then an implied cover may be planned and a frame may say its
   * `openCoverage`. Absent or false is the fail-closed default (imported): every Seedream outfit keeps its restrictive `coverage`. Nothing reads it before S5.BA3.
   */
  impliedNudity?: boolean | undefined;
  /** The sentences already rendered in this run: an equal one is redrawn. */
  seen?: ReadonlySet<string> | undefined;
  /**
   * A rewrite of a scene (the review's «Другая сцена», free for a scene the template writes): the held texts include the scene's own old one, and the new text must not
   * be any of them. A slot with nothing left to vary (from behind, a custom place) then takes another opening of its outfit clause instead of keeping its first text, which
   * is what a run's own dedup still does (the moment-repeat metric flags that).
   */
  distinct?: boolean | undefined;
  /** The gazes and expressions the sentences before this one said (S5.6R): one said twice in the last 19 is not drawn again while another fits. Absent: no cap. */
  tally?: GazeCueTally | undefined;
}

/** The redraws an equal sentence gets before the slot keeps it (I5.24). */
export const DEDUP_TRIES = 8;

/** S5.6R (round C): a gaze, and an expression (cue), is said at most this many times in any `GAZE_CUE_WINDOW` sentences in a row of a run. */
export const GAZE_CUE_CAP = 2;
export const GAZE_CUE_WINDOW = 20;

/**
 * The gazes and expressions a run's last sentences said (S5.6R, round C: one expression came back 3 times or more in 499 of 500 twenty-photo runs). The
 * caller renders a list of slots in order and keeps one tally for it (`localSentences`, the mock's `localTexts`), so the draws stay a pure function of the
 * list and a resume renders the same text. A sentence with no gaze or cue (her face hidden) still takes its place in the window.
 */
export class GazeCueTally {
  private readonly recent: (readonly string[])[] = [];

  /** The options that may be said once more; when every one is at the cap, the ones said least. In the given order, so an uncapped draw picks as before. */
  open<T extends { text: string }>(options: readonly T[]): readonly T[] {
    const counts = options.map((option) => this.recent.filter((said) => said.includes(option.text)).length);
    const open = options.filter((_, i) => (counts[i] ?? 0) < GAZE_CUE_CAP);
    if (open.length > 0) return open;
    const least = Math.min(...counts);
    return options.filter((_, i) => counts[i] === least);
  }

  /** Records what one rendered sentence said. */
  add(said: readonly string[]): void {
    this.recent.push(said);
    if (this.recent.length > GAZE_CUE_WINDOW - 1) this.recent.shift();
  }
}

/** The tags `momentAllowed` reads: a bank moment, or an old custom activity read through the adapter (which lists no captures: any fits). */
export interface MomentTags {
  captures?: readonly Capture[] | undefined;
  twoHanded: boolean;
  phone?: true | undefined;
  level?: "flirty" | "bold" | undefined;
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
  // «Ножки» (S5.8a review): her legs fill the frame and her face may be out of it, so a look at the viewer, away or at her hands would pull the frame to her face and read as staged: only a look down.
  if (framing === "legs") return ["down"];
  const shot = shotOf(capture);
  const kinds: GazeKind[] = shot === "mirror" ? ["mirror", "down"] : shot === "selfie" ? ["viewer", "down"] : capture === "candid" || pose === "profile" ? ["away", "down"] : ["viewer", "away", "down"];
  if (gaze === "focus" && !isHandCapture(capture)) kinds.push("hands");
  return kinds;
}

/**
 * Whether a slot of this capture, pose, level and framing may take the moment (I5.23; the planner draws the capture, then the pose, then a moment
 * this allows). The moment lists the capture. A hand-held capture faces the phone and has one hand on it: no profile or back, no two-handed or phone
 * moment. A moment with an angle needs that pose. A moment that looks at the viewer is never on a candid, a profile, a back or a face-hidden frame. A
 * moment needs a slot of its level or above (ordinary < flirty < bold, 5a.3); a legs moment a legs slot, and a legs slot a legs moment (5a.2c).
 */
export function momentAllowed(moment: MomentTags, capture: Capture, pose: ScenePose, level: Level = "ordinary", framing?: "legs"): boolean {
  if (moment.captures !== undefined && !moment.captures.includes(capture)) return false;
  if ((moment.legs !== undefined) !== (framing === "legs")) return false;
  if (LEGS_CAPTURES.includes(capture) && framing !== "legs") return false;
  if (!atOrBelow(moment.level, level)) return false;
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
  /** The moment's gaze tag (custom: `viewer` when the activity looks at the camera, `own` when its eyes are already busy). */
  gaze?: MomentGaze | undefined;
  /** The moment shows her expression itself: no cue. */
  expression?: boolean | undefined;
  /** A hand is already at her face: no hand cue. */
  handAtFace?: boolean | undefined;
  /** The place's details for `with {detail}`; none for a room or a custom place. */
  details: readonly string[];
  /** 5a.3: the positive coverage sentence of what the moment or the outfit shows, appended after the scene sentence («Смелая» banks only). */
  coverage?: string | undefined;
}

/**
 * The entries a slot of this level draws from (5a.3: ranked ordinary < flirty < bold). An ordinary slot takes the ordinary entries; a flirty slot the flirty ones when there are
 * any, else the ordinary ones; a bold slot the bold ones, then the flirty ones, then the ordinary ones (the gaze and cue lists have no bold entry, so a bold slot reads their flirty
 * list, as plan s5a3 §7.3 has it).
 */
function byLevel<T extends { level?: "flirty" | "bold" | undefined }>(items: readonly T[], level: Level): readonly T[] {
  const at = (wanted: "flirty" | "bold" | undefined): readonly T[] => items.filter((item) => item.level === wanted);
  if (level === "ordinary") return at(undefined);
  if (level === "bold") {
    const bold = at("bold");
    if (bold.length > 0) return bold;
  }
  const flirty = at("flirty");
  return flirty.length > 0 ? flirty : at(undefined);
}

function gazeOptions(capture: Capture, pose: ScenePose, gaze: MomentGaze | undefined, level: Level, framing: "legs" | undefined): readonly Gaze[] {
  const kinds = gazeKindsFor(capture, pose, gaze, framing);
  const fitting = GAZE.filter((g) => kinds.includes(g.kind));
  // A moment whose hands are busy keeps an ordinary gaze (plan s5a2 §5.2: «the row's kinds without flirty items»).
  return byLevel(fitting, gaze === "focus" ? "ordinary" : level);
}

function cueOptions(capture: Capture, level: Level, handAtFace: boolean): readonly Cue[] {
  return byLevel(
    CUES.filter((c) => (c.captures === undefined || c.captures.includes(capture)) && !(handAtFace && c.hand === true)),
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

/**
 * How the outfit clause opens. The first draw always says «wearing»; only a rewrite's redraw (`ctx.distinct`) whose text came out equal to the first (a frame with no gaze, cue or detail
 * to vary: from behind, or a custom place) takes another opening, so the scene is not rewritten into the text it already has.
 */
const OUTFIT_OPENINGS = ["wearing", "dressed in", "in", "clad in"] as const;

/** A drawn sentence and the gaze and cue it says. */
interface Drawn {
  text: string;
  said: readonly string[];
}

function draw(parts: SentenceParts, frame: Frame, key: string, tally: GazeCueTally | undefined, opening: number = 0): Drawn {
  const clauses = [capitalise(parts.at), `she ${parts.doing}`, `${OUTFIT_OPENINGS[opening % OUTFIT_OPENINGS.length]} ${parts.wearing}`];
  const said: string[] = [];
  if (faceVisibleOf(frame) !== "no") {
    const gazes = gazeOptions(frame.capture, frame.pose, parts.gaze, frame.level, frame.framing);
    if (gazes.length > 0) said.push(pick(tally?.open(gazes) ?? gazes, key, "gaze").text);
    // A legs frame carries no expression either (no smile for the viewer), only what she does.
    const cues = parts.expression === true || frame.framing === "legs" ? [] : cueOptions(frame.capture, frame.level, parts.handAtFace === true);
    if (cues.length > 0) said.push(pick(tally?.open(cues) ?? cues, key, "cue").text);
  }
  clauses.push(...said);
  if (parts.details.length > 0) clauses.push(`with ${pick(parts.details, key, "detail")}`);
  return { text: parts.coverage === undefined ? `${clauses.join(", ")}.` : `${clauses.join(", ")}. ${parts.coverage}`, said };
}

/**
 * The sentence for the parts, deduplicated against the run's sentences: an equal one is redrawn on `${key}:dedup:${i}`, i = 1..8, and if every
 * redraw is taken too the slot keeps its first text. With `ctx.distinct` (a rewrite), a redraw that comes out equal to the first (nothing in the frame varies) opens its outfit clause another way
 * («dressed in», «in», «clad in»), so a free redraw of such a slot is a different sentence. Null when a self-shot sentence (selfie, above, prone) would name a phone or say selfie (C1, S5.4).
 * With `ctx.tally`, the gaze and the cue are drawn from those the run has not said twice in its last 19 sentences, and the kept sentence is added to it.
 */
export function renderSentence(parts: SentenceParts, slot: { capture: Capture; pose: ScenePose; framing?: "legs" | undefined }, ctx: TemplateContext): string | null {
  const frame: Frame = { capture: slot.capture, pose: slot.pose, framing: slot.framing, level: ctx.level ?? "ordinary" };
  const first = draw(parts, frame, ctx.key, ctx.tally);
  if (shotOf(slot.capture) === "selfie" && (PHONE_WORDS.test(first.text) || SELFIE_WORDS.test(first.text))) return null;
  const kept = deduped(parts, frame, ctx, first);
  ctx.tally?.add(kept.said);
  return kept.text;
}

function deduped(parts: SentenceParts, frame: Frame, ctx: TemplateContext, first: Drawn): Drawn {
  if (ctx.seen === undefined || !ctx.seen.has(first.text)) return first;
  for (let i = 1; i <= DEDUP_TRIES; i++) {
    const redrawn = draw(parts, frame, `${ctx.key}:dedup:${i}`, ctx.tally);
    // Nothing else to vary: the same text again. Another opening of the outfit clause is the one change that keeps place, activity and outfit as they were.
    const again = ctx.distinct === true && redrawn.text === first.text ? draw(parts, frame, `${ctx.key}:dedup:${i}`, ctx.tally, i) : redrawn;
    if (!ctx.seen.has(again.text)) return again;
  }
  return first;
}
