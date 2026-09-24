import { afterEach, beforeEach, expect, test } from "bun:test";
import { OpenRouterError } from "./errors";
import { fakeFetch, LOCAL_BASE, makeClient, setupMoney, TEST_KEY, type Money, type Step } from "./testing/fakes";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

const CREDITS = { data: { total_credits: 20, total_usage: 1.2345 } };

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function codeOf(err: unknown): string | null {
  return err instanceof OpenRouterError ? err.code : null;
}

function credits(steps: Step[]) {
  const { fetch, calls } = fakeFetch(steps);
  return { client: makeClient(fetch).client, calls };
}

test("GETs /credits with the key as a bearer token and returns the parsed body", async () => {
  const { client, calls } = credits([{ status: 200, body: CREDITS }]);

  const body = await client.fetchCredits();

  expect(body).toEqual(CREDITS);
  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/credits`);
  expect(calls[0]?.method).toBe("GET");
  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(calls[0]?.body).toBeUndefined();
});

test("is what the money core's reconcile expects from a credits fetcher", async () => {
  const { client } = credits([{ status: 200, body: CREDITS }]);
  const { fetchCredits } = client;

  const result = await money.budget.reconcile({ fetchCredits });

  expect(result).toMatchObject({ ok: true, creditsUsageMicros: 1_234_500 });
});

test("throws AUTH_INVALID on 401, without the key in the message", async () => {
  const { client } = credits([{ status: 401, body: { error: { message: `No auth credentials found for Bearer ${TEST_KEY}` } } }]);

  const err = await thrownBy(client.fetchCredits());

  expect(codeOf(err)).toBe("AUTH_INVALID");
  expect(err instanceof OpenRouterError && err.httpStatus).toBe(401);
  expect(String(err)).not.toContain(TEST_KEY);
});

test("throws HTTP_ERROR on any other non-2xx", async () => {
  const { client } = credits([{ status: 503, body: { error: { message: "unavailable" } } }]);

  expect(codeOf(await thrownBy(client.fetchCredits()))).toBe("HTTP_ERROR");
});

test("throws when a 2xx body is not JSON", async () => {
  const { client } = credits([{ status: 200, body: "<html>" }]);

  expect(codeOf(await thrownBy(client.fetchCredits()))).toBe("HTTP_ERROR");
});

test("throws NETWORK when fetch fails", async () => {
  const { client } = credits([{ reject: new TypeError("fetch failed") }]);

  expect(codeOf(await thrownBy(client.fetchCredits()))).toBe("NETWORK");
});
