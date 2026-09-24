import { afterEach, beforeEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
];

test.each(UNUSABLE)("saves the raw body, settles at the worst case and returns a fatal error for $name", async ({ body }) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const { result, raws } = await generate({ status: 200, body });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, httpStatus: 200, rawSaved: true });
  expect(result.status === "error" && result.ledger).toEqual({ action: "settled", costMicros: WORST_ONE_REF, estimated: true });
  expect(raws).toEqual([{ attemptId: "slot-1#1", text }]);
  expect(money.lines()[1]).toMatchObject({ type: "settle", costMicros: WORST_ONE_REF, estimated: true });
});

// ---------- no image data in a saved body ----------

/** A GIF: a real image the client does not accept, so its 2xx is unusable and saved. */
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x02, 0x00, 0x80, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x21, 0xf9, 0x04]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

test.each([
  { name: "an image in a format the client does not accept", value: b64(GIF), bytes: GIF },
  { name: "a data URL", value: `data:image/gif;base64,${b64(GIF)}`, bytes: GIF },
  { name: "an empty b64_json", value: "", bytes: new Uint8Array() },
])("an unusable 2xx is saved without its image data, $name: only its length, sha256 and first bytes", async ({ value, bytes }) => {
  const body = { data: [{ b64_json: value, media_type: "image/gif" }], usage: { cost: 0.04 } };
  const { result, raws } = await generate({ status: 200, body });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, rawSaved: true });
  const saved = JSON.parse(raws[0]?.text ?? "null");
  expect(saved).toEqual({
    data: [{ b64_json: { omitted: "image data", chars: value.length, sha256: sha256Hex(bytes), head: hex(bytes.subarray(0, 16)) }, media_type: "image/gif" }],
    usage: { cost: 0.04 },
  });
  if (value !== "") expect(raws[0]?.text).not.toContain(b64(GIF).slice(0, 12));
});

test("a b64_json that is not base64 is omitted too: it may still be most of an image", async () => {
  const { raws } = await generate({ status: 200, body: { data: [{ b64_json: "%%% not base64 %%%" }] } });

  expect(JSON.parse(raws[0]?.text ?? "null")).toMatchObject({ data: [{ b64_json: { omitted: "image data", chars: 18 } }] });
  expect(raws[0]?.text).not.toContain("not base64");
});

test("an image as a data URL in any other field of an unusable 2xx is omitted too", async () => {
  const body = { data: [{ url: `data:image/png;base64,${b64(PNG)}` }] };
  const { raws } = await generate({ status: 200, body });

  expect(raws[0]?.text).not.toContain(b64(PNG).slice(0, 12));
  expect(raws[0]?.text).toContain(`image data omitted: ${b64(PNG).length} chars, sha256 ${sha256Hex(PNG)}`);
});

/** An image's worth of base64: long enough that a fragment of it identifies it. */
const PORTRAIT_B64 = b64(Uint8Array.from({ length: 900 }, (_, i) => (i * 37 + 11) % 256));

test.each([
  { name: "under a renamed key (image_base64)", body: JSON.stringify({ data: [{ image_base64: PORTRAIT_B64 }], usage: { cost: 0.04 } }) },
  { name: "under data[0].b64, next to a url", body: JSON.stringify({ data: [{ b64: PORTRAIT_B64, url: "https://example.com/a" }], usage: { cost: 0.04 } }) },
  { name: "under an escaped b64\\u005fjson key in a body that is not JSON", body: `{"data":[{"b64\\u005fjson":"${PORTRAIT_B64}"}], "usage":{"cost":0.04}` },
  { name: "in a b64_json split by a literal newline (not JSON)", body: `{"data":[{"b64_json":"${PORTRAIT_B64.slice(0, 76)}\n${PORTRAIT_B64.slice(76)}"}]}` },
  { name: "in a b64_json split by escaped newlines", body: `{"data":[{"b64_json":"${PORTRAIT_B64.slice(0, 300)}\\n${PORTRAIT_B64.slice(300)}"}],"usage":{"cost":0.04},"x":` },
  { name: "in a whole b64_json of a body cut short", body: `{"data":[{"b64_json":"${PORTRAIT_B64}"}` },
])("an unusable 2xx keeps no image data $name", async ({ body }) => {
  const { result, raws } = await generate({ status: 200, body });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", rawSaved: true });
  for (const at of [0, 300, 600, 1_000]) expect(raws[0]?.text).not.toContain(PORTRAIT_B64.slice(at, at + 40));
  // "image data" where the key says so, "long string" where it does not.
  expect(raws[0]?.text).toContain("omitted");
});

// Round 3 (R2): base64 wrapped in short lines (MIME: 76 chars, PEM: 64) has no long run.

function wrapped(text: string, width: number, separator: string): string {
  return (text.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join(separator);
}

/** The text with every kind of line break and space taken out, so a wrapped fragment is found again. */
function flattened(text: string): string {
  return text.replace(/\\[nr]|\r?\n| /g, "");
}

const PORTRAIT_HEX = Buffer.from(Uint8Array.from({ length: 900 }, (_, i) => (i * 37 + 11) % 256)).toString("hex");

test.each([
  { name: "image_base64 with a literal line break every 76 (not JSON)", body: `{"data":[{"image_base64":"${wrapped(PORTRAIT_B64, 76, "\n")}"}]}` },
  { name: "image_base64 with an escaped line break every 76", body: `{"data":[{"image_base64":"${wrapped(PORTRAIT_B64, 76, "\\n")}"}]}` },
  { name: "b64_json with a literal line break every 76 (not JSON)", body: `{"data":[{"b64_json":"${wrapped(PORTRAIT_B64, 76, "\n")}"}]}` },
  { name: "image_base64 with an escaped CRLF every 64 (PEM)", body: `{"data":[{"image_base64":"${wrapped(PORTRAIT_B64, 64, "\\r\\n")}"}]}` },
  { name: "image_base64 with a space every 76", body: `{"data":[{"image_base64":"${wrapped(PORTRAIT_B64, 76, " ")}"}]}` },
])("an unusable 2xx keeps no recoverable image when its base64 is wrapped: $name", async ({ body }) => {
  const { result, raws } = await generate({ status: 200, body });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", rawSaved: true });
  for (const at of [300, 600, 1_000]) expect(flattened(raws[0]?.text ?? "")).not.toContain(PORTRAIT_B64.slice(at, at + 60));
});

test("an unusable 2xx keeps no image written as hex", async () => {
  const { raws } = await generate({ status: 200, body: { data: [{ image_hex: PORTRAIT_HEX }] } });

  expect(raws[0]?.text).not.toContain(PORTRAIT_HEX.slice(600, 700));
});

test("a JSON body keeps its shape; every string longer than 256 chars becomes its length and sha256, the short ones stay", async () => {
  const note = "x".repeat(300);
  const body = { data: [{ note, id: "gen-123" }], error: "an image was expected" };
  const { raws } = await generate({ status: 200, body });

  expect(JSON.parse(raws[0]?.text ?? "null")).toEqual({
    data: [{ note: { omitted: "long string", chars: 300, sha256: createHash("sha256").update(note).digest("hex") }, id: "gen-123" }],
    error: "an image was expected",
  });
});

test("a body that is not JSON keeps only its first 256 chars, its length and its sha256", async () => {
  const body = `not json: ${"word ".repeat(200)}`;
  const { raws } = await generate({ status: 200, body });

  const text = raws[0]?.text ?? "";
  expect(text.startsWith(body.slice(0, 256))).toBe(true);
  expect(text).not.toContain(body.slice(0, 300));
  expect(text).toContain(`[not JSON: ${body.length} chars, sha256 ${createHash("sha256").update(body).digest("hex")}; only the first 256 are kept]`);
});

test("text that is not base64 stays, and a run just under 128 characters is kept", async () => {
  const shortRun = "A".repeat(127);
  const body = { error_note: "the provider said: something went wrong, try again later", data: [{ id: shortRun }] };
  const { raws } = await generate({ status: 200, body });

  expect(raws[0]?.text).toContain("the provider said: something went wrong, try again later");
  expect(raws[0]?.text).toContain(shortRun);
});

test("a run of exactly 128 base64 characters is omitted", async () => {
  const { raws } = await generate({ status: 200, body: { data: [{ id: "A".repeat(128) }] } });

  expect(raws[0]?.text).not.toContain("A".repeat(128));
  expect(raws[0]?.text).toContain("image data omitted: 128 chars");
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

test("treats a 2xx over the cap as unusable: saves its start with a note, its cut image data omitted, and settles at the worst case", async () => {
  const { result, raws } = await capped({ status: 200, body: BIG_BODY });

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, rawSaved: true, ledger: { action: "settled", costMicros: WORST_ONE_REF, estimated: true } });
  expect(raws[0]?.text.startsWith('{"data":[{"b64_json":{"omitted":"image data","chars":')).toBe(true);
  expect(raws[0]?.text).toContain('"truncated":true');
  expect(raws[0]?.text).toContain("[truncated: the body exceeded");
  expect(raws[0]?.text).not.toContain(b64(PNG).slice(0, 12));
  expect(raws[0]?.text).not.toContain("AAAA");
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
