import { asksForRevealing, REVEALING_NOTE } from "./revealingNote";

/** S5.5: the neutral note under a description that asks for lingerie, swimwear or nudity (not drawn yet), or nothing for any other text. */
export function RevealingLine({ description }: { description: string }) {
  if (!asksForRevealing(description)) return null;
  return (
    <p className="field-hint cat-revealing-note" role="note">
      {REVEALING_NOTE}
    </p>
  );
}
