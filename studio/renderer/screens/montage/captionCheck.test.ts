import { describe, expect, test } from "bun:test";
import { CAPTION_ISSUES, CAPTION_ISSUES_RU, type EngineError } from "../../../shared/engine";
import type { TextPreviewOutcome } from "../../engine/textPreview";
import { type LayerPreview, NO_PREVIEW } from "../../engine/textPreviewQueue";
import { errorText } from "../../lib/errors";
import { type CaptionCheck, captionCheckOf, captionNotice, NO_CHECK } from "./captionCheck";

// 3d.5: the text panel shows the ENGINE's verdict on the caption inline (the pending note: a draft caption that breaks the rules
// was refused only at render time). Every committed caption is asked of `montages.textPreview`; the answer to the latest ask is the
// verdict. 3d.4: the asks are the window's ONE per-layer queue (engine/textPreviewQueue.ts), shared with the preview; which answer
// counts (superseded, older, asked again) is the queue's rule and its tests'. The panel reads the layer's state from it. The words
// are the shared Russian texts (`CAPTION_ISSUES_RU`), never the window's own rules.

const PICTURE: TextPreviewOutcome = { kind: "picture", previewId: "preview-0001", width: 400, height: 90, url: null };
const invalid = (issue: (typeof CAPTION_ISSUES)[number]): TextPreviewOutcome => ({ kind: "invalid", captionIssue: issue, error: { code: "TEXT_INVALID", captionIssue: issue } });
const failed = (error: EngineError): TextPreviewOutcome => ({ kind: "failed", error });

/** A layer's state in the queue: `asked` asks sent, and the answer to ask `ask` shown (none for null). */
function preview(asked: number, ask: number, answer: TextPreviewOutcome | null): LayerPreview {
  if (answer === null || answer.kind === "superseded") return { ...NO_PREVIEW, asked, look: "look" };
  return { asked, look: "look", shown: { ask, look: "look", answer }, picture: null };
}

/** The panel's check of a layer whose one ask was answered `answer`. */
const answered = (answer: TextPreviewOutcome): CaptionCheck => captionCheckOf(preview(1, 1, answer));

describe("the verdict, read from the layer's state in the shared queue", () => {
  test("never asked: no verdict, nothing pending", () => {
    expect(captionCheckOf(NO_PREVIEW)).toEqual(NO_CHECK);
    expect(captionNotice(null, NO_CHECK)).toEqual({ tone: null, text: null, pending: false });
  });

  test("an ask out with no answer yet is pending", () => {
    expect(captionNotice(null, captionCheckOf(preview(1, 0, null))).pending).toBe(true);
  });

  test("the answer to the newest ask is shown and ends the wait", () => {
    expect(captionNotice(null, answered(invalid("charset")))).toEqual({ tone: "error", text: CAPTION_ISSUES_RU.charset, pending: false });
  });

  test("an older ask's answer is shown while the newest is still out, marked pending", () => {
    expect(captionNotice(null, captionCheckOf(preview(2, 1, invalid("emoji-missing"))))).toEqual({ tone: "error", text: CAPTION_ISSUES_RU["emoji-missing"], pending: true });
  });
});

describe("what the panel says", () => {
  test("every caption rule in the shared Russian text; a picture says nothing", () => {
    for (const issue of CAPTION_ISSUES) expect(captionNotice(null, answered(invalid(issue))).text).toBe(CAPTION_ISSUES_RU[issue]);
    expect(captionNotice(null, answered(PICTURE))).toEqual({ tone: null, text: null, pending: false });
  });

  test("a drawing that failed (a rasteriser timeout) gives the 3b.4b hint itself: RENDER_FAILED's own text speaks of a video", () => {
    const notice = captionNotice(null, answered(failed({ code: "RENDER_FAILED", detail: "text rasteriser: timeout" })));
    expect(notice.tone).toBe("warn");
    expect(notice.text).toBe("Надпись не удалось нарисовать — уменьшите размер или смените стиль.");
  });

  test("any other failure says the caption is not checked yet, and why", () => {
    const error: EngineError = { code: "INTERNAL", detail: "the text worker is down" };
    expect(captionNotice(null, answered(failed(error)))).toEqual({ tone: "warn", text: `Надпись пока не проверена. ${errorText(error)}`, pending: false });
  });

  test("text that never reached the engine speaks for the field as it is now, over any older verdict", () => {
    const shown = answered(PICTURE);
    const keep = " Пока так, в черновике остаётся прежняя надпись.";
    expect(captionNotice("empty", shown)).toEqual({ tone: "error", text: `Надпись не может быть пустой — напишите текст или удалите слой.${keep}`, pending: false });
    expect(captionNotice("blank", shown).text).toBe(`В надписи одни пробелы — рисовать нечего. Напишите текст или удалите слой.${keep}`);
    expect(captionNotice("too-long", shown).text).toBe(`${CAPTION_ISSUES_RU["too-long"]}${keep}`);
  });
});
