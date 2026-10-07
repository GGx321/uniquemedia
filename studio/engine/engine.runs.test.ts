import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computePdqHash } from "../../src/core/pdq/pdq";
import { JobState, type EventMessage } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { sharedRealFaceGate } from "./face/testing/realWorker";
import { NoFaceInReferenceError } from "./face";
import { openLibrary } from "./library";
import { Ledger } from "./money/ledger";
import { samplePhotoMeta, SAMPLE_IMPORTED_SOURCE, sequentialIds, steppingClock } from "./library/testing/helpers";
import { ffmpegPath } from "../node/ffmpegBinary";
import { decodeGray64 } from "../node/pdqPixels";
import { chatBody, imageBody, fakeFetch, readLedgerLines, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { plannedSlots, RunPlanSchema, type RunPlan } from "./runs/plan";
import { CAMERA_REALISM_CLAUSE, plan as planScenes } from "./scenes";
import { faceModelPaths } from "../scripts/faceModelCache";
import { createAgeGate } from "./runs/ageGate";
import { createFaceQaGate } from "./runs/faceGate";
import { createPdqGate } from "./runs/pdqGate";
import type { QaGate, QaInput } from "./runs/qa";
import type { Estimate, ImageAgeCheck, ImageQuality, ResponseMessage } from "../shared/engine";
import type { Engine, EngineDeps } from "./engine";
import { command, engineSettings, failed, GOOD, jobEnd, MODERATION, NOW, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Every test here runs a real engine over a real library and ledger. On a Windows runner Defender can hold a fresh
// file for seconds (renameWithRetry waits up to about 3 s), and Bun's default 5 s per test left no room: "a start that
// passes prepares the gates twice" timed out at 5000 ms in CI (390 ms when the runner was quiet). No test in this file
// asserts a short time bound, so nothing here relies on the default. (bunfig.toml's `timeout` is not applied by Bun.)
setDefaultTimeout(30_000);

// T6: the photo run commands — runs.estimate, runs.start, runs.cancel,
// runs.estimateResume, runs.resume and runs.list — against a real engine over
// a real ledger and library in a temp dir, the bundled ffmpeg (the master's
// reference downscale), and a fake OpenRouter. Nothing reaches the network.
// The image age check is off unless a test says otherwise: with it on, a run
// needs an age gate (invariant 8), and none is wired until T7a.

const dir = useEngineDir("studio-engine-runs-");

/** The dated fallback table (offline prices), image age check on. */
const TWENTY_ON = { expectedMicros: 1_042_350, worstMicros: 3_390_000, prices: "fallback", pricesAsOf: "2026-09-24" } as const;
/** 4 photos, image age check off: 4 × 3 × $0.05 + one writer chunk × 2 × $0.0375 (T5c: 14K prompt tokens). */
const FOUR_WORST = 4 * 3 * 50_000 + 75_000;
/** 4 photos, image age check on: 4 × 3 × ($0.05 + $0.00525) + one writer chunk × 2 × $0.0375. */
const FOUR_ON_WORST = 4 * 3 * 55_250 + 75_000;

/**
 * A fake face gate registered under the name the engine looks for (T7b): it
 * passes every photo (no qa fields — most of this file is not testing the
 * face gate itself, only that a run can start now that one is required,
 * invariant-mirroring the age gate's own `#assertAgeGate`). `engineOver`
 * wires it in by default so every existing run test keeps working without
 * having to know about T7b; a test can still override `qaGates` (e.g. to
 * omit it and prove `FACE_GATE_UNAVAILABLE`).
 */
function faceGate(): QaGate {
  return { name: "face", paid: false, check: async () => ({ verdict: "pass" }) };
}

/**
 * Money review M4: a test's own `qaGates` (arbitrary fakes, in whatever
 * order it wrote them) plus the auto-inserted fake face gate, reassembled
 * into the production order — pdq, then face, then age, then anything else
 * — never a face gate blindly appended at the end (which used to put it
 * AFTER a test's own age gate: wrong, and exactly backwards from
 * `productionGates.ts`'s own rule that money is spent only on an image
 * every free gate, face included, already accepted).
 */
function inProductionOrder(gates: readonly QaGate[]): QaGate[] {
  const pdq = gates.filter((g) => g.name === "pdq");
  const face = gates.filter((g) => g.name === "face");
  const age = gates.filter((g) => g.name === "age");
  const other = gates.filter((g) => g.name !== "pdq" && g.name !== "face" && g.name !== "age");
  return [...pdq, ...(face.length > 0 ? face : [faceGate()]), ...age, ...other];
}

/** A fake age gate registered under the name the engine looks for: it passes every photo and spends nothing. */
function ageGate(): QaGate & { inputs: QaInput[] } {
  const inputs: QaInput[] = [];
  return {
    name: "age",
    paid: true,
    inputs,
    check: async (input) => {
      inputs.push(input);
      return { verdict: "pass", qa: { age: { adult: true, confidence: 0.95 } } };
    },
  };
}

let seeded = 0;

/** A saved (active) avatar whose master is a real portrait, as a picked candidate would be. */
async function seedAvatar(opts: { status?: "active" | "draft" | "archived" } = {}): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  if (opts.status === "draft") return avatar.id;
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: opts.status ?? "active", masterPhotoId: master.id });
  return avatar.id;
}

let seededCategories = 0;

/** A custom category in the library, as a create would have left it: five places, three outfits, a deck with a mirror shot. */
async function seedCustomCategory(opts: { name?: string; label?: string; style?: "editorial" | "phone" } = {}): Promise<`cat-${string}`> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seedcat${++seededCategories}`) });
  const categoryId = `cat-seed-${String(++seededCategories).padStart(6, "0")}` as const;
  const activities = [
    { text: "reading a menu", twoHanded: false },
    { text: "stirring a cappuccino", twoHanded: true },
  ];
  await library.categories.create({
    categoryId,
    name: opts.name ?? `Seeded ${seededCategories}`,
    description: "кофейни",
    label: opts.label ?? "Paris cafes",
    style: opts.style ?? "phone",
    pool: {
      locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({ name, times: ["morning", "midday"], activities, mirror: i === 2 })),
      outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
      shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    },
    model: "x-ai/grok-4.3",
    spentMicros: 5_000,
  });
  return categoryId;
}

function request(avatarId: string, count = 4) {
  return { avatarId, count, categories: ["home"], poses: { profile: false, back: false } };
}

function estimate(avatarId: string, count = 4): unknown {
  return command("runs.estimate", request(avatarId, count));
}

function startRun(avatarId: string, acceptedWorstMicros = FOUR_WORST, count = 4): unknown {
  return command("runs.start", { ...request(avatarId, count), acceptedWorstMicros });
}

/** What runs.estimateResume says a resume could still spend. */
async function remainingWorst(engine: Engine, runId: string): Promise<Estimate> {
  const answer = ok(await engine.handle(command("runs.estimateResume", { runId })));
  if (answer.type !== "runs.estimateResume") throw new Error(`expected an estimateResume answer, got ${answer.type}`);
  return answer.result.estimate;
}

/** runs.resume, accepting exactly the remaining worst case runs.estimateResume answers (plus `delta`). */
async function resume(engine: Engine, runId: string, delta = 0): Promise<ResponseMessage> {
  const { worstMicros } = await remainingWorst(engine, runId);
  return engine.handle(command("runs.resume", { runId, acceptedWorstMicros: worstMicros + delta }));
}

/** runs.resume for a refusal that comes before any price is compared. */
function resumeAnyway(runId: string): unknown {
  return command("runs.resume", { runId, acceptedWorstMicros: 10_000_000 });
}

function started(response: Parameters<typeof ok>[0]): { runId: string; jobId: string } {
  const answer = ok(response);
  if (answer.type !== "runs.start" && answer.type !== "runs.resume") throw new Error(`expected a run answer, got ${answer.type}`);
  return answer.result;
}

function planOf(runId: string): RunPlan {
  return RunPlanSchema.parse(JSON.parse(readFileSync(join(dir(), "library", "runs", runId, "plan.json"), "utf8")));
}

function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

function isWriter(call: FetchCall): boolean {
  if (!call.url.endsWith("/chat/completions")) return false;
  const format = call.json().response_format;
  return typeof format === "object" && format !== null && "json_schema" in format && JSON.stringify(format.json_schema).includes("scene_sentences");
}

/** T7a: a paid age gate's own request — its json_schema is named "age_check" (ageGate.ts's own ageJsonSchema()). */
function isAge(call: FetchCall): boolean {
  if (!call.url.endsWith("/chat/completions")) return false;
  const format = call.json().response_format;
  return typeof format === "object" && format !== null && "json_schema" in format && JSON.stringify(format.json_schema).includes("age_check");
}

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

/**
 * A fake OpenRouter for runs. Every image request is matched to the attempt
 * id whose reserve the ledger holds for it — the newest reserve not yet
 * matched: a reserve is on disk before its request leaves, and the next
 * reserve cannot land before this request is sent — so `received` is what
 * the network saw, by attempt id.
 */
function runNetwork(opts: { image?: Handler; writer?: Handler; age?: Handler; prices?: (call: FetchCall) => Reply | Promise<Reply>; credits?: Reply; received?: string[] } = {}) {
  const received = opts.received ?? [];
  let images = 0;
  let writes = 0;
  let ages = 0;
  const claim = (): string => {
    const reserves = readLedgerLines(join(dir(), "userData", "ledger.jsonl")).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
    const id = [...reserves].reverse().find((r) => !received.includes(r));
    if (id === undefined) throw new Error("a request left without its reserve on disk");
    received.push(id);
    return id;
  };
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) {
      claim();
      return (opts.image ?? (() => ({ status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) })))(call, ++images);
    }
    if (isAge(call)) {
      claim();
      const n = ++ages;
      if (opts.age !== undefined) return opts.age(call, n);
      return { status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "Mature features of a woman in her mid-20s." }), { cost: 0.0014 }) };
    }
    if (isWriter(call)) {
      claim();
      const n = ++writes;
      if (opts.writer !== undefined) return opts.writer(call, n);
      const scenes = slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `A friend catches her mid-laugh at the kitchen counter in the morning light (${slotIndex}).` }));
      return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.0112 }) };
    }
    if (call.url.endsWith("/credits")) return opts.credits ?? { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return opts.prices === undefined ? OFFLINE : opts.prices(call);
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    received,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    writerCalls: () => net.calls.filter(isWriter),
    ageCalls: () => net.calls.filter(isAge),
  };
}

function engineOver(
  net: ReturnType<typeof runNetwork>,
  opts: {
    bootId?: string;
    clock?: () => number;
    monotonic?: () => number;
    imageAgeCheck?: ImageAgeCheck;
    /** `undefined`: the default face gate only. An array: that array, plus the default face gate unless it already named one. `null`: no gates at all — for a test proving FACE_GATE_UNAVAILABLE. */
    qaGates?: QaGate[] | null;
    network?: number;
    monthlyBudgetMicros?: number;
    imageModel?: string;
    imageQuality?: ImageQuality | null;
    cameraRealism?: boolean;
    faceGateLoadError?: string;
  } = {},
) {
  const settings = engineSettings(dir(), {
    imageAgeCheck: opts.imageAgeCheck ?? "off",
    ...(opts.imageQuality === undefined ? {} : { imageQuality: opts.imageQuality }),
    ...(opts.cameraRealism === undefined ? {} : { cameraRealism: opts.cameraRealism }),
    ...(opts.imageModel === undefined ? {} : { imageModel: opts.imageModel }),
    ...(opts.network === undefined ? {} : { concurrency: { network: opts.network } }),
    ...(opts.monthlyBudgetMicros === undefined ? {} : { monthlyBudgetMicros: opts.monthlyBudgetMicros }),
  });
  return startEngine(dir(), {
    init: { settings },
    net: { fetch: net.fetch, calls: net.calls, imageCalls: net.imageCalls, ageCalls: () => [], descriptorCalls: () => [], paidCalls: () => net.calls.filter((c) => c.method === "POST") },
    ...(opts.bootId === undefined ? {} : { bootId: opts.bootId }),
    deps: {
      ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      ...(opts.monotonic === undefined ? {} : { monotonic: opts.monotonic }),
      ...(opts.faceGateLoadError === undefined ? {} : { faceGateLoadError: opts.faceGateLoadError }),
      // T7b: every run needs a wired face gate now (#assertFaceGate); a test
      // that passes its own qaGates keeps a face gate too, unless it already
      // named one of its own. `qaGates: null` opts all the way out (a test
      // proving FACE_GATE_UNAVAILABLE).
      qaGates: opts.qaGates === null ? [] : inProductionOrder(opts.qaGates ?? []),
    },
  });
}

function runEvents(events: EventMessage[], jobId: string): EventMessage[] {
  return events.filter((e) => "jobId" in e.payload && e.payload.jobId === jobId);
}

// ---------- runs.estimate ----------

describe("runs.estimate", () => {
  test("answers the run's expected and worst case at the prices it can get: the fallback table offline", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(runNetwork(), { imageAgeCheck: "on" });
    expect(ok(await engine.handle(estimate(avatarId, 20)))).toMatchObject({ result: { estimate: TWENTY_ON } });
  });

  test("with the image age check off, no age check is priced", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }) } });
    expect(ok(await engine.handle(estimate(avatarId, 20)))).toMatchObject({ result: { estimate: { worstMicros: 3_075_000 } } });
  });

  test("prices the chosen quality: medium is $0.06 + $0.01 reference an attempt, so 20 photos cap at $4.275", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(runNetwork(), { imageQuality: "medium" });
    expect(ok(await engine.handle(estimate(avatarId, 20)))).toMatchObject({ result: { estimate: { worstMicros: 4_275_000 } } });
  });

  test("a model with no quality knob (null) is priced at its plain 1K price: grok-imagine-image-quality is $0.05 + $0.01", async () => {
    const avatarId = await seedAvatar();
    const { engine } = await engineOver(runNetwork(), { imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null });
    expect(ok(await engine.handle(estimate(avatarId, 20)))).toMatchObject({ result: { estimate: { worstMicros: 20 * 3 * 60_000 + 75_000 } } });
  });

  test("a model whose endpoints list no price for the reference is PRICE_UNAVAILABLE: the estimate is refused and nothing is sent (review round 1, M1)", async () => {
    const avatarId = await seedAvatar();
    const flux = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "imageModels", "fixtures", "endpoints", "black-forest-labs_flux-3-image.json"), "utf8"));
    const net = runNetwork({ prices: (call) => (call.url.endsWith("black-forest-labs/flux-3-image/endpoints") ? { status: 200, body: flux } : OFFLINE) });
    const { engine } = await engineOver(net, { imageModel: "black-forest-labs/flux-3-image", imageQuality: null });

    expect(failed(await engine.handle(estimate(avatarId, 4))).error.code).toBe("PRICE_UNAVAILABLE");
    expect(failed(await engine.handle(startRun(avatarId, FOUR_WORST))).error.code).toBe("PRICE_UNAVAILABLE");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("a model whose live endpoints no longer list 9:16 is PRICE_UNAVAILABLE: the run is refused before any reserve, not slot by slot with a free 400 each", async () => {
    const avatarId = await seedAvatar();
    const grok = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "money", "fixtures", "endpoints-grok-imagine-image-2.0.json"), "utf8"));
    const dropped = { ...grok, endpoints: grok.endpoints.map((e: { supported_parameters: object }) => ({ ...e, supported_parameters: { ...e.supported_parameters, aspect_ratio: { type: "enum", values: ["1:1", "3:4"] } } })) };
    const net = runNetwork({ prices: (call) => (call.url.endsWith("x-ai/grok-imagine-image-2.0/endpoints") ? { status: 200, body: dropped } : OFFLINE) });
    const { engine } = await engineOver(net, { imageQuality: "low" });

    expect(failed(await engine.handle(startRun(avatarId, FOUR_WORST))).error.code).toBe("PRICE_UNAVAILABLE");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve")).toHaveLength(0);
  });

  test("is NOT_FOUND for an unknown avatar and for a draft: only a saved avatar with a master gets photos", async () => {
    const draft = await seedAvatar({ status: "draft" });
    const { engine } = await engineOver(runNetwork());
    expect(failed(await engine.handle(estimate("avatar-00000404"))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(estimate(draft))).error.code).toBe("NOT_FOUND");
  });
});

// CS.1/CS.2: a run names its custom categories by id, and the library either holds them or not. An unknown or deleted one is NOT_FOUND, free,
// before a price is fetched, a reserve is made or a folder is written (CS.1 refused every custom id; CS.2's lookup refuses the unknown ones).
describe("a custom category in a run request that the library does not hold", () => {
  const CUSTOM = "cat-paris-cafes";
  const withCustom = (avatarId: string) => ({ ...request(avatarId), categories: ["home", CUSTOM] });

  test("runs.estimate is NOT_FOUND for it and fetches no price", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net);
    const refusal = failed(await engine.handle(command("runs.estimate", withCustom(avatarId))));
    expect(refusal.error.code).toBe("NOT_FOUND");
    expect(refusal.error.detail).toContain(CUSTOM);
    expect(net.calls).toHaveLength(0);
  });

  test("runs.start is NOT_FOUND for it: no price fetched, nothing sent, no ledger line, no run folder", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net);
    expect(failed(await engine.handle(command("runs.start", { ...withCustom(avatarId), acceptedWorstMicros: 10_000_000 }))).error.code).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
    expect(readLedgerLines(join(dir(), "userData", "ledger.jsonl"))).toEqual([]);
  });

  test("the refusal releases the avatar: a built-in run for it starts right after", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork());
    expect(failed(await engine.handle(command("runs.start", { ...withCustom(avatarId), acceptedWorstMicros: 10_000_000 }))).error.code).toBe("NOT_FOUND");
    // The refusal released the avatar: a built-in run for it starts, and ends.
    const { jobId } = started(await engine.handle(startRun(avatarId)));
    await jobEnd(events, jobId);
  });

  test("a built-in run's plan.json is the document main wrote: no categories key", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork());
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await jobEnd(events, jobId);
    const raw: Record<string, unknown> = JSON.parse(readFileSync(join(dir(), "library", "runs", runId, "plan.json"), "utf8"));
    expect("categories" in raw).toBe(false);
  });

  test("the avatar check stays first: a run for an avatar whose manifest is gone says so, not that the category is unknown", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net);
    await rm(join(dir(), "library", "avatars", avatarId, "avatar.json"));

    const refused = failed(await engine.handle(command("runs.start", { ...withCustom(avatarId), acceptedWorstMicros: 10_000_000 })));

    expect(refused.error.code).toBe("NOT_FOUND");
    expect(refused.error.detail).toContain("no longer on the disk");
  });

  test("a category the owner deleted is unknown again: NOT_FOUND, nothing fetched, nothing sent, no run folder", async () => {
    const avatarId = await seedAvatar();
    const id = await seedCustomCategory();
    const net = runNetwork();
    const { engine } = await engineOver(net);
    ok(await engine.handle(command("categories.delete", { categoryId: id })));

    const refused = failed(await engine.handle(command("runs.start", { ...request(avatarId), categories: ["home", id], acceptedWorstMicros: 10_000_000 })));

    expect(refused.error.code).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
  });
});

// CS.2: a custom category the library holds is a category like the five: the estimate prices it, the plan draws its slots from its own pool and keeps
// a snapshot of it, and the writer is told its English label.
describe("a custom category in a run request that the library holds", () => {
  const PLACES = ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"];
  const OUTFITS = ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"];

  test("runs.estimate prices it as any run of the same size: the category changes no price", async () => {
    const avatarId = await seedAvatar();
    const id = await seedCustomCategory();
    const { engine } = await engineOver(runNetwork());

    const builtIn = ok(await engine.handle(estimate(avatarId, 4)));
    const custom = ok(await engine.handle(command("runs.estimate", { ...request(avatarId, 4), categories: ["home", id] })));

    expect(custom.result).toEqual(builtIn.result);
  });

  test("runs.start plans its slots from the category's own pool and writes a snapshot of it next to the request", async () => {
    const avatarId = await seedAvatar();
    const id = await seedCustomCategory({ name: "Кофейни Парижа", label: "Paris cafes", style: "phone" });
    const { engine, events } = await engineOver(runNetwork());

    const { runId, jobId } = started(await engine.handle(command("runs.start", { ...request(avatarId, 4), categories: ["home", id], acceptedWorstMicros: FOUR_WORST })));
    await jobEnd(events, jobId);

    const plan = planOf(runId);
    expect(plan.request?.categories).toEqual(["home", id]);
    expect(plan.categories).toEqual([{ ref: id, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" }]);
    const customSlots = plannedSlots(plan).filter((s) => s.category === id);
    expect(customSlots).toHaveLength(2);
    for (const slot of customSlots) {
      expect(PLACES).toContain(slot.location);
      expect(OUTFITS).toContain(slot.outfit);
    }
    expect(plan.scenes.slots.filter((s) => s.category === "home")).toHaveLength(2);
  });

  test("the writer is told the category's English label, never its id or the owner's name", async () => {
    const avatarId = await seedAvatar();
    const id = await seedCustomCategory({ name: "ZEBRA-NAME-MARKER", label: "Paris cafes" });
    const net = runNetwork();
    const { engine, events } = await engineOver(net);

    const { jobId } = started(await engine.handle(command("runs.start", { ...request(avatarId, 4), categories: [id], acceptedWorstMicros: FOUR_WORST })));
    await jobEnd(events, jobId);

    const body = net.writerCalls()[0]?.body ?? "";
    expect(body).toContain("Paris cafes");
    expect(body).not.toContain(id);
    expect(body.toLowerCase()).not.toContain("zebra-name-marker");
  });

  test("a run that names it twice with built-ins keeps the contract's order: the five first, then the custom ones as named", async () => {
    const avatarId = await seedAvatar();
    const first = await seedCustomCategory({ name: "First" });
    const second = await seedCustomCategory({ name: "Second" });
    const { engine, events } = await engineOver(runNetwork());

    const { runId, jobId } = started(await engine.handle(command("runs.start", { ...request(avatarId, 4), categories: ["home", second, first], acceptedWorstMicros: FOUR_WORST })));
    await jobEnd(events, jobId);

    expect([...new Set(planOf(runId).scenes.slots.map((s) => s.category))]).toEqual(["home", second, first]);
  });

  test("a category deleted after the run started changes nothing: the plan keeps its snapshot, and the run is still listed from its plan alone", async () => {
    const avatarId = await seedAvatar();
    const id = await seedCustomCategory({ name: "Кофейни Парижа" });
    const { engine, events } = await engineOver(runNetwork());
    const { runId, jobId } = started(await engine.handle(command("runs.start", { ...request(avatarId, 4), categories: [id], acceptedWorstMicros: FOUR_WORST })));
    await jobEnd(events, jobId);
    const before = readFileSync(join(dir(), "library", "runs", runId, "plan.json"), "utf8");

    ok(await engine.handle(command("categories.delete", { categoryId: id })));

    expect(readFileSync(join(dir(), "library", "runs", runId, "plan.json"), "utf8")).toBe(before);
    const listed = ok(await engine.handle(command("runs.list")));
    expect(listed.type === "runs.list" && listed.result.runs.map((r) => r.runId)).toEqual([runId]);
  });
});

// ---------- runs.start ----------

describe("runs.start", () => {
  // «Удалить аватар»: only `avatar.json` is removed, so without the guard the run would carry on to its paid writer request (the master photo is still there).
  test("an avatar whose manifest is gone from the disk is NOT_FOUND: no request is sent, and nothing reaches the ledger", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net);
    await rm(join(dir(), "library", "avatars", avatarId, "avatar.json"));

    const refused = failed(await engine.handle(startRun(avatarId)));

    expect(refused.error.code).toBe("NOT_FOUND");
    expect(refused.error.detail).toContain("no longer on the disk");
    expect(net.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(existsSync(join(dir(), "userData", "ledger.jsonl"))).toBe(false);
  });

  test("the same stand with the manifest there: the run starts and its writer request goes out (the control of the test above)", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net);

    started(await engine.handle(startRun(avatarId)));

    await until(() => net.writerCalls().length >= 1, "the writer request");
  });

  test("PRICE_CHANGED when the accepted worst case is one micro under today's: nothing is written, nothing is sent", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net);

    expect(failed(await engine.handle(startRun(avatarId, FOUR_WORST - 1))).error.code).toBe("PRICE_CHANGED");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
    expect(readLedgerLines(join(dir(), "userData", "ledger.jsonl"))).toEqual([]);
  });

  test("starts when the accepted worst case is exactly today's, and caps the run at it", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork());

    const { runId, jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST)));
    await jobEnd(events, jobId);

    expect(planOf(runId).capMicros).toBe(FOUR_WORST);
    expect(planOf(runId).plannedWorstMicros).toBe(FOUR_WORST);
  });

  test("the chosen quality and camera realism reach plan.json and the first image request: medium, and the realism clause last", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const { engine, events } = await engineOver(net, { imageQuality: "medium", cameraRealism: true });
    const worst = 4 * 3 * 70_000 + 2 * 37_500;

    const { runId, jobId } = started(await engine.handle(startRun(avatarId, worst)));
    await until(() => net.imageCalls().length > 0, "the first image request");
    const stored = planOf(runId);
    const body = net.imageCalls()[0]?.json() ?? {};

    expect(stored.models.imageQuality).toBe("medium");
    expect(stored.cameraRealism).toBe(true);
    expect(body.quality).toBe("medium");
    expect(String(body.prompt)).toEndWith(CAMERA_REALISM_CLAUSE);

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("the settings' camera realism is captured when the run starts: switching it off afterwards does not change that run", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const { engine, events } = await engineOver(net, { cameraRealism: true });

    const { runId, jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST)));
    await engine.applyControl({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { imageAgeCheck: "off", cameraRealism: false }) });
    await until(() => net.imageCalls().length > 0, "the first image request");

    expect(planOf(runId).cameraRealism).toBe(true);
    expect(String(net.imageCalls()[0]?.json().prompt)).toEndWith(CAMERA_REALISM_CLAUSE);

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("the run's poses reach the planner: plan.json holds exactly the plan its seed and those poses draw", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork({ image: () => ({ hang: true }) }));
    const poses = { profile: true, back: true };
    const twenty = 20 * 3 * 50_000 + 2 * 37_500;

    const { runId, jobId } = started(await engine.handle(command("runs.start", { avatarId, count: 20, categories: ["home", "travel"], poses, acceptedWorstMicros: twenty })));
    const stored = planOf(runId);

    expect(stored.request?.poses).toEqual(poses);
    expect(stored.scenes).toEqual(planScenes({ seed: stored.scenes.seed, count: 20, categories: ["home", "travel"], poses }));
    expect(stored.scenes.slots.some((s) => s.pose === "profile" || s.pose === "back")).toBe(true);

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("invariant 6: plan.json, every slot with its pre-allocated attempt ids, is on disk before the writer's first request", async () => {
    const avatarId = await seedAvatar();
    const seen: RunPlan[] = [];
    let runId = "";
    const net = runNetwork({
      writer: (call) => {
        seen.push(planOf(runId));
        const scenes = slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `She reads by the window in the afternoon light (${slotIndex}).` }));
        return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.0112 }) };
      },
    });
    const { engine, events } = await engineOver(net);

    const answer = started(await engine.handle(startRun(avatarId)));
    runId = answer.runId;
    await jobEnd(events, answer.jobId);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.slotAttempts.map((s) => s.attemptIds)).toEqual([1, 2, 3, 4].map((i) => [1, 2, 3, 4, 5].map((n) => `${runId}:slot-${i}#${n}`)));
  });

  test("a run is announced at launch, then ends with job.progress per slot carrying the avatar, then money.changed and job.done with the run's photos", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork());

    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    const end = await jobEnd(events, jobId);

    const progress = runEvents(events(), jobId).filter((e) => e.type === "job.progress");
    expect(progress.map((e) => e.payload)).toEqual([0, 1, 2, 3, 4].map((done) => ({ kind: "run", jobId, runId, avatarId, done, total: 4 })));
    expect(end).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "run", runId, avatarId, failedSlots: 0 } } });
    if (end.type !== "job.done" || end.payload.result.kind !== "run") throw new Error("expected a run's job.done");
    expect(end.payload.result.photoIds).toHaveLength(4);
    const before = events().indexOf(end);
    expect(events().slice(0, before).some((e) => e.type === "money.changed")).toBe(true);
  });

  test("each stored photo announces its avatar with the new photo count", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork());
    const { jobId } = started(await engine.handle(startRun(avatarId)));
    await jobEnd(events, jobId);

    // One announcement per stored photo, each with the count at that moment (slots store concurrently), ending at the run's 4 (the master is not a gallery photo).
    const counts = events().flatMap((e) => (e.type === "avatar.changed" && e.payload.avatar.avatarId === avatarId ? [e.payload.avatar.photoCount] : []));
    expect(counts).toHaveLength(4);
    expect(counts.every((c, i) => i === 0 || c >= (counts[i - 1] ?? 0))).toBe(true);
    expect(counts.at(-1)).toBe(4);
  });

  // The writer phase can take a while before any slot ends: without an event at launch, a window that did not start the
  // run could neither see it running nor cancel it until the first photo.
  test("a run is announced with a job.progress (done 0, kind, runId, avatarId) the moment it is launched, before any slot ends", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ writer: () => ({ hang: true }) });
    const { engine, events } = await engineOver(net);

    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await until(() => net.writerCalls().length === 1, "the writer request");

    expect(runEvents(events(), jobId).filter((e) => e.type === "job.progress").map((e) => e.payload)).toEqual([{ kind: "run", jobId, runId, avatarId, done: 0, total: 4 }]);
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("the snapshot lists the run's job with its avatar, as the contract's JobState", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork({ image: () => ({ hang: true }) }));
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("expected a snapshot");
    const job = snapshot.result.jobs.find((j) => j.jobId === jobId);
    expect(job).toMatchObject({ kind: "run", runId, avatarId, status: "running", total: 4 });
    expect(JobState.safeParse(job).success).toBe(true);

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("a second run for the same avatar while one runs is refused with IN_FLIGHT", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork({ image: () => ({ hang: true }) }));
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));

    expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("IN_FLIGHT");
    expect(failed(await engine.handle(command("avatars.archive", { avatarId }))).error.code).toBe("IN_FLIGHT");

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("NOT_FOUND for a draft, before anything is priced, written or sent", async () => {
    const draft = await seedAvatar({ status: "draft" });
    const net = runNetwork();
    const { engine } = await engineOver(net);
    expect(failed(await engine.handle(startRun(draft))).error.code).toBe("NOT_FOUND");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("a moderation refusal goes to the Seedream fallback under the slot's next id, and the photo says which model made it", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: (call) => (call.json().model === "x-ai/grok-imagine-image-2.0" ? MODERATION : { status: 200, body: imageBody(portraitPng(3), { cost: 0.045 }) }) });
    const { engine, events } = await engineOver(net);
    const { runId, jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
    const end = await jobEnd(events, jobId);

    expect(net.imageCalls().map((c) => c.json().model)).toEqual(["x-ai/grok-imagine-image-2.0", "bytedance-seed/seedream-5-0-pro"]);
    expect(net.received.filter((id) => id.includes(":slot-"))).toEqual([`${runId}:slot-1#1`, `${runId}:slot-1#2`]);
    if (end.type !== "job.done" || end.payload.result.kind !== "run") throw new Error(`expected a run's job.done, got ${end.type}`);
    const { library } = await openLibrary(join(dir(), "library"), { newId: sequentialIds("check") });
    expect(library.getPhoto(end.payload.result.photoIds[0] ?? "")?.source).toMatchObject({ model: "bytedance-seed/seedream-5-0-pro", attemptId: `${runId}:slot-1#2` });
  });
});

// ---------- library switch ----------

describe("the library folder while a run runs", () => {
  test("a library switch is refused with IN_FLIGHT, and allowed once the run ended", async () => {
    const avatarId = await seedAvatar();
    const { engine, posted, events } = await engineOver(runNetwork({ image: () => ({ hang: true }) }));
    await mkdir(join(dir(), "other"));
    const open = (callId: string) => ({ kind: "control", type: "library.open", callId, path: join(dir(), "other") });

    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await engine.receive(open("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
    await engine.receive(open("call-00000002"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
  });

  test("money.reconcile is refused with IN_FLIGHT while a run runs", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork({ image: () => ({ hang: true }) }));
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));

    expect(failed(await engine.handle(command("money.reconcile"))).error.code).toBe("IN_FLIGHT");

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });
});

// ---------- runs.cancel ----------

describe("runs.cancel", () => {
  test("aborts the requests in flight, sends nothing after it, ends with job.cancelled, and leaves the aborted reserves open at their worst case", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const { engine, events } = await engineOver(net);
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length === 4, "four image requests");

    ok(await engine.handle(command("runs.cancel", { runId })));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.cancelled", payload: { kind: "run", jobId, runId, avatarId } });
    expect(net.imageCalls()).toHaveLength(4);
    const status = ok(await engine.handle(command("money.status")));
    expect(status).toMatchObject({ result: { unsettledCount: 4, unsettledMicros: 4 * 50_000, reconcileNeeded: true, reconcileReasons: ["open-reserves"] } });
  });

  test("a run that is not running answers ok; an unknown run is NOT_FOUND", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork());
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await jobEnd(events, jobId);

    expect(ok(await engine.handle(command("runs.cancel", { runId })))).toMatchObject({ result: { runId } });
    expect(failed(await engine.handle(command("runs.cancel", { runId: "run-00000404" }))).error.code).toBe("NOT_FOUND");
  });
});

// ---------- runs.resume ----------

describe("runs.resume", () => {
  const LATER = NOW + 10 * 60_000;

  /** Engine 1 runs until `inFlight` image requests hang, then stops (a cancel: its reserves stay open, like a crash's). */
  async function interrupted(opts: { hangFrom: number; count?: number; writerHangs?: boolean }) {
    const avatarId = await seedAvatar();
    const received: string[] = [];
    const net = runNetwork({
      received,
      image: (_call, n) => (n >= opts.hangFrom ? { hang: true } : { status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) }),
      ...(opts.writerHangs ? { writer: () => ({ hang: true }) } : {}),
    });
    const first = await engineOver(net);
    const { runId, jobId } = started(await first.engine.handle(startRun(avatarId, FOUR_WORST, opts.count ?? 4)));
    if (opts.writerHangs) await until(() => net.writerCalls().length === 1, "the writer request");
    else {
      await until(() => net.imageCalls().length === (opts.count ?? 4), "every slot's first request");
      // The images that did arrive are stored before the stop; only the hanging ones are cut off.
      await until(() => runEvents(first.events(), jobId).filter((e) => e.type === "job.progress").length === opts.hangFrom, "the launch and the photos that arrived");
    }
    ok(await first.engine.handle(command("runs.cancel", { runId })));
    await jobEnd(first.events, jobId);
    return { avatarId, runId, received };
  }

  async function restarted(received: string[], opts: { image?: Handler } = {}) {
    let mono = 0;
    const net = runNetwork({ received, ...(opts.image === undefined ? {} : { image: opts.image }) });
    const second = await engineOver(net, { bootId: "boot-0000-bbbb", clock: () => LATER, monotonic: () => mono });
    return { ...second, net, advance: (ms: number) => (mono += ms) };
  }

  test("after a restart, open reserves need a reconcile first; then the run continues where it stopped, no attempt id is sent twice, and the cap holds", async () => {
    const { avatarId, runId, received } = await interrupted({ hangFrom: 3 });
    const second = await restarted(received);

    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("RECONCILE_REQUIRED");
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));

    const { jobId } = started(await resume(second.engine, runId));
    const end = await jobEnd(second.events, jobId);

    expect(end).toMatchObject({ type: "job.done", payload: { result: { kind: "run", runId, avatarId, failedSlots: 0 } } });
    expect(new Set(received).size).toBe(received.length);
    expect(second.net.received.filter((id) => id.includes(":slot-")).slice(-2).sort()).toEqual([`${runId}:slot-3#2`, `${runId}:slot-4#2`]);
    expect(second.net.writerCalls()).toHaveLength(0);

    const cap = planOf(runId).capMicros;
    const lines = readLedgerLines(join(dir(), "userData", "ledger.jsonl"));
    const ofRun = new Set(lines.flatMap((l) => (l.type === "reserve" && JSON.stringify(l.scope) === JSON.stringify({ runId }) && typeof l.attemptId === "string" ? [l.attemptId] : [])));
    const committed = lines.reduce((sum, l) => sum + (l.type === "settle" && typeof l.attemptId === "string" && ofRun.has(l.attemptId) && typeof l.costMicros === "number" ? l.costMicros : 0), 0);
    expect(committed).toBeLessThanOrEqual(cap);
  });

  // «Удалить аватар»: an avatar whose manifest is no longer on the disk (its folder went to the Trash, and the engine that lists it did not hear) is never paid
  // for. Only `avatar.json` is removed, so WITHOUT the guard the resume would carry on to its paid request (its photos and master are still there).
  test("an avatar whose manifest is gone from the disk: the resume is NOT_FOUND, nothing is sent, and no reserve is made", async () => {
    const { avatarId, runId, received } = await interrupted({ hangFrom: 3 });
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));
    const reservesBefore = readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve").length;
    await rm(join(dir(), "library", "avatars", avatarId, "avatar.json"));

    const refused = failed(await resume(second.engine, runId));

    expect(refused.error.code).toBe("NOT_FOUND");
    expect(refused.error.detail).toContain("no longer on the disk");
    expect(second.net.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve")).toHaveLength(reservesBefore);
  });

  test("the same stand with the manifest there: the resume goes on and pays (the control of the test above)", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));

    const { jobId } = started(await resume(second.engine, runId));
    await jobEnd(second.events, jobId);

    expect(second.net.imageCalls().length).toBeGreaterThan(0);
  });

  // A chunk out of writer attempts with its slots still open (a crash mid-writer): the writer can never answer, and the
  // resume only closes the slots. It costs nothing, so it is priced at nothing and no month budget can refuse it.
  test("a writer chunk out of attempts: the resume is free (estimate 0), even with no room left in the month, and closes every open slot with 0 POST and 0 new reserves", async () => {
    await freeCloseWithMonthlyBudget(37_500);
  });

  test("a writer chunk out of attempts: the free resume is not refused BUDGET_EXCEEDED when the month is already OVER its budget", async () => {
    await freeCloseWithMonthlyBudget(10_000);
  });

  /** The month's budget is `monthlyBudgetMicros`; the abandoned writer reserve alone commits 37_500 of it. */
  async function freeCloseWithMonthlyBudget(monthlyBudgetMicros: number): Promise<void> {
    const avatarId = await seedAvatar();
    const received: string[] = [];
    const net = runNetwork({ received, writer: () => ({ hang: true }) });
    const first = await engineOver(net);
    const { runId, jobId } = started(await first.engine.handle(startRun(avatarId, FOUR_WORST, 2)));
    await until(() => net.writerCalls().length === 1, "the writer request");
    ok(await first.engine.handle(command("runs.cancel", { runId })));
    await jobEnd(first.events, jobId);
    // The chunk keeps only the id already used: it is out of writer attempts, its slots open.
    const plan = planOf(runId);
    const edited = { ...plan, writerChunks: plan.writerChunks.map((c) => ({ ...c, attemptIds: c.attemptIds.slice(0, 1) })) };
    await writeFile(join(dir(), "library", "runs", runId, "plan.json"), JSON.stringify(edited, null, 2));

    // The month has exactly what the abandoned writer reserve costs at its worst case: no room left after the reconcile.
    let mono = 0;
    const net2 = runNetwork({ received });
    const second = await engineOver(net2, { bootId: "boot-0000-bbbb", clock: () => LATER, monotonic: () => mono, monthlyBudgetMicros });
    mono += 10 * 60_000;
    ok(await second.engine.handle(command("money.reconcile")));
    const reserves = () => readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve").length;
    const before = reserves();

    expect(await remainingWorst(second.engine, runId)).toMatchObject({ worstMicros: 0, expectedMicros: 0 });
    const { jobId: resumeJob } = started(await second.engine.handle(command("runs.resume", { runId, acceptedWorstMicros: 0 })));
    await jobEnd(second.events, resumeJob);

    expect(net2.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(reserves()).toBe(before);
    const list = ok(await second.engine.handle(command("runs.list")));
    expect(list.type === "runs.list" ? list.result.runs.find((r) => r.runId === runId) : "not a list").toMatchObject({ open: 0, failed: 2, resumable: false, capExhausted: false });
  }

  test("the resumed job counts the slots the run already finished, from its launch announcement on", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));

    const { jobId } = started(await resume(second.engine, runId));
    await jobEnd(second.events, jobId);

    expect(runEvents(second.events(), jobId).filter((e) => e.type === "job.progress").map((e) => (e.type === "job.progress" ? e.payload.done : -1))).toEqual([2, 3, 4]);
  });

  test("resume uses plan.json and never re-plans: the writer is asked about the persisted slots, under its next id", async () => {
    const { runId, received } = await interrupted({ hangFrom: 1, count: 2, writerHangs: true });
    const plan = planOf(runId);
    const edited = { ...plan, scenes: { ...plan.scenes, slots: plan.scenes.slots.map((s) => ({ ...s, location: "a lighthouse keeper's kitchen" })) } };
    await writeFile(join(dir(), "library", "runs", runId, "plan.json"), JSON.stringify(edited, null, 2));
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));

    const { jobId } = started(await resume(second.engine, runId));
    await jobEnd(second.events, jobId);

    expect(JSON.stringify(second.net.writerCalls()[0]?.json())).toContain("a lighthouse keeper's kitchen");
    // writer-1#1 went out before the stop and was reconciled at its worst case; the resume never sends it again.
    expect(second.net.received.filter((id) => id.includes(":writer-"))).toEqual([`${runId}:writer-1#1`, `${runId}:writer-1#2`]);
    expect(new Set(received).size).toBe(received.length);
  });

  test("a run already running is refused with IN_FLIGHT; an unknown run is NOT_FOUND", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork({ image: () => ({ hang: true }) }));
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));

    expect(failed(await engine.handle(resumeAnyway(runId))).error.code).toBe("IN_FLIGHT");
    expect(failed(await engine.handle(resumeAnyway("run-00000404"))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(command("runs.estimateResume", { runId: "run-00000404" }))).error.code).toBe("NOT_FOUND");

    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
  });

  test("a run with nothing left to do is refused with VALIDATION and spends nothing", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine, events } = await engineOver(net);
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await jobEnd(events, jobId);
    const posts = net.calls.filter((c) => c.method === "POST").length;

    expect(failed(await engine.handle(resumeAnyway(runId))).error.code).toBe("VALIDATION");
    expect(failed(await engine.handle(command("runs.estimateResume", { runId }))).error.code).toBe("VALIDATION");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(posts);
  });

  // ---------- a run whose cap is used up has ended ----------

  /** What the run has committed once every open reserve is closed at its worst case: the writer, two photos, two aborted requests. */
  const COMMITTED_AFTER_TWO = 11_200 + 2 * 40_000 + 2 * 50_000;
  /** One more image attempt, the least the two open slots' resume must still be able to reserve (the writer is done). */
  const ONE_ATTEMPT = 50_000;

  /** Lowers the run's cap on disk so that `room` micros are left over what it has committed. */
  async function capLeaving(runId: string, room: number): Promise<void> {
    const plan = planOf(runId);
    await writeFile(join(dir(), "library", "runs", runId, "plan.json"), JSON.stringify({ ...plan, capMicros: COMMITTED_AFTER_TWO + room }, null, 2));
  }

  function summaryOf(response: ResponseMessage, runId: string) {
    const answer = ok(response);
    if (answer.type !== "runs.list") throw new Error(`expected a runs.list answer, got ${answer.type}`);
    return answer.result.runs.find((r) => r.runId === runId);
  }

  /** A restarted engine whose open reserves are already reconciled: what the run committed is settled, so its cap room is known. */
  async function restartedAndReconciled(received: string[]) {
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));
    return second;
  }

  test("runs.list: a stopped run whose cap cannot fund one more attempt has ended: not resumable, capExhausted, its slots still open", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, ONE_ATTEMPT - 1);
    const second = await restartedAndReconciled(received);

    expect(summaryOf(await second.engine.handle(command("runs.list")), runId)).toMatchObject({
      open: 2,
      running: false,
      resumable: false,
      capExhausted: true,
      remainingWorstMicros: ONE_ATTEMPT - 1,
    });
  });

  test("runs.list: a cap that leaves exactly one attempt still funds the resume (the boundary)", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, ONE_ATTEMPT);
    const second = await restartedAndReconciled(received);

    expect(summaryOf(await second.engine.handle(command("runs.list")), runId)).toMatchObject({ open: 2, resumable: true, capExhausted: false });
  });

  // Open reserves count at their worst case only until the user reconciles: until then the cap room is not final, so
  // the run is not declared ended (a reconcile settles them, and the estimate is still free to ask).
  test("runs.list: while the ledger needs a reconcile, a run is not reported cap-exhausted, and runs.estimateResume still answers", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, ONE_ATTEMPT - 1);
    const second = await restarted(received);

    expect(summaryOf(await second.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: true, capExhausted: false });
    expect((await remainingWorst(second.engine, runId)).worstMicros).toBe(ONE_ATTEMPT - 1);

    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));
    expect(summaryOf(await second.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: false, capExhausted: true });
  });

  // The reconcile a run waits for is about ITS OWN open reserves. Another scope's leftover (or a torn line) makes the
  // ledger need a reconcile, but it cannot change this run's committed money, so it must not keep a final run resumable.
  test("runs.list: another scope's open reserve does not keep a cap-exhausted run resumable, and its estimate still refuses RUN_CAP_EXCEEDED", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, ONE_ATTEMPT - 1);
    await restartedAndReconciled(received);
    const ledger = await Ledger.open(join(dir(), "userData", "ledger.jsonl"));
    await ledger.append({ type: "reserve", attemptId: "att-foreign-0001", jobId: "job-foreign-0001", scope: { avatarJobId: "job-foreign-0001" }, model: "x-ai/grok-4.3", worstMicros: 1_000, at: new Date(LATER).toISOString() });
    const third = await restarted(received);

    expect(ok(await third.engine.handle(command("money.status")))).toMatchObject({ result: { reconcileNeeded: true } });
    expect(summaryOf(await third.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: false, capExhausted: true });
    expect(failed(await third.engine.handle(command("runs.estimateResume", { runId }))).error.code).toBe("RUN_CAP_EXCEEDED");
  });

  test("runs.list: a torn ledger line does not keep a cap-exhausted run resumable", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, ONE_ATTEMPT - 1);
    await restartedAndReconciled(received);
    await appendFile(join(dir(), "userData", "ledger.jsonl"), '{"type":"reserve","attem');
    const third = await restarted(received);

    expect(ok(await third.engine.handle(command("money.status")))).toMatchObject({ result: { reconcileNeeded: true, reconcileReasons: ["torn-ledger-line"] } });
    expect(summaryOf(await third.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: false, capExhausted: true });
    expect(failed(await third.engine.handle(command("runs.estimateResume", { runId }))).error.code).toBe("RUN_CAP_EXCEEDED");
  });

  test("runs.list: a cap with no room at all left is exhausted too, and so is one already committed past (a bill above its worst case)", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, 0);
    const second = await restartedAndReconciled(received);
    expect(summaryOf(await second.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: false, capExhausted: true, remainingWorstMicros: 0 });

    await capLeaving(runId, -1);
    const third = await restarted(received);
    third.advance(10 * 60_000);
    ok(await third.engine.handle(command("money.reconcile")));
    expect(summaryOf(await third.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: false, capExhausted: true, remainingWorstMicros: 0 });
  });

  test("runs.estimateResume and runs.resume refuse a cap-exhausted run with RUN_CAP_EXCEEDED, free: nothing is sent and the ledger does not move", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, ONE_ATTEMPT - 1);
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));
    const posts = second.net.calls.filter((c) => c.method === "POST").length;
    const ledger = readLedgerLines(join(dir(), "userData", "ledger.jsonl")).length;

    expect(failed(await second.engine.handle(command("runs.estimateResume", { runId }))).error.code).toBe("RUN_CAP_EXCEEDED");
    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("RUN_CAP_EXCEEDED");
    // Asking again gives the same answer: the refused resume left the avatar unclaimed and no job behind.
    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("RUN_CAP_EXCEEDED");
    expect(second.net.calls.filter((c) => c.method === "POST")).toHaveLength(posts);
    expect(readLedgerLines(join(dir(), "userData", "ledger.jsonl"))).toHaveLength(ledger);
    expect(summaryOf(await second.engine.handle(command("runs.list")), runId)).toMatchObject({ resumable: false, capExhausted: true, running: false });
  });

  test("a cap-exhausted run's refusal keeps the resume's order: the ledger's RECONCILE_REQUIRED first, then NOT_FOUND for an unknown run, then RUN_CAP_EXCEEDED", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    await capLeaving(runId, 0);
    const second = await restarted(received);

    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("RECONCILE_REQUIRED");
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));
    expect(failed(await second.engine.handle(resumeAnyway("run-00000404"))).error.code).toBe("NOT_FOUND");
    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("RUN_CAP_EXCEEDED");
  });

  test("the key OpenRouter rejected mid-run is marked rejected, and a resume is refused until a new key is stored", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const { engine, events } = await engineOver(net);
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));

    // The run failed before any slot finished, so no slot's progress ever named it (only its launch did): its end names it too.
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.failed", payload: { kind: "run", jobId, runId, avatarId, error: { code: "AUTH_INVALID" } } });
    expect(runEvents(events(), jobId).some((e) => e.type === "job.progress" && e.payload.done > 0)).toBe(false);
    expect(events().some((e) => e.type === "settings.changed" && e.payload.settings.apiKey.rejected)).toBe(true);
    expect(failed(await engine.handle(resumeAnyway(runId))).error.code).toBe("AUTH_INVALID");
  });

  // Review M3: a resume spends only what the owner accepted, like a start.
  test("estimateResume answers what the open slots could still spend; one micro under it is PRICE_CHANGED and spends nothing; exactly it resumes, in the same process after a cancel", async () => {
    const avatarId = await seedAvatar();
    const received: string[] = [];
    const net = runNetwork({ received, image: (_call, n) => (n >= 3 && n <= 4 ? { hang: true } : { status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) }) });
    const { engine, events } = await engineOver(net);
    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length === 4, "every slot's first request");
    await until(() => runEvents(events(), jobId).filter((e) => e.type === "job.progress").length === 3, "the launch and the photos that arrived");
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);

    // Two open slots, each with two ids left, at the dearest model: the writer is done.
    expect(await remainingWorst(engine, runId)).toEqual({ expectedMicros: 2 * 50_000, worstMicros: 2 * 2 * 50_000, prices: "fallback", pricesAsOf: "2026-09-24" });
    const posts = net.calls.filter((c) => c.method === "POST").length;
    expect(failed(await resume(engine, runId, -1)).error.code).toBe("PRICE_CHANGED");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(posts);

    const resumed = started(await resume(engine, runId));
    expect(await jobEnd(events, resumed.jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });
    expect(new Set(received).size).toBe(received.length);
    expect(planOf(runId).capMicros).toBe(FOUR_WORST);
  });

  test("a resume the month has no room for is refused with BUDGET_EXCEEDED before anything is sent", async () => {
    const { runId, received } = await interrupted({ hangFrom: 3 });
    const second = await restarted(received);
    second.advance(10 * 60_000);
    ok(await second.engine.handle(command("money.reconcile")));
    const status = ok(await second.engine.handle(command("money.status")));
    if (status.type !== "money.status" || status.result.ledger !== "open") throw new Error("expected an open ledger");
    const { worstMicros } = await remainingWorst(second.engine, runId);
    const tight = status.result.spentMicros + status.result.unsettledMicros + worstMicros - 1;
    await second.engine.applyControl({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: tight }) });

    const posts = second.net.calls.filter((c) => c.method === "POST").length;
    expect(failed(await resume(second.engine, runId)).error.code).toBe("BUDGET_EXCEEDED");
    expect(second.net.calls.filter((c) => c.method === "POST")).toHaveLength(posts);
  });
});

// ---------- invariant 8: the image age check needs its gate (review M2) ----------

describe("a run with the image age check on", () => {
  test("is refused with AGE_GATE_UNAVAILABLE while no age gate is wired: nothing is written or sent", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net, { imageAgeCheck: "on" });

    expect(failed(await engine.handle(startRun(avatarId, FOUR_ON_WORST))).error.code).toBe("AGE_GATE_UNAVAILABLE");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
  });

  test("starts with an age gate registered, every photo passing through it, its cap pricing an age check per attempt", async () => {
    const avatarId = await seedAvatar();
    const gate = ageGate();
    const { engine, events } = await engineOver(runNetwork(), { imageAgeCheck: "on", qaGates: [gate] });

    const { runId, jobId } = started(await engine.handle(startRun(avatarId, FOUR_ON_WORST)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });
    expect(gate.inputs).toHaveLength(4);
    expect(planOf(runId).capMicros).toBe(FOUR_ON_WORST);
  });

  test("a run started with the check on is not resumed by an engine without its age gate", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const first = await engineOver(net, { imageAgeCheck: "on", qaGates: [ageGate()] });
    const { runId, jobId } = started(await first.engine.handle(startRun(avatarId, FOUR_ON_WORST)));
    await until(() => net.imageCalls().length === 4, "every slot's first request");
    ok(await first.engine.handle(command("runs.cancel", { runId })));
    await jobEnd(first.events, jobId);

    // A restarted engine with the toggle turned off since: the run keeps its own mode, captured at start.
    let mono = 0;
    const second = await engineOver(runNetwork(), { imageAgeCheck: "off", bootId: "boot-0000-bbbb", clock: () => NOW + 10 * 60_000, monotonic: () => mono });
    mono += 10 * 60_000;
    ok(await second.engine.handle(command("money.reconcile")));
    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("AGE_GATE_UNAVAILABLE");
  });
});

// ---------- T7b: the face gate is always required, never a toggle (unlike the age gate) ----------

describe("a run with no face gate wired", () => {
  test("is refused with FACE_GATE_UNAVAILABLE: nothing is written or sent", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net, { qaGates: null });

    expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("FACE_GATE_UNAVAILABLE");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
  });

  test("M3: FACE_GATE_UNAVAILABLE carries the startup load error in its detail, when the engine was told one", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net, { qaGates: null, faceGateLoadError: "the face models could not be read: ENOENT models/face_detection_yunet_2023mar.onnx" });

    const response = failed(await engine.handle(startRun(avatarId)));
    expect(response.error.code).toBe("FACE_GATE_UNAVAILABLE");
    expect(response.error.detail).toContain("the face models could not be read");
  });

  test("a resume is also refused with FACE_GATE_UNAVAILABLE by an engine without one", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const first = await engineOver(net, {});
    const { runId, jobId } = started(await first.engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length === 4, "every slot's first request");
    ok(await first.engine.handle(command("runs.cancel", { runId })));
    await jobEnd(first.events, jobId);

    let mono = 0;
    const second = await engineOver(runNetwork(), { qaGates: null, bootId: "boot-0000-cccc", clock: () => NOW + 10 * 60_000, monotonic: () => mono });
    mono += 10 * 60_000;
    ok(await second.engine.handle(command("money.reconcile")));
    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("FACE_GATE_UNAVAILABLE");
  });
});

// A worker that could not be terminated leaves the face gate broken until the engine restarts: every check would fail.
// A master whose embedding is already cached used to pass prepare() and pay for a wave of images before the first check failed.
describe("a run once the face gate is broken", () => {
  test("a new run for an avatar whose master embedding is cached is refused FACE_GATE_UNAVAILABLE at start: 0 POST, 0 reserves, no run folder", async () => {
    const avatarId = await seedAvatar();
    let broken = false;
    const face = createFaceQaGate({
      faceGate: { isBroken: () => broken, embed: async () => new Float32Array([1, 0, 0]), check: async () => ({ kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 }) },
    });
    const net = runNetwork();
    const { engine, events } = await engineOver(net, { qaGates: [face] });
    const first = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
    await jobEnd(events, first.jobId); // the master's embedding is now cached
    const posts = net.calls.filter((c) => c.method === "POST").length;
    const reserves = () => readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve").length;
    const reservesBefore = reserves();
    const runsBefore = readdirSync(join(dir(), "library", "runs"));

    broken = true;
    const refused = failed(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));

    expect(refused.error.code).toBe("FACE_GATE_UNAVAILABLE");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(posts);
    expect(reserves()).toBe(reservesBefore);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual(runsBefore);
  });

  test("a resume is refused FACE_GATE_UNAVAILABLE too: 0 POST and no new reserve", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const first = await engineOver(net, {});
    const { runId, jobId } = started(await first.engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length === 4, "every slot's first request");
    ok(await first.engine.handle(command("runs.cancel", { runId })));
    await jobEnd(first.events, jobId);

    let mono = 0;
    const net2 = runNetwork();
    const brokenFace: QaGate = { name: "face", paid: false, available: () => false, check: async () => ({ verdict: "pass" }) };
    const second = await engineOver(net2, { qaGates: [brokenFace], bootId: "boot-0000-dddd", clock: () => NOW + 10 * 60_000, monotonic: () => mono });
    mono += 10 * 60_000;
    ok(await second.engine.handle(command("money.reconcile")));
    const reserves = () => readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve").length;
    const before = reserves();

    expect(failed(await second.engine.handle(resumeAnyway(runId))).error.code).toBe("FACE_GATE_UNAVAILABLE");
    expect(net2.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(reserves()).toBe(before);
  });
});

// ---------- T7a: a wired age gate is never called (and never reserved for) while the toggle is off ----------

describe("a run with the image age check off, even with a fake age gate wired", () => {
  test("never calls the age gate and never reserves for it", async () => {
    const avatarId = await seedAvatar();
    const gate = ageGate();
    const { engine, events } = await engineOver(runNetwork(), { imageAgeCheck: "off", qaGates: [gate] });

    const { jobId } = started(await engine.handle(startRun(avatarId)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });
    expect(gate.inputs).toHaveLength(0);

    const reserves = readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve");
    expect(reserves.some((r) => typeof r.attemptId === "string" && r.attemptId.endsWith(":age"))).toBe(false);
  });
});

// ---------- T7a whole-slice review: the REAL age gate, wired through a real engine and run ----------
// (a run-level test with createAgeGate itself, not the local fake — this is what would have caught
// findings 1-3: the FIFO-queued timeout, the paid-gate-after-stop send, and the missing beforeSend forward).

describe("a run with the real createAgeGate wired (not the local fake)", () => {
  test("every photo passes through it for real: reserved, sent and settled under its own :age attempt id, qa.age stored on each photo", async () => {
    const avatarId = await seedAvatar();
    const { engine, events } = await engineOver(runNetwork(), { imageAgeCheck: "on", qaGates: [createAgeGate()] });

    const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_ON_WORST)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });

    const lines = readLedgerLines(join(dir(), "userData", "ledger.jsonl"));
    const reserves = lines.filter((l) => l.type === "reserve");
    const ageReserves = reserves.filter((r) => typeof r.attemptId === "string" && r.attemptId.endsWith(":age"));
    expect(ageReserves).toHaveLength(4);
    // T7a re-review (finding L4): the title promises "settled" and "qa.age stored" — pin both, not
    // just that a reserve line exists (a reserve alone says nothing about how the attempt ended).
    for (const reserve of ageReserves) {
      const close = lines.find((l) => l.type !== "reserve" && l.attemptId === reserve.attemptId);
      expect(close?.type).toBe("settle");
    }
    // Excludes seedAvatar's own master photo (also carries a qa.age, but is not one of the run's own).
    const masterPhotoId = engine.library?.getAvatar(avatarId)?.masterPhotoId;
    const generated = (engine.library?.photosByAvatar(avatarId) ?? []).filter((p) => p.id !== masterPhotoId);
    expect(generated).toHaveLength(4);
    expect(generated.every((p) => p.qa.age?.adult === true)).toBe(true);
  });

  test("network 1, a slow image: no deadlock and no lost slots with the real age gate under a constrained pool (a basic sanity check — NOT a proof of finding 1's own fix: a 60 ms image against a ~682 s gate timeout cannot distinguish 'fixed' from 'still broken'; runJob.test.ts's own repro A pins that)", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork({
      image: async (_call, n) => {
        if (n > 1) await new Promise((resolve) => setTimeout(resolve, 60));
        return { status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) };
      },
    });
    const { engine, events } = await engineOver(net, { imageAgeCheck: "on", qaGates: [createAgeGate()], network: 1 });

    const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_ON_WORST)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });
  });
});

// ---------- T7b whole-slice: the real face gate adapter (a fake underlying FaceGate, so no ONNX
// model is needed here — parity.test.ts and faceGate.test.ts cover that), wired through a real
// engine and run alongside the real pdq gate ----------

describe("a run with the real createFaceQaGate wired, alongside the real pdq gate", () => {
  test("a face-gate retry does not leave a dangling pdq claim: the slot's next (byte-identical) attempt still passes pdq instead of wrongly reading its own earlier claim as a duplicate", async () => {
    const avatarId = await seedAvatar();
    let faceChecks = 0;
    const face = createFaceQaGate({
      faceGate: {
        isBroken: () => false,
        embed: async () => new Float32Array([1, 0, 0]),
        // This slot's first attempt mismatches (retried); its second matches. The network's default
        // handler returns the exact same image bytes for both — a real near-duplicate by content —
        // so this pins that pdq's own claim from the first (never-stored) attempt was released: the
        // second attempt must still pass pdq, not be wrongly retried as a duplicate of its own slot's
        // earlier, already-released claim.
        check: async () => {
          faceChecks++;
          return faceChecks === 1 ? { kind: "mismatch" as const, similarity: 0.3, faces: 1, headRatio: 0.3 } : { kind: "match" as const, similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      },
    });
    const { engine, events } = await engineOver(runNetwork(), {
      qaGates: [createPdqGate(), face],
    });

    const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });
    expect(faceChecks).toBe(2);

    const masterPhotoId = engine.library?.getAvatar(avatarId)?.masterPhotoId;
    const generated = (engine.library?.photosByAvatar(avatarId) ?? []).filter((p) => p.id !== masterPhotoId);
    expect(generated).toHaveLength(1);
    expect(generated[0]?.qa.faceCos).toBeCloseTo(0.9, 6);
    expect(generated[0]?.qa.headRatio).toBeCloseTo(0.3, 6);
    expect(typeof generated[0]?.qa.pdq).toBe("string"); // pdq ran too, and recorded its own verdict — no interference either way.
  });

  test("computes the master embedding once and reuses it across every one of the run's photos", async () => {
    const avatarId = await seedAvatar();
    let embedCalls = 0;
    const net = runNetwork({
      // A different render per attempt (pdq's own near-duplicate check would otherwise retry every
      // slot after the first against the run's own earlier, already-stored photo — not what this
      // test is about; the master-embed test above covers same-bytes retries within one slot).
      image: (_call, n) => ({ status: 200, body: imageBody(portraitPng(n), { cost: 0.04 }) }),
    });
    const face = createFaceQaGate({
      faceGate: {
        isBroken: () => false,
        embed: async () => {
          embedCalls++;
          return new Float32Array([1, 0, 0]);
        },
        check: async () => ({ kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 }),
      },
    });
    const { engine, events } = await engineOver(net, {
      qaGates: [createPdqGate(), face],
    });

    const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 3)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 0 } } });

    const masterPhotoId = engine.library?.getAvatar(avatarId)?.masterPhotoId;
    const generated = (engine.library?.photosByAvatar(avatarId) ?? []).filter((p) => p.id !== masterPhotoId);
    expect(generated).toHaveLength(3);
    expect(embedCalls).toBe(1);
    expect(generated.every((p) => typeof p.qa.faceCos === "number")).toBe(true);
  });

  // Money review M4: the version of this test before the fix only ever ran
  // ONE slot with no actual duplicate in play — it pinned that pdq's check()
  // was CALLED first, never that a near-duplicate is caught by pdq and the
  // face gate is skipped entirely for that attempt (its own title's claim).
  // This version seeds a real prior photo whose stored `qa.pdq` hash is the
  // real PDQ hash of the exact bytes every attempt below will generate
  // (computed the same way the production gate does: decodeGray64 +
  // computePdqHash), so pdq's own real check() genuinely retries every
  // attempt as a duplicate — the face gate must never be reached at all.
  test("pdq runs before face: a near-duplicate is caught by pdq and the face gate is never called for that attempt", async () => {
    const avatarId = await seedAvatar();
    const duplicateBytes = portraitPng(3);
    const duplicateHash = Buffer.from(computePdqHash(await decodeGray64(duplicateBytes))).toString("hex");

    const { library: seedLibrary } = await openLibrary(join(dir(), "library"), { newId: sequentialIds("dup") });
    await seedLibrary.addPhoto(avatarId, duplicateBytes, samplePhotoMeta({ qa: { pdq: duplicateHash } }));

    const order: string[] = [];
    const face = createFaceQaGate({
      faceGate: {
        isBroken: () => false,
        embed: async () => new Float32Array([1, 0, 0]),
        check: async () => {
          order.push("face");
          return { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 };
        },
      },
    });
    const pdqReal = createPdqGate();
    const pdq: QaGate = {
      ...pdqReal,
      check: async (input) => {
        order.push("pdq");
        return pdqReal.check(input);
      },
      releaseClaim: pdqReal.releaseClaim?.bind(pdqReal),
    };
    const { engine, events } = await engineOver(runNetwork({ image: () => ({ status: 200, body: imageBody(duplicateBytes, { cost: 0.04 }) }) }), {
      qaGates: [pdq, face],
    });

    const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
    // Every one of the slot's 3 attempts generates the identical (seeded)
    // bytes, so pdq retries every one of them as a duplicate: the slot ends
    // without a photo, never having reached the face gate at all.
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done", payload: { result: { failedSlots: 1 } } });

    expect(order.length).toBeGreaterThan(0);
    expect(order.every((g) => g === "pdq")).toBe(true);
    expect(order).not.toContain("face");
  });
});

// ---------- re-review, MUST FIX 1/2 (N1, normalization): the real face gate on unusual masters ----------

const RR_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RR_MODEL_PATHS = faceModelPaths(RR_ROOT);
const RR_MODELS_PRESENT = existsSync(RR_MODEL_PATHS.yunet) && existsSync(RR_MODEL_PATHS.sface);
const RR_MASTER_JPEG = join(RR_ROOT, "studio", "engine", "face", "fixtures", "images", "master.jpg");

/** `master.jpg` (864x1152), re-encoded via the bundled ffmpeg — never a committed large binary — to the exact byte size/format each case needs. */
function transcodedMaster(args: string[]): Uint8Array {
  const result = spawnSync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-i", RR_MASTER_JPEG, ...args, "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg could not transcode the master fixture: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}

/** Seeds a fresh avatar whose ONLY photo (and master) is exactly `bytes`, at `mediaType`/`width`/`height` — an imported avatar, matching how a real WebP/oversized import is stored. */
async function seedWithMaster(bytes: Uint8Array, mediaType: "image/jpeg" | "image/png" | "image/webp", width: number, height: number): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`rrseed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Imported", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, bytes, samplePhotoMeta({ mediaType, width, height, source: SAMPLE_IMPORTED_SOURCE, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

describe.skipIf(!RR_MODELS_PRESENT)("re-review N1/normalization: the real face gate completes a run on every master format/size the app can import", () => {
  const cases = [
    { name: "864x1152 JPEG (the calibrated control size)", args: ["-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg"], mediaType: "image/jpeg" as const, w: 864, h: 1152 },
    { name: "the same portrait as WebP (import accepts WebP, importStaging.ts:26) — N1", args: ["-c:v", "libwebp", "-q:v", "90", "-f", "webp"], mediaType: "image/webp" as const, w: 864, h: 1152 },
    { name: "the same portrait at 1296x1728 (x1.5) — normalization", args: ["-vf", "scale=1296:1728", "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg"], mediaType: "image/jpeg" as const, w: 1296, h: 1728 },
    { name: "the same portrait at 3024x4032 (12 MP phone size) — normalization", args: ["-vf", "scale=3024:4032", "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg"], mediaType: "image/jpeg" as const, w: 3024, h: 4032 },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const bytes = transcodedMaster(c.args);
      const avatarId = await seedWithMaster(bytes, c.mediaType, c.w, c.h);
      const real = sharedRealFaceGate();
      try {
        const net = runNetwork({ image: () => ({ status: 200, body: imageBody(portraitPngFace(), { cost: 0.04 }) }) });
        const { engine, events } = await engineOver(net, { qaGates: [createPdqGate(), createFaceQaGate({ faceGate: real })] });
        const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
        const end = await jobEnd(events, jobId);
        expect(end.type).toBe("job.done");
        if (end.type !== "job.done") throw new Error("unreachable");
        expect(end.payload.result.kind === "run" ? end.payload.result.failedSlots : -1).toBe(0);
      } finally {
        // the real gate is shared by the whole test process (sharedRealFaceGate)
      }
    }, 30_000);
  }

  test("864x1152 JPEG still embeds from the ORIGINAL bytes, not loadMaster()'s downscaled reference (M1/N1 unchanged)", async () => {
    const bytes = transcodedMaster(["-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg"]);
    const avatarId = await seedWithMaster(bytes, "image/jpeg", 864, 1152);
    const real = sharedRealFaceGate();
    const seenMasterBytes: Uint8Array[] = [];
    const observing = {
      isBroken: () => real.isBroken(),
      check: real.check,
      embed: (b: Uint8Array, signal: AbortSignal) => {
        if (b.byteLength === bytes.byteLength) seenMasterBytes.push(b);
        return real.embed(b, signal);
      },
    };
    try {
      const net = runNetwork({ image: () => ({ status: 200, body: imageBody(portraitPngFace(), { cost: 0.04 }) }) });
      const { engine, events } = await engineOver(net, { qaGates: [createFaceQaGate({ faceGate: observing })] });
      const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
      await jobEnd(events, jobId);
      expect(seenMasterBytes.some((b) => Buffer.from(b).equals(Buffer.from(bytes)))).toBe(true);
    } finally {
      // the real gate is shared by the whole test process (sharedRealFaceGate)
    }
  }, 30_000);

  // ---------- final round, M1: a CMYK JPEG master the WASM decoder cannot read ----------

  test("M1: a CMYK JPEG master (ffmpeg/import tolerate it, the WASM decoder cannot) falls back to the reference and still completes", async () => {
    // A real, committed CMYK JPEG (master.jpg's own face, converted to CMYK
    // and downscaled via ImageMagick) — sniffs as image/jpeg, so
    // masterOriginalFor() picks the ORIGINAL bytes, which is exactly the
    // case that must fall back once the decoder rejects them.
    const bytes = readFileSync(join(RR_ROOT, "studio", "engine", "face", "fixtures", "images", "master-cmyk.jpg"));
    const avatarId = await seedWithMaster(new Uint8Array(bytes), "image/jpeg", 300, 400);
    const real = sharedRealFaceGate();
    try {
      const net = runNetwork({ image: () => ({ status: 200, body: imageBody(portraitPngFace(), { cost: 0.04 }) }) });
      const { engine, events } = await engineOver(net, { qaGates: [createFaceQaGate({ faceGate: real })] });
      const { jobId } = started(await engine.handle(startRun(avatarId, FOUR_WORST, 1)));
      const end = await jobEnd(events, jobId);
      expect(end.type).toBe("job.done");
      if (end.type !== "job.done") throw new Error("unreachable");
      // Before the fix: prepareGates() lets the WASM decoder's "Unsupported
      // color conversion" (an emscripten ExitStatus, not an Error) propagate
      // straight out of prepare() -> the job ends INTERNAL, never MASTER_FACE_UNUSABLE
      // (there IS a usable face -- the decoder just can't read this file).
      expect(end.payload.result.kind === "run" ? end.payload.result.failedSlots : -1).toBe(0);
    } finally {
      // the real gate is shared by the whole test process (sharedRealFaceGate)
    }
  }, 30_000);
});

/** The mock's own run image, composited with the real fixture face so the real gate (used above) can actually pass a slot — the same technique facePool.ts uses for the packaged E2E. */
function portraitPngFace(): Uint8Array {
  const face = join(RR_ROOT, "studio", "engine", "face", "fixtures", "images", "master.jpg");
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=gray:size=200x356:d=1",
    "-i", face,
    "-filter_complex", "[1:v]scale=130:170[f];[0:v][f]overlay=35:20",
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg", "pipe:1",
  ];
  const result = spawnSync(ffmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg could not composite a run image: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}

// ---------- runs.list (review M4) ----------

describe("runs.list", () => {
  /** A run with every slot's first request cut off by a cancel: stopped, resumable. */
  async function stoppedRun(engine: Engine, events: () => EventMessage[], net: ReturnType<typeof runNetwork>, avatarId: string): Promise<string> {
    const before = net.imageCalls().length;
    const worst = await (async () => {
      const answer = ok(await engine.handle(estimate(avatarId)));
      if (answer.type !== "runs.estimate") throw new Error("expected an estimate");
      return answer.result.estimate.worstMicros;
    })();
    const { runId, jobId } = started(await engine.handle(startRun(avatarId, worst)));
    await until(() => net.imageCalls().length === before + 4, "every slot's first request");
    ok(await engine.handle(command("runs.cancel", { runId })));
    await jobEnd(events, jobId);
    return runId;
  }

  test("prices for runs of different models load at once, not one model set after another (review round 3, L-d)", async () => {
    const a = await seedAvatar();
    const b = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const one = await engineOver(net);
    const first = await stoppedRun(one.engine, one.events, net, a);
    await one.engine.applyControl({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { imageAgeCheck: "off", imageModel: "x-ai/grok-imagine-image-quality" }) });
    const second = await stoppedRun(one.engine, one.events, net, b);
    // Every price GET waits until all six of both loads are in flight (or 2 s pass), then fails: the fallback table answers.
    let pending = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const prices = async (): Promise<Reply> => {
      pending++;
      most = Math.max(most, pending);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
        if (waiting.length >= 6) for (const release of waiting.splice(0)) release();
      });
      pending--;
      return OFFLINE;
    };
    const { engine } = await engineOver(runNetwork({ prices }), { bootId: "boot-0000-cccc" });

    const runs = listed(await engine.handle(command("runs.list")));

    expect(most).toBe(6);
    expect(runs.map((r) => r.runId).sort()).toEqual([first, second].sort());
    expect(runs.every((r) => r.remainingWorstMicros !== null && r.remainingWorstMicros > 0)).toBe(true);
  });

  // Fix round 2: one saved run whose model's live prices lost the input_image row (a reference of unknown price cannot be reserved) must
  // not hide the healthy runs: its remaining worst case is unknown (null), and the rest are listed.
  test("a saved run whose model has no listed reference price is listed with an unknown remaining cost, and the other runs stay listed", async () => {
    const a = await seedAvatar();
    const b = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const one = await engineOver(net);
    const first = await stoppedRun(one.engine, one.events, net, a);
    await one.engine.applyControl({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { imageAgeCheck: "off", imageModel: "x-ai/grok-imagine-image-quality" }) });
    const second = await stoppedRun(one.engine, one.events, net, b);
    const grok = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "money", "fixtures", "endpoints-grok-imagine-image-2.0.json"), "utf8"));
    for (const endpoint of grok.endpoints) endpoint.pricing = endpoint.pricing.filter((row: { billable: string }) => row.billable !== "input_image");
    const prices = (call: FetchCall): Reply => (call.url.endsWith("x-ai/grok-imagine-image-2.0/endpoints") ? { status: 200, body: grok } : OFFLINE);
    const { engine } = await engineOver(runNetwork({ prices }), { bootId: "boot-0000-dddd" });

    const runs = listed(await engine.handle(command("runs.list")));
    const byId = new Map(runs.map((r) => [r.runId, r]));

    expect(runs.map((r) => r.runId).sort()).toEqual([first, second].sort());
    expect(byId.get(first)?.remainingWorstMicros).toBeNull();
    expect(byId.get(first)?.resumable).toBe(true);
    expect(byId.get(second)?.remainingWorstMicros ?? 0).toBeGreaterThan(0);
  });

  function listed(response: ResponseMessage) {
    const answer = ok(response);
    if (answer.type !== "runs.list") throw new Error(`expected a runs.list answer, got ${answer.type}`);
    return answer.result.runs;
  }

  test("an empty library lists no runs", async () => {
    const { engine } = await engineOver(runNetwork());
    expect(listed(await engine.handle(command("runs.list")))).toEqual([]);
  });

  test("after a restart, finds a stopped run on disk: its slots, cap, committed money, and what a resume could still spend", async () => {
    const avatarId = await seedAvatar();
    const received: string[] = [];
    const net = runNetwork({ received, image: (_call, n) => (n >= 3 ? { hang: true } : { status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) }) });
    const first = await engineOver(net);
    const { runId, jobId } = started(await first.engine.handle(startRun(avatarId)));
    await until(() => net.imageCalls().length === 4, "every slot's first request");
    await until(() => runEvents(first.events(), jobId).filter((e) => e.type === "job.progress").length === 3, "the launch and the photos that arrived");
    ok(await first.engine.handle(command("runs.cancel", { runId })));
    await jobEnd(first.events, jobId);

    const second = await engineOver(runNetwork({ received }), { bootId: "boot-0000-bbbb" });
    expect(listed(await second.engine.handle(command("runs.list")))).toEqual([
      {
        runId,
        avatarId,
        createdAt: new Date(NOW).toISOString(),
        total: 4,
        done: 2,
        failed: 0,
        open: 2,
        capMicros: FOUR_WORST,
        // The writer's answer, two photos, and two aborted requests at their worst case.
        committedMicros: 11_200 + 2 * 40_000 + 2 * 50_000,
        running: false,
        resumable: true,
        capExhausted: false,
        remainingWorstMicros: 2 * 2 * 50_000,
      },
    ]);
  });

  test("newest first: a running run says it runs and is not resumable; a finished one has nothing left", async () => {
    const first = await seedAvatar();
    const second = await seedAvatar();
    let hang = false;
    const net = runNetwork({ image: () => (hang ? { hang: true } : { status: 200, body: imageBody(portraitPng(2), { cost: 0.04 }) }) });
    const { engine, events } = await engineOver(net);
    const done = started(await engine.handle(startRun(first)));
    await jobEnd(events, done.jobId);
    hang = true;
    const running = started(await engine.handle(startRun(second)));
    await until(() => net.imageCalls().length === 8, "the second run's requests");

    expect(listed(await engine.handle(command("runs.list")))).toEqual([
      expect.objectContaining({ runId: running.runId, avatarId: second, running: true, resumable: false, open: 4 }),
      expect.objectContaining({ runId: done.runId, avatarId: first, done: 4, open: 0, running: false, resumable: false, remainingWorstMicros: 0 }),
    ]);

    ok(await engine.handle(command("runs.cancel", { runId: running.runId })));
    await jobEnd(events, running.jobId);
  });
});

// ---------- an unusable master is refused before a run exists ----------

describe("runs.start with an unusable master: the gates' prepare() runs before anything is planned, reserved or sent", () => {
  /** A face gate whose prepare() says the master has no usable face until `failures` calls have been made. */
  function noFaceGate(prepared: string[], failures = Number.POSITIVE_INFINITY): QaGate {
    return {
      name: "face",
      paid: false,
      prepare: async (input) => {
        prepared.push(input.avatarId);
        if (prepared.length <= failures) throw new NoFaceInReferenceError();
      },
      check: async () => ({ verdict: "pass" }),
    };
  }

  test("MASTER_FACE_UNUSABLE, free: 0 POSTs, no reserve, no run folder, runs.list unchanged, however many times it is clicked", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const prepared: string[] = [];
    const { engine } = await engineOver(net, { qaGates: [noFaceGate(prepared)] });

    for (let click = 0; click < 3; click++) {
      expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("MASTER_FACE_UNUSABLE");
    }

    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readLedgerLines(join(dir(), "userData", "ledger.jsonl")).filter((l) => l.type === "reserve")).toEqual([]);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
    const list = ok(await engine.handle(command("runs.list")));
    expect(list.type === "runs.list" ? list.result.runs : "not a list").toEqual([]);
    expect(prepared).toEqual([avatarId, avatarId, avatarId]);
  });

  test("a systemic prepare failure (not «no face») refuses INTERNAL, just as free, with no run folder", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const broken: QaGate = {
      name: "face",
      paid: false,
      prepare: async () => {
        throw new Error("onnxruntime-web: session run failed");
      },
      check: async () => ({ verdict: "pass" }),
    };
    const { engine } = await engineOver(net, { qaGates: [broken] });

    expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("INTERNAL");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
  });

  test("a refused start leaves the avatar free: the next start, with the master now usable, runs", async () => {
    const avatarId = await seedAvatar();
    const prepared: string[] = [];
    const { engine, events } = await engineOver(runNetwork(), { qaGates: [noFaceGate(prepared, 1)] });

    expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("MASTER_FACE_UNUSABLE");
    const { jobId } = started(await engine.handle(startRun(avatarId)));

    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.done" });
    expect(readdirSync(join(dir(), "library", "runs"))).toHaveLength(1);
  });

  test("a start that passes prepares the gates twice: its own look before planning, and the job's own (cheap once cached), which a resume needs too", async () => {
    const avatarId = await seedAvatar();
    const prepared: string[] = [];
    const { engine, events } = await engineOver(runNetwork(), { qaGates: [noFaceGate(prepared, 0)] });

    const { jobId } = started(await engine.handle(startRun(avatarId)));
    await jobEnd(events, jobId);

    expect(prepared).toEqual([avatarId, avatarId]);
  });

  test("a run whose master turns unusable after its start check ends its open slots: runs.list shows it ended, not resumable", async () => {
    const avatarId = await seedAvatar();
    const prepared: string[] = [];
    // The start's own look passes (call 1); the job's prepare (call 2) finds no usable face.
    const late: QaGate = {
      name: "face",
      paid: false,
      prepare: async (input) => {
        prepared.push(input.avatarId);
        if (prepared.length > 1) throw new NoFaceInReferenceError();
      },
      check: async () => ({ verdict: "pass" }),
    };
    const net = runNetwork();
    const { engine, events } = await engineOver(net, { qaGates: [late] });

    const { runId, jobId } = started(await engine.handle(startRun(avatarId)));
    expect(await jobEnd(events, jobId)).toMatchObject({ type: "job.failed", payload: { kind: "run", runId, error: { code: "MASTER_FACE_UNUSABLE" } } });

    const list = ok(await engine.handle(command("runs.list")));
    expect(list.type === "runs.list" ? list.result.runs.find((r) => r.runId === runId) : "not a list").toMatchObject({ done: 0, failed: 4, open: 0, resumable: false, capExhausted: false });
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("the refusals that come first still come first: PRICE_CHANGED is answered without preparing anything", async () => {
    const avatarId = await seedAvatar();
    const prepared: string[] = [];
    const { engine } = await engineOver(runNetwork(), { qaGates: [noFaceGate(prepared)] });

    expect(failed(await engine.handle(startRun(avatarId, FOUR_WORST - 1))).error.code).toBe("PRICE_CHANGED");
    expect(prepared).toEqual([]);
  });
});

// ---------- more of runs.start, and the shared pool (review L16) ----------

describe("runs.start refusals and the shared network pool", () => {
  test("BUDGET_EXCEEDED when the month has no room for the run's worst case: nothing is written or sent", async () => {
    const avatarId = await seedAvatar();
    const net = runNetwork();
    const { engine } = await engineOver(net, { monthlyBudgetMicros: FOUR_WORST - 1 });

    expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
  });

  test("RECONCILE_REQUIRED while an earlier process's reserve is open: nothing is written or sent", async () => {
    const avatarId = await seedAvatar();
    await writeLedger(dir(), [{ type: "reserve", attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 5_250, at: new Date(NOW).toISOString() }]);
    const net = runNetwork();
    const { engine } = await engineOver(net);

    expect(failed(await engine.handle(startRun(avatarId))).error.code).toBe("RECONCILE_REQUIRED");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(readdirSync(join(dir(), "library", "runs"))).toEqual([]);
  });

  test("two runs share the engine's network pool: at most its concurrency is in flight across both", async () => {
    const first = await seedAvatar();
    const second = await seedAvatar();
    const net = runNetwork({ image: () => ({ hang: true }) });
    const { engine, events } = await engineOver(net, { network: 2 });

    const a = started(await engine.handle(startRun(first)));
    const b = started(await engine.handle(startRun(second)));
    await until(() => net.imageCalls().length === 2, "two image requests");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(net.imageCalls()).toHaveLength(2);

    ok(await engine.handle(command("runs.cancel", { runId: a.runId })));
    ok(await engine.handle(command("runs.cancel", { runId: b.runId })));
    await jobEnd(events, a.jobId);
    await jobEnd(events, b.jobId);

  });
});
