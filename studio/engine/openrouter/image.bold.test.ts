import { afterEach, beforeEach, expect, test } from "bun:test";
import { REQUEST_TIMEOUT_MS } from "../money/budget";
import type { BoldImageParams } from "./types";
import { asLibraryReference, b64, fakeFetch, imageBody, imageParams, JPEG, JPEG_2, makeClient, PNG, setupMoney, type Money } from "./testing/fakes";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §8.1): the «Смелая» route's request. Seedream 5 Pro at 2K, 9:16, ONE reference (the master), no quality knob; every other request keeps
// its 1K body byte for byte.

const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const SEEDREAM_2K_ONE_REF = 93_000;
const PROMPT = "A phone photo of a woman on a sandy beach";
const MODERATION = { error: { code: 400, message: "Seedream blocked this request through content moderation." } };

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

function boldParams(overrides: Partial<BoldImageParams> = {}): BoldImageParams {
  return { ...imageParams(money, { model: SEEDREAM, prompt: PROMPT, aspectRatio: "9:16", quality: null }), resolution: "2K", references: [asLibraryReference(JPEG)], ...overrides };
}

test("posts the bold body: 2K, 9:16, one reference, and no quality", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.045 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(boldParams());

  expect(calls[0]?.json()).toEqual({
    model: SEEDREAM,
    prompt: PROMPT,
    resolution: "2K",
    aspect_ratio: "9:16",
    input_references: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(JPEG)}` } }],
  });
});

test("a request that names no resolution is still sent at 1K", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.05 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money, { aspectRatio: "9:16" }));

  expect(calls[0]?.json().resolution).toBe("1K");
});

test("a Seedream request that names no resolution (the 1K moderation fallback) is still sent at 1K and reserves 48 000 µ$", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.045 }) }]);
  const { client } = makeClient(fetch);

  await client.generateImage(imageParams(money, { model: SEEDREAM, aspectRatio: "9:16", quality: null }));

  expect({ resolution: calls[0]?.json().resolution, reserved: money.lines()[0]?.worstMicros }).toEqual({ resolution: "1K", reserved: 48_000 });
});

test("reserves the 2K list price (93 000 µ$) before the request leaves", async () => {
  let reservedWhenSent: unknown;
  const { fetch } = fakeFetch([
    () => {
      reservedWhenSent = money.lines()[0]?.worstMicros;
      return { status: 200, body: imageBody(PNG, { cost: 0.045 }) };
    },
  ]);
  const { client } = makeClient(fetch);

  await client.generateImage(boldParams());

  expect(reservedWhenSent).toBe(SEEDREAM_2K_ONE_REF);
});

test("settles a bold frame at what it was billed, below the list reserve", async () => {
  const { fetch } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.045 }) }]);
  const { client } = makeClient(fetch);

  const result = await client.generateImage(boldParams());

  expect(result.status === "ok" && { cost: result.costMicros, aboveWorst: result.aboveWorst }).toEqual({ cost: 45_000, aboveWorst: false });
});

test("a moderation 400 on the bold route is a refusal settled at zero", async () => {
  const { fetch } = fakeFetch([{ status: 400, body: MODERATION }]);
  const { client } = makeClient(fetch);

  const result = await client.generateImage(boldParams());

  expect([result.status, money.lines().map((line) => [line.type, line.costMicros])]).toEqual(["refused", [["reserve", undefined], ["settle", 0]]]);
});

test("a 2xx without an image on the bold route settles at its bill and reports an unusable paid response", async () => {
  const { fetch } = fakeFetch([{ status: 200, body: { created: 1, data: [], usage: { cost: 0.045 } } }]);
  const { client } = makeClient(fetch);

  const result = await client.generateImage(boldParams());

  expect([result.status === "error" && result.kind, money.lines().at(-1)?.costMicros]).toEqual(["UNUSABLE_PAID_RESPONSE", 45_000]);
});

test("a 2xx without an image and without a bill settles at the 2K list price, estimated", async () => {
  const { fetch } = fakeFetch([{ status: 200, body: { created: 1, data: [] } }]);
  const { client } = makeClient(fetch);

  await client.generateImage(boldParams());

  expect(money.lines().at(-1)).toMatchObject({ type: "settle", costMicros: SEEDREAM_2K_ONE_REF, estimated: true });
});

test("the bold route never sends a second reference", () => {
  // The tuple type is the contract: a second reference does not compile (typecheck:studio is the check), and the runtime body carries exactly the one it was given.
  // @ts-expect-error a bold request carries exactly one reference
  const twoReferences: BoldImageParams = boldParams({ references: [asLibraryReference(JPEG), asLibraryReference(JPEG_2)] });

  expect(twoReferences.resolution).toBe("2K");
});

test("the per-try timeout stays 180 s: 72 s above the slowest 2K frame the probe measured (108 s)", () => {
  expect(REQUEST_TIMEOUT_MS).toBe(180_000);
  expect(REQUEST_TIMEOUT_MS - 108_000).toBeGreaterThanOrEqual(60_000);
});
