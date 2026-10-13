import { expect, test } from "bun:test";
import { fakeFetch, LOCAL_BASE, makeClient, TEST_KEY, type Step } from "./testing/fakes";
import { fixture, FIXTURE_ID } from "./testing/videoFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

function lookup(steps: Step[]) {
  const { fetch, calls } = fakeFetch(steps);
  const harness = makeClient(fetch);
  return { ...harness, calls };
}

test("GETs /generation with the id in the query and the key as a bearer token", async () => {
  const { client, calls } = lookup([{ status: 200, body: fixture("generation-found-kling") }]);

  await client.fetchGeneration(FIXTURE_ID);

  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/generation?id=${FIXTURE_ID}`);
  expect(calls[0]?.method).toBe("GET");
  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(calls[0]?.redirect).toBe("error");
});

test("reads the provider's bill in micro-dollars from a Kling generation", async () => {
  const { client } = lookup([{ status: 200, body: fixture("generation-found-kling") }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toEqual({ kind: "found", totalCostMicros: 420_000, finishReason: "complete" });
});

test("reads a bill for a clip that ended on a content filter, with its finish reason", async () => {
  const { client } = lookup([{ status: 200, body: fixture("generation-found-content-filter") }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toEqual({ kind: "found", totalCostMicros: 1_260_000, finishReason: "content_filter" });
});

test("reads a zero bill as found, not as missing", async () => {
  const body = { data: { total_cost: 0, finish_reason: "complete" } };
  const { client } = lookup([{ status: 200, body }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toEqual({ kind: "found", totalCostMicros: 0, finishReason: "complete" });
});

test("keeps the float noise of a dollar figure out of the micros", async () => {
  const body = { data: { total_cost: 0.045000000000000005, finish_reason: null } };
  const { client } = lookup([{ status: 200, body }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toEqual({ kind: "found", totalCostMicros: 45_000, finishReason: null });
});

test("answers not-found for the API's own 404", async () => {
  const { client } = lookup([{ status: 404, body: fixture("generation-not-found") }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toEqual({ kind: "not-found" });
});

test("a 404 is not an unreadable answer", async () => {
  const { client } = lookup([{ status: 404, body: fixture("generation-not-found") }]);

  const result = await client.fetchGeneration(FIXTURE_ID);

  expect(result.kind).not.toBe("unreadable");
});

test("does not take a 404 page that is not the API's as proof that nothing is billed", async () => {
  const { client } = lookup([{ status: 404, body: "<html><title>404 Not Found</title></html>" }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toMatchObject({ kind: "unreadable", cause: "http", httpStatus: 404 });
});

test("answers unreadable on a 5xx", async () => {
  const { client } = lookup([{ status: 503, body: { error: { message: "unavailable" } } }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toMatchObject({ kind: "unreadable", cause: "http", httpStatus: 503 });
});

test("answers unreadable with cause auth on a 401", async () => {
  const { client } = lookup([{ status: 401, body: { error: { message: "no auth" } } }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toMatchObject({ kind: "unreadable", cause: "auth", httpStatus: 401 });
});

test("answers unreadable when fetch fails", async () => {
  const { client } = lookup([{ reject: new TypeError("fetch failed") }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toMatchObject({ kind: "unreadable", cause: "network", httpStatus: null });
});

test("answers unreadable when the body is not JSON", async () => {
  const { client } = lookup([{ status: 200, body: "<html>" }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toMatchObject({ kind: "unreadable", cause: "malformed", httpStatus: 200 });
});

test.each([
  ["a missing total_cost", { data: { finish_reason: "complete" } }],
  ["a null total_cost", { data: { total_cost: null, finish_reason: "complete" } }],
  ["a string total_cost", { data: { total_cost: "0.42", finish_reason: "complete" } }],
  ["a negative total_cost", { data: { total_cost: -0.42, finish_reason: "complete" } }],
  ["a total_cost too large for micros", { data: { total_cost: 1e300, finish_reason: "complete" } }],
  ["no data object", { total_cost: 0.42 }],
])("answers unreadable, never a cost, for %s", async (_name, body) => {
  const { client } = lookup([{ status: 200, body }]);

  expect(await client.fetchGeneration(FIXTURE_ID)).toMatchObject({ kind: "unreadable", cause: "malformed" });
});

test("asks once and never retries a failing lookup", async () => {
  const { client, calls } = lookup([{ status: 503, body: "x" }, { status: 200, body: fixture("generation-found-kling") }]);

  await client.fetchGeneration(FIXTURE_ID);

  expect(calls).toHaveLength(1);
});

test("answers unreadable with cause aborted when the caller's signal has fired", async () => {
  const { fetch } = fakeFetch([{ hang: true }]);
  const { client } = makeClient(fetch);
  const abort = new AbortController();
  abort.abort();

  expect(await client.fetchGeneration(FIXTURE_ID, abort.signal)).toMatchObject({ kind: "unreadable", cause: "aborted" });
});

test("url-encodes an id that carries reserved characters", async () => {
  const { client, calls } = lookup([{ status: 404, body: fixture("generation-not-found") }]);

  await client.fetchGeneration("a&b=c");

  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/generation?id=a%26b%3Dc`);
});
