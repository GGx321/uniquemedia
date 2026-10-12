import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { endpointsAcceptPhotoRequest, imageWorstCase, parseImageEndpoints } from "../engine/money/prices";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
useNativeGlobals();

// 5a.3 (S5.9f, plan s5a3 §12): the packaged smoke's «Смелая» run needs the mock to serve what the engine asks of the Seedream route and to be told, by model, to refuse or to answer with no
// image. Unit-tested here, with no Electron: the 2K tier on the Seedream endpoint, the model and the resolution each image request names, and the two armed ends.

// The test preload swaps the global fetch for happy-dom's; Bun's own is the one that speaks plain HTTP to the loopback mock, and the mock answers with the native Response.
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

const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const GROK = "x-ai/grok-imagine-image-2.0";

let mock: MockOpenRouter | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function started(): Promise<MockOpenRouter> {
  mock = await startMockOpenRouter({ descriptorText: "A 25-year-old woman." });
  return mock;
}

const getJson = async (m: MockOpenRouter, path: string): Promise<unknown> => (await nativeFetch(`${m.url}${path}`)).json();
const postBody = (m: MockOpenRouter, body: unknown): Promise<Response> => nativeFetch(`${m.url}/images`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bold = (over: Record<string, unknown> = {}) => ({ model: SEEDREAM, prompt: "p", aspect_ratio: "9:16", resolution: "2K", input_references: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }], ...over });
const grok = (over: Record<string, unknown> = {}) => ({ model: GROK, prompt: "p", aspect_ratio: "9:16", resolution: "1K", ...over });
const imagesOf = async (response: Response): Promise<unknown[]> => ((await response.json()) as { data: unknown[] }).data;

describe("the Seedream endpoint", () => {
  test("serves the 2K tier: the engine's parser prices an attempt at 93 000 µ$ and accepts the 2K request", async () => {
    const m = await started();
    const body = await getJson(m, `/images/models/${SEEDREAM}/endpoints`);
    expect(endpointsAcceptPhotoRequest(body, "2K")).toBe(true);
    expect(imageWorstCase(parseImageEndpoints(body, SEEDREAM), { quality: null, refs: 1, resolution: "2K" })).toBe(93_000);
  });

  test("still prices the 1K attempt of the moderation fallback", async () => {
    const m = await started();
    const price = parseImageEndpoints(await getJson(m, `/images/models/${SEEDREAM}/endpoints`), SEEDREAM);
    expect(imageWorstCase(price, { quality: null, refs: 1, resolution: "1K" })).toBeGreaterThan(0);
    expect(imageWorstCase(price, { quality: null, refs: 1, resolution: "1K" })).toBeLessThan(imageWorstCase(price, { quality: null, refs: 1, resolution: "2K" }));
  });

  test("leaves the owner's model its own price", async () => {
    const m = await started();
    const price = parseImageEndpoints(await getJson(m, `/images/models/${GROK}/endpoints`), GROK);
    expect(imageWorstCase(price, { quality: "low", refs: 1, resolution: "1K" })).toBeGreaterThan(0);
  });
});

describe("the image requests the mock records", () => {
  test("keep the model and the resolution a request names", async () => {
    const m = await started();
    await postBody(m, bold());
    await postBody(m, grok());
    expect(m.imageRequests().map((r) => [r.model, r.resolution])).toEqual([
      [SEEDREAM, "2K"],
      [GROK, "1K"],
    ]);
  });

  test("keep null for a request that names neither", async () => {
    const m = await started();
    await postBody(m, {});
    expect(m.imageRequests().map((r) => [r.model, r.resolution])).toEqual([[null, null]]);
  });

  test("can be listed by the model they name", async () => {
    const m = await started();
    await postBody(m, bold());
    await postBody(m, grok());
    await postBody(m, bold());
    expect(m.imageRequestsFor(SEEDREAM)).toHaveLength(2);
    expect(m.imageRequestsFor(GROK)).toHaveLength(1);
  });
});

describe("armRefusal", () => {
  test("answers the model's moderation 400 to the next request for that model, once", async () => {
    const m = await started();
    m.armRefusal(SEEDREAM);
    const refused = await postBody(m, bold());
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("content moderation");
    expect((await postBody(m, bold())).status).toBe(200);
  });

  test("leaves a request for another model alone, and keeps the refusal for the next one of the armed model", async () => {
    const m = await started();
    m.armRefusal(SEEDREAM);
    expect((await postBody(m, grok())).status).toBe(200);
    expect((await postBody(m, bold())).status).toBe(400);
  });

  test("books nothing against /credits", async () => {
    const m = await started();
    m.armRefusal(SEEDREAM);
    await postBody(m, bold());
    expect(m.totalUsageUsd()).toBe(0);
  });

  test("refuses the next n requests when told n", async () => {
    const m = await started();
    m.armRefusal(SEEDREAM, 2);
    expect([(await postBody(m, bold())).status, (await postBody(m, bold())).status, (await postBody(m, bold())).status]).toEqual([400, 400, 200]);
  });
});

describe("armEmptyAnswer", () => {
  test("answers a 2xx with no image and a bill to the next request for that model, once", async () => {
    const m = await started();
    m.armEmptyAnswer(SEEDREAM);
    const empty = await postBody(m, bold());
    const body = (await empty.json()) as { data: unknown[]; usage: { cost: number } };
    expect(empty.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.usage.cost).toBeGreaterThan(0);
    expect(m.totalUsageUsd()).toBeCloseTo(body.usage.cost, 10);
    expect(await imagesOf(await postBody(m, bold()))).toHaveLength(1);
  });

  test("leaves a request for another model alone", async () => {
    const m = await started();
    m.armEmptyAnswer(SEEDREAM);
    expect(await imagesOf(await postBody(m, grok()))).toHaveLength(1);
    expect(await imagesOf(await postBody(m, bold()))).toEqual([]);
  });

  test("meets an armed refusal first", async () => {
    const m = await started();
    m.armEmptyAnswer(SEEDREAM);
    m.armRefusal(SEEDREAM);
    expect((await postBody(m, bold())).status).toBe(400);
    expect(await imagesOf(await postBody(m, bold()))).toEqual([]);
  });
});

describe("what an image is billed", () => {
  test("a 2K image is billed at the Seedream bill and a 1K one at the mock's image cost, and /credits adds up both", async () => {
    const m = await started();
    const costOf = async (response: Response): Promise<number> => ((await response.json()) as { usage: { cost: number } }).usage.cost;
    expect(await costOf(await postBody(m, bold()))).toBe(0.045);
    expect(await costOf(await postBody(m, grok()))).toBe(0.04);
    expect(m.totalUsageUsd()).toBeCloseTo(0.085, 10);
  });
});
