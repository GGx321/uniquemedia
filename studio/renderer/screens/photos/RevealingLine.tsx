import { asksForRevealing, REVEALING_NOTE, REVEALING_NOTE_DONE } from "./revealingNote";

/**
 * S5.5: the neutral note under a description that asks for lingerie, swimwear or nudity, or nothing for any other text. 5a.4 (§5.9 rows 15, 16): it says what «Смелая» gives
 * a custom category. `created` is the card of a category that already exists: there it first says the category's own outfits are ordinary.
 */
export function RevealingLine({ description, created = false }: { description: string; created?: boolean }) {
  if (!asksForRevealing(description)) return null;
  return (
    <p className="field-hint cat-revealing-note" role="note">
      {created ? REVEALING_NOTE_DONE : REVEALING_NOTE}
    </p>
  );
}
