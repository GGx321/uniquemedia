import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { batchOf, createBatch, jobsOf, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, clipsDir, jobEnd, phasesOf, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import type { EngineDeps } from "./engine";
import { BATCHES_DIR } from "./clips/batchSummary";
import { readClipRecord } from "./clips/store";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "./clips/timings";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 I5.63; §8 «shutdown mid-batch»): a quit in the middle of a batch, then a new engine on the same folders. The queued members are memory-only and are dropped for free; the
// member that was sent follows 5b.1's restart rules (recovered for free, never adopted, its reserve left to the reconcile); and no batch resumes or spends after a restart.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clip-batch-restart-");
const libraryDir = () => join(dir(), "library");
const ledgerPath = () => join(dir(), "userData", "ledger.jsonl");
const MIN = 60_000;
const BUDGET = 10_000_000;
/** The short set, but with a long give-up time (a slow machine must not turn a recovery into `late`) and a terminal hold that outlasts the test's reads. */
const TIMINGS: ClipTimings = { ...SHORT_CLIP_TIMINGS, lateGiveUpMs: 10 * MIN, holdTerminalMs: 30_000, holdUncertainMs: 30_000, holdSubmittedMs: 10 * MIN };

/**
 * Windows as CI 38713903237 met it (S5.WB2c): each rename of a batch summary is refused once with EPERM, as while another handle holds the file, and the shared atomic write's retry waits a real moment before the
 * next try, so a write is in flight (its temp file on disk) for a while.
 */
function windowsRenames(): EngineDeps["clipBatchSummaryRetry"] {
  const refused = new Set<string>();
  return {
    platform: "win32",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 300))),
    rename: async (from, to) => {
      if (!refused.has(from)) {
        refused.add(from);
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      }
      await rename(from, to);
    },
  };
}

/** A batch of `n` whose first member is in `rendering` when the process stops: its reserve and journal are on disk, the rest were only in memory. */
async function quitMidBatch(n = 3, deps: Partial<EngineDeps> = {}): Promise<{ avatarId: string; photoIds: string[]; batchId: string; jobIds: string[]; first: ClipEngine }> {
  const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(n));
  const first = await startClipEngine(dir(), { net: clipNetwork({ klingBy: (k) => (k === 1 ? { held: true } : undefined) }), timings: TIMINGS, monthlyBudgetMicros: BUDGET, deps });
  const { batchId, jobIds } = batchOf(await createBatch(first, { avatarId, photoIds }));
  await until(() => phasesOf(first, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
  await first.engine.shutdown();
  for (const id of jobIds) await jobEnd(first, id);
  return { avatarId, photoIds, batchId, jobIds, first };
}

async function clipJobDone(engine: ClipEngine): Promise<void> {
  await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "a clip job's end");
}

describe("a quit in the middle of a batch", () => {
  test("drops the queued members for free: no record, no journal, no reserve, and no hold or cap is left", async () => {
    const { avatarId, batchId, jobIds, first } = await quitMidBatch(3, { clipBatchSummaryRetry: windowsRenames() });

    const ends = jobIds.map((id) => first.events().find((e) => (e.type === "job.cancelled" || e.type === "job.done") && "jobId" in e.payload && e.payload.jobId === id));
    expect(ends.map((e) => e?.type)).toEqual(["job.cancelled", "job.cancelled", "job.cancelled"]);
    // Only the member that was sent left anything of its own on disk; the other two were memory-only. (5b.2, S5.WB2c: beside the clips, the batch's own summary is in `batches/`; it is the batch's, not a member's.)
    expect((await readdir(clipsDir(libraryDir(), avatarId))).filter((name) => name !== BATCHES_DIR).sort()).toEqual([`${jobIds[0]}.journal.jsonl`]);
    // The batch's last changes (its dropped members, its end) are written after the shutdown stopped it: the folder is looked at once they are all written (CI 38713903237 listed it mid-write on Windows).
    await first.engine.clipSummariesSettled();
    expect(await readdir(join(clipsDir(libraryDir(), avatarId), BATCHES_DIR))).toEqual([`${batchId}.json`]);
    expect(ledgerLines(dir()).map((l) => [l.type, l.attemptId])).toEqual([["reserve", `${jobIds[0]}:video#1`]]);
    expect(first.engine.budget?.status().heldMicros).toBe(0);
    expect(first.net.posts("kling")).toHaveLength(1);
  });

  test("the sent member is recovered for free by the new engine as a single clip is, and its record carries the batch trio; nothing is adopted or spent", async () => {
    const { avatarId, batchId, jobIds } = await quitMidBatch(3);
    const before = await readFile(ledgerPath(), "utf8");

    const second = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET });
    await clipJobDone(second);

    const read = await readClipRecord(clipsDir(libraryDir(), avatarId), jobIds[0] ?? "");
    if (read.kind !== "record") throw new Error(`expected a record, got ${read.kind}`);
    expect(read.record).toMatchObject({ recovered: true, outcome: { status: "ready" }, batchId, batchIndex: 1, batchSize: 3 });
    // Reconcile, not adopt: the ledger is exactly what the first process left, and the reserve is still open.
    expect(await readFile(ledgerPath(), "utf8")).toBe(before);
    expect(second.net.posts()).toHaveLength(0);
  });

  test("no batch resumes after a restart: the new engine has the one recovery job and no job, record or reserve for the queued members", async () => {
    const { avatarId, jobIds } = await quitMidBatch(3);

    const second = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET });
    await clipJobDone(second);

    const clipJobs = (await jobsOf(second)).filter((job) => job.kind === "clip");
    expect(clipJobs).toHaveLength(1);
    expect(clipJobs[0]).toMatchObject({ clipId: jobIds[0], status: "done" });
    expect(second.events().find((e) => e.type === "job.progress" && e.payload.kind === "clip")?.payload).toMatchObject({ clipId: jobIds[0], phase: "recovering" });
    for (const id of jobIds.slice(1)) {
      expect(existsSync(join(clipsDir(libraryDir(), avatarId), `${id}.json`))).toBe(false);
      expect(ledgerLines(dir()).some((l) => String(l.attemptId).startsWith(id))).toBe(false);
    }
    expect(second.net.posts()).toHaveLength(0);
    expect(second.engine.budget?.status().heldMicros).toBe(0);
  });

  test("the recovery job of the sent member tells its place in the batch in every event, so the header counts it", async () => {
    const { batchId, jobIds } = await quitMidBatch(3);
    const second = await startClipEngine(dir(), { timings: TIMINGS, monthlyBudgetMicros: BUDGET });
    await clipJobDone(second);

    const progress = second.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload] : []));
    expect(progress.length).toBeGreaterThan(0);
    for (const event of progress) expect(event).toMatchObject({ clipId: jobIds[0], batchId, batchIndex: 1, batchSize: 3 });
  });
});
