import { expect, test } from "bun:test";
import { loadPriceBook } from "../money/prices";
import { priceFetchFrom } from "./priceFetch";
import { fakeFetch, LOCAL_BASE } from "./testing/fakes";

const MODELS_BODY = { data: [{ id: "x-ai/grok-4.3", pricing: { prompt: "0.000002", completion: "0.000004" } }] };

test("prices are read with a plain GET: no API key, redirects refused", async () => {
  const net = fakeFetch([{ status: 200, body: MODELS_BODY }]);

  await priceFetchFrom(net.fetch)(`${LOCAL_BASE}/models`);

  expect(net.calls.map((c) => [c.method, c.url, c.headers, c.redirect])).toEqual([["GET", `${LOCAL_BASE}/models`, {}, "error"]]);
});

test("a 2xx answers ok and its body parses as JSON", async () => {
  const res = await priceFetchFrom(fakeFetch([{ status: 200, body: MODELS_BODY }]).fetch)(`${LOCAL_BASE}/models`);

  expect([res.ok, res.status, await res.json()]).toEqual([true, 200, MODELS_BODY]);
});

test("a non-2xx answers not ok with its status", async () => {
  const res = await priceFetchFrom(fakeFetch([{ status: 503, body: "busy" }]).fetch)(`${LOCAL_BASE}/models`);

  expect([res.ok, res.status]).toEqual([false, 503]);
});

test("a body over the cap is refused and its stream cancelled", async () => {
  const net = fakeFetch([{ status: 200, body: { data: [], padding: "x".repeat(4_000) }, chunkBytes: 1_000 }]);
  const res = await priceFetchFrom(net.fetch, 2_048)(`${LOCAL_BASE}/models`);

  expect(await res.json().then(() => "parsed", (e: unknown) => (e instanceof Error ? e.message : String(e)))).toContain("2048 bytes");
  expect(net.calls[0]?.response.cancelled).toBe(true);
});

test("the loader's timeout signal reaches the fetch", async () => {
  const net = fakeFetch([{ status: 200, body: MODELS_BODY }]);
  const controller = new AbortController();

  await priceFetchFrom(net.fetch)(`${LOCAL_BASE}/models`, { signal: controller.signal });

  expect(net.calls[0]?.signal).toBe(controller.signal);
});

test("through the adapter the price loader reads live prices, and falls back per model when a fetch fails", async () => {
  const endpoints = { id: "x-ai/grok-imagine-image-2.0", endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.03, variant: "low_1k" }] }] };
  const net = fakeFetch([{ status: 200, body: endpoints }, { reject: new TypeError("fetch failed") }]);

  const book = await loadPriceBook({
    fetch: priceFetchFrom(net.fetch),
    baseUrl: LOCAL_BASE,
    imageModels: ["x-ai/grok-imagine-image-2.0"],
    chatModels: ["x-ai/grok-4.3"],
  });

  expect(net.calls.map((c) => c.url)).toEqual([`${LOCAL_BASE}/images/models/x-ai/grok-imagine-image-2.0/endpoints`, `${LOCAL_BASE}/models`]);
  expect([book.sourceOf("x-ai/grok-imagine-image-2.0"), book.sourceOf("x-ai/grok-4.3")]).toEqual(["live", "fallback"]);
  expect(book.imageWorstCase({ model: "x-ai/grok-imagine-image-2.0", resolution: "1K", quality: "low", refs: 0 })).toBe(30_000);
});
