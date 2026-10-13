import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { MoneyStatus, ReconcileResult } from "../shared/engine";
import { clipNetwork, command, create, jobEnd, jobIdOf, phasesOf, seedClipAvatar, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { SHORT_CLIP_TIMINGS } from "./clips/timings";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 I5.48, I5.50, §5.12): the clip's money in the engine. While the clip's money is open the reconcile is refused IN_FLIGHT; once it closed, the hold
// registry keeps the reconcile TOO_SOON while an attempt of the clip may still bill, and then lets it run. A held abandoned reserve of this process is not a reconcile reason (the
// renderer's paidStop would stop every paid action for nothing), `money.changed` reaches the windows at every hold transition, and a shutdown silences the registry.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clips-money-");
const libraryDir = () => join(dir(), "library");

async function moneyStatus(engine: ClipEngine): Promise<Extract<MoneyStatus, { ledger: "open" }>> {
  const answer = await engine.engine.handle(command("money.status"));
  if (!answer.ok || answer.type !== "money.status" || answer.result.ledger !== "open") throw new Error(`no open money status: ${JSON.stringify(answer)}`);
  return answer.result;
}

async function reconcile(engine: ClipEngine): Promise<{ ok: true; result: ReconcileResult } | { ok: false; code: string }> {
  const answer = await engine.engine.handle(command("money.reconcile"));
  if (!answer.ok) return { ok: false, code: answer.error.code };
  if (answer.type !== "money.reconcile") throw new Error("wrong answer");
  return { ok: true, result: answer.result };
}

function moneyEvents(engine: ClipEngine): MoneyStatus[] {
  return engine.events().flatMap((e) => (e.type === "money.changed" ? [e.payload.status] : []));
}

/** An uncertain submit (a 502 at the POST): the clip ends at once, its reserve stays open at worst, held 20 min (1.2 s on the short set) from the reserve line. */
async function uncertainClip(engine: ClipEngine, avatarId: string, photoId: string): Promise<string> {
  const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
  expect((await jobEnd(engine, jobId)).type).toBe("job.done");
  return jobId;
}

describe("the reconcile and a clip", () => {
  test("is refused IN_FLIGHT while the clip's money is open", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }) });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    await until(() => phasesOf(engine, jobId).includes("rendering"), "rendering");
    expect(await reconcile(engine)).toEqual({ ok: false, code: "IN_FLIGHT" });
    engine.net.release("kling");
    await jobEnd(engine, jobId);
  });

  test("answers TOO_SOON while the hold registry holds an entry, and runs once it is gone", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }) });
    await uncertainClip(engine, avatarId, photoId);

    const held = await reconcile(engine);
    expect(held).toMatchObject({ ok: true, result: { status: "too-early" } });
    if (!held.ok || held.result.status !== "too-early") throw new Error("unreachable");
    expect(held.result.retryAfterMs).toBeGreaterThan(0);
    expect(held.result.retryAfterMs).toBeLessThanOrEqual(SHORT_CLIP_TIMINGS.holdUncertainMs);

    await until(() => moneyEvents(engine).some((s) => s.ledger === "open" && s.reconcileNeeded), "the hold's end");
    // The quiet wait the reconcile keeps on its own (/credits lags) is passed by moving the clocks, not by waiting it out.
    engine.clocks.skew(10 * 60_000);
    expect(await reconcile(engine)).toMatchObject({ ok: true, result: { status: "done", closedReserves: 1 } });
  });
});

describe("money.status with a held clip reserve", () => {
  test("leaves this process's held abandoned reserve out of the reconcile reasons, keeps it unsettled, and says when the reconcile can run", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }) });
    const jobId = await uncertainClip(engine, avatarId, photoId);

    const status = await moneyStatus(engine);
    expect(status).toMatchObject({ reconcileNeeded: false, reconcileReasons: [], unsettledMicros: 504_000, unsettledCount: 1 });
    const at = Date.parse(String(ledgerLines(dir()).find((l) => l.type === "reserve" && l.attemptId === `${jobId}:video#1`)?.at));
    expect(status.reconcileAvailableAt).toBe(new Date(at + SHORT_CLIP_TIMINGS.holdUncertainMs).toISOString());
  });

  test("after the hold the same reserve is `open-reserves`, with no time to wait for", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }) });
    await uncertainClip(engine, avatarId, photoId);
    await until(() => moneyEvents(engine).some((s) => s.ledger === "open" && s.reconcileNeeded), "the hold's end");

    const status = await moneyStatus(engine);
    expect(status).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledMicros: 504_000 });
    expect(status).not.toHaveProperty("reconcileAvailableAt");
  });

  test("a paid command still runs while the reserve is held, and after: RECONCILE_REQUIRED never comes from this process's own reserves", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ kling: { submit: { status: 502 } } });
    const engine = await startClipEngine(dir(), { net });
    await uncertainClip(engine, avatarId, photoId);
    const whileHeld = jobIdOf(await create(engine, { avatarId, photoId }));
    await jobEnd(engine, whileHeld);
    await until(() => moneyEvents(engine).some((s) => s.ledger === "open" && s.reconcileNeeded), "the hold's end");
    const after = await create(engine, { avatarId, photoId });
    expect(after.ok).toBe(true);
    await jobEnd(engine, jobIdOf(after));
  });

  test("money.changed reaches the windows when the hold is taken and when it ends, with no ledger write at the end", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }) });
    await uncertainClip(engine, avatarId, photoId);
    const linesAtEnd = ledgerLines(dir()).length;
    const held = moneyEvents(engine).filter((s) => s.ledger === "open" && s.reconcileAvailableAt !== undefined);
    expect(held.length).toBeGreaterThan(0);

    await until(() => moneyEvents(engine).some((s) => s.ledger === "open" && s.reconcileNeeded), "the hold's end");
    const last = moneyEvents(engine).at(-1);
    expect(last).toMatchObject({ ledger: "open", reconcileNeeded: true });
    expect(last).not.toHaveProperty("reconcileAvailableAt");
    expect(ledgerLines(dir())).toHaveLength(linesAtEnd);
  });

  test("with no hold, money.status carries no reconcileAvailableAt", async () => {
    await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir());
    expect(await moneyStatus(engine)).not.toHaveProperty("reconcileAvailableAt");
  });
});

describe("engine.shutdown", () => {
  test("clears the hold registry's timers: nothing is announced after it", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }) });
    await uncertainClip(engine, avatarId, photoId);
    expect((await moneyStatus(engine)).reconcileAvailableAt).toBeDefined();

    await engine.engine.shutdown();
    const announced = moneyEvents(engine).length;
    await new Promise((resolve) => setTimeout(resolve, SHORT_CLIP_TIMINGS.holdUncertainMs + 300));
    expect(moneyEvents(engine)).toHaveLength(announced);
  });

  test("does not wait for a clip in flight: its reserve stays open at worst for the next start's reconcile", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }) });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    await until(() => phasesOf(engine, jobId).includes("rendering"), "rendering");

    await engine.engine.shutdown();
    await jobEnd(engine, jobId);
    expect(ledgerLines(dir()).map((l) => l.type)).toEqual(["reserve"]);
  });
});
