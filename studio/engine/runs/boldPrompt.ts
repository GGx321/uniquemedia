import { CONSTRAINTS } from "../scenes/phoneLook";

// 5a.3 (S5.9d, Seedream hair probe p5a3b): the «Смелая» route's own step on a finished prompt. Seedream draws painted, over-smooth hair and skin when the artefact line asks for
// «slightly soft focus» or «muted colours», so on that route ONLY those two phrases go and a hair and skin realism cue is appended to the artefact line. The assembler
// and the look tables (phoneLook.ts) are shared with every other route and stay as they are; this runs on a Seedream slot's assembled prompt, in the run job, before the
// prompts are journaled (invariant 6), so a resume sends the very prompt that was written.

/** The probe's wording, kept verbatim. */
export const BOLD_REALISM_CUE = "hair rendered as individual fine strands with natural flyaways and frizz, sharp phone-camera detail, real skin texture with pores; not painted, not illustrated, not airbrushed";

/** The artefact line opens with this in every variant (phoneLook.ts `artefactLine`). */
const ARTEFACT_START = "Ordinary phone photo";
/** Phrases the artefact line says in every variant that has them, always after a comma. */
const SOFT_PHRASES = /,\s*(?:slightly soft focus|muted colours)(?=[,.])/g;

export function boldPrompt(prompt: string): string {
  if (prompt.includes(BOLD_REALISM_CUE)) return prompt;
  const constraintsAt = prompt.lastIndexOf(` ${CONSTRAINTS}`);
  const artefactAt = prompt.indexOf(ARTEFACT_START);
  // The artefact line runs from its opening to the constraints that follow it; with no constraints, to the end of the prompt.
  const artefactEnd = constraintsAt >= 0 ? constraintsAt : prompt.length;
  if (artefactAt < 0 || artefactAt >= artefactEnd) {
    // No artefact line to extend: the cue is its own sentence, before the constraints.
    return constraintsAt >= 0 ? `${prompt.slice(0, constraintsAt)} ${BOLD_REALISM_CUE}.${prompt.slice(constraintsAt)}` : `${prompt} ${BOLD_REALISM_CUE}.`;
  }
  const artefact = prompt.slice(artefactAt, artefactEnd).replace(SOFT_PHRASES, "");
  const open = artefact.replace(/\.\s*$/, "");
  return `${prompt.slice(0, artefactAt)}${open}, ${BOLD_REALISM_CUE}.${prompt.slice(artefactEnd)}`;
}
