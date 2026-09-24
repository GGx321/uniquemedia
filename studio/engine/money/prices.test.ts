import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MoneyError } from "./errors";
import {
  FALLBACK_PRICES_DATE,
  PriceBook,
  chatWorstCase,
  imageWorstCase,
  loadPriceBook,
  PRICE_FETCH_TIMEOUT_MS,
  parseChatModels,
  parseImageEndpoints,
  type ChatPrice,
  type FetchLike,
  type ImagePrice,
} from "./prices";

// Real response bodies of the public, free GET endpoints, saved on 2026-09-24
// (/models trimmed to two entries; each entry is unchanged).
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}
const GROK_2 = "x-ai/grok-imagine-image-2.0";
const GROK_Q = "x-ai/grok-imagine-image-quality";
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const GROK_CHAT = "x-ai/grok-4.3";
const BASE = "http://127.0.0.1:9/api/v1";

const LIVE: Record<string, unknown> = {
  [`${BASE}/images/models/${GROK_2}/endpoints`]: fixture("endpoints-grok-imagine-image-2.0.json"),
  [`${BASE}/images/models/${GROK_Q}/endpoints`]: fixture("endpoints-grok-imagine-image-quality.json"),
  [`${BASE}/images/models/${SEEDREAM}/endpoints`]: fixture("endpoints-seedream-5-0-pro.json"),
  [`${BASE}/models`]: fixture("models-chat.json"),
};

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

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    return err instanceof MoneyError ? err.code : `not a MoneyError: ${String(err)}`;
  }
  return null;
}

// ---------- parsing the three real endpoint shapes ----------

test("parses grok-imagine-image-2.0 endpoints: quality × resolution variants and an input-image price", () => {
  expect(parseImageEndpoints(fixture("endpoints-grok-imagine-image-2.0.json"), GROK_2)).toEqual({
    outputs: [
      { variant: "low_1k", micros: 40_000 },
      { variant: "low_2k", micros: 60_000 },
      { variant: "medium_1k", micros: 60_000 },
      { variant: "medium_2k", micros: 80_000 },
    ],
    inputImageMicros: 10_000,
  });
});

test("parses grok-imagine-image-quality endpoints: resolution-only variants", () => {
  expect(parseImageEndpoints(fixture("endpoints-grok-imagine-image-quality.json"), GROK_Q)).toEqual({
    outputs: [
      { variant: "1k", micros: 50_000 },
      { variant: "2k", micros: 70_000 },
    ],
    inputImageMicros: 10_000,
  });
});

test("parses seedream endpoints: a base price and a high_resolution variant", () => {
  expect(parseImageEndpoints(fixture("endpoints-seedream-5-0-pro.json"), SEEDREAM)).toEqual({
    outputs: [
      { variant: null, micros: 45_000 },
      { variant: "high_resolution", micros: 90_000 },
    ],
    inputImageMicros: 3_000,
  });
});

test("takes the highest price per variant when several providers serve the model", () => {
  const body = {
    id: "acme/img",
    endpoints: [
      { pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" }, { billable: "input_image", unit: "image", cost_usd: 0.01 }] },
      { pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.05, variant: "1k" }, { billable: "input_image", unit: "image", cost_usd: 0.002 }] },
    ],
  };

  expect(parseImageEndpoints(body, "acme/img")).toEqual({ outputs: [{ variant: "1k", micros: 50_000 }], inputImageMicros: 10_000 });
});

test("a model without an input_image price charges nothing per reference", () => {
  const body = { id: "acme/img", endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.03 }] }] };

  expect(parseImageEndpoints(body, "acme/img").inputImageMicros).toBe(0);
});

test("rejects an endpoints body for a different model", () => {
  expect(() => parseImageEndpoints(fixture("endpoints-seedream-5-0-pro.json"), GROK_2)).toThrow(GROK_2);
});

test("rejects an endpoints body without an output_image price", () => {
  const body = { id: "acme/img", endpoints: [{ pricing: [{ billable: "input_image", unit: "image", cost_usd: 0.01 }] }] };

  expect(() => parseImageEndpoints(body, "acme/img")).toThrow("output_image");
});

test("rejects an output_image price billed per a unit other than an image", () => {
  const body = { id: "acme/img", endpoints: [{ pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.01 }] }] };

  expect(() => parseImageEndpoints(body, "acme/img")).toThrow("megapixel");
});

// ---------- image worst case ----------

const GROK_2_PRICE: ImagePrice = {
  outputs: [
    { variant: "low_1k", micros: 40_000 },
    { variant: "low_2k", micros: 60_000 },
    { variant: "medium_1k", micros: 60_000 },
    { variant: "medium_2k", micros: 80_000 },
  ],
  inputImageMicros: 10_000,
};
const SEEDREAM_PRICE: ImagePrice = {
  outputs: [
    { variant: null, micros: 45_000 },
    { variant: "high_resolution", micros: 90_000 },
  ],
  inputImageMicros: 3_000,
};

test("the default photo (grok 2.0, low, 1K, one reference) costs $0.05 at worst", () => {
  expect(imageWorstCase(GROK_2_PRICE, { resolution: "1K", quality: "low", refs: 1 })).toBe(50_000);
});

test("grok 2.0 medium 2K without references uses the medium_2k price", () => {
  expect(imageWorstCase(GROK_2_PRICE, { resolution: "2K", quality: "medium", refs: 0 })).toBe(80_000);
});

test("without a quality the dearest quality at that resolution is the worst case", () => {
  expect(imageWorstCase(GROK_2_PRICE, { resolution: "1K", quality: null, refs: 0 })).toBe(60_000);
});

test("resolution-only variants: grok quality 2K with two references", () => {
  const price: ImagePrice = { outputs: [{ variant: "1k", micros: 50_000 }, { variant: "2k", micros: 70_000 }], inputImageMicros: 10_000 };

  expect(imageWorstCase(price, { resolution: "2K", quality: null, refs: 2 })).toBe(90_000);
});

test("seedream: 1K uses the base price, 2K the high_resolution price, and a quality is ignored", () => {
  expect(imageWorstCase(SEEDREAM_PRICE, { resolution: "1K", quality: "low", refs: 1 })).toBe(48_000);
  expect(imageWorstCase(SEEDREAM_PRICE, { resolution: "2K", quality: null, refs: 0 })).toBe(90_000);
});

test("variants that match nothing fall back to the dearest output price", () => {
  const price: ImagePrice = { outputs: [{ variant: "turbo", micros: 70_000 }, { variant: "eco", micros: 30_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { resolution: "1K", quality: "low", refs: 0 })).toBe(70_000);
});

test("variant names match case-insensitively: an upper-case 2K variant beats the base price", () => {
  const price: ImagePrice = { outputs: [{ variant: null, micros: 40_000 }, { variant: "2K", micros: 80_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { resolution: "2K", quality: null, refs: 0 })).toBe(80_000);
  expect(imageWorstCase(price, { resolution: "1K", quality: null, refs: 0 })).toBe(40_000);
});

test("a resolution without its own variant never gets a base price below a dearer variant: {base, 4k} prices 2K at 4k", () => {
  const price: ImagePrice = { outputs: [{ variant: null, micros: 40_000 }, { variant: "4k", micros: 120_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { resolution: "2K", quality: null, refs: 0 })).toBe(120_000);
});

test("1K keeps the base price when every variant names a higher resolution (seedream's high_resolution)", () => {
  const price: ImagePrice = { outputs: [{ variant: null, micros: 40_000 }, { variant: "4k", micros: 120_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { resolution: "1K", quality: null, refs: 0 })).toBe(40_000);
});

test("a requested quality without its variant never prices below the base", () => {
  const price: ImagePrice = { outputs: [{ variant: null, micros: 90_000 }, { variant: "medium_1k", micros: 60_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { resolution: "1K", quality: "low", refs: 0 })).toBe(90_000);
});

test("an unrecognised variant disables the base price: the dearest output is the worst case", () => {
  const price: ImagePrice = { outputs: [{ variant: null, micros: 40_000 }, { variant: "ultra", micros: 90_000 }], inputImageMicros: 0 };

  expect(imageWorstCase(price, { resolution: "1K", quality: null, refs: 0 })).toBe(90_000);
});

test("a quality the model does not list takes the dearest quality at that resolution", () => {
  expect(imageWorstCase(GROK_2_PRICE, { resolution: "2K", quality: "low", refs: 0 })).toBe(60_000);
  const noLow: ImagePrice = {
    outputs: [
      { variant: "medium_1k", micros: 60_000 },
      { variant: "high_1k", micros: 70_000 },
      { variant: "high_2k", micros: 90_000 },
    ],
    inputImageMicros: 0,
  };
  expect(imageWorstCase(noLow, { resolution: "1K", quality: "low", refs: 0 })).toBe(70_000);
});

test("refs must be a non-negative integer", () => {
  expect(() => imageWorstCase(GROK_2_PRICE, { resolution: "1K", quality: "low", refs: -1 })).toThrow(TypeError);
  expect(() => imageWorstCase(GROK_2_PRICE, { resolution: "1K", quality: "low", refs: 1.5 })).toThrow(TypeError);
});

// ---------- chat prices ----------

const GROK_CHAT_PRICE: ChatPrice = {
  promptPico: 1_250_000,
  completionPico: 2_500_000,
  imagePico: 0,
  requestPico: 0,
  overrides: [{ minPromptTokens: 200_000, promptPico: 2_500_000, completionPico: 5_000_000, imagePico: 0, requestPico: 0 }],
};

/** The real grok-4.3 /models entry with its pricing changed. */
function grokEntryWith(pricing: Record<string, unknown>): { data: unknown[] } {
  const models = fixture("models-chat.json") as { data: { id: string; pricing: Record<string, unknown> }[] };
  const grok = models.data.find((m) => m.id === GROK_CHAT);
  if (!grok) throw new Error("fixture lacks grok-4.3");
  return { data: [{ ...grok, pricing: { ...grok.pricing, ...pricing } }] };
}

test("parses the real grok-4.3 /models entry into picodollars per unit (per-token strings, overrides)", () => {
  expect(parseChatModels(fixture("models-chat.json"), GROK_CHAT)).toEqual(GROK_CHAT_PRICE);
});

test("parses a model without overrides", () => {
  expect(parseChatModels(fixture("models-chat.json"), "openai/gpt-4o-mini")).toEqual({
    promptPico: 150_000,
    completionPico: 600_000,
    imagePico: 0,
    requestPico: 0,
    overrides: [],
  });
});

test("parses per-image and per-request prices", () => {
  expect(parseChatModels(grokEntryWith({ image: "0.001", request: "0.0005" }), GROK_CHAT)).toMatchObject({
    imagePico: 1_000_000_000,
    requestPico: 500_000_000,
  });
});

test("ignores allowlisted fields and any zero-valued field", () => {
  const body = grokEntryWith({
    input_cache_write: "0.0000000833333333333333",
    input_cache_write_1h: "0.000001",
    audio: "0",
    internal_reasoning: "0.0000",
    image_output: 0,
  });

  expect(parseChatModels(body, GROK_CHAT)).toEqual(GROK_CHAT_PRICE);
});

test("rejects a non-zero pricing field the worst case cannot bound", () => {
  expect(() => parseChatModels(grokEntryWith({ internal_reasoning: "0.0000025" }), GROK_CHAT)).toThrow("internal_reasoning");
});

test("rejects the real gemini entry, which bills audio and internal reasoning separately", () => {
  expect(() => parseChatModels(fixture("models-chat.json"), "google/gemini-3.5-flash-lite")).toThrow("internal_reasoning");
});

test("rejects a non-zero unknown field inside an override", () => {
  const body = grokEntryWith({ overrides: [{ min_prompt_tokens: 200_000, prompt: "0.0000025", audio: "0.00001" }] });

  expect(() => parseChatModels(body, GROK_CHAT)).toThrow("audio");
});

test("unrelated models with unusual pricing do not break parsing", () => {
  const body = { data: [{ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }, ...(fixture("models-chat.json") as { data: unknown[] }).data] };

  expect(parseChatModels(body, GROK_CHAT)).toEqual(GROK_CHAT_PRICE);
});

test("rejects when the model is not listed in /models", () => {
  expect(() => parseChatModels(fixture("models-chat.json"), "acme/chat")).toThrow("acme/chat");
});

test("rejects a price string that is not a plain non-negative decimal", () => {
  for (const bad of ["-1", "1e-6", "", "0.000002.5"]) {
    const body = { data: [{ id: "acme/chat", pricing: { prompt: bad, completion: "0.000001" } }] };
    expect(() => parseChatModels(body, "acme/chat")).toThrow("pricing");
  }
});

test("the writer's worst case: 8000 output + 8000 input tokens on grok-4.3 is $0.03", () => {
  expect(chatWorstCase(GROK_CHAT_PRICE, { maxTokens: 8_000, inputTokens: 8_000, images: 0 })).toBe(30_000);
});

test("an age check's worst case: 1000 output + 2000 input tokens on grok-4.3 is $0.005", () => {
  expect(chatWorstCase(GROK_CHAT_PRICE, { maxTokens: 1_000, inputTokens: 2_000, images: 1 })).toBe(5_000);
});

test("the worst case adds the per-image price for each image and the per-request price", () => {
  const price: ChatPrice = { ...GROK_CHAT_PRICE, imagePico: 1_000_000_000, requestPico: 500_000_000, overrides: [] };

  expect(chatWorstCase(price, { maxTokens: 1_000, inputTokens: 2_000, images: 1 })).toBe(5_000 + 1_000 + 500);
  expect(chatWorstCase(price, { maxTokens: 1_000, inputTokens: 2_000, images: 3 })).toBe(5_000 + 3_000 + 500);
});

test("a fractional micro-dollar is rounded up", () => {
  const price: ChatPrice = { promptPico: 150_000, completionPico: 600_000, imagePico: 0, requestPico: 0, overrides: [] };

  expect(chatWorstCase(price, { maxTokens: 1, inputTokens: 0, images: 0 })).toBe(1);
});

test("the long-prompt override applies from its threshold, not one token before", () => {
  expect(chatWorstCase(GROK_CHAT_PRICE, { maxTokens: 1_000, inputTokens: 199_999, images: 0 })).toBe(252_499);
  expect(chatWorstCase(GROK_CHAT_PRICE, { maxTokens: 1_000, inputTokens: 200_000, images: 0 })).toBe(505_000);
});

test("images must be a non-negative integer", () => {
  expect(() => chatWorstCase(GROK_CHAT_PRICE, { maxTokens: 1, inputTokens: 1, images: -1 })).toThrow("images");
});

// ---------- price book: live, fallback, flag ----------

test("loadPriceBook uses live prices when every fetch succeeds", async () => {
  const fetch = fakeFetch(LIVE);

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [GROK_2, SEEDREAM], chatModels: [GROK_CHAT] });

  expect(book.source).toBe("live");
  expect(book.fallbackDate).toBeNull();
  expect(book.imageWorstCase({ model: GROK_2, resolution: "1K", quality: "low", refs: 1 })).toBe(50_000);
  expect(book.chatWorstCase({ model: GROK_CHAT, maxTokens: 8_000, inputTokens: 8_000, images: 0 })).toBe(30_000);
  expect([...fetch.urls].sort()).toEqual(
    [`${BASE}/images/models/${GROK_2}/endpoints`, `${BASE}/images/models/${SEEDREAM}/endpoints`, `${BASE}/models`].sort()
  );
});

test("the /models fetch runs while the image endpoints are still loading: one price load waits for one timeout, not two", async () => {
  let modelsAsked: () => void = () => {};
  const modelsStarted = new Promise<void>((resolve) => (modelsAsked = resolve));
  const routes = fakeFetch(LIVE);
  const fetch: FetchLike = async (url, init) => {
    if (url === `${BASE}/models`) modelsAsked();
    else await Promise.race([modelsStarted, Bun.sleep(500).then(() => Promise.reject(new Error("the image fetch ran alone")))]);
    return routes(url, init);
  };

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [GROK_2], chatModels: [GROK_CHAT] });

  expect([book.sourceOf(GROK_2), book.sourceOf(GROK_CHAT)]).toEqual(["live", "live"]);
});

test("two fetches that never answer end together at the one timeout, and both fall back", async () => {
  const hanging: FetchLike = (_url, init) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  const started = performance.now();

  const book = await loadPriceBook({ fetch: hanging, baseUrl: BASE, imageModels: [GROK_2], chatModels: [GROK_CHAT], timeoutMs: 300 });

  expect(performance.now() - started).toBeLessThan(550);
  expect(book.source).toBe("fallback");
});

test("the price fetch timeout is 15 s by default", () => {
  expect(PRICE_FETCH_TIMEOUT_MS).toBe(15_000);
});

test("a failed image fetch falls back to the dated table for that model and flags it", async () => {
  const fetch = fakeFetch({ ...LIVE, [`${BASE}/images/models/${GROK_2}/endpoints`]: new Error("ECONNRESET") });

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [GROK_2, SEEDREAM], chatModels: [GROK_CHAT] });

  expect(book.source).toBe("fallback");
  expect(book.fallbackDate).toBe(FALLBACK_PRICES_DATE);
  expect(book.sourceOf(GROK_2)).toBe("fallback");
  expect(book.sourceOf(SEEDREAM)).toBe("live");
  expect(book.imageWorstCase({ model: GROK_2, resolution: "1K", quality: "low", refs: 1 })).toBe(50_000);
});

test("a non-2xx price response falls back", async () => {
  const book = await loadPriceBook({ fetch: fakeFetch({ ...LIVE, [`${BASE}/models`]: 503 }), baseUrl: BASE, imageModels: [], chatModels: [GROK_CHAT] });

  expect(book.sourceOf(GROK_CHAT)).toBe("fallback");
  expect(book.chatWorstCase({ model: GROK_CHAT, maxTokens: 1_000, inputTokens: 2_000, images: 1 })).toBe(5_000);
});

test("a live chat entry with an unbounded pricing field falls back, or is PRICE_UNAVAILABLE without a fallback", async () => {
  const withReasoning = grokEntryWith({ internal_reasoning: "0.0000025" });
  const models = { data: [...withReasoning.data, ...(fixture("models-chat.json") as { data: unknown[] }).data.filter((m) => (m as { id: string }).id !== GROK_CHAT)] };

  const book = await loadPriceBook({ fetch: fakeFetch({ [`${BASE}/models`]: models }), baseUrl: BASE, imageModels: [], chatModels: [GROK_CHAT] });
  expect(book.sourceOf(GROK_CHAT)).toBe("fallback");

  let err: unknown;
  try {
    await loadPriceBook({ fetch: fakeFetch({ [`${BASE}/models`]: models }), baseUrl: BASE, imageModels: [], chatModels: ["google/gemini-3.5-flash-lite"] });
  } catch (e) {
    err = e;
  }
  expect(err instanceof MoneyError ? err.code : null).toBe("PRICE_UNAVAILABLE");
});

test("an unexpected price body falls back", async () => {
  const fetch = fakeFetch({ ...LIVE, [`${BASE}/images/models/${SEEDREAM}/endpoints`]: { id: SEEDREAM, endpoints: "soon" } });

  const book = await loadPriceBook({ fetch, baseUrl: BASE, imageModels: [SEEDREAM], chatModels: [] });

  expect(book.sourceOf(SEEDREAM)).toBe("fallback");
});

test("a model unknown to both the live endpoint and the fallback table is PRICE_UNAVAILABLE", async () => {
  const fetch = fakeFetch(LIVE);

  let err: unknown;
  try {
    await loadPriceBook({ fetch, baseUrl: BASE, imageModels: ["acme/unknown-image"], chatModels: [] });
  } catch (e) {
    err = e;
  }

  expect(err instanceof MoneyError ? err.code : null).toBe("PRICE_UNAVAILABLE");
});

test("asking the book for a model it was not loaded with is PRICE_UNAVAILABLE", () => {
  const book = PriceBook.fallback();

  expect(codeOf(() => book.imageWorstCase({ model: "acme/unknown-image", resolution: "1K", quality: null, refs: 0 }))).toBe("PRICE_UNAVAILABLE");
  expect(codeOf(() => book.chatWorstCase({ model: "acme/unknown-chat", maxTokens: 1, inputTokens: 1, images: 0 }))).toBe("PRICE_UNAVAILABLE");
});

test("the fallback table matches the live responses saved on its date", () => {
  const book = PriceBook.fallback();
  const cases = [
    { model: GROK_2, file: "endpoints-grok-imagine-image-2.0.json" },
    { model: GROK_Q, file: "endpoints-grok-imagine-image-quality.json" },
    { model: SEEDREAM, file: "endpoints-seedream-5-0-pro.json" },
  ];

  expect(book.source).toBe("fallback");
  for (const { model, file } of cases) {
    const live = parseImageEndpoints(fixture(file), model);
    for (const resolution of ["1K", "2K"] as const) {
      for (const quality of ["low", "medium", null] as const) {
        for (const refs of [0, 1, 3]) {
          expect(book.imageWorstCase({ model, resolution, quality, refs })).toBe(imageWorstCase(live, { resolution, quality, refs }));
        }
      }
    }
  }
  const liveChat = parseChatModels(fixture("models-chat.json"), GROK_CHAT);
  for (const inputTokens of [0, 8_000, 200_000]) {
    expect(book.chatWorstCase({ model: GROK_CHAT, maxTokens: 8_000, inputTokens, images: 1 })).toBe(chatWorstCase(liveChat, { maxTokens: 8_000, inputTokens, images: 1 }));
  }
});
