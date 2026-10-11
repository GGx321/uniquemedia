import { describe, expect, test } from "bun:test";
import { BANKS, CUES, GAZE } from "../../shared/scenes/banks";
import { BANK_CATEGORIES, type BankCategory, type BankPlace, type Level, type Moment } from "../../shared/scenes/banks/types";
import { faceVisibleOf, isHandCapture, LEGS_CAPTURES, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { legwearFits, momentAllowed, templateSentence } from "../../shared/scenes/template";
import { sentenceProblems } from "./assembler";
import { readWriterScenes } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6a, I5.23 «coherent by construction», plan s5a2 r1.2): every combination a built-in slot can draw (a moment, a capture it lists, a pose
// that capture can take, a level, an outfit, with and without legwear) renders, and its sentence passes the gates the LLM writer's sentences pass
// (readWriterScenes: youth and revealing words, a two-handed action on a hand-held shot, a pose contradiction, a phone or «selfie» in a selfie) and the
// assembler's last gate. So the face gate never pays a retry for our own contradiction.

const KEYS = Array.from({ length: 3 }, (_, i) => `run-${i}:slot-${i + 1}`);
const LEVELS: readonly Level[] = ["ordinary", "flirty"];

interface Case {
  where: string;
  sentence: string | null;
  capture: Capture;
  pose: (typeof POSES_ALL)[number];
}
const POSES_ALL = ["front", "three-quarter", "profile", "back"] as const;

/** The outfits a slot of this moment can wear: its pinned ones, or the category's; each with its legwear options. */
function wardrobe(category: BankCategory, moment: Moment): Array<{ outfit: string; legwear?: string }> {
  const outfits = BANKS[category].outfits.filter((o) => (moment.outfits === undefined ? o.pinOnly !== true : moment.outfits.includes(o.text)));
  return outfits.flatMap((o) => [{ outfit: o.text }, ...(legwearFits(moment, o) ? (BANKS[category].legwear?.items ?? []).map((legwear) => ({ outfit: o.text, legwear })) : [])]);
}

function drawableCases(): Case[] {
  const out: Case[] = [];
  for (const category of BANK_CATEGORIES) {
    for (const place of BANKS[category].places as readonly BankPlace[]) {
      for (const moment of place.moments) {
        for (const capture of moment.captures.filter((c) => !LEGS_CAPTURES.includes(c))) {
          for (const pose of posesFor(capture)) {
            for (const level of LEVELS) {
              if (!momentAllowed(moment, capture, pose, level)) continue;
              for (const { outfit, legwear } of wardrobe(category, moment)) {
                for (const key of KEYS) {
                  const sentence = templateSentence({ category, location: place.name, activity: moment.text, outfit, legwear, shot: shotOf(capture), capture, pose }, { key, level });
                  out.push({ where: `${category}/${place.name}/${moment.text}/${capture}/${pose}/${level}/${outfit}/${legwear ?? "-"}`, sentence, capture, pose });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

const CASES = drawableCases();

describe("every drawable built-in combination is coherent", () => {
  test("the sweep is not vacuous: every capture of the decks and every pose appear", () => {
    expect(CASES.length).toBeGreaterThan(20_000);
    expect(new Set(CASES.map((c) => c.capture)).size).toBe(9);
    expect(new Set(CASES.map((c) => c.pose)).size).toBe(4);
  });

  test("renders (built-in categories are always covered)", () => {
    expect(CASES.filter((c) => c.sentence === null).map((c) => c.where)).toEqual([]);
  });

  // Each distinct (sentence, stored shot, pose) is read once: many combinations render the same text.
  const READS = [...new Map(CASES.map((c) => [`${c.sentence}|${shotOf(c.capture)}|${c.pose}`, c])).values()];

  test("passes the writer's answer reader for its stored shot and pose", () => {
    const refused = READS.flatMap((c) => {
      const answer = readWriterScenes([{ slotIndex: 1, sentence: c.sentence ?? "" }], [{ slotIndex: 1, shot: shotOf(c.capture), pose: c.pose }]);
      return answer.ok ? [] : [`${c.where}: ${answer.problems.join(",")}: ${c.sentence}`];
    });
    expect(refused).toEqual([]);
  }, 30_000);

  test("passes the assembler's last gate", () => {
    const sentences = [...new Set(CASES.map((c) => c.sentence ?? ""))];
    expect(sentences.filter((s) => sentenceProblems(s).length > 0)).toEqual([]);
  }, 30_000);

  test("never names a camera or a lens, nor looks «into the phone» (the gaze gate S5.6d adds)", () => {
    expect(CASES.filter((c) => /\b(camera|lens)\b|into the phone/i.test(c.sentence ?? "")).map((c) => c.sentence)).toEqual([]);
  });

  test("a frame whose face does not show (the phone over it, from behind) carries no gaze and no cue", () => {
    const hidden = CASES.filter((c) => faceVisibleOf({ capture: c.capture, pose: c.pose }) === "no");
    expect(hidden.length).toBeGreaterThan(1000);
    for (const c of hidden) {
      for (const gaze of GAZE) expect(c.sentence).not.toContain(`, ${gaze.text}`);
      for (const cue of CUES) expect(c.sentence).not.toContain(`, ${cue.text}`);
    }
  });

  test("a hand-held capture never carries the gaze on her hands", () => {
    const hands = GAZE.filter((g) => g.kind === "hands").map((g) => g.text);
    expect(CASES.filter((c) => isHandCapture(c.capture) && hands.some((h) => (c.sentence ?? "").includes(h))).map((c) => c.sentence)).toEqual([]);
  });

  test("the reader's gates are live (negative controls)", () => {
    const viewerFromBehind = "On a park path, she walks along the path, wearing a denim jacket and jeans, looking straight at the viewer.";
    expect(readWriterScenes([{ slotIndex: 1, sentence: viewerFromBehind }], [{ slotIndex: 1, shot: "friend", pose: "back" }]).ok).toBe(false);
    const phoneInSelfie = "On her bed, she laughs at something on her phone, wearing silk pajamas.";
    expect(readWriterScenes([{ slotIndex: 1, sentence: phoneInSelfie }], [{ slotIndex: 1, shot: "selfie", pose: "front" }]).ok).toBe(false);
  });
});

test("the poses a capture is checked at are the ones it can take", () => {
  for (const capture of new Set(CASES.map((c) => c.capture))) expect(posesFor(capture)).toEqual(capture === "over-shoulder" ? ["three-quarter"] : isHandCapture(capture) ? ["front", "three-quarter"] : [...POSES_ALL]);
});
