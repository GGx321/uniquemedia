import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { AvatarDescriptor, EngineError } from "../../shared/engine";
import { openLibrary, type Library } from "../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { Budget, scopeKey } from "../money/budget";
import { Ledger, type Scope } from "../money/ledger";
import { PriceBook } from "../money/prices";
import { fakeFetch, imageBody, JPEG, makeClient, readLedgerLines, type FetchCall, type Reply } from "../openrouter/testing/fakes";
import { plan as planScenes } from "../scenes";
import { RunEventSchema, type RunEvent } from "./journal";
import { BOLD_IMAGE_MODEL, buildSceneRunPlan, RunPlanSchema, runEstimateFromScenes, type RunPlan, type SceneRunSource } from "./plan";
import { BOLD_REALISM_CUE } from "./boldPrompt";
import { createFaceQaGate } from "./faceGate";
import { CpuPool, NetworkPool } from "./pools";
import type { QaGate, QaVerdict } from "./qa";
import { reportingTo, runPhotoRun, type RunJobDeps, type RunJobEnd } from "./runJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// 5a.3 (S5.9d, plan s5a3 §8): the run job over a plan with Seedream slots. A Seedream slot is sent to Seedream 5 Pro at 2K with the master as its one reference, never to
// the settings' model and never to a fallback; its refusal is free and final (`model-refused`), a 2xx without an image ends that slot alone (`model-empty`, settled by
// the bill), a second empty one stops sending; a 429, a 5xx, a network error or an abort never ends it. Every other slot is sent exactly as before.

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };
const GROK = "x-ai/grok-imagine-image-2.0";
const SEEDREAM = BOLD_IMAGE_MODEL;
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const BOLD_ATTEMPT = 93_000;
const GROK_ATTEMPT = 50_000;
const MODERATION: Reply = { status: 400, body: { error: { message: "Seedream blocked this request through content moderation." } } };
const EMPTY_PAID: Reply = { status: 200, body: { created: 1, data: [], usage: { cost: 0.045 } } };
const RATE_LIMITED: Reply = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };

let dir = "";
let library: Library;
let avatarId = "";
let budget: Budget;
const caps = new Map<string, number>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-run-job-bold-"));
  await mkdir(join(dir, "library"));
  library = (await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds("lib"), downscaleReference: async () => JPEG })).library;
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR.text });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  avatarId = avatar.id;
  caps.clear();
  const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
  budget = new Budget(ledger, { runCapMicros: (scope) => caps.get(scopeKey(scope)) ?? 0, monthlyBudgetMicros: 10_000_000, clock: () => NOW, monotonic: () => 0 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A run made from a set of «Ночнушки и бельё» scenes; the scenes at `routed` indexes are on the Seedream route (what S5.9c's planner will mark for a bold slot). */
async function newRun(count: number, routed: readonly number[], opts: { imageModel?: string; cameraRealism?: boolean } = {}): Promise<RunPlan> {
  const imageModel = opts.imageModel ?? GROK;
  const planned = planScenes({ seed: 11, count, categories: ["nightwear"] }).slots;
  const scenes: SceneRunSource[] = planned.map((slot, i) => ({ sceneId: i + 1, text: `${SENTENCE} (${i + 1})`, slot: routed.includes(i) ? { ...slot, route: "seedream" as const } : slot }));
  const models = { imageModel, textModel: "x-ai/grok-4.3" };
  const cap = runEstimateFromScenes({ book: PriceBook.fallback(), asOf: "2026-10-12" }, models, { count, boldPhotos: routed.length }, "off").worstMicros;
  const run = buildSceneRunPlan({
    runId: RUN_ID,
    avatarId,
    createdAt: new Date(NOW).toISOString(),
    sceneSetId: "set-00000001",
    imageAgeCheck: "off",
    models,
    capMicros: cap,
    plannedWorstMicros: cap,
    scenes,
    ...(opts.cameraRealism === undefined ? {} : { cameraRealism: opts.cameraRealism }),
  });
  await library.createRun(RUN_ID, run, RunPlanSchema);
  caps.set(scopeKey(SCOPE), cap);
  return run;
}

function network(image: (call: FetchCall, n: number) => Reply = () => ({ status: 200, body: imageBody(PNG_1X1, { cost: 0.04 }) })) {
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return image(call, ++images);
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return { fetch: net.fetch, calls: net.calls, imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")) };
}
type Network = ReturnType<typeof network>;

const modelOf = (call: FetchCall): unknown => call.json().model;
const drawn = (): Reply => ({ status: 200, body: imageBody(PNG_1X1, { cost: 0.04 }) });

function start(run: RunPlan, net: Network, opts: { signal?: AbortSignal; softStop?: AbortSignal; jobId?: string; max?: number; gates?: QaGate[]; library?: RunJobDeps["library"] } = {}): { end: Promise<RunJobEnd>; sent: string[] } {
  const pool = new NetworkPool({ max: opts.max ?? 6 });
  const { client } = makeClient(reportingTo(pool, net.fetch));
  const sent: string[] = [];
  const end = runPhotoRun(
    {
      generateImage: async (params) => {
        const result = await client.generateImage(params);
        if (result.status !== "blocked" && !("ledger" in result && result.ledger.action === "released")) sent.push(params.attemptId);
        return result;
      },
      chat: client.chat,
      budget,
      priceBook: PriceBook.fallback(),
      library: opts.library ?? library,
      pool,
      cpu: new CpuPool(2),
      gates: opts.gates ?? [],
      now: () => new Date(NOW),
      errorOf: (error: unknown): EngineError => ({ code: "INTERNAL", detail: error instanceof Error ? error.message : String(error) }),
    },
    { plan: run, jobId: opts.jobId ?? "job-00000001", descriptor: DESCRIPTOR, signal: opts.signal ?? new AbortController().signal, ...(opts.softStop === undefined ? {} : { softStop: opts.softStop }) },
  );
  return { end, sent };
}

async function journal(): Promise<RunEvent[]> {
  return (await library.readJournal(RUN_ID, RunEventSchema)).events;
}
const ledgerLines = (): Record<string, unknown>[] => readLedgerLines(join(dir, "ledger.jsonl"));
const reserves = (): Record<string, unknown>[] => ledgerLines().filter((l) => l.type === "reserve");
const photosOfRun = () => library.photosByAvatar(avatarId).filter((p) => p.source.kind === "generated" && p.source.attemptId.startsWith(`${RUN_ID}:`));
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}
/** A library that forgets every slot-end line: what a crash between the settle/attempt line and the slot's end leaves on disk. */
function forgettingSlotEnds(): RunJobDeps["library"] {
  return {
    appendJournal: async <T>(runId: string, event: T, schema: z.ZodType<T>): Promise<void> => {
      if (typeof event === "object" && event !== null && "type" in event && event.type === "slot") return;
      await library.appendJournal(runId, event, schema);
    },
    readJournal: library.readJournal.bind(library),
    addPhoto: library.addPhoto.bind(library),
    loadReference: library.loadReference.bind(library),
    loadMasterOriginal: library.loadMasterOriginal.bind(library),
    photosByAvatar: library.photosByAvatar.bind(library),
    appendHistory: library.appendHistory.bind(library),
  };
}

describe("the request of a Seedream slot", () => {
  test("is Seedream 5 Pro at 2K, 9:16, with the master as its one reference and no quality", async () => {
    const run = await newRun(1, [0]);
    const net = network();
    await start(run, net).end;
    const body = net.imageCalls()[0]?.json() ?? {};
    expect({ model: body.model, resolution: body.resolution, aspect_ratio: body.aspect_ratio, refs: Array.isArray(body.input_references) ? body.input_references.length : null, quality: "quality" in body }).toEqual({
      model: SEEDREAM,
      resolution: "2K",
      aspect_ratio: "9:16",
      refs: 1,
      quality: false,
    });
  });

  test("reserves the 2K list price before it is sent", async () => {
    const run = await newRun(1, [0]);
    await start(run, network()).end;
    expect(reserves().map((r) => r.worstMicros)).toEqual([BOLD_ATTEMPT]);
  });

  test("never uses the settings' model, whichever it is", async () => {
    const run = await newRun(1, [0], { imageModel: "x-ai/grok-imagine-image-quality" });
    const net = network();
    await start(run, net).end;
    expect(net.imageCalls().map(modelOf)).toEqual([SEEDREAM]);
  });

  test("goes the same way when the settings' model already is Seedream (the plan has no fallback)", async () => {
    const run = await newRun(2, [0], { imageModel: SEEDREAM });
    const net = network();
    await start(run, net, { max: 1 }).end;
    expect(net.imageCalls().map((c) => [c.json().model, c.json().resolution])).toEqual([
      [SEEDREAM, "2K"],
      [SEEDREAM, "1K"],
    ]);
  });

  test("leaves a slot that is not on the route exactly as it was: the settings' model at 1K with its quality", async () => {
    const run = await newRun(2, [0]);
    const net = network();
    await start(run, net, { max: 1 }).end;
    const grok = net.imageCalls().find((c) => modelOf(c) === GROK)?.json() ?? {};
    expect({ resolution: grok.resolution, quality: grok.quality, reserved: reserves().map((r) => r.worstMicros) }).toEqual({ resolution: "1K", quality: "low", reserved: [BOLD_ATTEMPT, GROK_ATTEMPT] });
  });
});

describe("the sidecar of a drawn Seedream frame", () => {
  test("says it was drawn on the Seedream route", async () => {
    const run = await newRun(1, [0]);
    await start(run, network()).end;
    expect(photosOfRun().map((p) => (p.source.kind === "generated" ? [p.source.model, p.source.route] : null))).toEqual([[SEEDREAM, "seedream"]]);
  });

  test("a frame of the settings' model has no route", async () => {
    const run = await newRun(1, []);
    await start(run, network()).end;
    expect(photosOfRun().map((p) => p.source.kind === "generated" && "route" in p.source)).toEqual([false]);
  });

  test("a frame the 1K moderation fallback drew has no route either, although its model is Seedream", async () => {
    const run = await newRun(1, []);
    await start(run, network((call) => (modelOf(call) === GROK ? MODERATION : drawn()))).end;
    expect(photosOfRun().map((p) => (p.source.kind === "generated" ? [p.source.model, "route" in p.source] : null))).toEqual([[SEEDREAM, false]]);
  });
});

describe("a Seedream slot's prompt", () => {
  test("carries the hair and skin cue and neither «slightly soft focus» nor «muted colours»; the other slots' prompts do not carry the cue", async () => {
    const run = await newRun(4, [0, 1], { cameraRealism: true });
    await start(run, network()).end;
    const prompts = (await journal()).flatMap((e) => (e.type === "prompts" ? e.prompts : []));
    const bold = prompts.filter((p) => p.slotIndex <= 2);
    const plain = prompts.filter((p) => p.slotIndex > 2);
    expect(bold).toHaveLength(2);
    expect(bold.every((p) => p.prompt.includes(BOLD_REALISM_CUE) && !/slightly soft focus|muted colours/.test(p.prompt))).toBe(true);
    expect(plain.some((p) => p.prompt.includes(BOLD_REALISM_CUE))).toBe(false);
  });
});

describe("a free refusal of a Seedream slot", () => {
  test("ends that slot as model-refused, settled at zero, and the run goes on", async () => {
    const run = await newRun(2, [0]);
    const end = await start(run, network((call) => (modelOf(call) === SEEDREAM ? MODERATION : drawn())), { max: 1 }).end;
    expect(end).toMatchObject({ status: "done", failedSlots: 1, failedReasons: [{ slotIndex: 1, reason: "model-refused" }] });
    expect(ledgerLines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([0, 40_000]);
  });

  test("journals the refusal with the scene reason on the slot's error", async () => {
    const run = await newRun(1, [0]);
    await start(run, network(() => MODERATION)).end;
    const ended = (await journal()).find((e) => e.type === "slot");
    expect(ended).toMatchObject({ status: "failed", error: { code: "MODERATION_REFUSED", sceneReason: "model-refused" } });
  });

  test("is final: one request, no other model, no spare id", async () => {
    const run = await newRun(1, [0]);
    const net = network(() => MODERATION);
    const { sent } = start(run, net);
    await until(() => net.imageCalls().length >= 1, "the refused request");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([net.imageCalls().map(modelOf), sent]).toEqual([[SEEDREAM], [`${RUN_ID}:slot-1#1`]]);
  });

  test("does not stop the run: a refusal is a content end of one slot", async () => {
    const run = await newRun(3, [0, 1]);
    const end = await start(run, network((call) => (modelOf(call) === SEEDREAM ? MODERATION : drawn())), { max: 1 }).end;
    expect(end).toMatchObject({ status: "done", failedSlots: 2 });
  });
});

describe("a 2xx without an image on a Seedream slot", () => {
  test("ends that slot as model-empty, settled at its bill, and the run goes on", async () => {
    const run = await newRun(2, [0]);
    const end = await start(run, network((call) => (modelOf(call) === SEEDREAM ? EMPTY_PAID : drawn())), { max: 1 }).end;
    expect(end).toMatchObject({ status: "done", failedSlots: 1, failedReasons: [{ slotIndex: 1, reason: "model-empty" }] });
    expect(ledgerLines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([45_000, 40_000]);
  });

  test("journals it as an INTERNAL error with the scene reason", async () => {
    const run = await newRun(1, [0]);
    await start(run, network(() => EMPTY_PAID)).end;
    expect((await journal()).find((e) => e.type === "slot")).toMatchObject({ status: "failed", error: { code: "INTERNAL", sceneReason: "model-empty" } });
  });

  test("settles at the 2K list price, estimated, when the empty answer carries no bill", async () => {
    const run = await newRun(1, [0]);
    await start(run, network(() => ({ status: 200, body: { created: 1, data: [] } }))).end;
    expect(ledgerLines().find((l) => l.type === "settle")).toMatchObject({ costMicros: BOLD_ATTEMPT, estimated: true });
  });

  test("is not retried: the one request is all the slot sends", async () => {
    const run = await newRun(1, [0]);
    const net = network(() => EMPTY_PAID);
    await start(run, net).end;
    expect(net.imageCalls()).toHaveLength(1);
  });

  test("a second one in the run stops sending: the third slot is left open", async () => {
    const run = await newRun(3, [0, 1, 2]);
    const net = network(() => EMPTY_PAID);
    const end = await start(run, net, { max: 1 }).end;
    expect(end.status).toBe("failed");
    expect(net.imageCalls()).toHaveLength(2);
    const events = await journal();
    expect(events.filter((e) => e.type === "slot").map((e) => e.slotIndex)).toEqual([1, 2]);
    expect(events.some((e) => e.type === "attempt" && e.slotIndex === 3)).toBe(false);
  });

  test("on a slot that is NOT on the route it is still fatal, as before: the run stops with the slot open and no scene reason", async () => {
    const run = await newRun(2, []);
    const net = network(() => EMPTY_PAID);
    const end = await start(run, net, { max: 1 }).end;
    expect(end).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(net.imageCalls()).toHaveLength(1);
    expect((await journal()).some((e) => e.type === "slot")).toBe(false);
  });

  test("a resume counts the empty answers of the run's earlier jobs: one more in the resume is the second and stops sending", async () => {
    const run = await newRun(3, [0, 1, 2]);
    const softStop = new AbortController();
    // The first job's only request comes back empty and stops the job right after, so slot 1 ends model-empty and slots 2 and 3 are left open.
    const firstNet = network(() => {
      softStop.abort();
      return EMPTY_PAID;
    });
    expect(await start(run, firstNet, { max: 1, softStop: softStop.signal }).end).toEqual({ status: "cancelled" });

    const net = network(() => EMPTY_PAID);
    const resumed = await start(run, net, { max: 1, jobId: "job-00000002" }).end;
    expect(resumed.status).toBe("failed");
    expect(net.imageCalls()).toHaveLength(1);
  });

  test("an empty slot whose end was lost is counted on resume too", async () => {
    const run = await newRun(2, [0, 1]);
    const softStop = new AbortController();
    const firstNet = network(() => {
      softStop.abort();
      return EMPTY_PAID;
    });
    await start(run, firstNet, { max: 1, softStop: softStop.signal, library: forgettingSlotEnds() }).end;

    const net = network(() => EMPTY_PAID);
    const resumed = await start(run, net, { max: 1, jobId: "job-00000002" }).end;
    expect(resumed.status).toBe("failed");
    expect(net.imageCalls()).toHaveLength(1);
  });

  test("a refusal between two empty answers does not count toward the guard", async () => {
    const run = await newRun(3, [0, 1, 2]);
    const net = network((_call, n) => (n === 2 ? MODERATION : n === 1 ? EMPTY_PAID : drawn()));
    const end = await start(run, net, { max: 1 }).end;
    expect(end).toMatchObject({ status: "done", failedSlots: 2 });
    expect(photosOfRun()).toHaveLength(1);
  });
});

describe("an attempt on a Seedream slot that got no answer", () => {
  test("a final 429 stops the run with the slot open, and the resume draws it on the bold route", async () => {
    const run = await newRun(1, [0]);
    const first = await start(run, network(() => RATE_LIMITED)).end;
    expect(first).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });
    expect((await journal()).some((e) => e.type === "slot")).toBe(false);

    const net = network();
    const resumed = start(run, net, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    expect([resumed.sent, net.imageCalls().map((c) => [c.json().model, c.json().resolution])]).toEqual([[`${RUN_ID}:slot-1#2`], [[SEEDREAM, "2K"]]]);
  });

  test("a 503 that outlasts the transport retries stops the run with the slot open, and the resume draws it on the bold route", async () => {
    const run = await newRun(1, [0]);
    const first = await start(run, network(() => ({ status: 503, body: { error: { message: "upstream unavailable" } } }))).end;
    expect(first).toMatchObject({ status: "failed", error: { code: "NETWORK" } });

    const net = network();
    expect(await start(run, net, { jobId: "job-00000002" }).end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(net.imageCalls().map(modelOf)).toEqual([SEEDREAM]);
  });

  test("a fetch that rejects stops the run with the slot open, and the resume draws it on the bold route", async () => {
    const run = await newRun(1, [0]);
    const first = await start(run, network(() => ({ reject: new TypeError("fetch failed") }))).end;
    expect(first).toMatchObject({ status: "failed", error: { code: "NETWORK" } });

    const net = network();
    expect(await start(run, net, { jobId: "job-00000002" }).end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(net.imageCalls().map(modelOf)).toEqual([SEEDREAM]);
  });

  test("a cancel while the request is out leaves the slot open, and the resume draws it on the bold route", async () => {
    const run = await newRun(1, [0]);
    const controller = new AbortController();
    const hanging = network(() => ({ hang: true }));
    const first = start(run, hanging, { signal: controller.signal });
    await until(() => hanging.imageCalls().length === 1, "the request");
    controller.abort(new Error("cancelled by the user"));
    expect(await first.end).toEqual({ status: "cancelled" });

    const net = network();
    expect(await start(run, net, { jobId: "job-00000002" }).end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(net.imageCalls().map(modelOf)).toEqual([SEEDREAM]);
  });
});

describe("the resume of a Seedream slot", () => {
  test("after a paid mismatch continues on the bold route with the slot's next id, never on a fallback", async () => {
    const run = await newRun(1, [0]);
    const softStop = new AbortController();
    const firstNet = network();
    const stopAfterFirst: QaGate = { name: "stop", paid: false, check: async (): Promise<QaVerdict> => (softStop.abort(), { verdict: "retry", reason: "the face does not match" }) };
    expect(await start(run, firstNet, { gates: [stopAfterFirst], softStop: softStop.signal }).end).toEqual({ status: "cancelled" });

    const net = network();
    const resumed = start(run, net, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 0 });
    expect(resumed.sent).toEqual([`${RUN_ID}:slot-1#2`]);
    expect(net.imageCalls().map((c) => [c.json().model, c.json().resolution])).toEqual([[SEEDREAM, "2K"]]);
    expect(reserves().map((r) => r.worstMicros)).toEqual([BOLD_ATTEMPT, BOLD_ATTEMPT]);
  });

  test("after a free refusal whose slot end was lost keeps the slot ended model-refused and sends nothing", async () => {
    const run = await newRun(1, [0]);
    expect(await start(run, network(() => MODERATION), { library: forgettingSlotEnds() }).end).toMatchObject({ status: "done", failedSlots: 1 });
    expect((await journal()).some((e) => e.type === "slot")).toBe(false);

    const net = network();
    const resumed = start(run, net, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 1, failedReasons: [{ slotIndex: 1, reason: "model-refused" }] });
    expect([net.imageCalls(), resumed.sent]).toEqual([[], []]);
  });

  test("after a 2xx without an image whose slot end was lost keeps the slot ended model-empty and sends nothing", async () => {
    const run = await newRun(1, [0]);
    await start(run, network(() => EMPTY_PAID), { library: forgettingSlotEnds() }).end;

    const net = network();
    const resumed = start(run, net, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 1, failedReasons: [{ slotIndex: 1, reason: "model-empty" }] });
    expect(net.imageCalls()).toEqual([]);
  });

  test("a refusal whose slot end was lost and whose attempt line was lost too still sends nothing (a free ledger zero reads as refused)", async () => {
    const run = await newRun(1, [0]);
    const forgetting = forgettingSlotEnds();
    const noAttemptLines: RunJobDeps["library"] = {
      ...forgetting,
      appendJournal: async <T>(runId: string, event: T, schema: z.ZodType<T>): Promise<void> => {
        if (typeof event === "object" && event !== null && "type" in event && (event.type === "slot" || event.type === "attempt")) return;
        await library.appendJournal(runId, event, schema);
      },
    };
    await start(run, network(() => MODERATION), { library: noAttemptLines }).end;

    const net = network();
    const resumed = start(run, net, { jobId: "job-00000002" });
    expect(await resumed.end).toMatchObject({ status: "done", failedSlots: 1, failedReasons: [{ slotIndex: 1, reason: "model-refused" }] });
    expect(net.imageCalls()).toEqual([]);
  });

  test("a slot that is not on the route resumes exactly as before: a refusal on the settings' model still goes to the fallback", async () => {
    const run = await newRun(1, []);
    const net = network((call) => (modelOf(call) === GROK ? MODERATION : drawn()));
    await start(run, net).end;
    expect(net.imageCalls().map(modelOf)).toEqual([GROK, SEEDREAM]);
  });
});

describe("a Seedream frame the face gate misses", () => {
  test("journals the miss with the similarity it measured, so the distribution can be read back", async () => {
    const run = await newRun(1, [0]);
    const gate = createFaceQaGate({
      faceGate: { isBroken: () => false, embed: async () => new Float32Array([1, 0]), check: async () => ({ kind: "mismatch", similarity: 0.41, faces: 1, headRatio: 0.2 }) },
    });
    await start(run, network(), { gates: [gate] }).end;
    const miss = (await journal()).find((e) => e.type === "attempt" && e.outcome === "qa-retry");
    expect(miss?.type === "attempt" && miss.error?.detail).toContain("similarity 0.41");
  });

  test("retries it on the bold route within the three priced attempts", async () => {
    const run = await newRun(1, [0]);
    const gate = createFaceQaGate({
      faceGate: { isBroken: () => false, embed: async () => new Float32Array([1, 0]), check: async () => ({ kind: "mismatch", similarity: 0.41, faces: 1, headRatio: 0.2 }) },
    });
    const net = network();
    await start(run, net, { gates: [gate] }).end;
    expect(net.imageCalls().map((c) => [c.json().model, c.json().resolution])).toEqual([
      [SEEDREAM, "2K"],
      [SEEDREAM, "2K"],
      [SEEDREAM, "2K"],
    ]);
  });
});
