import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CAPTURES, POOL_TEXT_MAX, POOL_TIMES } from "../../shared/engine";
import { CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import { COVER } from "../../shared/scenes/banks/companions/outfits";
import { BANKS } from "../../shared/scenes/banks";
import { BOLD_COMPANIONS } from "../../shared/scenes/banks/companions";
import type { CategoryBank } from "../../shared/scenes/banks/types";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { plainSentence } from "../../shared/scenes/plain";
import { coverageOfWorn, KEPT_FALLBACK, slotCoverageOf } from "../../shared/scenes/template";
import { captureOfShot } from "../../shared/scenes/captures";
import { exposureWordsIn } from "../../shared/scenes/explicitWords";
import { WRITER_BOLD_CALL, writerAttemptWorstMicros, writerCallOf, writerExpectedMicros } from "../money/estimate";
import { PriceBook } from "../money/prices";
import { promptTokenFloor } from "../openrouter/chat";
import type { PlanSlot } from "./schema";
import { BOLD_PROBLEMS, boldReader, CAPTURE_LABEL, PLACE_KEYS, readBoldWriterAnswer, readWriterAnswer, REFUSAL_WORD_BYTES_MAX, REFUSAL_WORDS_MAX, SHOT_LABEL, slotList, timeWordOf, WATER_PLACE_KEYS, writerBoldMessages, writerMessages, writerRefusalText, writerRunPrice, WRITER_JSON_SCHEMA, type WriterAnswer, type WriterRefusal } from "./writer";
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
      expect(slot?.timeOfDay).toBe(timeWordOf(time));
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

describe("the bold reader: where she is, what she wears, what Seedream will not draw (§5.3.3 «The reader», r2.2 P8)", () => {
  /** A sentence that keeps every rule of the bold reader for `routed()`: her room inside the world, the outfit as given, the moment word for word. */
  const GOOD = "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling up at the viewer, a box of macarons from the corner bakery on the nightstand.";
  const bold = (sentence: string, slot: PlanSlot = routed()): WriterAnswer => readBoldWriterAnswer(answer([{ slotIndex: slot.slotIndex, sentence }]), [slot]);

  test("a sentence that keeps every rule passes", () => {
    expect(bold(GOOD)).toEqual({ ok: true, sentences: new Map([[1, GOOD]]) });
  });

  test("the bold reader keeps today's rules: an answer that is not the JSON object, a missing slot, a youth word", () => {
    expect(problemsOf(readBoldWriterAnswer("no json here", [routed()]))).toEqual(["not-json"]);
    expect(problemsOf(readBoldWriterAnswer(answer([]), [routed()]))).toEqual(["missing-slots"]);
    expect(problemsOf(bold(`${GOOD} She looks like a teen.`))).toContain("youth-word");
  });

  describe("place-missing: the sentence names the slot's place, or a word its world calls it (PLACE_KEYS)", () => {
    test("the table is the one the plan pins, one row per «rooms» place, and every «by the water» place reads the water row", () => {
      expect(PLACE_KEYS).toEqual({
        "her room": ["room", "bedroom", "suite", "cabin", "chalet", "bed"],
        "her bathroom": ["bathroom", "shower", "bath", "tub", "mirror"],
        // S5.BA4 round 2 (review LOW, the controller's amendment to r2.2 P8): the pane, the sill and the windowsill; the daybed and the settee.
        "her window": ["window", "porthole", "pane", "sill", "windowsill"],
        "her balcony": ["balcony", "terrace", "deck", "veranda"],
        "her sofa": ["sofa", "couch", "living room", "lounge", "daybed", "settee"],
      });
      expect(WATER_PLACE_KEYS).toEqual(["water", "pool", "sea", "beach", "shore", "lake", "bay", "deck", "sundeck", "lounger"]);
      expect(CUSTOM_BOLD_BANKS.rooms.places.map((p) => p.name).sort()).toEqual(Object.keys(PLACE_KEYS).sort());
      expect(CUSTOM_BOLD_BANKS.water.places.every((p) => p.water === true)).toBe(true);
    });

    test("«In the cabin of the yacht, she …» passes for «her room»", () => {
      const slot = routed({ activity: "lies on her side, half asleep", world: "the cabin of a sailing yacht" });
      const sentence = "In the cabin of the yacht, she lies on her side, half asleep, in a white lace bra and panties, a coil of rope by the door.";
      expect(problemsOf(bold(sentence, slot))).not.toContain("place-missing");
    });

    test("«Through the porthole …» passes for «her window»", () => {
      const slot = routed({ location: "her window", activity: "rests her forehead on the pane", shot: "friend", capture: "timer", pose: "profile", world: "the cabin of a sailing yacht", outfit: "a black lace bra and panties" });
      const sentence = "Through the porthole of the yacht the bay shows blue as she rests her forehead on the pane in a black lace bra and panties, her eyes on the water.";
      expect(problemsOf(bold(sentence, slot))).not.toContain("place-missing");
    });

    test.each([
      ["her window", "she rests her forehead on the pane", "rests her forehead on the pane"],
      ["her window", "she sits on the sill", "sits on the ledge, legs crossed"],
      ["her window", "the windowsill", "sits on the ledge, legs crossed"],
      ["her sofa", "the daybed", "curls up with her knees in"],
      ["her sofa", "the settee", "curls up with her knees in"],
    ])("«%s» is said by %s too (the amended P8)", (location, said, activity) => {
      const slot = routed({ location, activity, shot: "friend", capture: "timer", pose: "front", world: "the cabin of a sailing yacht" });
      const sentence = `On the yacht, ${said.startsWith("she ") ? `${said}, then she ${activity}` : `she ${activity} on ${said}`} in a white lace bra and panties, a coil of rope beside her.`;
      expect(problemsOf(bold(sentence, slot))).not.toContain("place-missing");
    });

    test("a sentence set at «the cafe terrace» with no private word is refused", () => {
      const slot = routed({ activity: "lies on her side, half asleep" });
      const sentence = "At the cafe terrace in Paris, she lies on her side, half asleep, in a white lace bra and panties, a croissant on the table beside her.";
      const read = bold(sentence, slot);
      expect(problemsOf(read)).toContain("place-missing");
      expect(read.ok === false && read.boldSlots?.["place-missing"]).toEqual([1]);
    });

    test("a «by the water» slot names the water or a word for it", () => {
      const slot = routed({ location: "a sunny spot by the water", activity: "sits with her feet in the water", outfit: "a red triangle bikini", shot: "friend", capture: "friend", world: "a yacht at anchor in a bay" });
      expect(problemsOf(bold("On the deck of the yacht, she sits with her feet in the water in a red triangle bikini, smiling at the viewer, the hills of the bay behind her.", slot))).not.toContain("place-missing");
    });

    test("a slot without a world is not held to it (an old set's slot in a bold chunk, r2.1 L3)", () => {
      const slot = routed({ category: "nightwear", route: undefined, world: undefined, location: "her bedroom", activity: "lies back against the pillows", outfit: "a tee and cotton panties", capture: "above" });
      const read = bold("She lies back against the pillows in a tee and cotton panties, smiling up at the viewer, a glass of water on the nightstand.", slot);
      expect(problemsOf(read)).not.toContain("place-missing");
    });
  });

  describe("outfit-missing: every garment of the outfit is named", () => {
    test("a lace set that lost its panties is refused; the set as given passes", () => {
      const read = bold("In her small hotel room in Paris, she lies back across the bed in a white lace bra, smiling up at the viewer, a box of macarons from the corner bakery on the nightstand.");
      expect(problemsOf(read)).toEqual(["outfit-missing"]);
      expect(read.ok === false && read.boldSlots?.["outfit-missing"]).toEqual([1]);
      expect(problemsOf(bold(GOOD))).toEqual([]);
    });

    test("an implied cover counts as what she wears: the towel", () => {
      const slot = routed({ location: "her bathroom", activity: "leans on the sink after a shower", outfit: "only a white bath towel", shot: "mirror", capture: "mirror-hidden" });
      expect(problemsOf(bold("In the bathroom of her hotel room in Paris, she leans on the sink after a shower, a bottle of lotion from the corner shop by the tap.", slot))).toContain("outfit-missing");
      expect(problemsOf(bold("In the bathroom of her hotel room in Paris, she leans on the sink after a shower in only a white bath towel, a bottle of lotion by the tap.", slot))).toEqual([]);
    });

    test("an outfit with no garment the reader knows asks nothing of the sentence", () => {
      const slot = unrouted({ outfit: "something comfortable" });
      expect(problemsOf(readBoldWriterAnswer(answer([{ slotIndex: 1, sentence: "At a corner cafe she sips a coffee, smiling at the viewer over the rim of her cup." }]), [slot]))).not.toContain("outfit-missing");
    });
  });

  describe("exposure-word: what Seedream refuses to draw is never our writer's word (I5.76, M9)", () => {
    test("«topless» on a routed slot is refused, and the correct sentence passes", () => {
      const read = bold("In her small hotel room in Paris, she lies back across the bed topless in white lace panties and a bra, a box of macarons from the corner bakery on the nightstand.");
      expect(problemsOf(read)).toContain("exposure-word");
      expect(read.ok === false && read.boldSlots?.["exposure-word"]).toEqual([1]);
      expect(problemsOf(bold(GOOD))).not.toContain("exposure-word");
    });

    test("«see-through» lace is refused too", () => {
      expect(problemsOf(bold("In her small hotel room in Paris, she lies back across the bed in a see-through lace bra and panties, a box of macarons on the nightstand."))).toContain("exposure-word");
    });
  });

  test("each problem marks its slot alone: the next attempt asks only it, and the others are kept", () => {
    const read = readBoldWriterAnswer(
      answer([
        { slotIndex: 1, sentence: GOOD },
        { slotIndex: 2, sentence: "At the cafe terrace in Paris, she lies back across the bed in a white lace bra, a croissant on the table beside her." },
      ]),
      [routed({ slotIndex: 1 }), routed({ slotIndex: 2 })],
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.repair?.marked).toEqual([2]);
    expect([...(read.repair?.accepted ?? new Map())]).toEqual([[1, GOOD]]);
  });

  test("a refusal never quotes the model's sentence: each bold reason is a fixed text with its slot numbers", () => {
    const sentence = "At the zanzibarquux cafe in Paris, she lies on the rug topless, a croissant on the table.";
    const read = bold(sentence);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const told = writerRefusalText(read);
    expect(told).not.toContain("zanzibarquux");
    expect(told).not.toContain("topless");
    expect(told).not.toContain("croissant");
    expect(told).toContain("slot(s) 1");
  });
});

describe("the bold reader: what the paid probe P-BA found (label leaks, public places, a split moment)", () => {
  const bold = (sentence: string, slot: PlanSlot = routed()): WriterAnswer => readBoldWriterAnswer(answer([{ slotIndex: slot.slotIndex, sentence }]), [slot]);
  const GOOD = "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling up at the viewer, a box of macarons from the corner bakery on the nightstand.";

  describe("label-word: the camera, the photo, the light and the slot's labels never reach the prose", () => {
    test.each([
      ["captured in her own photo from above", "In her hotel room in Paris, captured in her own photo from above, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["morning daylight", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties as morning daylight fills the room, a box of macarons on the nightstand."],
      ["set in the world of", "Set in the world of a cafe terrace, in her hotel room she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["a selfie", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties for a selfie, a box of macarons on the nightstand."],
      ["the camera", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling into the camera, a box of macarons on the nightstand."],
      ["a timer", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties while the timer counts down, a box of macarons on the nightstand."],
      ["a three-quarter view", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties in a three-quarter view, a box of macarons on the nightstand."],
    ])("%s is refused", (_, sentence) => {
      const read = bold(sentence);
      expect(problemsOf(read)).toContain("label-word");
      expect(read.ok === false && read.boldSlots?.["label-word"]).toEqual([1]);
    });

    test("a word the slot's own texts say is not held against it (an old custom slot whose activity is about her camera)", () => {
      const slot = unrouted({ activity: "checks her camera settings" });
      const read = readBoldWriterAnswer(answer([{ slotIndex: 1, sentence: "At a corner cafe she checks her camera settings in a beige trench coat and jeans, smiling to herself." }]), [slot]);
      expect(problemsOf(read)).not.toContain("label-word");
    });

    // Review LOW: only the leaks the probe saw. The light named by its source, a frame of the view, a photo on the wall and a shot of espresso are the rules' own.
    test.each([
      ["daylight", "as daylight fills the room"],
      ["captured", "captured from above"],
      ["selfie", "for a selfie"],
      ["snap", "in a quick snap"],
      ["timer", "while the timer counts down"],
      ["camera", "smiling into the camera"],
      ["lens", "close to the lens"],
      ["three-quarter", "in a three-quarter view"],
      ["world", "set in the world of the city"],
      ["slot", "as the slot says"],
    ])("«%s» is refused", (_, words) => {
      expect(problemsOf(bold(`In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties ${words}, a box of macarons on the nightstand.`))).toContain("label-word");
    });

    test("its refusal names the words it found, as our list writes them, never the sentence", () => {
      const read = bold("In her zanzibarquux hotel room in Paris, she lies back across the bed in a white lace bra and panties as Daylight fills the room, a timer on the nightstand.");
      expect(read.ok === false && read.boldWords?.["label-word"]).toEqual(["daylight", "timer"]);
      const told = read.ok ? "" : writerRefusalText(read);
      expect(told).toContain('slot(s) 1 wrote a word of the camera, the light or the slot\'s labels: "daylight", "timer"; write none of them');
      expect(told).not.toContain("zanzibarquux");
      expect(told).not.toContain("Daylight");
    });

    // Review round 3, LOW: the capture label's phrases.
    test.each([
      ["her own photo", "In her small hotel room in Paris, in her own photo, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["in the … shot", "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties in the timer shot, a box of macarons on the nightstand."],
      ["photo from above", "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, a photo from above, a box of macarons on the nightstand."],
    ])("the phrase «%s» is refused", (_, sentence) => {
      expect(problemsOf(bold(sentence))).toContain("label-word");
    });

    test.each([
      "as sunlight falls across the sheets",
      "in the sunshine from the window",
      "under the lamplight of the bedside lamp",
      "the window framing the rooftops",
      "beside a framed photo of the Seine",
      "with a shot of espresso on the nightstand",
    ])("«%s» is no label leak", (words) => {
      expect(problemsOf(bold(`In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, ${words}.`))).not.toContain("label-word");
    });

    test("the correct sentence passes, the viewer and her phone included", () => {
      expect(problemsOf(bold(GOOD))).toEqual([]);
      const mirror = routed({ location: "her bathroom", activity: "fixes her hair at the mirror", shot: "mirror", capture: "mirror-hidden", outfit: "a black lace bra and panties" });
      expect(problemsOf(bold("In the bathroom of her hotel room in Paris, she fixes her hair at the mirror in a black lace bra and panties, her phone over her face, a bottle of lotion by the tap.", mirror))).toEqual([]);
    });
  });

  describe("public-place: a slot with a world keeps her out of the world's public places", () => {
    const window = (world: string): PlanSlot => routed({ location: "her window", activity: "leans against the frame", shot: "friend", capture: "timer", pose: "profile", outfit: "a black lace bra and panties", world });

    test("the probe's W2:2: «in the seafood restaurant» is refused, its own world or not, her window right before it", () => {
      const slot = window("a seafood restaurant in the port");
      const sentences = [
        "She leans on the sill, looking out of her window in the seafood restaurant in the port, in a black lace bra and panties, her face turned to the side.",
        "she leans on the sill looking out her window in the seafood restaurant in the port while wearing a black lace bra and panties with her face turned fully to the side in profile.",
      ];
      for (const sentence of sentences) {
        const read = bold(sentence, slot);
        expect(problemsOf(read)).toContain("public-place");
        expect(read.ok === false && read.boldSlots?.["public-place"]).toEqual([1]);
      }
    });

    test("its refusal names the place it found, as our list writes it, never the sentence", () => {
      const read = bold("She leans against the frame in the Seafood Restaurant of zanzibarquux in a black lace bra and panties, her eyes on the boats.", window("a seafood restaurant in the port"));
      expect(read.ok === false && read.boldWords?.["public-place"]).toEqual(["restaurant"]);
      const told = read.ok ? "" : writerRefusalText(read);
      expect(told).toContain('slot(s) 1 put her in a public place: "restaurant"; keep her in the slot\'s location');
      expect(told).not.toContain("zanzibarquux");
    });

    test("«the cafe terrace» of her own world with no private word is refused", () => {
      expect(problemsOf(bold("At the cafe terrace in Paris, she lies back across her pillows in a white lace bra and panties, a croissant on the table beside her."))).toContain("public-place");
    });

    // Review round 3 (when in doubt, refuse): the world of her category is only the background; she is in her own room or the one she stays in, never at it. The
    // moments are the shared «rooms» bank's own.
    test.each([
      ["her room", "a cafe terrace in Paris", "lies back across the bed", "At the cafe terrace in Paris, she lies back across the bed in a white lace bra and panties."],
      ["her window", "a seafood restaurant in the port", "rests her forehead on the pane", "In the seafood restaurant in the port, she rests her forehead on the pane in a white lace bra and panties."],
      ["her balcony", "a cafe terrace in Paris", "leans on the railing in the sun", "On the cafe terrace in Paris, she leans on the railing in the sun in a white lace bra and panties."],
      ["her balcony", "a cafe terrace in Paris", "leans on the railing in the sun", "At the cafe terrace, she leans on the railing in the sun in a white lace bra and panties."],
      ["her sofa", "a hotel lobby lounge", "curls up with her knees in", "In the hotel lobby lounge, she curls up with her knees in in a white lace bra and panties."],
      ["her room", "a cafe terrace in Paris", "lies back across the bed", "She lies back across the bed in her hotel room in Paris in a white lace bra and panties, the morning at the cafe terrace still on her mind."],
      ["her room", "a beach club in Ibiza", "lies back across the bed", "At the beach club, she lies back across the bed in a white lace bra and panties."],
      ["her room", "a beach club in Ibiza", "lies back across the bed", "At the beach club bar, she lies back across the bed in a white lace bra and panties."],
      ["her room", "a cafe terrace in Paris", "lies back across the bed", "After dark at the bar, she lies back across the bed in a white lace bra and panties."],
      ["her room", "a cafe terrace in Paris", "lies back across the bed", "Following her friend into the bar, she lies back across the bed in a white lace bra and panties."],
      ["her room", "a cafe terrace in Paris", "lies back across the bed", "In her hotel room, she lies back across the bed in a white lace bra and panties, waving from her table at the cafe."],
    ])("%s in «%s»: refused, her place's word in it or not: %s / %s", (location, world, activity, sentence) => {
      const slot = routed({ location, world, activity, shot: "friend", capture: "timer", pose: "front" });
      expect(problemsOf(bold(sentence, slot))).toContain("public-place");
    });

    test.each(["on the street", "in a corner bistro", "at her office", "on the beach", "at the bakery counter"])("«%s», no place of her world, is refused away from the water", (where) => {
      expect(problemsOf(bold(`In her hotel room, she lies back across the bed in a white lace bra and panties, then ${where} a box of macarons sits beside her.`))).toContain("public-place");
    });

    // Review LOW (false passes): the place's own window, table or terrace, and its possessive.
    test.each([
      "By the window of the seafood restaurant in the port she leans against the frame in a black lace bra and panties, her eyes on the boats.",
      "She leans against the frame by the restaurant's window in a black lace bra and panties, her eyes on the boats outside.",
      "At a table of the corner bistro she leans against the frame in a black lace bra and panties, her eyes on the boats.",
      "She leans against the frame on the cafe's terrace in a black lace bra and panties, her eyes on the street below.",
    ])("the place's window, table or terrace, or its possessive, is refused: %s", (sentence) => {
      expect(problemsOf(bold(sentence, window("a seafood restaurant in the port")))).toContain("public-place");
    });

    // Review M2: a public noun that is no place she is in.
    test.each([
      ["a modifier: the beach house", "In the bedroom of the beach house she rents, she lies back across the bed in a white lace bra and panties, a shell on the nightstand."],
      ["a modifier: a market tote", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, flowers in a market tote on the chair."],
      ["a modifier: a bakery box", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, macarons in a bakery box on the nightstand."],
      ["her room right before «at the beach resort»", "In her room at the beach resort, she lies back across the bed in a white lace bra and panties, a shell on the nightstand."],
      ["her suite right before «at the beach club»", "In her suite at the beach club, she lies back across the bed in a white lace bra and panties, a shell on the nightstand."],
      ["her bungalow right before «at the beach club»", "In her bungalow at the beach club, she lies back across the bed in a white lace bra and panties, a shell on the nightstand."],
      ["a modifier: the hotel suite", "In the hotel suite in Paris, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["a modifier with a hyphen: beach-house", "In her beach-house bedroom, she lies back across the bed in a white lace bra and panties, a shell on the nightstand."],
      ["a modifier with a hyphen: street-facing", "In her room on the street-facing side, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["back from it: after a morning", "In her hotel room after a morning at the market, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["back from it: after a stop", "In her hotel room after a stop at the bakery, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["back from it: following lunch", "In her hotel room following lunch at the bistro, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["time spent there: back from a day", "Back from a day at the museum, she lies back across the bed in her hotel room in a white lace bra and panties, a box of macarons on the nightstand."],
      ["time spent there: having spent the morning", "She lies back across the bed in her hotel room in Paris in a white lace bra and panties, having spent the morning at the cafe terrace."],
      ["time spent there: after an evening in the bar", "In her hotel room after an evening in the bar, she lies back across the bed in a white lace bra and panties, a box of macarons on the nightstand."],
      ["a thing she brought back from it", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, a paper bag from the bakery on a side street on the nightstand."],
      ["a view: out at the street", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, looking out at the street from her pillow."],
      ["a view: out at the park", "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, her eyes out at the park beyond the glass."],
    ])("%s is no public place", (_, sentence) => {
      expect(problemsOf(bold(sentence))).not.toContain("public-place");
    });

    // The paid probe P-BA's 25-slot chunk (2026-10-26): real sentences the earlier rule refused for a public place they only came back from.
    test.each([
      ["a2", "her bathroom", "a cafe terrace in Paris", "She leans on the sink after a shower in her bathroom following time at a cafe terrace in Paris, morning daylight filling the space, in only a white bath towel with her free hand on the counter and face hidden in the mirror selfie."],
      ["a7", "her bathroom", "a cafe window seat at dusk", "She checks herself in the mirror in her bathroom after time at a cafe window seat at dusk, the evening lamps on and the sky outside already dim, in a white lace bra and panties in a three-quarter view with one hand free."],
      ["a8", "her room", "a corner bistro in Montmartre", "She stretches out on the covers in her room after a stop at a corner bistro in Montmartre, morning daylight coming in, in a satin camisole and shorts holding her phone above while facing the viewer in the shot from above."],
      ["a9", "her window", "a cafe window seat at dusk", "She stands by the curtain in her window after time at a cafe window seat at dusk, the evening lamps on and the sky outside already dim, in a white lace bra and panties with both hands empty on the timer shot in a three-quarter view."],
      ["a11", "her sofa", "a bakery on a side street", "She sits with her legs tucked under her on the sofa in her room after a stop at a bakery on a side street, a ceiling light on and a dark background, in a black lace bra and panties holding her phone above while facing the viewer."],
      ["a12", "her bathroom", "a cafe terrace in Paris", "She sits on the edge of the tub in her bathroom after time at a cafe terrace in Paris, the evening lamps on and the sky outside already dim, in only a white bath towel with both hands empty on the timer shot in profile."],
      ["a17", "her sofa", "a marina at sunset", "She curls up on the sofa in her room after time at a marina at sunset, a ceiling light on and a dark background, in a satin camisole and shorts with both hands empty on the timer shot in a three-quarter view."],
      ["a19", "her balcony", "a marina at sunset", "She leans on the railing in her balcony after time at a marina at sunset, the evening lamps on and the sky outside already dim, in a tee and cotton panties with both hands empty on the timer shot and face not visible from behind."],
      ["b4", "her sofa", "a bakery on a side street", "She curls up on the sofa in her room under the evening lamps with the sky outside already dim, her hands tucked around her knees as she turns slightly from the viewer, a paper bag from the bakery on a side street on the cushion next to her."],
      ["b11", "her sofa", "a bakery on a side street", "She sits with her legs tucked under her on the sofa in her room under a ceiling light with a dark background, holding her phone above her as she faces the viewer, a paper bag from the bakery on a side street beside her."],
    ])("P-BA chunk 25, %s: no public place", (_, location, world, sentence) => {
      expect(problemsOf(bold(sentence, routed({ location, world, activity: "a moment the probe hand-picked", outfit: "a white lace bra and panties" })))).not.toContain("public-place");
    });

    test("by the water the beach is her place; a bar there is not", () => {
      const slot = routed({ location: "a lounger by the water", activity: "lies back, soaking up the heat", outfit: "a white string bikini", shot: "friend", capture: "friend", world: "a beach near the harbour" });
      expect(problemsOf(bold("On the beach near the harbour, she lies back, soaking up the heat on a lounger by the water in a white string bikini, smiling at the viewer.", slot))).toEqual([]);
      expect(problemsOf(bold("At the beach bar near the harbour, she lies back, soaking up the heat by the water in a white string bikini, smiling at the viewer.", slot))).toContain("public-place");
    });

    // Review round 3, LOW: a water slot (the water branch, in swimwear) is at its world's water place: the beach, the beach club, the pool, the marina, the lido, the
    // sea, the lake. Its restaurant, bar and cafe are still public; so are the harbour, the pier, the promenade and the boardwalk (when in doubt, refuse).
    const lounger = (world: string): PlanSlot =>
      routed({ location: "a lounger by the water", activity: "lies back, soaking up the heat", outfit: "a white string bikini", shot: "friend", capture: "friend", world });
    test.each([
      ["a pool at the beach club", "By the pool at the beach club, she lies back, soaking up the heat on a lounger by the water in a white string bikini."],
      ["a marina at sunset", "At the marina, she lies back, soaking up the heat on a lounger by the water in a white string bikini."],
      ["a lido on the lake", "At the lido, she lies back, soaking up the heat on a lounger by the water of the lake in a white string bikini."],
      ["a yacht at anchor in a bay", "On the yacht, she lies back, soaking up the heat on a lounger by the water with the sea all around her in a white string bikini."],
    ])("a water slot (%s) is at its own water place", (world, sentence) => {
      expect(problemsOf(bold(sentence, lounger(world)))).not.toContain("public-place");
    });
    test.each([
      ["a pool at the beach club", "At the beach club restaurant, she lies back, soaking up the heat on a lounger by the water in a white string bikini."],
      ["a pool at the beach club", "In the cafe by the pool, she lies back, soaking up the heat on a lounger by the water in a white string bikini."],
      ["a beach near the harbour", "On the pier at the harbour, she lies back, soaking up the heat on a lounger by the water in a white string bikini."],
    ])("a water slot (%s) is still refused at a public place there", (world, sentence) => {
      expect(problemsOf(bold(sentence, lounger(world)))).toContain("public-place");
    });

    test("something she brought back from it is no place at all", () => {
      expect(problemsOf(bold(GOOD))).not.toContain("public-place");
      expect(problemsOf(bold("In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, a paper bag from the cafe terrace on the nightstand."))).not.toContain("public-place");
    });

    test("a slot without a world keeps its location as given, a cafe included", () => {
      const read = readBoldWriterAnswer(answer([{ slotIndex: 1, sentence: "At a corner cafe she sips a coffee in a beige trench coat and jeans, smiling at the viewer." }]), [unrouted()]);
      expect(problemsOf(read)).not.toContain("public-place");
    });
  });

  describe("moment-split: «she» and the moment, word for word and in one piece (the probe's W1:2 and W2:2)", () => {
    test("W1:2: «She leans on the sink in her bathroom … after a shower» is refused", () => {
      const slot = routed({ location: "her bathroom", activity: "leans on the sink after a shower", outfit: "only a white bath towel", shot: "mirror", capture: "mirror-hidden" });
      const read = bold("She leans on the sink in her bathroom in Paris after a shower, in only a white bath towel, a takeaway cup from the cafe terrace beside the tap.", slot);
      expect(problemsOf(read)).toEqual(["moment-split"]);
      expect(read.ok === false && read.boldSlots?.["moment-split"]).toEqual([1]);
    });

    test("W2:2: a moment that lost its comma is refused (the shipped «her window» moment with a comma)", () => {
      const slot = routed({ location: "her window", activity: "sits on the ledge, legs crossed", shot: "friend", capture: "timer", pose: "profile", outfit: "a black lace bra and panties" });
      expect(problemsOf(bold("By the window of her hotel room in Paris, she sits on the ledge legs crossed in a black lace bra and panties, a cup of tea beside her.", slot))).toEqual(["moment-split"]);
      expect(problemsOf(bold("By the window of her hotel room in Paris, she sits on the ledge, legs crossed, in a black lace bra and panties, a cup of tea beside her.", slot))).toEqual([]);
    });

    test("the moment kept whole passes, in any case at the start of the sentence", () => {
      expect(problemsOf(bold(GOOD))).toEqual([]);
      expect(problemsOf(bold("She lies back across the bed in her small hotel room in Paris in a white lace bra and panties, a box of macarons from the corner bakery on the nightstand."))).toEqual([]);
    });

    test("an activity that is no bank moment (an old custom slot) is not held to it", () => {
      const read = readBoldWriterAnswer(answer([{ slotIndex: 1, sentence: "At a corner cafe, sipping a coffee, she smiles at the viewer in a beige trench coat and jeans." }]), [unrouted()]);
      expect(problemsOf(read)).not.toContain("moment-split");
    });
  });
});

describe("the coverage sentence is appended after the read, once, by origin (§5.3.3 «After the read», I5.74)", () => {
  const LACE_KEPT = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
  const GOOD = "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling up at the viewer, a box of macarons from the corner bakery on the nightstand.";
  const TOWEL_SLOT = routed({ slotIndex: 2, location: "her bathroom", activity: "leans on the sink after a shower", outfit: "only a white bath towel", shot: "mirror", capture: "mirror-hidden" });
  const TOWEL = "In the bathroom of her hotel room in Paris, she leans on the sink after a shower in only a white bath towel, a bottle of lotion by the tap.";
  const count = (text: string, part: string): number => text.split(part).length - 1;
  const sentencesOf = (read: WriterAnswer): Map<number, string> => (read.ok ? read.sentences : (read.repair?.accepted ?? new Map()));

  test("an imported avatar, or one of unknown origin (the default), gets the outfit's kept sentence", () => {
    const read = boldReader()(answer([{ slotIndex: 1, sentence: GOOD }]), [routed()]);
    expect(sentencesOf(read).get(1)).toBe(`${GOOD} ${LACE_KEPT}`);
    expect(boldReader(false)(answer([{ slotIndex: 1, sentence: GOOD }]), [routed()])).toEqual(read);
  });

  test("a Studio-created avatar gets the open one: none for lace (P-BA drew it open), the descriptive one for the towel (P-BA B1)", () => {
    const read = boldReader(true)(
      answer([
        { slotIndex: 1, sentence: GOOD },
        { slotIndex: 2, sentence: TOWEL },
      ]),
      [routed(), TOWEL_SLOT],
    );
    expect(sentencesOf(read).get(1)).toBe(GOOD);
    expect(sentencesOf(read).get(2)).toBe(`${TOWEL} ${COVER.towelOpen}`);
    expect(sentencesOf(boldReader(false)(answer([{ slotIndex: 2, sentence: TOWEL }]), [TOWEL_SLOT])).get(2)).toBe(`${TOWEL} ${COVER.towel}`);
  });

  test("a slot of no «Смелая» bank (an old custom slot in a bold chunk) gets none", () => {
    const sentence = "At a corner cafe she sips a coffee in a beige trench coat and jeans, smiling at the viewer.";
    expect(sentencesOf(boldReader()(answer([{ slotIndex: 1, sentence }]), [unrouted()])).get(1)).toBe(sentence);
  });

  test("a refused answer's kept sentences carry it too, and a slot asked again gets it once more: once each", () => {
    const first = boldReader()(
      answer([
        { slotIndex: 1, sentence: GOOD },
        { slotIndex: 2, sentence: "She leans on the sink in her bathroom after a shower in only a white bath towel." },
      ]),
      [routed(), TOWEL_SLOT],
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.repair?.marked).toEqual([2]);
    const second = boldReader()(answer([{ slotIndex: 2, sentence: TOWEL }]), [TOWEL_SLOT]);
    const all = new Map([...sentencesOf(first), ...sentencesOf(second)]);
    expect(count(all.get(1) ?? "", LACE_KEPT)).toBe(1);
    expect(count(all.get(2) ?? "", COVER.towel)).toBe(1);
    expect(all.get(2)).toBe(`${TOWEL} ${COVER.towel}`);
  });

  test("a sentence that ends without its full stop gets one before the coverage", () => {
    const read = boldReader()(answer([{ slotIndex: 1, sentence: GOOD.slice(0, -1) }]), [routed()]);
    expect(sentencesOf(read).get(1)).toBe(`${GOOD} ${LACE_KEPT}`);
  });

  test("the reader reads the model's sentence, never the coverage: a refusal is the bold reader's own", () => {
    const bad = answer([{ slotIndex: 1, sentence: "At the cafe terrace in Paris, she lies on the rug topless." }]);
    expect(boldReader()(bad, [routed()])).toEqual(readBoldWriterAnswer(bad, [routed()]));
  });
});

describe("an old slot whose moment the bank renamed keeps its kept coverage (review M1, I5.74, fail-closed)", () => {
  const SHEET_KEPT = "The white sheet is pulled up to her chest and fully covers her breasts and her hips.";
  /** A «Смелая» nightwear scene stored before r2.2 P3 reworded its moment («lies holding the sheet to her chest» is now «lies with the sheet up to her chest»). */
  const oldSheet = (): PlanSlot => ({
    slotIndex: 1,
    category: "nightwear",
    location: "her bed",
    timeOfDay: "night",
    activity: "lies holding the sheet to her chest",
    outfit: "only the white bedsheet",
    shot: "selfie",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    capture: "above",
    level: "bold",
    route: "seedream",
  });
  const SAID = "She lies holding the sheet to her chest on her bed, a glass of water on the nightstand.";
  const read = (impliedNudity: boolean, slot: PlanSlot, sentence: string): string | undefined => {
    const answered = boldReader(impliedNudity)(answer([{ slotIndex: slot.slotIndex, sentence }]), [slot]);
    return answered.ok ? answered.sentences.get(slot.slotIndex) : undefined;
  };
  const count = (text: string, part: string): number => text.split(part).length - 1;

  test("the bank still has her place and the sheet, but no longer the moment", () => {
    const slot = oldSheet();
    const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
    expect(hit?.place.name).toBe("her bed");
    expect(hit?.moment).toBeUndefined();
    expect(hit?.bank.outfits.find((o) => o.text === slot.outfit)?.coverage).toBeUndefined();
  });

  test.each([false, true])("its rewrite ends with the sheet's kept sentence, once (impliedNudity %p)", (impliedNudity) => {
    expect(read(impliedNudity, oldSheet(), SAID)).toBe(`${SAID} ${SHEET_KEPT}`);
  });

  test.each([false, true])("so does its plain sentence (impliedNudity %p)", (impliedNudity) => {
    const plain = plainSentence(oldSheet(), impliedNudity);
    expect(plain).toEndWith(` ${SHEET_KEPT}`);
    expect(count(plain, SHEET_KEPT)).toBe(1);
  });

  test("an old slot always says the kept sentence, even where the open one differs (the towel, a Studio-created avatar)", () => {
    const slot = routed({ location: "her bathroom", activity: "dries off by the basin", outfit: "only a white bath towel", shot: "mirror", capture: "mirror-hidden" });
    expect(bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity })?.moment).toBeUndefined();
    const sentence = "In the bathroom of her hotel room in Paris, she dries off by the basin in only a white bath towel, a bottle of lotion by the tap.";
    expect(read(true, slot, sentence)).toBe(`${sentence} ${COVER.towel}`);
    expect(plainSentence(slot, true)).toEndWith(` ${COVER.towel}`);
    expect(slotCoverageOf(slot, true)).toBe(COVER.towel);
  });

  test("a slot whose moment the bank has keeps today's rule: the open sentence for a Studio-created avatar", () => {
    const slot = routed({ location: "her bathroom", activity: "leans on the sink after a shower", outfit: "only a white bath towel", shot: "mirror", capture: "mirror-hidden" });
    expect(slotCoverageOf(slot, true)).toBe(COVER.towelOpen);
    expect(slotCoverageOf(slot, false)).toBe(COVER.towel);
    expect(slotCoverageOf(routed(), true)).toBeUndefined();
  });

  test("an outfit no «Смелая» bank holds (an old cotton outfit, an old custom slot) says none", () => {
    expect(slotCoverageOf({ ...oldSheet(), activity: "lies back against the pillows", outfit: "an oversized sleep tee", route: undefined }, false)).toBeUndefined();
    expect(slotCoverageOf(unrouted(), false)).toBeUndefined();
  });

  describe("fail-closed: a Seedream outfit never goes out without a sentence", () => {
    const banks: [string, CategoryBank][] = [
      ["nightwear", BANKS.nightwear],
      ["beach", BANKS.beach],
      ...Object.entries(BOLD_COMPANIONS),
      ...Object.entries(CUSTOM_BOLD_BANKS),
    ];

    test("every Seedream outfit of every «Смелая» bank finds a kept sentence in its own bank's data, with its moment unknown", () => {
      const missing = banks.flatMap(([name, bank]) =>
        bank.outfits.filter((o) => o.route === "seedream").flatMap((o) => {
          const kept = coverageOfWorn(bank, undefined, o, false);
          return kept === undefined || kept === KEPT_FALLBACK ? [`${name}: ${o.text}`] : [];
        }),
      );
      expect(missing).toEqual([]);
      expect(banks.reduce((n, [, bank]) => n + bank.outfits.filter((o) => o.route === "seedream").length, 0)).toBeGreaterThan(40);
    });

    // A bank whose data says nothing for a Seedream outfit (a broken edit): the fail-closed sentence, for every avatar, never none.
    const silent: CategoryBank = {
      bold: true,
      places: [{ name: "her room", at: "in her room", details: ["a lamp"], times: ["night"], moments: [{ text: "lies back", motion: "she turns her head a little", captures: ["above"], twoHanded: false }] }],
      outfits: [{ text: "a lace set", route: "seedream", level: "flirty" }],
      captureDeck: ["above"],
    };

    test.each([false, true])("a Seedream outfit its bank says nothing for gets the fail-closed kept sentence (impliedNudity %p)", (impliedNudity) => {
      const outfit = silent.outfits[0];
      if (outfit === undefined) throw new Error("the fixture has its outfit");
      expect(coverageOfWorn(silent, undefined, outfit, impliedNudity)).toBe(KEPT_FALLBACK);
      expect(coverageOfWorn(silent, silent.places[0]?.moments[0], outfit, impliedNudity)).toBe(KEPT_FALLBACK);
    });

    test("an outfit off the route says none, as before", () => {
      expect(coverageOfWorn(silent, undefined, { text: "a cotton tee" }, false)).toBeUndefined();
    });

    test("the fail-closed sentence is restrictive and says no exposure word", () => {
      expect(KEPT_FALLBACK).toMatch(/fully covers/);
      expect(exposureWordsIn(KEPT_FALLBACK)).toEqual([]);
    });
  });
});

describe("the final check's five rows (S5.BA4, before the merge)", () => {
  const bold = (sentence: string, slot: PlanSlot = routed()): WriterAnswer => readBoldWriterAnswer(answer([{ slotIndex: slot.slotIndex, sentence }]), [slot]);
  const room = routed({ shot: "friend", capture: "timer" });
  const yachtLounger = routed({ location: "a lounger by the water", activity: "lies back, soaking up the heat", outfit: "a white string bikini", shot: "friend", capture: "friend", world: "a yacht at anchor in the harbour" });

  test.each([
    // 1. «spending» is the present: she is there now.
    ["1", "public-place", "Spending the evening at the bar, she lies back across the bed in a white lace bra and panties.", room],
    ["1", "public-place", "Spending the morning at the cafe terrace, she lies back across the bed in a white lace bra and panties.", room],
    // 2. «stopping» without «after» or «following» is the present too.
    ["2", "public-place", "Stopping at the bar, she lies back across the bed in a white lace bra and panties.", room],
    // 3. after a thing she brought, only «on» names where it came from; «at» and «in» name where she is.
    ["3", "public-place", "Holding a croissant from the bakery at the cafe terrace, she lies back across the bed in a white lace bra and panties.", room],
    ["3", "public-place", "With a cup from the cafe at the bar, she lies back across the bed in a white lace bra and panties.", room],
    // 4. the harbour alone is public, for a water slot too.
    ["4", "public-place", "In the harbour, she lies back, soaking up the heat on a lounger by the water in a white string bikini.", yachtLounger],
    // 5. a shot that is the photo's is still a leak.
    ["5", "label-word", "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties in the wide shot, a box of macarons on the nightstand.", room],
  ] as const)("item %s refuses (%s): %s", (_, problem, sentence, slot) => {
    expect(problemsOf(bold(sentence, slot))).toContain(problem);
  });

  test.each([
    // 2. «after stopping at a bakery on a side street»: the probe's chunk, row a4.
    ["2", "public-place", "She curls up on the sofa in her room after stopping at a bakery on a side street, the evening lamps on and the sky outside already dim, in a white lace bra and panties with both hands empty on the timer shot in a three-quarter view.", routed({ location: "her sofa", world: "a bakery on a side street", activity: "a moment the probe hand-picked" })],
    // 3. «on» after the thing: the probe's chunk, rows b4 and b11.
    ["3", "public-place", "She curls up on the sofa in her room under the evening lamps with the sky outside already dim, her hands tucked around her knees as she turns slightly from the viewer, a paper bag from the bakery on a side street on the cushion next to her.", routed({ location: "her sofa", world: "a bakery on a side street", activity: "a moment the probe hand-picked" })],
    ["3", "public-place", "She sits with her legs tucked under her on the sofa in her room under a ceiling light with a dark background, holding her phone above her as she faces the viewer, a paper bag from the bakery on a side street beside her.", routed({ location: "her sofa", world: "a bakery on a side street", activity: "a moment the probe hand-picked" })],
    // 4. the harbour right after the yacht, the boat or the deck: where the yacht is.
    ["4", "public-place", "On the deck of the yacht in the harbour, she lies back, soaking up the heat on a lounger by the water in a white string bikini.", yachtLounger],
    // 5. a shot glass and a shot of espresso are no photo.
    ["5", "label-word", "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, a whisky in the shot glass on the nightstand.", room],
    ["5", "label-word", "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, on the shot of espresso she brought up.", room],
  ] as const)("item %s passes (no %s): %s", (_, problem, sentence, slot) => {
    expect(problemsOf(bold(sentence, slot))).not.toContain(problem);
  });
});

// The widest of each value the bold slot JSON sends, read from the tables themselves.
const longestOf = (values: readonly string[]): string => values.reduce((a, b) => (b.length > a.length ? b : a));
const WORST_CAPTURE = (Object.keys(CAPTURE_LABEL) as (keyof typeof CAPTURE_LABEL)[]).reduce((a, b) => (CAPTURE_LABEL[b].length > CAPTURE_LABEL[a].length ? b : a));
const WORST_TIME = [...POOL_TIMES, "a time the table does not know"].reduce((a, b) => (timeWordOf(b).length > timeWordOf(a).length ? b : a));
const WORST_POSE = longestOf(["front", "three-quarter", "profile", "back"]) as PlanSlot["pose"];

describe("WRITER_BOLD_CALL's ceiling covers the worst bold chunk (r2.2 P4, the bold floor pin)", () => {
  /** What the reserve keeps clear of the ceiling, as the ordinary pins do. */
  const MARGIN = 250;
  // 3 961 with today's ten reasons (S5.BA4); 3 185 with every bold reason; 2 954 since label-word and public-place name the words they found (round 2).
  const MARGIN_PRINTED = 2_954;
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
      problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction", "phone-in-selfie", ...BOLD_PROBLEMS],
      missingSlots: rest,
      twoHandedSlots: rest,
      wordSlots: rest,
      poseSlots: rest,
      phoneSlots: rest,
      words: hostileWords,
      boldSlots: Object.fromEntries(BOLD_PROBLEMS.map((problem) => [problem, rest])),
      // S5.BA4 round 2: label-word and public-place name the words they found, clipped as the youth and revealing words are.
      boldWords: { "label-word": hostileWords, "public-place": hostileWords },
    };
  }

  const floorOf = (slots: readonly PlanSlot[]): number => promptTokenFloor({ messages: writerBoldMessages(slots, worstRefusal(slots)), jsonSchema: WRITER_JSON_SCHEMA, images: 0 });

  test("the two bold reasons that name a word tell REFUSAL_WORDS_MAX of them at most, each clipped to REFUSAL_WORD_BYTES_MAX bytes", () => {
    const text = writerRefusalText(worstRefusal(worstSlots(POOL_TEXT_MAX)));
    for (const lead of ["of the camera, the light or the slot's labels: ", "put her in a public place: "]) {
      const reason = text.slice(text.indexOf(lead) + lead.length).split("; ")[0] ?? "";
      const told = [...reason.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
      expect(told).toHaveLength(REFUSAL_WORDS_MAX);
      for (const word of told) expect(Buffer.byteLength(word, "utf8")).toBe(REFUSAL_WORD_BYTES_MAX);
    }
  });

  test("the worst refusal carries every reason: today's ten, revealing-word included, and every bold one, each with its slot list", () => {
    const refusal = worstRefusal(worstSlots(POOL_TEXT_MAX));
    const text = writerRefusalText(refusal);
    expect(new Set(refusal.problems).size).toBe(10 + BOLD_PROBLEMS.length);
    const rest = worstSlotList(worstSlots(POOL_TEXT_MAX).map((s) => s.slotIndex));
    for (const problem of BOLD_PROBLEMS) {
      const alone = writerRefusalText({ problems: [problem], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [], boldSlots: { [problem]: rest }, boldWords: refusal.boldWords ?? {} });
      expect(alone).toStartWith(`slot(s) ${slotList(rest)} `);
      expect(text).toContain(alone);
    }
    expect(BOLD_PROBLEMS).toEqual(["place-missing", "outfit-missing", "exposure-word", "label-word", "public-place", "moment-split"]);
  });

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

describe("writerRunPrice prices the writer by its mode, through writerCallOf (r2.1 L2)", () => {
  const book = PriceBook.fallback();

  test("bold: chunks × 2 attempts × the bold attempt (48 750 µ$), the reasoning allowance included", () => {
    expect(writerAttemptWorstMicros(book, writerCallOf("bold"))).toBe(48_750);
    expect(writerRunPrice(book, 0, "bold").worstMicros).toBe(0);
    expect(writerRunPrice(book, 1, "bold").worstMicros).toBe(97_500);
    expect(writerRunPrice(book, 25, "bold").worstMicros).toBe(97_500);
    expect(writerRunPrice(book, 26, "bold").worstMicros).toBe(195_000);
  });

  test("bold: expected at the bold call's typical tokens, one request a chunk", () => {
    for (const slots of [1, 20, 25, 26, 100]) {
      expect(writerRunPrice(book, slots, "bold").expectedMicros).toBe(writerExpectedMicros(book, writerCallOf("bold"), Math.ceil(slots / 25), slots));
    }
  });

  test("ordinary: today's figures, byte for byte", () => {
    expect(writerRunPrice(book, 25, "ordinary")).toEqual({ expectedMicros: 11_438, worstMicros: 75_000, priceSource: "fallback" });
    expect(writerRunPrice(book, 100, "ordinary")).toEqual({ expectedMicros: 45_750, worstMicros: 300_000, priceSource: "fallback" });
  });
});
