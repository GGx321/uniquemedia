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
import { rawFileName } from "./rawStore";
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
const NEW_AVATAR: Estimate = { expectedMicros: 169_265, worstMicros: 207_500, prices: "fallback", pricesAsOf: "2026-09-24" };
const NEXT_BATCH: Estimate = { expectedMicros: 166_640, worstMicros: 180_000, prices: "fallback", pricesAsOf: "2026-09-24" };
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

async function seedDraft(): Promise<{ draftId: string; avatarId: string }> {
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("seed") });
  const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
  const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
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

    // 4 × $0.03 + 4 age checks (658 in, 335 out; ceilings 2K in, 1K out) + the descriptor (900 in, 600 out; 2 × 5K in, 3K out) at $1/M in, $2/M out.
    expect(response.result).toEqual({
      expectedMicros: 4 * (30_000 + 1_328) + 2_100,
      worstMicros: 4 * (30_000 + 4_000) + 2 * 11_000,
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
    expect(ok(await engine.handle(command("avatars.estimate", { traits: TRAITS }))).result).toMatchObject({ worstMicros: 4 * (50_000 + 5_000) + 2 * ATTEMPT_WORST });
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
