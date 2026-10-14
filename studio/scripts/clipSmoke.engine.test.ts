import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { verifyClipExport } from "../engine/clips/exportVerify";
import { clipsDir as clipsDirOf, command, create, jobEnd, jobIdOf, seedClipAvatar, startClipEngine, type ClipEngine } from "../engine/clips/testing/engineClipKit";
import { VIDEO_TIERS } from "../engine/money/prices";
import { ledgerLines, useEngineDir } from "../engine/testing/engineHarness";
import type { OpenRouterFetch, OpenRouterRequestInit } from "../engine/openrouter/types";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { clipPostProblems, exportedCopyProblems, refusedJobProblems } from "./clipSmoke";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
useNativeGlobals();

// Stage 5, 5b.1, S5.V7: the packaged smoke's clip scenario, without Electron. The REAL engine (the short timing set, a real library and export folder) talks HTTP to the smoke's mock OpenRouter on loopback,
// and the checks the smoke makes (clipSmoke.ts) are made here on what the two did: the happy path, a content refusal proven free and followed by Grok, one POST per attempt id, the ledger where
// the mock's bill is, and one export whose file passes I5.58. This is how the mock's routes are held against the engine's client before CI runs the packaged app.

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-clip-smoke-engine-");
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

async function ready(): Promise<{ engine: ClipEngine; m: MockOpenRouter; avatarId: string; photoId: string }> {
  mock = await startMockOpenRouter({ descriptorText: "A woman.", clips: { generationAfterMs: 30 } });
  const { avatarId, photoId } = await seedClipAvatar(join(dir(), "library"));
  const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock), clipSwitches: { exportFps: "duplicate" } } });
  return { engine, m: mock, avatarId, photoId };
}

async function answer(engine: ClipEngine, type: string, payload: object) {
  const response = await engine.engine.handle(command(type, payload));
  if (!response.ok) throw new Error(`${type} answered ${response.error.code}`);
  return response.result;
}

describe("the smoke's clip scenario, against the real engine", () => {
  test("a clip is made, a refusal proven free is followed by Grok, and every attempt is one POST, billed as the mock billed it", async () => {
    const { engine, m, avatarId, photoId } = await ready();

    // 1. The happy path.
    const first = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, first)).type).toBe("job.done");
    expect(m.videoRequests().map((r) => r.model)).toEqual([KLING]);

    // 2. A content refusal at the poll: proven free by two /generation readings (the API's 404) and a quiet account; Grok follows by itself.
    m.armVideoRefusal(KLING);
    const second = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, second)).type).toBe("job.done");

    const listed = (await answer(engine, "clips.list", { avatarId })) as { clips: { clipId: string; status: string; model: string; fallback: boolean; cost: { micros: number; kind: string } }[] };
    expect(listed.clips.map((c) => [c.clipId, c.status, c.model, c.fallback, c.cost.kind])).toEqual([
      [second, "ready", "grok", true, "billed"],
      [first, "ready", "kling-std", false, "billed"],
    ]);

    // 3. One POST per attempt id, the models in order; the refused job is free and ends there.
    const attemptIds = ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
    expect(attemptIds).toEqual([`${first}:video#1`, `${second}:video#1`, `${second}:video#2`]);
    expect(clipPostProblems(m.videoRequests(), attemptIds, [KLING, KLING, GROK])).toEqual([]);
    const refused = m.videoRequests()[1]?.id ?? "";
    expect(refusedJobProblems(m.videoCalls(), refused)).toEqual([]);

    // 4. The ledger is where the mock's bill is, and nothing is open.
    const money = (await answer(engine, "money.status", {})) as { spentMicros: number; unsettledMicros: number; unsettledCount: number };
    expect(money).toMatchObject({ spentMicros: Math.round(m.totalUsageUsd() * 1_000_000), unsettledMicros: 0, unsettledCount: 0 });
    expect(m.totalUsageUsd()).toBeCloseTo(0.42 + 0.71, 9);
    expect(m.unexpected).toEqual([]);
  });

  test("a clip whose bill is not on the poll is billed from /generation once the record appears, and the ledger agrees with the mock", async () => {
    mock = await startMockOpenRouter({ descriptorText: "A woman.", clips: { generationAfterMs: 10, usageOnPoll: false } });
    const { avatarId, photoId } = await seedClipAvatar(join(dir(), "library"));
    const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock) } });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");
    const money = (await answer(engine, "money.status", {})) as { spentMicros: number; unsettledMicros: number };
    expect(money).toMatchObject({ spentMicros: 420_000, unsettledMicros: 0 });
    expect(mock.videoCalls().filter((c) => c.kind === "generation").map((c) => c.status)).toContain(200);
    expect(mock.unexpected).toEqual([]);
  });

  test("an export of the clip is a copy whose name and file pass the smoke's checks (I5.55, I5.58)", async () => {
    const { engine, m, avatarId, photoId } = await ready();
    const clipId = jobIdOf(await create(engine, { avatarId, photoId }));
    await jobEnd(engine, clipId);
    const exportJob = (await answer(engine, "clips.export", { avatarId, clipId })) as { jobId: string };
    const end = await jobEnd(engine, exportJob.jobId);
    const relPath = end.type === "job.done" && end.payload.result.kind === "clip" ? end.payload.result.exported?.relPath : undefined;
    const got = (await answer(engine, "clips.get", { avatarId, clipId })) as { clip: { exports: { at: string; fileState?: string }[] } };
    const [line] = got.clip.exports;
    expect(line?.fileState).toBe("present");
    const verdict = await verifyClipExport(join(dir(), "export", relPath ?? "-"), { createdAt: new Date(line?.at ?? 0) });
    expect(exportedCopyProblems(relPath, verdict)).toEqual([]);
    expect(clipsDirOf(join(dir(), "library"), avatarId)).toContain(avatarId);
    expect(m.unexpected).toEqual([]);
  });
});
