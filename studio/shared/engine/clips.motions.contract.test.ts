import { describe, expect, test } from "bun:test";
import {
  CLIP_CHOICES_MAX,
  CLIP_MOTIONS_MAX,
  ClipFrameReading,
  ClipMotion,
  ClipMotionChoice,
  ClipMotionId,
  ClipOptions,
  ClipSuggestResult,
  ClipTranslateResult,
  MOTION_ID_MAX,
  MOTION_LABEL_MAX,
  MOTION_MAX_ATTEMPTS,
  MOTION_MIN_SHOWN_MICROS,
  MOTION_PROBLEMS,
  MOTION_STORE_MAX_ITEMS,
  MOTION_SUGGEST_EXPECTED_MICROS,
  MOTION_SUGGEST_WORST_MICROS,
  MOTION_TEXT_MAX,
  MOTION_TRANSLATE_EXPECTED_MICROS,
  MOTION_TRANSLATE_WORST_MICROS,
  MotionProblem,
  OWN_IDEA_FALLBACK_LABEL,
  OWN_IDEA_MAX,
  OwnIdeaText,
  motionCostShownMicros,
  ownIdeaLabel,
} from "./index";
import { formatUsdTiered } from "./usd";
import { CLIP_IN_FLIGHT_REASONS, CLIP_REASONS, EngineError } from "./errors";
import { CLIP_REASONS_RU, MOTION_PROBLEMS_RU } from "./errorMessagesRu";
import { COMMAND_TYPES, ENGINE_COMMAND_TYPES, MAIN_ONLY_COMMANDS, OkResponse } from "./commands";
import { SLEEP_CLASS } from "./commandHold";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";

// Stage 5, 5b.2, S5.WC1 (plan s5b2 §5.3, I5.66-I5.68, §8 «S5.WC1 contract C»; Q-H = 2): the contract of part C «свои движения»: the vision writer's suggestions and the owner's own idea. Four commands, the
// motion id forms `v-<n>` and `o-<n>`, the sources `vision` and `own`, `ClipFrameReading`, the results, `MotionProblem` and its texts, and the reasons `motion-busy`, `suggest-busy` and `idea-busy`.
// Everything is additive in protocol 5: each shape is tried in its old form first.

const AVATAR = "avatar-aaaa-0001";
const PHOTO = "photo-0001";

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

const estimate = (expectedMicros: number, worstMicros: number) => ({ expectedMicros, worstMicros, prices: "live" as const, pricesAsOf: "2026-10-15" });
const scene = { id: "scene", source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" };
const code = (n: number) => ({ id: `g-code-${n}`, source: "code", label: `Код ${n}`, text: "she blinks and smiles a little" });
const vision = (n: number) => ({ id: `v-${n}`, source: "vision", label: `Предложено ${n}`, text: "she gently blows on her tea" });
const own = (n: number) => ({ id: `o-${n}`, source: "own", label: "медленно поворачивает голову…", text: "she slowly turns her head toward a sound" });
const reading = { notes: ["capture-differs", "second-phone"] };

const prices = { std5: estimate(420_000, 850_000), pro5: estimate(560_000, 850_000), std10: estimate(840_000, 1_550_000), pro10: estimate(1_120_000, 1_550_000), grok5: estimate(710_000, 850_000), grok10: estimate(1_410_000, 1_550_000) };
const noFallbackPrices = { std5: estimate(420_000, 504_000), pro5: estimate(560_000, 672_000), std10: estimate(840_000, 924_000), pro10: estimate(1_120_000, 1_232_000) };
const fits = { std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" };
const optionsWith = (motions: unknown[]) => ({ suitable: true, photoId: PHOTO, motions, prices, fallback: "auto", bold: false, noFallbackPrices, monthFits: fits });

// ---------- the id forms and the sources ----------

describe("ClipMotionId v-<1..99> and o-<1..99>", () => {
  test("takes the vision and own forms from 1 to 99", () => {
    for (const id of ["v-1", "v-9", "v-10", "v-99", "o-1", "o-42", "o-99", "v-100", "o-999"]) expect(ClipMotionId.safeParse(id).success).toBe(true);
  });

  // L2 (review round 2): ids are never reused while a store lives, so the range is 1..999 (a photo would reach 99 after thirty-odd suggestions); see MOTION_ID_MAX.
  test("the range is 1 to 999", () => {
    expect(MOTION_ID_MAX).toBe(999);
    expect(ClipMotionId.safeParse("v-999").success).toBe(true);
    expect(ClipMotionId.safeParse("v-1000").success).toBe(false);
    expect(ClipMotionId.safeParse("o-1000").success).toBe(false);
  });

  test("refuses 0, 1000, a leading zero, a missing number and other letters", () => {
    for (const id of ["v-0", "o-0", "v-1000", "o-1000", "v-01", "o-007", "v-", "o-", "v-1a", "V-1", "x-1", "v1", "v-1-2", "v--1"]) expect(ClipMotionId.safeParse(id).success).toBe(false);
  });

  test("keeps `scene` and `g-<slug>` as they were", () => {
    expect(ClipMotionId.safeParse("scene").success).toBe(true);
    expect(ClipMotionId.safeParse("g-blink-smile").success).toBe(true);
    expect(ClipMotionId.safeParse("g-").success).toBe(false);
  });
});

describe("ClipMotionChoice with the sources vision and own", () => {
  test("a vision motion has a v- id and an own motion an o- id", () => {
    expect(ClipMotionChoice.safeParse(vision(1)).success).toBe(true);
    expect(ClipMotionChoice.safeParse(own(1)).success).toBe(true);
  });

  test("the id and the source go together: no other pairing parses", () => {
    expect(ClipMotionChoice.safeParse({ ...vision(1), id: "o-1" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...own(1), id: "v-1" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...vision(1), id: "g-blink" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...vision(1), id: "scene" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code(1), id: "v-1" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code(1), id: "o-1" }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...scene, source: "vision" }).success).toBe(false);
  });

  test("a vision or own text is at most 60 characters, a code text keeps its 120", () => {
    expect(MOTION_TEXT_MAX).toBe(60);
    expect(ClipMotionChoice.safeParse({ ...vision(1), text: "a".repeat(60) }).success).toBe(true);
    expect(ClipMotionChoice.safeParse({ ...vision(1), text: "a".repeat(61) }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...own(1), text: "a".repeat(61) }).success).toBe(false);
    expect(ClipMotionChoice.safeParse({ ...code(1), text: "a".repeat(61) }).success).toBe(true);
  });

  test("a vision or own text is printable ASCII, because it goes to the video provider as it is (I5.67)", () => {
    for (const text of ["она медленно поворачивает голову", "she smiles\nand turns", "she smiles\tslowly", "she smiles — slowly", "she turns her head\u0000"]) {
      expect(ClipMotionChoice.safeParse({ ...own(1), text }).success).toBe(false);
      expect(ClipMotionChoice.safeParse({ ...vision(1), text }).success).toBe(false);
    }
  });

  // L8 (review round 2): the set is narrowed to what the 271 bank motions and the 7 code motions use (letters, a space, a comma; checked in engine/clips/motionCharset.test.ts), plus digits and `.'-`.
  test("a vision or own text uses letters, digits, spaces and , . ' - only", () => {
    for (const text of ["she smiles, then looks away.", "she lifts her mother's cup", "she turns her head 20 degrees", "she slowly lifts her hips - and lowers them"]) {
      expect(ClipMotionChoice.safeParse({ ...own(1), text }).success).toBe(true);
    }
    for (const text of ["she smiles!", "she smiles <b>", "she says \"hi\"", "she smiles; slowly", "she smiles (a lot)", "she waves {{x}}", "she smiles / waves", "she smiles ~ slowly", "she\\ smiles"]) {
      expect(ClipMotionChoice.safeParse({ ...own(1), text }).success).toBe(false);
      expect(ClipMotionChoice.safeParse({ ...vision(1), text }).success).toBe(false);
    }
  });

  test("the motion a clip was made with holds a vision or own text to the same 60 characters and charset, and a code text to 120", () => {
    const record = (source: string, text: string) => ClipMotion.safeParse({ source, label: "Движение", text }).success;
    expect(record("own", "a".repeat(60))).toBe(true);
    expect(record("own", "a".repeat(61))).toBe(false);
    expect(record("vision", "a".repeat(61))).toBe(false);
    expect(record("own", "she smiles!")).toBe(false);
    expect(record("vision", "она улыбается")).toBe(false);
    expect(record("code", "a".repeat(120))).toBe(true);
    expect(record("scene", "she smiles! Свет")).toBe(true);
  });

  test("a label is at most 40 characters for the new sources too", () => {
    expect(MOTION_LABEL_MAX).toBe(40);
    expect(ClipMotionChoice.safeParse({ ...own(1), label: "я".repeat(40) }).success).toBe(true);
    expect(ClipMotionChoice.safeParse({ ...own(1), label: "я".repeat(41) }).success).toBe(false);
  });

  test("the motion a clip was made with takes the two new sources and no other", () => {
    for (const source of ["scene", "code", "vision", "own"]) expect(ClipMotion.safeParse({ source, label: "Движение", text: "she blinks" }).success).toBe(true);
    expect(ClipMotion.safeParse({ source: "llm", label: "Движение", text: "she blinks" }).success).toBe(false);
  });
});

// ---------- ClipOptions.motions ----------

describe("ClipOptions.motions up to nine, with a limit per source", () => {
  test("the limits are scene 1, code 3, vision 3, own 2, and their sum is nine", () => {
    expect(CLIP_CHOICES_MAX).toEqual({ scene: 1, code: 3, vision: 3, own: 2 });
    expect(CLIP_MOTIONS_MAX).toBe(9);
  });

  test("a full list of nine parses", () => {
    const nine = [scene, code(1), code(2), code(3), vision(1), vision(2), vision(3), own(1), own(2)];
    expect(ClipOptions.safeParse(optionsWith(nine)).success).toBe(true);
  });

  test("a list with the old shape (a scene motion and codes) still parses", () => {
    expect(ClipOptions.safeParse(optionsWith([scene, code(1), code(2), code(3)])).success).toBe(true);
    expect(ClipOptions.safeParse(optionsWith([scene])).success).toBe(true);
  });

  test("a fourth vision motion is refused, though nine is not passed", () => {
    expect(ClipOptions.safeParse(optionsWith([scene, vision(1), vision(2), vision(3), vision(4)])).success).toBe(false);
  });

  test("a third own motion is refused", () => {
    expect(ClipOptions.safeParse(optionsWith([scene, own(1), own(2), own(3)])).success).toBe(false);
  });

  test("a fourth code motion is refused", () => {
    expect(ClipOptions.safeParse(optionsWith([scene, code(1), code(2), code(3), code(4)])).success).toBe(false);
  });

  test("ten motions are refused", () => {
    const ten = [scene, code(1), code(2), code(3), vision(1), vision(2), vision(3), own(1), own(2), own(3)];
    expect(ClipOptions.safeParse(optionsWith(ten)).success).toBe(false);
  });

  test("the order is scene, code, vision, own: a vision motion before a code one is refused", () => {
    expect(ClipOptions.safeParse(optionsWith([scene, vision(1), code(1)])).success).toBe(false);
    expect(ClipOptions.safeParse(optionsWith([scene, own(1), vision(1)])).success).toBe(false);
    expect(ClipOptions.safeParse(optionsWith([code(1), scene])).success).toBe(false);
  });

  test("an id does not repeat across the sources either", () => {
    expect(ClipOptions.safeParse(optionsWith([scene, vision(1), vision(1)])).success).toBe(false);
  });

  test("an empty list is still refused", () => {
    expect(ClipOptions.safeParse(optionsWith([])).success).toBe(false);
  });

  // L5 (review round 2): a reopened sheet shows the stored frame notes (mockup 62d).
  test("a suitable photo may carry the stored frame reading", () => {
    expect(ClipOptions.safeParse({ ...optionsWith([scene]), reading }).success).toBe(true);
    expect(ClipOptions.safeParse({ ...optionsWith([scene]), reading: { notes: [] } }).success).toBe(true);
    expect(ClipOptions.safeParse(optionsWith([scene])).success).toBe(true);
    expect(ClipOptions.safeParse({ ...optionsWith([scene]), reading: { notes: ["other"] } }).success).toBe(false);
  });

  test("an unsuitable photo carries no reading", () => {
    expect(ClipOptions.safeParse({ suitable: false, photoId: PHOTO, reason: "no-motion", reading }).success).toBe(false);
  });
});

// ---------- the four commands ----------

const PART_C = ["clips.estimateSuggest", "clips.suggestMotions", "clips.estimateIdea", "clips.translateIdea"] as const;
const suggestPayload = { avatarId: AVATAR, photoId: PHOTO, acceptedWorstMicros: 12_500 };
const translatePayload = { avatarId: AVATAR, photoId: PHOTO, text: "медленно поворачивает голову, прислушиваясь к шуму за окном", acceptedWorstMicros: 5_000 };

describe("the four part C commands exist", () => {
  test("all four are engine commands, none is main's", () => {
    for (const type of PART_C) {
      expect(COMMAND_TYPES).toContain(type);
      expect(ENGINE_COMMAND_TYPES as readonly string[]).toContain(type);
      expect(MAIN_ONLY_COMMANDS as readonly string[]).not.toContain(type);
    }
  });

  test("the two estimates are free and take a photo only: no text, no accepted worst", () => {
    for (const type of ["clips.estimateSuggest", "clips.estimateIdea"]) {
      expect(accepts(type, { avatarId: AVATAR, photoId: PHOTO })).toBe(true);
      expect(accepts(type, { avatarId: AVATAR })).toBe(false);
      expect(accepts(type, { avatarId: AVATAR, photoId: PHOTO, acceptedWorstMicros: 1 })).toBe(false);
      expect(accepts(type, { avatarId: AVATAR, photoId: PHOTO, text: "she waves" })).toBe(false);
    }
  });

  test("the estimates answer an Estimate", () => {
    for (const type of ["clips.estimateSuggest", "clips.estimateIdea"]) {
      expect(answers(type, estimate(3_400, 12_500))).toBe(true);
      expect(answers(type, { expectedMicros: 3_400 })).toBe(false);
    }
  });

  test("suggestMotions is accepted like create: a photo and the accepted worst case, nothing else", () => {
    expect(accepts("clips.suggestMotions", suggestPayload)).toBe(true);
    expect(accepts("clips.suggestMotions", { avatarId: AVATAR, photoId: PHOTO })).toBe(false);
    expect(accepts("clips.suggestMotions", { ...suggestPayload, acceptedWorstMicros: -1 })).toBe(false);
    expect(accepts("clips.suggestMotions", { ...suggestPayload, text: "she waves" })).toBe(false);
  });

  test("translateIdea takes the photo, the owner's text and the accepted worst case", () => {
    expect(accepts("clips.translateIdea", translatePayload)).toBe(true);
    expect(accepts("clips.translateIdea", { ...translatePayload, acceptedWorstMicros: undefined })).toBe(false);
    expect(accepts("clips.translateIdea", { ...translatePayload, extra: 1 })).toBe(false);
    expect(accepts("clips.translateIdea", { avatarId: AVATAR, photoId: PHOTO, acceptedWorstMicros: 5_000 })).toBe(false);
  });
});

describe("the owner's idea text", () => {
  const ok = (text: string): boolean => accepts("clips.translateIdea", { ...translatePayload, text });

  test("is 1 to 300 characters", () => {
    expect(OWN_IDEA_MAX).toBe(300);
    expect(ok("а")).toBe(true);
    expect(ok("я".repeat(300))).toBe(true);
    expect(ok("я".repeat(301))).toBe(false);
    expect(ok("")).toBe(false);
  });

  test("is not blank", () => {
    expect(ok("   ")).toBe(false);
    expect(ok(" а ")).toBe(true);
  });

  test("holds no control character: a newline, a tab, NUL, escape and DEL are refused", () => {
    for (const bad of ["a\nb", "a\r\nb", "a\tb", "a\u0000b", "a\u001bb", "a\u007fb", "a\u0085b"]) expect(ok(bad)).toBe(false);
  });

  // L7 (review round 2): an idea needs a letter and holds no format character (zero-width, bidi override).
  test("needs at least one letter", () => {
    for (const bad of ["123", "!!!", "...", "😀", "​", " 5 — 6 "]) expect(ok(bad)).toBe(false);
    for (const good of ["ё", "a", "поворачивает 2 раза", "turn 1"]) expect(ok(good)).toBe(true);
  });

  test("refuses format characters: zero-width space, joiner, bidi override, BOM", () => {
    for (const bad of ["a​b", "​", "a‍b", "abc‮def", "a⁦b", "﻿abc", "a­b"]) expect(ok(bad)).toBe(false);
  });

  test("takes spaces, punctuation, Cyrillic and a quote", () => {
    expect(ok("медленно, не спеша: «поправляет» прядь — и улыбается.")).toBe(true);
  });

  test("the schema is the one the command uses", () => {
    expect(OwnIdeaText.safeParse("она улыбается").success).toBe(true);
    expect(OwnIdeaText.safeParse("a\nb").success).toBe(false);
  });
});

describe("no clip command payload has a motion text field (I5.67)", () => {
  const createPayload = { avatarId: AVATAR, photoId: PHOTO, motionId: "o-1", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 };
  const batchPayload = { avatarId: AVATAR, items: [{ photoId: PHOTO, motionId: "v-2" }], quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 };

  test("clips.create and clips.createBatch carry the new ids", () => {
    expect(accepts("clips.create", createPayload)).toBe(true);
    expect(accepts("clips.createBatch", batchPayload)).toBe(true);
  });

  test("clips.create refuses every text-like field", () => {
    for (const key of ["text", "motionText", "motion", "label", "idea"]) expect(accepts("clips.create", { ...createPayload, [key]: "she waves" })).toBe(false);
  });

  test("clips.createBatch refuses every text-like field, on the payload and on an item", () => {
    for (const key of ["text", "motionText", "motion", "label", "idea"]) {
      expect(accepts("clips.createBatch", { ...batchPayload, [key]: "she waves" })).toBe(false);
      expect(accepts("clips.createBatch", { ...batchPayload, items: [{ photoId: PHOTO, motionId: "v-2", [key]: "she waves" }] })).toBe(false);
    }
  });

  // A valid payload of every other clip command, so that a refusal can only be the text field's.
  const BASES: Record<string, Record<string, unknown>> = {
    "clips.options": { avatarId: AVATAR, photoId: PHOTO },
    "clips.create": createPayload,
    "clips.list": { avatarId: AVATAR },
    "clips.get": { avatarId: AVATAR, clipId: "clip-0000001" },
    "clips.markSeen": { avatarId: AVATAR, clipId: "clip-0000001" },
    "clips.delete": { avatarId: AVATAR, clipId: "clip-0000001" },
    "clips.retryDownload": { avatarId: AVATAR, clipId: "clip-0000001" },
    "clips.export": { avatarId: AVATAR, clipId: "clip-0000001" },
    "clips.batchOptions": { avatarId: AVATAR, photoIds: [PHOTO] },
    "clips.createBatch": batchPayload,
    "clips.cancelBatch": { avatarId: AVATAR, batchId: "batch-00000001" },
    "clips.estimateSuggest": { avatarId: AVATAR, photoId: PHOTO },
    "clips.suggestMotions": suggestPayload,
    "clips.estimateIdea": { avatarId: AVATAR, photoId: PHOTO },
  };

  test("no other clip command but translateIdea has a text field", () => {
    const others = ENGINE_COMMAND_TYPES.filter((t) => t.startsWith("clips.") && t !== "clips.translateIdea");
    expect(Object.keys(BASES).sort()).toEqual([...others].sort());
    for (const type of others) {
      expect(accepts(type, BASES[type])).toBe(true);
      expect(accepts(type, { ...BASES[type], text: "she waves" })).toBe(false);
    }
  });
});

// ---------- the results ----------

describe("ClipFrameReading", () => {
  test("holds the notes capture-differs and second-phone, each at most once", () => {
    expect(ClipFrameReading.safeParse({ notes: [] }).success).toBe(true);
    expect(ClipFrameReading.safeParse({ notes: ["capture-differs"] }).success).toBe(true);
    expect(ClipFrameReading.safeParse(reading).success).toBe(true);
    expect(ClipFrameReading.safeParse({ notes: ["second-phone", "second-phone"] }).success).toBe(false);
  });

  test("refuses any other note and any other key", () => {
    expect(ClipFrameReading.safeParse({ notes: ["face-hidden"] }).success).toBe(false);
    expect(ClipFrameReading.safeParse({ notes: [], phoneVisible: true }).success).toBe(false);
    expect(ClipFrameReading.safeParse({}).success).toBe(false);
  });
});

describe("clips.suggestMotions answers ok or none", () => {
  const ok = { outcome: "ok", motions: [vision(1), vision(2), vision(3)], reading, costMicros: 3_400 };

  test("ok carries one to three vision motions, the frame reading and the cost", () => {
    expect(answers("clips.suggestMotions", ok)).toBe(true);
    expect(answers("clips.suggestMotions", { ...ok, motions: [vision(1)], reading: { notes: [] } })).toBe(true);
    expect(ClipSuggestResult.safeParse(ok).success).toBe(true);
  });

  test("ok with no motion, with four, with an own or a code motion, or with a repeated id is refused", () => {
    expect(answers("clips.suggestMotions", { ...ok, motions: [] })).toBe(false);
    expect(answers("clips.suggestMotions", { ...ok, motions: [vision(1), vision(2), vision(3), vision(4)] })).toBe(false);
    expect(answers("clips.suggestMotions", { ...ok, motions: [own(1)] })).toBe(false);
    expect(answers("clips.suggestMotions", { ...ok, motions: [code(1)] })).toBe(false);
    expect(answers("clips.suggestMotions", { ...ok, motions: [vision(1), vision(1)] })).toBe(false);
  });

  test("ok needs the reading and the cost", () => {
    expect(answers("clips.suggestMotions", { ...ok, reading: undefined })).toBe(false);
    expect(answers("clips.suggestMotions", { ...ok, costMicros: undefined })).toBe(false);
    expect(answers("clips.suggestMotions", { ...ok, costMicros: -1 })).toBe(false);
  });

  test("none carries the cost, 0 meaning free, and nothing else", () => {
    expect(answers("clips.suggestMotions", { outcome: "none", costMicros: 0 })).toBe(true);
    expect(answers("clips.suggestMotions", { outcome: "none", costMicros: 3_900 })).toBe(true);
    expect(answers("clips.suggestMotions", { outcome: "none" })).toBe(false);
    expect(answers("clips.suggestMotions", { outcome: "none", costMicros: 0, motions: [] })).toBe(false);
  });

  test("there is no `rejected` answer to a suggestion", () => {
    expect(answers("clips.suggestMotions", { outcome: "rejected", problems: ["content"], costMicros: 1_000 })).toBe(false);
  });
});

describe("clips.translateIdea answers ok, none or rejected", () => {
  const ok = { outcome: "ok", item: own(3), costMicros: 1_000 };

  test("ok returns the new own item and the cost", () => {
    expect(answers("clips.translateIdea", ok)).toBe(true);
    expect(ClipTranslateResult.safeParse(ok).success).toBe(true);
  });

  test("ok refuses an item that is not an own one, and a missing cost", () => {
    expect(answers("clips.translateIdea", { ...ok, item: vision(1) })).toBe(false);
    expect(answers("clips.translateIdea", { ...ok, item: code(1) })).toBe(false);
    expect(answers("clips.translateIdea", { ...ok, item: scene })).toBe(false);
    expect(answers("clips.translateIdea", { ...ok, costMicros: undefined })).toBe(false);
  });

  test("the item's label is at most 40 and its English text at most 60", () => {
    expect(answers("clips.translateIdea", { ...ok, item: { ...own(1), label: "я".repeat(41) } })).toBe(false);
    expect(answers("clips.translateIdea", { ...ok, item: { ...own(1), text: "a".repeat(61) } })).toBe(false);
  });

  test("none carries the cost: 0 is a free end, more than 0 a paid one", () => {
    expect(answers("clips.translateIdea", { outcome: "none", costMicros: 0 })).toBe(true);
    expect(answers("clips.translateIdea", { outcome: "none", costMicros: 2_200 })).toBe(true);
    expect(answers("clips.translateIdea", { outcome: "none" })).toBe(false);
  });

  test("rejected carries the problems and the cost", () => {
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: ["two-movements"], costMicros: 2_000 })).toBe(true);
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: ["two-movements"] })).toBe(false);
  });

  test("rejected needs at least one problem, with no repeat and no unknown code", () => {
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: [], costMicros: 2_000 })).toBe(false);
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: ["phone", "phone"], costMicros: 2_000 })).toBe(false);
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: ["too-big"], costMicros: 2_000 })).toBe(false);
  });

  test("rejected lists the problems in the fixed display order, so the first is the one the window shows", () => {
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: ["staging", "phone", "too-long"], costMicros: 2_000 })).toBe(true);
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: ["phone", "staging"], costMicros: 2_000 })).toBe(false);
    expect(answers("clips.translateIdea", { outcome: "rejected", problems: [...MOTION_PROBLEMS], costMicros: 2_000 })).toBe(true);
  });

  test("a suggest answer is not a translate answer", () => {
    expect(answers("clips.translateIdea", { outcome: "ok", motions: [vision(1)], reading, costMicros: 1_000 })).toBe(false);
  });
});

// ---------- MotionProblem and its texts ----------

describe("MotionProblem", () => {
  test("is the nine closed codes, in the display order of the mockups", () => {
    expect([...MOTION_PROBLEMS]).toEqual(["not-motion", "content", "takes-off", "staging", "phone", "face-hidden", "two-movements", "not-small", "too-long"]);
    for (const code of MOTION_PROBLEMS) expect(MotionProblem.safeParse(code).success).toBe(true);
    expect(MotionProblem.safeParse("too-big").success).toBe(false);
  });

  test("every code has its Russian text, word for word (the owner's veto), each ending with a period", () => {
    const TEXTS = {
      "two-movements": "Так не получится: два движения сразу — оставьте одно.",
      "not-small": "Так не получится: движение слишком большое — опишите небольшое и медленное.",
      "too-long": "Так не получится: для клипа это слишком подробно — опишите движение короче.",
      staging: "Так не получится: камера и монтаж в клипе не меняются — опишите, что делает она.",
      phone: "Так не получится: телефон в этом кадре не упоминаем — уберите его из идеи.",
      "face-hidden": "Так не получится: лица в этом кадре не видно — опишите движение тела, а не лица.",
      content: "Так не получится: такие слова для этого кадра не подходят — опишите движение иначе.",
      "takes-off": "Так не получится: здесь одежда остаётся на месте — такое движение только для кадров «Смелой».",
      "not-motion": "Так не получится: в идее нет движения — опишите, что она делает в кадре.",
    } as const;
    for (const problem of MOTION_PROBLEMS) {
      expect<string>(MOTION_PROBLEMS_RU[problem]).toBe(TEXTS[problem]);
      expect(MOTION_PROBLEMS_RU[problem].endsWith(".")).toBe(true);
    }
  });
});

// ---------- the reasons ----------

describe("clipReason motion-busy, suggest-busy, idea-busy and clip-busy", () => {
  const NEW = ["motion-busy", "suggest-busy", "idea-busy"];

  test("the three new reasons join the closed set as IN_FLIGHT reasons, beside the existing clip-busy", () => {
    for (const reason of [...NEW, "clip-busy"]) {
      expect(CLIP_REASONS as readonly string[]).toContain(reason);
      expect(CLIP_IN_FLIGHT_REASONS as readonly string[]).toContain(reason);
    }
  });

  test("each is accepted with IN_FLIGHT only", () => {
    for (const clipReason of [...NEW, "clip-busy"]) {
      expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason }).success).toBe(true);
      for (const code of ["VALIDATION", "NOT_FOUND", "INTERNAL", "BUDGET_EXCEEDED", "PRICE_CHANGED"]) expect(EngineError.safeParse({ code, clipReason }).success).toBe(false);
    }
  });

  // L2 (review round 2): ids are never reused while a store lives, so a store that has issued its last id refuses the photo free instead of reusing one.
  test("motions-full is a VALIDATION reason with the owner-facing text", () => {
    expect(CLIP_REASONS as readonly string[]).toContain("motions-full");
    expect(CLIP_IN_FLIGHT_REASONS as readonly string[]).not.toContain("motions-full");
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "motions-full" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "motions-full" }).success).toBe(false);
    expect(CLIP_REASONS_RU["motions-full"]).toBe("Для этого фото больше нельзя добавить движений — выберите другое фото.");
  });

  // L6: a call on a «Смелая» frame while bold clips are off refuses free with the existing reason.
  test("bold-off stays a VALIDATION reason with its existing text, for the part C calls too", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "bold-off" }).success).toBe(true);
    expect(CLIP_REASONS_RU["bold-off"]).toBe("Кадры «Смелой» пока не оживляются.");
  });

  test("the texts are the owner's, word for word, with a final period", () => {
    expect(CLIP_REASONS_RU["motion-busy"]).toBe("Подождите: идёт подбор движения или перевод.");
    expect(CLIP_REASONS_RU["suggest-busy"]).toBe("Движения для этого фото уже подбираются — дождитесь ответа.");
    expect(CLIP_REASONS_RU["idea-busy"]).toBe("Идея для этого фото уже переводится — дождитесь ответа.");
    expect(CLIP_REASONS_RU["clip-busy"]).toBe("Сейчас снимается клип — предложить или перевести движение можно после него.");
  });
});

// ---------- the sleep class, the constants, the display rules ----------

describe("the sleep class of the part C commands", () => {
  test("the estimates are free; the two paid calls are held while the Mac sleeps", () => {
    expect(SLEEP_CLASS["clips.estimateSuggest"]).toBe("free");
    expect(SLEEP_CLASS["clips.estimateIdea"]).toBe("free");
    expect(SLEEP_CLASS["clips.suggestMotions"]).toBe("held");
    expect(SLEEP_CLASS["clips.translateIdea"]).toBe("held");
  });
});

describe("the micros constants of part C (plan §5.3, «Money per call»)", () => {
  test("a suggestion costs about $0.0034 and at most $0.0125 over two attempts", () => {
    expect(MOTION_SUGGEST_EXPECTED_MICROS).toBe(3_400);
    expect(MOTION_SUGGEST_WORST_MICROS).toBe(12_500);
  });

  test("a translation costs about $0.001 and at most $0.005 over two attempts", () => {
    expect(MOTION_TRANSLATE_EXPECTED_MICROS).toBe(1_000);
    expect(MOTION_TRANSLATE_WORST_MICROS).toBe(5_000);
  });

  test("a call has at most two attempts, and the store keeps twelve items", () => {
    expect(MOTION_MAX_ATTEMPTS).toBe(2);
    expect(MOTION_STORE_MAX_ITEMS).toBe(12);
  });

  test("the ceilings show in three decimals, rounded up, like the app's other ceilings", () => {
    expect(formatUsdTiered(MOTION_SUGGEST_WORST_MICROS, "up")).toBe("$0.013");
    expect(formatUsdTiered(MOTION_TRANSLATE_WORST_MICROS, "up")).toBe("$0.005");
  });
});

describe("how the window shows what a call cost", () => {
  test("a free call (0) stays 0, so the window can say «бесплатно» on costMicros === 0 alone", () => {
    expect(motionCostShownMicros(0)).toBe(0);
  });

  test("a paid call below $0.001 shows as at least $0.001", () => {
    expect(MOTION_MIN_SHOWN_MICROS).toBe(1_000);
    expect(motionCostShownMicros(1)).toBe(1_000);
    expect(motionCostShownMicros(400)).toBe(1_000);
    expect(motionCostShownMicros(999)).toBe(1_000);
  });

  test("a paid call of $0.001 or more shows as it is", () => {
    expect(motionCostShownMicros(1_000)).toBe(1_000);
    expect(motionCostShownMicros(3_400)).toBe(3_400);
    expect(formatUsdTiered(motionCostShownMicros(3_400), "nearest")).toBe("$0.003");
    expect(formatUsdTiered(motionCostShownMicros(3_900), "nearest")).toBe("$0.004");
    expect(formatUsdTiered(motionCostShownMicros(400), "nearest")).toBe("$0.001");
  });

  test("refuses a negative or fractional cost", () => {
    expect(() => motionCostShownMicros(-1)).toThrow(RangeError);
    expect(() => motionCostShownMicros(1.5)).toThrow(RangeError);
  });
});

// ---------- the label of an own idea ----------

describe("ownIdeaLabel cuts the owner's words by word, to 40 characters, with a trailing «…»", () => {
  test("the fallback label is «Своя идея»", () => {
    expect(OWN_IDEA_FALLBACK_LABEL).toBe("Своя идея");
  });

  test("a text of 40 characters or fewer is its own label, untouched", () => {
    expect(ownIdeaLabel("поправляет прядь")).toBe("поправляет прядь");
    expect(ownIdeaLabel("я".repeat(40))).toBe("я".repeat(40));
  });

  test("a text of 41 characters is cut by word: the label is at most 40 including the «…»", () => {
    const text = `${"я".repeat(30)} ${"ю".repeat(10)}`;
    expect(text.length).toBe(41);
    expect(ownIdeaLabel(text)).toBe(`${"я".repeat(30)}…`);
  });

  test("the mockup's examples come out word for word (63a, 62 #full)", () => {
    expect(ownIdeaLabel("медленно поворачивает голову, прислушиваясь к шуму за окном")).toBe("медленно поворачивает голову…");
    expect(ownIdeaLabel("медленно греет ладони о кружку, глядя в окно")).toBe("медленно греет ладони о кружку, глядя…");
  });

  test("the cut never leaves trailing punctuation before the «…»", () => {
    expect(ownIdeaLabel("медленно поворачивает голову, прислушиваясь к шуму")).toBe("медленно поворачивает голову…");
    expect(ownIdeaLabel(`она тихо смотрит в окно; ${"п".repeat(20)}`)).toBe("она тихо смотрит в окно…");
  });

  test("the cut never ends on a one- or two-letter word", () => {
    expect(ownIdeaLabel("она медленно очень плавно и поворачивает голову")).toBe("она медленно очень плавно…");
  });

  test("the result is never longer than 40 characters", () => {
    for (const text of ["слово ".repeat(30), "я".repeat(300), `${"а".repeat(39)} бб`, `${"а".repeat(38)} бб вв`, "медленно ".repeat(10)]) {
      expect(ownIdeaLabel(text).length).toBeLessThanOrEqual(40);
    }
  });

  test("a single word longer than the room is cut hard at 39 characters, then «…»", () => {
    expect(ownIdeaLabel("я".repeat(100))).toBe(`${"я".repeat(39)}…`);
  });

  test("a hard cut never splits a surrogate pair", () => {
    const label = ownIdeaLabel("😀".repeat(50));
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.slice(0, -1)).toBe("😀".repeat((label.length - 1) / 2));
  });

  test("runs of spaces collapse to one and the edges are trimmed", () => {
    expect(ownIdeaLabel("  медленно    поворачивает  голову ")).toBe("медленно поворачивает голову");
  });

  test("a blank text gets the fallback label", () => {
    expect(ownIdeaLabel("   ")).toBe("Своя идея");
    expect(ownIdeaLabel("")).toBe("Своя идея");
  });

  test("every label it makes is one a ClipMotionChoice accepts", () => {
    for (const text of ["слово ".repeat(30), "я".repeat(300), "она улыбается", "медленно греет ладони о кружку, глядя в окно"]) {
      expect(ClipMotionChoice.safeParse({ ...own(1), label: ownIdeaLabel(text) }).success).toBe(true);
    }
  });
});
