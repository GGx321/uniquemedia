import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { IDLE_STEPS } from "./autopilot/steps";
import { batchOf, createBatch, jobsOf, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, jobEnd, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2d: the follow-ups of the whole-part money review of part B1, in the real engine with a fake OpenRouter.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clip-batch-followups-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;

async function started(opts: Parameters<typeof startClipEngine>[1] = {}): Promise<ClipEngine> {
  return startClipEngine(dir(), { monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS }, ...opts });
}

describe("L2: a batch does not start while a clip's money is still open", () => {
  test("after an uncertain submit the same process refuses a new batch, free: no job, no POST, no hold, no new ledger line", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { submit: { status: 502 } } : undefined) }) });
    const first = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    await jobEnd(engine, first.jobIds[0] ?? "");
    await until(() => engine.engine.budget?.ledger.openReserves().length === 1, "the open reserve");
    const jobsBefore = (await jobsOf(engine)).length;
    const linesBefore = ledgerLines(dir()).length;

    // The batch gives the unit back a moment after its member's money closed: wait it out, so the refusal is about the money and not about the unit.
    let answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    for (let i = 0; i < 200 && !answer.ok && answer.error.clipReason === "batch-running"; i++) {
      await Bun.sleep(5);
      answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    }

    expect(answer).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    expect((await jobsOf(engine)).length).toBe(jobsBefore);
    expect(ledgerLines(dir())).toHaveLength(linesBefore);
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
  });

  test("a batch is allowed again when no clip reserve is open", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    const one = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    await jobEnd(engine, one.jobIds[0] ?? "");
    await until(() => engine.engine.budget?.ledger.openReserves().length === 0, "the closed reserve");

    let answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    for (let i = 0; i < 200 && !answer.ok && answer.error.clipReason === "batch-running"; i++) {
      await Bun.sleep(5);
      answer = await createBatch(engine, { avatarId, photoIds: photoIds.slice(1) });
    }
    const two = batchOf(answer);
    await jobEnd(engine, two.jobIds[0] ?? "");
  });
});
