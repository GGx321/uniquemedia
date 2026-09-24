import { AvatarDescriptor } from "../../shared/engine";

// Image prompts. The avatar enters a prompt only as her descriptor, never as
// her traits: the vibe is stored with the avatar but only feeds the
// descriptor LLM, whose answer is gated strictly (invariant 8). Every image
// or scene prompt builder (2b's assembler included) takes the avatar through
// `promptSubject`; prompts.test.ts checks that no other engine module reads
// the vibe.

/**
 * The avatar as a prompt names her: her descriptor, checked again against
 * today's contract (one stored before a stricter rule is refused here, before
 * any image is paid for), without its closing period.
 */
export function promptSubject(descriptor: AvatarDescriptor): string {
  const checked = AvatarDescriptor.safeParse(descriptor);
  if (!checked.success) throw new TypeError(`the avatar's descriptor no longer passes the contract: ${checked.error.issues.map((i) => i.message).join("; ")}`);
  return checked.data.text.replace(/[.\s]+$/, "");
}

/** A candidate portrait: head and shoulders on a plain background, before there is a face to refer to (the spike's CANDIDATE_PROMPT). */
export function candidatePrompt(descriptor: AvatarDescriptor): string {
  return (
    `Head-and-shoulders portrait photo of a ${promptSubject(descriptor)}, looking straight at the camera with a relaxed, slight smile. ` +
    "Soft natural daylight, plain light grey background. Natural skin texture, minimal makeup, smartphone photo, no retouching, no beauty filter."
  );
}
