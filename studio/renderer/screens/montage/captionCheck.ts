import { CAPTION_ISSUES_RU, type CaptionIssue, type EngineError } from "../../../shared/engine";
import type { TextPreviewOutcome } from "../../engine/textPreview";
import { errorText } from "../../lib/errors";
import type { CaptionRefusal } from "./textOps";

// 3d.5: the text panel's inline verdict on the caption (EditorText.dc.html R26; the components sheet's «ошибка текста»). The
// pending plan note: a caption that broke the rules was refused only at render time, so the panel now asks the ENGINE about every
// caption it commits (`montages.textPreview`, which runs the shared technical caption rules) and shows TEXT_INVALID's
// `captionIssue` as you type. The answer to the newest ask is the verdict; `superseded` (a newer ask of the same layer replaced it
// in the engine's queue) is no answer at all and changes nothing. The words are the shared `CAPTION_ISSUES_RU`.

export type CaptionVerdict = { readonly kind: "ok" } | { readonly kind: "invalid"; readonly issue: CaptionIssue } | { readonly kind: "failed"; readonly error: EngineError };

/** The asks made so far (a counter) and the verdict shown, with the ask it answered. */
export interface CaptionCheck {
  readonly asked: number;
  readonly shown: { readonly ask: number; readonly verdict: CaptionVerdict } | null;
}

export const NO_CHECK: CaptionCheck = { asked: 0, shown: null };

/** A new ask: its number, larger than every earlier one. */
export function askCaption(check: CaptionCheck): { check: CaptionCheck; ask: number } {
  const ask = check.asked + 1;
  return { check: { ...check, asked: ask }, ask };
}

/** The engine's answer to ask `ask`. Superseded changes nothing; an answer older than the one shown is dropped. */
export function answerCaption(check: CaptionCheck, ask: number, outcome: TextPreviewOutcome): CaptionCheck {
  if (outcome.kind === "superseded") return check;
  if (check.shown !== null && ask <= check.shown.ask) return check;
  const verdict: CaptionVerdict = outcome.kind === "picture" ? { kind: "ok" } : outcome.kind === "invalid" ? { kind: "invalid", issue: outcome.captionIssue } : { kind: "failed", error: outcome.error };
  return { ...check, shown: { ask, verdict } };
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
