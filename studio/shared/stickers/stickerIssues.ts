import type { MontageDraft, MontageIssue } from "../engine/montage";
import { stickerById } from "./manifest";

/**
 * The referential half for a montage's built-in stickers (3b.6): a sticker id the set does not have is `sticker-unavailable` at the
 * layer's `sticker`. The set is in the build, so no library is asked. One function for the engine (`videos.render`, `montages.get`)
 * and for the mock, so the two answer the same way. An own sticker is not judged here: it stays `not-yet-supported` until 3f.5 (N9),
 * and there is no store for it.
 */
export function stickerIssues(spec: Pick<MontageDraft, "layers">): MontageIssue[] {
  const issues: MontageIssue[] = [];
  spec.layers.forEach((layer, i) => {
    if (layer.kind === "sticker" && layer.sticker.source === "builtin" && stickerById(layer.sticker.stickerId) === undefined) {
      issues.push({ code: "sticker-unavailable", path: ["layers", i, "sticker"] });
    }
  });
  return issues;
}
