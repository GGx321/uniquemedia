import { expect, test } from "bun:test";
import { fakeFetch, LOCAL_BASE, makeClient, TEST_KEY, type Step } from "./testing/fakes";
import { fixture, FIXTURE_ID } from "./testing/videoFixtures";
import { isContentFailure } from "./video";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

function poll(steps: Step[]) {
  const { fetch, calls } = fakeFetch(steps);
  const harness = makeClient(fetch);
  return { ...harness, calls, run: () => harness.client.pollVideo(FIXTURE_ID) };
}

const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";
const MODERATION = "Generated video rejected by content moderation.";

test("GETs /videos/<id> with the key as a bearer token", async () => {
  const { run, calls } = poll([{ status: 200, body: fixture("poll-pending") }]);

  await run();

  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/videos/${FIXTURE_ID}`);
  expect(calls[0]?.method).toBe("GET");
  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(calls[0]?.redirect).toBe("error");
});

test("reads a pending job", async () => {
  const { run } = poll([{ status: 200, body: fixture("poll-pending") }]);

  expect(await run()).toEqual({ kind: "status", status: "pending", rawStatus: "pending", usageCostMicros: null, error: null, contentFailure: false });
});

test.each([
  ["queued", "pending"],
  ["pending", "pending"],
  ["processing", "in_progress"],
  ["in_progress", "in_progress"],
  ["cancelled", "cancelled"],
  ["expired", "expired"],
])("reads the word %s as %s", async (word, status) => {
  const { run } = poll([{ status: 200, body: { id: FIXTURE_ID, status: word } }]);

  expect(await run()).toMatchObject({ kind: "status", status, rawStatus: word });
});

test("reads a completed job with its own bill in micro-dollars", async () => {
  const { run } = poll([{ status: 200, body: fixture("poll-completed") }]);

  expect(await run()).toEqual({ kind: "status", status: "completed", rawStatus: "completed", usageCostMicros: 420_000, error: null, contentFailure: false });
});

test("reads a completed job that comes without usage, with no bill", async () => {
  const { usage: _usage, ...withoutUsage } = fixture("poll-completed");
  const { run } = poll([{ status: 200, body: withoutUsage }]);

  expect(await run()).toMatchObject({ kind: "status", status: "completed", usageCostMicros: null });
});

test.each([
  ["a negative cost", { cost: -1 }],
  ["a string cost", { cost: "0.42" }],
  ["a cost too large for micros", { cost: 1e300 }],
  ["usage that is not an object", "0.42"],
])("reads a completed job with %s as one with no bill", async (_name, usage) => {
  const { run } = poll([{ status: 200, body: { id: FIXTURE_ID, status: "completed", usage } }]);

  expect(await run()).toMatchObject({ kind: "status", status: "completed", usageCostMicros: null });
});

test("reads a failed job with its moderation text as a content failure", async () => {
  const { run } = poll([{ status: 200, body: fixture("poll-failed-moderation") }]);

  expect(await run()).toEqual({ kind: "status", status: "failed", rawStatus: "failed", usageCostMicros: null, error: MODERATION, contentFailure: true });
});

test("reads Kling's risk-control refusal as a content failure", async () => {
  const { run } = poll([{ status: 200, body: fixture("poll-failed-risk-control") }]);

  expect(await run()).toMatchObject({ kind: "status", status: "failed", error: RISK_CONTROL, contentFailure: true });
});

test("reads a failed job with a provider timeout text as a failure that is not a content failure", async () => {
  const { run } = poll([{ status: 200, body: { id: FIXTURE_ID, status: "failed", error: "Provider timed out after 600 seconds" } }]);

  expect(await run()).toMatchObject({ kind: "status", status: "failed", error: "Provider timed out after 600 seconds", contentFailure: false });
});

test("reads a failed job whose error is an object with a message", async () => {
  const { run } = poll([{ status: 200, body: { id: FIXTURE_ID, status: "failed", error: { message: MODERATION } } }]);

  expect(await run()).toMatchObject({ status: "failed", error: MODERATION, contentFailure: true });
});

test("reads a failed job with no error text", async () => {
  const { run } = poll([{ status: 200, body: { id: FIXTURE_ID, status: "failed" } }]);

  expect(await run()).toMatchObject({ status: "failed", error: null, contentFailure: false });
});

test("keeps polling on a status word it does not know", async () => {
  const { run } = poll([{ status: 200, body: { id: FIXTURE_ID, status: "rendering_v2" } }]);

  expect(await run()).toMatchObject({ kind: "status", status: "unknown", rawStatus: "rendering_v2" });
});

test("answers unreadable on a 5xx, to be polled again", async () => {
  const { run } = poll([{ status: 503, body: { error: { message: "unavailable" } } }]);

  expect(await run()).toMatchObject({ kind: "unreadable", cause: "http", httpStatus: 503 });
});

test("answers unreadable with cause auth on a 401", async () => {
  const { run } = poll([{ status: 401, body: { error: { message: "no auth" } } }]);

  expect(await run()).toMatchObject({ kind: "unreadable", cause: "auth", httpStatus: 401 });
});

test("answers unreadable when fetch fails", async () => {
  const { run } = poll([{ reject: new TypeError("fetch failed") }]);

  expect(await run()).toMatchObject({ kind: "unreadable", cause: "network" });
});

test.each([
  ["a body that is not JSON", "<html>"],
  ["a body without a status", { id: FIXTURE_ID }],
  ["a numeric status", { id: FIXTURE_ID, status: 3 }],
])("answers unreadable on a 200 with %s", async (_name, body) => {
  const { run } = poll([{ status: 200, body }]);

  expect(await run()).toMatchObject({ kind: "unreadable", cause: "malformed", httpStatus: 200 });
});

test("sends nothing for an id that is not a job id", async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: fixture("poll-pending") }]);
  const { client } = makeClient(fetch);

  const result = await client.pollVideo("../credits");

  expect(calls).toHaveLength(0);
  expect(result).toMatchObject({ kind: "unreadable", cause: "malformed", httpStatus: null });
});

test("asks once per poll and never retries", async () => {
  const { run, calls } = poll([{ status: 503, body: "x" }, { status: 200, body: fixture("poll-pending") }]);

  await run();

  expect(calls).toHaveLength(1);
});

// ---------- the content matcher ----------

test("counts Kling's risk-control text as a content failure", () => {
  expect(isContentFailure(RISK_CONTROL, null)).toBe(true);
});

test("counts Grok's moderation text as a content failure", () => {
  expect(isContentFailure(MODERATION, null)).toBe(true);
});

test("counts a content_filter finish reason as a content failure even with no text", () => {
  expect(isContentFailure(null, "content_filter")).toBe(true);
});

test("does not count a provider timeout text", () => {
  expect(isContentFailure("Provider timed out after 600 seconds", null)).toBe(false);
});

test("does not count no text and an ordinary finish reason", () => {
  expect(isContentFailure(null, "complete")).toBe(false);
  expect(isContentFailure(null, null)).toBe(false);
});

test("does not count a prompt echo that merely contains the word moderation in a long unrelated text", () => {
  expect(isContentFailure("internal error while writing the result", null)).toBe(false);
});
