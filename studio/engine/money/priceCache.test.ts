import { expect, test } from "bun:test";
import { MoneyError } from "./errors";
import { FALLBACK_PRICES_TTL_MS, LIVE_PRICES_TTL_MS, PriceCache, type PriceModels } from "./priceCache";
import { FALLBACK_PRICES_DATE, PriceBook, type ChatPrice, type ImagePrice, type PriceEntry } from "./prices";

const NOW = Date.parse("2026-10-02T23:59:00.000Z");
const MODELS: PriceModels = { imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: ["x-ai/grok-4.3"] };

function liveBook(imageMicros = 40_000): PriceBook {
  const image: PriceEntry<ImagePrice> = { price: { outputs: [{ variant: null, micros: imageMicros }], inputImageMicros: 0 }, source: "live" };
  const chat: PriceEntry<ChatPrice> = { price: { promptPico: 1, completionPico: 1, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" };
  return new PriceBook(new Map([["x-ai/grok-imagine-image-2.0", image]]), new Map([["x-ai/grok-4.3", chat]]));
}

/** A cache whose loads are counted and answered by `books` in turn (the last one repeats). */
function setup(books: (PriceBook | Error)[] = [liveBook()]) {
  let now = NOW;
  let mono = 0;
  const loads: PriceModels[] = [];
  const cache = new PriceCache({
    load: async (models) => {
      loads.push(models);
      const next = books[Math.min(loads.length, books.length) - 1];
      if (next === undefined) throw new Error("no book scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    clock: () => now,
    monotonic: () => mono,
  });
  return {
    cache,
    loads,
    /** Time passes: both clocks move. */
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    /** Only the wall clock moves (the user or NTP set it). */
    jumpWall: (ms: number) => (now += ms),
  };
}

function imageMicros(book: PriceBook): number {
  return book.imageWorstCase({ model: "x-ai/grok-imagine-image-2.0", resolution: "1K", quality: null, refs: 0 });
}

test("a second request within the refresh time is answered from the cache", async () => {
  const { cache, loads, advance } = setup();

  const first = await cache.get(MODELS);
  advance(LIVE_PRICES_TTL_MS - 1);
  const second = await cache.get(MODELS);

  expect(loads).toHaveLength(1);
  expect(second.book).toBe(first.book);
});

test("live prices are loaded again once the refresh time has passed", async () => {
  const { cache, loads, advance } = setup([liveBook(40_000), liveBook(45_000)]);

  await cache.get(MODELS);
  advance(LIVE_PRICES_TTL_MS);
  const fresh = await cache.get(MODELS);

  expect(loads).toHaveLength(2);
  expect(imageMicros(fresh.book)).toBe(45_000);
});

test("fallback prices are retried sooner: after a minute, not ten", async () => {
  const { cache, loads, advance } = setup([PriceBook.fallback(), liveBook()]);

  await cache.get(MODELS);
  advance(FALLBACK_PRICES_TTL_MS - 1);
  await cache.get(MODELS);
  expect(loads).toHaveLength(1);

  advance(1);
  const fresh = await cache.get(MODELS);
  expect(loads).toHaveLength(2);
  expect(fresh.book.source).toBe("live");
  expect(FALLBACK_PRICES_TTL_MS).toBeLessThan(LIVE_PRICES_TTL_MS);
});

test("requests that arrive while prices load share one load", async () => {
  const { cache, loads } = setup();

  const [a, b] = await Promise.all([cache.get(MODELS), cache.get(MODELS)]);

  expect(loads).toHaveLength(1);
  expect(a.book).toBe(b.book);
});

test("a failed load is not cached: the next request loads again", async () => {
  const unavailable = new MoneyError("PRICE_UNAVAILABLE", "no price for acme/img");
  const { cache, loads } = setup([unavailable, liveBook()]);

  expect(await cache.get(MODELS).catch((e: unknown) => e)).toBe(unavailable);
  expect((await cache.get(MODELS)).book.source).toBe("live");
  expect(loads).toHaveLength(2);
});

test("another set of models (the settings changed) has its own entry", async () => {
  const { cache, loads } = setup();
  const other: PriceModels = { imageModels: ["bytedance-seed/seedream-5-0-pro"], chatModels: ["x-ai/grok-4.3"] };

  await cache.get(MODELS);
  await cache.get(other);
  await cache.get(MODELS);

  expect(loads).toEqual([MODELS, other]);
});

test("the order of the models does not matter", async () => {
  const { cache, loads } = setup();
  const images = ["x-ai/grok-imagine-image-2.0", "bytedance-seed/seedream-5-0-pro"];

  await cache.get({ imageModels: images, chatModels: ["x-ai/grok-4.3"] });
  await cache.get({ imageModels: [...images].reverse(), chatModels: ["x-ai/grok-4.3"] });

  expect(loads).toHaveLength(1);
});

test("the models are loaded without duplicates", async () => {
  const { cache, loads } = setup();

  await cache.get({ imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: ["x-ai/grok-4.3", "x-ai/grok-4.3"] });

  expect(loads).toEqual([MODELS]);
});

test("peek never loads: null before the first load, then the last prices even when they are due for a refresh", async () => {
  const { cache, loads, advance } = setup();

  expect(cache.peek(MODELS)).toBeNull();
  const loaded = await cache.get(MODELS);
  advance(LIVE_PRICES_TTL_MS * 3);

  expect(cache.peek(MODELS)).toEqual(loaded);
  expect(cache.peek({ imageModels: ["bytedance-seed/seedream-5-0-pro"], chatModels: [] })).toBeNull();
  expect(loads).toHaveLength(1);
});

test("live prices are dated by the UTC day they were loaded, fallback prices by the table's date", async () => {
  const live = await setup([liveBook()]).cache.get(MODELS);
  const fallback = await setup([PriceBook.fallback()]).cache.get(MODELS);

  expect(live.asOf).toBe("2026-10-02");
  expect(fallback.asOf).toBe(FALLBACK_PRICES_DATE);
});

test("the refresh time runs on the monotonic clock: a wall clock set back an hour does not keep old prices", async () => {
  const { cache, loads, advance, jumpWall } = setup([liveBook(40_000), liveBook(45_000)]);

  await cache.get(MODELS);
  jumpWall(-60 * 60_000);
  advance(LIVE_PRICES_TTL_MS);
  await cache.get(MODELS);

  expect(loads).toHaveLength(2);
});

test("a wall clock that jumps a day ahead does not reload prices early", async () => {
  const { cache, loads, advance, jumpWall } = setup();

  await cache.get(MODELS);
  jumpWall(24 * 60 * 60_000);
  advance(60_000);
  await cache.get(MODELS);

  expect(loads).toHaveLength(1);
});
