import type { ChatMessage } from "../openrouter/types";
import type { Pose } from "./schema";
import type { Shot } from "./types";
import { NO_REFUSAL, POSE_LABEL, SHOT_LABEL, writerRefusalText, type WriterRefusal } from "./writer";

// CS.4b: the idea variant of the scene writer. «+ Своя сцена» gives the writer the owner's idea (any language, up to 500 chars) and a shot and a pose for each
// scene, and it writes one English sentence per scene. Its system prompt is its own: the compose prompt (writer.ts) is byte-pinned and never changes. What the
// writer is told about the woman, the hands, the pose, the clothing and the words is the compose prompt's, line for line (ideaWriter.test.ts pins that).
// This module sees only the idea, the shot and the pose: never the avatar's traits or mood note, never a category.

/** One own scene as the writer is asked about it. `slotIndex` is the scene's id in its set, so `readWriterAnswer` reads the answer as it reads a plan's. */
export interface IdeaSlot {
  slotIndex: number;
  idea: string;
  shot: Shot;
  pose: Pose;
}

export function ideaSystemPrompt(): string {
  return [
    "You write one photorealistic scene sentence for each of the given photo slots, of one recurring adult woman.",
    "Reference images supply her identity, so you never describe her face, never give her a name, and never change her hair, eyes or body type.",
    "",
    "Each slot carries an idea written by the owner, in any language. Understand it, and write the scene in English: for each slot, exactly one full English sentence (never a fragment) that brings the idea to life, using the slot's shot type and pose, and adds natural, concrete detail: where she is, what she wears, what her hands and body do, her expression, the background and the light. Never copy the idea word for word and never leave it in its own language.",
    "",
    "Rules:",
    "- One full sentence per slot, about 25 to 45 words, plain present tense.",
    "- When several slots share an idea, make each one a different moment of it: vary the place, her outfit, the time of day and what she does.",
    '- In a front-camera selfie or a mirror selfie, one hand always holds the phone: describe only what her other, single hand does, or say nothing about her hands. Never describe an action that needs both hands in these shots.',
    '- Match each slot\'s pose: for pose "from behind, her face not visible" write the scene from behind — she never looks at, toward or into the camera, and her face is never described; for pose "in profile, her face turned fully to the side" write her in profile — her face turned to the side, never looking at or toward the camera. For any other pose she may face or glance toward the camera as the shot allows.',
    "- She is a grown adult woman; no children or minors anywhere in the scene, and never a word that suggests she or anyone else is not an adult.",
    "- No revealing clothing (no bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie): whatever the idea says, describe her clothing as covering and non-revealing.",
    "- No text, logos, brand names or readable signs; nothing covers her face.",
    '- Never use "stunning", "beautiful", "perfect" or "flawless".',
    "",
    'Return JSON matching the schema: {"scenes": [{"slotIndex", "sentence"}, ...]}, exactly one object per slot, in the given order.',
  ].join("\n");
}

/** The messages of one attempt of an idea write; `refusal` is why the previous answer was rejected, told in the compose prompt's own words. */
export function ideaMessages(slots: readonly IdeaSlot[], refusal: WriterRefusal = NO_REFUSAL): ChatMessage[] {
  const items = slots.map((slot) => ({ slotIndex: slot.slotIndex, idea: slot.idea, shot: SHOT_LABEL[slot.shot], pose: POSE_LABEL[slot.pose] }));
  const lines = ["Ideas:", JSON.stringify(items, null, 2)];
  if (refusal.problems.length > 0) {
    lines.push("", `An earlier answer was rejected: ${writerRefusalText(refusal)}. Write a new answer that follows every rule.`);
  }
  return [
    { role: "system", content: ideaSystemPrompt() },
    { role: "user", content: lines.join("\n") },
  ];
}
