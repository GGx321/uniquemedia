import type { MontageDraft, MontageIssue } from "../../shared/engine/montage";

/**
 * N9: the parts of a montage whose slice has not landed. A spec that uses one is REFUSED with `not-yet-supported` at
 * that spot, never rendered without it: own media (video clips, own photos, own stickers, own tracks) until 3f, layers
 * until 3b, music until 3c. Each slice lifts its own line here.
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
  if (spec.music !== null) add("music");
  return issues;
}
