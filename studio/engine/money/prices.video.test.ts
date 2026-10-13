import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MoneyError } from "./errors";
import { PriceCache, type PriceModels } from "./priceCache";
import {
  FALLBACK_PRICES_DATE,
  FALLBACK_VIDEO,
  FALLBACK_VIDEO_DATE,
  loadPriceBook,
  parseVideoModels,
  PriceBook,
  VIDEO_TIERS,
  type FetchLike,
  type VideoPrice,
  type VideoTier,
} from "./prices";
useNativeGlobals();

// S5.V2 (plan s5b1 §5.9, §8): the video price book. The listing is the real `/videos/models` body of 2026-10-10 (public, no key; every entry unchanged).
// The dated table stands in ONLY when the listing cannot be read; a listing that reads and lacks a needed tier is PRICE_UNAVAILABLE for the video scope (the 2K rule of 5a.3).

const LISTING = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/videos-models-2026-10-10.json", import.meta.url)), "utf8")) as { data: { id: string; pricing_skus: Record<string, unknown> }[] };
const BASE = "http://127.0.0.1:9/api/v1";
const LISTING_URL = `${BASE}/videos/models`;
const STD = VIDEO_TIERS.std.model;
const PRO = VIDEO_TIERS.pro.model;
const GROK = VIDEO_TIERS.grok.model;
const ALL_VIDEO = [STD, PRO, GROK];
const TIERS: VideoTier[] = ["std", "pro", "grok"];

/** The committed listing with `edit` applied to a copy of one model's SKUs (`undefined` deletes the model). */
function listingWith(model: string, edit: ((skus: Record<string, unknown>) => void) | undefined): unknown {
  const copy = structuredClone(LISTING);
  const data = copy.data.flatMap((entry) => {
    if (entry.id !== model) return [entry];
    if (edit === undefined) return [];
    edit(entry.pricing_skus);
    return [entry];
  });
  return { data };
}

/** A listing of exactly these models. */
function listingOf(models: Record<string, Record<string, unknown>>): unknown {
  return { data: Object.entries(models).map(([id, pricing_skus]) => ({ id, pricing_skus })) };
}

/** Serves `routes` by URL; an Error rejects, a number answers with that HTTP status. */
function fakeFetch(routes: Record<string, unknown>): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
    if (typeof route === "number") return { ok: false, status: route, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
  return Object.assign(fetch, { urls });
}

function loadVideo(routes: Record<string, unknown>, models: readonly string[] = ALL_VIDEO): Promise<PriceBook> {
  return loadPriceBook({ fetch: fakeFetch(routes), baseUrl: BASE, imageModels: [], chatModels: [], videoModels: models });
}

function moneyErrorOf(fn: () => unknown): MoneyError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MoneyError) return error;
    throw new Error(`expected a MoneyError, got ${String(error)}`);
  }
  throw new Error("expected a MoneyError, nothing was thrown");
}

async function moneyErrorOfAsync(promise: Promise<unknown>): Promise<MoneyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MoneyError) return error;
    throw new Error(`expected a MoneyError, got ${String(error)}`);
  }
  throw new Error("expected a MoneyError, nothing was thrown");
}

// ---------- MoneyError.scope ----------

test("a PRICE_UNAVAILABLE can carry the scope video", () => {
  const error = new MoneyError("PRICE_UNAVAILABLE", "no video tier", { scope: "video" });

  expect(error.scope).toBe("video");
});

test("a PRICE_UNAVAILABLE can still carry the scope bold", () => {
  expect(new MoneyError("PRICE_UNAVAILABLE", "no 2K tier", { scope: "bold" }).scope).toBe("bold");
});

// ---------- the parser on the committed listing ----------

test("the video tiers are Kling std at 720p, Kling pro at 1080p and Grok at 720p", () => {
  expect(VIDEO_TIERS).toEqual({
    std: { model: "kwaivgi/kling-v3.0-std", resolution: "720p" },
    pro: { model: "kwaivgi/kling-v3.0-pro", resolution: "1080p" },
    grok: { model: "x-ai/grok-imagine-video-1.5", resolution: "720p" },
  });
});

test("Kling std at 720p is 84 000 µ$ a second and no input-image price", () => {
  expect(parseVideoModels(LISTING, STD, "720p")).toEqual({ model: STD, resolution: "720p", perSecondMicros: 84_000, perInputImageMicros: 0, source: "live" });
});

test("Kling pro at 1080p is 112 000 µ$ a second", () => {
  expect(parseVideoModels(LISTING, PRO, "1080p")).toEqual({ model: PRO, resolution: "1080p", perSecondMicros: 112_000, perInputImageMicros: 0, source: "live" });
});

test("Grok at 720p is 140 000 µ$ a second plus 10 000 µ$ for the input image, both read from cents", () => {
  expect(parseVideoModels(LISTING, GROK, "720p")).toEqual({ model: GROK, resolution: "720p", perSecondMicros: 140_000, perInputImageMicros: 10_000, source: "live" });
});

test("every figure the parser returns is a whole, safe number of micro-dollars", () => {
  for (const tier of TIERS) {
    const price = parseVideoModels(LISTING, VIDEO_TIERS[tier].model, VIDEO_TIERS[tier].resolution);

    expect(Number.isSafeInteger(price.perSecondMicros)).toBe(true);
    expect(Number.isSafeInteger(price.perInputImageMicros)).toBe(true);
  }
});

// ---------- the SKU order and the rounding ----------

test("the image-to-video SKU of the resolution wins over the text-to-video, the plain and the cents SKUs", () => {
  const body = listingOf({
    m: { image_to_video_duration_seconds_720p: "0.2", text_to_video_duration_seconds_720p: "0.1", duration_seconds: "0.05", cents_per_video_output_second_720p: "3" },
  });

  expect(parseVideoModels(body, "m", "720p").perSecondMicros).toBe(200_000);
});

test("without an image-to-video SKU the cents SKU of the resolution is read as cents", () => {
  const body = listingOf({ m: { cents_per_video_output_second_720p: "7", cents_per_video_output_second_1080p: "25" } });

  expect(parseVideoModels(body, "m", "1080p").perSecondMicros).toBe(250_000);
});

test("a model priced flat, with no resolution in any SKU, is read from duration_seconds", () => {
  expect(parseVideoModels(listingOf({ m: { duration_seconds: "0.1120" } }), "m", "720p").perSecondMicros).toBe(112_000);
});

test("a price with digits below a micro-dollar rounds up, never down", () => {
  expect(parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0.0840001" } }), "m", "720p").perSecondMicros).toBe(84_001);
});

test("an exact price stays exact despite float noise", () => {
  expect(parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0.045", cents_per_image_input: "0.2" } }), "m", "720p")).toMatchObject({
    perSecondMicros: 45_000,
    perInputImageMicros: 2_000,
  });
});

test("a positive price below one micro-dollar is one micro-dollar, not free", () => {
  expect(parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0.0000001", cents_per_image_input: "0.00001" } }), "m", "720p")).toMatchObject({
    perSecondMicros: 1,
    perInputImageMicros: 1,
  });
});

test("an explicit input-image price of zero is a price the provider states, and stays zero", () => {
  expect(parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0.1", cents_per_image_input: "0" } }), "m", "720p").perInputImageMicros).toBe(0);
});

test("a price given as a JSON number is read like the same price as a string", () => {
  expect(parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: 0.084 } }), "m", "720p").perSecondMicros).toBe(84_000);
});

// ---------- a listing that reads and says no: PRICE_UNAVAILABLE, scope video ----------

test("a listing without the model is PRICE_UNAVAILABLE for the video scope", () => {
  const error = moneyErrorOf(() => parseVideoModels(listingWith(GROK, undefined), GROK, "720p"));

  expect([error.code, error.scope]).toEqual(["PRICE_UNAVAILABLE", "video"]);
});

test("a listing without Kling pro's 1080p SKU is PRICE_UNAVAILABLE even though the model also lists a plain duration_seconds", () => {
  const body = listingWith(PRO, (skus) => {
    delete skus.image_to_video_duration_seconds_1080p;
  });

  const error = moneyErrorOf(() => parseVideoModels(body, PRO, "1080p"));

  expect([error.code, error.scope]).toEqual(["PRICE_UNAVAILABLE", "video"]);
});

test("a model that lists other resolutions but not this one is PRICE_UNAVAILABLE, never another resolution's price", () => {
  const body = listingOf({ m: { image_to_video_duration_seconds_720p: "0.084" } });

  expect(moneyErrorOf(() => parseVideoModels(body, "m", "1080p")).scope).toBe("video");
});

test("a non-numeric price is PRICE_UNAVAILABLE for the video scope", () => {
  const error = moneyErrorOf(() => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "free" } }), "m", "720p"));

  expect([error.code, error.scope]).toEqual(["PRICE_UNAVAILABLE", "video"]);
});

test("a negative price is PRICE_UNAVAILABLE for the video scope", () => {
  expect(moneyErrorOf(() => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: -0.084 } }), "m", "720p")).scope).toBe("video");
});

test("a per-second price of zero is PRICE_UNAVAILABLE: it would reserve nothing", () => {
  expect(moneyErrorOf(() => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0" } }), "m", "720p")).scope).toBe("video");
});

test("a bad value in the present image-to-video SKU is not papered over by a good plain SKU", () => {
  const body = listingOf({ m: { image_to_video_duration_seconds_720p: "n/a", duration_seconds: "0.084" } });

  expect(moneyErrorOf(() => parseVideoModels(body, "m", "720p")).scope).toBe("video");
});

test("a bad input-image price is PRICE_UNAVAILABLE for the video scope", () => {
  const body = listingOf({ m: { image_to_video_duration_seconds_720p: "0.1", cents_per_image_input: "lots" } });

  expect(moneyErrorOf(() => parseVideoModels(body, "m", "720p")).scope).toBe("video");
});

test("a price too large to be a safe whole number of micro-dollars is PRICE_UNAVAILABLE for the video scope", () => {
  expect(moneyErrorOf(() => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "99999999999999" } }), "m", "720p")).scope).toBe("video");
});

// ---------- the dated table ----------

test("the dated table has its own date, 2026-10-10", () => {
  expect(FALLBACK_VIDEO_DATE).toBe("2026-10-10");
  expect(FALLBACK_VIDEO_DATE).not.toBe(FALLBACK_PRICES_DATE);
});

test("the dated table holds all three video models, flagged fallback", () => {
  expect([...FALLBACK_VIDEO.keys()].sort()).toEqual([...ALL_VIDEO].sort());
  for (const price of FALLBACK_VIDEO.values()) expect(price.source).toBe("fallback");
});

test("the dated table says what the committed listing says, tier by tier", () => {
  for (const tier of TIERS) {
    const { model, resolution } = VIDEO_TIERS[tier];
    const live = parseVideoModels(LISTING, model, resolution);
    const dated = FALLBACK_VIDEO.get(model);

    expect(dated).toEqual({ ...live, source: "fallback" } satisfies VideoPrice);
  }
});

// ---------- loadPriceBook ----------

test("a readable listing gives live prices for the three tiers from one GET", async () => {
  const fetch = fakeFetch({ [LISTING_URL]: LISTING });

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [], chatModels: [], videoModels: ALL_VIDEO });

  expect(fetch.urls).toEqual([LISTING_URL]);
  expect(TIERS.map((tier) => book.videoPrice(tier).perSecondMicros)).toEqual([84_000, 112_000, 140_000]);
  expect(book.videoSource).toBe("live");
  expect(book.videoFallbackDate).toBeNull();
  expect(book.source).toBe("live");
});

test("a fetch that rejects gives the dated table, flagged fallback, with its own date", async () => {
  const book = await loadVideo({ [LISTING_URL]: new Error("socket closed") });

  expect(TIERS.map((tier) => book.videoPrice(tier).perSecondMicros)).toEqual([84_000, 112_000, 140_000]);
  expect(book.videoPrice("std").source).toBe("fallback");
  expect(book.videoSource).toBe("fallback");
  expect(book.videoFallbackDate).toBe(FALLBACK_VIDEO_DATE);
  expect(book.fallbackDate).toBe(FALLBACK_VIDEO_DATE);
  expect(book.source).toBe("fallback");
});

test("a non-2xx answer gives the dated table", async () => {
  const book = await loadVideo({ [LISTING_URL]: 503 });

  expect(book.videoSource).toBe("fallback");
  expect(book.videoPrice("pro").perSecondMicros).toBe(112_000);
});

test("a missing route (404) gives the dated table", async () => {
  const book = await loadVideo({});

  expect(book.videoSource).toBe("fallback");
});

test.each([
  ["an empty object", {}],
  ["null", null],
  ["a data that is not a list", { data: "nope" }],
  ["an empty list", { data: [] }],
  ["entries without a pricing_skus", { data: [{ id: "a" }, { id: "b" }] }],
  ["entries without an id", { data: [{ pricing_skus: { duration_seconds: "0.1" } }] }],
])("a body that is %s is unreadable, so the dated table stands in", async (_name, body) => {
  const book = await loadVideo({ [LISTING_URL]: body });

  expect(book.videoSource).toBe("fallback");
  expect(book.videoPrice("grok").perInputImageMicros).toBe(10_000);
});

test("a body that is not JSON gives the dated table", async () => {
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [], chatModels: [], videoModels: ALL_VIDEO });

  expect(book.videoSource).toBe("fallback");
});

test("one malformed entry among readable ones does not make the listing unreadable", async () => {
  const body = { data: [null, { id: 3 }, ...LISTING.data] };

  const book = await loadVideo({ [LISTING_URL]: body });

  expect(book.videoSource).toBe("live");
  expect(book.videoPrice("std").perSecondMicros).toBe(84_000);
});

test("a listing that reads but lacks Kling pro's 1080p SKU rejects PRICE_UNAVAILABLE for the video scope, never the table", async () => {
  const body = listingWith(PRO, (skus) => {
    delete skus.image_to_video_duration_seconds_1080p;
  });

  const error = await moneyErrorOfAsync(loadVideo({ [LISTING_URL]: body }));

  expect([error.code, error.scope]).toEqual(["PRICE_UNAVAILABLE", "video"]);
});

test("a listing that reads but lacks Grok rejects PRICE_UNAVAILABLE for the video scope, never the table", async () => {
  const error = await moneyErrorOfAsync(loadVideo({ [LISTING_URL]: listingWith(GROK, undefined) }));

  expect([error.code, error.scope]).toEqual(["PRICE_UNAVAILABLE", "video"]);
});

test("a listing that holds a bad value for a needed tier rejects PRICE_UNAVAILABLE for the video scope", async () => {
  const body = listingWith(STD, (skus) => {
    skus.image_to_video_duration_seconds_720p = "-1";
  });

  expect((await moneyErrorOfAsync(loadVideo({ [LISTING_URL]: body }))).scope).toBe("video");
});

test("a bad value in a model nobody asked for does not stop the load", async () => {
  const body = listingWith("alibaba/wan-2.7", (skus) => {
    skus.duration_seconds = "garbage";
  });

  const book = await loadVideo({ [LISTING_URL]: body });

  expect(book.videoSource).toBe("live");
});

test("a video model the code has no tier for is PRICE_UNAVAILABLE for the video scope", async () => {
  const error = await moneyErrorOfAsync(loadVideo({ [LISTING_URL]: LISTING }, [STD, "alibaba/wan-2.7"]));

  expect(error.scope).toBe("video");
});

test("a book loaded for only some video models rejects a tier it was not asked for", async () => {
  const book = await loadVideo({ [LISTING_URL]: LISTING }, [STD]);

  expect(book.videoPrice("std").perSecondMicros).toBe(84_000);
  expect(moneyErrorOf(() => book.videoPrice("pro")).scope).toBe("video");
});

test("a book loaded without videoModels never GETs the listing and has no video prices", async () => {
  const fetch = fakeFetch({});

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [], chatModels: [] });

  expect(fetch.urls).toEqual([]);
  expect(moneyErrorOf(() => book.videoPrice("std")).scope).toBe("video");
});

test("a book built by hand with no video map has no video prices", () => {
  expect(moneyErrorOf(() => new PriceBook(new Map(), new Map()).videoPrice("grok")).code).toBe("PRICE_UNAVAILABLE");
});

test("an image-only fallback book still reports the image table's date and no video date", async () => {
  const book = await loadPriceBook({ fetch: fakeFetch({}), baseUrl: BASE, imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [] });

  expect(book.fallbackDate).toBe(FALLBACK_PRICES_DATE);
  expect(book.videoFallbackDate).toBeNull();
});

test("a book with image fallback and live video reports the image date and a live video source", async () => {
  const book = await loadPriceBook({ fetch: fakeFetch({ [LISTING_URL]: LISTING }), baseUrl: BASE, imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [], videoModels: ALL_VIDEO });

  expect(book.fallbackDate).toBe(FALLBACK_PRICES_DATE);
  expect(book.videoSource).toBe("live");
  expect(book.videoFallbackDate).toBeNull();
});

test("a book with fallback images and fallback video reports the older date", async () => {
  const book = await loadPriceBook({ fetch: fakeFetch({}), baseUrl: BASE, imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [], videoModels: ALL_VIDEO });

  expect(book.fallbackDate).toBe(FALLBACK_PRICES_DATE);
  expect(book.videoFallbackDate).toBe(FALLBACK_VIDEO_DATE);
});

// ---------- the cache key ----------

const NOW = Date.parse("2026-10-13T10:00:00.000Z");
const IMAGE_MODELS: PriceModels = { imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: ["x-ai/grok-4.3"] };

/** A cache whose loads are counted; every load answers with an empty book (the key is under test, not the prices). */
function countingCache(book: PriceBook = new PriceBook(new Map(), new Map())) {
  const loads: PriceModels[] = [];
  const cache = new PriceCache({
    load: async (models) => {
      loads.push(models);
      return book;
    },
    clock: () => NOW,
    monotonic: () => 0,
  });
  return { cache, loads };
}

test("the same models with and without videoModels are two cache entries", async () => {
  const { cache, loads } = countingCache();

  await cache.get(IMAGE_MODELS);
  await cache.get({ ...IMAGE_MODELS, videoModels: ALL_VIDEO });

  expect(loads).toHaveLength(2);
});

test("videoModels in another order, or repeated, is the same cache entry", async () => {
  const { cache, loads } = countingCache();

  await cache.get({ ...IMAGE_MODELS, videoModels: [GROK, STD, PRO] });
  await cache.get({ ...IMAGE_MODELS, videoModels: [STD, PRO, GROK, STD] });

  expect(loads).toHaveLength(1);
});

test("different videoModels are different cache entries", async () => {
  const { cache, loads } = countingCache();

  await cache.get({ imageModels: [], chatModels: [], videoModels: [STD] });
  await cache.get({ imageModels: [], chatModels: [], videoModels: [STD, PRO] });

  expect(loads).toHaveLength(2);
});

test("the loader is handed the sorted, de-duplicated videoModels", async () => {
  const { cache, loads } = countingCache();

  await cache.get({ imageModels: [], chatModels: [], videoModels: [STD, GROK, STD, PRO] });

  expect(loads[0]?.videoModels).toEqual([PRO, STD, GROK].sort());
});

test("an empty videoModels is the same cache entry as none", async () => {
  const { cache, loads } = countingCache();

  await cache.get(IMAGE_MODELS);
  await cache.get({ ...IMAGE_MODELS, videoModels: [] });

  expect(loads).toHaveLength(1);
});

test("a caller without videoModels keeps its cache key byte for byte (no videoModels property at all)", async () => {
  const { cache, loads } = countingCache();

  await cache.get(IMAGE_MODELS);

  expect(JSON.stringify(loads[0])).toBe('{"imageModels":["x-ai/grok-imagine-image-2.0"],"chatModels":["x-ai/grok-4.3"]}');
});

test("a caller with boldShape and without videoModels keeps its cache key byte for byte", async () => {
  const { cache, loads } = countingCache();

  await cache.get({ ...IMAGE_MODELS, checkRequestShape: true, boldShape: true });

  expect(JSON.stringify(loads[0])).toBe('{"imageModels":["x-ai/grok-imagine-image-2.0"],"chatModels":["x-ai/grok-4.3"],"checkRequestShape":true,"boldShape":true}');
});

test("peek answers for the video models it names and for no others", async () => {
  const { cache } = countingCache();
  await cache.get({ imageModels: [], chatModels: [], videoModels: ALL_VIDEO });

  expect(cache.peek({ imageModels: [], chatModels: [], videoModels: ALL_VIDEO })).not.toBeNull();
  expect(cache.peek({ imageModels: [], chatModels: [] })).toBeNull();
});

test("a video book that fell back is dated by the video table's own date in the cache", async () => {
  const book = await loadVideo({ [LISTING_URL]: new Error("offline") });
  const { cache } = countingCache(book);

  const priced = await cache.get({ imageModels: [], chatModels: [], videoModels: ALL_VIDEO });

  expect(priced.asOf).toBe(FALLBACK_VIDEO_DATE);
});

test("a video book with live prices is dated by the day of the load", async () => {
  const book = await loadVideo({ [LISTING_URL]: LISTING });
  const { cache } = countingCache(book);

  const priced = await cache.get({ imageModels: [], chatModels: [], videoModels: ALL_VIDEO });

  expect(priced.asOf).toBe("2026-10-13");
});

// ---------- round 2: exact decimals, duplicate ids, resolution SKUs with a suffix, the video part's own date ----------

const perSecondOf = (value: unknown): number => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: value } }), "m", "720p").perSecondMicros;

test("a decimal with a digit far below a micro-dollar rounds up, not to nearest", () => {
  expect(perSecondOf("0.0840000000004")).toBe(84_001);
});

test("a long decimal rounds up at the sixth place", () => {
  expect(perSecondOf("0.123456789")).toBe(123_457);
});

test("an exact decimal padded with zeros stays exact", () => {
  expect(perSecondOf("0.0840000000000")).toBe(84_000);
  expect(perSecondOf("0.084")).toBe(84_000);
  expect(perSecondOf("1")).toBe(1_000_000);
});

test("a JSON number is read as its decimal, rounded up like the string", () => {
  expect(perSecondOf(0.084)).toBe(84_000);
  expect(perSecondOf(0.112)).toBe(112_000);
});

test("cents are converted exactly and rounded up: 1.00000001 cents is 10 001 µ$", () => {
  const input = (cents: string): number => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0.1", cents_per_image_input: cents } }), "m", "720p").perInputImageMicros;

  expect(input("1.00000001")).toBe(10_001);
  expect(input("1")).toBe(10_000);
  expect(input("0.2")).toBe(2_000);
});

test("a duplicated model id takes the dearer price when the cheaper entry comes first", () => {
  const body = {
    data: [
      { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.05", cents_per_image_input: "1" } },
      { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.09", cents_per_image_input: "2" } },
    ],
  };

  expect(parseVideoModels(body, "m", "720p")).toMatchObject({ perSecondMicros: 90_000, perInputImageMicros: 20_000 });
});

test("a duplicated model id takes the dearer price when the dearer entry comes first", () => {
  const body = {
    data: [
      { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.09" } },
      { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.05" } },
    ],
  };

  expect(parseVideoModels(body, "m", "720p").perSecondMicros).toBe(90_000);
});

test("a duplicated model id with one entry lacking the tier is PRICE_UNAVAILABLE for the video scope", () => {
  const body = {
    data: [
      { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.05" } },
      { id: "m", pricing_skus: { image_to_video_duration_seconds_1080p: "0.09" } },
    ],
  };

  expect(moneyErrorOf(() => parseVideoModels(body, "m", "720p")).scope).toBe("video");
});

test("a SKU that names a resolution before a suffix makes the model not flat: _1080p_with_audio", () => {
  const body = listingOf({ m: { duration_seconds: "0.1", duration_seconds_1080p_with_audio: "0.3" } });

  expect(moneyErrorOf(() => parseVideoModels(body, "m", "720p")).scope).toBe("video");
});

test("a _2k SKU makes the model not flat", () => {
  const body = listingOf({ m: { duration_seconds: "0.1", duration_seconds_2k: "0.2" } });

  expect(moneyErrorOf(() => parseVideoModels(body, "m", "720p")).scope).toBe("video");
});

test("a suffix with no resolution (_with_audio) does not make the model resolution-priced", () => {
  const body = listingOf({ m: { duration_seconds: "0.1", duration_seconds_with_audio: "0.15" } });

  expect(parseVideoModels(body, "m", "720p").perSecondMicros).toBe(100_000);
});

test("a priced book of the cache carries the video part's own day, live or dated", async () => {
  const live = new PriceCache({ load: async () => await loadVideo({ [LISTING_URL]: LISTING }), clock: () => NOW, monotonic: () => 0 });
  const dated = new PriceCache({ load: async () => await loadVideo({}), clock: () => NOW, monotonic: () => 0 });
  const models = { imageModels: [], chatModels: [], videoModels: ALL_VIDEO };

  expect((await live.get(models)).videoAsOf).toBe("2026-10-13");
  expect((await dated.get(models)).videoAsOf).toBe(FALLBACK_VIDEO_DATE);
});

test("a mixed book (image fallback, video live) is dated by the image table but its video part by the load day", async () => {
  const mixed = await loadPriceBook({ fetch: fakeFetch({ [LISTING_URL]: LISTING }), baseUrl: BASE, imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [], videoModels: ALL_VIDEO });
  const cache = new PriceCache({ load: async () => mixed, clock: () => NOW, monotonic: () => 0 });

  const priced = await cache.get({ imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [], videoModels: ALL_VIDEO });

  expect(priced.asOf).toBe(FALLBACK_PRICES_DATE);
  expect(priced.videoAsOf).toBe("2026-10-13");
});

// ---------- round 3: JSON numbers through the exact path, the safe-integer edge, an unreadable duplicate ----------

test("a JSON number with a digit far below a micro-dollar rounds up like its string", () => {
  expect(perSecondOf(0.0840000000004)).toBe(84_001);
});

test("a JSON number in exponent form is expanded exactly: 8.4e-11 USD is 1 µ$", () => {
  expect(perSecondOf(8.4e-11)).toBe(1);
});

test("a positive JSON number below the rounding of toFixed(12) is one micro-dollar, never zero", () => {
  const input = (cents: number): number => parseVideoModels(listingOf({ m: { image_to_video_duration_seconds_720p: "0.1", cents_per_image_input: cents } }), "m", "720p").perInputImageMicros;

  expect(input(1e-13)).toBe(1);
  expect(input(0)).toBe(0);
});

test("a large JSON number is exact: 1500 USD is 1 500 000 000 µ$", () => {
  expect(perSecondOf(1500)).toBe(1_500_000_000);
});

test("a JSON number too large for toFixed to print plainly is PRICE_UNAVAILABLE for the video scope", () => {
  expect(moneyErrorOf(() => perSecondOf(1e30)).scope).toBe("video");
});

test("a price of exactly Number.MAX_SAFE_INTEGER micro-dollars is accepted", () => {
  expect(perSecondOf("9007199254.740991")).toBe(Number.MAX_SAFE_INTEGER);
});

test("a price one micro-dollar above Number.MAX_SAFE_INTEGER is PRICE_UNAVAILABLE for the video scope", () => {
  expect(moneyErrorOf(() => perSecondOf("9007199254.740992")).scope).toBe("video");
});

test("a price of 9007199254740993 USD is PRICE_UNAVAILABLE for the video scope", () => {
  expect(moneyErrorOf(() => perSecondOf("9007199254740993")).scope).toBe("video");
});

test("a duplicated model id with an unreadable entry is PRICE_UNAVAILABLE for the video scope, in either order", () => {
  const good = { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.05" } };
  const broken = { id: "m", pricing_skus: null };

  for (const data of [[good, broken], [broken, good]]) {
    const error = moneyErrorOf(() => parseVideoModels({ data }, "m", "720p"));
    expect([error.code, error.scope]).toEqual(["PRICE_UNAVAILABLE", "video"]);
  }
});

test("an unreadable entry for another model does not stop a model that reads", () => {
  const body = { data: [{ id: "other", pricing_skus: null }, { id: "m", pricing_skus: { image_to_video_duration_seconds_720p: "0.05" } }] };

  expect(parseVideoModels(body, "m", "720p").perSecondMicros).toBe(50_000);
});

test("a listing whose only entries are unreadable is still unreadable as a whole, so the dated table stands in", async () => {
  const book = await loadVideo({ [LISTING_URL]: { data: [{ id: STD, pricing_skus: null }, { id: PRO }] } });

  expect(book.videoSource).toBe("fallback");
});

test("an unreadable entry of a model the clip needs makes the load reject, never the table", async () => {
  const body = { data: [...LISTING.data, { id: STD, pricing_skus: null }] };

  expect((await moneyErrorOfAsync(loadVideo({ [LISTING_URL]: body }))).scope).toBe("video");
});
