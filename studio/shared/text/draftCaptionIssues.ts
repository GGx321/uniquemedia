import type { MontageDraft, MontageIssue } from "../engine/montage";
import { captionIssue } from "./captionRules";

/**
 * The caption half of a draft's referential issues: a text layer whose caption breaks the shared caption rules (`captionRules`) is
 * `caption-invalid` at the layer's `value`, one issue per layer however many rules it breaks. One function for the engine
 * (`videos.render`'s synchronous refusal, `montages.get` and `list`) and for the renderer's mock, so a render is refused at once,
 * with the issue the editor already shows, instead of failing later in the rasteriser with TEXT_INVALID.
 *
 * Nothing here knows the emoji font, so every well-formed emoji is taken as drawable (as the editor's own check does): a cluster the
 * font lacks stays the rasteriser's `emoji-missing`. An empty caption breaks no rule (the contract's `Caption` keeps it out of a spec).
 */
export function draftCaptionIssues(spec: Pick<MontageDraft, "layers">): MontageIssue[] {
  const issues: MontageIssue[] = [];
  spec.layers.forEach((layer, i) => {
    if (layer.kind === "text" && captionIssue(layer.value, { hasEmoji: () => true }) !== null) issues.push({ code: "caption-invalid", path: ["layers", i, "value"] });
  });
  return issues;
}
