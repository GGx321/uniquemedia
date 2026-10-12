import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MoneyError } from "./errors";
import { PriceCache, type PriceModels } from "./priceCache";
import { BOLD_IMAGE_MODEL, imageWorstCase, loadPriceBook, parseImageEndpoints, PriceBook, type FetchLike, type ImagePrice } from "./prices";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §10.1): the 2K price tier of the «Смелая» route. 1K is every existing row and never moves; 2K is read from `<quality>_2k`, `2k` or
// `high_resolution`, never from the 1K base, and an absent tier is PRICE_UNAVAILABLE for the bold scope.

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const GROK_2 = "x-ai/grok-imagine-image-2.0";
const BASE = "http://127.0.0.1:9/api/v1";
const SEEDREAM_PRICE = parseImageEndpoints(fixture("endpoints-seedream-5-0-pro.json"), SEEDREAM);

function errorOf(fn: () => unknown): MoneyError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MoneyError) return error;
    throw error;
  }
  throw new Error("expected a MoneyError");
}

test("the bold model is the Seedream 5 Pro endpoint the fixture describes", () => {
  expect(BOLD_IMAGE_MODEL).toBe(SEEDREAM);
});

test("seedream at 2K with the master as its one reference costs 93 000 µ$ at list", () => {
  expect(imageWorstCase(SEEDREAM_PRICE, { quality: null, refs: 1, resolution: "2K" })).toBe(93_000);
});

test("seedream at 1K is still 48 000 µ$ when the resolution is named", () => {
  expect(imageWorstCase(SEEDREAM_PRICE, { quality: null, refs: 1, resolution: "1K" })).toBe(48_000);
});

test("seedream at the default resolution is still 1K", () => {
  expect(imageWorstCase(SEEDREAM_PRICE, { quality: null, refs: 1 })).toBe(48_000);
});

test("the dearest of the matching 2K tiers is the price: the reserve is never below the bill of any of them", () => {
  const price: ImagePrice = {
    outputs: [{ variant: "high_resolution", micros: 90_000 }, { variant: "2k", micros: 80_000 }, { variant: "low_2k", micros: 70_000 }, { variant: "low_1k", micros: 40_000 }],
    inputImageMicros: 0,
  };

  expect(imageWorstCase(price, { quality: "low", refs: 0, resolution: "2K" })).toBe(90_000);
});

test("a plain 2k and a high_resolution tier: the dearer one", () => {
  const price: ImagePrice = { outputs: [{ variant: "high_resolution", micros: 90_000 }, { variant: "2k", micros: 80_000 }, { variant: "1k", micros: 50_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { quality: null, refs: 0, resolution: "2K" })).toBe(90_000);
});

test("a quality tier and a plain 2k that are both cheaper than high_resolution: high_resolution is the price", () => {
  const price: ImagePrice = { outputs: [{ variant: "low_2k", micros: 60_000 }, { variant: "2k", micros: 70_000 }, { variant: "high_resolution", micros: 80_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { quality: "low", refs: 0, resolution: "2K" })).toBe(80_000);
});

test("2K tiers that differ only in case: the dearest", () => {
  const price: ImagePrice = { outputs: [{ variant: "2k", micros: 80_000 }, { variant: "2K", micros: 95_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { quality: null, refs: 0, resolution: "2K" })).toBe(95_000);
});

test("a quality tier of another quality is not a 2K price for this one's request, but a plain 2k still is", () => {
  const price: ImagePrice = { outputs: [{ variant: "medium_2k", micros: 120_000 }, { variant: "2k", micros: 80_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { quality: "low", refs: 0, resolution: "2K" })).toBe(80_000);
});

test("the 2K price is never the 1K base: a price list with no 2K tier is PRICE_UNAVAILABLE", () => {
  const price: ImagePrice = { outputs: [{ variant: null, micros: 45_000 }], inputImageMicros: 3_000 };

  const error = errorOf(() => imageWorstCase(price, { quality: null, refs: 1, resolution: "2K" }));

  expect(error.code).toBe("PRICE_UNAVAILABLE");
});

test("a missing 2K tier is a bold-scope price failure", () => {
  const price: ImagePrice = { outputs: [{ variant: "low_1k", micros: 40_000 }], inputImageMicros: 0 };

  const error = errorOf(() => imageWorstCase(price, { quality: "low", refs: 0, resolution: "2K" }));

  expect(error.scope).toBe("bold");
});

test("a missing 1K price carries no scope", () => {
  const error = errorOf(() => new PriceBook(new Map(), new Map()).imageWorstCase({ model: SEEDREAM, quality: null, refs: 1 }));

  expect(error.scope).toBeUndefined();
});

test("the dated fallback table prices Seedream at 2K: 90 000 + 3 000 µ$", () => {
  expect(PriceBook.fallback().imageWorstCase({ model: SEEDREAM, quality: null, refs: 1, resolution: "2K" })).toBe(93_000);
});

test("the dated fallback table still prices Seedream at 1K: 45 000 + 3 000 µ$", () => {
  expect(PriceBook.fallback().imageWorstCase({ model: SEEDREAM, quality: null, refs: 1 })).toBe(48_000);
});

// ---------- the load: the 2K request shape ----------

function fakeFetch(routes: Record<string, unknown>): FetchLike {
  return async (url) => {
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
}
const LIVE: Record<string, unknown> = {
  [`${BASE}/images/models/${GROK_2}/endpoints`]: fixture("endpoints-grok-imagine-image-2.0.json"),
  [`${BASE}/images/models/${SEEDREAM}/endpoints`]: fixture("endpoints-seedream-5-0-pro.json"),
};
function seedreamWith(edit: (p: Record<string, unknown>) => Record<string, unknown>): unknown {
  const body = fixture("endpoints-seedream-5-0-pro.json") as { endpoints: { supported_parameters: Record<string, unknown> }[] };
  return { ...body, endpoints: body.endpoints.map((e) => ({ ...e, supported_parameters: edit(e.supported_parameters) })) };
}
function load(overrides: Record<string, unknown>, boldShape: boolean) {
  return loadPriceBook({
    fetch: fakeFetch({ ...LIVE, ...overrides }),
    baseUrl: BASE,
    imageModels: [GROK_2, SEEDREAM],
    chatModels: [],
    checkRequestShape: true,
    ...(boldShape ? { boldShape: true } : {}),
  });
}
const SEEDREAM_URL = `${BASE}/images/models/${SEEDREAM}/endpoints`;

test("a bold load refuses a Seedream endpoint that lists no 2K: PRICE_UNAVAILABLE for the bold scope", async () => {
  const body = seedreamWith((p) => ({ ...p, resolution: { type: "enum", values: ["1K"] } }));

  const error = await load({ [SEEDREAM_URL]: body }, true).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(MoneyError);
  expect({ code: (error as MoneyError).code, scope: (error as MoneyError).scope }).toEqual({ code: "PRICE_UNAVAILABLE", scope: "bold" });
});

test("a Seedream endpoint that lost the reference image or 9:16 breaks the 1K fallback too: PRICE_UNAVAILABLE without the bold scope", async () => {
  const noReference = seedreamWith((p) => ({ ...p, input_references: { type: "range", min: 0, max: 0 } }));
  const no916 = seedreamWith((p) => ({ ...p, aspect_ratio: { type: "enum", values: ["1:1", "3:4"] } }));

  for (const body of [noReference, no916]) {
    const error = await load({ [SEEDREAM_URL]: body }, true).catch((e: unknown) => e);
    expect([(error as MoneyError).code, (error as MoneyError).scope]).toEqual(["PRICE_UNAVAILABLE", undefined]);
  }
});

test("a bold load prices the Seedream endpoint that lists 2K", async () => {
  const book = await load({}, true);

  expect(book.imageWorstCase({ model: SEEDREAM, quality: null, refs: 1, resolution: "2K" })).toBe(93_000);
});

test("a load that is not bold does not look for 2K: the same body is priced for 1K", async () => {
  const body = seedreamWith((p) => ({ ...p, resolution: { type: "enum", values: ["1K"] } }));

  const book = await load({ [SEEDREAM_URL]: body }, false);

  expect(book.imageWorstCase({ model: SEEDREAM, quality: null, refs: 1 })).toBe(48_000);
});

test("a bold load does not hold the settings' model to 2K", async () => {
  const grokBody = fixture("endpoints-grok-imagine-image-2.0.json") as { endpoints: { supported_parameters: Record<string, unknown> }[] };
  const only1k = { ...grokBody, endpoints: grokBody.endpoints.map((e) => ({ ...e, supported_parameters: { ...e.supported_parameters, resolution: { type: "enum", values: ["1K"] } } })) };

  const book = await load({ [`${BASE}/images/models/${GROK_2}/endpoints`]: only1k }, true);

  expect(book.imageWorstCase({ model: GROK_2, quality: "low", refs: 1 })).toBe(50_000);
});

test("a bold load serves the dated table's 2K row when the live fetch fails", async () => {
  const book = await loadPriceBook({ fetch: fakeFetch({}), baseUrl: BASE, imageModels: [SEEDREAM], chatModels: [], checkRequestShape: true, boldShape: true });

  expect(book.imageWorstCase({ model: SEEDREAM, quality: null, refs: 1, resolution: "2K" })).toBe(93_000);
});

// ---------- the cache key ----------

function bookOf(micros: number): PriceBook {
  return new PriceBook(new Map([[SEEDREAM, { price: { outputs: [{ variant: null, micros }], inputImageMicros: 0 }, source: "live" as const }]]), new Map());
}

test("the price cache keeps a bold load apart from a plain one for the same models", async () => {
  const loads: PriceModels[] = [];
  const cache = new PriceCache({
    load: async (models) => {
      loads.push(models);
      return bookOf(loads.length);
    },
    clock: () => 0,
    monotonic: () => 0,
  });
  const models: PriceModels = { imageModels: [SEEDREAM], chatModels: [], checkRequestShape: true };

  await cache.get(models);
  await cache.get({ ...models, boldShape: true });

  expect(loads.map((m) => m.boldShape === true)).toEqual([false, true]);
});

test("the price cache answers a repeated bold request from its first load", async () => {
  let loads = 0;
  const cache = new PriceCache({
    load: async () => {
      loads += 1;
      return bookOf(1);
    },
    clock: () => 0,
    monotonic: () => 0,
  });
  const models: PriceModels = { imageModels: [SEEDREAM], chatModels: [], checkRequestShape: true, boldShape: true };

  await cache.get(models);
  await cache.get(models);

  expect(loads).toBe(1);
});

test("peek finds a bold load only by its bold models", async () => {
  const cache = new PriceCache({ load: async () => bookOf(1), clock: () => 0, monotonic: () => 0 });
  const models: PriceModels = { imageModels: [SEEDREAM], chatModels: [], checkRequestShape: true };
  await cache.get({ ...models, boldShape: true });

  expect([cache.peek(models), cache.peek({ ...models, boldShape: true })].map((p) => p !== null)).toEqual([false, true]);
});
