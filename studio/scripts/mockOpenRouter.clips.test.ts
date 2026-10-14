import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VIDEO_TIERS } from "../engine/money/prices";
import { isContentFailure } from "../engine/openrouter/video";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
useNativeGlobals();

// Stage 5, 5b.1, S5.V7: the fake video routes of the packaged smoke's mock OpenRouter. Unit-tested here with no Electron: what the engine's clip transport asks (the listing, the submit, the poll, the file,
// /generation, /credits) is answered as the provider answers it: one job per POST, a refused Kling job that never gets a /generation record (in the API's exact words), a completed one whose record
// appears a while after it completes, a bill booked once at completion.

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

const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";
const KLING = VIDEO_TIERS.std.model;
const KLING_PRO = VIDEO_TIERS.pro.model;
const GROK = VIDEO_TIERS.grok.model;

let mock: MockOpenRouter | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function started(clips: Parameters<typeof startMockOpenRouter>[0]["clips"] = { generationAfterMs: 60 }): Promise<MockOpenRouter> {
  mock = await startMockOpenRouter({ descriptorText: "A 25-year-old woman.", clips });
  return mock;
}

const get = (m: MockOpenRouter, path: string): Promise<Response> => nativeFetch(`${m.url}${path}`);
const post = (m: MockOpenRouter, body: unknown): Promise<Response> => nativeFetch(`${m.url}/videos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const request = (over: Record<string, unknown> = {}) => ({ model: KLING, prompt: "she blinks", duration: 5, resolution: "720p", aspect_ratio: "9:16", frame_images: [], ...over });

async function submit(m: MockOpenRouter, over: Record<string, unknown> = {}): Promise<string> {
  const response = await post(m, request(over));
  expect(response.status).toBe(202);
  const body = (await response.json()) as { id: string };
  return body.id;
}

describe("the price listing", () => {
  test("is the committed 2026-10-10 listing, byte for byte", async () => {
    const m = await started();
    const served = await (await get(m, "/videos/models")).text();
    const fixture = readFileSync(join(import.meta.dirname, "../engine/money/fixtures/videos-models-2026-10-10.json"), "utf8");
    expect(JSON.parse(served)).toEqual(JSON.parse(fixture));
  });
});

describe("a submit", () => {
  test("is one job per POST, with an id the engine accepts, and the request is recorded with its model, length and resolution", async () => {
    const m = await started();
    const a = await submit(m);
    const b = await submit(m, { model: GROK, duration: 10 });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(m.videoRequests().map((r) => [r.model, r.seconds, r.resolution, r.id])).toEqual([
      [KLING, 5, "720p", a],
      [GROK, 10, "720p", b],
    ]);
  });
});

describe("a poll", () => {
  test("of a job that completes: completed with the provider's bill, and the bill is booked once", async () => {
    const m = await started();
    const id = await submit(m);
    const first = (await (await get(m, `/videos/${id}`)).json()) as Record<string, unknown>;
    expect(first).toMatchObject({ id, generation_id: id, status: "completed", usage: { cost: 0.42, is_byok: false } });
    await get(m, `/videos/${id}`);
    expect(m.totalUsageUsd()).toBeCloseTo(0.42, 9);
  });

  test("bills each model its own figure: Kling pro 10 s, Grok with its input image", async () => {
    const m = await started();
    const pro = await submit(m, { model: KLING_PRO, duration: 10, resolution: "1080p" });
    const grok = await submit(m, { model: GROK });
    expect(((await (await get(m, `/videos/${pro}`)).json()) as { usage: { cost: number } }).usage.cost).toBeCloseTo(1.12, 9);
    expect(((await (await get(m, `/videos/${grok}`)).json()) as { usage: { cost: number } }).usage.cost).toBeCloseTo(0.71, 9);
  });

  test("of a job armed to be refused: failed with Kling's risk-control text, which the engine reads as a content refusal; nothing is billed", async () => {
    const m = await started();
    m.armVideoRefusal(KLING);
    const refused = await submit(m);
    const poll = (await (await get(m, `/videos/${refused}`)).json()) as { status: string; error: string };
    expect(poll).toMatchObject({ status: "failed", error: RISK_CONTROL });
    expect(isContentFailure(poll.error, null)).toBe(true);
    expect(m.totalUsageUsd()).toBe(0);
    // Armed once: the next job of that model completes; another model was never armed.
    const next = await submit(m);
    expect(((await (await get(m, `/videos/${next}`)).json()) as { status: string }).status).toBe("completed");
    m.armVideoRefusal(KLING);
    const grok = await submit(m, { model: GROK });
    expect(((await (await get(m, `/videos/${grok}`)).json()) as { status: string }).status).toBe("completed");
  });

  test("carries no usage when the scenario says so: the engine then reads the bill from /generation, which has it once the record appears", async () => {
    const m = await started({ usageOnPoll: false, generationAfterMs: 40 });
    const id = await submit(m);
    const poll = (await (await get(m, `/videos/${id}`)).json()) as Record<string, unknown>;
    expect(poll).toMatchObject({ status: "completed" });
    expect(poll).not.toHaveProperty("usage");
    expect(m.totalUsageUsd()).toBeCloseTo(0.42, 9);
    await Bun.sleep(80);
    expect(await (await get(m, `/generation?id=${id}`)).json()).toMatchObject({ data: { total_cost: 0.42 } });
  });

  test("of a job that is not finished yet is in progress, until `completeAfterMs` has passed", async () => {
    const m = await started({ completeAfterMs: 80, generationAfterMs: 60 });
    const id = await submit(m);
    expect(((await (await get(m, `/videos/${id}`)).json()) as { status: string }).status).toBe("in_progress");
    await Bun.sleep(120);
    expect(((await (await get(m, `/videos/${id}`)).json()) as { status: string }).status).toBe("completed");
  });

  test("an id the mock never issued is the provider's 404", async () => {
    const m = await started();
    expect((await get(m, "/videos/smoke-vid-404")).status).toBe(404);
  });
});

describe("the file", () => {
  test("is an MP4 of the length that was asked: 9:16, H.264, the faststart layout the providers' files have", async () => {
    const m = await started();
    const id = await submit(m);
    await get(m, `/videos/${id}`);
    const content = await get(m, `/videos/${id}/content?index=0`);
    expect(content.status).toBe(200);
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(Number(content.headers.get("content-length"))).toBe(bytes.length);
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe("ftyp");
    expect(bytes.length).toBeGreaterThan(1_000);
  });
});

describe("/generation", () => {
  test("a job that was refused never gets a record: the API's own 404, in its exact words, at every reading", async () => {
    const m = await started();
    m.armVideoRefusal(KLING);
    const id = await submit(m);
    await get(m, `/videos/${id}`);
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(30);
      const answer = await get(m, `/generation?id=${id}`);
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: { code: 404, message: `Generation ${id} not found` } });
    }
  });

  test("a job that completed has no record at first, and one after `generationAfterMs` (a video's record appears a while after it completes)", async () => {
    const m = await started({ generationAfterMs: 80 });
    const id = await submit(m);
    await get(m, `/videos/${id}`);
    const early = await get(m, `/generation?id=${id}`);
    expect(early.status).toBe(404);
    expect(await early.json()).toEqual({ error: { code: 404, message: `Generation ${id} not found` } });
    await Bun.sleep(120);
    const late = await get(m, `/generation?id=${id}`);
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ data: { id, total_cost: 0.42, finish_reason: "stop" } });
  });

  test("the default delay is the +15 s the probe measured", async () => {
    const m = await started(true);
    const id = await submit(m);
    await get(m, `/videos/${id}`);
    expect((await get(m, `/generation?id=${id}`)).status).toBe(404);
  });
});

describe("the account", () => {
  test("/credits is the running bill: a refused job adds nothing, a completed one adds its figure at completion", async () => {
    const m = await started();
    m.armVideoRefusal(KLING);
    const refused = await submit(m);
    await get(m, `/videos/${refused}`);
    const usage = async () => ((await (await get(m, "/credits")).json()) as { data: { total_usage: number } }).data.total_usage;
    expect(await usage()).toBe(0);
    const done = await submit(m);
    expect(await usage()).toBe(0);
    await get(m, `/videos/${done}`);
    expect(await usage()).toBeCloseTo(0.42, 9);
  });
});

describe("what the mock records and refuses", () => {
  test("every call of the video routes is logged with its job and its status, so a scenario can count the POSTs per attempt", async () => {
    const m = await started();
    const id = await submit(m);
    await get(m, `/videos/${id}`);
    await get(m, `/videos/${id}/content?index=0`);
    await get(m, `/generation?id=${id}`);
    expect(m.videoCalls().map((c) => [c.kind, c.jobId, c.status])).toEqual([
      ["submit", id, 202],
      ["poll", id, 200],
      ["content", id, 200],
      ["generation", id, 404],
    ]);
    expect(m.unexpected).toEqual([]);
  });

  test("without the option the video routes are unexpected requests, answered loudly", async () => {
    mock = await startMockOpenRouter({ descriptorText: "A woman." });
    const response = await post(mock, request());
    expect(response.status).toBe(404);
    expect(mock.unexpected).toHaveLength(1);
  });
});
