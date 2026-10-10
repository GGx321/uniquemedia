import { describe, expect, test } from "bun:test";
import { youthWords } from "../../shared/engine";
import { estimateRun, WRITER_CALL, type RunPlanInput } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { promptTokenFloor } from "../openrouter/chat";
import { POOL_TIMES } from "../../shared/engine";
import { lightOf } from "./phoneLook";
import { CATEGORIES } from "./types";
import { plan } from "./planner";
import type { PlanSlot } from "./schema";
import {
  chunkSlots,
  contradictsPose,
  emptyAnswerRefusal,
  isTwoHanded,
  POSE_LABEL,
  readWriterAnswer,
  revealingWordsIn,
  SHOT_LABEL,
  writerMessages,
  writerRefusalText,
  writerRunPrice,
  WRITER_JSON_SCHEMA,
  type WriterOutput,
  type WriterProblem,
  type WriterRefusal,
} from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T5b: the scene writer's pure logic (prompts, the model's output schema, the
// re-ask detectors and the writer's own pricing). No I/O, no money, no
// network: those live in runs/writerPhase.rules.test.ts.

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: "home",
    location: "a bright kitchen",
    timeOfDay: "morning",
    activity: "holding a ceramic coffee mug",
    outfit: "a plain white t-shirt and cotton shorts",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

function output(scenes: { slotIndex: number; sentence: string }[]): string {
  return JSON.stringify({ scenes });
}

describe("writerMessages", () => {
  test("the system prompt states the one-hand-holds-the-phone rule, full sentences, and no children", () => {
    const [system] = writerMessages([slot()]);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("one");
    expect(system?.content.toLowerCase()).toContain("hand");
    expect(system?.content.toLowerCase()).toContain("full");
    expect(system?.content.toLowerCase()).toContain("no children");
  });

  test("the user message carries only the plan's slot fields, in order, pose included", () => {
    const slots = [
      slot({ slotIndex: 1, category: "home", pose: "front" }),
      slot({ slotIndex: 2, category: "fitness", shot: "selfie", pose: "three-quarter" }),
    ];
    const [, user] = writerMessages(slots);
    expect(user?.role).toBe("user");
    const body = JSON.parse(user?.content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    expect(body).toEqual([
      { slotIndex: 1, category: "Home", location: "a bright kitchen", timeOfDay: "morning daylight", shot: "a phone snap a friend took", pose: "facing the viewer", outfit: "a plain white t-shirt and cotton shorts", activity: "holding a ceramic coffee mug" },
      { slotIndex: 2, category: "Fitness", location: "a bright kitchen", timeOfDay: "morning daylight", shot: "her own front-camera selfie", pose: "a three-quarter view, turned slightly from the viewer", outfit: "a plain white t-shirt and cotton shorts", activity: "holding a ceramic coffee mug" },
    ]);
  });

  test.each([
    ["profile", "in profile, her face turned fully to the side"],
    ["back", "from behind, her face not visible"],
  ] as const)("pose %s is labeled for the model as %j", (pose, label) => {
    const [, user] = writerMessages([slot({ pose, shot: "candid" })]);
    const body = JSON.parse(user?.content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    expect(body[0].pose).toBe(label);
  });

  test("the system prompt tells the model to match each slot's pose, naming back and profile phrasing", () => {
    const [system] = writerMessages([slot()]);
    expect(system?.content.toLowerCase()).toContain("pose");
    expect(system?.content.toLowerCase()).toContain("behind");
    expect(system?.content.toLowerCase()).toContain("profile");
  });

  test("with no refusal, the user message names no earlier rejection", () => {
    const [, user] = writerMessages([slot()]);
    expect(user?.content).not.toContain("rejected");
  });

  test("a refusal is fed back as fixed reasons, in the next message", () => {
    const [, user] = writerMessages([slot()], { problems: ["two-handed"], missingSlots: [], twoHandedSlots: [1], wordSlots: [], words: [], poseSlots: [] });
    expect(user?.content).toContain("rejected");
    expect(user?.content).toContain("1");
  });
});

describe("readWriterAnswer", () => {
  const SLOTS = [slot({ slotIndex: 1, shot: "selfie" }), slot({ slotIndex: 2, shot: "friend" })];
  const GOOD_SELFIE = "She holds her phone in one hand and brushes a loose strand of hair back with the other, smiling softly at her reflection.";
  const GOOD_FRIEND = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

  test("a valid answer with one sentence per slot is read as the sentences", () => {
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: GOOD_FRIEND }]), SLOTS);
    expect(answer).toEqual({ ok: true, sentences: new Map([[1, GOOD_SELFIE], [2, GOOD_FRIEND]]) });
  });

  test("content that is not JSON is refused as not-json", () => {
    const answer = readWriterAnswer("not json at all", SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["not-json"] });
  });

  test("content that does not match the schema is refused as not-json", () => {
    const answer = readWriterAnswer(JSON.stringify({ scenes: [{ slotIndex: 1, sentence: "" }, { slotIndex: 2, sentence: GOOD_FRIEND }] }), SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["not-json"] });
  });

  test("a missing slot is refused, naming it", () => {
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: GOOD_SELFIE }]), SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["missing-slots"], missingSlots: [2] });
  });

  test("an unknown slot index is refused", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: GOOD_FRIEND }, { slotIndex: 99, sentence: GOOD_FRIEND }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["unknown-slot"] });
  });

  test("a duplicated slot index is refused", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: GOOD_FRIEND }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["duplicate-slot"] });
  });

  test("a two-handed action in a selfie slot is refused, naming the slot", () => {
    const twoHanded = "She raises her phone for a selfie, holding a cup of coffee with both hands, glancing warmly at the camera.";
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: twoHanded }, { slotIndex: 2, sentence: GOOD_FRIEND }]), SLOTS);
    expect(answer).toMatchObject({ ok: false, problems: ["two-handed"], twoHandedSlots: [1] });
  });

  test("the same two-handed wording in a non-selfie, non-mirror slot is not flagged", () => {
    const twoHanded = "A friend photographs her holding a cup of coffee with both hands at the kitchen counter.";
    const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: twoHanded }]), SLOTS);
    expect(answer).toMatchObject({ ok: true });
  });

  test("a youth word is refused, naming the word and the slot", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: "A young girl laughs in the kitchen." }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["youth-word"], wordSlots: [2] });
    if (!answer.ok) expect(answer.words.length).toBeGreaterThan(0);
  });

  test("a revealing word is refused, naming the word and the slot", () => {
    const answer = readWriterAnswer(
      output([{ slotIndex: 1, sentence: GOOD_SELFIE }, { slotIndex: 2, sentence: "She lounges by the pool in a bikini, laughing." }]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false, problems: ["revealing-word"], wordSlots: [2] });
    if (!answer.ok) expect(answer.words.map((w) => w.toLowerCase())).toContain("bikini");
  });

  test("several problems across slots are all reported at once, deduplicated", () => {
    const answer = readWriterAnswer(
      output([
        { slotIndex: 1, sentence: "She raises her phone for a selfie, holding a mug with both hands." },
        { slotIndex: 2, sentence: "A young girl in a bikini laughs in the kitchen." },
      ]),
      SLOTS,
    );
    expect(answer).toMatchObject({ ok: false });
    if (answer.ok) throw new Error("expected a refusal");
    const expectedProblems: WriterProblem[] = ["revealing-word", "two-handed", "youth-word"];
    expect([...answer.problems].sort()).toEqual(expectedProblems.sort());
    expect(answer.twoHandedSlots).toEqual([1]);
    expect(answer.wordSlots).toEqual([2]);
  });

  describe("a sentence that contradicts its slot's pose (T5c)", () => {
    const BACK_SLOTS = [slot({ slotIndex: 1, shot: "friend", pose: "back" }), slot({ slotIndex: 2, shot: "friend", pose: "front" })];
    const PROFILE_SLOTS = [slot({ slotIndex: 1, shot: "candid", pose: "profile" })];

    test("a back pose whose sentence says she looks at the camera is refused, naming the slot", () => {
      const answer = readWriterAnswer(
        output([
          { slotIndex: 1, sentence: "She walks away down the hallway, looking at the camera over her shoulder as the light fades." },
          { slotIndex: 2, sentence: GOOD_FRIEND },
        ]),
        BACK_SLOTS,
      );
      expect(answer).toMatchObject({ ok: false, problems: ["pose-contradiction"], poseSlots: [1] });
    });

    test("a profile pose whose sentence has her smiling at the camera is refused", () => {
      const answer = readWriterAnswer(output([{ slotIndex: 1, sentence: "She stands by the window, smiling at the camera in the evening light." }]), PROFILE_SLOTS);
      expect(answer).toMatchObject({ ok: false, problems: ["pose-contradiction"], poseSlots: [1] });
    });

    test("a back pose with no camera-facing language passes", () => {
      const answer = readWriterAnswer(
        output([
          { slotIndex: 1, sentence: "She walks away down the hallway, her hair catching the light as the door closes ahead of her." },
          { slotIndex: 2, sentence: GOOD_FRIEND },
        ]),
        BACK_SLOTS,
      );
      expect(answer).toMatchObject({ ok: true });
    });

    test("the same camera-facing wording on a front-pose slot is not flagged", () => {
      const answer = readWriterAnswer(
        output([
          { slotIndex: 1, sentence: GOOD_FRIEND },
          { slotIndex: 2, sentence: "She looks at the camera and smiles warmly in the kitchen light." },
        ]),
        BACK_SLOTS,
      );
      expect(answer).toMatchObject({ ok: true });
    });
  });
});

describe("detectors", () => {
  test.each([
    ["holding a cup of coffee with both hands", true],
    ["her hands pulling her ponytail tighter", true],
    ["each hand gripping a strap of her backpack", true],
    ["using both hands to adjust her hair", true],
    ["holds her phone in one hand and waves with the other", false],
    ["a relaxed half-smile, her free hand resting on the counter", false],
    ["she smiles softly at the camera", false],
    // Review round 1 (MEDIUM): a free 40-char proximity window let "holding"
    // match even though it belongs to "her other hand", not to "hands" —
    // false positive that would have burned both paid attempts.
    ["She takes a mirror selfie, her hands neatly manicured, holding the phone with her other hand and smiling softly.", false],
    // Review round 1 (LOW/MEDIUM): past tense and typing/texting/carrying were missing.
    ["Her hands adjusted the strap of her bag before she smiled for the mirror.", true],
    ["She glances at the screen, her hands typing quickly on the counter.", true],
    ["her hands held the railing tightly as she posed", true],
    ["her hands carried the tray steadily", true],
  ])("isTwoHanded(%j) -> %p", (sentence, expected) => {
    expect(isTwoHanded(sentence)).toBe(expected);
  });

  test.each([
    ["she wears a bikini at the pool", ["bikini"]],
    ["a lace lingerie set and heels", ["lingerie"]],
    ["a sports bra and running shorts", ["sports bra"]],
    ["an oversized cream sweater", []],
  ])("revealingWordsIn(%j) -> %p", (sentence, expected) => {
    expect(revealingWordsIn(sentence).map((w) => w.toLowerCase())).toEqual(expected);
  });

  test.each([
    ["back", "she looks at the camera and smiles.", true],
    ["back", "gazing toward the camera as she turns.", true],
    ["profile", "she smiles at the camera.", true],
    ["back", "her hair catches the light as she walks away.", false],
    ["front", "she looks at the camera and smiles.", false],
    ["three-quarter", "she glances at the camera.", false],
    // Round 2 review (MEDIUM): natural phrasings with a gaze verb and the
    // camera separated by a short aside (e.g. "over her shoulder") were
    // false negatives — a paid attempt could slip through describing exactly
    // what the pose forbids.
    ["back", "she walks away, looking over her shoulder at the camera as the door closes.", true],
    ["back", "she glances back toward the camera over her shoulder before stepping out.", true],
    ["back", "she looks directly at the camera over her shoulder as she leaves.", true],
    ["back", "she peers at the camera from over her shoulder in the doorway.", true],
    ["profile", "she peers at the camera from over her shoulder as she waits.", true],
    // A false positive costs a paid retry, so the gap must stay bounded and
    // must not fire on an unrelated mention of "camera" far from any gaze verb.
    ["back", "the camera sits on a tripod behind her as she walks toward the window.", false],
    ["back", "she looks over her shoulder at the doorway, while the camera sits on a tripod across the room.", false],
    // Round 3 review: a negated gaze verb is a perfectly compliant sentence
    // for a back/profile pose ("not looking at the camera" IS the pose), but
    // it contains the bare substring "looking at the camera" and self-
    // triggered before this fix — a false positive that burns a paid retry
    // on an answer that was already correct.
    ["back", "She is not looking at the camera, focused on the horizon instead.", false],
    ["profile", "She is not looking at the camera, focused on the horizon instead.", false],
    ["back", "She isn't looking at the camera as she walks away.", false],
    ["back", "She never looks at the camera in this shot.", false],
    ["back", "She walks off without looking at the camera.", false],
    ["back", "She is no longer looking at the camera by the time she reaches the door.", false],
    ["profile", "She isn't gazing toward the camera at all.", false],
    // Negation must not blunt the real catch: an over-the-shoulder gaze at
    // the camera is still a violation even in a sentence that also contains
    // an unrelated negation elsewhere.
    ["back", "She isn't holding anything, but she looks over her shoulder at the camera as the door closes.", true],
    // S5.1b review: the viewer, the phone and the lens are the same forbidden gaze for a back or profile pose.
    ["back", "she looks over her shoulder at the viewer as she leaves.", true],
    ["profile", "she glances toward the viewer with a small smile.", true],
    // Her own phone is the slot's activity, not a gaze at the viewer: it must not cost a paid retry.
    ["back", "she looks down at the phone in her hand and walks away.", false],
    ["profile", "she looks at the phone in her hand, smiling.", false],
    ["profile", "she smiles into the lens.", true],
    ["profile", "she is not looking at the viewer, her eyes on the window.", false],
    ["front", "she looks at the viewer and laughs.", false],
  ] as const)("contradictsPose(%j, %j) -> %p", (pose, sentence, expected) => {
    expect(contradictsPose(sentence, pose)).toBe(expected);
  });
});

// Round 2 review (LOW): SHOT_LABEL and POSE_LABEL are engine-authored text
// sent straight into the writer's own prompt, exactly like the pool text in
// pools.ts — so they must pass the same youth/revealing checks.
describe("phrase constants never suggest a minor or use a revealing word (round 2, LOW)", () => {
  function allPhrases(): [string, string][] {
    return [
      ...Object.entries(SHOT_LABEL).map(([k, v]): [string, string] => [`SHOT_LABEL.${k}`, v]),
      ...Object.entries(POSE_LABEL).map(([k, v]): [string, string] => [`POSE_LABEL.${k}`, v]),
    ];
  }

  test.each(allPhrases())("%s has no youth word and no revealing word", (_name, text) => {
    expect(youthWords(text, "descriptor")).toEqual([]);
    expect(revealingWordsIn(text)).toEqual([]);
  });
});

// S5.1c: the writer is told never to write about the camera and to say she looks at the viewer, so the pose labels it reads speak of the viewer too.
describe("POSE_LABEL speaks of the viewer, never the camera", () => {
  test("no pose label names the camera, the lens or the photographer", () => {
    for (const label of Object.values(POSE_LABEL)) expect(label).not.toMatch(/camera|lens|photographer/i);
  });

  test("the front and three-quarter labels are worded around the viewer", () => {
    expect(POSE_LABEL.front).toBe("facing the viewer");
    expect(POSE_LABEL["three-quarter"]).toBe("a three-quarter view, turned slightly from the viewer");
  });
});

describe("emptyAnswerRefusal (the one refusal a paid answer without content gets, T6)", () => {
  test("names only the empty problem, with every other list empty, and says so to the next attempt", () => {
    const refusal = emptyAnswerRefusal();
    expect(refusal).toEqual({ problems: ["empty"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [] });
    expect(writerRefusalText(refusal)).toBe("it was empty");
  });

  test("is fresh every time: a caller that changes one cannot change the next", () => {
    const first = emptyAnswerRefusal();
    first.problems.push("not-json");
    expect(emptyAnswerRefusal().problems).toEqual(["empty"]);
  });
});

describe("writerRefusalText", () => {
  test("names the two-handed slots and the rule", () => {
    const text = writerRefusalText({ problems: ["two-handed"], missingSlots: [], twoHandedSlots: [3], wordSlots: [], words: [], poseSlots: [] });
    expect(text).toContain("3");
    expect(text.toLowerCase()).toContain("hand");
  });

  test("never repeats the model's own rejected words back verbatim, only our fixed reasons", () => {
    const text = writerRefusalText({ problems: ["youth-word"], missingSlots: [], twoHandedSlots: [], wordSlots: [2], words: ["girl"], poseSlots: [] });
    expect(text).toContain("girl");
    expect(text).not.toContain("laughs in the kitchen");
  });

  test("names the pose-contradiction slots and the rule", () => {
    const text = writerRefusalText({ problems: ["pose-contradiction"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [4] });
    expect(text).toContain("4");
    expect(text.toLowerCase()).toContain("pose");
  });
});

describe("chunkSlots", () => {
  function slotsOf(count: number): PlanSlot[] {
    return Array.from({ length: count }, (_, i) => slot({ slotIndex: i + 1 }));
  }

  test.each([
    [0, []],
    [1, [1]],
    [WRITER_CALL.slotsPerCall, [WRITER_CALL.slotsPerCall]],
    [WRITER_CALL.slotsPerCall + 1, [WRITER_CALL.slotsPerCall, 1]],
    [2 * WRITER_CALL.slotsPerCall, [WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall]],
    [100, [WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall]],
  ])("%i slots -> chunk sizes %j", (count, sizes) => {
    expect(chunkSlots(slotsOf(count)).map((c) => c.length)).toEqual(sizes);
  });

  test("keeps every slot's order, split by position, nothing dropped or duplicated", () => {
    const all = slotsOf(2 * WRITER_CALL.slotsPerCall + 7);
    const chunks = chunkSlots(all);
    expect(chunks.flat()).toEqual(all);
  });
});

describe("writerRunPrice", () => {
  // Review round 2/3: RunRequest.count allows up to 100 slots, so the writer
  // job makes ceil(slotCount / WRITER_CALL.slotsPerCall) calls, each retried
  // up to WRITER_CALL.maxAttempts times before the job gives up on it; the
  // worst case is chunks × maxAttempts × the per-call ceiling (review round
  // 3: a flat one-call, one-attempt ceiling priced this too low).
  test("the worst case is chunks × maxAttempts × the per-call ceiling", () => {
    // T5c round 2: the per-call ceiling rose from 35_000 to 37_500
    // (WRITER_CALL.inputTokens 12_000 -> 14_000); every figure below moves
    // with it (2 * 37_500 = 75_000, etc.).
    const book = PriceBook.fallback();
    expect(writerRunPrice(book, 0).worstMicros).toBe(0);
    expect(writerRunPrice(book, 1).worstMicros).toBe(75_000);
    expect(writerRunPrice(book, WRITER_CALL.slotsPerCall).worstMicros).toBe(75_000);
    expect(writerRunPrice(book, WRITER_CALL.slotsPerCall + 1).worstMicros).toBe(150_000);
    expect(writerRunPrice(book, 100).worstMicros).toBe(300_000);
  });

  test("the expected cost scales per scene, at the spike's measured per-scene tokens, unaffected by chunking or attempts", () => {
    const book = PriceBook.fallback();
    expect(writerRunPrice(book, 0).expectedMicros).toBe(0);
    expect(writerRunPrice(book, 1).expectedMicros).toBe(458);
    expect(writerRunPrice(book, 25).expectedMicros).toBe(11_438);
    expect(writerRunPrice(book, 26).expectedMicros).toBe(11_895);
    expect(writerRunPrice(book, 100).expectedMicros).toBe(45_750);
  });

  test("the price source follows the book", () => {
    expect(writerRunPrice(PriceBook.fallback(), 20).priceSource).toBe("fallback");
  });

  test("rejects a negative or non-integer slot count", () => {
    expect(() => writerRunPrice(PriceBook.fallback(), -1)).toThrow();
    expect(() => writerRunPrice(PriceBook.fallback(), 1.5)).toThrow();
  });

  // Review round 3: writerRunPrice must delegate to the exact same money
  // helper (writerWorstMicros) estimateRun uses for its own writer term, so
  // the two can never drift apart again. Isolates the writer's own
  // contribution to estimateRun's worst case by using one image choice, no
  // age checks and attemptsPerSlot 1, then subtracting the (independently
  // computed, via the public PriceBook API) image-only cost.
  test("agrees with estimateRun's writer term for the same slot count (drift guard)", () => {
    const book = PriceBook.fallback();
    const image = { model: "x-ai/grok-imagine-image-2.0", quality: "low" as const, refs: 1 };
    const imageOnlyPerPhoto = book.imageWorstCase(image);

    for (const slotCount of [0, 1, WRITER_CALL.slotsPerCall, WRITER_CALL.slotsPerCall + 1, 100]) {
      const run: RunPlanInput = { photos: slotCount, attemptsPerSlot: 1, route: [image], writer: WRITER_CALL, ageChecks: null };
      const writerPortion = estimateRun(book, run).worstMicros - slotCount * imageOnlyPerPhoto;
      expect(writerPortion).toBe(writerRunPrice(book, slotCount).worstMicros);
    }
  });
});

test("WRITER_JSON_SCHEMA and WRITER_CALL.maxAttempts", () => {
  expect(WRITER_CALL.maxAttempts).toBe(2);
  expect(WRITER_JSON_SCHEMA.name).toBe("scene_sentences");
  const good: WriterOutput = { scenes: [{ slotIndex: 1, sentence: "x" }] };
  expect(good.scenes[0]?.slotIndex).toBe(1);
});

describe("WRITER_CALL's per-call ceilings cover one full chunk", () => {
  // Review round 2: RunRequest.count (studio/shared/engine/state.ts) allows
  // 1..100 photos, possibly all in one category — far more than a single
  // writer call can safely take (a 100-slot prompt floor measured ~30_223
  // tokens, and 100 scenes' typical output alone, ~13_000 tokens, already
  // exceeds max_tokens). The writer phase (runs/writerPhase.ts) now chunks the plan
  // into calls of at most WRITER_CALL.slotsPerCall slots each, so the ceiling
  // only ever has to cover ONE chunk — never the whole run — whatever the
  // run's total slot count.
  //
  // The worst plausible single refusal: almost every slot both two-handed
  // and carrying a youth/revealing word, one slot missing outright, and
  // (T5c) almost every slot also flagged for a pose contradiction.
  function worstRefusal(slots: readonly PlanSlot[]): WriterRefusal {
    const indices = slots.map((s) => s.slotIndex);
    const missingSlots = indices.slice(-1);
    const rest = indices.slice(0, -1);
    return {
      problems: ["missing-slots", "two-handed", "youth-word", "revealing-word", "pose-contradiction"],
      missingSlots,
      twoHandedSlots: rest,
      wordSlots: rest,
      poseSlots: rest,
      words: ["girl", "teen", "child", "kid", "school uniform", "bikini", "lingerie", "stockings", "sports bra", "slip dress"],
    };
  }

  test("a full chunk's worst refusal message stays under WRITER_CALL.inputTokens", () => {
    const scenePlan = plan({ seed: 20260924, count: WRITER_CALL.slotsPerCall, categories: [...CATEGORIES] });
    const messages = writerMessages(scenePlan.slots, worstRefusal(scenePlan.slots));
    const floor = promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

    // Measured (2026-09-27, T5c: pose added to every slot and to a worst
    // refusal's own pose-contradiction problem): a WRITER_CALL.slotsPerCall
    // (25) chunk, plain ~10045, +worst refusal ~11108; 20 slots plain ~8446,
    // +worst refusal ~9429; 30 slots +worst refusal ~12711 (over one chunk,
    // for reference only — a 30-slot run is itself split into two chunks of
    // 25 and 5). That left only ~892 tokens of headroom over 12_000 (down
    // from ~2_800 before pose), so T5c round 2 (owner decision) raised
    // WRITER_CALL.inputTokens to 14_000: ~2_892 tokens of headroom over one
    // full chunk's worst refusal. Re-measure here before adding any further
    // refusal reason or per-slot field.
    expect(floor).toBeLessThanOrEqual(WRITER_CALL.inputTokens);
  });

  test("a smaller chunk (the run's documented default of 20 photos, all in one chunk) leaves even more headroom", () => {
    const scenePlan = plan({ seed: 20260924, count: 20, categories: [...CATEGORIES] });
    const messages = writerMessages(scenePlan.slots, worstRefusal(scenePlan.slots));
    const floor = promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

    expect(floor).toBeLessThanOrEqual(WRITER_CALL.inputTokens);
  });

  // Reliability, not money-safety: max_tokens is a hard API ceiling either
  // way (an attempt is truncated, never overpaid), but a chunk whose
  // scenes cannot fit inside it would waste an attempt on a truncated,
  // invalid-JSON answer every time. WORST_OUTPUT_TOKENS_PER_SCENE doubles
  // the spike's measured typical (130 tokens for ~39 words/scene,
  // WRITER_CALL.typicalPerScene.outputTokens) — generous headroom over the
  // system prompt's own "25 to 45 words" target.
  const WORST_OUTPUT_TOKENS_PER_SCENE = WRITER_CALL.typicalPerScene.outputTokens * 2;

  test("the output ceiling comfortably fits one full chunk, even generously overshooting the target sentence length", () => {
    expect(WRITER_CALL.slotsPerCall * WORST_OUTPUT_TOKENS_PER_SCENE).toBeLessThanOrEqual(WRITER_CALL.maxTokens);
  });
});

/** The words the writers are told never to use (Spike A v3): 37, copied here so a silent edit of the prompt turns this red. */
const TOLD_NEVER_WORDS = [
  "professional", "photographer", "photoshoot", "studio", "editorial", "fashion", "model", "posing", "captures", "candid", "cinematic", "bokeh", "golden hour", "softly lit",
  "soft light", "glow", "glowing", "dramatic", "moody", "dreamy", "elegant", "luxurious", "lavish", "glamorous", "chic", "sophisticated", "polished", "pristine", "marble",
  "silk", "satin", "velvet", "stunning", "beautiful", "perfect", "flawless", "gorgeous",
];

describe("S5.1b: the writer is told to write what an ordinary phone photo shows, and nothing about how it was taken", () => {
  const system = (): string => writerMessages([slot()])[0]?.content ?? "";

  test("the opening lines say it is her own ordinary phone photo and never name her hair, eyes or body", () => {
    const lines = system().split("\n");
    expect(lines[0]).toBe("You write one plain sentence of what an ordinary phone photo of her shows, for each of the given slots, of one recurring adult woman who posts her own photos.");
    expect(lines[1]).toContain("never describe her hair, eyes or body type");
    expect(system()).not.toContain("photorealistic");
    expect(system()).not.toContain("never change her hair");
  });

  test("the detail is at most one ordinary detail of the place, and the light is named by its source only", () => {
    expect(system()).toContain("her expression, and at most one ordinary detail of the place.");
    expect(system()).toContain("Do not describe the light, the colours or the mood; if light comes up, name only its source.");
    expect(system()).not.toContain("the background and the light");
  });

  test("the gaze rule: she looks at the viewer, never at a named phone, camera or lens; her phone appears only with its activity", () => {
    expect(system()).toContain(
      "When she looks toward whoever takes the photo, write that she looks at the viewer; never name a phone, camera or lens for her gaze. Her own phone appears only when the slot's activity uses it.",
    );
    expect(system()).not.toContain('"the phone" in a gaze');
    expect(system()).toContain("For any other pose she may face or glance toward the viewer as the shot allows.");
    expect(system()).not.toContain("glance toward the camera");
  });

  test("forbids camera talk, paper, books, laptops and tablets", () => {
    expect(system()).toContain("Never write about the camera, the lens, the photo, the shot or the framing.");
    expect(system()).toContain("No paper, books, magazines, documents, notebooks, menus, maps, desks or studying; no laptops or tablets: her phone is the only screen.");
  });

  test("the outfit is described exactly as given, and the revealing words are still named as forbidden (the readers refuse them)", () => {
    expect(system()).toContain(
      "Describe the outfit exactly as given, in its own words: never more or less revealing, never add or remove a garment. Never name bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie.",
    );
    expect(system()).not.toContain("describe it as covering and non-revealing");
  });

  test("tells the model the 37 words never to use", () => {
    const line = system().split("\n").find((l) => l.startsWith("- Never use these words: ")) ?? "";
    const told = line.slice("- Never use these words: ".length).replace(", unless the slot's own place, outfit or activity uses it.", "").split(", ");
    expect(told).toEqual(TOLD_NEVER_WORDS);
    expect(line.endsWith(", gorgeous, unless the slot's own place, outfit or activity uses it.")).toBe(true);
    expect(told).toHaveLength(37);
    expect(system()).not.toContain('Never use "stunning"');
  });

  test("SHOT_LABEL names who took the phone photo and carries no camera or photographer", () => {
    expect(SHOT_LABEL).toEqual({
      friend: "a phone snap a friend took",
      selfie: "her own front-camera selfie",
      mirror: "her mirror selfie",
      candid: "a friend's snap while she is busy",
      photographer: "a phone snap a friend took",
    });
    for (const label of Object.values(SHOT_LABEL)) expect(label).not.toMatch(/full-frame|photographer|candid shot|looking at the camera/);
  });

  test("the slot's time of day goes out as its light, by source, for every stored time", () => {
    for (const time of POOL_TIMES) {
      const [, user] = writerMessages([slot({ timeOfDay: time })]);
      const body = JSON.parse(user?.content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
      expect(body[0].timeOfDay).toBe(lightOf(time));
      expect(user?.content).not.toMatch(/golden hour|studio lighting|softly lit/);
    }
  });

  test("a built-in photoshoot slot is called «Own phone photos», never a photoshoot", () => {
    const [, user] = writerMessages([slot({ category: "photoshoot" })]);
    expect(user?.content).toContain('"category":"Own phone photos"');
    expect(user?.content).not.toContain("Photoshoot");
  });

  test("the slots go out as compact JSON (the worst custom chunk must stay under the writer ceiling: writer.custom.test.ts)", () => {
    expect(writerMessages([slot(), slot({ slotIndex: 2 })])[1]?.content).not.toContain("\n  ");
  });
});
