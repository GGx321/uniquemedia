import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  b64,
  fakeFetch,
  imageBody,
  imageParams,
  JPEG,
  makeClient,
  PNG,
  readLedgerLines,
  setupMoney,
  WEBP,
  withoutAt,
  WORST_ONE_REF,
  type Money,
} from "./testing/fakes";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

const RESERVE = { type: "reserve", attemptId: "slot-1#1", jobId: "job-1", scope: { avatarJobId: "avjob-1" }, model: "x-ai/grok-imagine-image-2.0", worstMicros: WORST_ONE_REF };

async function generate(reply: { status: number; body?: string | object }) {
  const { fetch } = fakeFetch([reply]);
  const harness = makeClient(fetch);
  const result = await harness.client.generateImage(imageParams(money));
  return { result, ...harness };
}

// ---------- usable 2xx ----------

test("returns the image bytes and settles a 2xx at its usage.cost", async () => {
  const { result } = await generate({ status: 200, body: imageBody(PNG, { cost: 0.04 }) });

  expect(result).toMatchObject({ status: "ok", mediaType: "image/png", costMicros: 40_000, estimated: false, httpTries: 1, aboveWorst: false });
  expect(result.status === "ok" && [...result.bytes]).toEqual([...PNG]);
  expect(withoutAt(money.lines())).toEqual([RESERVE, { type: "settle", attemptId: "slot-1#1", costMicros: 40_000, estimated: false }]);
});

test("settles a 2xx without usage.cost at the worst case, marked estimated", async () => {
  const { result } = await generate({ status: 200, body: imageBody(PNG) });

  expect(result).toMatchObject({ status: "ok", costMicros: WORST_ONE_REF, estimated: true });
  expect(money.lines()[1]).toMatchObject({ type: "settle", costMicros: WORST_ONE_REF, estimated: true });
});

test("settles a 2xx whose usage.cost is null at the worst case, marked estimated", async () => {
  const { result } = await generate({ status: 200, body: imageBody(PNG, { cost: null }) });

  expect(result).toMatchObject({ status: "ok", costMicros: WORST_ONE_REF, estimated: true });
});

test("accepts a null media_type and takes the type from the bytes", async () => {
  const { result } = await generate({ status: 200, body: imageBody(JPEG, { cost: 0.05, mediaType: null }) });

  expect(result).toMatchObject({ status: "ok", mediaType: "image/jpeg" });
});

test("trusts the bytes over a media_type field that disagrees", async () => {
  const { result } = await generate({ status: 200, body: imageBody(JPEG, { cost: 0.05, mediaType: "image/png" }) });

  expect(result).toMatchObject({ status: "ok", mediaType: "image/jpeg" });
});

test("recognises WebP bytes", async () => {
  const { result } = await generate({ status: 200, body: imageBody(WEBP, { cost: 0.05 }) });

  expect(result).toMatchObject({ status: "ok", mediaType: "image/webp" });
});

test("accepts a b64_json that carries a data URL prefix", async () => {
  const { result } = await generate({ status: 200, body: { data: [{ b64_json: `data:image/png;base64,${b64(PNG)}` }], usage: { cost: 0.05 } } });

  expect(result).toMatchObject({ status: "ok", mediaType: "image/png" });
});

test("needs only data[0].b64_json: unknown, null and extra fields are ignored", async () => {
  const body = {
    created: null,
    model: null,
    data: [{ b64_json: b64(PNG), revised_prompt: null, url: null }, { unexpected: true }],
    usage: { cost: 0.05, prompt_tokens: null, details: { anything: [1, 2] } },
    provider: "xAI",
  };

  const { result } = await generate({ status: 200, body });

  expect(result).toMatchObject({ status: "ok", mediaType: "image/png", costMicros: 50_000 });
});

test("reports a bill above the worst case, keeps the image, and the budget halts", async () => {
  const { result } = await generate({ status: 200, body: imageBody(PNG, { cost: 0.09 }) });

  expect(result).toMatchObject({ status: "ok", costMicros: 90_000, aboveWorst: true });
  expect(money.lines()[1]).toMatchObject({ type: "settle", costMicros: 90_000 });
  expect(money.budget.status().state).toBe("halted");
});

// ---------- unusable paid 2xx ----------

const UNUSABLE: { name: string; body: string | object }[] = [
  { name: "a body that is not JSON", body: "<html>upstream hiccup</html>" },
  { name: "a body without data", body: { usage: null } },
  { name: "an empty data array", body: { data: [] } },
  { name: "a missing b64_json", body: { data: [{ url: "https://example.com/a.png" }] } },
  { name: "an empty b64_json", body: { data: [{ b64_json: "" }] } },
  { name: "a b64_json that is not base64", body: { data: [{ b64_json: "%%% not base64 %%%" }] } },
  { name: "bytes of an unknown image type", body: { data: [{ b64_json: b64(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) }] } },
];

test.each(UNUSABLE)("saves the raw body, settles at the worst case and returns a fatal error for $name", async ({ body }) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const { result, raws } = await generate({ status: 200, body });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, httpStatus: 200, rawSaved: true });
  expect(result.status === "error" && result.ledger).toEqual({ action: "settled", costMicros: WORST_ONE_REF, estimated: true });
  expect(raws).toEqual([{ attemptId: "slot-1#1", text }]);
  expect(money.lines()[1]).toMatchObject({ type: "settle", costMicros: WORST_ONE_REF, estimated: true });
});

test("saves the raw body of an unusable 2xx before the attempt is settled", async () => {
  let linesWhenSaved: Record<string, unknown>[] = [];
  const { fetch } = fakeFetch([{ status: 200, body: "not json" }]);
  const { client } = makeClient(fetch, {
    saveRaw: async () => {
      linesWhenSaved = readLedgerLines(money.ledgerPath);
    },
  });

  await client.generateImage(imageParams(money));

  expect(linesWhenSaved.map((l) => l.type)).toEqual(["reserve"]);
  expect(money.lines().map((l) => l.type)).toEqual(["reserve", "settle"]);
});

test("settles an unusable 2xx at the usage.cost it reports (the money core's settle rule)", async () => {
  const { result } = await generate({ status: 200, body: { data: [{ b64_json: "" }], usage: { cost: 0.04 } } });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", ledger: { action: "settled", costMicros: 40_000, estimated: false } });
});

// ---------- body size cap ----------

const BIG_BODY = JSON.stringify({ data: [{ b64_json: `${b64(PNG)}${"A".repeat(4_096)}` }], usage: { cost: 0.05 } });

async function capped(reply: { status: number; body: string }) {
  const { fetch, calls } = fakeFetch([{ ...reply, chunkBytes: 256 }]);
  const harness = makeClient(fetch, { maxBodyBytes: 1_024 });
  const result = await harness.client.generateImage(imageParams(money));
  return { result, calls, ...harness };
}

test("stops reading a body at the cap and cancels the stream", async () => {
  const { calls } = await capped({ status: 200, body: BIG_BODY });

  expect(calls[0]?.response.cancelled).toBe(true);
  expect(calls[0]?.response.pulledChunks).toBeLessThanOrEqual(5);
});

test("treats a 2xx over the cap as unusable: saves its first bytes with a note and settles at the worst case", async () => {
  const { result, raws } = await capped({ status: 200, body: BIG_BODY });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, rawSaved: true, ledger: { action: "settled", costMicros: WORST_ONE_REF, estimated: true } });
  expect(raws[0]?.text.startsWith(BIG_BODY.slice(0, 1_000))).toBe(true);
  expect(raws[0]?.text).toContain("[truncated");
  expect(raws[0]?.text.length).toBeLessThan(BIG_BODY.length);
});

test("a non-2xx over the cap is still that status, settled zero", async () => {
  const { result } = await capped({ status: 400, body: JSON.stringify({ error: { message: `bad ${"x".repeat(4_096)}` } }) });

  expect(result).toMatchObject({ status: "error", kind: "HTTP_ERROR", httpStatus: 400, ledger: { action: "settled", costMicros: 0 } });
});

test("still settles an unusable 2xx when saving its raw body fails, and says so", async () => {
  const { fetch } = fakeFetch([{ status: 200, body: "not json" }]);
  const { client } = makeClient(fetch, {
    saveRaw: async () => {
      throw new Error("ENOSPC: no space left on device");
    },
  });

  const result = await client.generateImage(imageParams(money));

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, rawSaved: false });
  expect(result.status === "error" && result.message).toContain("ENOSPC");
  expect(money.lines()[1]).toMatchObject({ type: "settle", costMicros: WORST_ONE_REF, estimated: true });
});
