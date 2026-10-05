import { describe, expect, test } from "bun:test";
import { CAPTION_ISSUES, CAPTION_ISSUES_RU, type EngineError } from "../../../shared/engine";
import type { TextPreviewOutcome } from "../../engine/textPreview";
import { type LayerPreview, NO_PREVIEW, previewLook } from "../../engine/textPreviewQueue";
import { errorText } from "../../lib/errors";
import { type CaptionCheck, captionCheckOf, captionNotice, NO_CHECK, refusedCaptionLayers } from "./captionCheck";
import { stickerLayer, textLayer } from "./testkit";

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

describe("the layers whose caption the engine's preview refused, as it stands now", () => {
  const layer = (index: number, value: string) => ({ ...textLayer(index, 0, 1_000), value });
  const stickerOnly = stickerLayer(5, 0, 1_000);
  /** A queue state in which the layer's newest ask, for `look`, was answered `answer`. */
  const answeredFor = (look: string, answer: TextPreviewOutcome): LayerPreview => {
    if (answer.kind === "superseded") return NO_PREVIEW;
    return { asked: 1, look, shown: { ask: 1, look, answer }, picture: null };
  };

  test("a refusal of the layer's current look is listed", () => {
    const bad = layer(0, "tofu");
    const states = new Map([[bad.layerId, answeredFor(previewLook(bad), invalid("emoji-missing"))]]);
    expect([...refusedCaptionLayers([bad], (id) => states.get(id) ?? NO_PREVIEW)]).toEqual([bad.layerId]);
  });

  test("a refusal of an older value is stale and blocks nothing", () => {
    const older = layer(0, "old");
    const edited = { ...older, value: "new" };
    const states = new Map([[older.layerId, answeredFor(previewLook(older), invalid("emoji-missing"))]]);
    expect(refusedCaptionLayers([edited], (id) => states.get(id) ?? NO_PREVIEW).size).toBe(0);
  });

  test.each([
    ["colour", { color: "#000000" }],
    ["size", { scale: 2 }],
    ["style", { style: "outline" as const }],
    ["font", { font: "oswald" as const }],
  ])("a refusal stays when only the %s changes: the rule judges the value alone", (_what, patch) => {
    const refused = layer(0, "tofu");
    const states = new Map([[refused.layerId, answeredFor(previewLook(refused), invalid("emoji-missing"))]]);
    expect([...refusedCaptionLayers([{ ...refused, ...patch }], (id) => states.get(id) ?? NO_PREVIEW)]).toEqual([refused.layerId]);
  });

  test("a picture, a failed drawing, a layer never asked and a sticker are not listed", () => {
    const drawn = layer(0, "a");
    const broken = layer(1, "b");
    const unasked = layer(2, "c");
    const states = new Map([
      [drawn.layerId, answeredFor(previewLook(drawn), PICTURE)],
      [broken.layerId, answeredFor(previewLook(broken), failed({ code: "RENDER_FAILED", detail: "timeout" }))],
    ]);
    expect(refusedCaptionLayers([drawn, broken, unasked, stickerOnly], (id) => states.get(id) ?? NO_PREVIEW).size).toBe(0);
  });

  test("only the refused one of several is listed", () => {
    const good = layer(0, "good");
    const bad = layer(1, "bad");
    const states = new Map([
      [good.layerId, answeredFor(previewLook(good), PICTURE)],
      [bad.layerId, answeredFor(previewLook(bad), invalid("emoji-missing"))],
    ]);
    expect([...refusedCaptionLayers([good, bad], (id) => states.get(id) ?? NO_PREVIEW)]).toEqual([bad.layerId]);
  });
});
