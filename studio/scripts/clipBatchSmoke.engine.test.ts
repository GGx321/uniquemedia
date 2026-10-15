import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { batchOf, createBatch, plainPhotos, seedBatchAvatar } from "../engine/clips/testing/batchKit";
import { command, jobEnd, startClipEngine } from "../engine/clips/testing/engineClipKit";
import { VIDEO_TIERS } from "../engine/money/prices";
import { ledgerLines, useEngineDir } from "../engine/testing/engineHarness";
import type { OpenRouterFetch, OpenRouterRequestInit } from "../engine/openrouter/types";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { batchClipProblems, batchLedgerProblems, clipPostProblems, refusedJobProblems } from "./clipSmoke";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB3: the packaged smoke's batch scenario, without Electron. The REAL engine (the short timing set, a real library) talks HTTP to the smoke's mock OpenRouter on loopback, and the checks
// the smoke makes (clipSmoke.ts) are made here on what the two did: a batch of three, the first member refused by the provider's risk control and proven free, followed by Grok; one POST per attempt id, never
// two clip reserves open at once, the ledger where the mock's bill is, and every member's record telling its place. This is how the mock's routes are held against the batch before CI runs the packaged app.

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-clip-batch-smoke-engine-");
const KLING = VIDEO_TIERS.std.model;
const GROK = VIDEO_TIERS.grok.model;

// The test preload swaps the global fetch for happy-dom's; Bun's own speaks plain HTTP to the loopback mock.
const nativeFetch = Bun.fetch;
const happyDomResponse = globalThis.Response;
const sample = await nativeFetch("data:,");
const nativeResponse = sample.constructor;
beforeAll(() => {
  if (typeof nativeResponse === "function") globalThis.Response = nativeResponse as typeof Response;
});
afterAll(() => {
  globalThis.Response = happyDomResponse;
});
const ENGINE_BASE = "https://openrouter.ai/api/v1";

let mock: MockOpenRouter | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

/** The engine's fetch, pointed at the mock: the engine's base URL becomes the mock's, nothing else changes. */
function towards(m: MockOpenRouter): OpenRouterFetch {
  return (url: string, init: OpenRouterRequestInit) => nativeFetch(url.replace(ENGINE_BASE, m.url), init);
}

describe("the smoke's batch scenario, against the real engine", () => {
  test("a batch of three, the first refused for free and made on Grok: one POST per attempt id, one clip money unit at a time, every record tells its place, and the ledger is where the mock's bill is", async () => {
    mock = await startMockOpenRouter({ descriptorText: "A woman.", clips: { generationAfterMs: 30 } });
    const { avatarId, photoIds } = await seedBatchAvatar(join(dir(), "library"), plainPhotos(3));
    const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock) } });

    // The risk control refuses the first Kling job at the poll: proven free by two /generation readings (the API's 404) and a quiet account; Grok follows by itself.
    mock.armVideoRefusal(KLING);
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    expect(jobIds).toHaveLength(3);
    for (const id of jobIds) expect((await jobEnd(engine, id)).type).toBe("job.done");

    // One POST per attempt id, the models in order: Kling (refused), Grok behind it, then Kling for each of the other two.
    const attemptIds = ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
    expect(attemptIds).toEqual([`${jobIds[0]}:video#1`, `${jobIds[0]}:video#2`, `${jobIds[1]}:video#1`, `${jobIds[2]}:video#1`]);
    expect(clipPostProblems(mock.videoRequests(), attemptIds, [KLING, GROK, KLING, KLING])).toEqual([]);
    const refused = mock.videoRequests()[0]?.id ?? "";
    expect(refusedJobProblems(mock.videoCalls(), refused)).toEqual([]);

    // Never two clip reserves open at once, and the attempts are in the batch's order.
    const lines = ledgerLines(dir()).flatMap((l) => (typeof l.attemptId === "string" ? [{ type: String(l.type), attemptId: l.attemptId }] : []));
    expect(batchLedgerProblems(lines, attemptIds)).toEqual([]);

    // Every member's record tells its place; the first is made by Grok behind a free Kling.
    const listed = await engine.engine.handle(command("clips.list", { avatarId }));
    if (!listed.ok || listed.type !== "clips.list") throw new Error("no clips");
    const clips = listed.result.clips;
    expect(batchClipProblems(clips, batchId, 3)).toEqual([]);
    const byPlace = [...clips].sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
    expect(byPlace.map((c) => [c.model, c.fallback, c.cost.kind, c.cost.micros])).toEqual([
      ["grok", true, "billed", 710_000],
      ["kling-std", false, "billed", 420_000],
      ["kling-std", false, "billed", 420_000],
    ]);

    // The ledger is where the mock's bill is, and nothing is open.
    const money = await engine.engine.handle(command("money.status", {}));
    if (!money.ok || money.type !== "money.status" || money.result.ledger !== "open") throw new Error("no money status");
    expect(money.result).toMatchObject({ spentMicros: Math.round(mock.totalUsageUsd() * 1_000_000), unsettledMicros: 0, unsettledCount: 0 });
    expect(mock.totalUsageUsd()).toBeCloseTo(0.71 + 0.42 + 0.42, 9);
    // The batch is over: a cancel finds nothing queued, and the engine never asked for a route the mock does not know.
    expect(await engine.engine.handle(command("clips.cancelBatch", { avatarId, batchId }))).toMatchObject({ ok: true, result: { cancelled: 0 } });
    expect(mock.unexpected).toEqual([]);
  });
});
