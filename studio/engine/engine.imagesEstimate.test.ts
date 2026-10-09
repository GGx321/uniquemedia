import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Estimate, LaunchDraftInput, LaunchView, ResponseMessage } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { createPaidSteps } from "./autopilot/paidSteps";
import type { EngineDeps } from "./engine";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import { chatBody, fakeFetch, imageBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, failed, GOOD, ledgerLines, OFFLINE, ok, portraitPng, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// S4.6p: `runs.estimateImages`, the free price of DRAWING photos (images alone), so the window never works a price out. Over a real engine, library and ledger with a fake
// OpenRouter (nothing reaches the network). Its figure must be the one the real draw prices with (`runs.estimateFromScenes` and the launch's slices); for a launch it counts only
// the photos still to draw and never passes the draw allocation the launch has left.

setDefaultTimeout(45_000);

const dir = useEngineDir("studio-engine-images-estimate-");
const libraryDir = () => join(dir(), "library");
const IMAGE = 50_000;

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

let seeded = 0;

async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

/** A reviewed owner's set of `count` written scenes, as a finished compose leaves it. */
async function seedSet(avatarId: string, count: number, sceneSetId: string): Promise<void> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock("2026-09-01T10:00:00.000Z"), newId: sequentialIds(`seedset${++seeded}`) });
  await library.sceneSets.create(sampleSet({ sceneSetId, avatarId, runId: `run-${sceneSetId}`, count, written: count }));
}

function isWriter(call: FetchCall): boolean {
  return call.url.endsWith("/chat/completions") && JSON.stringify(call.json().response_format ?? {}).includes("scene_sentences");
}

function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const goodWriter: Handler = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) });
const goodImage: Handler = (_call, n) => ({ status: 200, body: imageBody(portraitPng(((n - 1) % 4) + 1), { cost: 0.04 }) });

function network(opts: { image?: Handler } = {}) {
  let writes = 0;
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (isWriter(call)) return goodWriter(call, ++writes);
    if (call.url.endsWith("/images")) return (opts.image ?? goodImage)(call, ++images);
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return OFFLINE;
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 1024 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    writerCalls: () => net.calls.filter(isWriter),
    paidCalls: () => net.calls.filter((c) => c.method === "POST"),
    ageCalls: () => [],
    descriptorCalls: () => [],
  };
}

type Started = Awaited<ReturnType<typeof boot>>;

async function boot(net: ReturnType<typeof network>, opts: { settings?: Parameters<typeof engineSettings>[1]; launchSteps?: boolean; deps?: Partial<EngineDeps> } = {}) {
  await mkdir(join(dir(), "export"), { recursive: true });
  const holder: { engine: Awaited<ReturnType<typeof startEngine>>["engine"] | null } = { engine: null };
  const steps = createPaidSteps({
    port: () => {
      if (holder.engine === null) throw new Error("the engine is not started yet");
      return holder.engine;
    },
  });
  const started = await startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: 10_000_000, ...opts.settings }) },
    net,
    deps: { qaGates: [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }], ...(opts.launchSteps === true ? { launchSteps: steps } : {}), ...opts.deps },
  });
  holder.engine = started.engine;
  return started;
}

async function call(started: Started, type: string, payload: unknown): Promise<ResponseMessage> {
  return started.engine.handle(command(type, payload));
}

/** The estimate and the photo count `runs.estimateImages` answers. */
async function imagesOf(started: Started, payload: { avatarId: string; count: number } | { launchId: string; avatarId: string }): Promise<{ estimate: Estimate; photos: number }> {
  const answer = ok(await call(started, "runs.estimateImages", payload));
  if (answer.type !== "runs.estimateImages") throw new Error(`expected an images estimate, got ${answer.type}`);
  return answer.result;
}

/** The figure the real draw of a set reserves: `runs.estimateFromScenes` over a set of `count` written scenes. */
async function drawFigure(started: Started, avatarId: string, count: number, sceneSetId: string): Promise<Estimate> {
  await seedSet(avatarId, count, sceneSetId);
  const set = await started.engine.library?.sceneSets.get(avatarId, sceneSetId);
  if (set === null || set === undefined) throw new Error("the seeded set is missing");
  const answer = ok(await call(started, "runs.estimateFromScenes", { sceneSetId, revision: set.revision }));
  if (answer.type !== "runs.estimateFromScenes") throw new Error("expected an estimate");
  return answer.result.estimate;
}

// ---------- an avatar and a count: the owner's sets ----------

describe("runs.estimateImages { avatarId, count }", () => {
  test.each([1, 5, 30])("is the figure the real draw of %p scenes reserves, expected and worst, from the same price book", async (count) => {
    const avatarId = await seedAvatar();
    const started = await boot(network());
    const drawn = await drawFigure(started, avatarId, count, `set-draw-${count}`);
    const answer = await imagesOf(started, { avatarId, count });
    expect(answer.estimate).toEqual(drawn);
    expect(answer.photos).toBe(count);
  });

  test("is N photos with no writer term: three attempts each at the dearest image, one attempt expected", async () => {
    const avatarId = await seedAvatar();
    const { estimate } = await imagesOf(await boot(network()), { avatarId, count: 12 });
    expect(estimate.worstMicros).toBe(12 * 3 * IMAGE);
    expect(estimate.expectedMicros).toBe(12 * IMAGE);
  });

  test("follows the settings' image quality and age check like the real draw", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network(), { settings: { imageQuality: "medium", imageAgeCheck: "on" } });
    const drawn = await drawFigure(started, avatarId, 7, "set-draw-settings");
    const answer = await imagesOf(started, { avatarId, count: 7 });
    expect(answer.estimate).toEqual(drawn);
    expect(answer.estimate.worstMicros).toBeGreaterThan(7 * 3 * IMAGE);
  });

  test("a text model nobody lists does not block it: there is no writer in an images-only price", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network(), { settings: { textModel: "acme/unlisted-text" } });
    expect((await imagesOf(started, { avatarId, count: 4 })).estimate.worstMicros).toBe(4 * 3 * IMAGE);
  });

  test("is free: nothing is sent to a paid endpoint and the ledger does not move", async () => {
    const avatarId = await seedAvatar();
    const net = network();
    const started = await boot(net);
    await imagesOf(started, { avatarId, count: 9 });
    expect(net.paidCalls()).toEqual([]);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("an avatar the library does not have is NOT_FOUND, free", async () => {
    const net = network();
    const started = await boot(net);
    const refusal = failed(await call(started, "runs.estimateImages", { avatarId: "avatar-nobody-0404", count: 3 }));
    expect(refusal.error.code).toBe("NOT_FOUND");
    expect(net.calls.filter((c) => c.url.endsWith("/models") || c.url.endsWith("/endpoints"))).toEqual([]);
  });
});

// ---------- a launch: what it still has to draw ----------

const draftOf = (avatarIds: string[], over: Partial<LaunchDraftInput> = {}): LaunchDraftInput => ({
  avatarIds,
  videosPerAvatar: 3,
  mix: { single: 100, collage: 0, slides: 0 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...over,
});

async function startLaunch(started: Started, draft: LaunchDraftInput): Promise<LaunchView> {
  const estimate = ok(await call(started, "autopilot.estimate", { draft }));
  if (estimate.type !== "autopilot.estimate") throw new Error("not an estimate");
  const { preview } = estimate.result;
  const answer = ok(await call(started, "autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }));
  if (answer.type !== "autopilot.start") throw new Error("not a start");
  return answer.result.launch;
}

async function viewOf(started: Started, launchId: string): Promise<LaunchView> {
  const answer = ok(await call(started, "autopilot.get", { launchId }));
  if (answer.type !== "autopilot.get") throw new Error("wrong answer");
  return answer.result.launch;
}

async function reviewing(started: Started, launchId: string): Promise<LaunchView> {
  let view = await viewOf(started, launchId);
  const deadline = Date.now() + 30_000;
  while (view.avatars[0]?.phase !== "awaiting-review" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    view = await viewOf(started, launchId);
  }
  if (view.avatars[0]?.phase !== "awaiting-review") throw new Error("the launch never reached the review");
  return view;
}

describe("runs.estimateImages { launchId, avatarId }", () => {
  async function inReview(opts: { settings?: Parameters<typeof engineSettings>[1]; net?: ReturnType<typeof network> } = {}) {
    const avatarId = await seedAvatar();
    const net = opts.net ?? network();
    const started = await boot(net, { launchSteps: true, ...(opts.settings === undefined ? {} : { settings: opts.settings }) });
    const launch = await startLaunch(started, draftOf([avatarId], { sceneReview: true }));
    const view = await reviewing(started, launch.launchId);
    return { avatarId, net, started, launchId: launch.launchId, view };
  }

  function rowOf(view: LaunchView) {
    const row = view.avatars[0];
    if (row === undefined) throw new Error("the launch has no avatar");
    return row;
  }

  test("before the review is continued it prices the photos «Продолжить запуск» would draw, as the same photos of an owner's set", async () => {
    const { avatarId, started, launchId, view } = await inReview();
    const row = rowOf(view);
    const photos = row.continuePhotos ?? Number.NaN;
    const answer = await imagesOf(started, { launchId, avatarId });
    expect(answer.photos).toBe(photos);
    expect(answer.estimate).toEqual((await imagesOf(started, { avatarId, count: photos })).estimate);
  });

  test("never exceeds the draw allocation of the launch", async () => {
    const { avatarId, started, launchId, view } = await inReview();
    const allocation = rowOf(view).drawAllocationMicros ?? Number.NaN;
    const { estimate } = await imagesOf(started, { launchId, avatarId });
    expect(estimate.worstMicros).toBeLessThanOrEqual(allocation);
    expect(estimate.expectedMicros).toBeLessThanOrEqual(estimate.worstMicros);
  });

  test("counts only the scenes still to draw: removing two lowers the photos by two and the figure by their price", async () => {
    const { avatarId, started, launchId, view } = await inReview();
    const before = await imagesOf(started, { launchId, avatarId });
    const row = rowOf(view);
    if (row.sceneSetId === null || row.setRevision === null) throw new Error("the review has no set");
    ok(await call(started, "scenes.edit", { sceneSetId: row.sceneSetId, revision: row.setRevision, op: { op: "remove", sceneIds: [1, 2] } }));
    const after = await imagesOf(started, { launchId, avatarId });
    expect(after.photos).toBe(before.photos - 2);
    expect(before.estimate.worstMicros - after.estimate.worstMicros).toBe(2 * 3 * IMAGE);
    expect(before.estimate.expectedMicros - after.estimate.expectedMicros).toBe(2 * IMAGE);
  });

  test("a price that rose since the plan: only the photos the allocation still buys are priced, so the figure never passes what the launch may spend", async () => {
    const { avatarId, started, launchId, view } = await inReview();
    const allocation = rowOf(view).drawAllocationMicros ?? Number.NaN;
    const planned = rowOf(view).continuePhotos ?? 1;
    // The owner moves the images to a dearer quality after the plan was accepted.
    await started.engine.applyControl({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: 10_000_000, imageQuality: "medium" }) });
    const raised = await imagesOf(started, { avatarId, count: planned });
    expect(raised.estimate.worstMicros).toBeGreaterThan(allocation);
    const answer = await imagesOf(started, { launchId, avatarId });
    expect(answer.photos).toBeLessThan(planned);
    expect(answer.estimate.worstMicros).toBeLessThanOrEqual(allocation);
    // The photos it says are the photos it prices: the same figure as that many photos of the avatar.
    expect(answer.estimate).toEqual((await imagesOf(started, { avatarId, count: answer.photos })).estimate);
  });

  test("a launch that has drawn everything has nothing left: no photos and a zero figure", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network(), { launchSteps: true });
    const launch = await startLaunch(started, draftOf([avatarId]));
      const deadline = Date.now() + 30_000;
    let view = await viewOf(started, launch.launchId);
    while (view.avatars[0]?.photos.done !== view.avatars[0]?.photos.total || view.avatars[0]?.photos.total === 0) {
      if (Date.now() > deadline) throw new Error("the launch never drew its photos");
      await new Promise((resolve) => setTimeout(resolve, 25));
      view = await viewOf(started, launch.launchId);
    }
    const answer = await imagesOf(started, { launchId: launch.launchId, avatarId });
    expect(answer.photos).toBe(0);
    expect(answer.estimate.worstMicros).toBe(0);
    expect(answer.estimate.expectedMicros).toBe(0);
  });

  test("a launch with a second slice still to come counts only the photos that are left, not the whole set", async () => {
    const avatarId = await seedAvatar();
    let release: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    // One single video is one photo, so 30 videos are 30 photos: a slice holds 25 at most. The first slice answers at once; the 26th image waits, so the second slice has begun and holds its photos open.
    const net = network({
      image: async (imageCall, n) => {
        if (n > 25) await closed;
        return goodImage(imageCall, n);
      },
    });
    const started = await boot(net, { launchSteps: true });
    const launch = await startLaunch(started, draftOf([avatarId], { videosPerAvatar: 30 }));
    await until(() => net.imageCalls().length >= 26, "the second slice's first image", 40_000);
    try {
      const view = await viewOf(started, launch.launchId);
      const total = view.avatars[0]?.photos.total ?? 0;
      expect(total).toBeGreaterThan(25);
      const answer = await imagesOf(started, { launchId: launch.launchId, avatarId });
      expect(answer.photos).toBe(total - 25);
      expect(answer.estimate).toEqual((await imagesOf(started, { avatarId, count: total - 25 })).estimate);
      expect(answer.estimate.worstMicros).toBeLessThanOrEqual(view.avatars[0]?.drawAllocationMicros ?? Number.NaN);
    } finally {
      release();
    }
  });

  describe("while the first slice is active (its images in flight)", () => {
    /** A launch whose first image never answers until `release()`: the first slice is running and holds the whole allocation. */
    async function hung(videos: number) {
      const avatarId = await seedAvatar();
      let release: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const net = network({
        image: async (imageCall, n) => {
          await closed;
          return goodImage(imageCall, n);
        },
      });
      const started = await boot(net, { launchSteps: true });
      const launch = await startLaunch(started, draftOf([avatarId], { videosPerAvatar: videos }));
      await until(() => net.imageCalls().length >= 1, "the first image in flight", 40_000);
      return { avatarId, started, launch, release };
    }

    test("a launch of 3 photos is priced for all 3: the open slots are paid from their slice's own cap, not from what is left for new slices", async () => {
      const { avatarId, started, launch, release } = await hung(3);
      try {
        const answer = await imagesOf(started, { launchId: launch.launchId, avatarId });
        expect(answer.photos).toBe(3);
        expect(answer.estimate.expectedMicros).toBe(3 * IMAGE);
        expect(answer.estimate.worstMicros).toBe(3 * 3 * IMAGE);
        expect(answer.estimate).toEqual((await imagesOf(started, { avatarId, count: 3 })).estimate);
      } finally {
        release();
      }
    });

    test("a launch of 30 photos with a first slice of 25 is priced for all 30: the slice's 25 and the 5 after it", async () => {
      const { avatarId, started, launch, release } = await hung(30);
      try {
        const answer = await imagesOf(started, { launchId: launch.launchId, avatarId });
        expect(answer.photos).toBe(30);
        expect(answer.estimate.expectedMicros).toBe(30 * IMAGE);
        expect(answer.estimate.worstMicros).toBe(30 * 3 * IMAGE);
      } finally {
        release();
      }
    });
  });

  test("a launch the engine does not hold is NOT_FOUND", async () => {
    const avatarId = await seedAvatar();
    const started = await boot(network(), { launchSteps: true });
    const refusal = failed(await call(started, "runs.estimateImages", { launchId: "launch-0a1b2c3d4e5f", avatarId }));
    expect(refusal.error.code).toBe("NOT_FOUND");
  });

  test("an avatar the launch does not hold is NOT_FOUND", async () => {
    const { started, launchId } = await inReview();
    const refusal = failed(await call(started, "runs.estimateImages", { launchId, avatarId: "avatar-nobody-0404" }));
    expect(refusal.error.code).toBe("NOT_FOUND");
  });
});
