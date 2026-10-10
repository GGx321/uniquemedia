import { z } from "zod";
import { ScenePose } from "../../shared/engine";
import type { ChatMessage } from "../openrouter/types";
import { isPhoneInHandShot, type Pose } from "./schema";
import type { Shot } from "./types";
import { NO_REFUSAL, POSE_LABEL, readWriterScenes, SHOT_LABEL, writerRefusalText, type ReadableSlot, type WriterRefusal } from "./writer";

// CS.4b: the idea variant of the scene writer. «+ Своя сцена» gives the writer the owner's idea (any language, up to 500 chars) and a shot and a pose for each
// scene, and it writes one English sentence per scene. Its system prompt is its own: the compose prompt (writer.ts) is byte-pinned and never changes. What the
// writer is told about the woman, the hands, the pose, the clothing and the words is the compose prompt's, line for line (ideaWriter.test.ts pins that).
// This module sees only the idea, the shot and the pose: never the avatar's traits or mood note, never a category.
//
// CS.8a: what the owner did not fix, the model picks from the idea. A slot's `shot` is null for «Авто» and its `pose` is null for a new idea write (the angle
// is the owner's idea: «вид сзади» is a view from behind, whatever the run's «Ракурсы» toggles say); a rewrite of an own scene gives both and keeps them.
// The model returns what was asked of it, and `readIdeaAnswer` holds it to the vocabulary and the pairing rule: a selfie or a mirror shot faces the camera,
// «Авто» never picks the mirror. A wrong or missing pick is a refusal (`bad-angle`) the next attempt is told, never a value we invent.
// The structured-output schema is built per write (`ideaJsonSchema`): a key only for what is asked, plain enums, no nulls.

/**
 * The shots the model may pick for an «Авто» slot: «Авто» never draws the mirror (an own scene has no place for a mirror to sit on) and never the photographer
 * (every photo is an ordinary phone photo a friend or she took, and a photographer shot would contradict that; before CS.8a «Авто» never picked it
 * either). A photographer the owner chose himself is kept as is: it is a given shot, not a pick.
 */
export const PICKABLE_SHOTS = ["friend", "selfie", "candid"] as const satisfies readonly Shot[];

/** With the mirror, which only an idea that names a mirror (`ideaNamesMirror`, tested before the call) may be written with on «Авто». */
const PICKABLE_SHOTS_WITH_MIRROR = ["friend", "selfie", "mirror", "candid"] as const satisfies readonly Shot[];

function pickable(mirrorAllowed: boolean): readonly Shot[] {
  return mirrorAllowed ? PICKABLE_SHOTS_WITH_MIRROR : PICKABLE_SHOTS;
}

/** Which of the two the model is asked to pick in one write: the schema carries a key only for what is asked. */
export interface IdeaAsks {
  shot: boolean;
  pose: boolean;
}

const ASKS_BOTH: IdeaAsks = { shot: true, pose: true };

/** What a write asks of the model: a key is asked when any of its slots leaves it to the model (in practice all slots of one write ask alike). */
export function ideaAsksOf(slots: readonly { askShot: boolean; askPose: boolean }[]): IdeaAsks {
  return { shot: slots.some((s) => s.askShot), pose: slots.some((s) => s.askPose) };
}

/**
 * One own scene as the writer is asked about it. `slotIndex` is the scene's id in its set, so the answer is read as a plan's. A null `shot` or `pose` is the
 * model's to pick (the prompt says "choose"); one that is set is given and kept.
 */
export interface IdeaSlot {
  slotIndex: number;
  idea: string;
  shot: Shot | null;
  pose: Pose | null;
}

/** An idea slot that gives both its shot and its pose: the case before CS.8a, and a rewrite of an own scene. */
export type FixedIdeaSlot = IdeaSlot & { shot: Shot; pose: Pose };

/** The angle an idea write settled on for one scene. */
export interface IdeaAngle {
  shot: Shot;
  pose: Pose;
}

/**
 * An own scene as the write job holds it: what the answer reader needs of a slot (`shot` and `pose` are the stored draw, a fallback the job never sends) and
 * which of the two the model is asked to pick. `toIdeaSlot` is what the writer is shown.
 */
export interface IdeaAsk extends ReadableSlot {
  idea: string;
  askShot: boolean;
  askPose: boolean;
}

export function toIdeaSlot(ask: IdeaAsk): IdeaSlot {
  return { slotIndex: ask.slotIndex, idea: ask.idea, shot: ask.askShot ? null : ask.shot, pose: ask.askPose ? null : ask.pose };
}

export function ideaSystemPrompt(mirrorAllowed = false): string {
  return [
    "You write one plain sentence of what an ordinary phone photo of her shows, for each of the given slots, of one recurring adult woman who posts her own photos.",
    "Reference images supply her identity, so you never describe her face, never give her a name, and never describe her hair, eyes or body type.",
    "",
    "Each slot carries an idea written by the owner, in any language. Understand it, and write the scene in English: for each slot, exactly one full English sentence (never a fragment) that brings the idea to life, using the slot's shot type and pose, and adds natural, concrete detail: where she is, what she wears, what her hands and body do, her expression, and at most one ordinary detail of the place. Do not describe the light, the colours or the mood; if light comes up, name only its source. Never copy the idea word for word and never leave it in its own language.",
    "",
    "Rules:",
    "- One full sentence per slot, about 25 to 45 words, plain present tense.",
    "- When several slots share an idea, make each one a different moment of it: vary the place, her outfit and what she does.",
    '- In a front-camera selfie or a mirror selfie, only one hand is free: describe only what that hand does, or say nothing about her hands. Never describe an action that needs both hands in these shots.',
    '- Match each slot\'s pose: for pose "from behind, her face not visible" write the scene from behind — she never looks at, toward or into the viewer, and her face is never described; for pose "in profile, her face turned fully to the side" write her in profile — her face turned to the side, never looking at or toward the viewer. For any other pose she may face or glance toward the viewer as the shot allows.',
    `- When a slot's "shot" or "pose" is "choose", pick it from the idea and return it in that slot's "shot" or "pose": the shot is ${mirrorAllowed ? "friend, selfie, mirror or candid" : "friend, selfie or candid"}; the pose is front, three-quarter, profile or back. Use "back" when the idea asks for a view from behind and "profile" for a side view. A selfie always faces the camera, and so does a mirror shot (front or three-quarter), so for a view from behind or from the side pick friend or candid. ${mirrorAllowed ? "The idea names a mirror, so you may pick the mirror shot, only for a mirror selfie." : "Never choose the mirror shot."} Then write the scene for what you picked. A shot or a pose the slot gives is kept as given: never return it.`,
    "- She is a grown adult woman; no children or minors anywhere in the scene, and never a word that suggests she or anyone else is not an adult.",
    "- No revealing clothing (no bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie): whatever the idea says, describe her clothing as covering and non-revealing.",
    "- No text, logos, brand names or readable signs; nothing covers her face.",
    "- Never write about the camera, the lens, the photo, the shot or the framing.",
    "- When she looks toward whoever takes the photo, write that she looks at the viewer; never name a phone, camera or lens for her gaze. Her own phone appears only when the slot's activity uses it.",
    "- No paper, books, magazines, documents, notebooks, menus, maps, desks or studying; no laptops or tablets: her phone is the only screen.",
    "- Never describe mess, clutter or things lying around; the room's state is given separately.",
    "- Never use these words: professional, photographer, photoshoot, studio, editorial, fashion, model, posing, captures, candid, cinematic, bokeh, golden hour, softly lit, soft light, glow, glowing, dramatic, moody, dreamy, elegant, luxurious, lavish, glamorous, chic, sophisticated, polished, pristine, marble, silk, satin, velvet, stunning, beautiful, perfect, flawless, gorgeous, unless the slot's own place, outfit or activity uses it.",
    "",
    'Return JSON matching the schema: {"scenes": [...]}, exactly one object per slot, in the given order, each with "slotIndex", "sentence" and, only where the schema has them, "shot" and "pose".',
  ].join("\n");
}

/** What a "choose" slot shows in place of a label. */
const CHOOSE = "choose";

/** The messages of one attempt of an idea write; `refusal` is why the previous answer was rejected, told in the compose prompt's own words. */
export function ideaMessages(slots: readonly IdeaSlot[], refusal: WriterRefusal = NO_REFUSAL, mirrorAllowed = false): ChatMessage[] {
  const items = slots.map((slot) => ({
    slotIndex: slot.slotIndex,
    idea: slot.idea,
    shot: slot.shot === null ? CHOOSE : SHOT_LABEL[slot.shot],
    pose: slot.pose === null ? CHOOSE : POSE_LABEL[slot.pose],
  }));
  const lines = ["Ideas:", JSON.stringify(items, null, 2)];
  if (refusal.problems.length > 0) {
    lines.push("", `An earlier answer was rejected: ${writerRefusalText(refusal)}. Write a new answer that follows every rule.`);
  }
  return [
    { role: "system", content: ideaSystemPrompt(mirrorAllowed) },
    { role: "user", content: lines.join("\n") },
  ];
}

/**
 * Structured output, built per write from what the model is asked: {slotIndex, sentence} per scene, plus `shot` and/or `pose` as plain required string enums, and
 * only when the write leaves them to the model. No key is nullable and no enum holds null: a nullable enum is the shape a provider may refuse, and a refusal here
 * would fail every idea write. A key that is not asked is simply not in the schema.
 */
export function ideaJsonSchema(mirrorAllowed: boolean, asks: IdeaAsks = ASKS_BOTH): { name: string; schema: Record<string, unknown> } {
  const properties: Record<string, unknown> = {
    slotIndex: { type: "integer" },
    sentence: { type: "string" },
    ...(asks.shot ? { shot: { type: "string", enum: [...pickable(mirrorAllowed)] } } : {}),
    ...(asks.pose ? { pose: { type: "string", enum: [...ScenePose.options] } } : {}),
  };
  return {
    name: "scene_ideas",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scenes"],
      properties: {
        scenes: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: Object.keys(properties), properties },
        },
      },
    },
  };
}

/** The schema of an idea whose text names no mirror, with the shot and the pose both asked: the shots without the mirror. */
export const IDEA_JSON_SCHEMA = ideaJsonSchema(false);

// ---------- reading the answer ----------

/** The JSON of the answer, tolerating a markdown fence around it (as writer.ts reads one). */
function parseJson(content: string): unknown {
  const unfenced = content.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

/** shot and pose are read loosely here (`unknown`) so a bad pick is a `bad-angle` of one slot, not a refusal of the whole answer's shape. */
const IdeaOutputSchema = z.strictObject({
  scenes: z.array(z.strictObject({ slotIndex: z.int().positive(), sentence: z.string().min(1), shot: z.unknown().optional(), pose: z.unknown().optional() })),
});

export type IdeaAnswer = { ok: true; sentences: Map<number, string>; angles: Map<number, IdeaAngle> } | ({ ok: false } & WriterRefusal);

function pickedShot(value: unknown, mirrorAllowed: boolean): Shot | undefined {
  return pickable(mirrorAllowed).find((shot) => shot === value);
}

function pickedPose(value: unknown): Pose | undefined {
  const parsed = ScenePose.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The angle one scene settles on, or undefined when the pick is missing, outside the vocabulary, or a selfie or a mirror shot facing away. */
function settle(slot: IdeaSlot, scene: { shot?: unknown; pose?: unknown }, mirrorAllowed: boolean): IdeaAngle | undefined {
  const shot = slot.shot ?? pickedShot(scene.shot, mirrorAllowed);
  const pose = slot.pose ?? pickedPose(scene.pose);
  if (shot === undefined || pose === undefined) return undefined;
  if (isPhoneInHandShot(shot) && (pose === "back" || pose === "profile")) return undefined;
  return { shot, pose };
}

/**
 * The model's answer to an idea write: one sentence per scene, read by the writer's own rules (`readWriterScenes`) against the angle each scene settled on, and
 * that angle. A shot or a pose the slot gave is kept whatever the answer says; one it left to the model must be a real pick, and a selfie or a mirror shot must
 * face the camera. A pick that fails either is a `bad-angle` refusal naming the slot; the sentence rules still run for it on the angle it was given, so one
 * retry is told everything that was wrong. The mirror is a real pick only when `mirrorAllowed` (the idea names a mirror, tested before the call).
 */
export function readIdeaAnswer(content: string, slots: readonly IdeaSlot[], mirrorAllowed = false): IdeaAnswer {
  const parsed = IdeaOutputSchema.safeParse(parseJson(content));
  if (!parsed.success) return { ok: false, problems: ["not-json"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] };

  const first = new Map<number, (typeof parsed.data.scenes)[number]>();
  for (const scene of parsed.data.scenes) if (!first.has(scene.slotIndex)) first.set(scene.slotIndex, scene);

  const angles = new Map<number, IdeaAngle>();
  const angleSlots: number[] = [];
  const readable: ReadableSlot[] = slots.map((slot) => {
    const scene = first.get(slot.slotIndex);
    // A scene the answer lacks is the number rules' to report; it reads as a given angle here.
    const settled = scene === undefined ? undefined : settle(slot, scene, mirrorAllowed);
    if (scene !== undefined && settled === undefined) angleSlots.push(slot.slotIndex);
    const angle = settled ?? { shot: slot.shot ?? "friend", pose: slot.pose ?? "front" };
    if (settled !== undefined) angles.set(slot.slotIndex, settled);
    return { slotIndex: slot.slotIndex, shot: angle.shot, pose: angle.pose };
  });

  const read = readWriterScenes(parsed.data.scenes, readable);
  if (read.ok && angleSlots.length === 0) return { ok: true, sentences: read.sentences, angles };
  const refusal: WriterRefusal = read.ok ? { problems: [], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] } : read;
  return { ok: false, ...refusal, problems: angleSlots.length === 0 ? refusal.problems : [...refusal.problems, "bad-angle"], ...(angleSlots.length === 0 ? {} : { angleSlots }) };
}
