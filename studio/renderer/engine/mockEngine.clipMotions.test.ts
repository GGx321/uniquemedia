import { describe, expect, test } from "bun:test";
import { AGE_PROBES } from "../../shared/scenes/ageProbes.testkit";
import {
  GOOD_TEXTS,
  NOT_MOTION,
  SUGGEST,
  SUGGEST_ATTEMPT,
  UNDRESS,
  UNREADABLE,
  BOLD,
  PLAIN,
  errorOf,
  estimateSuggest,
  idea,
  makeClipMock,
  money,
  suggest,
  suggestion,
  translate,
  unwrap,
} from "./mockEngine.clipMotions.testkit";

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.3, I5.66-I5.68; Q-H = 2): the four part C commands in the mock, number for number and refusal for refusal as the engine's (engine.clipMotions.test.ts, clips/motionService.test.ts,
// motionWriter.test.ts, ideaTranslator.test.ts). The model's answers are scripted (`scriptNextMotionReplies`: one per attempt, in the order the attempts are sent).


describe("the free estimates", () => {
  test("estimateSuggest is the writer's two attempts at the engine's figures", async () => {
    const m = makeClipMock();
    expect(await unwrap(estimateSuggest(m))).toMatchObject({ expectedMicros: SUGGEST.expectedMicros, worstMicros: SUGGEST.worstMicros });
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

  test("PRICE_CHANGED when the accepted worst case is below the live estimate: free, nothing sent", async () => {
    const m = makeClipMock();
    expect((await errorOf(suggest(m, PLAIN, SUGGEST.worstMicros - 1))).code).toBe("PRICE_CHANGED");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("BUDGET_EXCEEDED when the month has no room for the worst case: free, nothing sent", async () => {
    const m = makeClipMock();
    await unwrap(m.client.request("settings.setBudget", { monthlyBudgetMicros: SUGGEST.worstMicros - 1 }));
    expect((await errorOf(suggest(m))).code).toBe("BUDGET_EXCEEDED");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("AUTH_INVALID without a key: free, nothing sent", async () => {
    const m = makeClipMock();
    await unwrap(m.client.request("settings.clearApiKey", {}));
    expect((await errorOf(suggest(m))).code).toBe("AUTH_INVALID");
    expect(m.engine.peekMotions().lines).toEqual([]);
  });

  test("a moderation refusal is free: `none`, cost 0, one attempt, a settle at zero", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([{ kind: "refused" }]);
    expect(await unwrap(suggest(m))).toEqual({ outcome: "none", costMicros: 0 });
    expect(m.engine.peekMotions().lines.map((l) => [l.state, l.costMicros])).toEqual([["settled", 0]]);
    expect((await money(m)).spentMicros).toBe(0);
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

describe("clips.translateIdea", () => {
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
    expect((await money(m)).unsettledMicros).toBe(13_344);
  });
});

describe("S5.FU-AGE: the kept age guard's probes (scenes/ageProbes.testkit.ts), as the engine's, on an ordinary frame and on «Смелая»", () => {
  const IDEAS = AGE_PROBES.flatMap((probes) => probes.ideas);
  const PHOTOS = [
    ["ordinary", PLAIN],
    ["«Смелая»", BOLD],
  ] as const;

  test("each idea in his own words is refused FREE before any chat call", async () => {
    for (const [where, photoId] of PHOTOS) {
      const m = makeClipMock({ clips: { boldClips: "kling-only" } });
      m.engine.scriptNextMotionReplies([idea(UNDRESS)]);
      for (const text of IDEAS) {
        // An idea that holds a format character (a zero-width space) is refused by the contract itself, before the pre-check: free too.
        if (/\p{Cf}/u.test(text)) expect([where, text, (await errorOf(translate(m, text, photoId))).code]).toEqual([where, text, "VALIDATION"]);
        else expect([where, text, await unwrap(translate(m, text, photoId))]).toEqual([where, text, { outcome: "rejected", problems: ["content"], costMicros: 0 }]);
      }
      expect([where, m.engine.peekMotions().lines.length]).toEqual([where, 0]);
    }
  });

});

