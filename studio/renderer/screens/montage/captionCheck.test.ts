import { describe, expect, test } from "bun:test";
import { CAPTION_ISSUES, CAPTION_ISSUES_RU, type EngineError } from "../../../shared/engine";
import type { TextPreviewOutcome } from "../../engine/textPreview";
import { errorText } from "../../lib/errors";
import { answerCaption, askCaption, type CaptionCheck, captionNotice, NO_CHECK } from "./captionCheck";

// 3d.5: the text panel shows the ENGINE's verdict on the caption inline (the pending note: a draft caption that breaks the rules
// was refused only at render time). Every committed caption is asked of `montages.textPreview`; the answer to the latest ask is the
// verdict. `superseded` is no answer at all: a newer ask replaced it in the queue, and it is ignored silently. The words are the
// shared Russian texts (`CAPTION_ISSUES_RU`), never the window's own rules.

const PICTURE: TextPreviewOutcome = { kind: "picture", previewId: "preview-0001", width: 400, height: 90, url: null };
const SUPERSEDED: TextPreviewOutcome = { kind: "superseded" };
const invalid = (issue: (typeof CAPTION_ISSUES)[number]): TextPreviewOutcome => ({ kind: "invalid", captionIssue: issue, error: { code: "TEXT_INVALID", captionIssue: issue } });
const failed = (error: EngineError): TextPreviewOutcome => ({ kind: "failed", error });

/** `n` asks in a row from `check`, and the ask numbers. */
function asks(check: CaptionCheck, n: number): { check: CaptionCheck; ids: number[] } {
  const ids: number[] = [];
  let at = check;
  for (let i = 0; i < n; i++) {
    const next = askCaption(at);
    at = next.check;
    ids.push(next.ask);
  }
  return { check: at, ids };
}

describe("which answer is the verdict", () => {
  test("each ask gets a new, larger number; while it is out the check is pending", () => {
    const { check, ids } = asks(NO_CHECK, 2);
    expect(ids[1]).toBeGreaterThan(ids[0] ?? Number.POSITIVE_INFINITY);
    expect(captionNotice(null, check).pending).toBe(true);
  });

  test("the answer to the latest ask is shown and ends the wait", () => {
    const { check, ids } = asks(NO_CHECK, 1);
    const answered = answerCaption(check, ids[0] ?? 0, invalid("charset"));
    expect(captionNotice(null, answered)).toEqual({ tone: "error", text: CAPTION_ISSUES_RU.charset, pending: false });
  });

  test("superseded is ignored silently: nothing changes, not even the wait", () => {
    const { check, ids } = asks(NO_CHECK, 2);
    const shown = answerCaption(check, ids[0] ?? 0, invalid("charset"));
    expect(answerCaption(shown, ids[1] ?? 0, SUPERSEDED)).toBe(shown);
    expect(answerCaption(NO_CHECK, 1, SUPERSEDED)).toBe(NO_CHECK);
  });

  test("an answer older than the one shown is dropped (the newer text was judged already)", () => {
    const { check, ids } = asks(NO_CHECK, 2);
    const newer = answerCaption(check, ids[1] ?? 0, PICTURE);
    expect(answerCaption(newer, ids[0] ?? 0, invalid("too-long"))).toBe(newer);
    expect(captionNotice(null, newer)).toEqual({ tone: null, text: null, pending: false });
  });

  test("an older ask's answer is shown while the newest is still out, marked pending", () => {
    const { check, ids } = asks(NO_CHECK, 2);
    const older = answerCaption(check, ids[0] ?? 0, invalid("emoji-missing"));
    expect(captionNotice(null, older)).toEqual({ tone: "error", text: CAPTION_ISSUES_RU["emoji-missing"], pending: true });
  });
});

describe("what the panel says", () => {
  test("every caption rule in the shared Russian text; a picture says nothing", () => {
    for (const issue of CAPTION_ISSUES) {
      const { check, ids } = asks(NO_CHECK, 1);
      expect(captionNotice(null, answerCaption(check, ids[0] ?? 0, invalid(issue))).text).toBe(CAPTION_ISSUES_RU[issue]);
    }
    const { check, ids } = asks(NO_CHECK, 1);
    expect(captionNotice(null, answerCaption(check, ids[0] ?? 0, PICTURE)).text).toBe(null);
  });

  test("a drawing that failed (a rasteriser timeout) gives the 3b.4b hint itself: RENDER_FAILED's own text speaks of a video", () => {
    const { check, ids } = asks(NO_CHECK, 1);
    const notice = captionNotice(null, answerCaption(check, ids[0] ?? 0, failed({ code: "RENDER_FAILED", detail: "text rasteriser: timeout" })));
    expect(notice.tone).toBe("warn");
    expect(notice.text).toBe("Надпись не удалось нарисовать — уменьшите размер или смените стиль.");
  });

  test("any other failure says the caption is not checked yet, and why", () => {
    const error: EngineError = { code: "INTERNAL", detail: "the text worker is down" };
    const { check, ids } = asks(NO_CHECK, 1);
    const notice = captionNotice(null, answerCaption(check, ids[0] ?? 0, failed(error)));
    expect(notice).toEqual({ tone: "warn", text: `Надпись пока не проверена. ${errorText(error)}`, pending: false });
  });

  test("text that never reached the engine speaks for the field as it is now, over any older verdict", () => {
    const { check, ids } = asks(NO_CHECK, 1);
    const shown = answerCaption(check, ids[0] ?? 0, PICTURE);
    const keep = " Пока так, в черновике остаётся прежняя надпись.";
    expect(captionNotice("empty", shown)).toEqual({ tone: "error", text: `Надпись не может быть пустой — напишите текст или удалите слой.${keep}`, pending: false });
    expect(captionNotice("blank", shown).text).toBe(`В надписи одни пробелы — рисовать нечего. Напишите текст или удалите слой.${keep}`);
    expect(captionNotice("too-long", shown).text).toBe(`${CAPTION_ISSUES_RU["too-long"]}${keep}`);
  });
});
