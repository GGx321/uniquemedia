import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CAPTURES, POOL_TEXT_MAX, POOL_TIMES } from "../../shared/engine";
import { captureOfShot } from "../../shared/scenes/captures";
import { WRITER_BOLD_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import type { PlanSlot } from "./schema";
import { CAPTURE_LABEL, readWriterAnswer, SHOT_LABEL, TIME_WORD, writerBoldMessages, writerMessages, WRITER_JSON_SCHEMA, type WriterAnswer, type WriterRefusal } from "./writer";
import { worstSlotList } from "./testing/worstSlotList";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA4, plan s5a4 §5.3.3, §8 «S5.BA4», I5.71–I5.80): the scene writer's bold mode, the one a custom category's «Смелая» frames are written in.
// Its prompt, its slot JSON, its reader and the coverage appended after the read. The ordinary writer stays byte for byte as it was (writer.test.ts,
// writer.custom.test.ts and sceneSets/floor.test.ts pin it).

const CUSTOM = "cat-fixture-paris-cafes";

/** A custom category's «Смелая» slot as the planner draws it (S5.BA3): on the route, with its world, from the shared «rooms» bank. */
function routed(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "her room",
    timeOfDay: "evening",
    activity: "lies back across the bed",
    outfit: "a white lace bra and panties",
    shot: "selfie",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    capture: "above",
    level: "flirty",
    route: "seedream",
    world: "a cafe terrace in Paris",
    ...overrides,
  };
}

/** The same custom category's slot stored before 5a.4: no route, no world, an everyday outfit. */
function unrouted(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "a corner cafe",
    timeOfDay: "morning",
    activity: "sips a coffee",
    outfit: "a beige trench coat and jeans",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

const answer = (scenes: { slotIndex: number; sentence: string }[]): string => JSON.stringify({ scenes });
const problemsOf = (read: WriterAnswer): string[] => (read.ok ? [] : read.problems);

describe("the reader holds each slot to its own content level (§5.3.3 «The reader»)", () => {
  const LACE = "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling up at the viewer, a box of macarons on the nightstand.";

  test("«a black lace bra and panties» passes on a routed custom slot", () => {
    const sentence = "In her hotel room in Paris, she lies back across the bed in a black lace bra and panties, smiling up at the viewer, a box of macarons on the nightstand.";
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [routed({ outfit: "a black lace bra and panties" })]);
    expect(read.ok).toBe(true);
  });

  test("a nightwear slot is a «Смелая» frame without the route, so its lingerie passes too", () => {
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence: LACE }]), [routed({ category: "nightwear", route: undefined, world: undefined, location: "her bedroom" })]);
    expect(read.ok).toBe(true);
  });

  test("a youth word is still refused on a routed slot, and refuses the whole answer", () => {
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence: `${LACE} She looks like a schoolgirl.` }]), [routed()]);
    expect(problemsOf(read)).toEqual(["youth-word"]);
    expect(read.ok === false && read.repair).toBeUndefined();
  });

  test("the babydoll is a garment at «Смелая»: exempt on a routed slot, a youth word on an unrouted one", () => {
    const sentence = "In her hotel room in Paris, she lies back across the bed in a sheer babydoll over a lace set, a box of macarons on the nightstand.";
    expect(readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [routed({ outfit: "a sheer babydoll over a lace set" })]).ok).toBe(true);
    expect(problemsOf(readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [unrouted()]))).toContain("youth-word");
  });

  test("a revealing word on an unrouted custom slot is still refused, as today", () => {
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence: LACE }]), [unrouted()]);
    expect(problemsOf(read)).toEqual(["revealing-word"]);
    expect(read.ok === false && read.words).toEqual(["bra", "panties"]);
  });

  test("the owner's denim shorts are refused at every level, under our name for them", () => {
    const sentence = "In her hotel room in Paris, she lies back across the bed in denim shorts and a white lace bra, a box of macarons on the nightstand.";
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [routed()]);
    expect(problemsOf(read)).toEqual(["revealing-word"]);
    expect(read.ok === false && read.words).toEqual(["denim shorts"]);
  });

  test("in a chunk that holds both, only the unrouted slot is marked; the routed one is kept", () => {
    const read = readWriterAnswer(
      answer([
        { slotIndex: 1, sentence: LACE },
        { slotIndex: 2, sentence: LACE },
      ]),
      [routed({ slotIndex: 1 }), unrouted({ slotIndex: 2 })],
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.repair?.marked).toEqual([2]);
    expect([...(read.repair?.accepted.keys() ?? [])]).toEqual([1]);
  });
});

/** The slots a request carries, parsed back from its user message. */
const sentSlots = (messages: { content: string }[]): Record<string, unknown>[] => JSON.parse(messages[1]?.content.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("the ordinary writer does not move (§8 «S5.BA4»: 253 / 678 / 253 unchanged)", () => {
  // The 2 956 bytes of the ordinary system prompt on 8dc9a3ae, byte for byte. The floor pins measure its length; this pins its every byte.
  test("the ordinary system prompt is byte-identical", () => {
    const system = writerMessages([unrouted({ category: "home" })])[0]?.content ?? "";
    expect(Buffer.byteLength(system, "utf8")).toBe(2_956);
    expect(sha(system)).toBe("9cae2adf47e1085c6ce1d007b3566d3c81e7a027cb2013edd86c80bb2344f0db");
  });

  test("an ordinary request never carries a world, even for a routed slot handed to it", () => {
    const [, user] = writerMessages([routed()], undefined, () => "Paris cafes");
    expect(user?.content).not.toContain("world");
    expect(sentSlots(writerMessages([routed()], undefined, () => "Paris cafes"))[0]).toEqual({
      slotIndex: 1,
      category: "Paris cafes",
      location: "her room",
      timeOfDay: "the evening lamps, the sky outside already dim",
      shot: SHOT_LABEL.selfie,
      pose: "facing the viewer",
      outfit: "a white lace bra and panties",
      activity: "lies back across the bed",
    });
  });
});

describe("the bold system prompt (§5.3.3, r2.2 P1–P3)", () => {
  const bold = (): string => writerBoldMessages([routed()])[0]?.content ?? "";
  const ordinary = (): string => writerMessages([unrouted({ category: "home" })])[0]?.content ?? "";
  const lines = (text: string): string[] => text.split("\n");

  test("it is a system message of its own, and the ordinary one is not it", () => {
    const [system] = writerBoldMessages([routed()]);
    expect(system?.role).toBe("system");
    expect(system?.content).not.toBe(ordinary());
  });

  test("it keeps the youth rule verbatim", () => {
    expect(lines(bold())).toContain("- She is a grown adult woman; no children or minors anywhere in the scene, and never a word that suggests she or anyone else is not an adult.");
  });

  test("it drops the «Never name bikini …» rule, and still holds the outfit to exactly what is given", () => {
    expect(bold()).not.toContain("Never name bikini");
    expect(bold()).not.toMatch(/never name[^.]*(?:lingerie|swimsuit|thong)/i);
    expect(lines(bold())).toContain("- Describe the outfit exactly as given, in its own words: never more or less revealing, never add or remove a garment.");
  });

  test("it holds the timer, the hidden face and the phone over her face (r2.2 P1, P2)", () => {
    expect(bold()).toContain("On a timer both of her hands are empty");
    expect(bold()).toContain("When her face is hidden, describe neither her face nor her gaze");
    expect(bold()).toContain("nothing but her phone covers her face");
    expect(bold()).not.toContain("nothing covers her face");
  });

  test("the one-hand rule covers her own photos and the mirror selfie, the way the capture labels name them (r2.2 P2)", () => {
    expect(bold()).toContain("In her own photo or a mirror selfie, only one hand is free");
  });

  test("it holds no «she holds» clause for the sheet or the towel (r2.2 P3)", () => {
    expect(bold()).not.toMatch(/\b(?:sheet|towel)s?\b[^.\n]*\bholds?\b|\bholds?\b[^.\n]*\b(?:sheet|towel)s?\b/i);
  });

  test("it sets a slot with a world inside it, never in a public place, and keeps a slot without one where it is", () => {
    expect(bold()).toContain("The world is the place her day belongs to");
    expect(bold()).toMatch(/never in a public place/);
    expect(bold()).toContain("A slot without a world keeps its location as given.");
  });

  test("it says to write «she» and the activity word for word, in one piece (the probe's W1:2 and W2:2)", () => {
    expect(bold()).toContain('Write "she" and then the activity word for word, in one piece with its commas');
  });

  test("it says the shot, the pose and the time of day are never written, nor the light, the world or the slot (the probe's label leaks)", () => {
    expect(bold()).toContain("never write them, and never write the words world or slot");
    expect(bold()).toContain("Do not describe the light, the colours or the mood; if light comes up, name only its source.");
  });

  test("it never names a word of the soft list that the ordinary prompt does not, and keeps the ordinary lines it shares verbatim", () => {
    const shared = [0, 1].map((i) => lines(ordinary())[i]);
    expect(lines(bold()).slice(0, 2)).toEqual(shared);
    for (const line of lines(ordinary()).filter((l) => /^- (?:One full sentence|In a friend's snap|No paper|Never describe mess|Never use these words)|^Return JSON/.test(l))) {
      expect(lines(bold())).toContain(line);
    }
  });
});

describe("the bold slot JSON (§5.3.3, r2.2 P1, the probe's label leaks)", () => {
  test("a routed slot goes out with its world, no category, the capture label, the pose and a plain time word", () => {
    expect(sentSlots(writerBoldMessages([routed()]))).toEqual([
      { slotIndex: 1, location: "her room", world: "a cafe terrace in Paris", timeOfDay: "evening", shot: CAPTURE_LABEL.above, pose: "front", outfit: "a white lace bra and panties", activity: "lies back across the bed" },
    ]);
  });

  test("a slot without a world (an old set's slot in a bold chunk, r2.1 L3) carries no world key", () => {
    const [slot] = sentSlots(writerBoldMessages([routed({ category: "nightwear", route: undefined, world: undefined, location: "her bedroom" })]));
    expect(slot).not.toHaveProperty("world");
    expect(slot).not.toHaveProperty("category");
  });

  test("a timer slot says «on a timer», not «a phone snap a friend took»", () => {
    const [slot] = sentSlots(writerBoldMessages([routed({ shot: "friend", capture: "timer", pose: "profile" })]));
    expect(slot?.shot).toContain("on a timer");
    expect(slot?.shot).not.toBe(SHOT_LABEL.friend);
  });

  test("a mirror-hidden slot says that the phone covers her face", () => {
    const [slot] = sentSlots(writerBoldMessages([routed({ shot: "mirror", capture: "mirror-hidden" })]));
    expect(slot?.shot).toMatch(/\bphone covers (?:her )?face\b/);
  });

  test("a slot stored before captures reads its capture from its shot", () => {
    for (const shot of ["friend", "selfie", "mirror", "candid", "photographer"] as const) {
      const [slot] = sentSlots(writerBoldMessages([routed({ shot, capture: undefined, pose: "front" })]));
      expect(slot?.shot).toBe(CAPTURE_LABEL[captureOfShot(shot)]);
    }
  });

  test("every capture has a label of at most 33 characters, today's longest shot label, so the worst chunk does not grow", () => {
    expect(Object.keys(CAPTURE_LABEL).sort()).toEqual([...CAPTURES].sort());
    const longestShot = Math.max(...Object.values(SHOT_LABEL).map((l) => l.length));
    expect(longestShot).toBe(33);
    for (const label of Object.values(CAPTURE_LABEL)) expect(label.length).toBeLessThanOrEqual(33);
  });

  test("the self-shot captures are «her own photo» or a «mirror selfie», as the one-hand rule names them", () => {
    for (const capture of ["above", "prone", "over-shoulder", "selfie", "pov-legs"] as const) expect(CAPTURE_LABEL[capture]).toMatch(/^her own photo\b/);
    for (const capture of ["mirror", "mirror-hidden"] as const) expect(CAPTURE_LABEL[capture]).toContain("mirror selfie");
  });

  test("the time of day goes out as a plain time word, never a light phrase or a word of the soft list", () => {
    for (const time of [...POOL_TIMES, "a time the table does not know"]) {
      const [slot] = sentSlots(writerBoldMessages([routed({ timeOfDay: time })]));
      expect(slot?.timeOfDay).toBe(TIME_WORD(time));
      expect(String(slot?.timeOfDay)).not.toMatch(/light|lamp|sun|dim|golden hour|studio/i);
    }
  });

  test("the pose goes out as its own name, never the ordinary label to copy («facing the viewer»)", () => {
    for (const pose of ["front", "three-quarter", "profile", "back"] as const) {
      const [slot] = sentSlots(writerBoldMessages([routed({ pose, shot: "friend", capture: "timer" })]));
      expect(slot?.pose).toBe(pose);
    }
  });

  test("a refusal is fed back as fixed reasons, in the next message", () => {
    const refusal: WriterRefusal = { problems: ["two-handed"], missingSlots: [], twoHandedSlots: [1], wordSlots: [], words: [], poseSlots: [] };
    expect(writerBoldMessages([routed()], refusal)[1]?.content).toContain("An earlier answer was rejected: slot(s) 1 used a two-handed action");
    expect(writerBoldMessages([routed()])[1]?.content).not.toContain("rejected");
  });
});

// The widest of each value the bold slot JSON sends, read from the tables themselves.
const longestOf = (values: readonly string[]): string => values.reduce((a, b) => (b.length > a.length ? b : a));
const WORST_CAPTURE = (Object.keys(CAPTURE_LABEL) as (keyof typeof CAPTURE_LABEL)[]).reduce((a, b) => (CAPTURE_LABEL[b].length > CAPTURE_LABEL[a].length ? b : a));
const WORST_TIME = [...POOL_TIMES, "a time the table does not know"].reduce((a, b) => (TIME_WORD(b).length > TIME_WORD(a).length ? b : a));
const WORST_POSE = longestOf(["front", "three-quarter", "profile", "back"]) as PlanSlot["pose"];

describe("WRITER_BOLD_CALL's ceiling covers the worst bold chunk (r2.2 P4, the bold floor pin)", () => {
  /** What the reserve keeps clear of the ceiling, as the ordinary pins do. */
  const MARGIN = 250;
  const MARGIN_PRINTED = 3_961;
  const CEILING = WRITER_BOLD_CALL.inputTokens;
  const FIRST_INDEX = 100 - WRITER_BOLD_CALL.slotsPerCall + 1;

  /** 25 slots numbered 76–100, every text and the world at POOL_TEXT_MAX, the widest time, capture and pose. A mirror capture rides on a front pose (the schema's rule). */
  function worstSlots(textLength: number): PlanSlot[] {
    return Array.from({ length: WRITER_BOLD_CALL.slotsPerCall }, (_, i) => ({
      slotIndex: FIRST_INDEX + i,
      category: CUSTOM,
      location: "x".repeat(textLength),
      timeOfDay: WORST_TIME,
      activity: "x".repeat(textLength),
      outfit: "x".repeat(textLength),
      shot: "friend",
      capture: WORST_CAPTURE,
      pose: WORST_POSE,
      attemptIdBase: `slot-${i + 1}`,
      repeatedPair: false,
      level: "bold",
      route: "seedream",
      world: "x".repeat(textLength),
    }));
  }

  /** As the ordinary pin: 160 distinct words one byte over the clip, of the four widest kinds. */
  const hostileWords = Array.from({ length: 40 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return [`${"W".repeat(12)}${n}x`, `${"Я".repeat(6)}${n}x`, `${"😀".repeat(3)}${n}x`, `${"é".repeat(6)}${n}x`];
  }).flat();

  /** The worst refusal: every reason a bold chunk can raise, each slot list at its longest (`worstSlotList`). `revealing-word` included: an old set's unrouted slot can raise it (r2.1 L3). */
  function worstRefusal(slots: readonly PlanSlot[]): WriterRefusal {
    const rest = worstSlotList(slots.map((s) => s.slotIndex));
    return {
      problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction", "phone-in-selfie"],
      missingSlots: rest,
      twoHandedSlots: rest,
      wordSlots: rest,
      poseSlots: rest,
      phoneSlots: rest,
      words: hostileWords,
    };
  }

  const floorOf = (slots: readonly PlanSlot[]): number => promptTokenFloor({ messages: writerBoldMessages(slots, worstRefusal(slots)), jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

  test("the worst chunk's widest values are the ones the tables hold", () => {
    expect(CAPTURE_LABEL[WORST_CAPTURE].length).toBe(Math.max(...Object.values(CAPTURE_LABEL).map((l) => l.length)));
    expect(WORST_POSE).toBe("three-quarter");
  });

  test(`the worst bold chunk stays at least ${MARGIN} tokens under the 17 000 ceiling`, () => {
    const floor = floorOf(worstSlots(POOL_TEXT_MAX));
    console.log(`bold floor ${floor}, margin ${CEILING - floor} under ${CEILING}`);
    expect(floor).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("the margin printed here is the measured one: re-measure it when the bold prompt, a label or a reason changes", () => {
    expect(CEILING - floorOf(worstSlots(POOL_TEXT_MAX))).toBe(MARGIN_PRINTED);
  });

  test("one char more in every text is measurably bigger, so the pin does measure the bound", () => {
    expect(floorOf(worstSlots(POOL_TEXT_MAX + 1))).toBeGreaterThan(floorOf(worstSlots(POOL_TEXT_MAX)));
  });
});
