import { expect, test } from "bun:test";
import { fakeFetch, LOCAL_BASE, makeClient, TEST_KEY, type Step } from "./testing/fakes";
import { fixture, FIXTURE_ID } from "./testing/videoFixtures";
import type { VideoRequest } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const REQUEST: VideoRequest = {
  model: "kwaivgi/kling-v3.0-std",
  prompt: "She turns her head slowly.",
  duration: 5,
  resolution: "720p",
  aspect_ratio: "9:16",
  generate_audio: false,
  frame_images: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" }, frame_type: "first_frame" }],
};

function submit(steps: Step[], signal: AbortSignal = new AbortController().signal) {
  const { fetch, calls } = fakeFetch(steps);
  const harness = makeClient(fetch);
  return { ...harness, calls, run: () => harness.client.submitVideo(REQUEST, signal) };
}

test("POSTs the request to /videos as JSON with the key as a bearer token", async () => {
  const { run, calls } = submit([{ status: 202, body: fixture("submit-accepted") }]);

  await run();

  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/videos`);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  expect(calls[0]?.json()).toEqual({ ...REQUEST });
  expect(calls[0]?.redirect).toBe("error");
});

test("answers accepted with the job id on a 202", async () => {
  const { run } = submit([{ status: 202, body: fixture("submit-accepted") }]);

  expect(await run()).toEqual({ kind: "accepted", id: FIXTURE_ID });
});

test("answers accepted on a 200 that carries an id", async () => {
  const { run } = submit([{ status: 200, body: { id: FIXTURE_ID, status: "pending" } }]);

  expect(await run()).toEqual({ kind: "accepted", id: FIXTURE_ID });
});

test.each([
  ["400", 400],
  ["403", 403],
  ["422", 422],
])("answers refused for moderation on a %s whose message names content moderation", async (_name, status) => {
  const { run } = submit([{ status, body: { error: { message: "xAI blocked this request through content moderation." } } }]);

  expect(await run()).toMatchObject({ kind: "refused", httpStatus: status, moderation: true, errorKind: "HTTP_ERROR" });
});

test.each([400, 404, 413])("answers refused, not moderation, on a %d with a plain message", async (status) => {
  const { run } = submit([{ status, body: { error: { message: "frame image is too large" } } }]);

  expect(await run()).toMatchObject({ kind: "refused", httpStatus: status, moderation: false, errorKind: "HTTP_ERROR" });
});

test("answers refused with AUTH_INVALID on a 401", async () => {
  const { run } = submit([{ status: 401, body: { error: { message: "no auth" } } }]);

  expect(await run()).toMatchObject({ kind: "refused", httpStatus: 401, moderation: false, errorKind: "AUTH_INVALID" });
});

test("answers refused with INSUFFICIENT_CREDITS on a 402", async () => {
  const { run } = submit([{ status: 402, body: { error: { message: "out of credits" } } }]);

  expect(await run()).toMatchObject({ kind: "refused", httpStatus: 402, errorKind: "INSUFFICIENT_CREDITS" });
});

test("answers refused with RATE_LIMITED on a 429", async () => {
  const { run } = submit([{ status: 429, body: { error: { message: "slow down" } } }]);

  expect(await run()).toMatchObject({ kind: "refused", httpStatus: 429, errorKind: "RATE_LIMITED" });
});

test.each([500, 502, 503, 504])("answers uncertain on a %d, because the job may have started", async (status) => {
  const { run } = submit([{ status, body: { error: { message: "upstream" } } }]);

  expect(await run()).toMatchObject({ kind: "uncertain", cause: "server-error", httpStatus: status });
});

test("answers uncertain, not refused, on a 408", async () => {
  const { run } = submit([{ status: 408, body: { error: { message: "request timeout" } } }]);

  expect(await run()).toMatchObject({ kind: "uncertain", cause: "timeout", httpStatus: 408 });
});

test("answers uncertain when fetch fails", async () => {
  const { run } = submit([{ reject: new TypeError("fetch failed") }]);

  expect(await run()).toMatchObject({ kind: "uncertain", cause: "network", httpStatus: null });
});

test("answers uncertain when the request times out", async () => {
  const { fetch } = fakeFetch([{ hang: true }]);
  const { client } = makeClient(fetch, { timeoutMs: 5 });

  expect(await client.submitVideo(REQUEST, new AbortController().signal)).toMatchObject({ kind: "uncertain", cause: "timeout", httpStatus: null });
});

test("answers uncertain when the caller aborts after the request left", async () => {
  const abort = new AbortController();
  const { run } = submit([{ hang: true }], abort.signal);
  const pending = run();
  abort.abort();

  expect(await pending).toMatchObject({ kind: "uncertain", cause: "aborted", httpStatus: null });
});

test.each([
  ["a body that is not JSON", "<html>"],
  ["a body without an id", { status: "pending" }],
  ["a numeric id", { id: 17, status: "pending" }],
  ["an empty id", { id: "", status: "pending" }],
  ["an id that would change the URL it is put into", { id: "../credits", status: "pending" }],
])("answers uncertain, never accepted, on a 2xx with %s", async (_name, body) => {
  const { run } = submit([{ status: 202, body }]);

  expect(await run()).toMatchObject({ kind: "uncertain", cause: "unreadable-accept", httpStatus: 202 });
});

test.each([
  ["a 202", [{ status: 202, body: { id: FIXTURE_ID } }]],
  ["a 400", [{ status: 400, body: { error: { message: "bad" } } }]],
  ["a 429", [{ status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "1" } }]],
  ["a 503", [{ status: 503, body: "x" }, { status: 202, body: { id: FIXTURE_ID } }]],
  ["a network error", [{ reject: new TypeError("fetch failed") }, { status: 202, body: { id: FIXTURE_ID } }]],
] as [string, Step[]][])("sends exactly one POST after %s, never a retry", async (_name, steps) => {
  const { run, calls, sleeps } = submit(steps);

  await run();

  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
});
