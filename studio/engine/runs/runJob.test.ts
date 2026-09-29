import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvatarDescriptor, EngineError } from "../../shared/engine";
import { NoFaceInReferenceError } from "../face";
import { openLibrary, type Library } from "../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { Budget, scopeKey } from "../money/budget";
import { Ledger, type Scope } from "../money/ledger";
import { reconcile } from "../money/reconcile";
import { PriceBook } from "../money/prices";
import { chatBody, fakeFetch, imageBody, JPEG, makeClient, readLedgerLines, type FetchCall, type Reply } from "../openrouter/testing/fakes";
import type { ImageResult, OpenRouterClientOptions, OpenRouterFetch } from "../openrouter/types";
import { plan as planScenes, type PlanSlot } from "../scenes";
import { RunEventSchema, type RunEvent } from "./journal";
import { buildRunPlan, FALLBACK_IMAGE_MODEL, RunPlanSchema, runEstimate, type RunPlan } from "./plan";
import { CpuPool, NetworkPool } from "./pools";
import { GateFailure, QA_GATE_TIMEOUT_MS, type QaGate, type QaInput, type QaVerdict } from "./qa";
import { createAgeGate } from "./ageGate";
import { CANCELLED_GATE_TIMEOUT_MS, preflightMaster, reportingTo, runPhotoRun, type RunJobDeps, type RunJobEnd } from "./runJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Every test here writes a real library, journal and ledger. On a Windows runner, Defender or the indexer can
// hold a fresh file for seconds, which renameWithRetry is built to wait out (about 3 s per rename); Bun's
// default 5 s per test leaves no room for that. bunfig.toml's `timeout` is not applied by Bun, so the bound is set here.
setDefaultTimeout(30_000);

// T6: the photo run job — the writer phase, the prompts, then every slot's
// attempts through the network pool, the provider route, the QA gates and
// the library — against a real library and ledger in a temp dir, the real
// OpenRouter client (T3) over a fake fetch, and fake QA gates. Nothing
// reaches the network or spends money.

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const RUN_ID = "run-00000001";
const JOB_ID = "job-00000001";
const SCOPE: Scope = { runId: RUN_ID };
const PRIMARY = "x-ai/grok-imagine-image-2.0";
const TEXT = "x-ai/grok-4.3";
const DESCRIPTOR: AvatarDescriptor = {
  age: 25,
  text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.",
};
/** Fallback prices: the primary's attempt (low 1K + one reference) and the writer's (14K in, 8K out, T5c). */
const IMAGE_WORST = 50_000;
const WRITER_WORST = 37_500;
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const MODERATION: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };

let dir = "";
let library: Library;
let avatarId = "";
let ledger: Ledger;
let budget: Budget;
let mono = 0;
const caps = new Map<string, number>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-run-job-"));
  await mkdir(join(dir, "library"));
  library = await openTheLibrary();
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR.text });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  avatarId = avatar.id;
  mono = 0;
  caps.clear();
  ({ ledger, budget } = await openMoney(() => NOW));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `idPrefix` differs per process, so a reopened library never hands out an id the first one already used. */
async function openTheLibrary(idPrefix = "lib"): Promise<Library> {
  // The reference downscale is ffmpeg's in production; any JPEG will do for the client here.
  return (await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds(idPrefix), downscaleReference: async () => JPEG })).library;
}

/** A process's own ledger and Budget over the one ledger file; a scope's cap is whatever `caps` holds. */
async function openMoney(clock: () => number): Promise<{ ledger: Ledger; budget: Budget }> {
  const opened = await Ledger.open(join(dir, "ledger.jsonl"));
  return {
    ledger: opened,
    budget: new Budget(opened, { runCapMicros: (scope) => caps.get(scopeKey(scope)) ?? 0, monthlyBudgetMicros: 10_000_000, clock, monotonic: () => mono }),
  };
}

// ---------- the run ----------

async function newRun(count: number, opts: { cap?: number; imageModel?: string; avatar?: string } = {}): Promise<RunPlan> {
  const imageModel = opts.imageModel ?? PRIMARY;
  const runAvatar = opts.avatar ?? avatarId;
  const request = { avatarId: runAvatar, count, categories: ["home" as const], poses: { profile: false, back: false } };
  const estimated = runEstimate({ book: PriceBook.fallback(), asOf: "2026-09-24" }, { imageModel, textModel: TEXT }, request, "off").worstMicros;
  const cap = opts.cap ?? estimated;
  const run = buildRunPlan({
    runId: RUN_ID,
    avatarId: runAvatar,
    createdAt: new Date(NOW).toISOString(),
    request,
    imageAgeCheck: "off",
    models: { imageModel, textModel: TEXT },
    capMicros: cap,
    plannedWorstMicros: Math.max(cap, estimated),
    scenes: planScenes({ seed: 5, count, categories: ["home"] }),
  });
  await library.createRun(RUN_ID, run, RunPlanSchema);
  caps.set(scopeKey(SCOPE), cap);
  return run;
}

// ---------- the fake OpenRouter ----------

/** The slots a writer request asks about, read back from its own prompt. */
function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  const slots: { slotIndex: number }[] = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  return slots.map((s) => s.slotIndex);
}

function writerReply(call: FetchCall, cost = 0.0112): Reply {
  const scenes = slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (slot ${slotIndex})` }));
  return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost }) };
}

function imageReply(cost = 0.04): Reply {
  return { status: 200, body: imageBody(PNG_1X1, { cost }) };
}

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

/** A paid age gate's own request carries an image (image_url); the scene writer's never does. */
function isAgeCall(call: FetchCall): boolean {
  return call.url.endsWith("/chat/completions") && JSON.stringify(call.json()).includes("image_url");
}

function ageReply(cost = 0.001): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "Mature features of a woman in her mid-20s." }), { cost }) };
}

function network(opts: { image?: Handler; writer?: Handler; age?: Handler } = {}) {
  let images = 0;
  let writes = 0;
  let ages = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return (opts.image ?? (() => imageReply()))(call, ++images);
    if (isAgeCall(call)) return (opts.age ?? (() => ageReply()))(call, ++ages);
    if (call.url.endsWith("/chat/completions")) return (opts.writer ?? ((c) => writerReply(c)))(call, ++writes);
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    writerCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions") && !isAgeCall(c)),
    ageCalls: () => net.calls.filter(isAgeCall),
  };
}
type Network = ReturnType<typeof network>;

// ---------- gates ----------

function gate(
  name: string,
  decide: (input: QaInput, n: number) => QaVerdict | Promise<QaVerdict>,
  opts: { paid?: boolean; timeoutMs?: number } = {},
): QaGate & { inputs: QaInput[] } {
  const inputs: QaInput[] = [];
  return {
    name,
    paid: opts.paid ?? false,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    inputs,
    check: async (input) => {
      inputs.push(input);
      return decide(input, inputs.length);
    },
  };
}

// ---------- running it ----------

interface Harness {
  net: Network;
  pool: NetworkPool;
  progress: { done: number; total: number; photoId: string | null }[];
  /** Attempt ids the client actually sent, in order (a blocked or never-sent attempt is not here). */
  sent: string[];
  /** Attempt ids the job started (handed to the client, before its reserve), in order. */
  started: string[];
  end: Promise<RunJobEnd>;
}

function start(
  run: RunPlan,
  opts: {
    net?: Network;
    pool?: NetworkPool;
    gates?: QaGate[];
    signal?: AbortSignal;
    budget?: Budget;
    library?: RunJobDeps["library"];
    jobId?: string;
    generateImage?: RunJobDeps["generateImage"];
    /** Called as the job starts each attempt (it already holds its network slot). */
    onStart?: () => void;
    clientOverrides?: Partial<OpenRouterClientOptions>;
    cancelledGateTimeoutMs?: number;
    referenceTimeoutMs?: number;
    gateTimeout?: RunJobDeps["gateTimeout"];
  } = {},
): Harness {
  const net = opts.net ?? network();
  const pool = opts.pool ?? new NetworkPool({ max: 6 });
  const { client } = makeClient(reportingTo(pool, net.fetch), opts.clientOverrides);
  const sent: string[] = [];
  const started: string[] = [];
  const progress: Harness["progress"] = [];
  const spy: RunJobDeps["generateImage"] = async (params) => {
    opts.onStart?.();
    started.push(params.attemptId);
    const result: ImageResult = await client.generateImage(params);
    const dispatched = result.status !== "blocked" && !("ledger" in result && result.ledger.action === "released");
    if (dispatched) sent.push(params.attemptId);
    return result;
  };
  const end = runPhotoRun(
    {
      generateImage: opts.generateImage ?? spy,
      chat: client.chat,
      budget: opts.budget ?? budget,
      priceBook: PriceBook.fallback(),
      library: opts.library ?? library,
      pool,
      cpu: new CpuPool(2),
      gates: opts.gates ?? [],
      now: () => new Date(NOW),
      errorOf: (error: unknown): EngineError => ({ code: "INTERNAL", detail: error instanceof Error ? error.message : String(error) }),
      onSlot: (p) => progress.push(p),
      ...(opts.cancelledGateTimeoutMs === undefined ? {} : { cancelledGateTimeoutMs: opts.cancelledGateTimeoutMs }),
      ...(opts.referenceTimeoutMs === undefined ? {} : { referenceTimeoutMs: opts.referenceTimeoutMs }),
      ...(opts.gateTimeout === undefined ? {} : { gateTimeout: opts.gateTimeout }),
    },
    { plan: run, jobId: opts.jobId ?? JOB_ID, descriptor: DESCRIPTOR, signal: opts.signal ?? new AbortController().signal },
  );
  return { net, pool, progress, sent, started, end };
}

async function journal(lib: Library = library): Promise<RunEvent[]> {
  return (await lib.readJournal(RUN_ID, RunEventSchema)).events;
}

function ledgerLines(): Record<string, unknown>[] {
  return readLedgerLines(join(dir, "ledger.jsonl"));
}

function reservedIds(): string[] {
  return ledgerLines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
}

/** Everything the run's scope has committed now: settled costs plus open reserves at their worst case. */
function scopeCommitted(of: Ledger = ledger): number {
  const key = scopeKey(SCOPE);
  let total = 0;
  for (const line of of.lines) {
    if (line.type !== "settle") continue;
    const reserve = of.reserveOf(line.attemptId);
    if (reserve !== undefined && scopeKey(reserve.scope) === key) total += line.costMicros;
  }
  for (const reserve of of.openReserves()) if (scopeKey(reserve.scope) === key) total += reserve.worstMicros;
  return total;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/**
 * `end`, or "still running" after `ms`. The file's 30 s default timeout must not be what stops a test whose subject
 * is a short time bound: a bound that stops working shows here, well before that default, not as a slow pass. `ms`
 * leaves room for a Windows file-lock stall (renameWithRetry waits up to about 3 s) and is only the last resort:
 * where the bound is an injected timeout, the test reads it and fires it by hand instead.
 */
function endWithin<T>(end: Promise<T>, ms: number): Promise<T | "still running"> {
  return Promise.race([end, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), ms))]);
}

/** Gate timeouts that fire only when the test says so: a test that must order events against a timeout does not race a clock. */
function manualTimeouts() {
  const pending: { ms: number; fire: () => void }[] = [];
  const make: NonNullable<RunJobDeps["gateTimeout"]> = (ms) => {
    const controller = new AbortController();
    const entry = { ms, fire: () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")) };
    pending.push(entry);
    return {
      signal: controller.signal,
      clear: () => {
        const at = pending.indexOf(entry);
        if (at >= 0) pending.splice(at, 1);
      },
    };
  };
  return { pending, make };
}

/** Waits until the run's journal holds an attempt with this outcome. */
async function journalHas(outcome: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if ((await journal()).some((e) => e.type === "attempt" && e.outcome === outcome)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for an attempt journaled ${outcome}`);
}

function slotOf(run: RunPlan, slotIndex: number): PlanSlot {
  const slot = run.scenes.slots.find((s) => s.slotIndex === slotIndex);
  if (slot === undefined) throw new Error(`no slot ${slotIndex}`);
  return slot;
}

function modelOf(call: FetchCall): unknown {
  return call.json().model;
}

// ---------- the happy path ----------

describe("a run from the start", () => {
  test("stores one photo per slot under the slot's first attempt id, with its scene in the sidecar", async () => {
    const run = await newRun(3);
    const { end, sent } = start(run);

    const result = await end;

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.failedSlots).toBe(0);
    expect(result.photoIds).toHaveLength(3);
    expect(sent.sort()).toEqual([1, 2, 3].map((i) => `${RUN_ID}:slot-${i}#1`));
    const photos = result.photoIds.map((id) => library.getPhoto(id));
    expect(photos.map((p) => p?.source)).toEqual(
      [1, 2, 3].map((i) =>
        expect.objectContaining({ kind: "generated", model: PRIMARY, provider: "openrouter", jobId: JOB_ID, attemptId: `${RUN_ID}:slot-${i}#1`, slot: `slot-${i}`, category: "home", costMicros: 40_000 }),
      ),
    );
    // 2K removed (2026-09-29): a run photo's sidecar records no resolution.
    expect(photos.map((p) => p !== undefined && "resolution" in p)).toEqual([false, false, false]);
  });

  test("journals the writer's chunk, then the prompts, then each slot's attempt before its end, then the job's end", async () => {
    const run = await newRun(2);
    await start(run).end;

    const events = await journal();
    const label = (e: RunEvent): string =>
      e.type === "attempt" ? `attempt:${e.slotIndex}:${e.outcome}` : e.type === "slot" ? `slot:${e.slotIndex}:${e.status}` : e.type === "job" ? `job:${e.status}` : e.type;
    const labels = events.map(label);
    expect(labels.slice(0, 3)).toEqual(["job:started", "writer", "prompts"]);
    expect(labels.at(-1)).toBe("job:done");
    // Slots run concurrently, so their lines may interleave; each slot's own order is fixed.
    for (const slot of [1, 2]) {
      const own = labels.filter((l) => l.startsWith(`attempt:${slot}:`) || l.startsWith(`slot:${slot}:`));
      expect(own).toEqual([`attempt:${slot}:passed`, `slot:${slot}:done`]);
    }
    expect(labels).toHaveLength(8);
  });

  test("invariant 6: every slot's prompt is on disk before the first image request leaves", async () => {
    const run = await newRun(3);
    const onDiskAtFirstImage: string[] = [];
    const net = network({
      image: async (_call, n) => {
        if (n === 1) onDiskAtFirstImage.push(await readFile(join(dir, "library", "runs", RUN_ID, "journal.jsonl"), "utf8"));
        return imageReply();
      },
    });
    await start(run, { net }).end;

    const prompts = onDiskAtFirstImage[0]?.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "prompts");
    expect(prompts?.prompts.map((p: { slotIndex: number }) => p.slotIndex)).toEqual([1, 2, 3]);
  });

  test("each image request carries the assembled prompt (the descriptor's anchor and the writer's sentence) and the master as its one reference", async () => {
    const run = await newRun(1);
    const { net, end } = start(run);
    await end;
    const body = net.imageCalls()[0]?.json() ?? {};

    expect(body.prompt).toContain("25-year-old European woman");
    expect(body.prompt).toContain(`${SENTENCE} (slot 1)`);
    expect(body).toMatchObject({ model: PRIMARY, quality: "low", resolution: "1K", aspect_ratio: "9:16" });
    expect(Array.isArray(body.input_references) ? body.input_references.length : 0).toBe(1);
  });

  test("reports progress once per slot that ends", async () => {
    const run = await newRun(3);
    const { end, progress } = start(run);
    await end;
    expect(progress.map((p) => [p.done, p.total])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  test("records each stored photo's location and outfit in the avatar's scene history", async () => {
    const run = await newRun(2);
    await start(run).end;
    const recent = await library.recentPairs(avatarId, 10);
    expect(recent.map((e) => [e.location, e.outfit]).sort()).toEqual(run.scenes.slots.map((s) => [s.location, s.outfit]).sort());
  });
});

// ---------- the provider route ----------

describe("the provider route", () => {
  test("a moderation refusal on the primary sends the slot's next attempt to Seedream, once", async () => {
    const run = await newRun(1);
    const net = network({ image: (call) => (modelOf(call) === PRIMARY ? MODERATION : imageReply(0.045)) });
    const { end, sent } = start(run, { net });

    const result = await end;

    expect(sent).toEqual([`${RUN_ID}:slot-1#1`, `${RUN_ID}:slot-1#2`]);
    expect(net.imageCalls().map(modelOf)).toEqual([PRIMARY, FALLBACK_IMAGE_MODEL]);
    expect(net.imageCalls()[1]?.json().quality).toBeUndefined();
    if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);
    expect(library.getPhoto(result.photoIds[0] ?? "")?.source).toMatchObject({ model: FALLBACK_IMAGE_MODEL, attemptId: `${RUN_ID}:slot-1#2` });
  });

  test("a refusal on Seedream too ends the slot without a photo; its third id is never sent", async () => {
    const run = await newRun(1);
    const net = network({ image: () => MODERATION });
    const { end, sent } = start(run, { net });

    expect(await end).toEqual({ status: "done", photoIds: [], failedSlots: 1 });
    expect(sent).toEqual([`${RUN_ID}:slot-1#1`, `${RUN_ID}:slot-1#2`]);
    expect((await journal()).find((e) => e.type === "slot")).toMatchObject({ status: "failed", error: { code: "MODERATION_REFUSED" } });
  });

  test("the one fallback attempt is not retried after a QA failure; the slot ends", async () => {
    const run = await newRun(1);
    const net = network({ image: (call) => (modelOf(call) === PRIMARY ? MODERATION : imageReply(0.045)) });
    const qa = gate("face", () => ({ verdict: "retry", reason: "no face" }));
    const { end, sent } = start(run, { net, gates: [qa] });

    expect(await end).toMatchObject({ status: "done", photoIds: [], failedSlots: 1 });
    expect(sent).toHaveLength(2);
  });

  test("with Seedream as the image model there is no fallback: a refusal ends the slot at once", async () => {
    const run = await newRun(1, { imageModel: FALLBACK_IMAGE_MODEL });
    const net = network({ image: () => MODERATION });
    const { end, sent } = start(run, { net });

    expect(await end).toMatchObject({ status: "done", failedSlots: 1 });
    expect(sent).toEqual([`${RUN_ID}:slot-1#1`]);
  });

  test("a timeout moves the slot to its next id (the money model allows it) and leaves that reserve open at its worst case", async () => {
    const run = await newRun(1);
    const net = network({ image: (_call, n) => (n === 1 ? { hang: true } : imageReply()) });
    const { end, sent } = start(run, { net, clientOverrides: { timeoutMs: 30 } });

    expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(sent).toEqual([`${RUN_ID}:slot-1#1`, `${RUN_ID}:slot-1#2`]);
    expect(ledger.openReserves().map((r) => [r.attemptId, r.worstMicros])).toEqual([[`${RUN_ID}:slot-1#1`, IMAGE_WORST]]);
  });

  test("a fallback cancelled mid-flight closes its slot on resume, saying it was cancelled, not that it gave no usable photo", async () => {
    const run = await newRun(1);
    const controller = new AbortController();
    const net = network({ image: (call) => (modelOf(call) === PRIMARY ? MODERATION : { hang: true }) });
    const first = start(run, { net, signal: controller.signal });
    await until(() => net.imageCalls().length === 2, "the fallback's request");
    controller.abort(new Error("cancelled by the user"));
    expect(await first.end).toEqual({ status: "cancelled" });

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 1 });
    expect(resumed.sent).toEqual([]);
    const slotEnd = (await journal()).find((e) => e.type === "slot");
    expect(slotEnd).toMatchObject({ status: "failed", error: { code: "MODERATION_REFUSED" } });
    const detail = slotEnd?.type === "slot" ? (slotEnd.error?.detail ?? "") : "";
    expect(detail).toContain("cancelled before it answered");
    expect(detail).not.toContain("gave no usable photo");
  });
});

// ---------- failures that are no answer (review H1) ----------

describe("an attempt that got no answer stops the run with its slots open", () => {
  const RATE_LIMITED_120: Reply = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };
  const UNAVAILABLE: Reply = { status: 503, body: { error: { message: "upstream unavailable" } } };

  /** No slot ended, and no slot used more than one id. */
  async function expectOpenAndOneIdEach(run: RunPlan): Promise<void> {
    const events = await journal();
    expect(events.some((e) => e.type === "slot")).toBe(false);
    for (const slot of run.scenes.slots) expect(reservedIds().filter((id) => id.startsWith(`${RUN_ID}:${slot.attemptIdBase}#`)).length).toBeLessThanOrEqual(1);
  }

  test("a final 429 with Retry-After 120 s: the run stops at once with the wait, each slot in flight used one id, the rest none; a resume finishes it", async () => {
    const run = await newRun(4);
    const { end, net } = start(run, { net: network({ image: () => RATE_LIMITED_120 }), pool: new NetworkPool({ max: 2 }) });

    expect(await end).toEqual({ status: "failed", error: expect.objectContaining({ code: "RATE_LIMITED", retryAfterMs: 120_000 }) });
    expect(net.imageCalls()).toHaveLength(2);
    await expectOpenAndOneIdEach(run);

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(resumed.sent.sort()).toEqual([`${RUN_ID}:slot-1#2`, `${RUN_ID}:slot-2#2`, `${RUN_ID}:slot-3#1`, `${RUN_ID}:slot-4#1`]);
  });

  test("three 503s in a row (one attempt's transport retries): the run stops with NETWORK under one id; a resume finishes it", async () => {
    const run = await newRun(2);
    const { end, net } = start(run, { net: network({ image: () => UNAVAILABLE }), pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "NETWORK" } });
    expect(net.imageCalls()).toHaveLength(3);
    await expectOpenAndOneIdEach(run);

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(resumed.sent.sort()).toEqual([`${RUN_ID}:slot-1#2`, `${RUN_ID}:slot-2#1`]);
  });

  test("a fetch that always rejects: the run stops with NETWORK, the reserves in flight stay open at their worst case, and a resume finishes within the cap", async () => {
    const run = await newRun(3);
    const { end, net } = start(run, { net: network({ image: () => ({ reject: new TypeError("fetch failed") }) }), pool: new NetworkPool({ max: 2 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "NETWORK" } });
    expect(net.imageCalls()).toHaveLength(2);
    await expectOpenAndOneIdEach(run);
    expect(ledger.openReserves().map((r) => r.attemptId).sort()).toEqual([`${RUN_ID}:slot-1#1`, `${RUN_ID}:slot-2#1`]);

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(scopeCommitted()).toBeLessThanOrEqual(run.capMicros);
  });

  test("a writer whose prompt moderation refuses closes every slot: the run is not offered for resumes that would only burn its spare ids", async () => {
    const run = await newRun(2);
    const { end, net } = start(run, { net: network({ writer: () => MODERATION }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "MODERATION_REFUSED" } });
    expect(net.writerCalls()).toHaveLength(1);
    expect((await journal()).filter((e) => e.type === "slot").map((e) => (e.type === "slot" ? [e.status, e.error?.code] : null))).toEqual([
      ["failed", "MODERATION_REFUSED"],
      ["failed", "MODERATION_REFUSED"],
    ]);
  });

  test("a writer that gets a 503 three times stops the run before any image, every slot still open", async () => {
    const run = await newRun(2);
    const { end, net } = start(run, { net: network({ writer: () => UNAVAILABLE }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "NETWORK" } });
    expect(net.imageCalls()).toHaveLength(0);
    expect((await journal()).some((e) => e.type === "slot")).toBe(false);

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
  });

  test("a 4xx that is not a moderation refusal is our bug: fatal, and nothing more is sent", async () => {
    const run = await newRun(3);
    const { end, sent } = start(run, { net: network({ image: () => ({ status: 404, body: { error: { message: "No endpoints found" } } }) }), pool: new NetworkPool({ max: 1 }) });
    expect(await end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(sent).toHaveLength(1);
  });

  test("a request that cannot be built (NOT_SENT) is fatal: its reserve is released and nothing is sent", async () => {
    const run = await newRun(2);
    const pngReference = (await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("png"), downscaleReference: async () => PNG_1X1 })).library;
    const { end, net } = start(run, { library: pngReference, pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(net.imageCalls()).toHaveLength(0);
    expect(ledgerLines().filter((l) => typeof l.attemptId === "string" && l.attemptId.includes(":slot-")).map((l) => l.type)).toEqual(["reserve", "release"]);
  });

  // Review round 3 (a): a slot's spare ids absorb attempts that got no answer, so its three paid attempts survive them.
  test("two free failures in two jobs, then a slot still gets all three paid attempts: #3 and #4 retried by QA, #5 kept", async () => {
    const run = await newRun(1);
    const first = start(run, { net: network({ image: () => RATE_LIMITED_120 }) });
    expect(await first.end).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });
    const second = start(run, { net: network({ image: () => UNAVAILABLE }), jobId: "job-00000002" });
    expect(await second.end).toMatchObject({ status: "failed", error: { code: "NETWORK" } });

    const face = gate("face", (_i, n) => (n < 3 ? { verdict: "retry", reason: "mismatch" } : { verdict: "pass" }));
    const third = start(run, { gates: [face], jobId: "job-00000003" });
    const result = await third.end;

    expect(result).toMatchObject({ status: "done", failedSlots: 0 });
    expect(third.sent).toEqual([3, 4, 5].map((n) => `${RUN_ID}:slot-1#${n}`));
    if (result.status === "done") expect(library.getPhoto(result.photoIds[0] ?? "")?.source).toMatchObject({ attemptId: `${RUN_ID}:slot-1#5` });
  });

  test("three paid attempts close the slot even with spare ids left", async () => {
    const run = await newRun(1);
    const first = start(run, { net: network({ image: () => RATE_LIMITED_120 }) });
    await first.end;
    const face = gate("face", () => ({ verdict: "retry", reason: "mismatch" }));
    const second = start(run, { gates: [face], jobId: "job-00000002" });

    expect(await second.end).toMatchObject({ status: "done", failedSlots: 1 });
    expect(second.sent).toEqual([2, 3, 4].map((n) => `${RUN_ID}:slot-1#${n}`));
    expect(reservedIds()).not.toContain(`${RUN_ID}:slot-1#5`);
  });
});

// ---------- QA gates ----------

describe("QA gates", () => {
  test("a gate's retry consumes an attempt: after three, the slot ends without a photo and no fourth request is sent", async () => {
    const run = await newRun(1);
    const qa = gate("face", () => ({ verdict: "retry", reason: "no face" }));
    const { end, sent } = start(run, { gates: [qa] });

    expect(await end).toEqual({ status: "done", photoIds: [], failedSlots: 1 });
    expect(sent).toEqual([1, 2, 3].map((n) => `${RUN_ID}:slot-1#${n}`));
    expect(qa.inputs).toHaveLength(3);
    expect((await journal()).filter((e) => e.type === "attempt").map((e) => (e.type === "attempt" ? e.outcome : null))).toEqual(["qa-retry", "qa-retry", "qa-retry"]);
    expect((await journal()).find((e) => e.type === "slot")).toMatchObject({ status: "failed", error: { code: "QA_REJECTED" } });
  });

  test("a retry then a pass stores the second attempt's image, with every passing gate's qa fields in its sidecar", async () => {
    const run = await newRun(1);
    const face = gate("face", (_i, n) => (n === 1 ? { verdict: "retry", reason: "mismatch" } : { verdict: "pass", qa: { faceCos: 0.71, headRatio: 0.3 } }));
    const pdq = gate("pdq", () => ({ verdict: "pass", qa: { pdq: "c".repeat(64) } }));
    const { end } = start(run, { gates: [pdq, face] });

    const result = await end;
    if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);
    expect(library.getPhoto(result.photoIds[0] ?? "")).toMatchObject({
      source: { attemptId: `${RUN_ID}:slot-1#2` },
      qa: { pdq: "c".repeat(64), faceCos: 0.71, headRatio: 0.3 },
    });
  });

  test("gates see the slot, the attempt id and the image, and run in order: a failing first gate spares the second", async () => {
    const run = await newRun(1);
    const first = gate("pdq", () => ({ verdict: "reject", reason: "duplicate" }));
    const second = gate("face", () => ({ verdict: "pass" }));
    await start(run, { gates: [first, second] }).end;

    expect(first.inputs[0]).toMatchObject({ runId: RUN_ID, jobId: JOB_ID, avatarId, attemptId: `${RUN_ID}:slot-1#1`, scope: SCOPE, slot: slotOf(run, 1), image: { mediaType: "image/png", width: 1, height: 1 } });
    expect(first.inputs[0]?.budget).toBe(budget);
    expect(first.inputs[0]?.priceBook).toBeInstanceOf(PriceBook);
    expect(second.inputs).toHaveLength(0);
  });

  test("a gate's reject drops the photo and ends the slot without retrying", async () => {
    const run = await newRun(1);
    const qa = gate("age", () => ({ verdict: "reject", reason: "not clearly adult" }));
    const { end, sent } = start(run, { gates: [qa] });

    expect(await end).toEqual({ status: "done", photoIds: [], failedSlots: 1 });
    expect(sent).toHaveLength(1);
    expect(library.photosByAvatar(avatarId)).toHaveLength(1); // the master alone
    expect((await journal()).find((e) => e.type === "slot")).toMatchObject({ status: "failed", error: { code: "QA_REJECTED" } });
  });

  test("a later gate's retry releases an earlier passing gate's claim (T7a: a pdq pass is provisional until stored)", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq: QaGate & { releaseClaim(avatarId: string, attemptId: string): void } = {
      name: "pdq",
      paid: false,
      check: async () => ({ verdict: "pass", qa: { pdq: "a".repeat(64) } }),
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };
    const age = gate("age", (_i, n) => (n === 1 ? { verdict: "retry", reason: "not clearly adult" } : { verdict: "pass" }));
    const { end } = start(run, { gates: [pdq, age] });

    expect(await end).toMatchObject({ status: "done" });
    // T7a whole-slice review (finding 4) deliberately replaces this
    // assertion: the first attempt's claim is released because age retried
    // it; the SECOND attempt's own claim is ALSO released, now, once the
    // photo is stored — the library's own index carries the hash from then
    // on, so keeping the claim around would only ever be redundant (never
    // needed again), and a leaked claim on a resume in the same long-lived
    // engine process is worse than a redundant release.
    expect(released).toEqual([
      { avatarId, attemptId: `${RUN_ID}:slot-1#1` },
      { avatarId, attemptId: `${RUN_ID}:slot-1#2` },
    ]);
  });

  test("a later gate's reject also releases an earlier passing gate's claim, and ends the slot", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq: QaGate & { releaseClaim(avatarId: string, attemptId: string): void } = {
      name: "pdq",
      paid: false,
      check: async () => ({ verdict: "pass", qa: { pdq: "b".repeat(64) } }),
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };
    const age = gate("age", () => ({ verdict: "reject", reason: "not clearly adult" }));
    const { end } = start(run, { gates: [pdq, age] });

    expect(await end).toEqual({ status: "done", photoIds: [], failedSlots: 1 });
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-1#1` }]);
  });

  test("a gate that throws stops the run: the job fails and no request is sent after it", async () => {
    const run = await newRun(6);
    let callsAtThrow = -1;
    let harness: Harness | null = null;
    const qa = gate("face", () => {
      callsAtThrow = harness?.net.imageCalls().length ?? -1;
      throw new Error("the face model could not be loaded");
    });
    harness = start(run, { gates: [qa], pool: new NetworkPool({ max: 1 }) });

    expect(await harness.end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(callsAtThrow).toBeGreaterThan(0);
    // An attempt already reserved when the run stopped is asked beforeSend and released unsent (review L1).
    expect(harness.net.imageCalls()).toHaveLength(callsAtThrow);
    // An image already on its way when the run stopped is dropped: no gate (a paid one would be a new request) and no photo.
    expect(qa.inputs).toHaveLength(1);
    const outcomes = (await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []));
    expect(outcomes[0]).toBe("failed");
    expect(outcomes.slice(1).every((o) => o === "dropped" || o === "aborted")).toBe(true);
    expect(library.photosByAvatar(avatarId)).toHaveLength(1); // the master alone
  });

  test("a paid gate that ignores the cancel does not keep its network slot: the slot is freed as the cancel lands (review round 3, L-c)", async () => {
    const run = await newRun(1);
    const pool = new NetworkPool({ max: 2 });
    const controller = new AbortController();
    let checking = false;
    const stuck = gate(
      "age",
      () => {
        checking = true;
        return new Promise<QaVerdict>(() => {});
      },
      { paid: true },
    );
    const { end } = start(run, { gates: [stuck], pool, signal: controller.signal });
    await until(() => checking, "the paid gate's check");
    expect(pool.active).toBe(1);

    controller.abort(new Error("cancelled by the user"));
    expect(await end).toEqual({ status: "cancelled" });
    expect(pool.active).toBe(0);
  });

  test("a paid gate runs inside a network slot, a free one inside the CPU pool", async () => {
    const run = await newRun(1);
    const pool = new NetworkPool({ max: 2 });
    let activeInFree = -1;
    let activeInPaid = -1;
    const free = gate("pdq", () => {
      activeInFree = pool.active;
      return { verdict: "pass" };
    });
    const paid = gate(
      "age",
      () => {
        activeInPaid = pool.active;
        return { verdict: "pass" };
      },
      { paid: true },
    );
    await start(run, { gates: [free, paid], pool }).end;

    expect(activeInFree).toBe(0);
    expect(activeInPaid).toBe(1);
    expect(pool.active).toBe(0);
  });

  // Real clock, nothing injected: the PAID gate's own timeout through the production wiring (`timeoutSignal`). A
  // timeout that is never armed or is far too long ends at `endWithin`'s 10 s, not at the gate's 60 s fallback.
  test("real clock: a paid gate that outlives its own timeout is read as broken and the run fails naming that timeout", async () => {
    const run = await newRun(1);
    const hung = gate("age", () => new Promise<QaVerdict>(() => {}), { paid: true, timeoutMs: 50 });
    const { end } = start(run, { gates: [hung], pool: new NetworkPool({ max: 2 }) });

    const result = await endWithin(end, 10_000);
    expect(result).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    if (result === "still running" || result.status !== "failed") throw new Error("the paid gate's timeout never fired");
    expect(result.error.detail).toContain('the QA gate "age" could not run: it took longer than 50 ms');
  });

  test("a gate that outlives its timeout is read as broken: the run stops, nothing more is sent, and the image in flight then is dropped", async () => {
    const run = await newRun(3);
    const hung = gate("face", () => new Promise<QaVerdict>(() => {}), { timeoutMs: 30 });
    // No wall clock decides the order of events: the gate's timeout is fired by hand once slot 2's image is on its
    // way, and slot 2's answer is held until the run has stopped. Slot 3 waits for the network slot.
    const timeouts = manualTimeouts();
    let answerSlot2: () => void = () => {};
    const slot2Answer = new Promise<void>((resolve) => (answerSlot2 = resolve));
    const net = network({
      image: async (_call, n) => {
        if (n > 1) await slot2Answer;
        return imageReply();
      },
    });
    const { end } = start(run, { net, gates: [hung], pool: new NetworkPool({ max: 1 }), gateTimeout: timeouts.make });

    await until(() => net.imageCalls().length === 2 && timeouts.pending.length === 1, "slot 2's image on its way and the gate's timeout armed");
    expect(timeouts.pending[0]?.ms).toBe(30);
    timeouts.pending[0]?.fire();
    // The run stops (halt set) before the failed attempt is journaled, so once that line exists slot 2's image can only arrive late.
    await journalHas("failed");
    answerSlot2();

    const result = await end;
    expect(result).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(result.status === "failed" ? result.error.detail : "").toContain('the QA gate "face" could not run: it took longer than 30 ms');
    expect(net.imageCalls()).toHaveLength(2);
    expect(hung.inputs).toHaveLength(1);
    expect((await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []))).toEqual(["failed", "dropped"]);
  });

  test("a cancel while a gate runs drops the paid image (journaled dropped, never aborted) and leaves the slot open", async () => {
    const run = await newRun(1);
    const controller = new AbortController();
    let checking = false;
    const slow = gate("face", (input) => {
      checking = true;
      return new Promise<QaVerdict>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    });
    const { end } = start(run, { gates: [slow], signal: controller.signal });
    await until(() => checking, "the gate's check");
    controller.abort(new Error("cancelled by the user"));

    expect(await end).toEqual({ status: "cancelled" });
    const events = await journal();
    expect(events.filter((e) => e.type === "attempt").map((e) => (e.type === "attempt" ? e.outcome : null))).toEqual(["dropped"]);
    expect(events.some((e) => e.type === "slot")).toBe(false);
  });
});

// ---------- a start's own look at the master, before a run exists ----------

describe("preflightMaster (runs.start looks at the master before it plans anything)", () => {
  const face = (prepare: QaGate["prepare"]): QaGate => ({ name: "face", paid: false, ...(prepare === undefined ? {} : { prepare }), check: async () => ({ verdict: "pass" }) });
  const look = (gates: QaGate[], opts: { referenceTimeoutMs?: number; avatar?: string } = {}) =>
    preflightMaster({ library, gates, ...(opts.referenceTimeoutMs === undefined ? {} : { referenceTimeoutMs: opts.referenceTimeoutMs }) }, opts.avatar ?? avatarId, new AbortController().signal);

  test("a master with no usable face is MASTER_FACE_UNUSABLE, and nothing is written or spent", async () => {
    const calls: string[] = [];
    const result = await look([
      face(async (input) => {
        calls.push(input.avatarId);
        throw new NoFaceInReferenceError();
      }),
    ]);

    expect(result).toMatchObject({ ok: false, end: { status: "failed", error: { code: "MASTER_FACE_UNUSABLE" } } });
    expect(calls).toEqual([avatarId]);
    expect(ledgerLines()).toEqual([]);
  });

  test("a systemic prepare failure is INTERNAL, never MASTER_FACE_UNUSABLE", async () => {
    const result = await look([
      face(async () => {
        throw new Error("onnxruntime-web: session run failed");
      }),
    ]);

    expect(result).toMatchObject({ ok: false, end: { status: "failed", error: { code: "INTERNAL" } } });
  });

  test("a passing prepare() and a gate with none both pass", async () => {
    expect(await look([face(async () => undefined)])).toEqual({ ok: true });
    expect(await look([face(undefined)])).toEqual({ ok: true });
  });

  test("a decode failure on the original file is retried once on the downscaled reference, like the job's own prepare (M1)", async () => {
    const seen: number[] = [];
    const result = await look([
      face(async (input) => {
        seen.push(input.masterOriginal.length);
        if (seen.length === 1) throw new Error("Unsupported color conversion");
      }),
    ]);

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(JPEG.length);
  });

  test("an avatar with no master photo is NOT_FOUND", async () => {
    const bare = await library.createAvatar({ name: "Bare", age: 25, traits: {}, descriptor: DESCRIPTOR.text });
    expect(await look([face(async () => undefined)], { avatar: bare.id })).toMatchObject({ ok: false, end: { status: "failed", error: { code: "NOT_FOUND" } } });
  });

  test("bounded like the job's own prepare: a prepare() that never answers ends INTERNAL after the reference timeout", async () => {
    const result = await endWithin(look([face(() => new Promise<void>(() => undefined))], { referenceTimeoutMs: 40 }), 10_000);

    expect(result).toMatchObject({ ok: false, end: { status: "failed", error: { code: "INTERNAL", detail: expect.stringContaining("took longer than 40 ms") } } });
  });
});

// ---------- money review H1: a gate's prepare() runs before any paid work ----------

describe("prepare() (H1: a gate that cannot run for this avatar stops the job before any paid work)", () => {
  // N3: MASTER_FACE_UNUSABLE means specifically "no usable face in the
  // master" — pinned with the real NoFaceInReferenceError (face/gate.ts),
  // never a plain Error with a similar message (string-matching would be
  // fragile, and the whole point of N3 is that "looks like the same
  // message" is not how this is told apart from a systemic failure).
  function unusableFaceGate(prepareCalls: { avatarId: string }[]): QaGate {
    return {
      name: "face",
      paid: false,
      prepare: async (input) => {
        prepareCalls.push({ avatarId: input.avatarId });
        throw new NoFaceInReferenceError();
      },
      check: async () => {
        throw new Error("must not be called: prepare() should have stopped the job first");
      },
    };
  }

  // N3: a systemic prepare() failure (a decode/library/ORT problem, not
  // "this master has no face") must never be reported as MASTER_FACE_UNUSABLE
  // — that message tells the owner to fix the master, which may be fine.
  function brokenPrepareGate(): QaGate {
    return {
      name: "face",
      paid: false,
      prepare: async () => {
        throw new Error("onnxruntime-web: session run failed");
      },
      check: async () => {
        throw new Error("must not be called: prepare() should have stopped the job first");
      },
    };
  }

  test("on runs.start: MASTER_FACE_UNUSABLE, and 0 POSTs — no writer call, no image call", async () => {
    const run = await newRun(2);
    const prepareCalls: { avatarId: string }[] = [];
    const { end, net } = start(run, { gates: [unusableFaceGate(prepareCalls)] });

    expect(await end).toMatchObject({ status: "failed", error: { code: "MASTER_FACE_UNUSABLE" } });
    expect(net.calls).toHaveLength(0);
    expect(prepareCalls).toEqual([{ avatarId }]);
  });

  test("on runs.resume: the same avatar's master is still unusable, so the resume also ends MASTER_FACE_UNUSABLE with 0 POSTs", async () => {
    const run = await newRun(2);
    const prepareCalls: { avatarId: string }[] = [];
    const first = start(run, { gates: [unusableFaceGate(prepareCalls)] });
    expect(await first.end).toMatchObject({ status: "failed", error: { code: "MASTER_FACE_UNUSABLE" } });

    const resumed = start(run, { gates: [unusableFaceGate(prepareCalls)], jobId: "job-00000002" });

    expect(await resumed.end).toMatchObject({ status: "failed", error: { code: "MASTER_FACE_UNUSABLE" } });
    expect(resumed.net.calls).toHaveLength(0);
    expect(prepareCalls).toEqual([{ avatarId }, { avatarId }]);
  });

  // A run planned before runs.start looked at the master first can already be sitting on disk, open and resumable. A
  // master with no usable face never gets better, so its job ends the open slots: nothing is left to resume.
  test("MASTER_FACE_UNUSABLE ends the run's open slots failed, so it is no longer resumable, and the job still ends with that error", async () => {
    const run = await newRun(2);
    const { end, net } = start(run, { gates: [unusableFaceGate([])] });

    expect(await end).toMatchObject({ status: "failed", error: { code: "MASTER_FACE_UNUSABLE" } });
    expect(net.calls).toHaveLength(0);
    const slots = (await journal()).filter((e) => e.type === "slot");
    expect(slots.map((e) => [e.slotIndex, e.status, e.status === "failed" ? (e.error?.code ?? "") : ""])).toEqual([
      [1, "failed", "MASTER_FACE_UNUSABLE"],
      [2, "failed", "MASTER_FACE_UNUSABLE"],
    ]);
  });

  test("a systemic prepare failure leaves the slots open: the master may be fine, a resume can try again", async () => {
    const run = await newRun(2);
    const { end } = start(run, { gates: [brokenPrepareGate()] });

    expect(await end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect((await journal()).filter((e) => e.type === "slot")).toEqual([]);
  });

  test("a gate with no prepare (pdq, age) is unaffected: the run proceeds normally", async () => {
    const run = await newRun(1);
    const pdq = gate("pdq", () => ({ verdict: "pass", qa: { pdq: "d".repeat(64) } }));
    const { end } = start(run, { gates: [pdq] });

    expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
  });

  test("a passing prepare() lets the run proceed, and the gate's own check() still runs per photo", async () => {
    const run = await newRun(1);
    let prepareCalls = 0;
    const face: QaGate = {
      name: "face",
      paid: false,
      prepare: async () => {
        prepareCalls++;
      },
      check: async () => ({ verdict: "pass", qa: { faceCos: 0.9, headRatio: 0.3 } }),
    };
    const { end } = start(run, { gates: [face] });

    expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(prepareCalls).toBe(1);
  });

  test("N3: a systemic prepare() failure ends INTERNAL, never MASTER_FACE_UNUSABLE — the master may be fine", async () => {
    const run = await newRun(1);
    const { end, net } = start(run, { gates: [brokenPrepareGate()] });

    const result = await end;
    expect(result).toMatchObject({ status: "failed" });
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.code).not.toBe("MASTER_FACE_UNUSABLE");
    expect(net.calls).toHaveLength(0);
  });

  test("N3: prepareGates' own timeout is also systemic (INTERNAL), never MASTER_FACE_UNUSABLE", async () => {
    const run = await newRun(1);
    const hungGate: QaGate = {
      name: "face",
      paid: false,
      prepare: () => new Promise(() => {}), // never settles
      check: async () => ({ verdict: "pass" }),
    };
    const { end } = start(run, { gates: [hungGate], referenceTimeoutMs: 50 });

    const result = await endWithin(end, 10_000);
    expect(result).toMatchObject({ status: "failed" });
    if (result === "still running" || result.status !== "failed") throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.detail).toContain("50 ms");
  });

  test("N9: a cancel during prepare() ends the job cancelled, with 0 POSTs", async () => {
    const run = await newRun(1);
    let prepareStarted = false;
    const hungGate: QaGate = {
      name: "face",
      paid: false,
      prepare: async () => {
        prepareStarted = true;
        await new Promise(() => {}); // never settles on its own — only the job's own cancel ends it
      },
      check: async () => ({ verdict: "pass" }),
    };
    const controller = new AbortController();
    const { end, net } = start(run, { gates: [hungGate], signal: controller.signal });

    await until(() => prepareStarted, "prepare() to start");
    controller.abort(new Error("cancelled by the user"));

    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(0);
  });

  // 2b whole-slice review blocker: the CMYK/M1 fallback (masterOriginalFor's
  // own retry against loadMaster()'s <=1024px reference, when the original
  // master fails to DECODE rather than fails the format sniff) must not fire
  // once the job has already stopped sending — a gate's own prepare() runs
  // an embedding computation the caller's own signal does not actually stop
  // (T7b's H2/N11: the shared computation runs on its own internal
  // AbortController), so retrying it after a cancel starts real, wasted work
  // that outlives the job.
  test("a cancel during prepare must not start the CMYK/M1 fallback's own reference embedding a second time", async () => {
    const run = await newRun(1);
    const controller = new AbortController();
    let prepareCalls = 0;
    const face: QaGate = {
      name: "face",
      paid: false,
      prepare: async () => {
        prepareCalls++;
        await new Promise(() => {}); // never settles on its own — only the job's own cancel ends it
      },
      check: async () => ({ verdict: "pass" }),
    };
    const { end, net } = start(run, { gates: [face], signal: controller.signal });

    await until(() => prepareCalls === 1, "prepare() to start");
    controller.abort(new Error("cancelled by the user"));

    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(0);
    expect(prepareCalls).toBe(1);
  });

  test("N9: loadMasterOriginal() returning null ends NOT_FOUND, with 0 POSTs", async () => {
    const run = await newRun(1);
    const nullMasterLibrary: RunJobDeps["library"] = {
      appendJournal: library.appendJournal.bind(library),
      readJournal: library.readJournal.bind(library),
      addPhoto: library.addPhoto.bind(library),
      loadReference: library.loadReference.bind(library),
      loadMasterOriginal: async () => null,
      photosByAvatar: library.photosByAvatar.bind(library),
      appendHistory: library.appendHistory.bind(library),
    };
    const { end, net } = start(run, { library: nullMasterLibrary });

    const result = await end;
    expect(result).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    expect(net.calls).toHaveLength(0);
  });

  test("N9: loadMasterOriginal() throwing (a library I/O failure) ends INTERNAL, never MASTER_FACE_UNUSABLE, with 0 POSTs", async () => {
    const run = await newRun(1);
    const throwingMasterLibrary: RunJobDeps["library"] = {
      appendJournal: library.appendJournal.bind(library),
      readJournal: library.readJournal.bind(library),
      addPhoto: library.addPhoto.bind(library),
      loadReference: library.loadReference.bind(library),
      loadMasterOriginal: async () => {
        throw new Error("ENOENT: the master file is missing from disk");
      },
      photosByAvatar: library.photosByAvatar.bind(library),
      appendHistory: library.appendHistory.bind(library),
    };
    const { end, net } = start(run, { library: throwingMasterLibrary });

    const result = await end;
    expect(result).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error.code).not.toBe("MASTER_FACE_UNUSABLE");
    expect(net.calls).toHaveLength(0);
  });
});

// ---------- a fatal error does not waste images already paid for (review M1) ----------

describe("images that arrive after a fatal error elsewhere", () => {
  /** Slot 1's request answers a paid 2xx that cannot be used (fatal) at once; slot 2's image arrives just after. */
  function lateArrival() {
    return network({
      image: async (_call, n) => {
        if (n === 1) return { status: 200, body: "not an image" };
        await new Promise((resolve) => setTimeout(resolve, 40));
        return imageReply();
      },
    });
  }

  test("are still stored through free gates, and nothing new is sent", async () => {
    const run = await newRun(4);
    const pdq = gate("pdq", () => ({ verdict: "pass" }));
    const { end, net } = start(run, { net: lateArrival(), gates: [pdq], pool: new NetworkPool({ max: 2 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(net.imageCalls()).toHaveLength(2);
    expect(pdq.inputs).toHaveLength(1);
    expect(library.photosByAvatar(avatarId)).toHaveLength(2); // the master and the late arrival
    expect((await journal()).filter((e) => e.type === "slot")).toEqual([expect.objectContaining({ slotIndex: 2, status: "done" })]);
  });

  test("are dropped when a gate is paid: a paid gate would be a new request after the stop", async () => {
    const run = await newRun(4);
    const age = gate("age", () => ({ verdict: "pass" }), { paid: true });
    const { end } = start(run, { net: lateArrival(), gates: [age], pool: new NetworkPool({ max: 2 }) });

    expect(await end).toMatchObject({ status: "failed" });
    expect(age.inputs).toHaveLength(0);
    expect((await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []))).toContain("dropped");
    expect(library.photosByAvatar(avatarId)).toHaveLength(1);
  });

  test("a dropped image (a paid gate after the stop) also releases an earlier free gate's own claim", async () => {
    const run = await newRun(4);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq: QaGate & { releaseClaim(avatarId: string, attemptId: string): void } = {
      name: "pdq",
      paid: false,
      check: async () => ({ verdict: "pass", qa: { pdq: "d".repeat(64) } }),
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };
    const age = gate("age", () => ({ verdict: "pass" }), { paid: true });
    const { end } = start(run, { net: lateArrival(), gates: [pdq, age], pool: new NetworkPool({ max: 2 }) });

    await end;
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-2#1` }]);
  });

  test("a free gate that throws after another slot's own fatal image failure is recorded as broken (gatesBroken), never silently dropped (review M1)", async () => {
    const run = await newRun(3);
    const net = network({
      image: async (_call, n) => {
        if (n === 1) return { status: 402, body: { error: { message: "Insufficient credits" } } };
        if (n === 2) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return imageReply();
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
        return imageReply();
      },
    });
    const broken = gate("pdq", () => {
      throw new Error("decoder broke");
    });
    const { end } = start(run, { net, gates: [broken], pool: new NetworkPool({ max: 3 }) });

    // The run's own overall error stays the FIRST fatal reason (the 402, invariant: "the first
    // reason no attempt may start any more") — that part of the design is unchanged and correct.
    expect(await end).toMatchObject({ status: "failed", error: { code: "INSUFFICIENT_CREDITS" } });
    // gatesBroken stopped the third (later) image from ever being offered to the gate again.
    expect(broken.inputs).toHaveLength(1);
    const attempts = (await journal()).flatMap((e) => (e.type === "attempt" ? [e] : []));
    const outcomes = attempts.map((e) => e.outcome);
    expect(outcomes).toContain("dropped"); // the later image, correctly dropped once the gate is known broken
    // The gate's own throw is recorded on ITS OWN attempt, with its own error — never silently
    // discarded as "dropped" just because the run had already stopped sending for another reason.
    const brokenAttempt = attempts.find((e) => e.outcome === "failed" && e.error?.detail?.includes("decoder broke"));
    expect(brokenAttempt).toBeDefined();
    expect(brokenAttempt?.error?.code).toBe("INTERNAL");
  });

  test("an image billed above its worst case is kept, and the run stops with SETTLE_ABOVE_WORST", async () => {
    const run = await newRun(2);
    const { end, net } = start(run, { net: network({ image: () => imageReply(0.06) }), pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "SETTLE_ABOVE_WORST" } });
    expect(net.imageCalls()).toHaveLength(1);
    expect(library.photosByAvatar(avatarId)).toHaveLength(2);
  });
});

// ---------- the network pool ----------

describe("the network pool", () => {
  test("a 429 shrinks the pool: with three in flight and the limit down to two, one finishing does not let a fourth start", async () => {
    const run = await newRun(6);
    const pool = new NetworkPool({ max: 3 });
    // Every image request waits for the test to let it answer, except the third, which is rate limited at once
    // (Retry-After 0: the client retries it inside its own attempt, and that retry waits too).
    const gates: (() => void)[] = [];
    const net = network({
      image: async (_call, n) => {
        if (n === 3) return { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "rate limited" } } };
        await new Promise<void>((resolve) => gates.push(resolve));
        return imageReply();
      },
    });
    const { end, started, progress } = start(run, { net, pool });
    await until(() => net.imageCalls().length === 4 && gates.length === 3, "three requests in flight, the third one's retry among them");
    expect(started).toHaveLength(3);
    expect(pool.limit).toBe(2);

    // Slot 1 answers and ends. At the old limit of three its slot would start a fourth attempt; at two it must not.
    gates.shift()?.();
    await until(() => progress.length === 1, "slot 1's end");
    expect(pool.active).toBe(2);
    expect(started).toHaveLength(3);

    // The rest may go: the pool grows back as successes come in.
    const releaseAll = setInterval(() => {
      for (const release of gates.splice(0)) release();
    }, 1);
    try {
      expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
    } finally {
      clearInterval(releaseAll);
    }
  });

  test("reportingTo tells the pool every status the fetch gets back and passes the response through", async () => {
    const pool = new NetworkPool({ max: 2 });
    const inner: OpenRouterFetch = async () => ({ status: 429, headers: { get: () => null }, body: null });
    const response = await reportingTo(pool, inner)("https://openrouter.ai/api/v1/images", { method: "POST", headers: {}, redirect: "error", signal: new AbortController().signal });
    expect(response.status).toBe(429);
    expect(pool.limit).toBe(1);
  });
});

// ---------- cancel ----------

describe("cancel", () => {
  test("mid-flight: no request after the cancel, in-flight reserves stay open at their worst case, queued slots are never reserved", async () => {
    const run = await newRun(5);
    const controller = new AbortController();
    const net = network({ image: () => ({ hang: true }) });
    const { end } = start(run, { net, signal: controller.signal, pool: new NetworkPool({ max: 2 }) });
    await until(() => net.imageCalls().length === 2, "two image requests in flight");

    controller.abort(new Error("cancelled by the user"));
    const result = await end;

    expect(result).toEqual({ status: "cancelled" });
    expect(net.imageCalls()).toHaveLength(2);
    expect(reservedIds().filter((id) => id.includes(":slot-"))).toEqual([`${RUN_ID}:slot-1#1`, `${RUN_ID}:slot-2#1`]);
    expect(ledger.openReserves().map((r) => [r.attemptId, r.worstMicros])).toEqual([
      [`${RUN_ID}:slot-1#1`, IMAGE_WORST],
      [`${RUN_ID}:slot-2#1`, IMAGE_WORST],
    ]);
    expect(budget.inFlightCount()).toBe(0);
    const events = await journal();
    expect(events.filter((e) => e.type === "attempt").map((e) => (e.type === "attempt" ? e.outcome : null))).toEqual(["aborted", "aborted"]);
    expect(events.at(-1)).toMatchObject({ type: "job", status: "cancelled" });
  });

  test("before the first image: the writer's reserve stays open and no image is ever reserved", async () => {
    const run = await newRun(3);
    const controller = new AbortController();
    const net = network({ writer: () => ({ hang: true }) });
    const { end } = start(run, { net, signal: controller.signal });
    await until(() => net.writerCalls().length === 1, "the writer request");

    controller.abort(new Error("cancelled by the user"));

    expect(await end).toEqual({ status: "cancelled" });
    expect(net.imageCalls()).toHaveLength(0);
    expect(ledger.openReserves().map((r) => [r.attemptId, r.worstMicros])).toEqual([[`${RUN_ID}:writer-1#1`, WRITER_WORST]]);
  });

  // Review round 3 (b): an image paid for when the user cancels is kept, through free gates only.
  /** A client whose first image arrives just as the user cancels: the 2xx is settled, then the cancel lands. */
  function cancelAsFirstImageArrives(controller: AbortController): RunJobDeps["generateImage"] {
    const { client } = makeClient(network().fetch);
    let first = true;
    return async (params) => {
      const result = await client.generateImage(params);
      if (first && result.status === "ok") {
        first = false;
        controller.abort(new Error("cancelled by the user"));
      }
      return result;
    };
  }

  test("an image that arrives as the user cancels is still kept: its free gates run, not aborted by the cancel", async () => {
    const run = await newRun(2);
    const controller = new AbortController();
    const abortedDuringCheck: boolean[] = [];
    const pdq = gate("pdq", (input) => {
      abortedDuringCheck.push(input.signal.aborted);
      return { verdict: "pass", qa: { pdq: "d".repeat(64) } };
    });
    const { end, net } = start(run, { gates: [pdq], signal: controller.signal, pool: new NetworkPool({ max: 1 }), generateImage: cancelAsFirstImageArrives(controller) });

    expect(await end).toEqual({ status: "cancelled" });
    expect(abortedDuringCheck).toEqual([false]);
    expect(library.photosByAvatar(avatarId)).toHaveLength(2); // the master and the kept image
    expect((await journal()).filter((e) => e.type === "slot")).toEqual([expect.objectContaining({ slotIndex: 1, status: "done" })]);
    expect(net.imageCalls()).toHaveLength(0); // slot 2 never started: nothing is sent after the cancel
  });

  test("...but it is dropped when a paid gate is registered: after a cancel nothing more is sent, and invariant 8 needs every gate", async () => {
    const run = await newRun(2);
    const controller = new AbortController();
    const age = gate("age", () => ({ verdict: "pass" }), { paid: true });
    const { end } = start(run, { gates: [age], signal: controller.signal, pool: new NetworkPool({ max: 1 }), generateImage: cancelAsFirstImageArrives(controller) });

    expect(await end).toEqual({ status: "cancelled" });
    expect(age.inputs).toHaveLength(0);
    expect(library.photosByAvatar(avatarId)).toHaveLength(1);
    expect((await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []))).toEqual(["dropped"]);
  });

  test("a free gate that hangs after the cancel is cut off by its own short timeout: the image is dropped and the run ends cancelled", async () => {
    const run = await newRun(2);
    const controller = new AbortController();
    const hung = gate("face", () => new Promise<QaVerdict>(() => {}), { timeoutMs: 30 });
    // The bound is read off the timeout the job arms, and fired by hand: no clock, and no Windows file-lock stall, decides the test.
    const timeouts = manualTimeouts();
    const { end } = start(run, { gates: [hung], signal: controller.signal, pool: new NetworkPool({ max: 1 }), generateImage: cancelAsFirstImageArrives(controller), gateTimeout: timeouts.make });

    await until(() => timeouts.pending.length === 1, "the gate's timeout to be armed after the cancel");
    expect(timeouts.pending[0]?.ms).toBe(30);
    timeouts.pending[0]?.fire();
    expect(await endWithin(end, 10_000)).toEqual({ status: "cancelled" });
    expect(hung.inputs).toHaveLength(1);
    expect((await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []))).toEqual(["dropped"]);
  });

  // Final review LOW-1: a free gate with no timeout of its own gets the gates' default (60 s), which the
  // after-cancel bound must cut short: a hung gate may not hold the end of a cancelled job.
  test("a free gate with no timeout of its own that hangs after the cancel is cut off by the after-cancel bound, not the gates' default", async () => {
    const run = await newRun(2);
    const controller = new AbortController();
    const hung = gate("face", () => new Promise<QaVerdict>(() => {}));
    const timeouts = manualTimeouts();
    const { end } = start(run, {
      gates: [hung],
      signal: controller.signal,
      pool: new NetworkPool({ max: 1 }),
      generateImage: cancelAsFirstImageArrives(controller),
      cancelledGateTimeoutMs: 50,
      gateTimeout: timeouts.make,
    });

    await until(() => timeouts.pending.length === 1, "the gate's timeout to be armed after the cancel");
    expect(timeouts.pending[0]?.ms).toBe(50); // the after-cancel bound, not the gates' 60 s default
    timeouts.pending[0]?.fire();
    expect(await endWithin(end, 10_000)).toEqual({ status: "cancelled" });
    expect((await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []))).toEqual(["dropped"]);
  });

  // The two tests above read the bound off an injected timeout. This one injects nothing: it runs the production
  // wiring (`timeoutSignal`, a ref'd real timer) and the real clock, so a bound that is never armed, an unref'd timer,
  // or a fallback of 60 s shows here. 10 s leaves room for a Windows file-lock stall and is far under that fallback.
  test("real clock: a free gate with no timeout of its own that hangs after the cancel is cut off by the production after-cancel bound", async () => {
    const run = await newRun(2);
    const controller = new AbortController();
    const hung = gate("face", () => new Promise<QaVerdict>(() => {}));
    const { end } = start(run, {
      gates: [hung],
      signal: controller.signal,
      pool: new NetworkPool({ max: 1 }),
      generateImage: cancelAsFirstImageArrives(controller),
      cancelledGateTimeoutMs: 50,
    });

    expect(await endWithin(end, 10_000)).toEqual({ status: "cancelled" });
    expect((await journal()).flatMap((e) => (e.type === "attempt" ? [e.outcome] : []))).toEqual(["dropped"]);
  });

  test("the after-cancel bound is short: five seconds, far under the gates' default", () => {
    expect(CANCELLED_GATE_TIMEOUT_MS).toBe(5_000);
    expect(CANCELLED_GATE_TIMEOUT_MS).toBeLessThan(QA_GATE_TIMEOUT_MS);
  });
});

// ---------- money ----------

describe("the run's cap", () => {
  /** One slot whose every image fails QA: the writer (settled at exactly its worst case) and three image attempts (each billed at its worst). */
  async function capRun(cap: number) {
    const run = await newRun(1, { cap });
    const net = network({ image: () => imageReply(IMAGE_WORST / 1_000_000), writer: (call) => writerReply(call, WRITER_WORST / 1_000_000) });
    const qa = gate("face", () => ({ verdict: "retry", reason: "no face" }));
    return start(run, { net, gates: [qa] });
  }

  test("exactly at the cap every allowed attempt is sent", async () => {
    const { end, sent } = await capRun(WRITER_WORST + 3 * IMAGE_WORST);
    expect(await end).toMatchObject({ status: "done", failedSlots: 1 });
    expect(sent).toHaveLength(3);
    expect(scopeCommitted()).toBe(WRITER_WORST + 3 * IMAGE_WORST);
  });

  test("one micro under it, the last attempt is refused before it is sent and the run stops with RUN_CAP_EXCEEDED", async () => {
    const cap = WRITER_WORST + 3 * IMAGE_WORST - 1;
    const { end, sent } = await capRun(cap);
    expect(await end).toMatchObject({ status: "failed", error: { code: "RUN_CAP_EXCEEDED" } });
    expect(sent).toHaveLength(2);
    expect(reservedIds()).not.toContain(`${RUN_ID}:slot-1#3`);
    expect(scopeCommitted()).toBeLessThanOrEqual(cap);
  });

  test("six slots in flight racing for the last of the cap: exactly what fits is reserved, never one more", async () => {
    const cap = WRITER_WORST + 4 * IMAGE_WORST;
    const run = await newRun(6, { cap });
    let inFlight = 0;
    let peak = 0;
    // A barrier: no reply until four requests are in flight together (bounded, should fewer ever arrive).
    const waiting: (() => void)[] = [];
    const net = network({
      image: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
          if (waiting.length >= 4) for (const release of waiting.splice(0)) release();
        });
        inFlight--;
        return imageReply(IMAGE_WORST / 1_000_000);
      },
      writer: (call) => writerReply(call, WRITER_WORST / 1_000_000),
    });
    const { end, sent } = start(run, { net, pool: new NetworkPool({ max: 6 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "RUN_CAP_EXCEEDED" } });
    expect(sent).toHaveLength(4);
    expect(peak).toBe(4);
    expect(scopeCommitted()).toBe(cap);
  });

  test("a moderation refusal is settled at zero, so a slot's fallback still fits the room its refusal held", async () => {
    // Writer + one image at the worst case exactly: the refusal's reserve is released by its free settle.
    const cap = WRITER_WORST + IMAGE_WORST;
    const run = await newRun(1, { cap });
    const net = network({ image: (call) => (modelOf(call) === PRIMARY ? MODERATION : imageReply(0.045)), writer: (call) => writerReply(call, WRITER_WORST / 1_000_000) });
    const { end, sent } = start(run, { net });

    expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(sent).toHaveLength(2);
    expect(scopeCommitted()).toBeLessThanOrEqual(cap);
  });
});

// ---------- failures ----------

describe("failures", () => {
  test("a writer chunk rejected on every attempt fails the run cleanly: no image request, the writer's money stays settled", async () => {
    const run = await newRun(3);
    const net = network({ writer: () => ({ status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) }) });
    const { end } = start(run, { net });

    expect(await end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(net.imageCalls()).toHaveLength(0);
    expect(ledgerLines().filter((l) => l.type === "settle").map((l) => [l.attemptId, l.costMicros])).toEqual([
      [`${RUN_ID}:writer-1#1`, 2_000],
      [`${RUN_ID}:writer-1#2`, 2_000],
    ]);
    expect(ledger.openReserves()).toEqual([]);
    expect((await journal()).some((e) => e.type === "prompts")).toBe(false);
    // No job will ever write that chunk: its slots end, so the run is not offered for a resume that cannot help.
    expect((await journal()).filter((e) => e.type === "slot").map((e) => (e.type === "slot" ? e.status : null))).toEqual(["failed", "failed", "failed"]);
  });

  test("a fatal error (401) stops the run: no new request after it", async () => {
    const run = await newRun(4);
    const net = network({ image: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const { end, sent } = start(run, { net, pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "AUTH_INVALID" } });
    expect(sent).toHaveLength(1);
  });

  test("an avatar without a usable master (a draft) fails the run before anything is sent", async () => {
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR.text });
    const run = await newRun(2, { avatar: draft.id });
    const { end, net } = start(run);

    expect(await end).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    expect(net.calls).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
  });

  test("a master whose file no longer matches its sidecar fails the run before anything is sent", async () => {
    const run = await newRun(2);
    const master = library.getAvatar(avatarId)?.masterPhotoId ?? "";
    const photo = library.getPhoto(master);
    await writeFile(join(dir, "library", "avatars", avatarId, "photos", photo?.file ?? ""), "rotten");
    const { end, net } = start(run);

    expect(await end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(net.calls).toHaveLength(0);
  });
});

// ---------- crash and resume ----------

describe("crash and resume", () => {
  test("after an abrupt stop mid-run and a resume, no attempt id is sent twice and the run's cap is never passed", async () => {
    const run = await newRun(4);
    const cap = run.capMicros;

    // Process A: the first two images arrive; the next two are in flight when the process dies.
    const sentA: string[] = [];
    const netA = network();
    const clientA = makeClient(netA.fetch).client;
    let images = 0;
    const dying: RunJobDeps["generateImage"] = async (params) => {
      if (++images <= 2) {
        const result = await clientA.generateImage(params);
        sentA.push(params.attemptId);
        return result;
      }
      // What the client does before its request leaves: the reserve, on disk. Then the process is gone.
      const reserved = await params.budget.tryReserve({ attemptId: params.attemptId, jobId: params.jobId, scope: params.scope, model: params.model, worstMicros: IMAGE_WORST });
      if (!reserved.ok) throw new Error("the reserve was refused");
      sentA.push(params.attemptId);
      return new Promise<ImageResult>(() => {});
    };
    const a = start(run, { generateImage: dying, pool: new NetworkPool({ max: 2 }) });
    void a.end;
    await until(() => sentA.length === 4, "four image requests from process A");
    await until(() => library.photosByAvatar(avatarId).length === 3, "two photos stored by process A");

    // Process B: a fresh ledger, Budget and library over the same files. Its
    // wall clock is later; the open reserves wait for a reconcile first (invariant 4).
    const later = () => NOW + 10 * 60_000;
    const b = await openMoney(later);
    expect(await b.budget.tryReserve({ attemptId: "probe", jobId: "probe", scope: SCOPE, model: PRIMARY, worstMicros: 1 })).toMatchObject({ ok: false, reason: "RECONCILE_REQUIRED" });
    mono = 10 * 60_000;
    const reconciled = await reconcile(b.budget, { fetchCredits: async () => ({ data: { total_usage: 1 } }) });
    expect(reconciled.ok && [...reconciled.closedAttempts].sort()).toEqual([`${RUN_ID}:slot-3#1`, `${RUN_ID}:slot-4#1`]);
    const libraryB = await openTheLibrary("libb");

    const resumed = start(run, { budget: b.budget, library: libraryB, jobId: "job-00000002" });
    const result = await resumed.end;

    const everySent = [...sentA, ...resumed.sent];
    expect(new Set(everySent).size).toBe(everySent.length);
    expect(resumed.sent.sort()).toEqual([`${RUN_ID}:slot-3#2`, `${RUN_ID}:slot-4#2`]);
    expect(resumed.net.writerCalls()).toHaveLength(0);
    expect(result).toMatchObject({ status: "done", failedSlots: 0 });
    if (result.status === "done") expect(result.photoIds).toHaveLength(4);
    expect(resumed.progress.map((p) => [p.done, p.total])).toEqual([
      [3, 4],
      [4, 4],
    ]);
    expect(scopeCommitted(b.ledger)).toBeLessThanOrEqual(cap);
  });

  test("a resume after a crash before the prompts were written asks the writer again under its next id, from the persisted plan", async () => {
    const run = await newRun(2);
    // Process A reserved the writer's first attempt and died.
    const reserved = await budget.tryReserve({ attemptId: `${RUN_ID}:writer-1#1`, jobId: JOB_ID, scope: SCOPE, model: TEXT, worstMicros: WRITER_WORST });
    if (!reserved.ok) throw new Error("the reserve was refused");
    const b = await openMoney(() => NOW + 10 * 60_000);
    mono = 10 * 60_000;
    await reconcile(b.budget, { fetchCredits: async () => ({ data: { total_usage: 1 } }) });

    const resumed = start(run, { budget: b.budget, library: await openTheLibrary("libb"), jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });

    expect(reservedIds().filter((id) => id.includes(":writer-"))).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-1#2`]);
    const asked = resumed.net.writerCalls()[0];
    expect(asked === undefined ? [] : slotsAskedFor(asked)).toEqual(run.scenes.slots.map((s) => s.slotIndex));
  });

  /** A first job that wrote the prompts and was cancelled with its one image in flight. */
  async function cancelledAfterPrompts(run: RunPlan): Promise<void> {
    const controller = new AbortController();
    const net = network({ image: () => ({ hang: true }) });
    const first = start(run, { net, signal: controller.signal });
    await until(() => net.imageCalls().length === 1, "the image request");
    controller.abort(new Error("cancelled by the user"));
    await first.end;
  }

  test("review L3: a resume re-assembles every prompt from the journal's writer sentences; a prompt edited in the journal is never sent", async () => {
    const run = await newRun(1);
    await cancelledAfterPrompts(run);
    await library.appendJournal(RUN_ID, { type: "prompts", prompts: [{ slotIndex: 1, prompt: "TAMPERED prompt from the journal" }], at: new Date(NOW).toISOString() }, RunEventSchema);

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    const prompt = resumed.net.imageCalls()[0]?.json().prompt;
    expect(prompt).not.toContain("TAMPERED");
    expect(prompt).toContain(`${SENTENCE} (slot 1)`);
  });

  test("review L3: a writer sentence edited in the journal to break today's rules stops the resume before anything is sent", async () => {
    const run = await newRun(1);
    await cancelledAfterPrompts(run);
    await library.appendJournal(RUN_ID, { type: "writer", chunk: 1, sentences: [{ slotIndex: 1, sentence: "A teenage girl laughs at the kitchen counter." }], at: new Date(NOW).toISOString() }, RunEventSchema);

    const resumed = start(run, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(resumed.net.calls).toHaveLength(0);
  });

  test("review L15: a crash between a refusal's settle and its journal line never resends that prompt to the primary", async () => {
    const run = await newRun(1);
    const clientA = makeClient(network({ image: () => MODERATION }).fetch).client;
    const dying: RunJobDeps["generateImage"] = async (params) => {
      const result = await clientA.generateImage(params);
      // The refusal is settled in the ledger; the process dies before the journal hears of it.
      return result.status === "refused" ? new Promise<ImageResult>(() => {}) : result;
    };
    const a = start(run, { generateImage: dying });
    void a.end;
    await until(() => ledger.closeOf(`${RUN_ID}:slot-1#1`) !== undefined, "the refusal's settle");

    const resumed = start(run, { jobId: "job-00000002", net: network({ image: () => imageReply(0.045) }) });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(resumed.net.imageCalls().map(modelOf)).toEqual([FALLBACK_IMAGE_MODEL]);
    expect(resumed.sent).toEqual([`${RUN_ID}:slot-1#2`]);
  });
});

// ---------- T7a whole-slice review: a paid gate's own queue wait must not count against its timeout (finding 1) ----------

describe("a paid gate's timeout starts only once it actually has a network slot", () => {
  test("repro A: pool 1, 3 slots, a 60 ms image and a 100 ms gate timeout — the gate's own instant check must not be timed out by the FIFO wait behind other slots' images", async () => {
    const run = await newRun(3);
    const paid: QaGate = { name: "age", paid: true, timeoutMs: 100, check: async () => ({ verdict: "pass" }) };
    const net = network({
      image: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return imageReply();
      },
    });
    const { end } = start(run, { net, gates: [paid], pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
  });
});

// ---------- T7a whole-slice review: no paid gate request once the run stopped sending (finding 3) ----------

describe("a paid gate re-checks sending() the moment its network slot is granted", () => {
  test("repro B: a fatal error on slot 2's image while slot 1's gate is still queued means no age request for slot 1", async () => {
    const run = await newRun(2);
    const pool = new NetworkPool({ max: 1 });
    let calls = 0;
    const paid: QaGate = {
      name: "age",
      paid: true,
      check: async () => {
        calls++;
        return { verdict: "pass" };
      },
    };
    const net = network({
      image: async (_call, n) => {
        if (n === 1) return imageReply();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: 402, body: { error: { message: "Insufficient credits" } } };
      },
    });
    const { end } = start(run, { net, gates: [paid], pool });

    expect(await end).toMatchObject({ status: "failed", error: { code: "INSUFFICIENT_CREDITS" } });
    // Slot 1's image already succeeded and paid; its gate must never have been asked to run,
    // since by the time it could get a network slot, slot 2's failure had already stopped the run.
    expect(calls).toBe(0);
  });
});

// ---------- T7a whole-slice review: a paid gate's own failure, classified like an image's (findings 2, 6, 7, 8) ----------

describe("GateFailure: a paid gate's own systemic or transient failure", () => {
  function paidThatThrows(error: EngineError): QaGate {
    return { name: "age", paid: true, check: async () => { throw new GateFailure(error); } };
  }

  test("AUTH_INVALID stops the whole run, its code preserved (not collapsed to INTERNAL), and the slot stays open for a resume", async () => {
    const run = await newRun(2);
    const gate = paidThatThrows({ code: "AUTH_INVALID", detail: "the stored key was rejected" });
    const { end } = start(run, { gates: [gate], pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "AUTH_INVALID" } });
    // Neither slot ended: both stay open for a resume, exactly like an image attempt's own fatal error.
    expect((await journal()).some((e) => e.type === "slot")).toBe(false);
  });

  test("a limit failure (RUN_CAP_EXCEEDED) leaves this slot open without stopping other slots (mirrors ctx.limited for images)", async () => {
    const run = await newRun(2);
    let n = 0;
    const gate: QaGate = {
      name: "age",
      paid: true,
      check: async () => {
        n++;
        if (n === 1) throw new GateFailure({ code: "RUN_CAP_EXCEEDED", detail: "no room left in the run's cap" });
        return { verdict: "pass" };
      },
    };
    const { end } = start(run, { gates: [gate], pool: new NetworkPool({ max: 2 }) });

    const result = await end;
    // The run overall failed (one slot never got a photo), but the OTHER slot completed normally —
    // a limit failure must not halt sending for every slot the way a fatal one does.
    expect(result).toMatchObject({ status: "failed" });
    expect(library.photosByAvatar(avatarId)).toHaveLength(2); // the master, and the one slot that got through
  });

  test("BUDGET_EXCEEDED behaves the same way as RUN_CAP_EXCEEDED: a limit, not a run-wide halt", async () => {
    const run = await newRun(1);
    const gate = paidThatThrows({ code: "BUDGET_EXCEEDED", detail: "the month has no room left" });
    const { end } = start(run, { gates: [gate], pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed" });
    expect((await journal()).some((e) => e.type === "slot")).toBe(false); // stayed open, not QA_REJECTED
  });
});

// ---------- T7a re-review (finding L1): the halt from a paid gate's own attempt must be noticed before its network slot is released ----------

describe("a paid gate's own halt is decided before its network slot is released", () => {
  test("above-worst on slot 1's age check: slot 2's own age gate is never even invoked — dropped, not a failed reserve attempt of its own", async () => {
    const run = await newRun(2);
    const net = network({ age: (_call, n) => (n === 1 ? ageReply(50) : ageReply()) });
    const { end } = start(run, { net, gates: [createAgeGate({ downscale: async () => JPEG })], pool: new NetworkPool({ max: 1 }) });

    expect(await end).toMatchObject({ status: "failed", error: { code: "SETTLE_ABOVE_WORST" } });
    const attempts = (await journal()).flatMap((e) => (e.type === "attempt" ? [e] : []));
    const slot2 = attempts.find((e) => e.slotIndex === 2);
    // Had the halt only been noticed AFTER slot 1's network slot was released (T6 review round 3's own
    // bug this re-review caught), slot 2's gate could have grabbed that freed slot and reached its own
    // reserve attempt before the halt was visible — recorded as "failed" with SETTLE_ABOVE_WORST, not
    // "dropped". T6's own rule: decide synchronously right after the result, before anything else awaits.
    expect(slot2?.outcome).toBe("dropped");
    expect(slot2?.error).toBeUndefined();
  });
});

// ---------- T7a whole-slice review: a passed gate's claim is released after every attempt, whatever the outcome (finding 4) ----------

describe("a passed gate's claim is always released once its attempt is decided", () => {
  function releasableGate(verdicts: (() => QaVerdict | Promise<QaVerdict>) | QaVerdict, released: { avatarId: string; attemptId: string }[]): QaGate {
    return {
      name: "pdq",
      paid: false,
      check: async () => (typeof verdicts === "function" ? verdicts() : verdicts),
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };
  }

  test("released after a successful store, not only on a later rejection: the claims map ends empty either way", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq = releasableGate({ verdict: "pass", qa: { pdq: "e".repeat(64) } }, released);
    const { end } = start(run, { gates: [pdq] });

    expect(await end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-1#1` }]);
  });

  test("released when a cancel drops the image while a later paid gate runs", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq = releasableGate({ verdict: "pass" }, released);
    const controller = new AbortController();
    let checking = false;
    const slow: QaGate = {
      name: "age",
      paid: true,
      check: async () => {
        checking = true;
        return new Promise<QaVerdict>(() => {});
      },
    };
    const { end } = start(run, { gates: [pdq, slow], signal: controller.signal });
    await until(() => checking, "the paid gate's check");
    controller.abort(new Error("cancelled by the user"));

    expect(await end).toEqual({ status: "cancelled" });
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-1#1` }]);
  });

  test("released when a later gate throws unexpectedly (GateBroken)", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq = releasableGate({ verdict: "pass" }, released);
    const broken = gate("face", () => {
      throw new Error("the face model could not be loaded");
    });
    const { end } = start(run, { gates: [pdq, broken] });

    expect(await end).toMatchObject({ status: "failed" });
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-1#1` }]);
  });

  test("released even when storing the photo itself fails (addPhoto throws)", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    const pdq = releasableGate({ verdict: "pass" }, released);
    const throwingLibrary: RunJobDeps["library"] = {
      appendJournal: library.appendJournal.bind(library),
      readJournal: library.readJournal.bind(library),
      addPhoto: () => Promise.reject(new Error("disk is full")),
      loadReference: library.loadReference.bind(library),
      loadMasterOriginal: library.loadMasterOriginal.bind(library),
      photosByAvatar: library.photosByAvatar.bind(library),
      appendHistory: library.appendHistory.bind(library),
    };
    const { end } = start(run, { gates: [pdq], library: throwingLibrary });

    expect(await end).toMatchObject({ status: "failed" });
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-1#1` }]);
  });

  test("T7a re-review (finding L8): a gate that never even ran for this attempt still gets releaseClaim called (a no-op) — release does not rely on the `passed` list alone", async () => {
    const run = await newRun(1);
    const released: { avatarId: string; attemptId: string }[] = [];
    // The earlier gate rejects immediately, so this one is never invoked at all for this attempt.
    const rejecting = gate("pdq", () => ({ verdict: "reject", reason: "not adult" }));
    const neverRan: QaGate = {
      name: "age",
      paid: true,
      check: async () => {
        throw new Error("must never be called: the earlier gate already rejected");
      },
      releaseClaim: (avatarId, attemptId) => released.push({ avatarId, attemptId }),
    };
    const { end } = start(run, { gates: [rejecting, neverRan] });

    expect(await end).toMatchObject({ status: "done", failedSlots: 1 });
    expect(released).toEqual([{ avatarId, attemptId: `${RUN_ID}:slot-1#1` }]);
  });
});
