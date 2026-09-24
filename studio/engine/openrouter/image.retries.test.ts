import { afterEach, beforeEach, expect, test } from "bun:test";
import { fakeFetch, imageBody, imageParams, makeClient, PNG, setupMoney, withoutAt, WORST_ONE_REF, type Money, type Step } from "./testing/fakes";
import type { OpenRouterClientOptions } from "./types";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

const OK: Step = { status: 200, body: imageBody(PNG, { cost: 0.05 }) };
const MODERATION = { error: { code: 400, message: "xAI blocked this request through content moderation.", metadata: { provider_name: "xAI" } } };

async function run(steps: Step[], overrides: Partial<OpenRouterClientOptions> = {}) {
  const { fetch, calls } = fakeFetch(steps);
  const harness = makeClient(fetch, overrides);
  const result = await harness.client.generateImage(imageParams(money));
  return { result, calls, ...harness };
}

// ---------- transport retries ----------

test("retries a 429 inside the same attempt id, waiting as long as Retry-After asks", async () => {
  const { result, calls, sleeps } = await run([{ status: 429, headers: { "Retry-After": "3" }, body: { error: { message: "slow down" } } }, OK]);

  expect(result).toMatchObject({ status: "ok", httpTries: 2, costMicros: 50_000 });
  expect(calls).toHaveLength(2);
  expect(sleeps).toHaveLength(1);
  expect(sleeps[0]).toBeGreaterThanOrEqual(3_000);
  expect(withoutAt(money.lines())).toEqual([
    expect.objectContaining({ type: "reserve", attemptId: "slot-1#1" }),
    { type: "settle", attemptId: "slot-1#1", costMicros: 50_000, estimated: false },
  ]);
});

test("sends the same request body on a transport retry", async () => {
  const { calls } = await run([{ status: 503 }, OK]);

  expect(calls[1]?.body).toBe(calls[0]?.body ?? "");
});

test("settles zero after a 502 survives both transport retries", async () => {
  const { result, calls, sleeps } = await run([{ status: 502 }, { status: 502 }, { status: 502 }]);

  expect(calls).toHaveLength(3);
  expect(sleeps).toHaveLength(2);
  expect(result).toMatchObject({ status: "error", kind: "HTTP_ERROR", httpStatus: 502, fatal: false, ledger: { action: "settled", costMicros: 0, estimated: false } });
  expect(withoutAt(money.lines()).slice(1)).toEqual([{ type: "settle", attemptId: "slot-1#1", costMicros: 0, estimated: false }]);
});

test.each([429, 500, 502, 503, 504])("retries HTTP %i", async (status) => {
  const { result, calls } = await run([{ status }, OK]);

  expect(calls).toHaveLength(2);
  expect(result.status).toBe("ok");
});

test("backs off exponentially with jitter when there is no Retry-After", async () => {
  const { sleeps } = await run([{ status: 503 }, { status: 503 }, OK], { random: () => 0.5 });

  expect(sleeps).toEqual([1_500, 2_500]);
});

test("reads a Retry-After given as an HTTP date", async () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const { sleeps } = await run([{ status: 429, headers: { "Retry-After": new Date(now + 7_000).toUTCString() } }, OK], { clock: () => now });

  expect(sleeps).toEqual([7_000]);
});

test("does not wait out a Retry-After above the cap: rate limited, settled zero, with the hint", async () => {
  const { result, calls, sleeps } = await run([{ status: 429, headers: { "Retry-After": "3600" } }]);

  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
  expect(result).toMatchObject({ status: "error", kind: "RATE_LIMITED", httpStatus: 429, retryAfterMs: 3_600_000, ledger: { action: "settled", costMicros: 0 } });
});

test("reports RATE_LIMITED when 429 outlasts the transport retries", async () => {
  const { result, calls } = await run([{ status: 429 }, { status: 429 }, { status: 429 }]);

  expect(calls).toHaveLength(3);
  expect(result).toMatchObject({ status: "error", kind: "RATE_LIMITED", fatal: false, ledger: { action: "settled", costMicros: 0 } });
});

// ---------- final non-2xx ----------

test("returns a moderation 400 as a refusal, settled zero, never retried", async () => {
  const { result, calls, sleeps } = await run([{ status: 400, body: MODERATION }]);

  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
  expect(result).toMatchObject({ status: "refused", httpStatus: 400, ledger: { action: "settled", costMicros: 0, estimated: false } });
  expect(result.status === "refused" && result.message).toContain("content moderation");
});

test.each([
  { status: 403, body: { error: { code: 403, message: "Your chosen model requires moderation and your input was flagged", metadata: { reasons: ["sexual"] } } } },
  { status: 422, body: { error: { message: "The request failed because the input image may contain sensitive content" } } },
])("returns a moderation $status as a refusal", async ({ status, body }) => {
  const { result, calls } = await run([{ status, body }]);

  expect(calls).toHaveLength(1);
  expect(result).toMatchObject({ status: "refused", httpStatus: status });
});

test.each(["xAI blocked this request through content moderation.", "Seedream blocked this request through content moderation."])(
  "returns the spike's exact moderation message %p as a refusal",
  async (message) => {
    const { result } = await run([{ status: 400, body: { error: { code: 400, message, metadata: { provider_name: "xAI" } } } }]);

    expect(result).toMatchObject({ status: "refused", httpStatus: 400 });
  }
);

test("returns a 400 whose metadata.raw carries a provider's sensitive-content code as a refusal", async () => {
  const raw = JSON.stringify({ error: { code: "InputImageSensitiveContentDetected", message: "The request failed." } });

  const { result } = await run([{ status: 400, body: { error: { message: "Provider returned error", metadata: { raw, provider_name: "Seedream" } } } }]);

  expect(result).toMatchObject({ status: "refused", httpStatus: 400 });
});

test.each([
  { name: "a case-sensitivity hint", body: { error: { message: "model id is case-sensitive" } } },
  { name: "an unknown safety parameter", body: { error: { message: "Unknown parameter: safety_tolerance" } } },
  { name: "a prompt echo that mentions safety", body: { error: { message: "prompt too long: 'a worker in a safety vest …'" } } },
  { name: "moderation words only in metadata", body: { error: { message: "Invalid request", metadata: { hint: "content moderation settings", flagged: false } } } },
])("does not mistake $name for a moderation refusal", async ({ body }) => {
  const { result } = await run([{ status: 400, body }]);

  expect(result).toMatchObject({ status: "error", kind: "HTTP_ERROR", httpStatus: 400 });
});

test("clamps an absurd Retry-After: no wait, RATE_LIMITED, the hint capped at 24 hours", async () => {
  const { result, sleeps } = await run([{ status: 429, headers: { "Retry-After": "1e20" } }]);

  expect(sleeps).toEqual([]);
  expect(result).toMatchObject({ status: "error", kind: "RATE_LIMITED", retryAfterMs: 86_400_000 });
});

test("reports a 400 that is not a moderation refusal as HTTP_ERROR, never retried", async () => {
  const { result, calls } = await run([{ status: 400, body: { error: { message: "aspect_ratio must be one of 1:1, 3:4, 9:16" } } }]);

  expect(calls).toHaveLength(1);
  expect(result).toMatchObject({ status: "error", kind: "HTTP_ERROR", httpStatus: 400, fatal: false, ledger: { action: "settled", costMicros: 0 } });
  expect(result.status === "error" && result.message).toContain("aspect_ratio must be one of");
});

test("stops on 401 with a fatal AUTH_INVALID, never retried, settled zero", async () => {
  const { result, calls } = await run([{ status: 401, body: { error: { message: "User not found." } } }]);

  expect(calls).toHaveLength(1);
  expect(result).toMatchObject({ status: "error", kind: "AUTH_INVALID", httpStatus: 401, fatal: true, ledger: { action: "settled", costMicros: 0 } });
});

test("stops on 402 with a fatal INSUFFICIENT_CREDITS, never retried, settled zero", async () => {
  const { result, calls } = await run([{ status: 402, body: { error: { message: "Insufficient credits" } } }]);

  expect(calls).toHaveLength(1);
  expect(result).toMatchObject({ status: "error", kind: "INSUFFICIENT_CREDITS", httpStatus: 402, fatal: true, ledger: { action: "settled", costMicros: 0 } });
});

test("keeps a non-2xx error message to 500 characters", async () => {
  const { result } = await run([{ status: 400, body: { error: { message: `bad request ${"x".repeat(2_000)}` } } }]);

  const message = result.status === "error" ? result.message : "";
  expect(message).toContain("bad request xxx");
  expect(message.length).toBeLessThanOrEqual(500);
});

test("the worst case reserved once covers every transport retry", async () => {
  const { calls } = await run([{ status: 503 }, { status: 503 }, OK]);

  expect(calls).toHaveLength(3);
  expect(money.lines().filter((l) => l.type === "reserve")).toEqual([expect.objectContaining({ worstMicros: WORST_ONE_REF })]);
});
