import type { MontageDraft, MontageIssue } from "../engine/montage";

/**
 * N9: the parts of a montage whose slice has not landed. A spec that uses one is REFUSED with `not-yet-supported` at
 * that spot, never rendered without it: own media (video clips, own photos, own stickers) until 3f, layers until 3b, an own
 * track until 3f.4 (a trending track is supported since 3c.5). Each slice lifts its own line here.
 */
export function notYetSupportedIssues(spec: Pick<MontageDraft, "clips" | "layers" | "music">): MontageIssue[] {
  const issues: MontageIssue[] = [];
  const add = (...path: (string | number)[]): void => void issues.push({ code: "not-yet-supported", path });
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "video") add("clips", i);
    else if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "own") add("clips", i, "cell");
    } else {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "own") add("clips", i, "cells", j);
      });
    }
  });
  spec.layers.forEach((_layer, i) => add("layers", i));
  // 3c.5 lifted it for a trending track (its own issues are `trackIssues`); an own track waits for 3f.4.
  if (spec.music?.source === "own") add("music");
  return issues;
}
