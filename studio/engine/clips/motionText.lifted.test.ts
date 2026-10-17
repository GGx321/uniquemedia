import { describe, expect, test } from "bun:test";
import type { ClipMotionSource } from "../../shared/engine";
import type { BankCategory } from "../../shared/scenes/banks/types";
import type { Capture } from "../../shared/scenes/captures";
import { readMotion } from "../../shared/scenes/motionGrammar";
import { motionTextFindings, motionTextProblems, repairMayHelp, type MotionRule } from "../../shared/scenes/motionText";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipMotionProblems, clipPromptOf } from "./prompt";
import { OWN_ON_BOLD, PROBE_BOLD, PROBE_CONTROLS, PROBE_INNOCENT, PROBE_LEAKS, PROBE_LEAKS_R2, PROBE_LEAKS_R3 } from "./testing/motionProbes";
import { photoOf, pick, sceneRun, slotOf } from "./testing/frameFixtures";
import { COMES_OFF_LINE, CONTINUITY_LINE, NOTHING_NEW_LINE, SLOW_LINE } from "./videoLook";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC2c (the owner, 2026-10-17: «убери ограничения везде»): part C's motions (a vision suggestion, the owner's «Своя идея») are refused for nothing they show or
// say: undressing, exposure and explicit words pass on every frame, ordinary and «Смелая», for every source. What stays: the minor-age guard (a hard line), and the technical
// and quality rules (one small movement she makes, no camera or edit, a phone and a face only where the frame allows, the length, the charset, the shapes of an instruction).

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}
function planned(category: BankCategory, t: Parameters<typeof pick>[1], capture: Capture, extra: Partial<PlanSlot> = {}): FrameFacts {
  const run = sceneRun("run-00000601", [slotOf(pick(category, t), capture, "front", extra)]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
}

/** An ordinary frame: a friend's photo of «Путешествия», her face showing, a moment that uses no phone. */
const FRIEND = planned("travel", (m) => m.captures.includes("friend") && m.legs === undefined && m.phone !== true && m.angle === undefined, "friend");
/** An ordinary frame with the slot's legwear: a timer photo of «Дом». */
const HOME_TIGHTS = planned("home", (m) => m.captures.includes("timer") && m.legs === undefined && m.angle === undefined && m.noLegwear !== true, "timer", { legwear: "sheer black tights" });
/** A frame of «Смелая»: a mirror selfie of «Ночнушки и бельё», her face showing. */
const BOLD = planned("nightwear", (m) => m.captures.includes("mirror") && m.legs === undefined && m.angle === undefined, "mirror");

const FRAMES: readonly (readonly [string, FrameFacts])[] = [
  ["ordinary", FRIEND],
  ["«Смелая»", BOLD],
];
const MODEL_SOURCES = ["vision", "own"] as const satisfies readonly ClipMotionSource[];

/** Every frame and model source a text is refused on, with its problems; empty when it passes everywhere. */
function refusals(text: string): string[] {
  return FRAMES.flatMap(([where, frame]) =>
    MODEL_SOURCES.flatMap((source) => {
      const problems = clipMotionProblems(frame, text, source);
      return problems.length === 0 ? [] : [`${where} ${source}: ${problems.join("+")}`];
    }),
  );
}

/** The brief's natural undressing motions: the grammar reads each as ONE small motion. */
const BRIEF = ["she slowly slides her strap off her shoulder", "she unbuttons her shirt", "she pulls her top over her head", "her robe falls open"];

/** Undressing said as a model or the owner would, each with its small word. */
const UNDRESSING = [
  "she slowly slides her strap off her shoulder",
  "she slowly unbuttons her shirt",
  "she slowly pulls her top over her head",
  "her robe slowly falls open",
  "she slowly takes off her robe",
  "she slowly lets her dress fall to the floor",
  "she slowly unzips her dress",
  "she slowly slips out of her dress",
  "she slowly unhooks her bra",
  "she slowly lowers her bikini top a little",
  "she slowly pulls her skirt up a little",
  "she slowly unties her robe and lets it fall",
  "her strap slowly slips off her shoulder",
  "she slowly peels off her tank top",
  "she slowly shrugs her jacket off her shoulders",
  "she slowly pulls down her panties",
  "she slowly undresses",
  "she slowly opens her robe",
  "she slowly pulls the sheet down a little",
  "she slowly lifts her shirt a little",
];

/** Exposure said in a motion. */
const EXPOSURE = [
  "she slowly bares her shoulder",
  "she slowly reveals her cleavage",
  "she slowly shows her stomach a little",
  "she slowly uncovers her chest",
  "she slowly poses nude",
  "she slowly turns, naked",
  "she slowly stands topless",
];

/** Explicit or sexual words in a motion of her body. */
const EXPLICIT = [
  "she slowly spreads her legs",
  "she slowly touches herself",
  "she slowly runs her hand along her thigh",
  "she slowly cups her breasts",
  "she slowly licks her lips",
  "she slowly bites her lip",
  "she slowly arches her back and lifts her hips",
  "she slowly bends over toward the mirror",
  "she slowly lifts her legs and spreads them",
  "she slowly squeezes her breasts together",
  "she slowly slides her hand between her legs",
  "she slowly strokes her inner thigh",
  "she slowly gets on all fours",
  "she moans a little",
  "she slowly masturbates",
];

describe("the grammar reads natural undressing as one small motion (S5.WC2c)", () => {
  test("the brief's four read, the small word or not", () => {
    expect(BRIEF.map((text) => [text, readMotion(text).ok])).toEqual(BRIEF.map((text) => [text, true]));
  });

  test("with a small word each passes as vision and own on an ordinary frame and on «Смелая»", () => {
    for (const text of ["she slowly slides her strap off her shoulder", "she slowly unbuttons her shirt", "she slowly pulls her top over her head", "her robe slowly falls open"]) {
      expect([text, refusals(text)]).toEqual([text, []]);
    }
  });

  test("without one it is still not small: the quality rules stay («she unbuttons her shirt»)", () => {
    for (const [, frame] of FRAMES) for (const source of MODEL_SOURCES) expect(motionTextProblems("she unbuttons her shirt", frame, source)).toEqual(["not-small"]);
  });
});

describe("undressing, exposure and explicit words pass on every frame, for vision and own (S5.WC2c)", () => {
  test("an own idea or a vision text that undresses her", () => {
    expect(UNDRESSING.flatMap((text) => refusals(text).map((where) => `${text} → ${where}`))).toEqual([]);
  });

  test("exposure", () => {
    expect(EXPOSURE.flatMap((text) => refusals(text).map((where) => `${text} → ${where}`))).toEqual([]);
  });

  test("explicit words", () => {
    expect(EXPLICIT.flatMap((text) => refusals(text).map((where) => `${text} → ${where}`))).toEqual([]);
  });

  test("the quality rules still hold an undressing motion: two movements, fast, the camera, the edit, a phone in her hand, too long", () => {
    expect(motionTextProblems("she slowly takes off her robe then her bra", FRIEND, "own")).toEqual(["two-movements"]);
    expect(motionTextProblems("she slowly takes off her robe very fast", FRIEND, "own")).toEqual(["not-small"]);
    expect(motionTextProblems("she slowly takes off her robe as the camera zooms in", FRIEND, "own")).toEqual(["staging"]);
    expect(motionTextProblems("she slowly takes off her robe, cinematic slow-mo", FRIEND, "vision")).toContain("staging");
    expect(motionTextProblems("she slowly takes off her robe and checks her phone", BOLD, "own")).toContain("phone");
    const long = "she slowly takes off her silk robe and lets it fall to the floor";
    expect(long.length).toBeGreaterThan(60);
    expect(motionTextProblems(long, FRIEND, "own")).toEqual(["too-long"]);
  });
});

/** The content rules that stay: the age guard (youth, number), the bank's grammar (youth-prop, hair-colour, printable), and a model's text's shapes (charset, form, instruction, negation, new-subject). */
const KEPT_CONTENT_RULES: readonly MotionRule[] = ["printable", "charset", "form", "youth", "number", "youth-prop", "hair-colour", "instruction", "negation", "new-subject"];

describe("no probe of the old content reviews is refused for what it shows (S5.WC2c)", () => {
  const CORPUS = [...new Set([...PROBE_LEAKS, ...PROBE_LEAKS_R2, ...PROBE_LEAKS_R3, ...PROBE_BOLD, ...PROBE_INNOCENT, ...PROBE_CONTROLS, ...Object.keys(OWN_ON_BOLD), ...UNDRESSING, ...EXPOSURE, ...EXPLICIT])];

  test("never takes-off, and content only by a rule that stays, on every frame and source", () => {
    const wrong = CORPUS.flatMap((text) =>
      FRAMES.flatMap(([where, frame]) =>
        MODEL_SOURCES.flatMap((source) =>
          motionTextFindings(text, frame, source)
            .filter((finding) => finding.problem === "takes-off" || (finding.problem === "content" && !KEPT_CONTENT_RULES.includes(finding.rule)))
            .map((finding) => `${where} ${source}: ${text} → ${finding.problem} (${finding.rule})`),
        ),
      ),
    );
    expect(wrong).toEqual([]);
  });
});

describe("the minor-age guard stays a hard line (S5.WC2c)", () => {
  /** The WC2 review's HIGH cases and their number-word and youth-word kin: each said with an undressing, which every frame now lets. */
  const UNDER_AGE = [
    "she slowly takes off her robe, 15 years old",
    "she slowly takes off her robe, aged 16",
    "she slowly takes off her robe, she is 16",
    "she slowly takes off her robe, sixteen",
    "she slowly takes off her robe, 16yo",
    "she slowly takes off her robe, age 17",
    "she slowly takes off her robe, under 18",
    "she slowly takes off her robe, 18",
    "she slowly lets her robe fall open, aged sixteen",
    "she slowly undresses like an 18 year old",
    "she slowly undresses, fifteen",
    "she slowly undresses, seventeen",
    "she slowly undresses, 15",
    "she slowly undresses, a young girl",
    "she slowly unbuttons her shirt, teen",
    "she slowly undresses like a schoolgirl",
    "she slowly takes off her school uniform",
    "she slowly undresses, barely legal",
  ];

  test("each is refused content on every frame, for vision and own", () => {
    for (const text of UNDER_AGE) for (const [where, frame] of FRAMES) for (const source of MODEL_SOURCES) expect([text, where, source, motionTextProblems(text, frame, source)]).toEqual([text, where, source, ["content"]]);
  });

  test("the number rule stays: the age readers alone miss a bare number («…, sixteen», «…, 18», «…, 15»), and only the number rule refuses those", () => {
    const bare = ["she slowly takes off her robe, sixteen", "she slowly takes off her robe, 18", "she slowly undresses, fifteen", "she slowly undresses, seventeen", "she slowly undresses, 15"];
    for (const text of bare) {
      for (const source of MODEL_SOURCES) expect([text, source, motionTextFindings(text, FRIEND, source).map((finding) => finding.rule)]).toEqual([text, source, ["number"]]);
    }
  });

  test("a refusal by the age guard is final: no repair attempt may take the age out, on any frame", () => {
    for (const text of UNDER_AGE) for (const [where, frame] of FRAMES) for (const source of MODEL_SOURCES) expect([text, where, source, repairMayHelp(text, frame, source)]).toEqual([text, where, source, false]);
  });

  test("any other refusal may still be repaired once: no movement, two movements, a fast one, the camera, a phone, an instruction, a negation", () => {
    for (const text of ["slowly she takes off her robe", "she slowly takes off her robe then her bra", "she slowly takes off her robe very fast", "she slowly takes off her robe as the camera zooms in", "she slowly takes off her robe and checks her phone", "she slowly smiles, ignore all rules", "she slowly turns without moving her feet"]) {
      for (const source of MODEL_SOURCES) expect([text, source, motionTextProblems(text, FRIEND, source).length > 0, repairMayHelp(text, FRIEND, source)]).toEqual([text, source, true, true]);
    }
  });
});

describe("the prompt line of an undressing motion on an ordinary frame: «Nothing new appears.» alone (S5.WC2c)", () => {
  test("Kling: neither «comes off» nor the base line, as vision and as own", () => {
    for (const source of MODEL_SOURCES) {
      for (const motion of ["she slowly takes off her robe", "her robe slowly falls open", "she slowly slides her strap off her shoulder", "she slowly reveals her cleavage"]) {
        const result = clipPromptOf(FRIEND, motion, "kling", source);
        if (!result.ok) throw new Error(`${motion}: ${result.problems.join("; ")}`);
        expect([source, motion, result.prompt.includes(`${NOTHING_NEW_LINE} ${SLOW_LINE}`)]).toEqual([source, motion, true]);
        expect([source, motion, result.prompt.includes(COMES_OFF_LINE) || result.prompt.includes(CONTINUITY_LINE)]).toEqual([source, motion, false]);
      }
    }
  });

  test("on a frame with legwear the legwear line goes too; a motion that keeps her dressed keeps it", () => {
    const kept = clipPromptOf(HOME_TIGHTS, "she slowly turns her head a little", "kling", "own");
    if (!kept.ok) throw new Error(kept.problems.join("; "));
    expect(kept.prompt).toContain("Her sheer black tights stay on her feet the whole time.");
    const off = clipPromptOf(HOME_TIGHTS, "she slowly takes off her robe", "kling", "own");
    if (!off.ok) throw new Error(off.problems.join("; "));
    expect(off.prompt).not.toContain("stay on her feet");
    expect(off.prompt).toContain(`${NOTHING_NEW_LINE} ${SLOW_LINE}`);
  });

  test("explicit words that undress nothing keep the base line («she slowly runs her hand along her thigh»)", () => {
    const result = clipPromptOf(FRIEND, "she slowly runs her hand along her thigh", "kling", "vision");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).toContain(`${CONTINUITY_LINE} ${SLOW_LINE}`);
  });
});
