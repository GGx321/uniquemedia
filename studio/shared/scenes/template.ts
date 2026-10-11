import type { PoolShot, ScenePose } from "../engine";
import { BANKS, CUES, GAZE } from "./banks";
import { BANK_CATEGORIES, type BankCategory, type Cue, type Gaze, type GazeKind, type Level, type Moment, type MomentGaze } from "./banks/types";
import { pick } from "./hash";
import { PHONE_WORDS, SELFIE_WORDS } from "./words";

// 5a.2 (S5.6a, plan s5a2 §5.2): the code template. Every new built-in planned scene gets its sentence from here, not from the LLM writer:
//
//   «{At}, she {moment}, wearing {outfit}, {gaze}, {cue}, with {detail}.»
//
// with r1.1's corrections: a gaze never names a camera or a lens, and only a mirror gaze names her phone (K-2); a room drops `with {detail}`, because
// its room phrase already carries the details (K-3); a back pose drops both the gaze and the cue. A frame with her face hidden (the owner's references,
// 2026-10-11) drops them too. The draws are hash picks of the slot's key (I5.4: a resume renders the same text), on the streams `gaze`, `cue` and
// `detail`; an equal sentence in the same run is redrawn on `${key}:dedup:${i}` (I5.24). Never a throw: whatever the bank cannot render is null, and
// a null slot goes to the LLM writer (I5.22).

/** What the template reads of a slot: a plan slot, a scene-set scene, or a candidate the planner is weighing. */
export interface TemplateSlot {
  category: string;
  location?: string | undefined;
  activity?: string | undefined;
  outfit?: string | undefined;
  shot: PoolShot;
  pose: ScenePose;
  /** Absent: her face shows. A face-hidden frame (a hook for the references' captures) gets no gaze and no cue. */
  faceVisible?: boolean | undefined;
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

const isHandShot = (shot: PoolShot): boolean => shot === "selfie" || shot === "mirror";

/**
 * The gaze kinds a slot may draw (the coherence table, plan s5a2 §5.2). A back pose and a moment that carries its own gaze (or looks at the viewer
 * itself) take none. A selfie looks at the viewer or down; a mirror shot at her reflection or down; a friend's snap may look anywhere; a candid and a
 * profile never at the viewer. Only a moment whose hands are busy (`focus`) may take «her eyes on what her hands are doing», never on a hand shot.
 */
export function gazeKindsFor(shot: PoolShot, pose: ScenePose, gaze?: MomentGaze): readonly GazeKind[] {
  if (pose === "back" || gaze === "own" || gaze === "viewer") return [];
  const kinds: GazeKind[] = shot === "selfie" ? ["viewer", "down"] : shot === "mirror" ? ["mirror", "down"] : shot === "candid" || pose === "profile" ? ["away", "down"] : ["viewer", "away", "down"];
  if (gaze === "focus" && !isHandShot(shot)) kinds.push("hands");
  return kinds;
}

/**
 * Whether a slot of this shot, pose and level may take the moment (I5.23; the planner draws the pose first, then a moment this allows). A hand shot
 * (selfie, mirror) has one hand on the phone and faces it: no two-handed or phone moment, no profile or back. A moment with an angle needs that pose.
 * A moment that looks at the viewer is never on a candid, a profile or a back. A flirty moment needs a flirty slot. A legs moment waits for «Ножки»
 * (5a.2c), and a moment limited to captures takes only the drawn ones it names.
 */
export function momentAllowed(moment: Moment, shot: PoolShot, pose: ScenePose, level: Level = "ordinary"): boolean {
  if (moment.legs !== undefined) return false;
  if (moment.captures !== undefined && !moment.captures.includes(shot)) return false;
  if (moment.level === "flirty" && level !== "flirty") return false;
  if (moment.angle !== undefined && moment.angle !== pose) return false;
  if (isHandShot(shot) && (moment.twoHanded || moment.phone === true || pose === "profile" || pose === "back")) return false;
  if (moment.gaze === "viewer" && (shot === "candid" || pose === "profile" || pose === "back")) return false;
  return true;
}

/** What a sentence is made of, once its place and moment are found. */
export interface SentenceParts {
  /** The locative phrase, as the bank or the adapter has it. */
  at: string;
  /** What follows «she»: the bank moment, or «is {activity}» for a custom one. */
  doing: string;
  outfit: string;
  /** The moment's gaze tag (custom: `own` when the activity looks itself). */
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

function gazeOptions(shot: PoolShot, pose: ScenePose, gaze: MomentGaze | undefined, level: Level): readonly Gaze[] {
  const kinds = gazeKindsFor(shot, pose, gaze);
  const fitting = GAZE.filter((g) => kinds.includes(g.kind));
  // A moment whose hands are busy keeps an ordinary gaze (plan s5a2 §5.2: «the row's kinds without flirty items»).
  return byLevel(fitting, gaze === "focus" ? "ordinary" : level);
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function draw(parts: SentenceParts, shot: PoolShot, pose: ScenePose, faceShows: boolean, level: Level, key: string): string {
  const clauses = [capitalise(parts.at), `she ${parts.doing}`, `wearing ${parts.outfit}`];
  if (faceShows && pose !== "back") {
    const gazes = gazeOptions(shot, pose, parts.gaze, level);
    if (gazes.length > 0) clauses.push(pick(gazes, key, "gaze").text);
    const cues: readonly Cue[] = byLevel(CUES, level);
    if (cues.length > 0) clauses.push(pick(cues, key, "cue").text);
  }
  if (parts.details.length > 0) clauses.push(`with ${pick(parts.details, key, "detail")}`);
  return `${clauses.join(", ")}.`;
}

/**
 * The sentence for the parts, deduplicated against the run's sentences: an equal one is redrawn on `${key}:dedup:${i}`, i = 1..8, and if every
 * redraw is taken too the slot keeps its first text. Null when a selfie's sentence would name a phone or say selfie (C1, S5.4).
 */
export function renderSentence(parts: SentenceParts, slot: Pick<TemplateSlot, "shot" | "pose" | "faceVisible">, ctx: TemplateContext): string | null {
  const level = ctx.level ?? "ordinary";
  const faceShows = slot.faceVisible !== false;
  const first = draw(parts, slot.shot, slot.pose, faceShows, level, ctx.key);
  if (slot.shot === "selfie" && (PHONE_WORDS.test(first) || SELFIE_WORDS.test(first))) return null;
  if (ctx.seen === undefined || !ctx.seen.has(first)) return first;
  for (let i = 1; i <= DEDUP_TRIES; i++) {
    const again = draw(parts, slot.shot, slot.pose, faceShows, level, `${ctx.key}:dedup:${i}`);
    if (!ctx.seen.has(again)) return again;
  }
  return first;
}

function bankCategory(category: string): BankCategory | undefined {
  return BANK_CATEGORIES.find((c) => c === category);
}

/** A built-in slot's sentence: its place by name in its category's bank, its moment by text in that place, its outfit in the bank's list. */
function builtInSentence(category: BankCategory, slot: TemplateSlot, ctx: TemplateContext): string | null {
  const bank = BANKS[category];
  const place = bank.places.find((p) => p.name === slot.location);
  const moment = place?.moments.find((m) => m.text === slot.activity);
  if (place === undefined || moment === undefined || slot.outfit === undefined || !bank.outfits.includes(slot.outfit)) return null;
  if (!momentAllowed(moment, slot.shot, slot.pose, ctx.level ?? "ordinary")) return null;
  const parts: SentenceParts = { at: place.at, doing: moment.text, outfit: slot.outfit, gaze: moment.gaze, details: place.room === true ? [] : place.details };
  return renderSentence(parts, slot, ctx);
}

/** The slot's sentence from the banks, or null when they cannot render it (it then goes to the LLM writer at its chunk's reserved ids). */
export function templateSentence(slot: TemplateSlot, ctx: TemplateContext): string | null {
  const category = bankCategory(slot.category);
  if (category !== undefined) return builtInSentence(category, slot, ctx);
  return null;
}
