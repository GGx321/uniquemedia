import { describe, expect, test } from "bun:test";
import { BANK_VERBS, CURATED_VERBS, readMotion } from "../../shared/scenes/motionGrammar";
import { motionTextFindings, motionTextProblems, undressesBy } from "../../shared/scenes/motionText";
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
// POSITIVE motion grammar (shared/scenes/motionGrammar.ts). Every probe of the review is a case here.
//
// S5.WC2c (the owner, 2026-10-17: «убери ограничения везде»): the review's leak probes were refused for what they show; nothing is now. Each one passes, or comes back as a
// repairable `not-motion` (a text the grammar does not read as one motion of hers) or with a quality problem; the grammar reads undressing and baring as such, so the prompt
// says «Nothing new appears.» alone for it. The counts below pin how far the grammar reads; a change to them is a change to the grammar, made on purpose.

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

/** The problems a probe may still get where the grammar holds: no content rule of what it shows, never takes-off. */
const QUALITY = new Set(["not-motion", "staging", "phone", "face-hidden", "two-movements", "not-small", "too-long"]);
/** The content rules that stay: the age guard and a model's text's shapes. */
const KEPT_CONTENT = new Set(["printable", "charset", "form", "youth", "number", "youth-prop", "hair-colour", "instruction", "negation", "new-subject"]);

/** What a probe gets as vision and own on an ordinary frame and as vision on «Смелая»: a problem the rules no longer give, or nothing. */
const wrongly = (text: string): string[] =>
  ([
    ["ordinary vision", FRIEND, "vision"],
    ["ordinary own", FRIEND, "own"],
    ["«Смелая» vision", BOLD, "vision"],
  ] as const).flatMap(([where, frame, source]) =>
    motionTextFindings(text, frame, source)
      .filter((finding) => !(QUALITY.has(finding.problem) || (finding.problem === "content" && KEPT_CONTENT.has(finding.rule))))
      .map((finding) => `${where}: ${text} → ${finding.problem} (${finding.rule})`),
  );

/** How many of a probe file pass as vision on an ordinary frame, and how many of those its prompt reads as undressing. */
function reach(texts: readonly string[]): { passed: number; undressing: number; of: number } {
  const passed = texts.filter((text) => motionTextProblems(text, FRIEND, "vision").length === 0);
  return { passed: passed.length, undressing: passed.filter((text) => undressesBy(text, "vision", false)).length, of: texts.length };
}

describe("S5.WC2c: the review's leak probes are refused for nothing they show", () => {
  test("every leak probe (r1, r2, r3): no takes-off, and no content but by a rule that stays", () => {
    expect([...PROBE_LEAKS, ...PROBE_LEAKS_R2, ...PROBE_LEAKS_R3].flatMap(wrongly)).toEqual([]);
  });

  test("how far the grammar reads them: the passes, and the passes read as undressing (pinned)", () => {
    expect({ r1: reach(PROBE_LEAKS), r2: reach(PROBE_LEAKS_R2), r3: reach(PROBE_LEAKS_R3) }).toEqual({
      r1: { passed: 157, undressing: 134, of: 206 },
      r2: { passed: 109, undressing: 75, of: 112 },
      r3: { passed: 52, undressing: 31, of: 65 },
    });
  });
});

/**
 * What an innocent text may still get from the rules that were there before the grammar, never from it: the new-subject rule's «walks in» («walks in her bikini along the
 * shore»), repairable `content`. (S5.WC2c: the content line's revealing words refuse nothing any more.)
 */
const OLDER_CONTENT_RULES = new Set(["new-subject"]);
const notTheGrammars = (text: string, source: "vision" | "own"): string[] =>
  motionTextFindings(text, FRIEND, source)
    .filter((finding) => !(finding.problem === "not-motion" || (finding.problem === "content" && OLDER_CONTENT_RULES.has(finding.rule))))
    .map((finding) => `${source}: ${text} → ${finding.problem} (${finding.rule})`);

describe("the covering controls among them pass (they end more covered)", () => {
  test("every control, as vision and own on an ordinary frame (S5.WC2c: «her bikini strap» is no revealing word any more), and none undresses her", () => {
    for (const text of PROBE_CONTROLS) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextFindings(text, FRIEND, source)]).toEqual([text, source, []]);
      expect([text, undressesBy(text, "vision", false)]).toEqual([text, false]);
    }
  });
});

describe("the innocent probes pass, or come back as a repairable not-motion: never takes-off, never a content of the grammar's (F1)", () => {
  test("every innocent probe, as vision and own on an ordinary frame (the older content rules aside)", () => {
    expect(PROBE_INNOCENT.flatMap((text) => (["vision", "own"] as const).flatMap((source) => notTheGrammars(text, source)))).toEqual([]);
  });

  test("none that passes is read as undressing, but an accessory or a hat taken off (round 2, L2: «nothing she wears comes off» would contradict it)", () => {
    expect(PROBE_INNOCENT.filter((text) => motionTextProblems(text, FRIEND, "vision").length === 0 && undressesBy(text, "vision", false))).toEqual([
      "she slowly takes off her sunglasses",
      "she slowly takes off her hat",
    ]);
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

describe("an own idea on «Смелая» keeps its own path (no grammar): the recorded problems and Kling and Grok prompts, for every probe", () => {
  test("every probe's own-on-«Смелая» answer is the recorded one (re-recorded by S5.WC2c, see OWN_ON_BOLD)", () => {
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

// ---------- S5.WC2b round 3: the re-review (2 HIGH, 4 MEDIUM, LOW), as S5.WC2c reads it ----------

describe("the re-review's cases (round 3), now accepted: undressing is read as undressing, a place stays a place", () => {
  test("H1, M1: a towel, a sheet, a blanket or the covers taken, pulled, slipped or kicked off pass, read as undressing", () => {
    for (const text of ["she slowly takes off her towel", "she slowly pulls off her towel", "she slowly slips off her towel", "she slowly kicks off the sheet", "she slowly pulls off the blanket", "she slowly takes off the covers"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source), undressesBy(text, source, false)]).toEqual([text, source, [], true]);
    }
  });

  test("H1: the towel or the blanket stays a place she moves on, off or from (steps, rolls, rises, sits, lies, gets up): no undressing", () => {
    for (const text of ["she slowly steps off the towel", "she slowly rises from the blanket", "she slowly gets up off the towel", "she slowly rolls off the towel onto the sand"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source), undressesBy(text, source, false)]).toEqual([text, source, [], false]);
    }
  });

  test("H2: «it» and «them» are what they stand for: legs or knees spread, opened or parted by a pronoun pass on every frame and source (an explicit act is no refusal now)", () => {
    for (const text of ["she slowly lifts her legs and spreads them", "she slowly bends her knees and opens them", "she slowly crosses her legs and opens them", "she slowly raises her knees and parts them a little"]) {
      for (const source of ["vision", "own", "scene", "code"] as const) {
        for (const frame of [FRIEND, BOLD]) expect([text, source, motionTextProblems(text, frame, source)]).toEqual([text, source, []]);
      }
    }
  });

  test("M2, M-B: a garment held closed, then her hands or arms moved, lets it go: it passes, read as undressing", () => {
    for (const text of [
      "she slowly holds her robe closed and drops her hands",
      "she slowly holds her robe closed, relaxing her hands",
      "she slowly closes her robe and drops her hands",
      "she slowly holds her robe closed and lifts her hands",
      "she slowly holds her robe closed and stretches",
      "she slowly wraps her robe tighter and reaches up",
    ]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source), undressesBy(text, source, false)]).toEqual([text, source, [], true]);
    }
    // Her face after it is no letting go: «… and lifts her chin» keeps the robe closed.
    expect(undressesBy("she slowly wraps her coat tighter and lifts her chin", "vision", false)).toBe(false);
  });

  test("M4, M-C: bending over toward, in front of or at the mirror, her hips or her back posed there: they pass on every frame and source", () => {
    for (const text of ["she slowly bends over toward the mirror", "she slowly bends over in front of the mirror", "she slowly bends over at the mirror", "she slowly lifts her hips in front of the mirror", "she slowly arches her back in front of the mirror", "she slowly leans forward in front of the mirror"]) {
      for (const source of ["vision", "own", "scene", "code"] as const) expect([text, source, motionTextProblems(text, BOLD, source)]).toEqual([text, source, []]);
    }
  });

  test("the bank's own «toward the mirror» stays: her head and her hips turned toward it", () => {
    for (const text of ["she slowly turns her head a little toward the mirror", "she turns her hips a little toward the mirror and back"]) expect(motionTextProblems(text, FRIEND, "vision")).toEqual([]);
  });

  test("the re-review's sweep, as a consistency of the one check: every verb × particle × garment text the grammar reads passes as vision on an ordinary frame (no rule refuses what the grammar reads)", () => {
    const VERBS = [...BANK_VERBS, ...CURATED_VERBS];
    const PARTS = ["off", "from", "out from", "down", "away", "aside", "open", "up", "out of", "under", "into", "across", "onto", "on"];
    const OBJS = [
      ...["her towel", "the towel", "the sheet", "the blanket", "her robe", "her top", "her dress", "her skirt", "her shorts", "her bra", "her bikini", "her strap", "her straps", "her neckline"],
      ...["her sleeve", "her jeans", "her panties", "her shirt", "the covers", "her outfit", "her clothes", "her jacket", "her hem", "her waistband", "her belt", "her duvet"],
      ...["her bra cup", "the clip of her bra", "the laces of her dress", "the laces of her corset", "the ring of her bikini top", "the hood of her robe", "her bikini cup"],
    ];
    const refused: string[] = [];
    let generated = 0;
    let read = 0;
    let undressing = 0;
    for (const v of VERBS) {
      for (const p of PARTS) {
        for (const o of OBJS) {
          for (const t of [`she slowly ${v} ${p} ${o}`, `she slowly ${v} ${o} ${p}`, `she slowly ${v} ${o} ${p} a little`]) {
            // Within the length the one check allows (a longer one is `too-long`, a rule of its own).
            if (t.length > 60) continue;
            generated++;
            if (!readMotion(t).ok) continue;
            read++;
            const problems = motionTextProblems(t, FRIEND, "vision");
            if (problems.length > 0) refused.push(`${t} → ${problems.join("+")}`);
            if (undressesBy(t, "vision", false)) undressing++;
          }
        }
      }
    }
    expect(refused).toEqual([]);
    // Round 2 (L4): exact, so a change to the grammar's reach shows here and is made on purpose.
    expect({ generated, read, undressing }).toEqual({ generated: 184_065, read: 46_766, undressing: 24_063 });
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

// ---------- S5.WC2b final touch: the last re-check, as S5.WC2c reads it ----------

describe("the last re-check's cases (final touch), now accepted", () => {
  test("M-A: a cup, a clip, laces or a ring of what she wears is part of it, never a prop: lowered or taken off, it passes, read as undressing", () => {
    for (const text of ["she slowly lowers her bra cup", "she slowly removes the clip of her bra", "she slowly pulls the laces of her dress down", "she slowly pulls the ring of her bikini top"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source), undressesBy(text, source, false)]).toEqual([text, source, [], true]);
    }
  });

  test("M-D: a hand slid up her knee or brought lower passes, and undresses nothing", () => {
    for (const text of ["she slowly rests her hand on her knee and slides it higher", "she slowly rests a hand on her knee, sliding it up", "she slowly brings her hand to her lips and lower"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source), undressesBy(text, source, false)]).toEqual([text, source, [], false]);
    }
  });

  test("LOW: undressing said in the words of the final touch passes, read as undressing; what the grammar still cannot read is a repairable not-motion", () => {
    for (const text of ["she slowly steps out from her towel", "she slowly zips her hoodie down a little"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source), undressesBy(text, source, false)]).toEqual([text, source, [], true]);
    }
    for (const text of ["her chest slowly rises out of her top", "she slowly stands, the towel at her feet"]) {
      for (const source of ["vision", "own"] as const) expect([text, source, motionTextProblems(text, FRIEND, source)]).toEqual([text, source, ["not-motion"]]);
    }
    expect(motionTextProblems("she slowly sways her knees side to side", FRIEND, "vision")).toEqual([]);
  });

  test("knees named, then «them» lowered aside, pass", () => {
    const text = "she slowly lifts her knees over a book, lowering them aside";
    expect(text.length).toBeLessThanOrEqual(60);
    for (const source of ["vision", "own"] as const) expect([source, motionTextProblems(text, FRIEND, source)]).toEqual([source, []]);
  });

  test("what the final touch left alone still reads: her hand on her knee, the cup to her lips, a skirt held down in the wind, a strap pulled up, the beach towel stepped off", () => {
    for (const text of ["she slowly rests her hand on her knee", "she slowly brings the cup to her lips", "she slowly holds her skirt down in the wind", "she slowly pulls up her strap a little", "she slowly steps off the towel", "she slowly lowers her hand slowly and smiles"]) {
      expect([text, motionTextProblems(text, FRIEND, "vision"), undressesBy(text, "vision", false)]).toEqual([text, [], false]);
    }
  });
});
