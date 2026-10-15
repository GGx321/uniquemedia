import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockModelReply } from "../../../renderer/engine/mockClipMotions";
import type { MockClipAttempt, MockClipScript } from "../../../renderer/engine/mockClips";
import { writeClip } from "../../clips/testing/clipFixtures";
import { VIDEO_TIERS } from "../../money/prices";
import { chatBody } from "../../openrouter/testing/fakes";
import type { OpenRouterFetch, OpenRouterRequestInit, OpenRouterResponse } from "../../openrouter/types";

// Test-only (Stage 5, 5b.1, S5.V7): the fake video provider of the parity rig. It answers what OpenRouter answers for a clip: the price listing, `POST /videos`, the poll, the file, `/generation` and
// `/credits`. Each ATTEMPT of a clip (the first POST, then the Grok behind it) plays the outcome the story scripted for it, in the vocabulary the mock plays (`MockClipAttempt`), so the two engines
// are told one story. What a request BODY says decides what is answered: the model prices the clip and sizes its file, the duration is its length. It counts the POSTs that left (the money
// story is «at most one per attempt»). No network, and no key that is real.

const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";
const MODERATION = "xAI blocked this request through content moderation.";
const PROVIDER_ERROR = "Provider returned an internal error";

/** The 2026-10-10 listing (engine/clips/testing/engineClipKit.ts, `listing`): Kling std 0.084 $/s, pro 0.112 $/s, Grok 14 ¢/s + 1 ¢ per image. */
function listing(withGrokSkus: boolean, stdPerSecond = "0.084"): object {
  return {
    data: [
      { id: VIDEO_TIERS.std.model, pricing_skus: { image_to_video_duration_seconds_720p: stdPerSecond, image_to_video_duration_seconds_1080p: stdPerSecond } },
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
  /**
   * 5b.2 (S5.WB3): arms the NEXT batch's members, one script each, in the order their Kling POSTs leave (the provider cannot see a member's boundaries; a Kling POST starts the next one, and a Grok POST is the
   * `then` of the member before it). Used once, by the next `beginBatch`.
   */
  scriptBatch(scripts: readonly MockClipScript[]): void;
  /** A batch has been accepted by the engine: its members play the armed scripts, and an entry the story did not give completes. Until the next `beginClip`. */
  beginBatch(): void;
  /** While held, a POST that has arrived waits for its answer (a 429 the engine has not met yet), however long the engine waits: the story releases it by this event, never by a clock. */
  holdSubmit(held: boolean): void;
  /** The listing's Kling std rate moves, in micro-dollars per second (the engine's cache sees it once it is older than 10 minutes). */
  setKlingStdRate(perSecondMicros: number): void;
  /** A `late-ok` clip comes in: until then its polls stay in progress, however long the engine waits (the story says when, never a clock). */
  arrive(): void;
  /** While held, every poll is in progress (the render is still going); released, the outcome shows. */
  hold(held: boolean): void;
  /** The provider has the file of a clip whose download failed (`download-failed`, `invalid-file`) again: a retry fetches it. */
  heal(healed: boolean): void;
  setPrices(mode: VideoListing): void;
  /**
   * 5b.2 (S5.WC4): the chat route of part C. The model's answers to the NEXT chat requests, one per request in the order they arrive (`MockModelReply`, the mock's own vocabulary). A request with no answer left is
   * a defect of the story and throws. `timeout` and `network` are played by the mock alone (the real transport waits 60 s for the first and retries the second).
   */
  scriptChat(replies: readonly MockModelReply[]): void;
  /** While held, a chat request that has arrived waits for its answer, however long the engine waits: the story releases it by this event, never by a clock. */
  holdChat(held: boolean): void;
  /** The chat requests waiting for their answer now. */
  chatWaiting(): number;
  /** The body of each chat request that left, in order: what the engine sent to the model. */
  chatRequests(): string[];
  /** The model of each POST that left, in order. */
  posts(): AttemptModel[];
  close(): Promise<void>;
}

/** What only the mock can play: `no-room` is the month's refusal of Grok's reserve; `ok-above-worst` and `fault` (5b.2) are a bill above the reserve and a defect of the money path, which the engine's own tests hold. */
const MOCK_ONLY: readonly MockClipAttempt[] = ["no-room", "ok-above-worst", "fault"];

function attemptsOf(script: MockClipScript): { first: MockClipAttempt; then: MockClipAttempt } {
  const parts = typeof script === "string" ? { first: script } : script;
  const played = { first: parts.first ?? "ok", then: parts.then ?? "ok" };
  for (const outcome of [played.first, played.then]) {
    if (MOCK_ONLY.includes(outcome)) throw new Error(`\`${outcome}\` is played by the mock alone: the real engine cannot be told it by a provider (the engine's own tests hold it)`);
  }
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
  /** 5b.2: the batch's members still to play, and whether a batch is the one being played (its Kling POST starts the next member). */
  let armedBatch: { first: MockClipAttempt; then: MockClipAttempt }[] | null = null;
  let batch: { first: MockClipAttempt; then: MockClipAttempt }[] | null = null;
  let submitGate: Promise<void> | null = null;
  let releaseSubmit: (() => void) | null = null;
  /** 5b.2 (S5.WC4): the chat route of part C: the answers still to give, the bodies that arrived, and the gate that holds a request at the model. */
  let chatReplies: MockModelReply[] = [];
  const chatBodies: string[] = [];
  let chatGate: Promise<void> | null = null;
  let releaseChat: (() => void) | null = null;
  let chatWaiting = 0;
  let klingStd = "0.084";
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
      return response(200, listing(prices === "live", klingStd));
    }
    if (path === "/credits") {
      if (creditsDown()) return response(500, { error: { message: "credits are unreadable" } });
      return response(200, { data: { total_credits: 100, total_usage: usage() } });
    }
    if (path === "/chat/completions" && init.method === "POST") return answerChat(init);
    if (path === "/videos" && init.method === "POST") {
      // 5b.2: a held POST has arrived and waits for its answer; the engine's request is out, and nothing is decided until the story lets it go.
      if (submitGate !== null) await submitGate;
      return submit(init);
    }
    const content = /^\/videos\/([^/]+)\/content$/.exec(path);
    if (content !== null) return serve(decodeURIComponent(content[1] ?? ""));
    const poll = /^\/videos\/([^/]+)$/.exec(path);
    if (poll !== null) return answerPoll(decodeURIComponent(poll[1] ?? ""));
    if (path === "/generation") return answerGeneration(new URL(url).searchParams.get("id") ?? "");
    throw new Error(`the parity clip provider has no answer for ${init.method} ${path}`);
  };

  /** 5b.2 (S5.WC4): a part C chat request (the vision writer's or the translator's): the next scripted answer, once the story lets it go. */
  async function answerChat(init: OpenRouterRequestInit): Promise<OpenRouterResponse> {
    chatBodies.push(init.body ?? "");
    if (chatGate !== null) {
      chatWaiting += 1;
      try {
        await chatGate;
      } finally {
        chatWaiting -= 1;
      }
    }
    const reply = chatReplies.shift();
    if (reply === undefined) throw new Error("the parity clip provider was asked for a chat answer the story did not script");
    return chatResponse(reply);
  }

  /** What a scripted answer bills: the mock's default (the call's expected figure) is the mock's, so a story that plays both rigs names the figure. */
  function billedChat(costMicros: number | undefined): number {
    if (costMicros === undefined) throw new Error("a story that plays the real rig names the cost of every chat answer it scripts");
    return costMicros;
  }

  function chatResponse(reply: MockModelReply): OpenRouterResponse {
    switch (reply.kind) {
      case "answer":
        return response(200, chatBody(reply.content, { cost: dollars(billedChat(reply.costMicros)) }));
      case "empty":
        return response(200, chatBody(null, { cost: dollars(billedChat(reply.costMicros)) }));
      case "unusable-body":
        // Paid, and not a chat answer at all: the engine settles it at the attempt's worst case and ends the call.
        return response(200, { note: "this is not a chat completion" });
      case "refused":
        return response(400, { error: { message: MODERATION } });
      case "http":
        return response(reply.status, { error: { message: `HTTP ${reply.status}` } });
      case "timeout":
      case "network":
        throw new Error(`\`${reply.kind}\` is played by the mock alone: the real transport waits 60 s for a timeout and retries a network failure (the engine's own tests hold both)`);
    }
  }

  function submit(init: OpenRouterRequestInit): OpenRouterResponse {
    const body: unknown = JSON.parse(init.body ?? "{}");
    const record = typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};
    const model: AttemptModel = record.model === VIDEO_TIERS.grok.model ? "grok" : "kling";
    const tier = model === "grok" ? "grok" : record.model === VIDEO_TIERS.pro.model ? "pro" : "std";
    const seconds = typeof record.duration === "number" ? record.duration : 5;
    // A batch's Kling POST starts the next member: its script, or a clean clip when the story gave none (a requeued member takes one again).
    if (batch !== null && model === "kling") {
      clip = { ...(batch.shift() ?? { first: "ok" as const, then: "ok" as const }), ordinal: 0 };
      arrived = false;
    }
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
      batch = null;
    },
    scriptBatch: (scripts) => {
      armedBatch = scripts.map(attemptsOf);
    },
    beginBatch: () => {
      batch = armedBatch ?? [];
      armedBatch = null;
      arrived = false;
    },
    holdSubmit: (value) => {
      if (value) {
        submitGate ??= new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
        return;
      }
      releaseSubmit?.();
      submitGate = null;
      releaseSubmit = null;
    },
    scriptChat: (replies) => {
      chatReplies = [...replies];
    },
    holdChat: (value) => {
      if (value) {
        chatGate ??= new Promise<void>((resolve) => {
          releaseChat = resolve;
        });
        return;
      }
      releaseChat?.();
      chatGate = null;
      releaseChat = null;
    },
    chatWaiting: () => chatWaiting,
    chatRequests: () => [...chatBodies],
    setKlingStdRate: (perSecondMicros) => {
      klingStd = String(perSecondMicros / 1_000_000);
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
