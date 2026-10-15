import { describe, expect, test } from "bun:test";
import { MOTION_ENGLISH, MOTION_TEXT_MAX } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { checkModelText, framePayload, normalizeModelText, stepOf } from "./motionCall";
import { GOOD_MOTION, UNDRESS_MOTION, authAnswer, boldMirrorFrame, emptyAnswer, okAnswer, refusedAnswer, timerFrame } from "./testing/motionKit";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3, I5.66): what the writer and the translator share. A model's text is normalised in the CODE path before the one motion check (models write «she’s…» and a
// final period); the check itself is not weakened.

describe("normalizeModelText", () => {
  test("a typographic apostrophe becomes a plain one", () => {
    expect(normalizeModelText("she’s tucking a strand of hair")).toBe("she's tucking a strand of hair");
  });

  test("a trailing period is stripped, and the spaces around the text with it", () => {
    expect(normalizeModelText("  she slowly tucks her hair behind her ear.  ")).toBe("she slowly tucks her hair behind her ear");
  });

  test("a period inside the text stays (the check refuses a second sentence)", () => {
    expect(normalizeModelText("she smiles. she blinks.")).toBe("she smiles. she blinks");
  });

  test("a capital She at the start becomes she (the prompt asks for lowercase; the check stays strict)", () => {
    expect(normalizeModelText("She slowly tucks her hair behind her ear")).toBe("she slowly tucks her hair behind her ear");
    expect(normalizeModelText("Her hair slowly moves")).toBe("her hair slowly moves");
  });

  test("runs of white space become one space", () => {
    expect(normalizeModelText("she  slowly\ttucks her hair")).toBe("she slowly tucks her hair");
  });
});

describe("checkModelText", () => {
  test("a good text passes on an ordinary frame, as vision and as own", () => {
    expect(checkModelText(timerFrame(), `${GOOD_MOTION}.`, "vision")).toEqual({ text: GOOD_MOTION, problems: [] });
    expect(checkModelText(timerFrame(), GOOD_MOTION, "own").problems).toEqual([]);
  });

  test("a text that takes clothing off is takes-off for a vision text on any frame", () => {
    expect(checkModelText(timerFrame(), UNDRESS_MOTION, "vision").problems).toContain("takes-off");
    expect(checkModelText(boldMirrorFrame(), UNDRESS_MOTION, "vision").problems).toContain("takes-off");
  });

  test("an own idea that takes clothing off is takes-off on an ordinary frame and accepted on a frame of «Смелая» (Q-H = 2)", () => {
    expect(checkModelText(timerFrame(), UNDRESS_MOTION, "own").problems).toContain("takes-off");
    expect(checkModelText(boldMirrorFrame(), UNDRESS_MOTION, "own").problems).toEqual([]);
  });

  test("a text over 60 characters is refused, whatever else it is", () => {
    const long = "she slowly turns her head a little toward the window and back";
    expect(long.length).toBeGreaterThan(MOTION_TEXT_MAX);
    expect(checkModelText(timerFrame(), long, "vision").problems.length).toBeGreaterThan(0);
  });

  test("a text the check accepts always fits the contract's English (so a stored item can never break the strict store)", () => {
    const { text, problems } = checkModelText(timerFrame(), GOOD_MOTION, "vision");
    expect(problems).toEqual([]);
    expect(text.length).toBeLessThanOrEqual(MOTION_TEXT_MAX);
    expect(MOTION_ENGLISH.test(text)).toBe(true);
  });
});

describe("framePayload: the frame's facts as the model sees them (constraints, never the photo's prompt)", () => {
  test("names the capture, the face, the legs framing, the level and «Смелая»", () => {
    const ordinary = framePayload(timerFrame());
    expect(ordinary).toMatchObject({ capture: "timer", faceVisible: "yes", legsFraming: false, level: "ordinary", bold: false });
    const bold = framePayload(boldMirrorFrame());
    expect(bold).toMatchObject({ capture: "mirror", level: "bold", bold: true });
    expect(JSON.stringify(bold)).not.toContain("prompt");
  });

  test("allows a phone only where the moment uses one and hers is not in her hand or propped", () => {
    expect(framePayload(timerFrame()).phoneAllowed).toBe(false);
    expect(framePayload(boldMirrorFrame()).phoneAllowed).toBe(false);
  });

  test("keeps the bank activity short (at most 160 characters), and null when the photo does not carry one", () => {
    const long = framePayload({ ...timerFrame(), activity: "x".repeat(400) });
    expect(long.activity?.length).toBeLessThanOrEqual(160);
    expect(framePayload({ ...timerFrame(), activity: null }).activity).toBeNull();
  });
});

describe("stepOf: one chat result as the part C jobs read it", () => {
  test("a 2xx is an answer, paid at its usage cost", () => {
    expect(stepOf(okAnswer("{}", 3_400))).toEqual({ kind: "answer", content: "{}", costMicros: 3_400 });
  });

  test("a moderation refusal is free", () => {
    expect(stepOf(refusedAnswer())).toEqual({ kind: "refused", costMicros: 0 });
  });

  test("a paid answer with no content is unreadable and keeps what it cost", () => {
    expect(stepOf(emptyAnswer(1_500))).toEqual({ kind: "unreadable", costMicros: 1_500 });
  });

  test("a budget refusal before the send is no room, free", () => {
    const blocked = { status: "blocked", refusal: { reason: "RUN_CAP_EXCEEDED", committedMicros: 1, worstMicros: 2, limitMicros: 1 } } as const;
    expect(stepOf(blocked)).toEqual({ kind: "no-room", costMicros: 0 });
  });

  test("any other failure is an engine error", () => {
    const step = stepOf(authAnswer());
    expect(step).toMatchObject({ kind: "error", error: { code: "AUTH_INVALID" }, costMicros: 0 });
  });

  test("a cancel is an error too, never a silent success", () => {
    const step = stepOf({ status: "aborted", ledger: { action: "left-open", worstMicros: 5 } });
    expect(step).toMatchObject({ kind: "error", error: { code: "INTERNAL" } });
  });
});
