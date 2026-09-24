import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  b64,
  fakeFetch,
  imageBody,
  imageParams,
  JPEG,
  JPEG_2,
  LOCAL_BASE,
  makeClient,
  PNG,
  readLedgerLines,
  setupMoney,
  TEST_KEY,
  WORST_ONE_REF,
  type Money,
} from "./testing/fakes";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

test("writes the reserve to disk before the request leaves", async () => {
  let onDiskWhenSent: Record<string, unknown>[] = [];
  const { fetch } = fakeFetch([
    () => {
      onDiskWhenSent = readLedgerLines(money.ledgerPath);
      return { status: 200, body: imageBody(PNG, { cost: 0.05 }) };
    },
  ]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money));

  expect(onDiskWhenSent).toEqual([expect.objectContaining({ type: "reserve", attemptId: "slot-1#1", worstMicros: WORST_ONE_REF })]);
});

test("reserves the price book's worst case for the model, quality, resolution and references", async () => {
  const { fetch } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.07 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money, { quality: "medium", resolution: "2K", references: [JPEG, JPEG_2] }));

  const expected = money.priceBook.imageWorstCase({ model: "x-ai/grok-imagine-image-2.0", resolution: "2K", quality: "medium", refs: 2 });
  expect(money.lines()[0]).toMatchObject({ type: "reserve", worstMicros: expected, jobId: "job-1", scope: { avatarJobId: "avjob-1" } });
});

test("sends nothing when the run cap refuses the reserve, and passes the refusal through", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: WORST_ONE_REF - 1 });
  const { fetch, calls } = fakeFetch([]);
  const { client } = makeClient(fetch);

  const result = await client.generateImage(imageParams(money));

  expect(result).toEqual({
    status: "blocked",
    refusal: { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: WORST_ONE_REF - 1, committedMicros: 0, worstMicros: WORST_ONE_REF },
  });
  expect(calls).toHaveLength(0);
  expect(money.lines()).toEqual([]);
});

test("posts the Image API body with each reference as a JPEG data URL, in order", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.06 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money, { references: [JPEG, JPEG_2] }));

  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/images`);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.json()).toEqual({
    model: "x-ai/grok-imagine-image-2.0",
    prompt: "Head-and-shoulders portrait photo of a 25-year-old woman",
    resolution: "1K",
    aspect_ratio: "3:4",
    quality: "low",
    input_references: [
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(JPEG)}` } },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(JPEG_2)}` } },
    ],
  });
});

test("omits quality and input_references when there are none", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.045 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money, { model: "bytedance-seed/seedream-5-0-pro", quality: null, references: [] }));

  const body = calls[0]?.json() ?? {};
  expect(Object.keys(body).sort()).toEqual(["aspect_ratio", "model", "prompt", "resolution"]);
});

test("refuses redirects, so a paid POST cannot be replayed elsewhere", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.05 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money));

  expect(calls[0]?.redirect).toBe("error");
});

test("sends the key only as a bearer token in the Authorization header", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.05 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money));

  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  expect(calls[0]?.url).not.toContain(TEST_KEY);
  expect(calls[0]?.body).not.toContain(TEST_KEY);
});
