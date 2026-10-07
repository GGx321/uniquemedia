import { ScenePose, type CategoryPoses } from "../../../shared/engine";

// CS.8b: a custom category's angles (CS.8a's `CategoryPool.poses`) as the UI shows and sends them (README «CS.8 — angles from descriptions»): the app's own
// words for the four poses — the card's chip «Со спины», never «сзади» — always sorted front → back (the engine stores a list as given), and what a press of
// the sheet's chips saves.

/** The chips' words, capitalised as the card's own chips are (`GenerateCard`). */
export const POSE_CHIP: Record<ScenePose, string> = { front: "Анфас", "three-quarter": "Три четверти", profile: "Профиль", back: "Со спины" };

/** The same in running text. */
export const POSE_WORD: Record<ScenePose, string> = { front: "анфас", "three-quarter": "три четверти", profile: "профиль", back: "со спины" };

/** What the card always gives a category with no angles of its own: the sheet draws these two dimmed-on, and a first press starts from them. */
export const CARD_POSES: readonly ScenePose[] = ["front", "three-quarter"];

/** The four poses in the UI's order, front → back, each once. */
export function sortPoses(poses: readonly ScenePose[]): ScenePose[] {
  return ScenePose.options.filter((pose) => poses.includes(pose));
}

/** «три четверти, со спины». */
export function posesText(poses: readonly ScenePose[]): string {
  return sortPoses(poses)
    .map((pose) => POSE_WORD[pose])
    .join(", ");
}

/**
 * What a press of `pose`'s chip in the sheet saves (contract note 2, «CS.8d round 1» M1). From «как в карточке» (`stored` absent) it starts at front and
 * three-quarter — what the card always gives — so «Со спины» saves [front, three-quarter, back], never «со спины» alone; with own angles it toggles that one.
 * The last chip off is «как в карточке» again: null, never an empty list. Sorted, as the UI sends it.
 */
export function nextPoses(stored: readonly ScenePose[] | undefined, pose: ScenePose): CategoryPoses | null {
  const current = stored ?? CARD_POSES;
  const next = current.includes(pose) ? current.filter((p) => p !== pose) : [...current, pose];
  return next.length === 0 ? null : sortPoses(next);
}
