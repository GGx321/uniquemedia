import type { MontageDraft, MontageIssue } from "../engine/montage";

/**
 * N9: the parts of a montage whose slice has not landed. A spec that uses one is REFUSED with `not-yet-supported` at
 * that spot, never rendered without it: own video clips until 3f.3b, an own track until 3f.4. Each slice lifts
 * its own line here: text layers and built-in stickers were lifted by 3b.6, a trending track by 3c.5, an own photo in a photo or
 * collage cell by 3f.2 and an own sticker by 3f.5 (the engine then judges each with `media-unavailable`, and a render holds it until it ends).
 */
export function notYetSupportedIssues(spec: Pick<MontageDraft, "clips" | "layers" | "music">): MontageIssue[] {
  const issues: MontageIssue[] = [];
  const add = (...path: (string | number)[]): void => void issues.push({ code: "not-yet-supported", path });
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "video") add("clips", i);
  });
  // 3b.6 lifted text layers and built-in stickers, 3f.5 an own sticker: no layer is refused any more.
  // 3c.5 lifted it for a trending track (its own issues are `trackIssues`); an own track waits for 3f.4.
  if (spec.music?.source === "own") add("music");
  return issues;
}
