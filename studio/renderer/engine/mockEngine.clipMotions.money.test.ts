import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chatReply, errorOf, resultOf, send } from "../../engine/clips/testing/motionNet";
import { motionWorld } from "../../engine/clips/testing/motionWorld";
import { useEngineDir } from "../../engine/testing/engineHarness";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { BOLD, IDEA, NOT_MOTION, PLAIN, makeClipMock, suggest, translate, unwrap } from "./mockEngine.clipMotions.testkit";
useNativeGlobals();
setDefaultTimeout(60_000);

// Stage 5, 5b.2, S5.WC4 round 2 (plan s5b2 I5.68): the MONEY of a part C call, the mock held to the REAL engine's ledger. The engine reserves each attempt at `chatAttemptWorstMicros` of the message it really sends (the
// prompt, the facts, the idea, the feedback and the schema, and the photo's allowance), and a bill above that reserve stops the ledger (`SETTLE_ABOVE_WORST`). Each case below runs the same scripted answers through the
// real engine (real ledger, fake HTTP) and through the mock, and compares what each wrote: the reserve of every attempt, what each settled at, the result, and what the next call meets.

const dir = useEngineDir("studio-mock-motion-money-");

interface Answer {
  content: string;
  costUsd: number;
}
interface Case {
  name: string;
  kind: "suggest" | "idea";
  bold?: true;
  idea?: string;
  answers: readonly Answer[];
}

const say = (content: string, costUsd = 0.002): Answer => ({ content, costUsd });
const UNREADABLE = say("I cannot see the photo");
const suggestionOf = (texts: readonly string[], costUsd = 0.003): Answer =>
  say(JSON.stringify({ motions: texts.map((text, i) => ({ label_ru: `Движение ${i + 1}`, text_en: text })), frame: { capture: "unknown", phoneVisible: false, faceVisible: true } }), costUsd);
const ideaOf = (text: string, costUsd = 0.001): Answer => say(JSON.stringify({ text_en: text }), costUsd);
const TWO = "she slowly turns her head and then she slowly sits down";
const MANY = "she slowly turns her head toward the window and smiles gently while the wind moves her hair and the curtains and then looks back at the camera";
const LONG_IDEA = "я".repeat(300);

const CASES: readonly Case[] = [
  { name: "a suggestion, two unreadable answers", kind: "suggest", answers: [UNREADABLE, UNREADABLE] },
  { name: "a suggestion repaired with one closed code", kind: "suggest", answers: [suggestionOf([NOT_MOTION]), suggestionOf([NOT_MOTION])] },
  { name: "a suggestion repaired with several closed codes", kind: "suggest", answers: [suggestionOf([MANY, TWO]), UNREADABLE] },
  { name: "a suggestion for a frame of «Смелая»", kind: "suggest", bold: true, answers: [UNREADABLE, UNREADABLE] },
  { name: "a translation of a short idea, repaired once", kind: "idea", idea: IDEA, answers: [ideaOf(NOT_MOTION), ideaOf(NOT_MOTION)] },
  { name: "a translation of an idea of 300 letters, an unreadable answer first", kind: "idea", idea: LONG_IDEA, answers: [UNREADABLE, ideaOf(TWO)] },
  { name: "a translation of an idea of 300 letters, repaired with the previous text", kind: "idea", idea: LONG_IDEA, answers: [ideaOf(TWO), ideaOf(TWO)] },
  { name: "a translation for a frame of «Смелая» (the longer system prompt)", kind: "idea", bold: true, idea: IDEA, answers: [ideaOf(NOT_MOTION), ideaOf(MANY)] },
  { name: "a translation repaired with several closed codes", kind: "idea", idea: IDEA, answers: [ideaOf(MANY), ideaOf(MANY)] },
  { name: "a suggestion billed above its reserve: the ledger stops, the repair is refused, the next call is refused", kind: "suggest", answers: [say("I cannot see the photo", 0.02), UNREADABLE] },
  { name: "a translation billed above its reserve: the ledger stops, the repair is refused, the next call is refused", kind: "idea", idea: IDEA, answers: [ideaOf(NOT_MOTION, 0.02), ideaOf(NOT_MOTION)] },
  { name: "a suggestion billed above its reserve whose answer is good: it is stored, and the next call is refused", kind: "suggest", answers: [suggestionOf(["she slowly tucks a strand of hair behind her ear"], 0.02)] },
];

interface Observed {
  outcome: unknown;
  reserves: number[];
  settles: number[];
  next: unknown;
}

async function onEngine(c: Case): Promise<Observed> {
  const w = await motionWorld(dir(), {
    chat: (request) => {
      const answer = c.answers[request.n - 1] ?? UNREADABLE;
      return chatReply(answer.content, answer.costUsd);
    },
    seed: c.bold === true ? { category: "nightwear" } : {},
    engine: { deps: { clipSwitches: { boldClips: "kling-only" } } },
  });
  const call = (): Promise<Awaited<ReturnType<typeof send>>> => (c.kind === "suggest" ? w.suggest() : w.translate(c.idea ?? IDEA));
  const outcome = observe(await call());
  const lines = w.ledger();
  const next = observe(await call());
  return {
    outcome,
    reserves: lines.filter((l) => l.type === "reserve").map((l) => Number(l.worstMicros)),
    settles: lines.filter((l) => l.type === "settle").map((l) => Number(l.costMicros)),
    next,
  };
}

function observe(response: { ok: boolean }): unknown {
  if (response.ok) {
    const result = resultOf(response as Parameters<typeof resultOf>[0]) as Record<string, unknown>;
    return { outcome: result.outcome, costMicros: result.costMicros, ...(result.problems === undefined ? {} : { problems: result.problems }) };
  }
  return { error: errorOf(response as Parameters<typeof errorOf>[0]).code };
}

async function onMock(c: Case): Promise<Observed> {
  const m = makeClipMock({ clips: { boldClips: "kling-only" } });
  const photo = c.bold === true ? BOLD : PLAIN;
  // The engine's fake answers every request past the script with an unreadable one; the mock is told the same, for the call that follows.
  m.engine.scriptNextMotionReplies([...c.answers, UNREADABLE, UNREADABLE, UNREADABLE].map((a) => ({ kind: "answer" as const, content: a.content, costMicros: Math.round(a.costUsd * 1_000_000) })));
  const call = () => (c.kind === "suggest" ? suggest(m, photo) : translate(m, c.idea ?? IDEA, photo));
  const outcome = observe(await call());
  const lines = m.engine.peekMotions().lines;
  const next = observe(await call());
  return { outcome, reserves: lines.map((l) => l.worstMicros), settles: lines.filter((l) => l.state === "settled").map((l) => l.costMicros), next };
}

describe("the mock's money is the engine's ledger", () => {
  for (const c of CASES) {
    test(`${c.name}: the same reserves, settles, result and next call`, async () => {
      expect(await onMock(c)).toEqual(await onEngine(c));
    });
  }

  test("the reserve of an attempt follows the message, not half the call's worst case", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "unusable-body" }]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 7_024 });
    const idea = makeClipMock();
    idea.engine.scriptNextMotionReplies([{ kind: "unusable-body" }]);
    expect(await unwrap(translate(idea))).toMatchObject({ outcome: "none" });
    expect(idea.engine.peekMotions().lines[0]?.worstMicros).not.toBe(4_825);
  });
});
