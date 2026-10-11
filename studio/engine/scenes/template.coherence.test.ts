import { describe, expect, test } from "bun:test";
import { BANKS, CUES, GAZE } from "../../shared/scenes/banks";
import { BANK_CATEGORIES, type BankCategory, type BankPlace, type Level } from "../../shared/scenes/banks/types";
import { momentAllowed, templateSentence } from "../../shared/scenes/template";
import { sentenceProblems } from "./assembler";
import { PoseSchema } from "./schema";
import { SHOTS } from "./types";
import { readWriterScenes } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6a, I5.23 «coherent by construction»): every combination a built-in slot can draw renders, and its sentence passes the gates the LLM
// writer's sentences pass (readWriterScenes: youth and revealing words, a two-handed action on a hand-held shot, a pose contradiction, a phone or
// «selfie» in a selfie) and the assembler's last gate. So the face gate never pays a retry for our own contradiction, and a built-in plan never needs
// the planner's fallback (every place has a moment for every shot and pose it can draw).

const POSES = PoseSchema.options;
const KEYS = Array.from({ length: 6 }, (_, i) => `run-${i}:slot-${i + 1}`);
const LEVELS: readonly Level[] = ["ordinary", "flirty"];

/** The shots a slot at this place can draw: the deck's, with a mirror only on a mirror place. */
function shotsAt(category: BankCategory, place: BankPlace) {
  return SHOTS.filter((shot) => BANKS[category].shotDeck.includes(shot) && (shot !== "mirror" || place.mirror === true));
}

const posesFor = (shot: string) => (shot === "selfie" || shot === "mirror" ? POSES.filter((p) => p === "front" || p === "three-quarter") : POSES);

interface Case {
  where: string;
  sentence: string | null;
  shot: (typeof SHOTS)[number];
  pose: (typeof POSES)[number];
}

function drawableCases(): Case[] {
  const out: Case[] = [];
  for (const category of BANK_CATEGORIES) {
    const outfit = BANKS[category].outfits[0] ?? "";
    for (const place of BANKS[category].places) {
      for (const shot of shotsAt(category, place)) {
        for (const pose of posesFor(shot)) {
          for (const level of LEVELS) {
            for (const moment of place.moments.filter((m) => momentAllowed(m, shot, pose, level))) {
              for (const key of KEYS) {
                const sentence = templateSentence({ category, location: place.name, activity: moment.text, outfit, shot, pose }, { key, level });
                out.push({ where: `${category}/${place.name}/${moment.text}/${shot}/${pose}/${level}`, sentence, shot, pose });
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
  test("the sweep is not vacuous", () => {
    expect(CASES.length).toBeGreaterThan(5000);
  });

  test("renders (built-in categories are always covered)", () => {
    expect(CASES.filter((c) => c.sentence === null).map((c) => c.where)).toEqual([]);
  });

  test("passes the writer's answer reader for its shot and pose", () => {
    const refused = CASES.flatMap((c) => {
      const answer = readWriterScenes([{ slotIndex: 1, sentence: c.sentence ?? "" }], [{ slotIndex: 1, shot: c.shot, pose: c.pose }]);
      return answer.ok ? [] : [`${c.where}: ${answer.problems.join(",")}: ${c.sentence}`];
    });
    expect(refused).toEqual([]);
  });

  test("passes the assembler's last gate", () => {
    expect(CASES.filter((c) => sentenceProblems(c.sentence ?? "").length > 0).map((c) => c.where)).toEqual([]);
  });

  test("never names a camera or a lens, nor looks «into the phone» (the gaze gate S5.6d adds)", () => {
    expect(CASES.filter((c) => /\b(camera|lens)\b|into the phone/i.test(c.sentence ?? "")).map((c) => c.sentence)).toEqual([]);
  });

  test("a back pose carries no gaze and no cue", () => {
    const back = CASES.filter((c) => c.pose === "back");
    expect(back.length).toBeGreaterThan(0);
    for (const c of back) {
      for (const gaze of GAZE) expect(c.sentence).not.toContain(`, ${gaze.text}`);
      for (const cue of CUES) expect(c.sentence).not.toContain(`, ${cue.text}`);
    }
  });

  test("a hand-held shot never carries «her eyes on what her hands are doing»", () => {
    const hands = GAZE.filter((g) => g.kind === "hands").map((g) => g.text);
    expect(CASES.filter((c) => (c.shot === "selfie" || c.shot === "mirror") && hands.some((h) => (c.sentence ?? "").includes(h))).map((c) => c.sentence)).toEqual([]);
  });

  test("the reader's gates are live (negative controls)", () => {
    const viewerFromBehind = "On a park path, she walks along the path, wearing a denim jacket and jeans, looking straight at the viewer.";
    expect(readWriterScenes([{ slotIndex: 1, sentence: viewerFromBehind }], [{ slotIndex: 1, shot: "friend", pose: "back" }]).ok).toBe(false);
    const phoneInSelfie = "In her small kitchen, she laughs at something on her phone, wearing a grey lounge set.";
    expect(readWriterScenes([{ slotIndex: 1, sentence: phoneInSelfie }], [{ slotIndex: 1, shot: "selfie", pose: "front" }]).ok).toBe(false);
  });
});

describe("a built-in plan never needs the planner's fallback", () => {
  test.each([...BANK_CATEGORIES])("%s: every place has an ordinary moment for every shot it can draw, at every pose that shot allows", (category) => {
    const empty: string[] = [];
    for (const place of BANKS[category].places) {
      for (const shot of shotsAt(category, place)) {
        for (const pose of posesFor(shot)) if (!place.moments.some((m) => momentAllowed(m, shot, pose))) empty.push(`${place.name}/${shot}/${pose}`);
      }
    }
    expect(empty).toEqual([]);
  });
});
