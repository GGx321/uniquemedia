import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventMessage, ResponseMessage, type AvatarTraits, type Estimate } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import type { EngineInit } from "./control";
import { Engine, type EngineDeps } from "./engine";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { Ledger, type LedgerLine } from "./money/ledger";
import { RAW_KEEP_BYTES, RAW_KEEP_BYTES_IMAGE, rawFileName } from "./rawStore";
import { chatBody, fakeFetch, readLedgerLines, withoutAt, type FetchCall, type Reply, type Step } from "./openrouter/testing/fakes";

// The avatar commands of T6a part 2a against a real ledger and library in a
// temp dir. Every request goes to a fake fetch routed by URL: prices (free
// GETs) and chat completions; nothing reaches the network.

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const KEY = "sk-or-v1-0123456789abcdef-wxyz";
const BASE = "https://openrouter.ai/api/v1";

const TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "girl next door, coffee, travel, books",
};
const GOOD = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";

/** The dated fallback table's prices (grok-imagine-image-2.0 low 1K, grok-4.3), as plan.test.ts pins them. */
const NEW_AVATAR: Estimate = { expectedMicros: 169_265, worstMicros: 208_500, prices: "fallback", pricesAsOf: "2026-09-24" };
const NEXT_BATCH: Estimate = { expectedMicros: 166_640, worstMicros: 181_000, prices: "fallback", pricesAsOf: "2026-09-24" };
const ATTEMPT_WORST = 13_750;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-engine-avatars-"));
  await mkdir(join(dir, "library"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function init(overrides: Partial<EngineInit> = {}): EngineInit {
  return {
    kind: "control",
    type: "init",
    ledgerPath: join(dir, "userData", "ledger.jsonl"),
    defaultLibraryPath: join(dir, "userData", "library"),
    rawDir: join(dir, "userData", "raw"),
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(dir, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
    },
    encryptionAvailable: true,
    notices: [],
    ...overrides,
  };
}

const OFFLINE: Reply = { reject: new TypeError("fetch failed") };

/**
 * A fake OpenRouter routed by URL: price GETs answer `prices` (offline by
 * default, so the fallback table applies), chat completions take `chat` in turn.
 */
function network(opts: { prices?: (call: FetchCall) => Reply | Promise<Reply>; chat?: Step[] } = {}) {
  const chat = [...(opts.chat ?? [])];
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/chat/completions")) {
      const step = chat.shift();
      if (step === undefined) throw new Error("unexpected chat completion");
      return typeof step === "function" ? step(call) : step;
    }
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return (await opts.prices?.(call)) ?? OFFLINE;
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    priceCalls: () => net.calls.filter((c) => !c.url.endsWith("/chat/completions")),
    chatCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions")),
  };
}

function descriptorReply(descriptor: string, cost = 0.0021): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ descriptor }), { cost }) };
}

async function startEngine(opts: { init?: Partial<EngineInit>; net?: ReturnType<typeof network>; key?: string | null } = {}) {
  const net = opts.net ?? network();
  const posted: unknown[] = [];
  let n = 0;
  const deps: EngineDeps = {
    bootId: "boot-0000-aaaa",
    clock: () => NOW,
    monotonic: () => 0,
    newId: () => `id-${String(++n).padStart(8, "0")}`,
    post: (message) => posted.push(message),
    fetch: net.fetch,
  };
  const engine = await Engine.start(init(opts.init), deps);
  const key = opts.key === undefined ? KEY : opts.key;
  if (key !== null) await engine.applyControl({ kind: "control", type: "apiKey.set", key });
  const events = () =>
    posted.filter((m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "event").map((m) => EventMessage.parse(m));
  return { engine, net, posted, events };
}

let commandSeq = 0;
function command(type: string, payload: unknown = {}): unknown {
  return { v: 1, id: `cmd-${String(++commandSeq).padStart(8, "0")}`, kind: "command", type, payload };
}

function ok(response: ResponseMessage): Extract<ResponseMessage, { ok: true }> {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (!response.ok) throw new Error(`expected ok, got ${response.error.code}: ${response.error.detail ?? ""}`);
  return response;
}

function failed(response: ResponseMessage): Extract<ResponseMessage, { ok: false }> {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (response.ok) throw new Error(`expected an error, got ${JSON.stringify(response.result)}`);
  return response;
}

function ledgerLines(): Record<string, unknown>[] {
  return readLedgerLines(join(dir, "userData", "ledger.jsonl"));
}

async function seedDraft(opts: { descriptor?: string } = {}): Promise<{ draftId: string; avatarId: string }> {
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("seed") });
  const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
  const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: opts.descriptor ?? GOOD });
  return { draftId: draft.id, avatarId: saved.id };
}

async function writeLedger(lines: LedgerLine[]): Promise<void> {
  const ledger = await Ledger.open(join(dir, "userData", "ledger.jsonl"));
  for (const line of lines) await ledger.append(line);
}

// ---------- prices and estimates ----------

/** Live prices for the default models: cheaper than the table, so live and fallback numbers differ. */
function livePrices(call: FetchCall): Reply {
  if (call.url.endsWith("/endpoints")) {
    return {
      status: 200,
      body: { id: "x-ai/grok-imagine-image-2.0", endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.03, variant: "low_1k" }] }] },
    };
  }
  return { status: 200, body: { data: [{ id: "x-ai/grok-4.3", pricing: { prompt: "0.000001", completion: "0.000002" } }] } };
}

describe("avatars.estimate", () => {
  test("prices the whole job at live prices fetched through the engine's fetch, without the API key", async () => {
    const { engine, net } = await startEngine({ net: network({ prices: livePrices }) });

    const response = ok(await engine.handle(command("avatars.estimate", { traits: TRAITS })));

    // 4 × $0.03 + 4 age checks (658 in, 335 out; ceilings 2.2K in, 1K out) + the descriptor (900 in, 600 out; 2 × 5K in, 3K out) at $1/M in, $2/M out.
    expect(response.result).toEqual({
      expectedMicros: 4 * (30_000 + 1_328) + 2_100,
      worstMicros: 4 * (30_000 + 4_200) + 2 * 11_000,
      prices: "live",
      pricesAsOf: "2026-09-24",
    });
    expect(net.priceCalls().map((c) => [c.method, c.url, "Authorization" in c.headers])).toEqual([
      ["GET", `${BASE}/images/models/x-ai/grok-imagine-image-2.0/endpoints`, false],
      ["GET", `${BASE}/models`, false],
    ]);
  });

  test("when the price fetch fails it answers the dated fallback prices and says so", async () => {
    const { engine } = await startEngine();

    expect(ok(await engine.handle(command("avatars.estimate", { traits: TRAITS }))).result).toEqual(NEW_AVATAR);
  });

  test("a second estimate soon after gives the same numbers without fetching again", async () => {
    const { engine, net } = await startEngine({ net: network({ prices: livePrices }) });

    const first = ok(await engine.handle(command("avatars.estimate", { traits: TRAITS })));
    const second = ok(await engine.handle(command("avatars.estimate", { traits: { ...TRAITS, age: 31, vibe: "" } })));

    expect(second.result).toEqual(first.result);
    expect(net.priceCalls()).toHaveLength(2);
  });

  test("follows the image model in the settings", async () => {
    const { engine } = await startEngine();
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, imageModel: "x-ai/grok-imagine-image-quality" } });

    // grok-imagine-image-quality: $0.05 at 1K.
    expect(ok(await engine.handle(command("avatars.estimate", { traits: TRAITS }))).result).toMatchObject({ worstMicros: 4 * (50_000 + 5_250) + 2 * ATTEMPT_WORST });
  });

  test("a model neither the live prices nor the table know answers PRICE_UNAVAILABLE", async () => {
    const { engine } = await startEngine({ init: { settings: { ...init().settings, imageModel: "acme/unknown-image" } } });

    expect(failed(await engine.handle(command("avatars.estimate", { traits: TRAITS }))).error.code).toBe("PRICE_UNAVAILABLE");
  });

  test("needs no key and no library", async () => {
    const { engine } = await startEngine({ key: null, init: { settings: { ...init().settings, libraryPath: join(dir, "missing") } } });

    expect(ok(await engine.handle(command("avatars.estimate", { traits: TRAITS }))).result).toEqual(NEW_AVATAR);
  });
});

describe("avatars.estimateCandidates", () => {
  test("prices another batch for a draft: portraits and age checks, no descriptor", async () => {
    const { draftId } = await seedDraft();
    const { engine } = await startEngine();

    expect(ok(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId }))).result).toEqual(NEXT_BATCH);
  });

  test("answers NOT_FOUND for an unknown id and for a saved avatar", async () => {
    const { avatarId } = await seedDraft();
    const { engine } = await startEngine();

    expect(failed(await engine.handle(command("avatars.estimateCandidates", { avatarId: "nobody-00000000" }))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(command("avatars.estimateCandidates", { avatarId }))).error.code).toBe("NOT_FOUND");
  });

  test("answers NOT_FOUND without a library", async () => {
    const { engine } = await startEngine({ init: { settings: { ...init().settings, libraryPath: join(dir, "missing") } } });

    expect(failed(await engine.handle(command("avatars.estimateCandidates", { avatarId: "draft-00000001" }))).error.code).toBe("NOT_FOUND");
  });

  test("answers DESCRIPTOR_INVALID, never INTERNAL, for a draft whose stored descriptor fails today's rules", async () => {
    const { draftId } = await seedDraft({ descriptor: "a young woman with hazel eyes" });
    const { engine } = await startEngine();

    expect(failed(await engine.handle(command("avatars.estimateCandidates", { avatarId: draftId }))).error.code).toBe("DESCRIPTOR_INVALID");
  });
});

// ---------- avatars.estimateRewriteDescriptor / avatars.rewriteDescriptor ----------

const BAD_DESCRIPTOR = "a young woman with hazel eyes";
/** The descriptor call alone, at fallback prices: no candidates, no age checks. */
const REWRITE: Estimate = { expectedMicros: 2_625, worstMicros: 2 * ATTEMPT_WORST, prices: "fallback", pricesAsOf: "2026-09-24" };

async function seedUnreadable(status: "draft" | "active" | "archived" = "draft"): Promise<{ avatarId: string }> {
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("bad") });
  const avatar = await library.createAvatar({ name: "Bad", age: 25, traits: manifestTraits(TRAITS), descriptor: BAD_DESCRIPTOR });
  if (status !== "draft") {
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  }
  if (status === "archived") await library.updateAvatar(avatar.id, { status: "archived" });
  return { avatarId: avatar.id };
}

function rewriteDescriptor(avatarId: string, acceptedWorstMicros = REWRITE.worstMicros): unknown {
  return command("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros });
}

/** A draft whose vibe (not just the descriptor) now fails today's rules: rewriting the descriptor alone cannot recover it (H2). */
async function seedUnrewritableVibe(): Promise<{ avatarId: string }> {
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("badvibe") });
  const avatar = await library.createAvatar({ name: "Bad", age: 25, traits: manifestTraits({ ...TRAITS, vibe: "teen look" }), descriptor: BAD_DESCRIPTOR });
  return { avatarId: avatar.id };
}

/** An active avatar with a name over 60 chars (the library allows it; the contract's AvatarName does not): no descriptor could make it fit (H2/M1). */
async function seedUnrewritableName(): Promise<{ avatarId: string }> {
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("badname") });
  const avatar = await library.createAvatar({ name: "N".repeat(61), age: 25, traits: manifestTraits(TRAITS), descriptor: BAD_DESCRIPTOR });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return { avatarId: avatar.id };
}

describe("avatars.estimateRewriteDescriptor", () => {
  test("prices the descriptor call alone for a draft whose descriptor fails today's rules", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine } = await startEngine();

    expect(ok(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId }))).result).toEqual(REWRITE);
  });

  test("prices it the same for an active avatar", async () => {
    const { avatarId } = await seedUnreadable("active");
    const { engine } = await startEngine();

    expect(ok(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId }))).result).toEqual(REWRITE);
  });

  test("answers NOT_FOUND for an unknown id", async () => {
    const { engine } = await startEngine();

    expect(failed(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId: "nobody-00000000" }))).error.code).toBe("NOT_FOUND");
  });

  test("refuses with VALIDATION for an avatar whose descriptor already fits today's rules: nothing to fix", async () => {
    const { avatarId } = await seedDraft();
    const { engine } = await startEngine();

    expect(failed(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId }))).error.code).toBe("VALIDATION");
  });

  test("refuses with VALIDATION, not a price, for a draft whose vibe also fails today's rules: rewriting the descriptor alone would not fix it", async () => {
    const { avatarId } = await seedUnrewritableVibe();
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId }))).error.code).toBe("VALIDATION");
    expect(net.chatCalls()).toHaveLength(0);
  });

  test("refuses with VALIDATION, not a price, for an avatar whose name is over 60 chars: no descriptor could make it fit", async () => {
    const { avatarId } = await seedUnrewritableName();
    const { engine } = await startEngine();

    expect(failed(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId }))).error.code).toBe("VALIDATION");
  });

  test("prices it even when the settings' image model has no price at all (L8): a rewrite never sends an image", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine } = await startEngine({ init: { settings: { ...init().settings, imageModel: "acme/unknown-image" } } });

    expect(ok(await engine.handle(command("avatars.estimateRewriteDescriptor", { avatarId }))).result).toEqual(REWRITE);
  });
});

describe("avatars.rewriteDescriptor", () => {
  test("one paid descriptor call rewrites a draft's descriptor; the next snapshot lists it normally", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, events } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    const response = ok(await engine.handle(rewriteDescriptor(avatarId)));
    expect(response).toMatchObject({ result: { avatarId } });

    expect(engine.library?.getAvatar(avatarId)).toMatchObject({ descriptor: GOOD, name: "Bad", status: "draft" });
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot).toMatchObject({ result: { drafts: [{ avatarId, descriptor: { text: GOOD } }], unreadableAvatars: [] } });
    expect(events().map((e) => e.type)).toContain("draft.changed");

    const [reserve, settle, ...rest] = withoutAt(ledgerLines());
    expect(rest).toEqual([]);
    expect(reserve).toMatchObject({ type: "reserve", model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST });
    expect(settle).toMatchObject({ type: "settle", costMicros: 2_100 });
  });

  test("rewrites an active avatar's descriptor, keeping its master photo and name, and emits avatar.changed", async () => {
    const { avatarId } = await seedUnreadable("active");
    const { engine, events } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    const before = engine.library?.getAvatar(avatarId);

    ok(await engine.handle(rewriteDescriptor(avatarId)));

    expect(engine.library?.getAvatar(avatarId)).toMatchObject({ descriptor: GOOD, name: before?.name, masterPhotoId: before?.masterPhotoId, status: "active" });
    const list = ok(await engine.handle(command("avatars.list")));
    expect(list).toMatchObject({ result: { avatars: [{ avatarId }], unreadableAvatars: [] } });
    expect(events().map((e) => e.type)).toContain("avatar.changed");
  });

  test("rewrites an archived avatar's descriptor too, leaving it archived", async () => {
    const { avatarId } = await seedUnreadable("archived");
    const { engine } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    ok(await engine.handle(rewriteDescriptor(avatarId)));

    expect(engine.library?.getAvatar(avatarId)).toMatchObject({ descriptor: GOOD, status: "archived" });
    const list = ok(await engine.handle(command("avatars.list")));
    expect(list).toMatchObject({ result: { avatars: [{ avatarId, status: "archived" }], unreadableAvatars: [] } });
  });

  test("a rejected answer is asked once more; the job's cap is exactly the descriptor job's cap", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine } = await startEngine({ net: network({ chat: [descriptorReply("25-year-old European girl, hazel eyes."), descriptorReply(GOOD)] }) });

    ok(await engine.handle(rewriteDescriptor(avatarId)));

    expect(ledgerLines().filter((l) => l.type === "settle")).toHaveLength(2);
    expect(engine.library?.getAvatar(avatarId)).toMatchObject({ descriptor: GOOD });
  });

  test("refuses with VALIDATION and spends nothing for an avatar whose descriptor already fits today's rules", async () => {
    const { avatarId } = await seedDraft();
    const { engine, net } = await startEngine();

    const refused = failed(await engine.handle(rewriteDescriptor(avatarId, REWRITE.worstMicros)));

    expect(refused.error.code).toBe("VALIDATION");
    expect(net.chatCalls()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
  });

  test("refuses with VALIDATION and spends nothing for a draft whose vibe also fails today's rules (H2): rewriting the descriptor alone would not fix it", async () => {
    const { avatarId } = await seedUnrewritableVibe();
    const { engine, net } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    const refused = failed(await engine.handle(rewriteDescriptor(avatarId)));

    expect(refused.error.code).toBe("VALIDATION");
    expect(net.chatCalls()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
  });

  test("refuses with VALIDATION and spends nothing for an avatar with a name over 60 chars: it pays, writes, then INTERNAL was the bug (M1)", async () => {
    const { avatarId } = await seedUnrewritableName();
    const { engine, net, events } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    const before = events().length;

    const refused = failed(await engine.handle(rewriteDescriptor(avatarId)));

    expect(refused.error.code).toBe("VALIDATION");
    expect(net.chatCalls()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
    expect(events().slice(before)).toEqual([]);
    // A retry behaves identically: the record was never mutated.
    expect(failed(await engine.handle(rewriteDescriptor(avatarId))).error.code).toBe("VALIDATION");
  });

  test("answers NOT_FOUND for an unknown id, nothing sent", async () => {
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(rewriteDescriptor("nobody-00000000"))).error.code).toBe("NOT_FOUND");
    expect(net.chatCalls()).toHaveLength(0);
  });

  test("accepted one micro-dollar below the current worst case: PRICE_CHANGED, nothing sent", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, net } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    const refused = failed(await engine.handle(rewriteDescriptor(avatarId, REWRITE.worstMicros - 1)));

    expect(refused.error.code).toBe("PRICE_CHANGED");
    expect(net.chatCalls()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
  });

  test("without a key: AUTH_INVALID, nothing sent", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, net } = await startEngine({ key: null });

    expect(failed(await engine.handle(rewriteDescriptor(avatarId))).error.code).toBe("AUTH_INVALID");
    expect(net.calls).toHaveLength(0);
  });

  test("without a library: LIBRARY_UNAVAILABLE, nothing sent", async () => {
    const { engine, net } = await startEngine({ init: { settings: { ...init().settings, libraryPath: join(dir, "missing") } } });

    expect(failed(await engine.handle(rewriteDescriptor("avatar-00000001"))).error.code).toBe("LIBRARY_UNAVAILABLE");
    expect(net.calls).toHaveLength(0);
  });

  test("after a restart with open reserves: RECONCILE_REQUIRED before anything is sent (M2)", async () => {
    await writeLedger([
      { type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" },
    ]);
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(rewriteDescriptor("avatar-00000001"))).error.code).toBe("RECONCILE_REQUIRED");
    expect(net.calls).toHaveLength(0);
  });

  test("after a bill above its worst case: SETTLE_ABOVE_WORST until a reconcile, nothing sent (M2)", async () => {
    await writeLedger([
      { type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" },
      { type: "settle", attemptId: "old#1", costMicros: 6_000, estimated: false, at: "2026-09-24T11:00:01.000Z" },
    ]);
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(rewriteDescriptor("avatar-00000001"))).error.code).toBe("SETTLE_ABOVE_WORST");
    expect(net.calls).toHaveLength(0);
  });

  test("a ledger halted by a failed write: LEDGER_WRITE_FAILED, nothing sent (M2)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, net } = await startEngine({ init: { ledgerPath: join(dir, "money", "ledger.jsonl") } });
    await writeFile(join(dir, "money"), "a file where the ledger's folder should be");
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 }).catch(() => undefined);

    expect(failed(await engine.handle(rewriteDescriptor(avatarId))).error.code).toBe("LEDGER_WRITE_FAILED");
    expect(net.chatCalls()).toHaveLength(0);
  });

  test("a 401 answers AUTH_INVALID and marks the key rejected (M2)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, events } = await startEngine({ net: network({ chat: [{ status: 401, body: { error: { message: "No auth credentials found" } } }] }) });

    expect(failed(await engine.handle(rewriteDescriptor(avatarId))).error.code).toBe("AUTH_INVALID");
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { rejected: true } } } });
  });

  test("emits money.changed on a successful rewrite (M2)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, events } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    const before = events().length;

    ok(await engine.handle(rewriteDescriptor(avatarId)));

    const emitted = events().slice(before);
    expect(emitted.map((e) => e.type)).toEqual(["money.changed", "draft.changed"]);
    expect(emitted[0]).toMatchObject({ payload: { status: { spentMicros: 2_100 } } });
  });

  test("the job's scope is capped at the descriptor job's cap while it runs, and cleared once it ends (M2)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    let probe: unknown = null;
    let engineRef: Engine | null = null;
    const probeAttempt = async (): Promise<Reply> => {
      const budget = engineRef?.budget;
      if (budget === null || budget === undefined) throw new Error("expected a budget");
      const jobId = String(ledgerLines()[0]?.jobId);
      const scope = { avatarJobId: jobId };
      probe = await budget.tryReserve({ attemptId: "probe#1", jobId, scope, model: "x-ai/grok-4.3", worstMicros: 2 * ATTEMPT_WORST + 1 });
      return descriptorReply(GOOD);
    };
    const { engine } = await startEngine({ net: network({ chat: [probeAttempt] }) });
    engineRef = engine;

    ok(await engine.handle(rewriteDescriptor(avatarId)));

    // Probed while the descriptor attempt is in flight: its own reserve (13,750 µ$) is already open in the scope.
    expect(probe).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 2 * ATTEMPT_WORST });
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    const jobId = String(ledgerLines()[0]?.jobId);
    expect(await budget.tryReserve({ attemptId: "late#1", jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: 1 })).toMatchObject({
      ok: false,
      reason: "RUN_CAP_EXCEEDED",
      limitMicros: 0,
    });
  });

  test("money.reconcile is refused with IN_FLIGHT while a rewrite runs (M2, P5)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine } = await startEngine({ net: network({ prices: async () => (await held, OFFLINE), chat: [descriptorReply(GOOD)] }) });

    // No sleep needed: #paidCommands++ (the avatars.rewriteDescriptor dispatch case)
    // runs synchronously, before rewriteDescriptor's first await, so it is
    // already set by the time this call returns control (L10).
    const rewriting = engine.handle(rewriteDescriptor(avatarId));
    expect(failed(await engine.handle(command("money.reconcile"))).error.code).toBe("IN_FLIGHT");

    release();
    ok(await rewriting);
  });

  test("a final non-2xx settles the attempt at 0 and releases the claim: a second rewrite is taken, not IN_FLIGHT (M2, P4)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const moderationRefused: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
    const { engine } = await startEngine({ net: network({ chat: [moderationRefused, descriptorReply(GOOD)] }) });

    const first = failed(await engine.handle(rewriteDescriptor(avatarId)));
    expect(first.error.code).not.toBe("IN_FLIGHT");
    expect(ledgerLines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([0]);

    const second = ok(await engine.handle(rewriteDescriptor(avatarId)));
    expect(second.result).toMatchObject({ avatarId });
  });

  test("a failed rewrite also releases the claim for a library switch (M2)", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const moderationRefused: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
    const { engine, posted } = await startEngine({ net: network({ chat: [moderationRefused] }) });
    await mkdir(join(dir, "other"));

    failed(await engine.handle(rewriteDescriptor(avatarId)));

    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: join(dir, "other") });
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
  });

  test("a monthly budget without room for the descriptor job: BUDGET_EXCEEDED before anything is sent", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine, net } = await startEngine({ init: { settings: { ...init().settings, monthlyBudgetMicros: REWRITE.worstMicros - 1 } } });

    expect(failed(await engine.handle(rewriteDescriptor(avatarId))).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.chatCalls()).toHaveLength(0);
  });

  test("refuses with VALIDATION an avatar whose traits do not fit AvatarTraits (schema version 2, free-form values): it cannot be rewritten", async () => {
    const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("legacy") });
    const legacy = await library.createAvatar({ name: "Legacy", age: 25, traits: { hair: "chestnut" }, descriptor: BAD_DESCRIPTOR });
    const { engine, net } = await startEngine();

    const refused = failed(await engine.handle(rewriteDescriptor(legacy.id, REWRITE.worstMicros)));

    expect(refused.error.code).toBe("VALIDATION");
    expect(net.chatCalls()).toHaveLength(0);
  });

  test("refuses with VALIDATION a genuine schema version 1 manifest (text-only traits, from before version 2 existed): it cannot be rewritten", async () => {
    await openLibrary(join(dir, "library"));
    const avatarDir = join(dir, "library", "avatars", "legacy-0000001");
    await mkdir(join(avatarDir, "photos"), { recursive: true });
    const v1Manifest = {
      schemaVersion: 1,
      id: "legacy-0000001",
      name: "Legacy",
      age: 25,
      traits: { ethnicity: "european", hair: "chestnut" },
      descriptor: BAD_DESCRIPTOR,
      masterPhotoId: null,
      status: "draft",
      createdAt: "2026-09-24T10:00:00.000Z",
    };
    await writeFile(join(avatarDir, "avatar.json"), JSON.stringify(v1Manifest));
    const { engine, net } = await startEngine();
    expect(engine.library?.getAvatar("legacy-0000001")).toMatchObject({ schemaVersion: 1 });

    const refused = failed(await engine.handle(rewriteDescriptor("legacy-0000001", REWRITE.worstMicros)));

    expect(refused.error.code).toBe("VALIDATION");
    expect(net.chatCalls()).toHaveLength(0);
  });

  test("a second rewriteDescriptor for the same avatar while one runs is refused with IN_FLIGHT", async () => {
    const { avatarId } = await seedUnreadable("draft");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine } = await startEngine({
      net: network({ prices: async () => (await held, OFFLINE), chat: [descriptorReply(GOOD)] }),
    });

    // No sleep needed (L10): #claimAvatar runs synchronously, before the
    // first await, so it is already set by the time this call returns control.
    const first = engine.handle(rewriteDescriptor(avatarId));
    const second = failed(await engine.handle(rewriteDescriptor(avatarId)));
    release();
    ok(await first);

    expect(second.error.code).toBe("IN_FLIGHT");
  });

  test("a library switch is refused with IN_FLIGHT while rewriteDescriptor runs", async () => {
    const { avatarId } = await seedUnreadable("draft");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine, posted } = await startEngine({
      net: network({ prices: async () => (await held, OFFLINE), chat: [descriptorReply(GOOD)] }),
    });
    await mkdir(join(dir, "other"));

    // No sleep needed (L10): #paidCommands++ and #claimAvatar run
    // synchronously, before rewriteDescriptor's first await.
    const rewriting = engine.handle(rewriteDescriptor(avatarId));
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: join(dir, "other") });
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    release();
    ok(await rewriting);
  });

  test("a library write that fails after the paid call fails the command; the money stays settled and the paid descriptor is kept", async () => {
    const { avatarId } = await seedUnreadable("draft");
    const { engine } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    // The avatars folder becomes a file: the rewrite cannot be written.
    await rm(join(dir, "library", "avatars"), { recursive: true });
    await writeFile(join(dir, "library", "avatars"), "not a folder");

    const refused = failed(await engine.handle(rewriteDescriptor(avatarId)));
    expect(refused.error.code).toBe("INTERNAL");
    expect(ledgerLines().at(-1)).toMatchObject({ type: "settle", costMicros: 2_100 });
    const jobId = String(ledgerLines()[0]?.jobId);
    expect(refused.error.detail).toContain(`raw/${rawFileName(`${jobId}:rewrite`)}`);
    const kept = JSON.parse(await readFile(join(dir, "userData", "raw", rawFileName(`${jobId}:rewrite`)), "utf8"));
    expect(kept).toEqual({ avatarId, descriptor: { age: 25, text: GOOD } });
  });
});

describe("drafts in the snapshot", () => {
  test("carry no estimate before the engine has prices: a snapshot never fetches", async () => {
    await seedDraft();
    const { engine, net } = await startEngine();

    const snapshot = ok(await engine.handle(command("engine.snapshot")));

    expect(snapshot).toMatchObject({ result: { drafts: [{ estimate: null }] } });
    expect(net.calls).toHaveLength(0);
  });

  test("carry the next batch's estimate at the prices the engine has", async () => {
    await seedDraft();
    const { engine } = await startEngine();
    ok(await engine.handle(command("avatars.estimate", { traits: TRAITS })));

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { drafts: [{ estimate: NEXT_BATCH }] } });
  });
});

// ---------- avatars.createDraft ----------

function createDraft(acceptedWorstMicros = NEW_AVATAR.worstMicros, traits: AvatarTraits = TRAITS): unknown {
  return command("avatars.createDraft", { traits, acceptedWorstMicros });
}

describe("avatars.createDraft", () => {
  test("one paid descriptor call, then the draft is stored and returned with the next batch's estimate", async () => {
    const { engine, net } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    const response = ok(await engine.handle(createDraft()));
    if (response.type !== "avatars.createDraft") throw new Error("wrong type");
    const { draft } = response.result;

    expect(draft).toEqual({ avatarId: draft.avatarId, traits: TRAITS, descriptor: { age: 25, text: GOOD }, candidates: [], estimate: NEXT_BATCH });
    expect(net.chatCalls().map((c) => [c.url, c.headers.Authorization])).toEqual([[`${BASE}/chat/completions`, `Bearer ${KEY}`]]);
    const stored = engine.library?.getAvatar(draft.avatarId);
    expect(stored).toMatchObject({ status: "draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD, masterPhotoId: null });
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { drafts: [{ avatarId: draft.avatarId }] } });
  });

  test("the call is reserved on disk under the job's own scope and settled at usage.cost", async () => {
    const { engine } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    ok(await engine.handle(createDraft()));

    const [reserve, settle, ...rest] = withoutAt(ledgerLines());
    expect(rest).toEqual([]);
    expect(reserve).toMatchObject({ type: "reserve", model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST });
    const jobId = String(reserve?.jobId);
    expect(reserve).toMatchObject({ attemptId: `${jobId}:descriptor#1`, scope: { avatarJobId: jobId } });
    expect(settle).toEqual({ type: "settle", attemptId: `${jobId}:descriptor#1`, costMicros: 2_100, estimated: false });
  });

  test("the job's scope is capped at what it can send, two descriptor attempts, while PRICE_CHANGED uses the whole job", async () => {
    let probes: unknown[] = [];
    let engineRef: Engine | null = null;
    // Probed while attempt #1 is in flight: its reserve (13,750 µ$) is open in the job's scope.
    const probe = async (): Promise<Reply> => {
      const budget = engineRef?.budget;
      if (budget === null || budget === undefined) throw new Error("expected a budget");
      const jobId = String(ledgerLines()[0]?.jobId);
      const scope = { avatarJobId: jobId };
      probes = [
        await budget.tryReserve({ attemptId: "probe#1", jobId, scope, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST + 1 }),
        await budget.tryReserve({ attemptId: "probe#2", jobId, scope, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST }),
      ];
      return descriptorReply(GOOD);
    };
    const { engine } = await startEngine({ net: network({ chat: [probe] }) });
    engineRef = engine;

    ok(await engine.handle(createDraft(NEW_AVATAR.worstMicros)));

    expect(probes).toMatchObject([{ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 2 * ATTEMPT_WORST }, { ok: true }]);
  });

  test("the job's cap is dropped when the command ends: its scope can reserve nothing more", async () => {
    const { engine } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    ok(await engine.handle(createDraft()));
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    const jobId = String(ledgerLines()[0]?.jobId);

    expect(await budget.tryReserve({ attemptId: "late#1", jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: 1 })).toMatchObject({
      ok: false,
      reason: "RUN_CAP_EXCEEDED",
      limitMicros: 0,
    });
  });

  test("emits money.changed and draft.changed with the draft it returns", async () => {
    const { engine, events } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    const before = events().length;

    const response = ok(await engine.handle(createDraft()));
    if (response.type !== "avatars.createDraft") throw new Error("wrong type");

    const emitted = events().slice(before);
    expect(emitted.map((e) => e.type)).toEqual(["money.changed", "draft.changed"]);
    expect(emitted[0]).toMatchObject({ payload: { status: { spentMicros: 2_100, unsettledCount: 0 } } });
    expect(emitted[1]).toMatchObject({ payload: { draft: response.result.draft } });
  });

  test("uses the prices the estimate loaded: no second price fetch", async () => {
    const { engine, net } = await startEngine({ net: network({ prices: livePrices, chat: [descriptorReply(GOOD)] }) });
    const estimate = ok(await engine.handle(command("avatars.estimate", { traits: TRAITS })));
    if (estimate.type !== "avatars.estimate") throw new Error("wrong type");

    ok(await engine.handle(createDraft(estimate.result.worstMicros)));

    expect(net.priceCalls()).toHaveLength(2);
    // Live grok-4.3 at $1/M in, $2/M out: 3K out + 5K in.
    expect(ledgerLines()[0]).toMatchObject({ worstMicros: 11_000 });
  });

  test("accepted exactly at the current worst case it goes ahead; one micro-dollar below, PRICE_CHANGED and nothing is sent or written", async () => {
    const { engine, net } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });

    const refused = failed(await engine.handle(createDraft(NEW_AVATAR.worstMicros - 1)));
    expect(refused.error.code).toBe("PRICE_CHANGED");
    expect(net.chatCalls()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);

    ok(await engine.handle(createDraft(NEW_AVATAR.worstMicros)));
  });

  test("without a key: AUTH_INVALID, nothing sent", async () => {
    const { engine, net } = await startEngine({ key: null });

    expect(failed(await engine.handle(createDraft())).error.code).toBe("AUTH_INVALID");
    expect(net.calls).toHaveLength(0);
  });

  test("with a key OpenRouter rejected: AUTH_INVALID, nothing sent", async () => {
    const { engine, net } = await startEngine();
    engine.markKeyRejected(KEY);

    expect(failed(await engine.handle(createDraft())).error.code).toBe("AUTH_INVALID");
    expect(net.calls).toHaveLength(0);
  });

  test("without a library: LIBRARY_UNAVAILABLE, nothing sent or written", async () => {
    const { engine, net } = await startEngine({ init: { settings: { ...init().settings, libraryPath: join(dir, "missing") } } });

    const refused = failed(await engine.handle(createDraft()));

    expect(refused.error.code).toBe("LIBRARY_UNAVAILABLE");
    expect(net.calls).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
  });

  test("after a restart with open reserves: RECONCILE_REQUIRED, nothing sent (invariant 4)", async () => {
    await writeLedger([
      { type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" },
    ]);
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(createDraft())).error.code).toBe("RECONCILE_REQUIRED");
    expect(net.calls).toHaveLength(0);
  });

  test("after a bill above its worst case: SETTLE_ABOVE_WORST until a reconcile, nothing sent", async () => {
    await writeLedger([
      { type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" },
      { type: "settle", attemptId: "old#1", costMicros: 6_000, estimated: false, at: "2026-09-24T11:00:01.000Z" },
    ]);
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(createDraft())).error.code).toBe("SETTLE_ABOVE_WORST");
    expect(net.calls).toHaveLength(0);
  });

  test("a ledger that cannot be read: its cause, nothing sent", async () => {
    await mkdir(join(dir, "userData", "ledger.jsonl"), { recursive: true });
    const { engine, net } = await startEngine();

    expect(failed(await engine.handle(createDraft())).error.code).toBe("LEDGER_UNREADABLE");
    expect(net.calls).toHaveLength(0);
  });

  test("a monthly budget without room for the whole job: BUDGET_EXCEEDED before anything is sent", async () => {
    const { engine, net } = await startEngine({ init: { settings: { ...init().settings, monthlyBudgetMicros: NEW_AVATAR.worstMicros - 1 } } });

    expect(failed(await engine.handle(createDraft())).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.chatCalls()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
  });

  test("a rejected answer is asked once more; the second good answer makes the draft", async () => {
    const { engine, net } = await startEngine({ net: network({ chat: [descriptorReply("25-year-old European girl, hazel eyes."), descriptorReply(GOOD)] }) });

    const response = ok(await engine.handle(createDraft()));

    expect(response).toMatchObject({ result: { draft: { descriptor: { text: GOOD } } } });
    expect(net.chatCalls()).toHaveLength(2);
    expect(ledgerLines().filter((l) => l.type === "settle")).toHaveLength(2);
  });

  test("an answer rejected twice fails the command clearly; both attempts are settled and no draft is stored", async () => {
    const { engine, events } = await startEngine({ net: network({ chat: [descriptorReply("European woman."), descriptorReply("25-year-old woman who looks 19.")] }) });

    const refused = failed(await engine.handle(createDraft()));

    expect(refused.error.code).toBe("INTERNAL");
    expect(refused.error.detail).toContain("rejected 2 times");
    expect(ledgerLines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([2_100, 2_100]);
    expect(engine.library?.listAvatars()).toEqual([]);
    expect(events().map((e) => e.type)).toContain("money.changed");
    expect(events().map((e) => e.type)).not.toContain("draft.changed");
  });

  test("a 401 answers AUTH_INVALID and marks the key rejected", async () => {
    const { engine, events } = await startEngine({ net: network({ chat: [{ status: 401, body: { error: { message: "No auth credentials found" } } }] }) });

    expect(failed(await engine.handle(createDraft())).error.code).toBe("AUTH_INVALID");
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { rejected: true } } } });
  });

  test("a paid answer that cannot be used is kept, redacted, in userData/raw, and the command fails", async () => {
    const leaky = `oops ${KEY} not json`;
    const { engine } = await startEngine({ net: network({ chat: [{ status: 200, body: leaky }] }) });

    const refused = failed(await engine.handle(createDraft()));

    expect(refused.error.code).toBe("INTERNAL");
    const raw = join(dir, "userData", "raw");
    const files = await readdir(raw);
    const jobId = String(ledgerLines()[0]?.jobId);
    expect(files).toEqual([rawFileName(`${jobId}:descriptor#1`)]);
    const text = await readFile(join(raw, files[0] ?? ""), "utf8");
    expect(text).toContain("not json");
    expect(text).not.toContain(KEY);
    expect(ledgerLines().at(-1)).toMatchObject({ type: "settle", costMicros: ATTEMPT_WORST, estimated: true });
  });

  test("an oversized paid descriptor answer keeps far more on disk than an image attempt would: the chat default cap, not the image one", async () => {
    // Ordinary words with spaces, not a run of one letter: a long run of
    // base64-alphabet characters would itself be scrubbed as image-shaped
    // data (chat.ts's scrubRaw), which is not what this test is about.
    const phrase = "the descriptor answer keeps going on and on without ever closing its quote. ";
    const leaky = `oops ${phrase.repeat(Math.ceil((RAW_KEEP_BYTES + 500) / phrase.length))} not json`;
    const { engine } = await startEngine({ net: network({ chat: [{ status: 200, body: leaky }] }) });

    const refused = failed(await engine.handle(createDraft()));

    expect(refused.error.code).toBe("INTERNAL");
    const raw = join(dir, "userData", "raw");
    const files = await readdir(raw);
    expect(files).toHaveLength(1);
    const text = await readFile(join(raw, files[0] ?? ""), "utf8");
    // The chat/descriptor default (RAW_PREFIX_BYTES + 4096) fits the client's
    // own 64 KiB prefix and note whole; a flat image-sized cap would not.
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(RAW_KEEP_BYTES_IMAGE * 4);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(RAW_KEEP_BYTES + 500);
  });

  test("a second createDraft while one runs is refused with IN_FLIGHT: one paid descriptor, one draft", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine, net } = await startEngine({
      net: network({ prices: async () => (await held, OFFLINE), chat: [descriptorReply(GOOD), descriptorReply(GOOD)] }),
    });

    const first = engine.handle(createDraft());
    await Bun.sleep(5);
    const second = failed(await engine.handle(createDraft()));
    release();
    ok(await first);

    expect(second.error.code).toBe("IN_FLIGHT");
    expect(net.chatCalls()).toHaveLength(1);
    expect(engine.library?.listAvatars()).toHaveLength(1);
    // Once the first has ended, a new avatar may be started.
    ok(await engine.handle(createDraft()));
    expect(engine.library?.listAvatars()).toHaveLength(2);
  });

  test("a library switch is refused with IN_FLIGHT while createDraft runs, before its first reserve too", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine, posted } = await startEngine({
      net: network({ prices: async () => (await held, OFFLINE), chat: [descriptorReply(GOOD)] }),
    });
    await mkdir(join(dir, "other"));
    const open = (callId: string) => ({ kind: "control", type: "library.open", callId, path: join(dir, "other") });

    const creating = engine.handle(createDraft());
    await Bun.sleep(5);
    await engine.receive(open("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    release();
    ok(await creating);
    await engine.receive(open("call-00000002"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
  });

  test("library.confirm is refused with IN_FLIGHT while createDraft runs, and allowed once it ended", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine, posted } = await startEngine({
      net: network({ prices: async () => (await held, OFFLINE), chat: [descriptorReply(GOOD)] }),
    });
    await mkdir(join(dir, "other"));
    const confirm = (callId: string) => ({ kind: "control", type: "library.confirm", callId, path: join(dir, "other") });
    // Staged first, while nothing is busy yet: confirm itself has no await
    // left to race, so what matters here is that "other" is staged.
    await engine.receive({ kind: "control", type: "library.open", callId: "call-open-0001", path: join(dir, "other") });

    // No sleep needed: #paidCommands++ (engine.ts's avatars.createDraft case)
    // runs synchronously, before createDraft's first await, so it is already
    // set by the time this call returns control.
    const creating = engine.handle(createDraft());
    await engine.receive(confirm("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    expect(engine.library?.root).toBe(join(dir, "library"));

    release();
    ok(await creating);
    // An IN_FLIGHT refusal drops the staged entry (main always opens again before it retries confirm).
    await engine.receive({ kind: "control", type: "library.open", callId: "call-open-0002", path: join(dir, "other") });
    await engine.receive(confirm("call-00000002"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
    expect(engine.library?.root).toBe(join(dir, "other"));
  });

  test("a library write that fails after the paid call fails the command; the money stays settled", async () => {
    const { engine } = await startEngine({ net: network({ chat: [descriptorReply(GOOD)] }) });
    // The avatars folder becomes a file: the draft cannot be written.
    await rm(join(dir, "library", "avatars"), { recursive: true });
    await writeFile(join(dir, "library", "avatars"), "not a folder");

    const refused = failed(await engine.handle(createDraft()));
    expect(refused.error.code).toBe("INTERNAL");
    expect(ledgerLines().at(-1)).toMatchObject({ type: "settle", costMicros: 2_100 });
    // The paid descriptor is not lost: it waits in userData/raw with the traits it was written for, and the error says where.
    const jobId = String(ledgerLines()[0]?.jobId);
    expect(refused.error.detail).toContain(`raw/${rawFileName(`${jobId}:descriptor`)}`);
    const kept = JSON.parse(await readFile(join(dir, "userData", "raw", rawFileName(`${jobId}:descriptor`)), "utf8"));
    expect(kept).toEqual({ traits: TRAITS, descriptor: { age: 25, text: GOOD } });
  });
});
