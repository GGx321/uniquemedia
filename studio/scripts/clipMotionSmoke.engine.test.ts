import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clipsDir as clipsDirOf, command, create, jobEnd, jobIdOf, seedClipAvatar, startClipEngine } from "../engine/clips/testing/engineClipKit";
import { ledgerLines, useEngineDir } from "../engine/testing/engineHarness";
import type { OpenRouterFetch, OpenRouterRequestInit } from "../engine/openrouter/types";
import { ownIdeaLabel } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { canaryProblems, motionLedgerProblems, type Haystack } from "./clipMotionSmoke";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC4: the packaged smoke's part C scenario, without Electron. The REAL engine (a real library, the real photo downscale) talks HTTP to the smoke's mock OpenRouter on loopback, and the checks the smoke
// makes (clipMotionSmoke.ts) are made here on what the two did: one suggestion and one translation over the mock's chat route, the stored motions listed by the sheet, a clip made from the translated idea, the ledger
// where the mock's bill is, and the I5.67 canary: no fragment longer than 40 characters of the owner's idea is in any file, log line, event or video request. This is how the mock's chat route is held against the engine's
// writer and translator before CI runs the packaged app.

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-clip-motion-smoke-engine-");
/** More than 40 characters, so a fragment of it can be told from its label. */
const IDEA = "медленно поворачивает голову к окну и улыбается, CANARY-9c41";

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

function towards(m: MockOpenRouter): OpenRouterFetch {
  return (url: string, init: OpenRouterRequestInit) => nativeFetch(url.replace(ENGINE_BASE, m.url), init);
}

/** Every file under `root` as text (a binary file is read as text too: a fragment of the idea would show in it all the same). */
async function filesUnder(root: string): Promise<Haystack[]> {
  const found: Haystack[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.push({ where: `the file ${path.slice(root.length)}`, text: await readFile(path, "latin1").then((latin) => latin + "\n" + Buffer.from(latin, "latin1").toString("utf8")) });
  }
  return found;
}

async function answer(engine: Awaited<ReturnType<typeof startClipEngine>>, type: string, payload: object): Promise<Record<string, unknown>> {
  const response = await engine.engine.handle(command(type, payload));
  if (!response.ok) throw new Error(`${type} answered ${response.error.code}`);
  return response.result as Record<string, unknown>;
}

describe("the smoke's part C scenario, against the real engine", () => {
  test("a suggestion and a translation over the mock's chat route are paid and stored, the sheet lists them, a clip is made from the idea, and nothing of his words is anywhere but the translator's request", async () => {
    const logs: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      mock = await startMockOpenRouter({ descriptorText: "A woman.", clips: { generationAfterMs: 30 }, motions: true });
      const { avatarId, photoId } = await seedClipAvatar(join(dir(), "library"));
      const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock) } });

      // 1. The estimates are free; the suggestion is paid at the mock's bill and joins the sheet.
      const suggestEstimate = await answer(engine, "clips.estimateSuggest", { avatarId, photoId });
      const ideaEstimate = await answer(engine, "clips.estimateIdea", { avatarId, photoId });
      expect(mock.motionRequests()).toHaveLength(0);
      const suggested = await answer(engine, "clips.suggestMotions", { avatarId, photoId, acceptedWorstMicros: suggestEstimate.worstMicros });
      expect(suggested).toMatchObject({ outcome: "ok", costMicros: 3_400, motions: [{ id: "v-1" }, { id: "v-2" }, { id: "v-3" }], reading: { notes: [] } });

      // 2. The idea is translated and stored under his label.
      const translated = await answer(engine, "clips.translateIdea", { avatarId, photoId, text: IDEA, acceptedWorstMicros: ideaEstimate.worstMicros });
      expect(translated).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: ownIdeaLabel(IDEA), text: "she tilts her head a little to one side and smiles" }, costMicros: 1_000 });
      expect(mock.motionRequests().map((r) => r.schemaName)).toEqual(["motion_suggestions", "motion_idea"]);

      // 3. The sheet lists the three suggestions and the idea after the code's, and a clip is made from the idea.
      const options = await answer(engine, "clips.options", { avatarId, photoId });
      const motions = (options.motions as { id: string }[]).map((m) => m.id);
      expect(motions).toEqual(["g-blink", "g-tilt", "g-breath", "v-1", "v-2", "v-3", "o-1"]);
      expect(options.reading).toEqual({ notes: [] });
      const clipId = jobIdOf(await create(engine, { avatarId, photoId, motionId: "o-1" }));
      expect((await jobEnd(engine, clipId)).type).toBe("job.done");
      const listed = (await answer(engine, "clips.list", { avatarId })) as { clips: { motion: { source: string; label: string; text: string } }[] };
      expect(listed.clips[0]?.motion).toEqual({ source: "own", label: ownIdeaLabel(IDEA), text: "she tilts her head a little to one side and smiles" });

      // 4. The ledger is where the mock's bill is, the calls were reserved and settled, and nothing is open.
      const lines = ledgerLines(dir()).flatMap((l) => (typeof l.attemptId === "string" ? [{ type: String(l.type), attemptId: l.attemptId }] : []));
      expect(motionLedgerProblems(lines, ["motion", "idea"])).toEqual([]);
      const money = await answer(engine, "money.status", {});
      expect(money).toMatchObject({ spentMicros: Math.round(mock.totalUsageUsd() * 1_000_000), unsettledMicros: 0, unsettledCount: 0 });
      expect(mock.totalUsageUsd()).toBeCloseTo(0.0034 + 0.001 + 0.42, 9);

      // 5. The canary (I5.67): the translator's request holds his words as JSON data, and nowhere else is a fragment of them.
      const translatorRequest = mock.motionRequests()[1];
      expect(translatorRequest?.bodyText).toContain(IDEA);
      const writerRequest = mock.motionRequests()[0];
      const videoRequests = mock.requests.filter((r) => r.path.endsWith("/videos") && r.method === "POST");
      expect(videoRequests.length).toBeGreaterThan(0);
      const places: Haystack[] = [
        ...(await filesUnder(dir())),
        { where: "an event the engine posted", text: JSON.stringify(engine.posted) },
        { where: "a log line", text: logs.join("\n") },
        { where: "the writer's chat request", text: writerRequest?.bodyText ?? "" },
        ...videoRequests.map((r, i) => ({ where: `video request ${i + 1}`, text: r.bodyText })),
      ];
      expect(places.length).toBeGreaterThan(10);
      expect(canaryProblems(IDEA, places)).toEqual([]);
      expect(clipsDirOf(join(dir(), "library"), avatarId)).toContain(avatarId);
      expect(mock.unexpected).toEqual([]);
    } finally {
      console.warn = warn;
      console.error = error;
    }
  });

  test("the canary bites: the same scan finds the idea in the one place it is allowed to be", async () => {
    mock = await startMockOpenRouter({ descriptorText: "A woman.", motions: true });
    const { avatarId, photoId } = await seedClipAvatar(join(dir(), "library"));
    const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock) } });
    const estimate = await answer(engine, "clips.estimateIdea", { avatarId, photoId });
    await answer(engine, "clips.translateIdea", { avatarId, photoId, text: IDEA, acceptedWorstMicros: estimate.worstMicros });
    const request = mock.motionRequests()[0];
    expect(canaryProblems(IDEA, [{ where: "the translator's request", text: request?.bodyText ?? "" }])).toHaveLength(1);
  });
});
