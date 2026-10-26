import type { ClipAttemptModel, ClipMotionSource, ClipQuality, ClipSeconds, MotionProblem } from "../../shared/engine";
import { motionTextFindings, motionTextProblems, undressesBy } from "../../shared/scenes/motionText";
import { VIDEO_TIERS } from "../money/prices";
import type { VideoFrameImage, VideoRequest } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import {
  ADULT_LINE,
  LOOK_LINE,
  PROMPT_WORDS_MAX,
  SLOW_LINE,
  cameraLineOf,
  continuityLineOf,
  legsLineOf,
  legwearLineOf,
  motionSentenceOf,
  poseAnchorOf,
  proneAnchorOf,
  shortCameraLineOf,
  wordCount,
  type ClipDialect,
} from "./videoLook";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51, I5.57): the clip prompt and the request body. No LLM: the prompt is code that places videoLook's lines around one text that
// is data, the motion (the bank's, verbatim, a code motion, and since 5b.2 a vision suggestion or the owner's own idea). In order: the camera line, the pose anchor, the
// motion sentence, the prone anchor, the legs line, the continuity line, the legwear line, the pacing, the look, and «She is an adult woman.». No outfit text and no
// coverage sentence, ever: the continuity line keeps what she wears, and the slot's legwear is named only by the legwear line.
//
// FU-CLIP (canary C5c, 2026-10-26): the prompt makes no claim about her pose that only the plan makes, since the image model does not always draw the plan (C5c clip 2:
// «lies curled under the blanket» on a photo where she sits on it, and Kling drew the blanket in). The slot's activity is never sent; the pose anchor holds her to the
// photo. The prone anchor and the legs line read the capture, which proves them by construction (videoLook's `proneAnchorOf`, `legsLineOf`). Two lines still
// read a plan fact, on purpose: the prone anchor on a hips motion over an activity that lies on her stomach (hips-2), and the continuity line (see below).
//
// The checks run before any money (I5.51). S5.WC2 (plan s5b2 I5.66): the motion takes the ONE motion check (shared/scenes/motionText.ts) as what it is: a scene motion the
// frame's rules (its grammar ran when its bank loaded), a code, vision or own motion the bank's grammar as well. The frame's rules: the content line at the slot's own level (a
// frame of «Смелая» at bold, everything else at ordinary), no staging of the camera or the edit, no phone where hers is in her hand or propped (on the capture the photo proves
// or the one its plan names), no movement of a face the photo does not show. The prompt is at most 130 words; a prompt over the cap takes the capture's short camera line
// (pov-legs), never losing an anchor.

export type ClipPromptResult = { readonly ok: true; readonly prompt: string; readonly words: number } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The clip prompt for this frame and motion in this dialect, or the problems that keep it from being sent. `source` is where the motion comes from, always named (S5.WC2
 * round 2): a vision or own text takes the grammar a scene text took at its bank's load. A motion that takes clothing off or bares her (`undressesBy`, read by its source:
 * S5.WC2c lets one on every frame) says «Nothing new appears.» alone, with no clothing or legwear line, in both dialects: the frame decides which model runs, never the motion.
 */
export function clipPromptOf(facts: FrameFacts, motion: string, dialect: ClipDialect, source: ClipMotionSource): ClipPromptResult {
  const findings = motionTextFindings(motion, facts, source);
  if (findings.length > 0) return { ok: false, problems: findings.map((finding) => `${finding.problem} (${finding.rule}): ${finding.what}`) };
  const off = undressesBy(motion, source, facts.bold);
  const rest = [
    poseAnchorOf(motion),
    motionSentenceOf(motion),
    proneAnchorOf(facts.capture, facts.activity, motion),
    legsLineOf(facts.capture),
    // Plan-based on purpose (FU-CLIP): the activity only chooses between two lines, neither of which names it or anything in it. «adjusts the strap of her bag» makes
    // «she tugs the strap a little» a held bag's strap (the base line, which keeps what she holds: K09 lost its bag) rather than a garment's («comes off»).
    continuityLineOf(motion, facts.activity, off),
    // A motion that takes clothing off or bares her carries no clothing clause, the legwear's included: the video model decides.
    facts.legwear === null || off ? null : legwearLineOf(facts.legwear),
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

const DIALECTS: readonly ClipDialect[] = ["kling", "grok"];

/**
 * What a motion must pass before it is offered (I5.66: «every LLM motion passes that check and `clipPromptOf` in both dialects»): the one check's closed problems, else
 * `too-long` when its prompt crosses 130 words in either dialect. Empty: the motion can be offered on this frame.
 */
export function clipMotionProblems(facts: FrameFacts, text: string, source: ClipMotionSource): MotionProblem[] {
  const problems = motionTextProblems(text, facts, source);
  if (problems.length > 0) return problems;
  return DIALECTS.every((dialect) => clipPromptOf(facts, text, dialect, source).ok) ? [] : ["too-long"];
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
