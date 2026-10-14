import { afterEach, describe, expect, test } from "bun:test";
import { isModerationRefusal } from "../openrouter/transport";
import type { OpenRouterResponse } from "../openrouter/types";
import { VIDEO_TIERS } from "../money/prices";
import { clipProvider, type ClipProvider } from "./testing/clipProvider";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V7: the fake video provider of the parity rig. It answers what OpenRouter answers for a clip (the price listing, POST /videos, the poll, the file, /generation and /credits), by the
// outcome a story scripts for each attempt, and it keeps a count of the POSTs that left: the money story is «at most one POST per attempt». No network, no key that is real.

const BASE = "https://openrouter.ai/api/v1";
const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";

let provider: ClipProvider | undefined;
afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

function make(): ClipProvider {
  provider = clipProvider();
  return provider;
}

async function call(p: ClipProvider, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown; bytes: Uint8Array }> {
  const response: OpenRouterResponse = await p.fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: "Bearer sk-or-v1-fake" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: new AbortController().signal,
  });
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  for (;;) {
    const part = await reader?.read();
    if (part === undefined || part.done) break;
    if (part.value !== undefined) chunks.push(part.value);
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = null;
  }
  return { status: response.status, json, bytes };
}

const klingBody = (over: Record<string, unknown> = {}) => ({ model: VIDEO_TIERS.std.model, prompt: "she blinks", duration: 5, resolution: "720p", aspect_ratio: "9:16", frame_images: [], ...over });
const grokBody = () => klingBody({ model: VIDEO_TIERS.grok.model });

async function submit(p: ClipProvider, body: unknown = klingBody()): Promise<{ status: number; id: string | null; json: unknown }> {
  const answer = await call(p, "POST", "/videos", body);
  const id = typeof answer.json === "object" && answer.json !== null && "id" in answer.json && typeof answer.json.id === "string" ? answer.json.id : null;
  return { status: answer.status, id, json: answer.json };
}

describe("the price listing", () => {
  test("is the 2026-10-10 listing of the three models", async () => {
    const p = make();
    const answer = await call(p, "GET", "/videos/models");
    expect(answer.status).toBe(200);
    const ids = (answer.json as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toEqual([VIDEO_TIERS.std.model, VIDEO_TIERS.pro.model, VIDEO_TIERS.grok.model]);
  });

  test("can be unreadable (the dated table stands in) or lack Grok's price (PRICE_UNAVAILABLE)", async () => {
    const offline = make();
    offline.setPrices("fallback");
    await expect(call(offline, "GET", "/videos/models")).rejects.toThrow(TypeError);
    offline.setPrices("missing");
    const answer = await call(offline, "GET", "/videos/models");
    const grok = (answer.json as { data: { id: string; pricing_skus: Record<string, string> }[] }).data.find((m) => m.id === VIDEO_TIERS.grok.model);
    expect(grok?.pricing_skus).toEqual({});
  });
});

describe("a clip that completes", () => {
  test("is accepted, polls completed with the provider's bill, and serves a file; /generation has no record, in the API's exact words", async () => {
    const p = make();
    p.beginClip();
    const sent = await submit(p);
    expect(sent.status).toBe(202);
    const id = sent.id ?? "";
    const poll = await call(p, "GET", `/videos/${id}`);
    expect(poll.json).toMatchObject({ id, generation_id: id, status: "completed", usage: { cost: 0.42, is_byok: false } });
    const content = await call(p, "GET", `/videos/${id}/content?index=0`);
    expect(content.status).toBe(200);
    expect(new TextDecoder().decode(content.bytes.subarray(4, 8))).toBe("ftyp");
    const generation = await call(p, "GET", `/generation?id=${id}`);
    expect(generation).toMatchObject({ status: 404, json: { error: { code: 404, message: `Generation ${id} not found` } } });
    expect(p.posts()).toEqual(["kling"]);
  });

  test("bills each model its own figure: Kling pro 10 s, and Grok with its input image", async () => {
    const p = make();
    p.beginClip();
    const pro = await submit(p, klingBody({ model: VIDEO_TIERS.pro.model, duration: 10, resolution: "1080p" }));
    expect((await call(p, "GET", `/videos/${pro.id}`)).json).toMatchObject({ usage: { cost: 1.12 } });
    const grok = await submit(p, grokBody());
    expect((await call(p, "GET", `/videos/${grok.id}`)).json).toMatchObject({ usage: { cost: 0.71 } });
    expect(p.posts()).toEqual(["kling", "grok"]);
  });

  test("an id is a safe opaque token, one per POST", async () => {
    const p = make();
    p.beginClip();
    const a = await submit(p);
    const b = await submit(p);
    expect(a.id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(a.id).not.toBe(b.id);
  });

  test("an outcome without a usable cost polls completed with no usage", async () => {
    const p = make();
    p.script("ok-uncosted");
    p.beginClip();
    const sent = await submit(p);
    const poll = await call(p, "GET", `/videos/${sent.id}`);
    expect(poll.json).not.toHaveProperty("usage");
  });
});

describe("a refusal at the submit", () => {
  test("a moderation 400 is one the engine's matcher calls moderation", async () => {
    const p = make();
    p.script("refused-submit");
    p.beginClip();
    const sent = await submit(p);
    expect(sent.status).toBe(400);
    expect(isModerationRefusal(400, JSON.stringify(sent.json))).toBe(true);
  });

  test.each([
    ["rate-limited", 429],
    ["bad-request", 400],
    ["key-invalid", 401],
    ["no-credits", 402],
    ["uncertain", 502],
  ] as const)("%s is HTTP %d, and not a moderation refusal", async (script, status) => {
    const p = make();
    p.script(script);
    p.beginClip();
    const sent = await submit(p);
    expect(sent.status).toBe(status);
    expect(isModerationRefusal(sent.status, JSON.stringify(sent.json))).toBe(false);
    expect(p.posts()).toEqual(["kling"]);
  });
});

describe("a clip that fails at the poll", () => {
  test("a content refusal is Kling's risk-control text, and /generation answers 404 on every read", async () => {
    const p = make();
    p.script("refused-free");
    p.beginClip();
    const sent = await submit(p);
    const poll = await call(p, "GET", `/videos/${sent.id}`);
    expect(poll.json).toMatchObject({ status: "failed", error: RISK_CONTROL, generation_id: sent.id });
    for (let i = 0; i < 3; i++) expect((await call(p, "GET", `/generation?id=${sent.id}`)).status).toBe(404);
  });

  test("a refusal that is billed has a /generation record with its cost", async () => {
    const p = make();
    p.script("refused-paid");
    p.beginClip();
    const sent = await submit(p);
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "failed" });
    expect((await call(p, "GET", `/generation?id=${sent.id}`)).json).toMatchObject({ data: { id: sent.id, total_cost: 0.42 } });
  });

  test("a refusal after which the account's usage rose shows it on /credits, from the moment of the POST", async () => {
    const p = make();
    p.script("refused-unknown");
    p.beginClip();
    const before = ((await call(p, "GET", "/credits")).json as { data: { total_usage: number } }).data.total_usage;
    await submit(p);
    const after = ((await call(p, "GET", "/credits")).json as { data: { total_usage: number } }).data.total_usage;
    expect(after).toBeGreaterThan(before);
  });

  test("a clip whose net-usage check cannot count has an unreadable /credits for the whole clip", async () => {
    const p = make();
    p.script("refused-uncounted");
    p.beginClip();
    expect((await call(p, "GET", "/credits")).status).toBe(500);
    await submit(p);
    expect((await call(p, "GET", "/credits")).status).toBe(500);
    p.script("ok");
    p.beginClip();
    expect((await call(p, "GET", "/credits")).status).toBe(200);
  });

  test("a failure that is not a content refusal says something the engine does not call one", async () => {
    const p = make();
    p.script("provider-error");
    p.beginClip();
    const sent = await submit(p);
    const poll = (await call(p, "GET", `/videos/${sent.id}`)).json as { status: string; error: string };
    expect(poll.status).toBe("failed");
    expect(poll.error).not.toMatch(/risk control|moderation|blocked|flagged/i);
  });
});

describe("the attempts of one clip", () => {
  test("the first POST plays `first`, the second `then`; a new clip starts again, and without a script a clip completes", async () => {
    const p = make();
    p.script({ first: "refused-submit", then: "ok" });
    p.beginClip();
    expect((await submit(p)).status).toBe(400);
    expect((await submit(p, grokBody())).status).toBe(202);
    p.beginClip();
    expect((await submit(p)).status).toBe(202);
    expect(p.posts()).toEqual(["kling", "grok", "kling"]);
  });

  test("a script is used once", async () => {
    const p = make();
    p.script("rate-limited");
    p.beginClip();
    expect((await submit(p)).status).toBe(429);
    p.beginClip();
    expect((await submit(p)).status).toBe(202);
  });
});

describe("holding the render and the late clip", () => {
  test("while held, a poll is in progress; once released it is the outcome", async () => {
    const p = make();
    p.beginClip();
    p.hold(true);
    const sent = await submit(p);
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "in_progress" });
    p.hold(false);
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "completed" });
  });

  test("a clip that never comes stays in progress", async () => {
    const p = make();
    p.script("late");
    p.beginClip();
    const sent = await submit(p);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "in_progress" });
  });

  test("a clip that comes in late is in progress however long it takes, until the story says it has arrived, then completed", async () => {
    const p = make();
    p.script("late-ok");
    p.beginClip();
    const sent = await submit(p);
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "in_progress" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "in_progress" });
    p.arrive();
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "completed" });
  });

  test("an arrival only completes the late clips: a clip that never comes stays in progress", async () => {
    const p = make();
    p.script("late");
    p.beginClip();
    const sent = await submit(p);
    p.arrive();
    expect((await call(p, "GET", `/videos/${sent.id}`)).json).toMatchObject({ status: "in_progress" });
  });
});

describe("the file", () => {
  test("a download that fails is a 502; a file that is not a video is bytes with no `ftyp`", async () => {
    const failed = make();
    failed.script("download-failed");
    failed.beginClip();
    const a = await submit(failed);
    expect((await call(failed, "GET", `/videos/${a.id}/content?index=0`)).status).toBe(502);

    const invalid = make();
    invalid.script("invalid-file");
    invalid.beginClip();
    const b = await submit(invalid);
    const content = await call(invalid, "GET", `/videos/${b.id}/content?index=0`);
    expect(content.status).toBe(200);
    expect(new TextDecoder().decode(content.bytes.subarray(4, 8))).not.toBe("ftyp");
  });

  test("a file the provider has again is served: a retry of a failed download fetches it", async () => {
    const p = make();
    p.script("download-failed");
    p.beginClip();
    const sent = await submit(p);
    expect((await call(p, "GET", `/videos/${sent.id}/content?index=0`)).status).toBe(502);
    p.heal(true);
    const content = await call(p, "GET", `/videos/${sent.id}/content?index=0`);
    expect(content.status).toBe(200);
    expect(new TextDecoder().decode(content.bytes.subarray(4, 8))).toBe("ftyp");
  });

  test("an unknown request is a defect, not a silent answer", async () => {
    const p = make();
    await expect(call(p, "GET", "/models")).rejects.toThrow();
  });
});
