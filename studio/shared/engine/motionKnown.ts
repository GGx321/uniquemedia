// Stage 5, 5b.2, S5.WC3c: how a suggested motion is compared with the ones already known. The engine (`clips/motionService.ts`) and the mock (`renderer/engine/mockClipMotions.ts`) both
// dedupe through THIS module, so the owner is told the same thing by either. Pure.

import { CLIP_CHOICES_MAX } from "./clips";

/** A text as it is compared with another: case and white space aside. */
export function sameText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The drafts whose text is not in `known` (already passed through `sameText`), in order; a draft that repeats an earlier one of the same list is left out as well. `repeated` says the answer HAD drafts
 * and every one was known: the call is a paid `none` with the reason `repeated`. `known` is not changed.
 */
export function freshDrafts<T extends { readonly text: string }>(drafts: readonly T[], known: ReadonlySet<string> | readonly string[]): { fresh: T[]; repeated: boolean } {
  const seen = new Set<string>(known);
  const fresh: T[] = [];
  for (const draft of drafts) {
    const key = sameText(draft.text);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(draft);
  }
  return { fresh, repeated: drafts.length > 0 && fresh.length === 0 };
}

/**
 * The suggestions ON THE SHEET, as `sameText` keys: the newest `CLIP_CHOICES_MAX.vision` stored suggestions that pass the check made now (the rule of `clips.options`' list, `listedItems`). An older one
 * has left the sheet and the owner cannot pick it; a model that suggests it again must be able to bring it back, so it is not "known". Own ideas are another source and do not count.
 */
export function sheetVisionTexts<T extends { readonly source: string; readonly text: string }>(items: readonly T[], passes: (item: T) => boolean): string[] {
  const kept: string[] = [];
  for (const item of [...items].reverse()) {
    if (item.source !== "vision" || !passes(item)) continue;
    kept.push(sameText(item.text));
    if (kept.length === CLIP_CHOICES_MAX.vision) break;
  }
  return kept.reverse();
}
