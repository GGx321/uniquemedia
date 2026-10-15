import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { batchOf, cancelBatch, createBatch, jobsOf, mostOpenClipReserves, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, command, startClipEngine, until, type ClipEngine, type VideoScript } from "./clips/testing/engineClipKit";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { join } from "node:path";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 §8 «invariants on every path»): a batch is walked through random but fixed scripts: clean clips, free refusals, a 429, an uncertain submit, a bill above the reserve, and a
// cancel of the queue at a random moment. On every path: never two members between their reserve and their settle, the paid count balanced (the reconcile is never held IN_FLIGHT after the batch), the hold
// map empty, and no cap left behind (the month's room is the budget less what was spent and what is still open at worst).

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-engine-clip-batch-property-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;
const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** What a POST does, drawn from a weighted pool: mostly clean, and now and then something that ends or stops a batch. */
function scriptFor(draw: number): VideoScript | undefined {
  if (draw < 0.5) return undefined;
  if (draw < 0.65) return { terminal: { status: "failed", error: RISK_CONTROL } };
  if (draw < 0.8) return { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };
  if (draw < 0.9) return { submit: { status: 502 } };
  return { terminal: { status: "completed", cost: 0.6 } };
}

async function settled(engine: ClipEngine): Promise<void> {
  // The unit is given back (the reconcile is not held IN_FLIGHT) and every clip job has ended.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await engine.engine.handle(command("money.reconcile"));
    const unitFree = !(answer.ok === false && answer.error.code === "IN_FLIGHT");
    const running = (await jobsOf(engine)).some((job) => job.kind === "clip" && job.status === "running");
    if (unitFree && !running) return;
    if (Date.now() > deadline) throw new Error("the batch did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What the seeds below actually exercised: a property over paths that never took one would pass for nothing. */
const seen = new Set<string>();

describe("a batch on every path (fixed seeds)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    test(`seed ${seed}: one reserve open at a time, the paid count balanced, no hold and no cap left`, async () => {
      const rand = seeded(seed * 7919);
      const size = 1 + Math.floor(rand() * 4);
      const draws = Array.from({ length: 12 }, () => rand());
      const cancelAfter = rand() < 0.35 ? Math.floor(rand() * 3) : -1;
      const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(size));
      const net = clipNetwork({ klingBy: (n) => scriptFor(draws[(n - 1) % draws.length] ?? 1) });
      const engine = await startClipEngine(dir(), { net, monthlyBudgetMicros: BUDGET });

      let postsAtCancel = 0;
      const { batchId } = batchOf(await createBatch(engine, { avatarId, photoIds }));
      if (cancelAfter >= 0) {
        await until(() => engine.net.posts("kling").length > cancelAfter, "the cancel point").catch(() => undefined);
        await cancelBatch(engine, avatarId, batchId);
        // The member in flight at the cancel may still have its one POST to make; no other may follow it.
        postsAtCancel = engine.net.posts("kling").length;
      }
      await settled(engine);
      if (cancelAfter >= 0) expect(engine.net.posts("kling").length).toBeLessThanOrEqual(postsAtCancel + 1);

      const lines = ledgerLines(dir());
      for (const event of engine.events()) {
        if (event.type === "job.cancelled" && event.payload.kind === "clip" && event.payload.detail !== undefined) seen.add(event.payload.detail);
        if (event.type === "job.progress" && event.payload.kind === "clip" && event.payload.waitReason === "rate-limit") seen.add("429");
      }
      if (lines.some((line) => line.type === "reserve" && String(line.attemptId).endsWith("#2"))) seen.add("grok");
      expect(mostOpenClipReserves(lines)).toBeLessThanOrEqual(1);
      const status = engine.engine.budget?.status();
      expect(status?.heldMicros).toBe(0);
      const open = status?.openReserveMicros ?? 0;
      expect(engine.engine.monthRoom()?.freeMicros).toBe(BUDGET - (status?.spentThisMonthMicros ?? 0) - open);
      // No member sits queued, and the unit is free: the next batch is refused for anything but IN_FLIGHT, unless a clip's money is still open (WB2d, L2): then it is refused `one-at-a-time`, free.
      expect((await jobsOf(engine)).some((job) => job.kind === "clip" && job.status === "running")).toBe(false);
      const moneyOpen = (engine.engine.budget?.ledger.openReserves().length ?? 0) > 0;
      const next = await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) });
      if (moneyOpen) expect(next).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
      else if (!next.ok) expect(next.error.code).not.toBe("IN_FLIGHT");
      await settled(engine);
    });
  }

  test("the seeds took the paths that matter: a free refusal into Grok, a 429, a cancel, an uncertain stop and a halted-ledger stop", () => {
    for (const path of ["grok", "429", "cancelled", "money-uncertain", "ledger-stopped"]) expect(seen.has(path)).toBe(true);
  });
});
