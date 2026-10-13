import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch, makeClient, TEST_KEY, type Harness, type Step } from "./testing/fakes";
import { FIXTURE_ID } from "./testing/videoFixtures";
import type { OpenRouterFetch, VideoRequest } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Invariant 10 for the video calls: the key never reaches a result, a log line or a thrown error.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-video-redaction-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ECHO = `Invalid request, headers were {"Authorization":"Bearer ${TEST_KEY}"}`;
/** The unique tail of the key: a cut that keeps only a fragment of it must be caught too. */
const KEY_TAIL = TEST_KEY.slice(-16);
const REQUEST: VideoRequest = {
  model: "kwaivgi/kling-v3.0-std",
  prompt: "She turns her head slowly.",
  duration: 5,
  resolution: "720p",
  aspect_ratio: "9:16",
  generate_audio: false,
  frame_images: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" }, frame_type: "first_frame" }],
};

type Call = "submit" | "poll" | "download" | "generation";

interface Scenario {
  name: string;
  call: Call;
  steps: Step[];
  fetch?: OpenRouterFetch;
}

const BODY_THROWS: OpenRouterFetch = async () => ({
  status: 200,
  headers: { get: () => null },
  body: {
    getReader: () => ({
      read: async () => {
        throw new Error(`socket closed while sending ${ECHO}`);
      },
      cancel: async () => {},
    }),
  },
});

const SCENARIOS: Scenario[] = [
  { name: "a submit 400 that echoes the header", call: "submit", steps: [{ status: 400, body: { error: { message: ECHO } } }] },
  { name: "a submit moderation refusal that echoes it", call: "submit", steps: [{ status: 403, body: { error: { message: `flagged: ${ECHO}` } } }] },
  { name: "a submit 503 that echoes it", call: "submit", steps: [{ status: 503, body: ECHO }] },
  { name: "a submit network error that mentions it", call: "submit", steps: [{ reject: new TypeError(`fetch failed: ${ECHO}`) }] },
  { name: "a submit 2xx whose body echoes it instead of an id", call: "submit", steps: [{ status: 202, body: ECHO }] },
  { name: "a submit 401 whose message holds a key at the 500-character cut", call: "submit", steps: [{ status: 401, body: { error: { message: `${"x".repeat(470)}${TEST_KEY}` } } }] },
  { name: "a poll of a failed job whose error text echoes it", call: "poll", steps: [{ status: 200, body: { id: FIXTURE_ID, status: "failed", error: ECHO } }] },
  { name: "a poll whose status word is the key", call: "poll", steps: [{ status: 200, body: { id: FIXTURE_ID, status: TEST_KEY } }] },
  { name: "a poll 503 that echoes it", call: "poll", steps: [{ status: 503, body: { error: { message: ECHO } } }] },
  { name: "a poll network error that mentions it", call: "poll", steps: [{ reject: new TypeError(`fetch failed: ${ECHO}`) }] },
  { name: "a poll body that is not a status and echoes it", call: "poll", steps: [{ status: 200, body: ECHO }] },
  { name: "a download 401 that echoes it", call: "download", steps: [{ status: 401, body: { error: { message: ECHO } } }] },
  { name: "a download 503 that echoes it", call: "download", steps: [{ status: 503, body: ECHO }] },
  { name: "a download network error that mentions it", call: "download", steps: [{ reject: new TypeError(`fetch failed: ${ECHO}`) }] },
  { name: "a download body that breaks with it in the error", call: "download", steps: [], fetch: BODY_THROWS },
  { name: "a download redirect to a host that carries it", call: "download", steps: [{ status: 302, body: "", headers: { location: `https://${TEST_KEY}.evil.example/clip.mp4` } }] },
  { name: "a generation whose finish_reason holds it", call: "generation", steps: [{ status: 200, body: { data: { total_cost: 0.1, finish_reason: ECHO } } }] },
  { name: "a generation 401 that echoes it", call: "generation", steps: [{ status: 401, body: { error: { message: ECHO } } }] },
  { name: "a generation body that is not a record and echoes it", call: "generation", steps: [{ status: 200, body: ECHO }] },
  { name: "a generation network error that mentions it", call: "generation", steps: [{ reject: new TypeError(`fetch failed: ${ECHO}`) }] },
];

/** Everything the client let out: results, log lines, thrown errors. */
function captured(harness: Harness, results: unknown[], thrown: unknown[]): string {
  return [
    ...results.map((r) => JSON.stringify(r)),
    ...harness.logs,
    ...harness.raws.map((r) => r.text),
    ...thrown.map((e) => (e instanceof Error ? `${e.name} ${e.message} ${e.stack ?? ""}` : String(e))),
  ].join("\n");
}

test.each(SCENARIOS)("keeps the key out of every output for $name", async ({ call, steps, fetch: custom }) => {
  const harness = makeClient(custom ?? fakeFetch(steps).fetch);
  const results: unknown[] = [];
  const thrown: unknown[] = [];

  try {
    const signal = new AbortController().signal;
    if (call === "submit") results.push(await harness.client.submitVideo(REQUEST, signal));
    else if (call === "poll") results.push(await harness.client.pollVideo(FIXTURE_ID));
    else if (call === "download") results.push(await harness.client.downloadVideo(FIXTURE_ID, join(dir, "clip.tmp"), 1_000, signal));
    else results.push(await harness.client.fetchGeneration(FIXTURE_ID));
  } catch (err) {
    thrown.push(err);
  }

  const out = captured(harness, results, thrown);
  expect(out.length).toBeGreaterThan(0);
  expect(out).not.toContain(TEST_KEY);
  expect(out).not.toContain(KEY_TAIL);
  expect(out).not.toMatch(/sk-or-[A-Za-z0-9_-]{8,}/);
});

test("never writes the request body, the prompt or the frame into a log line", async () => {
  const harness = makeClient(fakeFetch([{ status: 503, body: "x" }]).fetch);

  await harness.client.submitVideo(REQUEST, new AbortController().signal);

  const out = harness.logs.join("\n");
  expect(out).not.toContain(REQUEST.prompt);
  expect(out).not.toContain("base64");
});

test("sends the key only in the Authorization header, never in a URL or a body", async () => {
  const { fetch, calls } = fakeFetch([
    { status: 202, body: { id: FIXTURE_ID } },
    { status: 200, body: { id: FIXTURE_ID, status: "pending" } },
    { status: 404, body: { error: { code: 404, message: "not found" } } },
  ]);
  const { client } = makeClient(fetch);

  await client.submitVideo(REQUEST, new AbortController().signal);
  await client.pollVideo(FIXTURE_ID);
  await client.fetchGeneration(FIXTURE_ID);

  for (const call of calls) {
    expect(call.url).not.toContain(TEST_KEY);
    expect(call.body ?? "").not.toContain(TEST_KEY);
    expect(call.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
  }
});
