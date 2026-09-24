import { afterEach, beforeEach, expect, test } from "bun:test";
import { chatParams, fakeFetch, imageParams, makeClient, setupMoney, TEST_KEY, type Harness, type Money, type Step } from "./testing/fakes";
import type { OpenRouterClientOptions } from "./types";

// Invariant 10: the key never reaches logs, error messages or saved files.

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

const ECHO = `Invalid request, headers were {"Authorization":"Bearer ${TEST_KEY}"}`;

/** Everything the client let out: results, log lines, saved raw bodies, thrown errors. */
function captured(harness: Harness, results: unknown[], thrown: unknown[]): string {
  return [
    ...results.map((r) => JSON.stringify(r)),
    ...harness.logs,
    ...harness.raws.map((r) => r.text),
    ...thrown.map((e) => (e instanceof Error ? `${e.name} ${e.message} ${e.stack ?? ""}` : String(e))),
  ].join("\n");
}

const SCENARIOS: { name: string; steps: Step[]; call: "image" | "chat" | "credits"; overrides?: Partial<OpenRouterClientOptions> }[] = [
  { name: "a 400 body that echoes the header", steps: [{ status: 400, body: { error: { message: ECHO } } }], call: "image" },
  { name: "a moderation refusal that echoes it", steps: [{ status: 403, body: { error: { message: `flagged: ${ECHO}` } } }], call: "image" },
  { name: "retried 503s that echo it (log lines)", steps: [{ status: 503, body: ECHO }, { status: 503, body: ECHO }, { status: 503, body: ECHO }], call: "image" },
  { name: "a network error that mentions it", steps: [{ reject: new TypeError(`fetch failed: ${ECHO}`) }], call: "image" },
  { name: "an unusable 2xx whose raw body contains it", steps: [{ status: 200, body: ECHO }], call: "image" },
  {
    name: "a raw-body save that fails with it in the error",
    steps: [{ status: 200, body: "not json" }],
    call: "image",
    overrides: {
      saveRaw: async () => {
        throw new Error(`cannot write ${ECHO}`);
      },
    },
  },
  { name: "an unusable chat 2xx that contains it", steps: [{ status: 200, body: { choices: [], note: ECHO } }], call: "chat" },
  { name: "a /credits 401 that echoes it", steps: [{ status: 401, body: { error: { message: ECHO } } }], call: "credits" },
];

test.each(SCENARIOS)("keeps the key out of every output for $name", async ({ steps, call, overrides }) => {
  const { fetch } = fakeFetch(steps);
  const harness = makeClient(fetch, overrides);
  const results: unknown[] = [];
  const thrown: unknown[] = [];

  try {
    if (call === "image") results.push(await harness.client.generateImage(imageParams(money)));
    else if (call === "chat") results.push(await harness.client.chat(chatParams(money)));
    else results.push(await harness.client.fetchCredits());
  } catch (err) {
    thrown.push(err);
  }

  const output = captured(harness, results, thrown);
  expect(output).toContain("[redacted]");
  expect(output).not.toContain(TEST_KEY);
});

test("redacts before truncating, so no prefix of the key survives the 500-character cut", async () => {
  const { fetch } = fakeFetch([{ status: 400, body: { error: { message: `${"x".repeat(470)} ${TEST_KEY}` } } }]);
  const { client } = makeClient(fetch);

  const result = await client.generateImage(imageParams(money));

  expect(result.status === "error" && result.message).not.toContain(TEST_KEY.slice(0, 12));
});

test("redacts a key that straddles the cut of an over-cap raw body, leaving no fragment", async () => {
  const key = "customKEY0123456789abcdefSECRET"; // not key-shaped: only the exact match can catch it
  const body = `${"A".repeat(1_014)}${key}${"B".repeat(4_000)}`;
  const { fetch } = fakeFetch([{ status: 200, body, chunkBytes: 256 }]);
  const { client, raws } = makeClient(fetch, { apiKey: key, maxBodyBytes: 1_024 });

  await client.generateImage(imageParams(money));

  expect(raws[0]?.text).toContain("[redacted]");
  expect(raws[0]?.text).not.toContain(key.slice(0, 6));
});

test("redacts other strings shaped like OpenRouter keys (a rotated-out key)", async () => {
  const oldKey = "sk-or-v1-0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld";
  const { fetch } = fakeFetch([{ status: 400, body: { error: { message: `key ${oldKey} was revoked` } } }]);
  const { client } = makeClient(fetch);

  const result = await client.generateImage(imageParams(money));

  expect(result.status === "error" && result.message).not.toContain(oldKey);
});
