import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SceneWriteTarget } from "../../shared/engine";
import { COVER } from "../../shared/scenes/banks/companions/outfits";
import { OWN_BOLD_COVERAGE } from "../../shared/scenes/ownScene";
import { writerCallOf } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { ideaJsonSchema, ideaMessages, ideaSystemPrompt, readIdeaAnswer, type IdeaSlot } from "./ideaWriter";
import { plan } from "./planner";
import { POSE_LABEL, SHOT_LABEL, writerMessages, writerRefusalText, type WriterRefusal } from "./writer";
import type { Pose } from "./schema";
import type { Shot } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA9, plan s5a4 §8 BA9, Q-F → 1): «Своя сцена» at «Смелая». An own scene of a «Смелая» set is written by the idea writer's bold variant: the covering rule is replaced, the
// owner's idea is drawn in lingerie (or, for an avatar made in Studio only, under an implied cover), and an imported avatar is told «lingerie at most» and ends with the kept coverage.
// Below «Смелая» the idea writer is byte-identical (the hashes below were taken on 6f3e9308, before BA9).

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
/**
 * The measured margin of the bold variant's honest worst (five 500-character CJK ideas, the worst refusal with the exposure and the implied-cover reasons) under WRITER_BOLD_CALL's 17 000,
 * as built: its floor is 14 506, over the ordinary 14 000 by 506, so the bold variant is priced and reserved as the bold writer call (S5.BA9; S5.BA9 r2 added the implied-cover reason,
 * 2 599 before it).
 */
const BOLD_IDEA_MARGIN = 2_494;
const IMPORTED = { impliedNudity: false } as const;
const STUDIO = { impliedNudity: true } as const;
const ORDINARY_CLOTHING = "- No revealing clothing (no bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie): whatever the idea says, describe her clothing as covering and non-revealing.";

const IDEA: IdeaSlot = { slotIndex: 5, idea: "в белье на кровати", shot: null, pose: null };
const answer = (...scenes: Record<string, unknown>[]): string => JSON.stringify({ scenes });
const LINGERIE = "She lies across her bed in a black lace bra and panties, propped on one elbow, her other hand resting on the pillow as she smiles at the viewer.";
const SECOND: IdeaSlot = { slotIndex: 6, idea: "в белье на кровати", shot: null, pose: null };
const GOOD_SECOND = { slotIndex: 6, sentence: "She sits on the edge of her bed in a white lingerie set, one hand in her hair, a glass of water on the nightstand.", shot: "friend", pose: "three-quarter" };

describe("the idea writer below «Смелая» is byte-identical (S5.BA9)", () => {
  test("the system prompt without and with the mirror hashes as it did before BA9", () => {
    expect(sha(ideaSystemPrompt(false))).toBe("d1504f5a29f27e16b6157abb625f3a565ca0f9f58f8ddf7a0125d35eaa7c8918");
    expect(sha(ideaSystemPrompt(true))).toBe("dc4d4f28b2842c4785ba39028b7fcf0af7a077e0f4fb945ea4bed425250370d9");
  });

  test("the messages of an ordinary write carry that very prompt", () => {
    expect(ideaMessages([IDEA])[0]?.content).toBe(ideaSystemPrompt(false));
    expect(ideaMessages([IDEA], undefined, true)[0]?.content).toBe(ideaSystemPrompt(true));
  });

  test("an ordinary read still refuses lingerie as a revealing word and appends nothing", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: LINGERIE, shot: "friend", pose: "front" }), [IDEA])).toMatchObject({ ok: false, problems: ["revealing-word"], wordSlots: [5] });
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: "She sits on her balcony with a cup of coffee, one hand on the railing, smiling at the viewer.", shot: "friend", pose: "front" }), [IDEA]);
    expect(read.ok && read.sentences.get(5)).toBe("She sits on her balcony with a cup of coffee, one hand on the railing, smiling at the viewer.");
  });
});

describe("the bold variant's prompt (S5.BA9)", () => {
  test.each([
    ["imported", IMPORTED],
    ["Studio-created", STUDIO],
  ] as const)("for an %s avatar it replaces the covering rule and keeps every other line of the ordinary prompt", (_name, bold) => {
    for (const mirrorAllowed of [false, true]) {
      const ordinary = ideaSystemPrompt(mirrorAllowed).split("\n");
      const prompt = ideaSystemPrompt(mirrorAllowed, bold);
      expect(prompt).not.toContain("covering and non-revealing");
      expect(prompt).not.toContain(ORDINARY_CLOTHING);
      const lines = prompt.split("\n");
      for (const line of ordinary.filter((l) => l !== ORDINARY_CLOTHING)) expect(lines).toContain(line);
    }
  });

  test("it keeps the compose prompt's standing rules line for line, the adult rule among them", () => {
    const compose = (writerMessages(plan({ seed: 1, count: 1, categories: ["home"] }).slots)[0]?.content ?? "").split("\n");
    const standing = compose.filter((line) => /^You write|^Reference images|only one hand is free|Match each slot|grown adult|^- No text|^- Never write about|^- When she looks|^- No paper|^- Never describe mess|^- Never use these words/.test(line));
    expect(standing.length).toBe(11);
    for (const bold of [IMPORTED, STUDIO]) for (const line of standing) expect(ideaSystemPrompt(false, bold).split("\n")).toContain(line);
    for (const bold of [IMPORTED, STUDIO]) expect(ideaSystemPrompt(false, bold)).toContain("She is a grown adult woman; no children or minors anywhere in the scene");
  });

  test("it draws the owner's idea bold: in lingerie, a lingerie set when the idea names no outfit, other garments worn open over it", () => {
    for (const bold of [IMPORTED, STUDIO]) {
      const prompt = ideaSystemPrompt(false, bold);
      expect(prompt).toContain("she wears lingerie or underwear, a short nightdress or, by the water, swimwear");
      expect(prompt).toContain("when it names no outfit she wears a lingerie set");
    }
  });

  test("it keeps her in a private place: her home, her hotel room, her own balcony, or by the water", () => {
    for (const bold of [IMPORTED, STUDIO]) {
      const prompt = ideaSystemPrompt(false, bold);
      expect(prompt).toContain("She is somewhere private of hers: her home, her hotel room, her own balcony or terrace, or by the water.");
      expect(prompt).toContain("When the idea names a public place, set the moment in her room nearby, before or after it.");
    }
  });

  test("it never asks for the exposure words Seedream refuses, nor the youth word «tiny»", () => {
    for (const bold of [IMPORTED, STUDIO]) {
      const prompt = ideaSystemPrompt(false, bold);
      expect(prompt).toContain("Never write naked, nude, topless, nipples, see-through, transparent or sheer");
      expect(prompt).toContain('never "tiny" or "little"');
    }
  });

  test("for an imported avatar it says «lingerie at most» and allows no implied cover", () => {
    const prompt = ideaSystemPrompt(false, IMPORTED);
    expect(prompt).toContain("She wears lingerie at most, whatever the idea says: never only a towel, a sheet, bath foam or her hands over her.");
    expect(prompt).not.toContain("she may wear only");
  });

  test("for an avatar made in Studio it allows the implied cover when the idea asks for less, and never less than it", () => {
    const prompt = ideaSystemPrompt(false, STUDIO);
    expect(prompt).toContain("When the idea asks for less, she may wear only a towel wrapped around her, a sheet pulled up to her chest or bath foam, never less.");
    expect(prompt).not.toContain("lingerie at most");
  });

  test("the bold messages carry the bold prompt and the very user message an ordinary write sends", () => {
    for (const bold of [IMPORTED, STUDIO]) {
      for (const mirrorAllowed of [false, true]) {
        const messages = ideaMessages([IDEA], undefined, mirrorAllowed, bold);
        expect(messages[0]?.content).toBe(ideaSystemPrompt(mirrorAllowed, bold));
        expect(messages[1]).toEqual(ideaMessages([IDEA], undefined, mirrorAllowed)[1]);
      }
    }
  });
});

describe("the bold variant's reader (S5.BA9)", () => {
  test("«в белье на кровати» written in lingerie is accepted at «Смелая»", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: LINGERIE, shot: "friend", pose: "front" }), [IDEA], false, STUDIO);
    expect(read.ok && read.sentences.get(5)).toBe(LINGERIE);
    expect(read.ok && read.angles.get(5)).toEqual({ shot: "friend", pose: "front" });
  });

  test("an imported avatar's accepted sentence ends with the kept coverage, once", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: LINGERIE, shot: "friend", pose: "front" }), [IDEA], false, IMPORTED);
    expect(read.ok && read.sentences.get(5)).toBe(`${LINGERIE} ${OWN_BOLD_COVERAGE}`);
  });

  test("a sentence without its full stop gets one before the coverage", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: LINGERIE.slice(0, -1), shot: "friend", pose: "front" }), [IDEA], false, IMPORTED);
    expect(read.ok && read.sentences.get(5)).toBe(`${LINGERIE} ${OWN_BOLD_COVERAGE}`);
  });

  test("an avatar made in Studio gets no coverage appended: the idea is drawn as the owner wrote it", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: LINGERIE, shot: "friend", pose: "front" }), [IDEA], false, STUDIO);
    expect(read.ok && read.sentences.get(5)?.endsWith(OWN_BOLD_COVERAGE)).toBe(false);
  });

  test.each(["topless", "naked", "nude", "see-through bra"])("an exposure word («%s») is refused for its scene alone, and the other scene is kept with its coverage", (word) => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: `She lies across her bed ${word}, one hand on the pillow.`, shot: "friend", pose: "front" }, GOOD_SECOND), [IDEA, SECOND], false, IMPORTED);
    expect(read).toMatchObject({ ok: false, problems: ["exposure-word"], boldSlots: { "exposure-word": [5] } });
    if (read.ok) throw new Error("expected a refusal");
    expect(read.repair?.marked).toEqual([5]);
    expect(read.repair?.accepted).toEqual(new Map([[6, `${GOOD_SECOND.sentence} ${OWN_BOLD_COVERAGE}`]]));
    expect(read.repair?.angles).toEqual(new Map([[6, { shot: "friend", pose: "three-quarter" }]]));
  });

  // S5.BA9 r2 (review M1): «lingerie at most» is held in code for an imported avatar (or one of unknown origin), not by the prompt alone. A frame that only a towel, a sheet or bath foam
  // covers is refused for its scene (`implied-cover`) and asked again once, as an exposure word is; a sentence that names lingerie or swimwear beside one is a lingerie frame.
  const COVER_ONLY = [
    ["a towel", "She sits on the edge of her bathtub wrapped in a white towel, one hand in her wet hair, smiling at the viewer."],
    ["a sheet", "She lies in her bed with the white sheet pulled up to her chest, one hand under her cheek, smiling at the viewer."],
    ["bath foam", "She lies back in her bath under thick foam, one hand resting on the rim, smiling at the viewer."],
  ] as const;

  test.each(COVER_ONLY)("an imported avatar's sentence covered by %s alone is refused for its scene (implied-cover), and the other scene is kept with its coverage", (_cover, sentence) => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence, shot: "friend", pose: "front" }, GOOD_SECOND), [IDEA, SECOND], false, IMPORTED);
    expect(read).toMatchObject({ ok: false, problems: ["implied-cover"], boldSlots: { "implied-cover": [5] } });
    if (read.ok) throw new Error("expected a refusal");
    expect(read.repair?.marked).toEqual([5]);
    expect(read.repair?.accepted).toEqual(new Map([[6, `${GOOD_SECOND.sentence} ${OWN_BOLD_COVERAGE}`]]));
  });

  test.each([
    ["lingerie", "She stands in her bathroom in a white lace bra and panties, a towel over her shoulder, smiling at the viewer."],
    ["swimwear", "She lies on a striped towel by the pool in a black bikini, one hand shading her eyes."],
    ["a nightdress", "She sits on her bed in a short nightdress, the sheet bunched at her feet, smiling at the viewer."],
  ])("an imported avatar's sentence that names %s beside the cover is a lingerie frame: kept, with the kept coverage", (_garment, sentence) => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence, shot: "friend", pose: "front" }), [IDEA], false, IMPORTED);
    expect(read.ok && read.sentences.get(5)).toBe(`${sentence} ${OWN_BOLD_COVERAGE}`);
  });

  // S5.BA9 r2 (review M2, I5.74, banks/schema.ts open-coverage: «an implied cover says what covers her to every avatar»): an avatar made in Studio may be covered by one alone, and the
  // sentence then ends with the bank's sentence of that cover, as the bank's own towel, sheet and foam moments end: the towel's open one, the sheet's and the foam's kept ones.
  const STUDIO_COVER = [
    [COVER_ONLY[0][0], COVER_ONLY[0][1], COVER.towelOpen],
    [COVER_ONLY[1][0], COVER_ONLY[1][1], COVER.sheet],
    [COVER_ONLY[2][0], COVER_ONLY[2][1], COVER.foam],
  ] as const;

  test.each(STUDIO_COVER)("an avatar made in Studio may be covered by %s alone: the sentence is kept and ends with that cover's sentence", (_cover, sentence, coverage) => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence, shot: "friend", pose: "front" }), [IDEA], false, STUDIO);
    expect(read.ok && read.sentences.get(5)).toBe(`${sentence} ${coverage}`);
  });

  test("an avatar made in Studio's sentence that names two covers ends with the sentence of the one it names first", () => {
    const sentence = "She lies in her bed under the white sheet, a towel wrapped around her hair, smiling at the viewer.";
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence, shot: "friend", pose: "front" }), [IDEA], false, STUDIO);
    expect(read.ok && read.sentences.get(5)).toBe(`${sentence} ${COVER.sheet}`);
  });

  test("an avatar made in Studio's sentence that names lingerie beside a towel is a lingerie frame: nothing is appended", () => {
    const sentence = "She stands in her bathroom in a white lace bra and panties, a towel over her shoulder, smiling at the viewer.";
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence, shot: "friend", pose: "front" }), [IDEA], false, STUDIO);
    expect(read.ok && read.sentences.get(5)).toBe(sentence);
  });

  test("a youth word still refuses the whole answer, as at every level (the age guard is unchanged)", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: "A teenage girl lies on a bed in a lace bra.", shot: "friend", pose: "front" }, GOOD_SECOND), [IDEA, SECOND], false, STUDIO);
    expect(read).toMatchObject({ ok: false, problems: ["youth-word"] });
    if (read.ok) throw new Error("expected a refusal");
    expect(read.repair).toBeUndefined();
  });

  test("«tiny» is a youth word at «Смелая» too", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: "She lies on her bed in a tiny lace thong, smiling.", shot: "friend", pose: "front" }), [IDEA], false, STUDIO)).toMatchObject({ ok: false, problems: ["youth-word"] });
  });

  test("the owner's denim ban and the angle rules hold at «Смелая»", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: "She sits on her bed in a lace bra and a denim skirt.", shot: "friend", pose: "front" }), [IDEA], false, STUDIO)).toMatchObject({ ok: false, problems: ["revealing-word"], words: ["denim skirt"] });
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: LINGERIE, shot: "selfie", pose: "back" }), [IDEA], false, STUDIO)).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [5] });
  });
});

describe("the bold variant's floor (S5.BA9): it is priced as the bold writer call", () => {
  const ORDINARY_CEILING = writerCallOf("ordinary").inputTokens;
  const CEILING = writerCallOf("bold").inputTokens;
  const MARGIN = 200;
  const hostileWords = Array.from({ length: 40 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return [`${"W".repeat(12)}${n}`, `${"Я".repeat(6)}${n}`, `${"😀".repeat(3)}${n}`, `${"é".repeat(6)}${n}`];
  }).flat();
  const IDEA_IDS = [9_992, 9_994, 9_996, 9_998, 10_000];
  /** The ordinary worst refusal, plus the two problems only the bold variant raises (an exposure word, and S5.BA9 r2 an imported avatar's implied cover), naming every scene. */
  const worstRefusal = (indices: readonly number[]): WriterRefusal => ({
    problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction", "phone-in-selfie", "bad-angle", "exposure-word", "implied-cover"],
    missingSlots: [...indices],
    twoHandedSlots: [...indices],
    wordSlots: [...indices],
    poseSlots: [...indices],
    angleSlots: [...indices],
    phoneSlots: [...indices],
    boldSlots: { "exposure-word": [...indices], "implied-cover": [...indices] },
    words: hostileWords,
  });

  test("the worst refusal tells every reason the bold variant can raise, each with its scenes", () => {
    const text = writerRefusalText(worstRefusal(IDEA_IDS));
    for (const problem of ["exposure-word", "implied-cover"] as const) {
      expect(text).toContain(writerRefusalText({ problems: [problem], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [], boldSlots: { [problem]: [...IDEA_IDS] } }));
      expect(text).not.toContain(`; ${problem}`);
    }
  });

  /** The dearest bold write for `idea`, by the ordinary floor's own walk: every shot against every pose, with and without the mirror, as a rewrite and on «Авто», for both origins. */
  function worstFloor(idea: string): number {
    const refusal = worstRefusal(IDEA_IDS);
    const floors: number[] = [];
    for (const bold of [IMPORTED, STUDIO]) {
      for (const mirrorAllowed of [false, true]) {
        const asked: IdeaSlot[] = IDEA_IDS.map((slotIndex) => ({ slotIndex, idea, shot: null, pose: null }));
        floors.push(promptTokenFloor({ messages: ideaMessages(asked, refusal, mirrorAllowed, bold), jsonSchema: ideaJsonSchema(mirrorAllowed), images: 0 }));
        for (const shot of Object.keys(SHOT_LABEL) as Shot[]) {
          for (const pose of Object.keys(POSE_LABEL) as Pose[]) {
            const given: IdeaSlot[] = IDEA_IDS.map((slotIndex) => ({ slotIndex, idea, shot, pose }));
            floors.push(promptTokenFloor({ messages: ideaMessages(given, refusal, mirrorAllowed, bold), jsonSchema: ideaJsonSchema(mirrorAllowed, { shot: false, pose: false }), images: 0 }));
          }
        }
      }
    }
    return Math.max(...floors);
  }

  test("the heaviest idea the contract lets through stays at least 200 tokens under the bold call's 17K ceiling with the worst refusal", () => {
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "中".repeat(500), count: 5, shot: null }).success).toBe(true);
    const floor = worstFloor("中".repeat(500));
    expect(floor).toBeLessThanOrEqual(CEILING - MARGIN);
    // As built (S5.BA9): re-measure it when the bold idea prompt or a refusal text changes.
    expect(CEILING - floor).toBe(BOLD_IDEA_MARGIN);
  });

  test("it does not fit the ordinary 14K ceiling with the ordinary margin: so the bold variant is priced and reserved as the bold call", () => {
    expect(worstFloor("中".repeat(500))).toBeGreaterThan(ORDINARY_CEILING - MARGIN);
  });
});
