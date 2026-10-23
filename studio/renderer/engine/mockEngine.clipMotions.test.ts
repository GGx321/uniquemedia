import { describe, expect, test } from "bun:test";
import { ownIdeaLabel } from "../../shared/engine";
import { MIA } from "./mockEngine.testkit";
import {
  GOOD_TEXTS,
  IDEA,
  NOT_MOTION,
  SUGGEST,
  SUGGEST_ATTEMPT,
  TRANSLATE,
  TRANSLATE_ATTEMPT,
  UNDER_AGE,
  UNDRESS,
  UNREADABLE,
  BOLD,
  CODE_TEXT,
  PLAIN,
  CLIP_PHOTOS,
  errorOf,
  estimateIdea,
  estimateSuggest,
  idea,
  ideaRefusal,
  makeClipMock,
  money,
  optionsOf,
  suggest,
  suggestion,
  translate,
  unwrap,
} from "./mockEngine.clipMotions.testkit";

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.3, I5.66-I5.68; Q-H = 2): the four part C commands in the mock, number for number and refusal for refusal as the engine's (engine.clipMotions.test.ts, clips/motionService.test.ts,
// motionWriter.test.ts, ideaTranslator.test.ts). The model's answers are scripted (`scriptNextMotionReplies`: one per attempt, in the order the attempts are sent).

const MASTER = MIA.masterPhotoId;

describe("the free estimates", () => {
  test("estimateSuggest is the writer's two attempts at the engine's figures", async () => {
    const m = makeClipMock();
    expect(await unwrap(estimateSuggest(m))).toMatchObject({ expectedMicros: SUGGEST.expectedMicros, worstMicros: SUGGEST.worstMicros });
  });

  test("estimateIdea is the translator's two attempts at the engine's figures", async () => {
    const m = makeClipMock();
    expect(await unwrap(estimateIdea(m))).toMatchObject({ expectedMicros: TRANSLATE.expectedMicros, worstMicros: TRANSLATE.worstMicros });
  });

  test("an estimate is free: no key needed, no ledger line, nothing spent", async () => {
    const m = makeClipMock();
    await unwrap(m.client.request("settings.clearApiKey", {}));
    await unwrap(estimateSuggest(m));
    await unwrap(estimateIdea(m));
    expect(m.engine.peekMotions().lines).toEqual([]);
    expect((await money(m)).spentMicros).toBe(0);
  });

  test("NOT_FOUND for a photo or an avatar the library does not have", async () => {
    const m = makeClipMock();
    expect((await errorOf(estimateSuggest(m, "photo-nope-0001"))).code).toBe("NOT_FOUND");
    expect((await errorOf(m.client.request("clips.estimateIdea", { avatarId: "avatar-nope-0001", photoId: PLAIN }))).code).toBe("NOT_FOUND");
  });
});

describe("clips.suggestMotions: the money", () => {
  test("is reserved at one attempt's worst case under <job>:motion#1 and settled at the answer's cost, and the result carries the cost", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 3), 3_400)]);
    const estimate = await unwrap(estimateSuggest(m));
    const result = await unwrap(suggest(m, PLAIN, estimate.worstMicros));
    expect(result).toMatchObject({ outcome: "ok", costMicros: 3_400 });
    const [line, ...rest] = m.engine.peekMotions().lines;
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ worstMicros: SUGGEST_ATTEMPT, state: "settled", costMicros: 3_400, estimated: false });
    expect(line?.attemptId).toMatch(/:motion#1$/);
    expect(SUGGEST_ATTEMPT).toBeLessThanOrEqual(estimate.worstMicros / 2);
    const status = await money(m);
    expect([status.spentMicros, status.unsettledMicros]).toEqual([3_400, 0]);
  });

  test("the call announces its money once, after it has ended, not at every reserve", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, suggestion(GOOD_TEXTS.slice(0, 1))]);
    const before = m.events.filter((e) => e.type === "money.changed").length;
    await unwrap(suggest(m));
    expect(m.events.filter((e) => e.type === "money.changed").length - before).toBe(1);
  });

  test("PRICE_CHANGED when the accepted worst case is below the live estimate: free, nothing sent", async () => {
    const m = makeClipMock();
    expect((await errorOf(suggest(m, PLAIN, SUGGEST.worstMicros - 1))).code).toBe("PRICE_CHANGED");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("the exact worst case is accepted", async () => {
    const m = makeClipMock();
    expect(await unwrap(suggest(m, PLAIN, SUGGEST.worstMicros))).toMatchObject({ outcome: "ok" });
  });

  test("BUDGET_EXCEEDED when the month has no room for the worst case: free, nothing sent", async () => {
    const m = makeClipMock();
    await unwrap(m.client.request("settings.setBudget", { monthlyBudgetMicros: SUGGEST.worstMicros - 1 }));
    expect((await errorOf(suggest(m))).code).toBe("BUDGET_EXCEEDED");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("the month's room of exactly the worst case is enough", async () => {
    const m = makeClipMock();
    await unwrap(m.client.request("settings.setBudget", { monthlyBudgetMicros: SUGGEST.worstMicros }));
    expect(await unwrap(suggest(m))).toMatchObject({ outcome: "ok" });
  });

  test("AUTH_INVALID without a key: free, nothing sent", async () => {
    const m = makeClipMock();
    await unwrap(m.client.request("settings.clearApiKey", {}));
    expect((await errorOf(suggest(m))).code).toBe("AUTH_INVALID");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("an unusable answer is paid: two unreadable answers are `none` with both costs, two settles, nothing stored", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, UNREADABLE]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 4_000 });
    expect(m.engine.peekMotions().lines.map((l) => [l.state, l.costMicros])).toEqual([
      ["settled", 2_000],
      ["settled", 2_000],
    ]);
    expect((await unwrap(estimateSuggest(m))).worstMicros).toBe(SUGGEST.worstMicros);
    expect((await optionsOf(m)).motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
  });

  test("a moderation refusal is free: `none`, cost 0, one attempt, a settle at zero", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "refused" }]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 0 });
    expect(m.engine.peekMotions().lines.map((l) => [l.state, l.costMicros])).toEqual([["settled", 0]]);
    expect((await money(m)).spentMicros).toBe(0);
  });

  test("a paid unusable answer then a moderation refusal is `none` and carries the paid amount", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, { kind: "refused" }]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 2_000 });
  });

  test("two attempts at most: both failing the check is `none`, paid for both, and a third is never sent", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([NOT_MOTION], 3_000), suggestion([NOT_MOTION], 3_000), suggestion(GOOD_TEXTS.slice(0, 1))]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 6_000 });
    expect(m.engine.peekMotions().lines).toHaveLength(2);
  });

  test("an answer that fails the check once is repaired by the second attempt, and both are paid", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([NOT_MOTION], 3_000), suggestion(GOOD_TEXTS.slice(0, 1), 3_400)]);
    expect(await unwrap(suggest(m))).toMatchObject({ outcome: "ok", costMicros: 6_400, motions: [{ id: "v-1", text: GOOD_TEXTS[0] }] });
  });

  test("S5.WC2c: a text the age guard refuses is dropped with no second attempt: a repair could only take the age out", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([UNDER_AGE], 3_000), suggestion(GOOD_TEXTS.slice(0, 1))]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 3_000 });
    expect(m.engine.peekMotions().lines).toHaveLength(1);
  });

  test("S5.WC2c: a text that takes clothing off is a suggestion like any other on an ordinary frame", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([UNDRESS], 3_000)]);
    expect(await unwrap(suggest(m))).toMatchObject({ outcome: "ok", costMicros: 3_000, motions: [{ id: "v-1", text: UNDRESS }] });
  });

  test("a four-motion answer keeps the first three", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 4))]);
    const result = await unwrap(suggest(m));
    expect(result).toMatchObject({ outcome: "ok" });
    expect(result.outcome === "ok" && result.motions.map((x) => x.text)).toEqual(GOOD_TEXTS.slice(0, 3));
  });

  test("a good text next to a bad one: the bad one is dropped, the good one kept, one attempt", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([NOT_MOTION, GOOD_TEXTS[1]])]);
    const result = await unwrap(suggest(m));
    expect(result.outcome === "ok" && result.motions.map((x) => [x.id, x.text])).toEqual([["v-1", GOOD_TEXTS[1]]]);
    expect(m.engine.peekMotions().lines).toHaveLength(1);
  });

  test("the reading marks a second phone, and nothing else on a frame whose capture the plan does not name", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 1), 3_400, { capture: "timer", phoneVisible: true, faceVisible: true })]);
    expect(await unwrap(suggest(m))).toMatchObject({ reading: { notes: ["second-phone"] } });
  });
});

describe("clips.suggestMotions: a text that is already known (S5.WC3c, as the engine's)", () => {
  test("every text stored already: `none` with the reason `repeated`, paid, ids and store untouched", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 2)), suggestion(GOOD_TEXTS.slice(0, 2))]);
    await unwrap(suggest(m));
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", reason: "repeated", costMicros: 3_400 });
    expect((await optionsOf(m)).motions.filter((x) => x.source === "vision").map((x) => x.id)).toEqual(["v-1", "v-2"]);
  });

  test("a stored text met again with a capital letter inside it is the same text; one new text next to it gets the next id", async () => {
    const m = makeClipMock();
    const first = GOOD_TEXTS[0];
    m.engine.scriptNextMotionReplies([suggestion([first]), suggestion([first.replace("hair", "Hair"), GOOD_TEXTS[3]])]);
    await unwrap(suggest(m));
    const second = await unwrap(suggest(m));
    expect(second.outcome === "ok" && second.motions.map((x) => [x.id, x.text])).toEqual([["v-2", GOOD_TEXTS[3]]]);
  });

  test("two texts of one answer that differ only by a capital letter inside are kept once", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([GOOD_TEXTS[0], GOOD_TEXTS[0].replace("hair", "Hair")])]);
    const result = await unwrap(suggest(m));
    expect(result.outcome === "ok" && result.motions.map((x) => x.id)).toEqual(["v-1"]);
  });

  test("a text equal to a code motion of the frame is not stored; an answer of nothing else is `repeated`", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion([CODE_TEXT.replace("head", "Head"), GOOD_TEXTS[0]]), suggestion([CODE_TEXT])]);
    const first = await unwrap(suggest(m));
    expect(first.outcome === "ok" && first.motions.map((x) => x.text)).toEqual([GOOD_TEXTS[0]]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", reason: "repeated", costMicros: 3_400 });
  });

  test("a suggestion that left the sheet can be suggested again: stored as a new item with the next id, and it shows", async () => {
    const m = makeClipMock();
    m.engine.tamperMotionStore(PLAIN, (seeded) => {
      seeded.items = GOOD_TEXTS.map((text, i) => ({ id: `v-${i + 1}`, source: "vision" as const, label: `Старое ${i + 1}`, text }));
      seeded.next.vision = 6;
    });
    m.engine.scriptNextMotionReplies([suggestion([GOOD_TEXTS[0]]), suggestion([GOOD_TEXTS[4]])]);
    const again = await unwrap(suggest(m));
    expect(again.outcome === "ok" && again.motions.map((x) => [x.id, x.text])).toEqual([["v-6", GOOD_TEXTS[0]]]);
    expect((await optionsOf(m)).motions.filter((x) => x.source === "vision").map((x) => x.id)).toEqual(["v-4", "v-5", "v-6"]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", reason: "repeated", costMicros: 3_400 });
  });

  test("an own idea with the same English that came first does not hide the suggestion", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[0]), suggestion([GOOD_TEXTS[0]])]);
    await unwrap(translate(m));
    const result = await unwrap(suggest(m));
    expect(result.outcome === "ok" && result.motions.map((x) => [x.id, x.text])).toEqual([[ "v-1", GOOD_TEXTS[0]]]);
  });

  test("an unusable answer is `none` without a reason", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, UNREADABLE]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 4_000 });
  });
});

describe("clips.suggestMotions: the second attempt fails", () => {
  test("a TIMEOUT on the first attempt is an error, free of cost to tell, and its reserve stays open at its worst case", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "timeout" }]);
    expect((await errorOf(suggest(m))).code).toBe("TIMEOUT");
    expect(m.engine.peekMotions().lines.map((l) => [l.state, l.worstMicros])).toEqual([["open", SUGGEST_ATTEMPT]]);
    const status = await money(m);
    expect([status.spentMicros, status.unsettledMicros, status.unsettledCount]).toEqual([0, SUGGEST_ATTEMPT, 1]);
  });

  test("a TIMEOUT on the second attempt after a paid first one is still an error (the reserve may have been billed): both stay told", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, { kind: "timeout" }]);
    expect((await errorOf(suggest(m))).code).toBe("TIMEOUT");
    expect(m.engine.peekMotions().lines.map((l) => l.state)).toEqual(["settled", "open"]);
  });

  test("a 5xx on the second attempt after a paid first one is `none` with what the first cost", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, { kind: "http", status: 503 }]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 2_000 });
    expect((await money(m)).unsettledMicros).toBe(0);
  });

  test("a 5xx on the first attempt is an error: nothing was paid", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "http", status: 500 }]);
    expect((await errorOf(suggest(m))).code).toBe("NETWORK");
  });

  test("a refused key on the second attempt is an error, and the key is marked rejected", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, { kind: "http", status: 401 }]);
    expect((await errorOf(suggest(m))).code).toBe("AUTH_INVALID");
    const settings = await unwrap(m.client.request("settings.get", {}));
    expect(settings.apiKey.rejected).toBe(true);
  });

  test("no credits on the second attempt is an error too", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, { kind: "http", status: 402 }]);
    expect((await errorOf(suggest(m))).code).toBe("INSUFFICIENT_CREDITS");
  });

  test("a paid body that is no chat answer at all ends the call at once, settled at the attempt's worst case", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "unusable-body" }, suggestion(GOOD_TEXTS.slice(0, 1))]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: SUGGEST_ATTEMPT });
    expect(m.engine.peekMotions().lines).toMatchObject([{ state: "settled", costMicros: SUGGEST_ATTEMPT, estimated: true }]);
  });
});

describe("clips.suggestMotions: the photo", () => {
  test("a frame of «Смелая» while bold clips are off: VALIDATION `bold-off`, free, for both calls", async () => {
    const m = makeClipMock({ clips: { boldClips: "off" } });
    expect(await errorOf(suggest(m, BOLD))).toMatchObject({ code: "VALIDATION", clipReason: "bold-off" });
    expect(await errorOf(translate(m, IDEA, BOLD))).toMatchObject({ code: "VALIDATION", clipReason: "bold-off" });
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("the master portrait is `not-a-gallery-photo`; an unknown photo is NOT_FOUND; both free", async () => {
    const m = makeClipMock();
    expect(await errorOf(suggest(m, MASTER))).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo" });
    expect((await errorOf(suggest(m, "photo-nope-0001"))).code).toBe("NOT_FOUND");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("a photo the age check did not call adult is `age-unverified`, free", async () => {
    const m = makeClipMock();
    expect(await errorOf(suggest(m, CLIP_PHOTOS.aged.photoId))).toMatchObject({ clipReason: "age-unverified" });
  });

  test("a photo with no motion to offer is `no-motion`, free", async () => {
    const m = makeClipMock();
    expect(await errorOf(suggest(m, CLIP_PHOTOS.unknown.photoId))).toMatchObject({ clipReason: "no-motion" });
  });

  test("a photo of another avatar is NOT_FOUND", async () => {
    const m = makeClipMock();
    expect((await errorOf(m.client.request("clips.suggestMotions", { avatarId: "avatar-nope-0001", photoId: PLAIN, acceptedWorstMicros: 1_000_000 }))).code).toBe("NOT_FOUND");
  });
});

describe("clips.translateIdea: the translator's own refusal (S5.WCX)", () => {
  test("a refusal with a closed code is rejected at once with that code: one attempt, paid, nothing stored", async () => {
    for (const code of ["two-movements", "not-small", "staging", "not-motion"] as const) {
      const m = makeClipMock();
      m.engine.scriptNextMotionReplies([ideaRefusal(code, 600), idea(GOOD_TEXTS[0])]);
      expect(await unwrap(translate(m))).toEqual({ outcome: "rejected", problems: [code], costMicros: 600 });
      expect(m.engine.peekMotions().lines.map((line) => line.attemptId.replace(/^.*:/, ""))).toEqual(["idea#1"]);
      expect((await optionsOf(m)).motions.filter((motion) => motion.source === "own")).toEqual([]);
    }
  });

  test("a refusal on the repair ends the call with the refusal's code, both attempts paid", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea("she sharply turns her head toward the door", 1_000), ideaRefusal("not-small", 600)]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "rejected", problems: ["not-small"], costMicros: 1_600 });
  });

  test("a faithful text the check refuses for her phone is final: rejected at once, no repair", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea("she slowly looks at her phone and smiles", 1_000), idea(GOOD_TEXTS[0], 1_000)]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "rejected", problems: ["phone"], costMicros: 1_000 });
    expect(m.engine.peekMotions().lines).toHaveLength(1);
  });

  test("a refusal outside the list is unreadable and asked once more", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([ideaRefusal("content", 600), idea(GOOD_TEXTS[0], 1_000)]);
    expect(await unwrap(translate(m))).toMatchObject({ outcome: "ok", costMicros: 1_600 });
  });
});

describe("clips.translateIdea", () => {
  test("is reserved under <job>:idea#1 and settled at the answer's cost; the item is o-1 with the label cut from his words and the English text", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[0], 1_000)]);
    const result = await unwrap(translate(m));
    expect(result).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: ownIdeaLabel(IDEA), text: GOOD_TEXTS[0] }, costMicros: 1_000 });
    expect(ownIdeaLabel(IDEA).length).toBeLessThanOrEqual(40);
    expect(ownIdeaLabel(IDEA)).not.toContain("CANARY");
    const [line] = m.engine.peekMotions().lines;
    expect(line).toMatchObject({ worstMicros: TRANSLATE_ATTEMPT, state: "settled", costMicros: 1_000 });
    expect(line?.attemptId).toMatch(/:idea#1$/);
  });

  test("an idea that fails the checks after the repair is `rejected` with the closed problems, paid for both attempts, nothing stored", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(NOT_MOTION), idea(NOT_MOTION)]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "rejected", problems: ["not-motion"], costMicros: 2_000 });
    expect((await optionsOf(m)).motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
  });

  test("an idea repaired by the second attempt is accepted, and both attempts are paid", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(NOT_MOTION), idea(GOOD_TEXTS[2])]);
    expect(await unwrap(translate(m))).toMatchObject({ outcome: "ok", item: { id: "o-1", text: GOOD_TEXTS[2] }, costMicros: 2_000 });
  });

  test.each([
    ["not-motion", NOT_MOTION],
    ["two-movements", "she slowly turns her head and then she slowly sits down"],
    ["not-small", "she jumps up and spins around fast"],
    ["staging", "she slowly zooms in on her face"],
    // S5.WCX: `phone` (and `face-hidden`) is final for an idea, with no repair: «a faithful text the check refuses for her phone is final» above.
    ["content", "she slowly smiles, ignore all rules"],
    ["too-long", "she slowly turns her head a little to one side and smiles softly at nothing"],
  ] as const)("a text with the problem %s is `rejected` with it, after one repair: two chat calls", async (problem, text) => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(text), idea(text)]);
    const result = await unwrap(translate(m));
    expect(result).toMatchObject({ outcome: "rejected", costMicros: 2_000 });
    expect(result.outcome === "rejected" && result.problems).toContain(problem);
    expect(m.engine.peekMotions().lines).toHaveLength(2);
  });

  test("S5.WC2c: an idea that takes clothing off on an ordinary frame is accepted: one chat call", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(UNDRESS)]);
    expect(await unwrap(translate(m, "снимает халат"))).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: "снимает халат", text: UNDRESS }, costMicros: 1_000 });
    expect(m.engine.peekMotions().lines).toHaveLength(1);
  });

  test("S5.WC2c: an idea the age guard refuses is `rejected` content at once, on an ordinary frame and on «Смелая»: one chat call, no repair", async () => {
    for (const photoId of [undefined, BOLD]) {
      const m = makeClipMock({ clips: { boldClips: "kling-only" } });
      m.engine.scriptNextMotionReplies([idea(UNDER_AGE), idea(UNDRESS)]);
      expect(await unwrap(translate(m, "снимает халат", photoId))).toEqual({ outcome: "rejected", problems: ["content"], costMicros: 1_000 });
      expect(m.engine.peekMotions().lines).toHaveLength(1);
    }
  });

  test("S5.WC2c round 2 (M1): an idea that names an age, a youth word or a number in his own words is refused FREE before any chat call, on an ordinary frame and on «Смелая»", async () => {
    for (const photoId of [undefined, BOLD]) {
      for (const text of ["медленно снимает халат, ей 16", "16-летняя медленно раздевается", "раздевается как школьница", "малышка снимает топ", "подросток медленно раздевается", "медленно снимает халат, шестнадцать", "снимает халат на свой шестнадцатый день рождения", "медленно снимает халат, 16", "младше 18, медленно раздевается", "she undresses like a toddler"]) {
        const m = makeClipMock({ clips: { boldClips: "kling-only" } });
        m.engine.scriptNextMotionReplies([idea(UNDRESS)]);
        expect([text, await unwrap(translate(m, text, photoId))]).toEqual([text, { outcome: "rejected", problems: ["content"], costMicros: 0 }]);
        expect([text, m.engine.peekMotions().lines.length]).toEqual([text, 0]);
      }
    }
  });

  test("the same idea on a frame of «Смелая» is accepted", async () => {
    const m = makeClipMock({ clips: { boldClips: "kling-only" } });
    m.engine.scriptNextMotionReplies([idea(UNDRESS)]);
    expect(await unwrap(translate(m, "снимает халат", BOLD))).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: "снимает халат", text: UNDRESS }, costMicros: 1_000 });
  });

  test("a moderation refusal is free", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "refused" }]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "none", costMicros: 0 });
  });

  test("a rejected answer then a moderation refusal is `rejected` with the first problems and the paid amount", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(NOT_MOTION), { kind: "refused" }]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "rejected", problems: ["not-motion"], costMicros: 1_000 });
  });

  test("an unreadable answer twice is `none`, paid twice", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([UNREADABLE, UNREADABLE]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "none", costMicros: 4_000 });
  });

  test("a 5xx on the repair after a paid answer that failed the check is `rejected` with what the first cost", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(NOT_MOTION), { kind: "http", status: 500 }]);
    expect(await unwrap(translate(m))).toEqual({ outcome: "rejected", problems: ["not-motion"], costMicros: 1_000 });
  });

  test("a timeout on the repair is an error and leaves its reserve open", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(NOT_MOTION), { kind: "timeout" }]);
    expect((await errorOf(translate(m))).code).toBe("TIMEOUT");
    // The repair carries the closed codes and the previous text, so its reserve is above the first attempt's (the real ledger agrees: money.test.ts).
    expect((await money(m)).unsettledMicros).toBe(10_808);
  });

  test("ids count on: the next idea is o-2", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[0]), idea(GOOD_TEXTS[1])]);
    await unwrap(translate(m));
    expect(await unwrap(translate(m, "вторая идея"))).toMatchObject({ outcome: "ok", item: { id: "o-2" } });
  });
});
