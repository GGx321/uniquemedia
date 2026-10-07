import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvatarDescriptor, EngineError } from "../../shared/engine";
import { openLibrary, type Library } from "../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { Budget, scopeKey } from "../money/budget";
import { Ledger, type Scope } from "../money/ledger";
import { PriceBook } from "../money/prices";
import { chatBody, fakeFetch, imageBody, JPEG, makeClient, type FetchCall, type Reply } from "../openrouter/testing/fakes";
import { plan as planScenes } from "../scenes";
import { RunEventSchema, type RunEvent } from "./journal";
import { buildSceneRunPlan, RunPlanSchema, type RunPlan, type SceneRunSource } from "./plan";
import { CpuPool, NetworkPool } from "./pools";
import { reportingTo, runPhotoRun, type RunJobEnd } from "./runJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// CS.5: the run job over a plan made from a reviewed scene set. The sentences are already in the plan, so the job asks the writer for nothing, journals the
// prompts before the first image, and sends images only. An own scene commits like any photo and leaves no line in the avatar's (location, outfit) history.

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };
const PRIMARY = "x-ai/grok-imagine-image-2.0";
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const IMAGE_WORST = 50_000;
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

let dir = "";
let library: Library;
let avatarId = "";
let budget: Budget;
const caps = new Map<string, number>();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-run-job-scenes-"));
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

const planned = planScenes({ seed: 11, count: 5, categories: ["home"] }).slots;

function plannedScene(sceneId: number, text = `${SENTENCE} (${sceneId})`): SceneRunSource {
  return { sceneId, text, slot: planned[sceneId - 1]! };
}
const ownScene = (sceneId: number, text = "She waves at the camera from a rooftop terrace at golden hour."): SceneRunSource => ({ sceneId, text, slot: { kind: "own", shot: "friend", pose: "front" } });

async function newRun(scenes: readonly SceneRunSource[]): Promise<RunPlan> {
  const cap = scenes.length * 3 * IMAGE_WORST;
  const run = buildSceneRunPlan({
    runId: RUN_ID,
    avatarId,
    createdAt: new Date(NOW).toISOString(),
    sceneSetId: "set-00000001",
    imageAgeCheck: "off",
    models: { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" },
    capMicros: cap,
    plannedWorstMicros: cap,
    scenes,
  });
  await library.createRun(RUN_ID, run, RunPlanSchema);
  caps.set(scopeKey(SCOPE), cap);
  return run;
}

function network(image: (call: FetchCall, n: number) => Reply = () => ({ status: 200, body: imageBody(PNG_1X1, { cost: 0.04 }) })) {
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return image(call, ++images);
    if (call.url.endsWith("/chat/completions")) return { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.001 }) };
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return { fetch: net.fetch, calls: net.calls, imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")), chatCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions")) };
}

function start(run: RunPlan, net: ReturnType<typeof network>, opts: { signal?: AbortSignal; jobId?: string; onSlot?: () => void; library?: Library } = {}): Promise<RunJobEnd> {
  const pool = new NetworkPool({ max: 1 });
  const { client } = makeClient(reportingTo(pool, net.fetch));
  return runPhotoRun(
    {
      generateImage: client.generateImage,
      chat: client.chat,
      budget,
      priceBook: PriceBook.fallback(),
      library: opts.library ?? library,
      pool,
      cpu: new CpuPool(2),
      gates: [],
      now: () => new Date(NOW),
      errorOf: (error: unknown): EngineError => ({ code: "INTERNAL", detail: error instanceof Error ? error.message : String(error) }),
      ...(opts.onSlot === undefined ? {} : { onSlot: opts.onSlot }),
    },
    { plan: run, jobId: opts.jobId ?? "job-00000001", descriptor: DESCRIPTOR, signal: opts.signal ?? new AbortController().signal },
  );
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/** The photos this run drew (the avatar's master is a generated photo too, with another attempt id). */
function drawnPhotos() {
  return library.photosByAvatar(avatarId).filter((p) => p.source.kind === "generated" && p.source.attemptId.startsWith(`${RUN_ID}:`));
}

async function journal(): Promise<RunEvent[]> {
  return (await library.readJournal(RUN_ID, RunEventSchema)).events;
}

describe("a run job over a scene set's plan", () => {
  test("sends no writer request: only images are asked of the provider", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3), plannedScene(4)]);
    const net = network();
    const end = await start(run, net);
    expect(end.status).toBe("done");
    expect(net.chatCalls()).toHaveLength(0);
    expect(net.imageCalls()).toHaveLength(3);
  });

  test("reserves nothing for a writer: the ledger holds image attempts only", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3)]);
    await start(run, network());
    const reserved = budget.ledger.lines.flatMap((l) => (l.type === "reserve" ? [l.attemptId] : []));
    expect(reserved).toEqual(["run-00000001:slot-1#1", "run-00000001:slot-2#1"]);
  });

  test("journals every prompt before the first image attempt, and no writer event", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3)]);
    await start(run, network());
    const events = await journal();
    const firstAttempt = events.findIndex((e) => e.type === "attempt");
    const prompts = events.findIndex((e) => e.type === "prompts");
    expect(prompts).toBeGreaterThanOrEqual(0);
    expect(prompts).toBeLessThan(firstAttempt);
    expect(events.some((e) => e.type === "writer")).toBe(false);
  });

  test("draws each slot from its own sentence, in slot order", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3)]);
    const net = network();
    await start(run, net);
    const prompts = net.imageCalls().map((c) => String(c.json().prompt));
    expect(prompts[0]).toContain(`${SENTENCE} (1)`);
    expect(prompts[1]).toContain(`${SENTENCE} (3)`);
  });

  test("a 700-char writer sentence from the set reaches plan.json and the image prompt whole", async () => {
    const long = `${SENTENCE} ${"She keeps laughing as the light moves across the room. ".repeat(12)}`.trim().slice(0, 700).replace(/\.?$/, ".");
    const run = await newRun([plannedScene(1, long)]);
    const stored = await library.readRun(RUN_ID, RunPlanSchema);
    expect(stored.scenes.slots[0]?.sentence).toBe(long);
    const net = network();
    await start(run, net);
    expect(String(net.imageCalls()[0]?.json().prompt)).toContain(long.slice(0, -1));
  });

  test("a sentence that now fails the word rules ends the run before any image is sent", async () => {
    const run = await newRun([plannedScene(1, "She wears a bikini on the beach.")]);
    const net = network();
    const end = await start(run, net);
    expect(end.status).toBe("failed");
    expect(net.imageCalls()).toHaveLength(0);
  });

  test("a photo from a planned scene keeps the planner's category", async () => {
    const run = await newRun([plannedScene(1)]);
    await start(run, network());
    const [photo] = drawnPhotos();
    expect(photo?.source.kind === "generated" ? photo.source.category : null).toBe("home");
  });

  test("a photo from an own scene is categorised own and carries no category name", async () => {
    const run = await newRun([ownScene(7)]);
    const net = network();
    const end = await start(run, net);
    expect(end.status).toBe("done");
    const photos = drawnPhotos();
    expect(photos).toHaveLength(1);
    const source = photos[0]?.source;
    expect(source?.kind === "generated" ? [source.category, "categoryName" in source] : null).toEqual(["own", false]);
    expect(String(net.imageCalls()[0]?.json().prompt)).toContain("rooftop terrace");
  });
});

describe("the avatar's scene history", () => {
  test("a planned scene records its location and outfit", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3)]);
    await start(run, network());
    const recent = await library.recentPairs(avatarId, 10);
    expect(recent.map((e) => [e.location, e.outfit]).sort()).toEqual([planned[0]!, planned[2]!].map((s) => [s.location, s.outfit]).sort());
  });

  test("an own scene commits without a history line", async () => {
    const run = await newRun([plannedScene(1), ownScene(7), ownScene(8)]);
    const appended: unknown[] = [];
    const watched = new Proxy(library, {
      get: (target, key) => {
        if (key === "appendHistory") return async (id: string, entry: unknown) => void appended.push(entry);
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await start(run, network(), { library: watched });
    expect(drawnPhotos()).toHaveLength(3);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ location: planned[0]!.location, outfit: planned[0]!.outfit });
  });
});

describe("cancel and resume", () => {
  test("a cancel after the first photo stops the run, and a resume draws only what is left, still without a writer", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3), plannedScene(4)]);
    const controller = new AbortController();
    // The first photo arrives; the second request hangs until the cancel.
    const first = network((_call, n) => (n === 1 ? { status: 200, body: imageBody(PNG_1X1, { cost: 0.04 }) } : { hang: true }));
    const ended = start(run, first, { signal: controller.signal });
    await until(() => first.imageCalls().length === 2, "the second image request");
    controller.abort(new Error("cancelled by the user"));
    expect(await ended).toEqual({ status: "cancelled" });
    expect(drawnPhotos()).toHaveLength(1);

    const second = network();
    const end = await start(run, second, { jobId: "job-00000002" });
    expect(end.status).toBe("done");
    expect(second.chatCalls()).toHaveLength(0);
    expect(second.imageCalls()).toHaveLength(2);
    expect(drawnPhotos()).toHaveLength(3);
  });

  test("a resume does not journal the prompts again", async () => {
    const run = await newRun([plannedScene(1), plannedScene(3)]);
    const controller = new AbortController();
    const first = network((_call, n) => (n === 1 ? { status: 200, body: imageBody(PNG_1X1, { cost: 0.04 }) } : { hang: true }));
    const ended = start(run, first, { signal: controller.signal });
    await until(() => first.imageCalls().length === 2, "the second image request");
    controller.abort(new Error("cancelled by the user"));
    await ended;
    const before = (await journal()).filter((e) => e.type === "prompts");
    expect(before).toHaveLength(1);
    await start(run, network(), { jobId: "job-00000002" });
    expect((await journal()).filter((e) => e.type === "prompts")).toHaveLength(1);
  });
});
