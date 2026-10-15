import { describe, expect, test } from "bun:test";
import type { MockClipScript } from "./mockClips";
import { cancelBatch, endOf, makeBatchMock, mostOpenReserves, stepUntil, startBatch, detailOf } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB3 (plan s5b2 §5.6, M11; the mirror of engine.clipBatch.property.test.ts): a batch walked through random but FIXED scripts on the mock's manual clock: clean clips, free refusals into
// Grok, a 429, an uncertain submit, a bill above the reserve, and a cancel of the queue at a random moment. On every path: never two members between their reserve and their settle, the unit given back
// (the paid count balanced), the month's hold map empty, and every member job ended. Fixed seeds, 60 cases, a few milliseconds each (no sleep, no real clock).

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** What a member does, drawn from a weighted pool: mostly clean, and now and then something that ends or stops a batch. */
function scriptFor(draw: number): MockClipScript {
  if (draw < 0.45) return "ok";
  if (draw < 0.6) return { first: "refused-free" };
  if (draw < 0.75) return "rate-limited";
  if (draw < 0.85) return "uncertain";
  if (draw < 0.92) return "ok-above-worst";
  return { first: "refused-free", then: "refused-free" };
}

const seen = new Set<string>();

describe("a batch on every path in the mock (fixed seeds)", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: one reserve open at a time, the unit back, no hold left, every member ended`, async () => {
      const rand = seeded(seed * 7919);
      const size = 1 + Math.floor(rand() * 5);
      const scripts = Array.from({ length: 10 }, () => scriptFor(rand()));
      const cancelAfter = rand() < 0.35 ? Math.floor(rand() * 3) : -1;
      const m = makeBatchMock(size);
      m.engine.scriptNextBatch(scripts);
      const { batchId, jobIds } = await startBatch(m, m.photoIds);

      let postsAtCancel = 0;
      if (cancelAfter >= 0) {
        for (let i = 0; i < 6_000 && m.engine.peekClips().posts.length <= cancelAfter; i++) if (!m.scheduler.next()) break;
        await cancelBatch(m, batchId);
        postsAtCancel = m.engine.peekClips().posts.length;
      }
      stepUntil(m, () => m.engine.peekClips().unit === null, "the unit given back");
      m.scheduler.runAll();
      if (cancelAfter >= 0) expect(m.engine.peekClips().posts.length).toBeLessThanOrEqual(postsAtCancel + 1);

      for (const event of m.events) {
        if (event.type === "job.cancelled" && event.payload.kind === "clip" && event.payload.detail !== undefined) seen.add(event.payload.detail);
        if (event.type === "job.progress" && event.payload.kind === "clip" && event.payload.waitReason === "rate-limit") seen.add("429");
      }
      if (m.engine.peekClips().posts.includes("grok")) seen.add("grok");
      expect(mostOpenReserves(m.events)).toBeLessThanOrEqual(1);
      expect([...m.engine.peekClips().monthHolds]).toEqual([]);
      expect(m.engine.peekClips().unit).toBeNull();
      // Every member of the batch ended, and a cancelled one says why.
      const running = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload.jobId] : [])).filter((id, i, all) => all.indexOf(id) === i);
      for (const id of running) {
        const end = endOf(m.events, id);
        expect(end).toBeDefined();
        if (end?.type === "job.cancelled") expect(detailOf(end)).toBeDefined();
      }
      expect(jobIds.length).toBe(size);
    });
  }

  test("the seeds took the paths that matter: a free refusal into Grok, a 429, a cancel, an uncertain stop and a halted-ledger stop", () => {
    for (const path of ["grok", "429", "cancelled", "money-uncertain", "ledger-stopped"]) expect(seen.has(path)).toBe(true);
  });
});
