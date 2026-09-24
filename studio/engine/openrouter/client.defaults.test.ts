import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MoneyError } from "../money/errors";
import { createOpenRouterClient } from "./client";
import { fakeFetch, imageBody, imageParams, LOCAL_BASE, PNG, setupMoney, TEST_KEY, type Money, type Step } from "./testing/fakes";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

/** A client with the production defaults for sleep, timeout, clocks and jitter. */
function defaultClient(steps: Step[]) {
  const { fetch, calls } = fakeFetch(steps);
  const client = createOpenRouterClient({ apiKey: TEST_KEY, baseUrl: LOCAL_BASE, allowBaseUrlOverride: true, fetch, saveRaw: async () => {} });
  return { client, calls };
}

test("arms the money core's 180 s request timeout by default", async () => {
  const setTimeoutSpy = spyOn(globalThis, "setTimeout");
  try {
    const { client } = defaultClient([{ status: 200, body: imageBody(PNG, { cost: 0.05 }) }]);

    await client.generateImage(imageParams(money));

    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 180_000)).toHaveLength(1);
  } finally {
    setTimeoutSpy.mockRestore();
  }
});

test("the default retry wait ends as soon as the signal aborts", async () => {
  const { client, calls } = defaultClient([{ status: 429 }]);
  const controller = new AbortController();
  const started = performance.now();

  const pending = client.generateImage(imageParams(money, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  const result = await pending;

  expect(result).toEqual({ status: "aborted", ledger: { action: "settled", costMicros: 0, estimated: false } });
  expect(calls).toHaveLength(1);
  expect(performance.now() - started).toBeLessThan(500);
}, 2_000);

test("refuses to send an attempt id a second time (invariant 5)", async () => {
  const { client, calls } = defaultClient([{ status: 200, body: imageBody(PNG, { cost: 0.05 }) }]);
  await client.generateImage(imageParams(money));

  let err: unknown;
  try {
    await client.generateImage(imageParams(money));
  } catch (e) {
    err = e;
  }

  expect(err instanceof MoneyError && err.code).toBe("ATTEMPT_ID_REUSED");
  expect(calls).toHaveLength(1);
});
