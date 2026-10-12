import { describe, expect, test } from "bun:test";
import { artefactLine, CONSTRAINTS } from "../scenes/phoneLook";
import { BOLD_REALISM_CUE, boldPrompt } from "./boldPrompt";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, Seedream hair probe p5a3b): on the «Смелая» route ONLY, the artefact line gains a hair and skin realism cue and loses «slightly soft focus» and «muted colours»
// (Seedream paints soft, over-smooth hair from them). The assembler and phoneLook are S5.9c's; this is the route's own step on the finished prompt.

const CUE = "hair rendered as individual fine strands with natural flyaways and frizz, sharp phone-camera detail, real skin texture with pores; not painted, not illustrated, not airbrushed";
const IMPERFECTION = "a slight tilt of the horizon";

function promptWith(artefact: string): string {
  return `A friend photographs her. She sits on the bed. The reference photo shows the same woman; her face is the one in it. ${artefact} ${CONSTRAINTS}`;
}

describe("the cue", () => {
  test("is the probe's wording", () => {
    expect(BOLD_REALISM_CUE).toBe(CUE);
  });
});

describe("boldPrompt", () => {
  test("appends the cue to the artefact line, before the constraints", () => {
    const prompt = promptWith(artefactLine({ cameraRealism: false, light: "morning daylight", imperfection: "" }));
    expect(boldPrompt(prompt)).toContain(`Ordinary phone photo: morning daylight, everything in focus, the background as sharp as she is, ${CUE}. ${CONSTRAINTS}`);
  });

  test("drops «slightly soft focus» and «muted colours» from the lamp-mood camera-roll line and keeps the rest of it", () => {
    const prompt = promptWith(artefactLine({ cameraRealism: true, light: "x", imperfection: IMPERFECTION, lampMood: true }));
    const bold = boldPrompt(prompt);
    expect(bold).not.toMatch(/slightly soft focus|muted colours/);
    expect(bold).toContain(`Ordinary phone photo straight from her camera roll: dim evening light from a bedside lamp, the room in soft shadow, visible grain from the low light, ${IMPERFECTION}, ${CUE}. ${CONSTRAINTS}`);
  });

  test("drops «muted colours» from the plain lamp-mood line", () => {
    const prompt = promptWith(artefactLine({ cameraRealism: false, light: "x", imperfection: "", lampMood: true }));
    expect(boldPrompt(prompt)).toContain(`Ordinary phone photo: dim evening light from a bedside lamp, the room in soft shadow, ${CUE}. ${CONSTRAINTS}`);
  });

  test("keeps the camera-roll line without the soft words as it was, plus the cue", () => {
    const prompt = promptWith(artefactLine({ cameraRealism: true, light: "morning daylight", imperfection: IMPERFECTION }));
    expect(boldPrompt(prompt)).toContain(`flat auto-exposure, slight noise in the shadows, mild JPEG compression, ${IMPERFECTION}, everything in focus, the background as sharp as she is, ${CUE}. ${CONSTRAINTS}`);
  });

  test("leaves everything before the artefact line untouched", () => {
    const prompt = promptWith(artefactLine({ cameraRealism: true, light: "x", imperfection: IMPERFECTION, lampMood: true }));
    const head = prompt.slice(0, prompt.indexOf("Ordinary phone photo"));
    expect(boldPrompt(prompt).startsWith(head)).toBe(true);
  });

  test("leaves the constraints byte for byte", () => {
    expect(boldPrompt(promptWith(artefactLine({ cameraRealism: false, light: "morning daylight", imperfection: "" }))).endsWith(CONSTRAINTS)).toBe(true);
  });

  test("says the cue once even when applied twice", () => {
    const once = boldPrompt(promptWith(artefactLine({ cameraRealism: false, light: "morning daylight", imperfection: "" })));
    expect(boldPrompt(once)).toBe(once);
  });

  test("a prompt with no artefact line still gets the cue, before the constraints", () => {
    const bare = `She sits on the bed. ${CONSTRAINTS}`;
    expect(boldPrompt(bare)).toBe(`She sits on the bed. ${CUE}. ${CONSTRAINTS}`);
  });

  test("a prompt with neither an artefact line nor constraints ends with the cue", () => {
    expect(boldPrompt("She sits on the bed.")).toBe(`She sits on the bed. ${CUE}.`);
  });
});
