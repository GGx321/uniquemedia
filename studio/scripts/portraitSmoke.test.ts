import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestTraits } from "../engine/avatars/records";
import { NoFaceInReferenceError } from "../engine/face/noFaceError";
import { openLibrary } from "../engine/library";
import { SAMPLE_IMPORTED_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "../engine/library/testing/helpers";
import { OPENROUTER_API_BASE } from "../engine/money/prices";
import { command, engineSettings, failed, GOOD, jobEnd, ok, startEngine, TRAITS } from "../engine/testing/engineHarness";
import { fakeGate } from "../engine/testing/portraitKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { FACE_FIXTURE_PATH } from "./facePool";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
import { PORTRAIT_BATCH_SIZE, portraitBatchProblems, portraitSmokeProblems } from "./portraitSmoke";
useNativeGlobals();
useNativeHttp();

// The E2E smoke's reference portrait scenarios (smoke-engine.ts, `runPortraitScenario` and the import scenario's free refusal) need an Electron app and run in CI. What does not need one is
// held here: the check of what the batch sent, and the mock OpenRouter serving EVERY route a real engine's portrait batch asks for (a route the mock does not know fails in CI only: the
// wave-2 lesson), read by the real engine over a scripted face gate.

describe("portraitBatchProblems", () => {
  const request = (references: number, extra: Record<string, unknown> = {}) => ({
    body: { model: "x-ai/grok-imagine-image-2.0", prompt: "p", aspect_ratio: "9:16", ...(references === 0 ? {} : { input_references: Array.from({ length: references }, () => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } })) }), ...extra },
  });

  test("a batch of exactly five requests, each 9:16 with one reference, has no problem", () => {
    expect(portraitBatchProblems(Array.from({ length: PORTRAIT_BATCH_SIZE }, () => request(1)))).toEqual([]);
  });

  test("four requests and six requests are both a problem", () => {
    expect(portraitBatchProblems(Array.from({ length: 4 }, () => request(1)))).not.toEqual([]);
    expect(portraitBatchProblems(Array.from({ length: 6 }, () => request(1)))).not.toEqual([]);
  });

  test("a request with no reference, or with two, is named", () => {
    expect(portraitBatchProblems([request(0), ...Array.from({ length: 4 }, () => request(1))]).join(" ")).toContain("request 1");
    expect(portraitBatchProblems([...Array.from({ length: 4 }, () => request(1)), request(2)]).join(" ")).toContain("request 5");
  });

  test("a request that is not 9:16 is named", () => {
    expect(portraitBatchProblems([...Array.from({ length: 4 }, () => request(1)), request(1, { aspect_ratio: "3:4" })]).join(" ")).toContain("9:16");
  });

  test("a body that is not an object is a problem, not a crash", () => {
    expect(portraitBatchProblems([...Array.from({ length: 4 }, () => request(1)), { body: null }])).not.toEqual([]);
  });
});

describe("portraitSmokeProblems", () => {
  const FRESH = { imageRequests: 0, unsettledCount: 0, spentMicros: 0 };

  test("a free refusal sent no image request and reserved nothing", () => {
    expect(portraitSmokeProblems("MASTER_FACE_UNUSABLE", FRESH, FRESH)).toEqual([]);
  });

  test("a refusal with any other code is a problem", () => {
    expect(portraitSmokeProblems("FACE_GATE_UNAVAILABLE", FRESH, FRESH).join(" ")).toContain("MASTER_FACE_UNUSABLE");
  });

  test("an image request, an open reserve or any spend during the refusal is a problem", () => {
    expect(portraitSmokeProblems("MASTER_FACE_UNUSABLE", FRESH, { ...FRESH, imageRequests: 1 })).not.toEqual([]);
    expect(portraitSmokeProblems("MASTER_FACE_UNUSABLE", FRESH, { ...FRESH, unsettledCount: 1 })).not.toEqual([]);
    expect(portraitSmokeProblems("MASTER_FACE_UNUSABLE", FRESH, { ...FRESH, spentMicros: 1 })).not.toEqual([]);
  });
});

describe("the mock OpenRouter serves a real engine's portrait batch", () => {
  let tmp = "";
  let mock: MockOpenRouter | null = null;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "studio-portrait-smoke-"));
    await mkdir(join(tmp, "library"));
  });
  afterEach(async () => {
    await mock?.stop();
    mock = null;
    await rm(tmp, { recursive: true, force: true });
  });

  /** An imported avatar whose photo is the fixture face, the engine pointed at the mock server (its URL swapped in for OpenRouter's), the app's own defaults for the image model. */
  async function setup(opts: { embedFails?: boolean } = {}) {
    mock = await startMockOpenRouter({ descriptorText: GOOD, faceFixture: true });
    const { library } = await openLibrary(join(tmp, "library"), { now: steppingClock(), newId: sequentialIds("smk") });
    const { avatar } = await library.createImportedAvatar({
      name: "Nini",
      age: 25,
      traits: manifestTraits(TRAITS),
      descriptor: GOOD,
      photoBytes: new Uint8Array(readFileSync(FACE_FIXTURE_PATH)),
      photoMeta: samplePhotoMeta({ mediaType: "image/jpeg", width: 864, height: 1152, source: SAMPLE_IMPORTED_SOURCE }),
    });
    const base = mock.url;
    const gate = fakeGate({
      ...(opts.embedFails === true
        ? {
            embed: async () => {
              throw new NoFaceInReferenceError();
            },
          }
        : {}),
    });
    const net = await startEngine(tmp, {
      init: { settings: engineSettings(tmp, { imageAgeCheck: "off" }) },
      deps: { fetch: (url, init) => nativeFetch(String(url).replace(OPENROUTER_API_BASE, base), init), portraitFaceGate: gate.gate },
    });
    return { ...net, avatarId: avatar.id, mock, gate };
  }

  test("the price routes answer a price with a reference image, and the batch sends five requests with one reference each and ends done", async () => {
    const { engine, events, avatarId, mock: served } = await setup();

    const estimate = ok(await engine.handle(command("avatars.estimatePortraits", {})));
    if (estimate.type !== "avatars.estimatePortraits") throw new Error("wrong answer");
    expect(estimate.result.worstMicros).toBeGreaterThan(0);
    const started = ok(await engine.handle(command("avatars.generatePortraits", { avatarId, acceptedWorstMicros: estimate.result.worstMicros })));
    if (started.type !== "avatars.generatePortraits") throw new Error("wrong answer");
    const end = await jobEnd(events, started.result.jobId);

    expect(end.type).toBe("job.done");
    expect(portraitBatchProblems(served.imageRequests())).toEqual([]);
    expect(served.unexpected).toEqual([]);
    expect(end.type === "job.done" && end.payload.result.kind === "avatar.portraits" && end.payload.result.candidates).toHaveLength(PORTRAIT_BATCH_SIZE);
    const money = ok(await engine.handle(command("money.status", {})));
    expect(money.type === "money.status" && money.result.ledger === "open" && money.result.unsettledCount).toBe(0);
  });

  test("a source with no face is refused free: no image request reached the mock, nothing is reserved", async () => {
    const { engine, avatarId, mock: served } = await setup({ embedFails: true });
    const estimate = ok(await engine.handle(command("avatars.estimatePortraits", {})));
    if (estimate.type !== "avatars.estimatePortraits") throw new Error("wrong answer");

    const refused = failed(await engine.handle(command("avatars.generatePortraits", { avatarId, acceptedWorstMicros: estimate.result.worstMicros })));

    expect(refused.error.code).toBe("MASTER_FACE_UNUSABLE");
    expect(served.imageRequests()).toHaveLength(0);
    expect(served.unexpected).toEqual([]);
  });
});
