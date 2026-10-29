import { describe, expect, test } from "bun:test";
import { GOOD_TEXTS, create, errorOf, flush, idea, makeClipMock, suggest, suggestion, translate, unwrap } from "./mockEngine.clipMotions.testkit";

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.3, I5.68; review r2.1 N10): the guard between the clip money and the part C calls, BOTH ways and global, in the mock, as in the engine (engine.clipMotions.guard.test.ts,
// engine.clipMotions.batchGuard.test.ts). The unit is the ONE predicate behind both directions; a batch holds it for its whole life, the gaps between members included.



describe("a part C call waits for the clip money: IN_FLIGHT `clip-busy`", () => {
  test("while a single clip holds the unit, suggestMotions and translateIdea answer it, and nothing is reserved", async () => {
    const m = makeClipMock();
    await unwrap(create(m));
    for (const answer of [suggest(m), translate(m)]) expect(await errorOf(answer)).toMatchObject({ code: "IN_FLIGHT", clipReason: "clip-busy" });
    expect(m.engine.peekMotions().lines).toEqual([]);
    expect(m.engine.peekMotions().running).toBe(0);
  });

});

describe("a clip waits for any part C call: IN_FLIGHT `motion-busy`, global", () => {
  async function runningCall(kind: "suggest" | "translate") {
    const m = makeClipMock();
    m.engine.holdMotionCalls(true);
    m.engine.scriptNextMotionReplies([kind === "suggest" ? suggestion(GOOD_TEXTS.slice(0, 1)) : idea(GOOD_TEXTS[1])]);
    const running = kind === "suggest" ? suggest(m) : translate(m);
    await flush();
    expect(m.engine.peekMotions()).toMatchObject({ running: 1, waiting: 1 });
    return { m, running };
  }

  test.each(["suggest", "translate"] as const)("while a %s runs, clips.create answers it: no job, no reserve, no unit", async (kind) => {
    const { m, running } = await runningCall(kind);
    const linesBefore = m.engine.peekMotions().lines.length;
    expect(await errorOf(create(m))).toMatchObject({ code: "IN_FLIGHT", clipReason: "motion-busy" });
    expect(m.engine.peekMotions().lines).toHaveLength(linesBefore);
    expect(m.engine.peekClips().attempts).toEqual([]);
    expect(m.engine.peekClips().unit).toBeNull();
    m.engine.holdMotionCalls(false);
    expect(await running).toMatchObject({ ok: true, result: { outcome: "ok" } });
  });

});

