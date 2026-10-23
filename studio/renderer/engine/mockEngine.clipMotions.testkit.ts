import type { ClipOptions, EngineError } from "../../shared/engine";
import type { MockModelReply } from "./mockClipMotions";
import { AVATAR, CLIP_PHOTOS, makeClipMock, money, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Test support for the mock's part C tests (Stage 5, 5b.2, S5.WC4): the clip mock of 5b.1 with the four motion commands as the window sends them, and the model's answers as the wire shapes the engine reads. Every figure
// the tests expect is the ENGINE's (engine.clipMotions*.test.ts, clips/motion*.test.ts), so a drift of the mock from the engine reads as a failing number.

export { CLIP_PHOTOS, makeClipMock, money, unwrap };
export type { ClipMock };
export { AVATAR, create, createPayload, endOf, listClips, phasesOf, runUntilEnd, suitable } from "./mockEngine.clips.testkit";

export const PLAIN = CLIP_PHOTOS.plain.photoId;
export const BOLD = CLIP_PHOTOS.bold.photoId;

/** The prices of the two calls at the engine's bundled table with its system prompts (clips/motionPrice.ts). */
export const SUGGEST = { expectedMicros: 5_310, worstMicros: 34_024 } as const;
export const TRANSLATE = { expectedMicros: 1_363, worstMicros: 29_088 } as const;
/** What the first attempt of a call on the plain frame reserves: the engine reserves for the message it really sends (chatAttemptWorstMicros), so it is below half of the widest case; mockEngine.clipMotions.money.test.ts holds it to the real ledger. */
export const SUGGEST_ATTEMPT = 16_268;
export const TRANSLATE_ATTEMPT = 13_263;

/** None of them is a code motion of a frame (S5.WC3c: a suggestion equal to one is not stored). */
export const GOOD_TEXTS = [
  "she slowly tucks a strand of hair behind her ear",
  "she slowly lifts her chin and smiles softly",
  "she slowly turns toward the window and smiles",
  "she slowly looks down and smiles to herself",
  "she slowly glances to the side and looks back",
] as const;

/** The owner's idea, with a canary far enough in that the first 40 characters (the label) do not hold it. */
export const IDEA = "медленно поворачивает голову к окну и улыбается, CANARY-9c41";
export const CANARY = "CANARY-9c41";
/** The sheet's code motion `g-tilt` on the plain photo. */
export const CODE_TEXT = "she tilts her head a little to one side and smiles";
export const NOT_MOTION = "slowly she turns her head";
export const UNDRESS = "she slowly takes off her robe";
/** The same with an age: the minor-age guard refuses it on every frame, and no repair is asked for (S5.WC2c). */
export const UNDER_AGE = "she slowly takes off her robe, aged sixteen";

/** The writer's answer for these texts (labels «Движение n»). */
export function suggestion(texts: readonly string[], costMicros = 3_400, frame: Record<string, unknown> = { capture: "unknown", phoneVisible: false, faceVisible: true }): MockModelReply {
  return { kind: "answer", content: JSON.stringify({ motions: texts.map((text, i) => ({ label_ru: `Движение ${i + 1}`, text_en: text })), frame }), costMicros };
}

export function idea(text: string, costMicros = 1_000): MockModelReply {
  return { kind: "answer", content: JSON.stringify({ text_en: text, refusal: "none" }), costMicros };
}

/** S5.WCX: the translator's own refusal: no text, one closed code. */
export function ideaRefusal(code: string, costMicros = 600): MockModelReply {
  return { kind: "answer", content: JSON.stringify({ text_en: "", refusal: code }), costMicros };
}

/** A paid answer that is no JSON at all (the model talks): unusable, a second attempt may follow. */
export const UNREADABLE: MockModelReply = { kind: "answer", content: "I cannot see the photo", costMicros: 2_000 };

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

export function suggestPayload(photoId = PLAIN, acceptedWorstMicros = 1_000_000) {
  return { avatarId: AVATAR, photoId, acceptedWorstMicros };
}
export function translatePayload(text = IDEA, photoId = PLAIN, acceptedWorstMicros = 1_000_000) {
  return { avatarId: AVATAR, photoId, text, acceptedWorstMicros };
}

export function suggest(m: ClipMock, photoId = PLAIN, accepted = 1_000_000) {
  return m.client.request("clips.suggestMotions", suggestPayload(photoId, accepted));
}
export function translate(m: ClipMock, text = IDEA, photoId = PLAIN, accepted = 1_000_000) {
  return m.client.request("clips.translateIdea", translatePayload(text, photoId, accepted));
}
export function estimateSuggest(m: ClipMock, photoId = PLAIN) {
  return m.client.request("clips.estimateSuggest", { avatarId: AVATAR, photoId });
}
export function estimateIdea(m: ClipMock, photoId = PLAIN) {
  return m.client.request("clips.estimateIdea", { avatarId: AVATAR, photoId });
}

export async function errorOf(reply: Promise<{ ok: boolean; error?: EngineError }>): Promise<EngineError> {
  const r = await reply;
  if (r.ok || r.error === undefined) throw new Error("expected a refusal");
  return r.error;
}

export async function optionsOf(m: ClipMock, photoId = PLAIN): Promise<Extract<ClipOptions, { suitable: true }>> {
  const answer = await unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId }));
  if (!answer.suitable) throw new Error(`expected a suitable photo, got ${answer.reason}`);
  return answer;
}
