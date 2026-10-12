import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResponseMessage } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import type { FetchCall, Reply } from "./openrouter/testing/fakes";
import { RunPlanSchema, type RunPlan } from "./runs/plan";
import type { QaGate } from "./runs/qa";
import { command, engineSettings, failed, GOOD, jobEnd, network, OFFLINE, ok, portraitPng, portraitReply, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(60_000);

// 5a.3 (S5.9d, round 3): the «Смелая» route end to end on the merged tree (S5.9c's planner and sets + S5.9d's route and money), over a real engine, ledger and library and a fake
// OpenRouter. (a) a run: the plan names the route, Seedream is asked at 2K with one reference and every other slot as before, the cap is the estimate, the photo says it is
// Seedream's. (b) a composed set: the estimate counts the routed scenes, carries the 2K attempt, and a start on a stale accepted figure is PRICE_CHANGED when the 2K price rose.
// (d) the resume of an engine-planned run: a refusal stays ended and sends nothing, a 429 continues on the bold route.

const dir = useEngineDir("studio-engine-bold-e2e-");
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const SEEDREAM_URL = "bytedance-seed/seedream-5-0-pro/endpoints";
const POSES = { profile: false, back: false };
const GROK_ATTEMPT = 50_000;
const BOLD_ATTEMPT = 93_000;
const MODERATION: Reply = { status: 400, body: { error: { message: "Seedream blocked this request through content moderation." } } };
const RATE_LIMITED: Reply = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };

const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });
const isSeedream = (call: FetchCall): boolean => call.json().model === SEEDREAM;

let seeded = 0;
async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

type Handler = (call: FetchCall, n: number) => Reply;
const drawn: Handler = (_call, n) => portraitReply(((n - 1) % 4) + 1);

async function boot(image: Handler, opts: { prices?: (call: FetchCall) => Reply; monotonic?: () => number } = {}) {
  const net = network({ image, ...(opts.prices === undefined ? {} : { prices: opts.prices }) });
  const started = await startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }) },
    net,
    deps: { qaGates: [faceGate()], ...(opts.monotonic === undefined ? {} : { monotonic: opts.monotonic }) },
  });
  return { ...started, net };
}
type Booted = Awaited<ReturnType<typeof boot>>;

function planOf(runId: string): RunPlan {
  return RunPlanSchema.parse(JSON.parse(readFileSync(join(dir(), "library", "runs", runId, "plan.json"), "utf8")));
}
const routedOf = (plan: RunPlan): number => plan.scenes.slots.filter((s) => "route" in s && s.route === "seedream").length;

function journalOf(runId: string): { type: string; status?: string; error?: { sceneReason?: string } }[] {
  return readFileSync(join(dir(), "library", "runs", runId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const runRequest = (avatarId: string, count: number) => ({ avatarId, count, categories: ["nightwear"], level: "bold", poses: POSES });

function estimateOf(response: ResponseMessage) {
  const answer = ok(response);
  if (answer.type !== "runs.estimate" && answer.type !== "runs.estimateFromScenes" && answer.type !== "runs.estimateResume") throw new Error(`expected an estimate, got ${answer.type}`);
  return answer.result.estimate;
}

function startedOf(response: ResponseMessage): { runId: string; jobId: string } {
  const answer = ok(response);
  if (answer.type !== "runs.start" && answer.type !== "runs.startFromScenes" && answer.type !== "runs.resume") throw new Error(`expected a run answer, got ${answer.type}`);
  return answer.result;
}

async function photosOf(started: Booted, avatarId: string) {
  const answer = ok(await started.engine.handle(command("photos.list", { avatarId })));
  if (answer.type !== "photos.list") throw new Error("wrong answer");
  return answer.result.photos;
}

describe("(a) runs.start in «Смелая»", () => {
  test("plans the route, asks Seedream at 2K with one reference, leaves the other slots on the settings' model, caps at the estimate and marks the photos", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(drawn);
    const { engine, events, net } = started;
    const estimate = estimateOf(await engine.handle(command("runs.estimate", runRequest(avatarId, 10))));
    expect(estimate.worstMicros).toBe(10 * 3 * BOLD_ATTEMPT);

    const { runId, jobId } = startedOf(await engine.handle(command("runs.start", { ...runRequest(avatarId, 10), acceptedWorstMicros: estimate.worstMicros })));
    expect((await jobEnd(events, jobId)).type).toBe("job.done");

    const plan = planOf(runId);
    const routed = routedOf(plan);
    expect(routed).toBeGreaterThan(0);
    expect(routed).toBeLessThan(10);
    expect(plan.models.bold).toBe(SEEDREAM);
    expect([plan.capMicros, plan.plannedWorstMicros]).toEqual([estimate.worstMicros, estimate.worstMicros]);

    const calls = net.imageCalls();
    const bold = calls.filter(isSeedream);
    const plain = calls.filter((c) => !isSeedream(c));
    expect([bold.length, plain.length]).toEqual([routed, 10 - routed]);
    for (const call of bold) {
      const body = call.json();
      expect({ resolution: body.resolution, aspect: body.aspect_ratio, refs: Array.isArray(body.input_references) ? body.input_references.length : null, quality: "quality" in body }).toEqual({ resolution: "2K", aspect: "9:16", refs: 1, quality: false });
    }
    for (const call of plain) expect([call.json().resolution, call.json().aspect_ratio]).toEqual(["1K", "9:16"]);

    const photos = await photosOf(started, avatarId);
    const ofRun = photos.filter((p) => p.runId === runId);
    expect(ofRun).toHaveLength(10);
    expect(ofRun.filter((p) => p.route === "seedream")).toHaveLength(routed);
    expect(ofRun.filter((p) => p.route === undefined)).toHaveLength(10 - routed);
  });
});

describe("(b) a composed «Смелая» set", () => {
  /** A set of six «Ночнушки и бельё» scenes, composed (the code template writes them: nothing is asked of the writer). */
  async function composed(started: Booted, avatarId: string) {
    const answer = ok(await started.engine.handle(command("scenes.compose", { avatarId, count: 6, categories: ["nightwear"], level: "bold", poses: POSES, acceptedWorstMicros: 0 })));
    if (answer.type !== "scenes.compose") throw new Error("wrong answer");
    if (answer.result.jobId !== null) await jobEnd(started.events, answer.result.jobId);
    const got = ok(await started.engine.handle(command("scenes.get", { avatarId })));
    if (got.type !== "scenes.get" || got.result.sceneSet === null) throw new Error("no set");
    return got.result.sceneSet;
  }

  test("is priced by its routed scenes, carries the 2K attempt, is PRICE_CHANGED when the 2K price rose, and draws the routed scenes at 2K", async () => {
    const avatarId = await seedAvatar();
    let dearer = false;
    let mono = 0;
    const live = (call: FetchCall): Reply => {
      if (!call.url.endsWith(SEEDREAM_URL)) return OFFLINE;
      const body = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "money", "fixtures", "endpoints-seedream-5-0-pro.json"), "utf8")) as { endpoints: { pricing: { variant?: string; cost_usd: number }[] }[] };
      for (const e of body.endpoints) for (const row of e.pricing) if (row.variant === "high_resolution") row.cost_usd = dearer ? 0.12 : 0.09;
      return { status: 200, body };
    };
    const started = await boot(drawn, { prices: live, monotonic: () => mono });
    const { engine, events, net } = started;
    const set = await composed(started, avatarId);
    const active = set.scenes.filter((s) => !s.removed);
    const routed = active.filter((s) => s.route === "seedream").length;
    expect(active).toHaveLength(6);
    expect(routed).toBeGreaterThan(0);

    const asked = command("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision });
    const before = estimateOf(await engine.handle(asked));
    expect(before.worstMicros).toBe(routed * 3 * BOLD_ATTEMPT + (6 - routed) * 3 * GROK_ATTEMPT);
    expect(before.boldAttemptMicros).toBe(BOLD_ATTEMPT);

    // The 2K price rises; the cached prices age out. The figure the owner accepted is now too low.
    dearer = true;
    mono += 11 * 60_000;
    const stale = failed(await engine.handle(command("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros: before.worstMicros })));
    expect(stale.error.code).toBe("PRICE_CHANGED");
    expect(net.paidCalls()).toHaveLength(0);

    const after = estimateOf(await engine.handle(asked));
    expect(after.boldAttemptMicros).toBe(123_000);
    expect(after.worstMicros).toBe(routed * 3 * 123_000 + (6 - routed) * 3 * GROK_ATTEMPT);

    const { runId, jobId } = startedOf(await engine.handle(command("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros: after.worstMicros })));
    expect((await jobEnd(events, jobId)).type).toBe("job.done");
    const plan = planOf(runId);
    expect([plan.capMicros, routedOf(plan), plan.models.bold]).toEqual([after.worstMicros, routed, SEEDREAM]);
    expect(net.imageCalls().filter(isSeedream).map((c) => c.json().resolution)).toEqual(Array.from({ length: routed }, () => "2K"));
  });
});

describe("(d) the resume of an engine-planned run", () => {
  test("a refusal ended its slots as model-refused for good: the resume has nothing to send", async () => {
    const avatarId = await seedAvatar();
    const started = await boot((call, n) => (isSeedream(call) ? MODERATION : drawn(call, n)));
    const { engine, events, net } = started;
    const { runId, jobId } = startedOf(await engine.handle(command("runs.start", { ...runRequest(avatarId, 6), acceptedWorstMicros: 6 * 3 * BOLD_ATTEMPT })));
    expect((await jobEnd(events, jobId)).type).toBe("job.done");
    const routed = routedOf(planOf(runId));
    const refused = journalOf(runId).filter((e) => e.type === "slot" && e.status === "failed" && e.error?.sceneReason === "model-refused");
    expect(refused).toHaveLength(routed);
    expect(net.imageCalls().filter(isSeedream)).toHaveLength(routed);

    const sent = net.imageCalls().length;
    expect(failed(await engine.handle(command("runs.estimateResume", { runId }))).error.code).toBe("VALIDATION");
    expect(failed(await engine.handle(command("runs.resume", { runId, acceptedWorstMicros: 10_000_000 }))).error.code).toBe("VALIDATION");
    expect(net.imageCalls()).toHaveLength(sent);
  });

  test("a 429 leaves the Seedream slots open, and the resume draws them on the bold route at 2K", async () => {
    const avatarId = await seedAvatar();
    let limited = true;
    const started = await boot((call, n) => (limited && isSeedream(call) ? RATE_LIMITED : drawn(call, n)));
    const { engine, events, net } = started;
    const { runId, jobId } = startedOf(await engine.handle(command("runs.start", { ...runRequest(avatarId, 6), acceptedWorstMicros: 6 * 3 * BOLD_ATTEMPT })));
    const end = await jobEnd(events, jobId);
    expect(end.type).toBe("job.failed");
    const routed = routedOf(planOf(runId));
    expect(journalOf(runId).filter((e) => e.type === "slot" && e.error?.sceneReason !== undefined)).toEqual([]);

    limited = false;
    const remaining = estimateOf(await engine.handle(command("runs.estimateResume", { runId })));
    const resumed = startedOf(await engine.handle(command("runs.resume", { runId, acceptedWorstMicros: remaining.worstMicros })));
    expect((await jobEnd(events, resumed.jobId)).type).toBe("job.done");

    const seedreamCalls = net.imageCalls().filter(isSeedream);
    expect(seedreamCalls.every((c) => c.json().resolution === "2K" && JSON.stringify(c.json().input_references).split("image_url\"").length === 3)).toBe(true);
    const photos = (await photosOf(started, avatarId)).filter((p) => p.runId === runId);
    expect(photos).toHaveLength(6);
    expect(photos.filter((p) => p.route === "seedream")).toHaveLength(routed);
  });
});
