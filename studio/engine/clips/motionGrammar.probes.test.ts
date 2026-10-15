import { describe, expect, test } from "bun:test";
import { BANK_VERBS, CURATED_VERBS, readMotion } from "../../shared/scenes/motionGrammar";
import { motionTextFindings, motionTextProblems } from "../../shared/scenes/motionText";
import type { BankCategory } from "../../shared/scenes/banks/types";
import type { Capture } from "../../shared/scenes/captures";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { clipPromptOf } from "./prompt";
import { photoOf, pick, sceneRun, slotOf } from "./testing/frameFixtures";
import { OWN_ON_BOLD, PROBE_BOLD, PROBE_CONTROLS, PROBE_INNOCENT, PROBE_LEAKS, PROBE_LEAKS_R2, PROBE_LEAKS_R3 } from "./testing/motionProbes";
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

// ---------- S5.WC2b round 3: the re-review (2 HIGH, 4 MEDIUM, LOW) ----------

const where = (text: string): string[] =>
  [
    ["ordinary vision", motionTextProblems(text, FRIEND, "vision")],
    ["ordinary own", motionTextProblems(text, FRIEND, "own")],
    ["«Смелая» vision", motionTextProblems(text, BOLD, "vision")],
  ].flatMap(([at, problems]) => ((problems as string[]).length === 0 ? [`${String(at)}: ${text}`] : []));

describe("the re-review's leaks are refused as vision and own on an ordinary frame and as vision on «Смелая» (round 3)", () => {
  test("every r2 probe", () => {
    expect(PROBE_LEAKS_R2.flatMap(where)).toEqual([]);
  });

  test("H1, M1: a towel, a sheet, a blanket or the covers taken, pulled, slipped or kicked off stays what she wears or lies under: takes-off", () => {
    for (const text of ["she slowly takes off her towel", "she slowly pulls off her towel", "she slowly slips off her towel", "she slowly kicks off the sheet", "she slowly pulls off the blanket", "she slowly takes off the covers"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, ["takes-off"]]);
    }
  });

  test("H1: the towel or the blanket stays a place she moves on, off or from (steps, rolls, rises, sits, lies, gets up)", () => {
    for (const text of ["she slowly steps off the towel", "she slowly rises from the blanket", "she slowly gets up off the towel", "she slowly rolls off the towel onto the sand"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, []]);
    }
  });

  test("H2: «it» and «them» are what they stand for: legs or knees spread, opened or parted by a pronoun are an explicit act, content on every frame and source", () => {
    for (const text of ["she slowly lifts her legs and spreads them", "she slowly bends her knees and opens them", "she slowly crosses her legs and opens them", "she slowly raises her knees and parts them a little"]) {
      for (const source of ["vision", "own", "scene", "code"] as const) {
        for (const frame of [FRIEND, BOLD]) expect([text, source, motionTextProblems(text, frame, source).includes("content")]).toEqual([text, source, true]);
      }
    }
  });

  test("M2: a garment held closed, then her hands dropped, lowered or relaxed: takes-off", () => {
    for (const text of ["she slowly holds her robe closed and drops her hands", "she slowly holds her robe closed, relaxing her hands", "she slowly closes her robe and drops her hands"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, ["takes-off"]]);
    }
  });

  test("M4: bending over toward the mirror is the explicit list's own, content on every frame and source", () => {
    for (const source of ["vision", "own", "scene", "code"] as const) expect(motionTextProblems("she slowly bends over toward the mirror", BOLD, source)).toContain("content");
  });

  test("the bank's own «toward the mirror» stays: her head and her hips turned toward it", () => {
    for (const text of ["she slowly turns her head a little toward the mirror", "she turns her hips a little toward the mirror and back"]) expect(motionTextProblems(text, FRIEND, "vision")).toEqual([]);
  });

  test("the re-review's sweep: every verb × particle × garment the grammar reads and the check passes ends more covered (or names bedding as a place)", () => {
    const VERBS = [...BANK_VERBS, ...CURATED_VERBS];
    const PARTS = ["off", "from", "out from", "down", "away", "aside", "open", "up", "out of", "under", "into", "across", "onto", "on"];
    // The final touch adds garment parts said as phrases (a cup, a clip, laces, a ring, a hood of what she wears), which read as props before.
    const OBJS = [
      ...["her towel", "the towel", "the sheet", "the blanket", "her robe", "her top", "her dress", "her skirt", "her shorts", "her bra", "her bikini", "her strap", "her straps", "her neckline"],
      ...["her sleeve", "her jeans", "her panties", "her shirt", "the covers", "her outfit", "her clothes", "her jacket", "her hem", "her waistband", "her belt", "her duvet"],
      ...["her bra cup", "the clip of her bra", "the laces of her dress", "the laces of her corset", "the ring of her bikini top", "the hood of her robe", "her bikini cup"],
    ];
    /** What may pass: bedding or a towel as a place; leaving it; a cover pulled up; what covers her legs, a strap or a neckline pulled up; a sleeve; a skirt or a hem down; an outer layer on; zipped up; smoothed. */
    const COVERED = [
      / (?:under|into|across|onto|on) (?:her towel|the towel|the sheet|the blanket|the covers|her duvet)$/,
      /^she slowly (?:lies|gets|rolls|rises|sits|stands|steps) (?:off|from|out from) the (?:towel|sheet|blanket|covers)$/,
      /^she slowly (?:pulls|tugs|draws) (?:up )?(?:the sheet|the blanket|the covers|her duvet)(?: up)?(?: a little)?$/,
      /^she slowly (?:pulls|tugs|slides) (?:up )?her (?:jeans|waistband|strap|straps|neckline)(?: up)?(?: a little)?$/,
      /^she slowly (?:pulls|tugs|rolls|pushes) (?:up |down )?her sleeve(?: up| down)?(?: a little)?$/,
      /^she slowly (?:pulls|tugs|holds|keeps) (?:down )?her (?:skirt|hem)(?: down)?(?: a little)?$/,
      /^she slowly (?:puts|slips|pulls) (?:on )?her (?:jacket|robe)(?: on)?(?: a little)?$/,
      /^she slowly slips into her (?:jacket|robe)$/,
      /^she slowly zips (?:up )?her (?:clothes|dress|hem|jacket|outfit|robe|shirt|skirt|top)(?: up)?(?: a little)?$/,
      /^she slowly smooths (?:down |out )?(?:her|the) (?:dress|hem|skirt|shirt|top|outfit|clothes|sheet|blanket|covers|duvet)(?: down| out)?(?: a little)?$/,
    ];
    const loose: string[] = [];
    for (const v of VERBS) {
      for (const p of PARTS) {
        for (const o of OBJS) {
          for (const t of [`she slowly ${v} ${p} ${o}`, `she slowly ${v} ${o} ${p}`, `she slowly ${v} ${o} ${p} a little`]) {
            if (!readMotion(t).ok) continue;
            if (motionTextProblems(t, FRIEND, "vision").length > 0 && motionTextProblems(t, BOLD, "vision").length > 0) continue;
            if (!COVERED.some((shape) => shape.test(t))) loose.push(t);
          }
        }
      }
    }
    // Two clauses (the final touch's M-B and M-D): a garment held closed, then any movement of her hands or arms; a hand on her knee or at her lips, then slid higher or
    // brought lower; a strap adjusted, then a bare «lower» (the strap again).
    const passes = (t: string): boolean => readMotion(t).ok && (motionTextProblems(t, FRIEND, "vision").length === 0 || motionTextProblems(t, BOLD, "vision").length === 0);
    for (const first of ["she slowly holds her robe closed", "she slowly pulls her robe closed", "she slowly wraps her robe tighter"]) {
      for (const then of ["lifts her hands", "raises her arms", "stretches", "reaches up", "waves both hands", "lower", "drops her hands", "spreads her arms"]) if (passes(`${first} and ${then}`)) loose.push(`${first} and ${then}`);
    }
    for (const first of ["she slowly rests her hand on her knee", "she slowly brings her hand to her lips", "she slowly adjusts her strap"]) {
      for (const then of ["slides it higher", "slides it up", "lower"]) if (passes(`${first} and ${then}`)) loose.push(`${first} and ${then}`);
    }
    expect(loose).toEqual([]);
  }, 120_000);

  test("the café vocabulary reads (a repair would otherwise spin)", () => {
    for (const text of [
      "she slowly sets her cup down",
      "she slowly brings the cup to her lips",
      "she slowly stirs her latte",
      "she slowly stirs her coffee",
      "she slowly turns a page of her book",
      "she slowly looks out the window",
      "she slowly rests her hand on her knee",
      "she slowly wraps her arms around her knees",
      "she slowly digs her toes into the sand",
    ]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, []]);
    }
  });
});

// ---------- S5.WC2b final touch: the last re-check ----------

describe("the last re-check's leaks are refused as vision and own on an ordinary frame and as vision on «Смелая» (final touch)", () => {
  test("every r3 probe", () => {
    expect(PROBE_LEAKS_R3.flatMap(where)).toEqual([]);
  });

  test("M-A: a cup, a clip, laces or a ring of what she wears is part of it, never a prop: lowered or taken off, takes-off", () => {
    // «bra» and «bikini» are the content line's revealing words at an ordinary frame too: the grammar's code is takes-off.
    for (const text of ["she slowly lowers her bra cup", "she slowly removes the clip of her bra", "she slowly pulls the laces of her dress down", "she slowly pulls the ring of her bikini top"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextFindings(text, FRIEND, source).filter((f) => f.rule === "grammar-off").length]).toEqual([text, source, 1]);
    }
  });

  test("M-B: a garment held closed, then any movement of her hands or arms: takes-off", () => {
    // The last is 61 characters (too-long too): its grammar code is still takes-off.
    for (const text of ["she slowly holds her robe closed and lifts her hands", "she slowly holds her robe closed and stretches", "she slowly wraps her robe tighter and reaches up", "she slowly holds her robe closed and puts her hands on her hips"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextFindings(text, FRIEND, source).filter((f) => f.rule === "grammar-off").length]).toEqual([text, source, 1]);
    }
  });

  test("M-C: bending over in front of, at or facing the mirror is the explicit list's own; her hips, her arched back or leaning forward there pose her: content", () => {
    for (const source of ["vision", "own", "scene", "code"] as const) {
      for (const text of ["she slowly bends over in front of the mirror", "she slowly bends over at the mirror"]) expect([text, source, motionTextProblems(text, BOLD, source).includes("content")]).toEqual([text, source, true]);
    }
    for (const text of ["she slowly lifts her hips in front of the mirror", "she slowly arches her back in front of the mirror", "she slowly leans forward in front of the mirror"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, ["content"]]);
    }
  });

  test("M-D: a hand slid up her knee or brought lower is no motion it reads: content", () => {
    for (const text of ["she slowly rests her hand on her knee and slides it higher", "she slowly rests a hand on her knee, sliding it up", "she slowly brings her hand to her lips and lower"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, ["content"]]);
    }
  });

  test("LOW: undressing said in a way the grammar does not read is still named: takes-off; knees swayed side to side are refused", () => {
    for (const text of ["she slowly steps out from her towel", "she slowly zips her hoodie down a little", "her chest slowly rises out of her top", "she slowly stands, the towel at her feet"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, ["takes-off"]]);
    }
    expect(motionTextProblems("she slowly sways her knees side to side", FRIEND, "vision")).toEqual(["content"]);
  });

  test("knees or legs named, then «them» moved aside, apart or open, whatever noun came last (the r3 probe is refused only by its length otherwise): content", () => {
    const text = "she slowly lifts her knees over a book, lowering them aside";
    expect(text.length).toBeLessThanOrEqual(60);
    for (const source of ["vision", "own"] as const) expect([source, motionTextProblems(text, FRIEND, source)]).toEqual([source, ["content"]]);
  });

  test("what the final touch leaves alone still reads: her hand on her knee, the cup to her lips, a skirt held down in the wind, a strap pulled up, the beach towel stepped off", () => {
    for (const text of ["she slowly rests her hand on her knee", "she slowly brings the cup to her lips", "she slowly holds her skirt down in the wind", "she slowly pulls up her strap a little", "she slowly steps off the towel", "she slowly lowers her hand slowly and smiles"]) {
      expect([text, motionTextProblems(text, FRIEND, "vision")]).toEqual([text, []]);
    }
  });
});
