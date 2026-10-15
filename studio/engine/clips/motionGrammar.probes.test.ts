import { describe, expect, test } from "bun:test";
import { motionTextFindings, motionTextProblems } from "../../shared/scenes/motionText";
import type { BankCategory } from "../../shared/scenes/banks/types";
import type { Capture } from "../../shared/scenes/captures";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipPromptOf } from "./prompt";
import { photoOf, pick, sceneRun, slotOf } from "./testing/frameFixtures";
import { OWN_ON_BOLD, PROBE_BOLD, PROBE_CONTROLS, PROBE_INNOCENT, PROBE_LEAKS } from "./testing/motionProbes";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC2b round 2 (the controller's decision after the adversarial review): a vision text on any frame and an own text on an ordinary frame are held to a
// POSITIVE motion grammar (shared/scenes/motionGrammar.ts). Every probe of the review is a case here: the leaks are refused, the covering controls and the innocent texts
// pass or come back as a repairable `not-motion` (never `takes-off`), and an own idea on «Смелая» keeps today's answer, byte for byte.

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}
function planned(category: BankCategory, t: Parameters<typeof pick>[1], capture: Capture): FrameFacts {
  const run = sceneRun("run-00000401", [slotOf(pick(category, t), capture, "front")]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
}
/** The review's frames: a friend's photo of «Путешествия» (ordinary) and a mirror selfie of «Ночнушки и бельё» («Смелая»). */
const FRIEND = planned("travel", (m) => m.captures.includes("friend") && m.legs === undefined && m.phone !== true && m.angle === undefined, "friend");
const BOLD = planned("nightwear", (m) => m.captures.includes("mirror") && m.legs === undefined && m.angle === undefined, "mirror");

describe("the review's leaks are refused as vision and own on an ordinary frame and as vision on «Смелая»", () => {
  test("every leak probe", () => {
    const passed = PROBE_LEAKS.flatMap((text) =>
      [
        ["ordinary vision", motionTextProblems(text, FRIEND, "vision")],
        ["ordinary own", motionTextProblems(text, FRIEND, "own")],
        ["«Смелая» vision", motionTextProblems(text, BOLD, "vision")],
      ].flatMap(([where, problems]) => ((problems as string[]).length === 0 ? [`${String(where)}: ${text}`] : [])),
    );
    expect(passed).toEqual([]);
  });
});

/**
 * What an innocent text may still get from the rules that were there before the grammar, never from it: the content line's revealing word at an ordinary frame («poses in
 * her bikini») and the new-subject rule's «walks in» («walks in her bikini along the shore»). Both are repairable `content`.
 */
const OLDER_CONTENT_RULES = new Set(["revealing", "new-subject"]);
const notTheGrammars = (text: string, source: "vision" | "own"): string[] =>
  motionTextFindings(text, FRIEND, source)
    .filter((finding) => !(finding.problem === "not-motion" || (finding.problem === "content" && OLDER_CONTENT_RULES.has(finding.rule))))
    .map((finding) => `${source}: ${text} → ${finding.problem} (${finding.rule})`);

describe("the covering controls among them pass (they end more covered)", () => {
  test("every control, as vision and own on an ordinary frame (the content line's own revealing word aside: «her bikini strap»)", () => {
    for (const text of PROBE_CONTROLS) {
      for (const source of ["vision", "own"] as const) {
        expect([text, source, motionTextFindings(text, FRIEND, source).filter((finding) => finding.rule !== "revealing")]).toEqual([text, source, []]);
      }
    }
  });
});

describe("the innocent probes pass, or come back as a repairable not-motion: never takes-off, never a content of the grammar's (F1)", () => {
  test("every innocent probe, as vision and own on an ordinary frame (the older content rules aside)", () => {
    expect(PROBE_INNOCENT.flatMap((text) => (["vision", "own"] as const).flatMap((source) => notTheGrammars(text, source)))).toEqual([]);
  });

  test("the prone, dressing and twirling cases the controller names pass outright", () => {
    for (const text of [
      "she slowly lies on her stomach on the bed",
      "she slowly lies on her stomach on the sand",
      "she slowly lies on her stomach on her towel",
      "she slowly twirls in her dress",
      "she slowly lies back on the towel",
      "she slowly puts on her jacket",
    ]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, []]);
    }
  });

  test("«checks her outfit in the mirror» is a repairable not-motion, not takes-off", () => {
    for (const source of ["vision", "own"] as const) expect(motionTextProblems("she slowly checks her outfit in the mirror", FRIEND, source)).toEqual(["not-motion"]);
  });
});

describe("an own idea on «Смелая» keeps today's path: the same problems, the same Kling and Grok prompts, for every probe", () => {
  test("every probe's own-on-«Смелая» answer is the one recorded before the grammar", () => {
    const moved = Object.entries(OWN_ON_BOLD).flatMap(([text, was]) => {
      const problems = motionTextProblems(text, BOLD, "own").join("+");
      const k = clipPromptOf(BOLD, text, "kling", "own");
      const g = clipPromptOf(BOLD, text, "grok", "own");
      const line = k.ok ? (k.prompt.includes("Nothing new appears. ") ? "nothing-new" : k.prompt.includes("comes off") ? "comes-off" : "base") : "refused";
      const now = `${problems === "" ? "ok" : problems} k:${line} g:${g.ok ? "ok" : "refused"}`;
      return now === was ? [] : [`${text}: was ${was}, now ${now}`];
    });
    expect(moved).toEqual([]);
    expect(PROBE_BOLD.length).toBeGreaterThan(0);
  });
});
