import { asksForRevealing, REVEALING_NOTE, REVEALING_NOTE_DONE } from "./revealingNote";

/**
 * S5.5: the neutral note under a description that asks for lingerie, swimwear or nudity (not drawn yet), or nothing for any other text.
 * `created` is the card of a category that already exists: the sentence is in the past tense there.
 */
export function RevealingLine({ description, created = false }: { description: string; created?: boolean }) {
  if (!asksForRevealing(description)) return null;
  return (
    <p className="field-hint cat-revealing-note" role="note">
      {created ? REVEALING_NOTE_DONE : REVEALING_NOTE}
    </p>
  );
}
