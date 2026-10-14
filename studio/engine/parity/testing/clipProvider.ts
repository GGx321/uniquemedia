import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockClipAttempt, MockClipScript } from "../../../renderer/engine/mockClips";
import { writeClip } from "../../clips/testing/clipFixtures";
import { VIDEO_TIERS } from "../../money/prices";
import type { OpenRouterFetch, OpenRouterRequestInit, OpenRouterResponse } from "../../openrouter/types";

// Test-only (Stage 5, 5b.1, S5.V7): the fake video provider of the parity rig. It answers what OpenRouter answers for a clip: the price listing, `POST /videos`, the poll, the file, `/generation` and
// `/credits`. Each ATTEMPT of a clip (the first POST, then the Grok behind it) plays the outcome the story scripted for it, in the vocabulary the mock plays (`MockClipAttempt`), so the two engines
// are told one story. What a request BODY says decides what is answered: the model prices the clip and sizes its file, the duration is its length. It counts the POSTs that left (the money
// story is «at most one per attempt»). No network, and no key that is real.

const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";
const MODERATION = "xAI blocked this request through content moderation.";
const PROVIDER_ERROR = "Provider returned an internal error";

/** The 2026-10-10 listing (engine/clips/testing/engineClipKit.ts, `listing`): Kling std 0.084 $/s, pro 0.112 $/s, Grok 14 ¢/s + 1 ¢ per image. */
function listing(withGrokSkus: boolean): object {
  return {
    data: [
      { id: VIDEO_TIERS.std.model, pricing_skus: { image_to_video_duration_seconds_720p: "0.084", image_to_video_duration_seconds_1080p: "0.084" } },
      { id: VIDEO_TIERS.pro.model, pricing_skus: { image_to_video_duration_seconds_720p: "0.112", image_to_video_duration_seconds_1080p: "0.112" } },
      { id: VIDEO_TIERS.grok.model, pricing_skus: withGrokSkus ? { cents_per_image_input: "1", cents_per_video_output_second_720p: "14" } : {} },
    ],
  };
}

function response(status: number, body: Uint8Array | string | object, headers: Record<string, string> = {}): OpenRouterResponse {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let offset = 0;
  const chunk = 64 * 1024;
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.length) return { done: true };
          const value = bytes.subarray(offset, offset + chunk);
          offset += chunk;
          return { done: false, value };
        },
        cancel: async () => {
          offset = bytes.length;
        },
      }),
    },
  };
}

type AttemptModel = "kling" | "grok";

interface Job {
  id: string;
  model: AttemptModel;
  tier: "std" | "pro" | "grok";
  seconds: number;
  outcome: MockClipAttempt;
}

interface Clip {
  first: MockClipAttempt;
  then: MockClipAttempt;
  ordinal: number;
}

export type VideoListing = "live" | "fallback" | "missing";

export interface ClipProvider {
  readonly fetch: OpenRouterFetch;
  /** Arms the NEXT clip's attempts (an outcome for its first POST, then one for the Grok behind it). Used once, by the next `beginClip`. */
  script(script: MockClipScript): void;
  /** A clip has been accepted by the engine: its attempts play the armed script (or complete). */
  beginClip(): void;
  /** A `late-ok` clip comes in: until then its polls stay in progress, however long the engine waits (the story says when, never a clock). */
  arrive(): void;
  /** While held, every poll is in progress (the render is still going); released, the outcome shows. */
  hold(held: boolean): void;
  /** The provider has the file of a clip whose download failed (`download-failed`, `invalid-file`) again: a retry fetches it. */
  heal(healed: boolean): void;
  setPrices(mode: VideoListing): void;
  /** The model of each POST that left, in order. */
  posts(): AttemptModel[];
  close(): Promise<void>;
}

const PLAYABLE_ONLY = "no-room";

function attemptsOf(script: MockClipScript): { first: MockClipAttempt; then: MockClipAttempt } {
  const parts = typeof script === "string" ? { first: script } : script;
  const played = { first: parts.first ?? "ok", then: parts.then ?? "ok" };
  if (played.first === PLAYABLE_ONLY || played.then === PLAYABLE_ONLY) throw new Error("`no-room` is the month's refusal of Grok's reserve: the mock plays it, the real engine cannot be told it by a provider");
  return played;
}

/** What a job bills when it completes, in micro-dollars (the formula of shared/engine/clips.ts, `clipBilledMicros`, over the listing's prices). */
function billedMicros(job: Job): number {
  const perSecond = job.tier === "std" ? 84_000 : job.tier === "pro" ? 112_000 : 140_000;
  return job.seconds * perSecond + (job.tier === "grok" ? 10_000 : 0);
}

const dollars = (micros: number): number => micros / 1_000_000;

/** Outcomes whose poll ends `completed`. */
const COMPLETES: readonly MockClipAttempt[] = ["ok", "ok-uncosted", "download-failed", "invalid-file", "disk-full"];

export function clipProvider(): ClipProvider {
  const jobs = new Map<string, Job>();
  const posted: AttemptModel[] = [];
  let armed: { first: MockClipAttempt; then: MockClipAttempt } | null = null;
  let clip: Clip = { first: "ok", then: "ok", ordinal: 0 };
  let held = false;
  let arrived = false;
  let healed = false;
  let prices: VideoListing = "live";
  let folder: Promise<string> | undefined;
  const files = new Map<string, Promise<string>>();

  const media = (width: number, height: number, seconds: number): Promise<string> => {
    folder ??= mkdtemp(join(tmpdir(), "studio-parity-clip-"));
    const key = `${width}x${height}x${seconds}`;
    let path = files.get(key);
    if (path === undefined) {
      path = folder.then(async (dir) => {
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${key}.mp4`);
        await writeClip(file, { width, height, seconds });
        return file;
      });
      files.set(key, path);
    }
    return path;
  };

  /** The account's usage: a refusal the engine's net-usage check must SEE shows up on `/credits` from the moment its job is POSTed. */
  const usage = (): number => {
    let total = 5;
    for (const job of jobs.values()) if (job.outcome === "refused-unknown" || job.outcome === "provider-error-unknown") total += 0.42;
    return total;
  };

  const creditsDown = (): boolean => clip.first === "refused-uncounted" || clip.then === "refused-uncounted";

  const fetch: OpenRouterFetch = async (url: string, init: OpenRouterRequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    if (path === "/videos/models") {
      if (prices === "fallback") throw new TypeError("fetch failed");
      return response(200, listing(prices === "live"));
    }
    if (path === "/credits") {
      if (creditsDown()) return response(500, { error: { message: "credits are unreadable" } });
      return response(200, { data: { total_credits: 100, total_usage: usage() } });
    }
    if (path === "/videos" && init.method === "POST") return submit(init);
    const content = /^\/videos\/([^/]+)\/content$/.exec(path);
    if (content !== null) return serve(decodeURIComponent(content[1] ?? ""));
    const poll = /^\/videos\/([^/]+)$/.exec(path);
    if (poll !== null) return answerPoll(decodeURIComponent(poll[1] ?? ""));
    if (path === "/generation") return answerGeneration(new URL(url).searchParams.get("id") ?? "");
    throw new Error(`the parity clip provider has no answer for ${init.method} ${path}`);
  };

  function submit(init: OpenRouterRequestInit): OpenRouterResponse {
    const body: unknown = JSON.parse(init.body ?? "{}");
    const record = typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};
    const model: AttemptModel = record.model === VIDEO_TIERS.grok.model ? "grok" : "kling";
    const tier = model === "grok" ? "grok" : record.model === VIDEO_TIERS.pro.model ? "pro" : "std";
    const seconds = typeof record.duration === "number" ? record.duration : 5;
    clip.ordinal += 1;
    const outcome = clip.ordinal === 1 ? clip.first : clip.then;
    posted.push(model);
    switch (outcome) {
      case "refused-submit":
        return response(400, { error: { message: MODERATION } });
      case "rate-limited":
        return response(429, { error: { message: "Rate limit exceeded" } });
      case "bad-request":
        return response(400, { error: { message: "invalid request" } });
      case "key-invalid":
        return response(401, { error: { message: "No auth credentials found" } });
      case "no-credits":
        return response(402, { error: { message: "Insufficient credits" } });
      case "uncertain":
        return response(502, { error: { message: "bad gateway" } });
      default: {
        const id = `prov-${model}-${posted.length}`;
        jobs.set(id, { id, model, tier, seconds, outcome });
        return response(202, { id, polling_url: `https://openrouter.ai/api/v1/videos/${id}`, status: "pending" });
      }
    }
  }

  function answerPoll(id: string): OpenRouterResponse {
    const job = jobs.get(id);
    if (job === undefined) return response(404, { error: { code: 404, message: `Video ${id} not found` } });
    const running = { id, generation_id: id, status: "in_progress" };
    if (held || job.outcome === "late") return response(200, running);
    if (job.outcome === "late-ok" && !arrived) return response(200, running);
    if (COMPLETES.includes(job.outcome) || job.outcome === "late-ok") {
      const uncosted = job.outcome === "ok-uncosted";
      return response(200, { id, generation_id: id, status: "completed", ...(uncosted ? {} : { usage: { cost: dollars(billedMicros(job)), is_byok: false } }) });
    }
    const content = job.outcome === "refused-free" || job.outcome === "refused-paid" || job.outcome === "refused-unknown" || job.outcome === "refused-uncounted";
    return response(200, { id, generation_id: id, status: "failed", error: content ? RISK_CONTROL : PROVIDER_ERROR });
  }

  async function serve(id: string): Promise<OpenRouterResponse> {
    const job = jobs.get(id);
    if (job === undefined) return response(404, { error: { code: 404, message: `Video ${id} not found` } });
    if (job.outcome === "download-failed" && !healed) return response(502, { error: { message: "bad gateway" } });
    if (job.outcome === "invalid-file" && !healed) {
      const bytes = new TextEncoder().encode("this is not a video, whatever the provider says");
      return response(200, bytes, { "content-length": String(bytes.length) });
    }
    const [width, height] = job.tier === "pro" ? [1080, 1920] : [720, 1280];
    const bytes = new Uint8Array(await readFile(await media(width, height, job.seconds)));
    return response(200, bytes, { "content-length": String(bytes.length) });
  }

  function answerGeneration(id: string): OpenRouterResponse {
    const job = jobs.get(id);
    if (job !== undefined && (job.outcome === "refused-paid" || job.outcome === "provider-error-paid")) {
      return response(200, { data: { id, total_cost: dollars(billedMicros(job)), finish_reason: "stop" } });
    }
    // The API's own 404, in its exact words (engine/openrouter/generation.ts): a refused job never got a record.
    return response(404, { error: { code: 404, message: `Generation ${id} not found` } });
  }

  return {
    fetch,
    script: (script) => {
      armed = attemptsOf(script);
    },
    beginClip: () => {
      clip = { ...(armed ?? { first: "ok" as const, then: "ok" as const }), ordinal: 0 };
      armed = null;
      arrived = false;
    },
    hold: (value) => {
      held = value;
    },
    arrive: () => {
      arrived = true;
    },
    heal: (value) => {
      healed = value;
    },
    setPrices: (mode) => {
      prices = mode;
    },
    posts: () => [...posted],
    close: async () => {
      if (folder !== undefined) await rm(await folder, { recursive: true, force: true });
      folder = undefined;
      files.clear();
    },
  };
}
