import { CAPTION_ISSUES_RU, type CaptionIssue, type EngineError, type MontageDraft } from "../../../shared/engine";
import { type LayerPreview, previewLook } from "../../engine/textPreviewQueue";
import { errorText } from "../../lib/errors";
import type { CaptionRefusal } from "./textOps";

// 3d.5: the text panel's inline verdict on the caption (EditorText.dc.html R26; the components sheet's «ошибка текста»). The
// pending plan note: a caption that broke the rules was refused only at render time, so the panel now asks the ENGINE about every
// caption it commits (`montages.textPreview`, which runs the shared technical caption rules) and shows TEXT_INVALID's
// `captionIssue` as you type. The answer to the newest ask is the verdict; `superseded` (a newer ask of the same layer replaced it
// in the engine's queue) is no answer at all and changes nothing. 3d.4: the asks go through the window's one per-layer queue
// (engine/textPreviewQueue.ts), which the preview shares; the panel reads the layer's state from it. The words are the shared
// `CAPTION_ISSUES_RU`.

export type CaptionVerdict = { readonly kind: "ok" } | { readonly kind: "invalid"; readonly issue: CaptionIssue } | { readonly kind: "failed"; readonly error: EngineError };

/** The asks made so far (a counter) and the verdict shown, with the ask it answered. */
export interface CaptionCheck {
  readonly asked: number;
  readonly shown: { readonly ask: number; readonly verdict: CaptionVerdict } | null;
}

export const NO_CHECK: CaptionCheck = { asked: 0, shown: null };

/** The panel's verdict, from the layer's state in the window's one preview queue (3d.4: which answer counts is the queue's rule). */
export function captionCheckOf(preview: LayerPreview): CaptionCheck {
  const { shown } = preview;
  if (shown === null) return preview.asked === 0 ? NO_CHECK : { asked: preview.asked, shown: null };
  const { answer } = shown;
  const verdict: CaptionVerdict = answer.kind === "picture" ? { kind: "ok" } : answer.kind === "invalid" ? { kind: "invalid", issue: answer.captionIssue } : { kind: "failed", error: answer.error };
  return { asked: preview.asked, shown: { ask: shown.ask, verdict } };
}

export interface CaptionNotice {
  /** `error`: the caption must change; `warn`: it could not be checked or drawn; null: nothing to say. */
  readonly tone: "error" | "warn" | null;
  readonly text: string | null;
  /** A newer ask is still out: what is shown may be about the text before it. */
  readonly pending: boolean;
}

/** Text the field holds but the draft does not (it never reached the engine): the draft keeps its last caption meanwhile. */
const KEPT = " Пока так, в черновике остаётся прежняя надпись.";

const REFUSALS: Record<"empty" | "blank", string> = {
  empty: "Надпись не может быть пустой — напишите текст или удалите слой.",
  blank: "В надписи одни пробелы — рисовать нечего. Напишите текст или удалите слой.",
};

/** The 3b.4b hint for a drawing that failed (a rasteriser timeout): RENDER_FAILED's own text speaks of a video. */
const DRAW_FAILED = "Надпись не удалось нарисовать — уменьшите размер или смените стиль.";

/**
 * What the panel says under the caption. `local` is why the text in the field could not become the caption (it never reached the
 * engine): it speaks for the field as it is now. Otherwise the engine's verdict on the caption committed last.
 */
export function captionNotice(local: CaptionRefusal | null, check: CaptionCheck): CaptionNotice {
  const pending = check.asked > (check.shown?.ask ?? 0);
  if (local !== null) return { tone: "error", text: `${local === "empty" || local === "blank" ? REFUSALS[local] : CAPTION_ISSUES_RU[local]}${KEPT}`, pending: false };
  const verdict = check.shown?.verdict;
  if (verdict === undefined || verdict.kind === "ok") return { tone: null, text: null, pending };
  if (verdict.kind === "invalid") return { tone: "error", text: CAPTION_ISSUES_RU[verdict.issue], pending };
  return { tone: "warn", text: verdict.error.code === "RENDER_FAILED" ? DRAW_FAILED : `Надпись пока не проверена. ${errorText(verdict.error)}`, pending };
}

/**
 * The text layers whose caption the engine's preview refused as a caption rule (TEXT_INVALID), judged for the layer's look NOW: an answer
 * for an older value is stale and counts for nothing, and a drawing that failed or a transport failure is not the caption's fault. This is
 * what the committed check cannot know (`emoji-missing` needs the real font): the render is refused for it later, in the job, so «Рендер»
 * waits for the same verdict the panel already shows.
 */
export function refusedCaptionLayers(layers: readonly MontageDraft["layers"][number][], previewOf: (layerId: string) => LayerPreview): ReadonlySet<string> {
  const refused = new Set<string>();
  for (const layer of layers) {
    if (layer.kind !== "text") continue;
    const { shown } = previewOf(layer.layerId);
    if (shown !== null && shown.look === previewLook(layer) && shown.answer.kind === "invalid") refused.add(layer.layerId);
  }
  return refused;
}
