import type { ClipAttemptModel, ClipQuality, ClipSeconds } from "../../shared/engine";
import { MOMENT_VERBS } from "../../shared/scenes/banks/schema";
import { isHandCapture } from "../../shared/scenes/captures";
import { contentProblems } from "../../shared/scenes/contentLine";
import { rendersActivity } from "../../shared/scenes/custom";
import { PHONE_WORDS, SELFIE_WORDS } from "../../shared/scenes/words";
import { VIDEO_TIERS } from "../money/prices";
import type { VideoFrameImage, VideoRequest } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import {
  ADULT_LINE,
  LOOK_LINE,
  PRONE_ANCHOR,
  PROMPT_WORDS_MAX,
  SLOW_LINE,
  cameraLineOf,
  continuityLineOf,
  hasVideoStagingWord,
  legsLineOf,
  legwearLineOf,
  motionSentenceOf,
  poseSentenceOf,
  shortCameraLineOf,
  wordCount,
  type ClipCapture,
  type ClipDialect,
} from "./videoLook";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51, I5.57): the clip prompt and the request body. No LLM: the prompt is code that places videoLook's lines around two texts that
// are data, the slot's activity and the motion (the bank's, verbatim, or a code motion). In order: the camera line, the pose sentence, the motion sentence, the prone anchor,
// the legs line, the continuity line, the legwear line, the pacing, the look, and «She is an adult woman.». No outfit text and no coverage sentence, ever: the continuity line
// keeps what she wears, and the slot's legwear is named only by the legwear line.
//
// The checks run before any money (I5.51): the motion opens with «she» or «her»; the motion and the activity pass the content line at the slot's own level (a frame of «Смелая»
// at bold, everything else at ordinary); neither stages the camera or the edit; on a capture where her phone is in her hand or propped, neither names a phone; on a frame
// whose face does not show, the motion moves no part of her face (no prompt contradicts its photo); and the prompt is at most 130 words. A prompt over the cap takes the
// capture's short camera line (pov-legs), never losing an anchor.

export type ClipPromptResult = { readonly ok: true; readonly prompt: string; readonly words: number } | { readonly ok: false; readonly problems: readonly string[] };

const MOTION_START = /^(?:she|her)\s/;
const ON_HER_STOMACH = /\bon her stomach\b/i;

/** Her phone is in her hand (a selfie or a mirror) or propped (a timer): a text that names a phone there draws a second one. */
function phoneRuleHolds(capture: ClipCapture): boolean {
  return capture !== "unknown" && (isHandCapture(capture) || capture === "timer");
}

const namesPhone = (text: string): boolean => PHONE_WORDS.test(text) || SELFIE_WORDS.test(text);

/** What a text breaks of the checks every motion and activity takes (I5.51), at the frame's level and on its capture. */
function textProblems(facts: FrameFacts, text: string): string[] {
  const problems = contentProblems(text, facts.level).map((p) => `${p.reason}: ${p.words.join(", ")}`);
  if (hasVideoStagingWord(text)) problems.push("stages the camera or the edit");
  if (phoneRuleHolds(facts.capture) && namesPhone(text)) problems.push(`names a phone on a ${facts.capture} capture`);
  return problems;
}

/**
 * A motion of her mouth, her eyes or her expression. On a frame whose face does not show (the phone over it from her eyebrows to her chin, her legs filling the frame) it
 * would contradict the photo: the clip would have to uncover her face to play it.
 */
const FACE_ACTION = /\b(?:smil\w*|blink\w*|laugh\w*|grin\w*|wink\w*|pout\w*|kiss\w*|lips?|eyes?|sips?|sipping)\b/i;

/** What a motion breaks: it opens with «she» or «her», takes every check of a text, and moves no face the photo does not show. */
export function motionProblems(facts: FrameFacts, motion: string): string[] {
  const problems = textProblems(facts, motion);
  if (!MOTION_START.test(motion)) problems.unshift("opens with neither «she» nor «her»");
  if (facts.face !== "yes" && FACE_ACTION.test(motion)) problems.push("moves her face, which the photo does not show");
  return problems;
}

/** A finite verb phrase opens with a bank verb («lies», «sits»); an «-ing» phrase or a position reads after «is» (custom.ts's rule); anything else has no pose sentence. */
function activityForm(activity: string): "finite" | "ing" | null {
  const first = /^[a-z]+/i.exec(activity)?.[0]?.toLowerCase() ?? "";
  if (MOMENT_VERBS.includes(first)) return "finite";
  return rendersActivity(activity) ? "ing" : null;
}

/**
 * The pose sentence (§5.5 item 2) from the slot's activity, or null when it is left out: no activity the photo still carries (an own scene, no plan, an edited scene), an
 * activity that is neither a verb phrase nor an «-ing» phrase, or one that fails the checks (the content line at the slot's level, a video word, a phone on a hand-held or
 * propped capture). The camera line and the motion still carry the clip.
 */
export function poseSentenceFor(facts: FrameFacts): string | null {
  const activity = facts.activity;
  if (activity === null) return null;
  const form = activityForm(activity);
  if (form === null || textProblems(facts, activity).length > 0) return null;
  return poseSentenceOf(activity, form);
}

/** The prone anchor's rule: a prone or over-the-shoulder capture, or an activity that lies on her stomach (on a mirror, say). */
function lyingOnHerStomach(facts: FrameFacts): boolean {
  return facts.capture === "prone" || facts.capture === "over-shoulder" || ON_HER_STOMACH.test(facts.activity ?? "");
}

/** The clip prompt for this frame and motion in this dialect, or the problems that keep it from being sent. */
export function clipPromptOf(facts: FrameFacts, motion: string, dialect: ClipDialect): ClipPromptResult {
  const problems = motionProblems(facts, motion);
  if (problems.length > 0) return { ok: false, problems };
  const rest = [
    poseSentenceFor(facts),
    motionSentenceOf(motion),
    lyingOnHerStomach(facts) ? PRONE_ANCHOR : null,
    facts.legs ? legsLineOf(facts.capture) : null,
    continuityLineOf(motion, facts.activity),
    facts.legwear === null ? null : legwearLineOf(facts.legwear),
    SLOW_LINE,
    LOOK_LINE,
    ADULT_LINE,
  ].filter((line): line is string => line !== null);
  let prompt = [cameraLineOf(facts.capture, dialect), ...rest].join(" ");
  const short = shortCameraLineOf(facts.capture, dialect);
  if (wordCount(prompt) > PROMPT_WORDS_MAX && short !== null) prompt = [short, ...rest].join(" ");
  const words = wordCount(prompt);
  if (words > PROMPT_WORDS_MAX) return { ok: false, problems: [`${words} words, over the cap of ${PROMPT_WORDS_MAX}`] };
  return { ok: true, prompt, words };
}

/** Grok's listing has no audio flag (`generate_audio: null`), so its body carries none (plan §5.5); Kling's says `false`. */
export type GrokVideoRequest = Omit<VideoRequest, "generate_audio">;
export type ClipRequestBody = VideoRequest | GrokVideoRequest;

export interface ClipRequestInput {
  readonly prompt: string;
  readonly model: ClipAttemptModel;
  readonly quality: ClipQuality;
  readonly seconds: ClipSeconds;
  /** The first frame: the photo scaled to the clip's size, as a JPEG data URL (V4b's `firstFrame` through `jpegDataUrl`). */
  readonly firstFrame: string;
}

const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;

/** The body of one `POST /videos` (the probes' shape): 9:16, the first frame only, Kling with no audio. A first frame that is not a JPEG data URL is refused. */
export function clipRequestBody(input: ClipRequestInput): ClipRequestBody {
  if (!JPEG_DATA_URL.test(input.firstFrame)) throw new RangeError("a clip's first frame must be a JPEG data URL");
  const frame_images: readonly VideoFrameImage[] = [{ type: "image_url", image_url: { url: input.firstFrame }, frame_type: "first_frame" }];
  // The sent model is the priced one: V2's tier table names the model and the resolution each clip price was read for.
  // The keys go in the probes' order (generate_audio before the frames), pinned byte for byte by a test.
  if (input.model === "grok") {
    const grok = VIDEO_TIERS.grok;
    return { model: grok.model, prompt: input.prompt, duration: input.seconds, resolution: grok.resolution, aspect_ratio: "9:16", frame_images };
  }
  const kling = VIDEO_TIERS[input.quality];
  return { model: kling.model, prompt: input.prompt, duration: input.seconds, resolution: kling.resolution, aspect_ratio: "9:16", generate_audio: false, frame_images };
}
