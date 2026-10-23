import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClipMotionSource, MotionProblem } from "../../shared/engine";
import { freshDrafts, sameText } from "../../shared/engine/motionKnown";
import type { BankCategory } from "../../shared/scenes/banks/types";
import type { Capture } from "../../shared/scenes/captures";
import type { ScenePose } from "../../shared/engine/categories";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts } from "./frameFacts";
import { runIdeaTranslator, type TranslatorOutcome } from "./ideaTranslator";
import { checkModelText } from "./motionCall";
import { runMotionWriter, type WriterOutcome } from "./motionWriter";
import { photoOf, pick, sceneRun, slotOf } from "./testing/frameFixtures";
import { boldMirrorFrame, okAnswer, scriptedChat } from "./testing/motionKit";
import { setupMoney, type Money } from "../openrouter/testing/fakes";
useNativeGlobals();

// Stage 5, 5b.2, S5.WCX (plan s5b2 §8 «S5.WCX»): the answers the paid probes recorded (fixtures/motion-probes.json, text only), run through the parse and the checks on the KIND of frame each was
// made for. P-M ran the provisional prompts on his library's frames; P-R ran the translator on the selfie frame in four reasoning arms. What the checks make of each recorded answer is pinned here, and
// so is what they could NOT see: a translation that changed the idea's meaning and still passed. That is the gap the final prompts close (motionPrompts.ts); the last group runs the answers the final
// translator text asks for on each probe idea, which no probe has recorded yet (C5c does).

interface ProbeFile {
  ideas: Record<string, { text: string; frame: FrameKind }>;
  suggestions: { probe: "P-M"; frame: FrameKind; answer: { motions: { label_ru: string; text_en: string }[]; frame: Record<string, unknown> } }[];
  translations: { probe: "P-M" | "P-R"; reasoning: string; idea: string; english: string; meaning: "faithful" | "substituted" | "softened" | "dropped" | "merged" }[];
}
const PROBES = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "motion-probes.json"), "utf8")) as ProbeFile;

type FrameKind = "selfie" | "mirror" | "friend" | "friend-profile" | "face-hidden" | "bold";

function planned(category: BankCategory, capture: Capture, pose: ScenePose = "front"): FrameFacts {
  const picked = pick(category, (m) => m.captures.includes(capture) && m.legs === undefined && m.angle === undefined && m.phone !== true && m.level === undefined);
  const run = sceneRun("run-00000701", [slotOf(picked, capture, pose)]);
  const result = frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run);
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

/** The kinds of frame the probes ran on (P-M's F1-F8 by kind), plus the two it could not run: a face the photo hides, and «Смелая». */
const FRAMES: Readonly<Record<FrameKind, FrameFacts>> = {
  selfie: planned("glamour", "selfie"),
  mirror: planned("glamour", "mirror"),
  friend: planned("travel", "friend"),
  "friend-profile": planned("photoshoot", "friend", "profile"),
  "face-hidden": planned("home", "mirror-hidden"),
  bold: boldMirrorFrame(),
};

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

/** The scripted chat answers without the ledger; the jobs still get a real budget and price book. */
const deps = (chat: ReturnType<typeof scriptedChat>["chat"], log: (line: string) => void = () => undefined) => ({ chat, budget: money.budget, priceBook: money.priceBook, log });

async function suggestOn(frame: FrameKind, answer: unknown, listed: readonly string[] = []): Promise<{ outcome: WriterOutcome; dropped: string[] }> {
  const dropped: string[] = [];
  const { chat } = scriptedChat([okAnswer(JSON.stringify(answer), 3_500), okAnswer(JSON.stringify(answer), 3_500)]);
  const outcome = await runMotionWriter(deps(chat, (line) => dropped.push(line.replace(/^.*: /, ""))), {
    jobId: "job-00000701",
    scope: { avatarJobId: "job-00000701" },
    textModel: "x-ai/grok-4.3",
    photoId: "photo-0701",
    image: new Uint8Array([0xff, 0xd8, 0xff]),
    facts: FRAMES[frame],
    listed,
  });
  return { outcome, dropped };
}

async function translateOn(frame: FrameKind, answers: readonly { text_en: string; refusal: string }[], idea = "медленно поворачивает голову к окну"): Promise<{ outcome: TranslatorOutcome; calls: number }> {
  const script = scriptedChat(answers.map((answer) => okAnswer(JSON.stringify(answer), 1_000)));
  const outcome = await runIdeaTranslator(deps(script.chat), {
    jobId: "job-00000702",
    scope: { avatarJobId: "job-00000702" },
    textModel: "x-ai/grok-4.3",
    photoId: "photo-0702",
    idea,
    facts: FRAMES[frame],
  });
  return { outcome, calls: script.calls.length };
}

const checkOn = (frame: FrameKind, text: string, source: Extract<ClipMotionSource, "vision" | "own">): MotionProblem[] => checkModelText(FRAMES[frame], text, source).problems;

describe("the frames the probes ran on, by kind", () => {
  test("a selfie, a mirror and a friend's photo show her face; a profile is a friend's photo; the hidden face does not show; «Смелая» is bold", () => {
    expect([FRAMES.selfie.capture, FRAMES.mirror.capture, FRAMES.friend.capture, FRAMES["friend-profile"].capture, FRAMES["face-hidden"].capture]).toEqual(["selfie", "mirror", "friend", "friend", "mirror-hidden"]);
    expect([FRAMES.selfie.face, FRAMES.mirror.face, FRAMES.friend.face, FRAMES["face-hidden"].face]).toEqual(["yes", "yes", "yes", "no"]);
    expect(FRAMES["friend-profile"].faceRole).toBe("profile");
    expect([FRAMES.selfie.bold, FRAMES.bold.bold]).toEqual([false, true]);
  });
});

describe("P-M's suggestions (9 answers, 27 texts) through the parse and the checks", () => {
  /** What each recorded answer keeps on its frame and why it drops the others, in order. */
  const EXPECTED: readonly { kept: string[]; dropped: string[] }[] = [
    { kept: ["she slowly raises the mug toward her lips", "she tilts her head a little to one side", "she blinks slowly"], dropped: [] },
    { kept: ["she slowly tucks a strand of hair behind her ear", "she tilts her head a little to one side", "she blinks slowly"], dropped: [] },
    { kept: ["she slowly tucks a strand of hair behind her ear", "she tilts her head a little to one side", "she lowers her gaze slowly"], dropped: [] },
    { kept: ["she tilts her head a little to one side"], dropped: ["suggestion 1 of 3 dropped (not-small)", "suggestion 3 of 3 dropped (not-small)"] },
    { kept: ["she slowly turns her head a little to the side", "she smiles a little"], dropped: ["suggestion 2 of 3 dropped (not-motion)"] },
    { kept: ["she tilts her head a little to one side", "she slowly lowers her hand from her ear"], dropped: ["suggestion 3 of 3 dropped (not-small)"] },
    { kept: ["she tilts her head a little to one side"], dropped: ["suggestion 2 of 3 dropped (not-small)", "suggestion 3 of 3 dropped (not-small)"] },
    { kept: ["she tilts her head slightly to one side"], dropped: ["suggestion 2 of 3 dropped (not-motion)", "suggestion 3 of 3 dropped (not-motion)"] },
    { kept: ["she slowly raises the mug to her lips", "she tilts her head a little to one side"], dropped: ["suggestion 3 of 3 dropped (not-motion)"] },
  ];

  test("the record holds P-M's nine answers, three texts each, on selfie, mirror and friend frames", () => {
    expect(PROBES.suggestions).toHaveLength(EXPECTED.length);
    expect(PROBES.suggestions.map((s) => s.frame)).toEqual(["selfie", "mirror", "friend-profile", "friend", "selfie", "mirror", "friend", "selfie", "selfie"]);
    for (const suggestion of PROBES.suggestions) expect(suggestion.answer.motions).toHaveLength(3);
  });

  for (const [i, recorded] of PROBES.suggestions.entries()) {
    test(`answer ${i + 1} on a ${recorded.frame} frame: the texts kept and the closed problems of the ones dropped`, async () => {
      const { outcome, dropped } = await suggestOn(recorded.frame, recorded.answer);
      const expected = EXPECTED[i];
      expect(outcome.kind).toBe("ok");
      expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : []).toEqual(expected?.kept ?? []);
      expect(dropped).toEqual(expected?.dropped ?? []);
    });
  }

  test("18 of 27 texts pass, 5 drop as not-small and 4 as not-motion: «softly», no small word, «moves», «blinks her eyes», «shifts her gaze» (the final texts name each)", () => {
    const all = PROBES.suggestions.flatMap((s) => s.answer.motions.map((m) => checkOn(s.frame, m.text_en, "vision")));
    expect(all.filter((p) => p.length === 0)).toHaveLength(18);
    expect(all.filter((p) => p.join() === "not-small")).toHaveLength(5);
    expect(all.filter((p) => p.join() === "not-motion")).toHaveLength(4);
  });

  test("the provisional text's own example came back in 7 of 9 answers: why the final writer text gives no example and is told what the sheet lists", () => {
    const texts = PROBES.suggestions.map((s) => s.answer.motions.map((m) => m.text_en));
    expect(texts.filter((answer) => answer.includes("she tilts her head a little to one side"))).toHaveLength(7);
  });

  test("the repeat on the selfie frame: with the first answer listed, the same text is dropped as known, but the same movement in other words is not (so the text asks for other movements, not other words)", async () => {
    const first = PROBES.suggestions[0];
    const again = PROBES.suggestions[8];
    if (first === undefined || again === undefined) throw new Error("the record lost an answer");
    const listed = first.answer.motions.map((m) => sameText(m.text_en));
    const { outcome } = await suggestOn("selfie", again.answer, listed);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    expect(freshDrafts(outcome.drafts, listed).fresh.map((d) => d.text)).toEqual(["she slowly raises the mug to her lips"]);
  });
});

describe("the recorded translations (P-M and P-R) through the check, as own ideas", () => {
  const frameOf = (t: ProbeFile["translations"][number]): FrameKind => (t.probe === "P-R" ? "selfie" : (PROBES.ideas[t.idea]?.frame ?? "selfie"));

  /** What the check says of each recorded English on its frame (P-R ran every idea on the selfie frame). */
  const EXPECTED: Readonly<Record<string, MotionProblem[]>> = {
    "she slowly tucks a strand of hair behind her ear": [],
    "she slowly turns her head to the window": [],
    "she slowly turns her head toward the window": [],
    "she slowly adjusts her hair and waves her hand": [],
    "she slowly adjusts her hair and waves": [],
    "she slowly rises from the bed toward the mirror": [],
    "she lowers her gaze and smiles": ["not-small"],
    "she smiles gently while looking down": [],
    "she slowly turns her head toward the side": [],
    "she slowly shifts her shoulders": [],
    "she sharply turns her head toward the door": ["not-small"],
    "she slowly turns her head toward the door": [],
    "she slowly tucks a strand of hair behind her ear and waves her hand": ["too-long"],
    "she slowly fixes her hair then waves her hand": ["two-movements"],
    "she slowly raises the ceramic coffee mug toward her lips": ["not-motion"],
    "she slowly rises from the bed holding her mug": ["not-motion"],
    "she slowly stands from the bed holding her mug": ["not-motion"],
    "she slowly rises from the bed holding the mug": ["not-motion"],
    "she slowly stands from the bed holding the mug": ["not-motion"],
    "she slowly approaches the mirror holding her mug": ["not-motion"],
    "she tilts her head slightly and smiles": [],
    "she smiles softly while holding the mug": ["not-small"],
    "she slowly lifts the mug closer to her face": [],
    "she slowly raises the mug a little higher": [],
    "she slowly sips from the ceramic coffee mug": ["not-motion"],
    "she slowly lifts the ceramic coffee mug": ["not-motion"],
  };

  test("every recorded English gives the pinned closed problems on its frame", () => {
    expect(PROBES.translations.length).toBeGreaterThan(30);
    for (const t of PROBES.translations) expect({ english: t.english, problems: checkOn(frameOf(t), t.english, "own") }).toEqual({ english: t.english, problems: EXPECTED[t.english] ?? ["<no pin>"] });
  });

  test("the check cannot see meaning: 27 of the 36 recorded translations changed the idea, and 14 of those still pass it (the final translator text, not the check, closes this)", () => {
    expect(PROBES.translations).toHaveLength(36);
    expect(PROBES.translations.filter((t) => t.meaning !== "faithful")).toHaveLength(27);
    const changedAndPassed = PROBES.translations.filter((t) => t.meaning !== "faithful" && checkOn(frameOf(t), t.english, "own").length === 0);
    expect(changedAndPassed.map((t) => `${t.probe} ${t.reasoning} ${t.idea} ${t.meaning}: ${t.english}`)).toEqual([
      "P-M low T3 merged: she slowly adjusts her hair and waves her hand",
      "P-M low T4 merged: she slowly rises from the bed toward the mirror",
      "P-M low T5 dropped: she smiles gently while looking down",
      "P-M low T6 substituted: she slowly turns her head toward the side",
      "P-M low T7 substituted: she slowly shifts her shoulders",
      "P-M low T8 softened: she slowly turns her head toward the door",
      "P-R none T8 softened: she slowly turns her head toward the door",
      "P-R low T3 merged: she slowly adjusts her hair and waves her hand",
      "P-R low T5 substituted: she tilts her head slightly and smiles",
      "P-R low T6 substituted: she slowly lifts the mug closer to her face",
      "P-R low T7 substituted: she slowly raises the mug a little higher",
      "P-R minimal T3 merged: she slowly adjusts her hair and waves",
      "P-R minimal T5 substituted: she tilts her head slightly and smiles",
      "P-R minimal T8 softened: she slowly turns her head toward the door",
    ]);
  });

  test("the frame's activity stood in for what the idea said in 13 P-R translations («the mug»), every arm: why the final translator sees the idea alone", () => {
    const borrowed = PROBES.translations.filter((t) => t.probe === "P-R" && /\bmug\b/.test(t.english));
    expect(borrowed).toHaveLength(13);
    expect(borrowed.every((t) => t.meaning === "substituted")).toBe(true);
    expect(new Set(borrowed.map((t) => t.reasoning))).toEqual(new Set(["none", "low", "minimal", "max_tokens 256"]));
  });
});

describe("the final translator's answer to each probe idea, on its frame (the text asks for these; no probe has recorded them yet)", () => {
  const none = (text_en: string) => ({ text_en, refusal: "none" });
  const refuse = (refusal: string) => ({ text_en: "", refusal });

  test("T1 «медленно заправляет прядь волос за ухо» on a selfie: said as it is, accepted", async () => {
    expect(await translateOn("selfie", [none("she slowly tucks a strand of hair behind her ear")])).toEqual({ outcome: { kind: "ok", text: "she slowly tucks a strand of hair behind her ear", costMicros: 1_000 }, calls: 1 });
  });

  test("T2 «медленно поворачивает голову к окну» on a mirror selfie: said as it is, accepted", async () => {
    expect(await translateOn("mirror", [none("she slowly turns her head toward the window")])).toMatchObject({ outcome: { kind: "ok" }, calls: 1 });
  });

  test("T3 «поправляет волосы, а потом машет рукой»: two movements, refused `two-movements` at once (P-M and P-R «low» merged them into a text the check passes)", async () => {
    expect(await translateOn("selfie", [refuse("two-movements")])).toEqual({ outcome: { kind: "rejected", problems: ["two-movements"], costMicros: 1_000 }, calls: 1 });
  });

  test("T4 «встаёт с кровати и подходит к зеркалу»: two big movements, refused at once (P-M passed «rises from the bed toward the mirror»)", async () => {
    expect(await translateOn("mirror", [refuse("two-movements")])).toEqual({ outcome: { kind: "rejected", problems: ["two-movements"], costMicros: 1_000 }, calls: 1 });
  });

  test("T5 «смотрит в телефон и улыбается» on a friend's photo: the phone is kept, and the check refuses it at once where her moment has none (P-M and P-R dropped or replaced it)", async () => {
    expect(await translateOn("friend", [none("she slowly looks at her phone and smiles"), none("she smiles a little")])).toEqual({ outcome: { kind: "rejected", problems: ["phone"], costMicros: 1_000 }, calls: 1 });
  });

  test("T6 «камера медленно приближается к её лицу»: the camera, not her: refused `staging` at once (P-M turned her head, P-R raised the mug)", async () => {
    expect(await translateOn("friend-profile", [refuse("staging")])).toEqual({ outcome: { kind: "rejected", problems: ["staging"], costMicros: 1_000 }, calls: 1 });
  });

  test("T7 «медленно снимает толстовку» on an ordinary frame: said as it is and accepted, no content rule (P-M shifted her shoulders, P-R raised the mug)", async () => {
    expect(await translateOn("friend", [none("she slowly takes off her hoodie")])).toEqual({ outcome: { kind: "ok", text: "she slowly takes off her hoodie", costMicros: 1_000 }, calls: 1 });
  });

  test("T7 on «Смелая» too", async () => {
    expect(await translateOn("bold", [none("she slowly takes off her hoodie")])).toMatchObject({ outcome: { kind: "ok", text: "she slowly takes off her hoodie" }, calls: 1 });
  });

  test("T8 «резко поворачивает голову к двери»: quick, refused `not-small` at once, never made slow (L14; P-M and P-R said «slowly»)", async () => {
    expect(await translateOn("selfie", [refuse("not-small")])).toEqual({ outcome: { kind: "rejected", problems: ["not-small"], costMicros: 1_000 }, calls: 1 });
  });

  test("T8 said as it is is refused by the check, and the repair refuses rather than slows it", async () => {
    expect(await translateOn("selfie", [none("she sharply turns her head toward the door"), refuse("not-small")])).toEqual({ outcome: { kind: "rejected", problems: ["not-small"], costMicros: 2_000 }, calls: 2 });
  });

  test("T9 «медленно подмигивает» where her face does not show: said as it is, refused `face-hidden` at once", async () => {
    expect(await translateOn("face-hidden", [none("she winks slowly"), none("she slowly turns her head")])).toEqual({ outcome: { kind: "rejected", problems: ["face-hidden"], costMicros: 1_000 }, calls: 1 });
  });

  test("every probe idea has its answer above", () => {
    expect(Object.keys(PROBES.ideas).sort()).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"]);
  });
});

describe("the final writer's answers on the frames P-M could not run", () => {
  test("where her face does not show, a body motion is kept and a face motion is dropped `face-hidden`", async () => {
    const answer = { motions: [{ label_ru: "Поправляет волосы", text_en: "she slowly runs a hand through her hair" }, { label_ru: "Улыбается", text_en: "she smiles a little" }], frame: { capture: "mirror-hidden", phoneVisible: true, faceVisible: false } };
    const { outcome, dropped } = await suggestOn("face-hidden", answer);
    expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : []).toEqual(["she slowly runs a hand through her hair"]);
    expect(dropped).toEqual(["suggestion 2 of 2 dropped (face-hidden)"]);
  });

  test("on «Смелая» a bolder, flirty motion that undresses her is kept", async () => {
    const answer = { motions: [{ label_ru: "Спускает бретельку", text_en: "she slowly slides a strap off her shoulder" }], frame: { capture: "mirror", phoneVisible: true, faceVisible: true } };
    const { outcome } = await suggestOn("bold", answer);
    expect(outcome.kind === "ok" ? outcome.drafts.map((d) => d.text) : []).toEqual(["she slowly slides a strap off her shoulder"]);
  });
});
