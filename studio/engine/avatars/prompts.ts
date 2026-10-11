import { AvatarDescriptor } from "../../shared/engine";

// Image prompts. The avatar enters a prompt only as her descriptor, never as
// her traits: the vibe is stored with the avatar but only feeds the
// descriptor LLM, whose answer is gated strictly (invariant 8). Every image
// or scene prompt builder (2b's assembler included) takes the avatar through
// `promptSubject`; prompts.test.ts checks that no other engine module reads
// the vibe.

/** A stored descriptor that today's contract refuses: no prompt may be built from it. */
export class PromptSubjectError extends TypeError {}

/**
 * The avatar as a prompt names her: her descriptor, checked again against
 * today's contract (one stored before a stricter rule is refused here, before
 * any image is paid for), without its closing period.
 */
export function promptSubject(descriptor: AvatarDescriptor): string {
  const checked = AvatarDescriptor.safeParse(descriptor);
  if (!checked.success) throw new PromptSubjectError(`the avatar's descriptor no longer passes the contract: ${checked.error.issues.map((i) => i.message).join("; ")}`);
  const text = checked.data.text.replace(/[.\s]+$/, "");
  // Stage 5, S5.2a: her body phrase closes the descriptor, once, after «; ». The text never holds it.
  return checked.data.body === undefined ? text : `${text}; ${checked.data.body}`;
}

/** A candidate portrait: head and shoulders on a plain background, before there is a face to refer to (the spike's CANDIDATE_PROMPT). */
export function candidatePrompt(descriptor: AvatarDescriptor): string {
  return (
    // The text alone: a head-and-shoulders portrait shows no body, and the master is made before any body is judged.
    `Head-and-shoulders portrait photo of a ${promptSubject({ age: descriptor.age, text: descriptor.text })}, looking straight at the camera with a relaxed, slight smile. ` +
    "Soft natural daylight, plain light grey background. Natural skin texture, minimal makeup, smartphone photo, no retouching, no beauty filter."
  );
}

/**
 * Stage 5, S5.3b: the reference portrait, drawn FROM the imported photo (sent as the one reference): the spike's wording (canary C1's follow-up), plus «She is an
 * adult woman.» (I5.13). One line, single spaces. It names no look term in the negative (I5.10) and, like `candidatePrompt`, takes the descriptor's text alone: a
 * head-and-shoulders portrait shows no body.
 */
export function referencePortraitPrompt(descriptor: AvatarDescriptor): string {
  return (
    "The same woman as in the reference photo, with her exact face, facial proportions, exact hair colour and exact haircut. " +
    `Head-and-shoulders portrait photo of a ${promptSubject({ age: descriptor.age, text: descriptor.text })}, looking straight at the camera with a relaxed, slight smile. ` +
    "Soft natural daylight, plain light grey background, nothing else in the picture, her hands out of the frame. " +
    "Natural skin texture, minimal makeup, ordinary phone photo. She is an adult woman."
  );
}
