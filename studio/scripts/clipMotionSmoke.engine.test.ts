import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clipsDir as clipsDirOf, command, create, jobEnd, jobIdOf, seedClipAvatar, startClipEngine } from "../engine/clips/testing/engineClipKit";
import { ledgerLines, useEngineDir } from "../engine/testing/engineHarness";
import type { OpenRouterFetch, OpenRouterRequestInit } from "../engine/openrouter/types";
import { ownIdeaLabel } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { canaryProblems, filePlace, motionLedgerProblems, type Haystack } from "./clipMotionSmoke";
import { DEFAULT_MOTION_SUGGESTIONS, DEFAULT_MOTION_TRANSLATION, startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
import { pick, sceneRun, slotOf } from "../engine/clips/testing/frameFixtures";
import { openLibrary } from "../engine/library";
import { RunPlanSchema } from "../engine/runs/plan";
import { posesFor } from "../shared/scenes/captures";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC4: the packaged smoke's part C scenario, without Electron. The REAL engine (a real library, the real photo downscale) talks HTTP to the smoke's mock OpenRouter on loopback, and the checks the smoke
// makes (clipMotionSmoke.ts) are made here on what the two did: one suggestion and one translation over the mock's chat route, the stored motions listed by the sheet, a clip made from the translated idea, the ledger
// where the mock's bill is, and the I5.67 canary: no fragment longer than 40 characters of the owner's idea is in any file, log line, event or video request. This is how the mock's chat route is held against the engine's
// writer and translator before CI runs the packaged app.

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-clip-motion-smoke-engine-");
/** More than 40 characters, so a fragment of it can be told from its label. */
const CANARY = "CANARY-9c41";
const IDEA = `медленно поворачивает голову к окну и улыбается, ${CANARY}`;

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

/**
 * The photo the packaged smoke makes, as the smoke makes it: a SCENE photo with a run plan on disk, taken in a mirror with her face hidden (`mirror-hidden`: the planned face is `no`, the face role `hidden`). Its facts come
 * from the plan, not from the sidecar's face marks, so a motion that moves her face (a smile, a gaze) is refused `face-hidden` on it; the planless photo of `seedClipAvatar` alone would let it through.
 */
async function seedHiddenFaceScenePhoto(libraryDir: string): Promise<{ avatarId: string; photoId: string }> {
  const seeded = await seedClipAvatar(libraryDir);
  const picked = pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined && m.angle === undefined);
  const run = sceneRun("run-00000099", [slotOf(picked, "mirror-hidden", posesFor("mirror-hidden")[0] ?? "front")]);
  const { library } = await openLibrary(libraryDir);
  await library.createRun("run-00000099", run, RunPlanSchema);
  return { avatarId: seeded.avatarId, photoId: seeded.photoId };
}

/** Every file under `root` as text (a binary file is read as text too: a fragment of the idea would show in it all the same). */
async function filesUnder(root: string): Promise<Haystack[]> {
  const found: Haystack[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.push({ where: `the file ${filePlace(root, path)}`, text: await readFile(path, "latin1").then((latin) => latin + "\n" + Buffer.from(latin, "latin1").toString("utf8")) });
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
      // The packaged smoke's photo is a SCENE photo with a plan, and on a mirror frame her face is hidden: so is this one (a face-hidden frame refuses any motion that moves her face).
      const { avatarId, photoId } = await seedHiddenFaceScenePhoto(join(dir(), "library"));
      const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock) } });

      // 1. The estimates are free; the suggestion is paid at the mock's bill and joins the sheet.
      const suggestEstimate = await answer(engine, "clips.estimateSuggest", { avatarId, photoId });
      const ideaEstimate = await answer(engine, "clips.estimateIdea", { avatarId, photoId });
      expect(mock.motionRequests()).toHaveLength(0);
      const suggested = await answer(engine, "clips.suggestMotions", { avatarId, photoId, acceptedWorstMicros: suggestEstimate.worstMicros });
      expect(suggested).toMatchObject({ outcome: "ok", costMicros: 3_400, motions: [{ id: "v-1" }, { id: "v-2" }, { id: "v-3" }], reading: { notes: [] } });

      // 2. The idea is translated and stored under his label.
      const translated = await answer(engine, "clips.translateIdea", { avatarId, photoId, text: IDEA, acceptedWorstMicros: ideaEstimate.worstMicros });
      expect(translated).toEqual({ outcome: "ok", item: { id: "o-1", source: "own", label: ownIdeaLabel(IDEA), text: DEFAULT_MOTION_TRANSLATION }, costMicros: 1_000 });
      expect(mock.motionRequests().map((r) => r.schemaName)).toEqual(["motion_suggestions", "motion_idea"]);

      // 3. The sheet lists the three suggestions and the idea after the code's, and a clip is made from the idea.
      const options = await answer(engine, "clips.options", { avatarId, photoId });
      const motions = (options.motions as { id: string }[]).map((m) => m.id);
      // The photo's own motions come first (a planned scene photo offers the scene's and the code's), then the three suggestions and the idea, exactly.
      expect(motions.slice(-4)).toEqual(["v-1", "v-2", "v-3", "o-1"]);
      expect(motions.length).toBeGreaterThan(4);
      expect(options.motions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "v-1", text: DEFAULT_MOTION_SUGGESTIONS[0] }), expect.objectContaining({ id: "v-3", text: DEFAULT_MOTION_SUGGESTIONS[2] })]));
      expect(options.reading).toEqual({ notes: [] });
      const clipId = jobIdOf(await create(engine, { avatarId, photoId, motionId: "o-1" }));
      expect((await jobEnd(engine, clipId)).type).toBe("job.done");
      const listed = (await answer(engine, "clips.list", { avatarId })) as { clips: { motion: { source: string; label: string; text: string } }[] };
      expect(listed.clips[0]?.motion).toEqual({ source: "own", label: ownIdeaLabel(IDEA), text: DEFAULT_MOTION_TRANSLATION });

      // 4. The ledger is where the mock's bill is, the calls were reserved and settled, and nothing is open.
      const lines = ledgerLines(dir()).flatMap((l) => (typeof l.attemptId === "string" ? [{ type: String(l.type), attemptId: l.attemptId }] : []));
      expect(motionLedgerProblems(lines, ["motion", "idea"])).toEqual([]);
      const money = await answer(engine, "money.status", {});
      expect(money).toMatchObject({ spentMicros: Math.round(mock.totalUsageUsd() * 1_000_000), unsettledMicros: 0, unsettledCount: 0 });
      expect(mock.totalUsageUsd()).toBeCloseTo(0.0034 + 0.001 + 0.42, 9);

      // 5. The canary (I5.67): the translator's request holds his words as JSON data, and nowhere else is a fragment of them.
      const translatorRequest = mock.motionRequests()[1];
      expect(translatorRequest?.bodyText).toContain(IDEA);
      expect(mock.requests.some((r) => r.path.endsWith("/videos") && r.method === "POST")).toBe(true);
      const provider = mock;
      const gather = async (): Promise<Haystack[]> => [
        ...(await filesUnder(dir())),
        { where: "an event the engine posted", text: JSON.stringify(engine.posted) },
        { where: "a log line", text: logs.join("\n") },
        // EVERY request the provider saw except the translator's own: the writer's, the video requests, the price reads, the credits.
        ...provider.requests.filter((r) => r.schemaName !== "motion_idea").map((r, i) => ({ where: `provider request ${i + 1} (${r.method} ${r.path})`, text: `${r.url}\n${r.bodyText}` })),
      ];
      const places = await gather();
      expect(places.length).toBeGreaterThan(10);
      expect(canaryProblems(IDEA, places, CANARY)).toEqual([]);
      expect(clipsDirOf(join(dir(), "library"), avatarId)).toContain(avatarId);
      expect(mock.unexpected).toEqual([]);

      // 6. The negative control: the same scan, after the idea is planted in a file and in a log line, finds both.
      await writeFile(join(dir(), "planted.txt"), `a note: ${IDEA}`);
      console.warn(`planted: ${IDEA}`);
      const found = canaryProblems(IDEA, await gather(), CANARY);
      expect(found.some((line) => line.startsWith("the file /planted.txt"))).toBe(true);
      expect(found.some((line) => line.startsWith("a log line"))).toBe(true);
    } finally {
      console.warn = warn;
      console.error = error;
    }
  });

  test("the canary bites: the same scan finds the idea in the one place it is allowed to be", async () => {
    mock = await startMockOpenRouter({ descriptorText: "A woman.", motions: true });
    const { avatarId, photoId } = await seedHiddenFaceScenePhoto(join(dir(), "library"));
    const engine = await startClipEngine(dir(), { deps: { fetch: towards(mock) } });
    const estimate = await answer(engine, "clips.estimateIdea", { avatarId, photoId });
    await answer(engine, "clips.translateIdea", { avatarId, photoId, text: IDEA, acceptedWorstMicros: estimate.worstMicros });
    const request = mock.motionRequests()[0];
    expect(canaryProblems(IDEA, [{ where: "the translator's request", text: request?.bodyText ?? "" }])).toHaveLength(1);
  });
});
