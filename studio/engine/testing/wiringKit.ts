import { expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type LaunchDraftInput, type LaunchView, type ResponseMessage } from "../../shared/engine";
import { manifestTraits } from "../avatars/records";
import { randomPdq, rng } from "../autopilot/testing/planFixtures";
import type { EngineDeps } from "../engine";
import { openLibrary } from "../library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { excerptOf, fakeCdn, JPEG_1X1, listTracks } from "../music/testing/storeKit";
import { TrackStore } from "../music/trackStore";
import { chatBody, fakeFetch, imageBody, type FetchCall, type Reply } from "../openrouter/testing/fakes";
import { command, engineSettings, GOOD, NOW, OFFLINE, ok, portraitPng, startEngine, TRAITS } from "./engineHarness";
import { within } from "./within";

// Test-only (S4.6w): what the engine-level tests of the DEFAULT autopilot wiring share. A real engine over a temp folder with nothing injected into `launchSteps`, a fake OpenRouter that
// answers the writer, the images and the credits (any other request fails the test), fixture photos for the library, a track store holding the 3c.1 excerpts, and the launch commands.

const FIXTURES = join(import.meta.dir, "../face/fixtures/images");
const PHOTO_FILES = ["render-best-home-1.jpg", "render-median-travel-2.jpg", "render-worst-fitness-3.jpg"];
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const FACE = [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }];

/** A whole launch with real renders on a slow runner. */
export const LAUNCH_MS = 200_000;

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

/** A fake OpenRouter: the writer, the images and the credits answer; prices are offline (the dated fallback table). Any other request throws. */
export function network() {
  let images = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (isWriter(call)) return { status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) };
    if (call.url.endsWith("/images")) return { status: 200, body: imageBody(portraitPng(((++images - 1) % 4) + 1), { cost: 0.04 }) };
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return OFFLINE;
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 512 }, () => route));
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

export type WiringNetwork = ReturnType<typeof network>;

export const draftOf = (avatarIds: string[], over: Partial<LaunchDraftInput> = {}): LaunchDraftInput => ({
  avatarIds,
  videosPerAvatar: 2,
  // Slides of 5 photos last 6 to 7 s: every one fits the 3c.1 excerpts (6 to 8 s). A single lasts 6 to 10 s, and some would wait for a longer track.
  mix: { single: 0, collage: 0, slides: 100 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...over,
});


export function wiringKit(dir: () => string) {
  const libraryDir = () => join(dir(), "library");
  const exportDir = () => join(dir(), "export");
  const musicDir = () => join(dir(), "userData", "music");

  /** An avatar with a master portrait and `photos` fixture JPEGs of the category «home», far apart in their hashes. */
  async function seedAvatar(photos: number): Promise<string> {
    const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("wire") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    const base = samplePhotoMeta().source;
    if (base.kind !== "generated") throw new Error("expected a generated sample source");
    const next = rng(41);
    for (let i = 0; i < photos; i++) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, PHOTO_FILES[i % PHOTO_FILES.length] ?? "")));
      await library.addPhoto(
        avatar.id,
        bytes,
        samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa: { pdq: randomPdq(next) } }),
      );
    }
    return avatar.id;
  }

  /** A track store holding the four 3c.1 excerpts as saved trends: what the free steps choose a track from. */
  async function trackStore(): Promise<TrackStore> {
    const cdn = fakeCdn();
    const tracks = listTracks(4);
    tracks.forEach((track, index) => {
      cdn.serve(track.downloadUrl, { bytes: excerptOf(index) });
      if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
    });
    const store = await TrackStore.open({ dir: musicDir(), transport: cdn.transport, clock: () => NOW, log: () => undefined });
    await store.accept({ fetchedAt: NOW - 1000, tracks }, () => undefined, new AbortController().signal);
    return store;
  }

  /** The engine as the app builds it: nothing is injected into `launchSteps`. */
  async function boot(net: WiringNetwork, opts: { deps?: Partial<EngineDeps>; settings?: Parameters<typeof engineSettings>[1] } = {}) {
    await mkdir(exportDir(), { recursive: true });
    const store = await trackStore();
    const started = await startEngine(dir(), {
      init: {
        renderTmpDir: join(dir(), "userData", "render-tmp"),
        musicDir: musicDir(),
        settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: 10_000_000, renderConcurrency: 1, ...opts.settings }),
      },
      net,
      deps: { qaGates: FACE, musicTracks: store, musicTrends: store, ...opts.deps },
    });
    await started.engine.settled();
    return started;
  }
  type Started = Awaited<ReturnType<typeof boot>>;

  const call = (started: Started, type: string, payload: unknown): Promise<ResponseMessage> => within(started.engine.handle(command(type, payload)), 60_000, type);

  async function startLaunch(started: Started, draft: LaunchDraftInput): Promise<LaunchView> {
    const estimate = ok(await call(started, "autopilot.estimate", { draft }));
    if (estimate.type !== "autopilot.estimate") throw new Error("not an estimate");
    const { preview } = estimate.result;
    const answer = ok(await call(started, "autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }));
    if (answer.type !== "autopilot.start") throw new Error("not a start");
    return answer.result.launch;
  }

  async function getLaunch(started: Started, launchId: string) {
    const answer = ok(await call(started, "autopilot.get", { launchId }));
    if (answer.type !== "autopilot.get") throw new Error("wrong answer");
    return answer.result;
  }

  /** Polls the engine's own answer (never the file: the view is what the owner sees) until `want` holds. */
  async function waitFor(started: Started, launchId: string, what: string, want: (view: LaunchView) => boolean, ms = LAUNCH_MS): Promise<LaunchView> {
    const deadline = Date.now() + ms;
    for (;;) {
      const view = (await getLaunch(started, launchId)).launch;
      if (want(view)) return view;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (status ${view.status}, avatar phase ${view.avatars[0]?.phase ?? "none"})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function videosOf(started: Started, avatarId: string) {
    const answer = ok(await call(started, "videos.list", { avatarId }));
    if (answer.type !== "videos.list") throw new Error("wrong answer");
    return answer.result.videos;
  }

  function expectVideosOnDisk(videos: readonly { relPath: string }[], count: number): void {
    expect(videos).toHaveLength(count);
    for (const video of videos) {
      const file = join(exportDir(), video.relPath);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(0);
    }
  }

  return { libraryDir, exportDir, musicDir, seedAvatar, trackStore, boot, call, startLaunch, getLaunch, waitFor, videosOf, expectVideosOnDisk };
}
