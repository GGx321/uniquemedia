import type { MontageDraft, MontageIssue } from "../engine/montage";

/**
 * N9: the parts of a montage whose slice has not landed. A spec that uses one is REFUSED with `not-yet-supported` at
 * that spot, never rendered without it. Each slice lifts its own line here: text layers and built-in stickers were lifted by 3b.6,
 * a trending track by 3c.5, an own photo in a photo or collage cell by 3f.2, an own track by 3f.4, an own sticker by 3f.5 and an own video clip by 3f.3b
 * (the engine then judges each with `media-unavailable`, and a render holds it until it ends). Nothing is refused any more; the function stays so that
 * a part added later has the one place to be refused, and so the order of the engine's and the mock's verdicts does not change.
 */
export function notYetSupportedIssues(_spec: Pick<MontageDraft, "clips" | "layers" | "music">): MontageIssue[] {
  return [];
}
