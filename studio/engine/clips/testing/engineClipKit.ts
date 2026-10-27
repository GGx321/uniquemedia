import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventMessage, PROTOCOL_VERSION, ResponseMessage, type ClipOptions } from "../../../shared/engine";
import type { PhotoQa } from "../../library/schemas";
import { manifestTraits } from "../../avatars/records";
import type { EngineInit } from "../../control";
import { Engine, type EngineDeps } from "../../engine";
import { openLibrary } from "../../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../../library/testing/helpers";
import { SAMPLE_SOURCE } from "../../library/testing/sampleData";
import { VIDEO_TIERS } from "../../money/prices";
import type { OpenRouterFetch, OpenRouterRequestInit, OpenRouterResponse } from "../../openrouter/types";
import { engineInit, GOOD, KEY, NOW, TRAITS } from "../../testing/engineHarness";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "../timings";
import { runFfmpegForFixture, writeClip } from "./clipFixtures";

// Test-only (S5.V4a1): the real engine with a fake OpenRouter that answers the clip's own calls: the video price listing, `POST /videos`, its polls, the file, `/generation` and
// `/credits`. Nothing here can reach the network or spend money. A clip's file is a real small MP4 made by the bundled ffmpeg, so the job's download, validation, poster and face
// steps are the real ones. The clocks run in real time from NOW, and a test may move both ahead (`skew`), which is how a reconcile's quiet wait is passed without waiting it out.

export const KLING_STD = VIDEO_TIERS.std.model;
export const KLING_PRO = VIDEO_TIERS.pro.model;
export const GROK = VIDEO_TIERS.grok.model;

/** The three models as the 2026-10-10 listing prices them: Kling std 0.084 $/s, Kling pro 0.112 $/s, Grok 14 ¢/s + 1 ¢ per image. */
export function listing(overrides: { std?: Record<string, string>; pro?: Record<string, string>; grok?: Record<string, string> } = {}): object {
  return {
    data: [
      { id: KLING_STD, pricing_skus: overrides.std ?? { image_to_video_duration_seconds_720p: "0.084", image_to_video_duration_seconds_1080p: "0.084" } },
      { id: KLING_PRO, pricing_skus: overrides.pro ?? { image_to_video_duration_seconds_720p: "0.112", image_to_video_duration_seconds_1080p: "0.112" } },
      { id: GROK, pricing_skus: overrides.grok ?? { cents_per_image_input: "1", cents_per_video_output_second_720p: "14" } },
    ],
  };
}

export type Terminal = { status: "completed"; cost?: number | null } | { status: "failed"; error: string };

export interface VideoScript {
  /** What the POST answers: accepted (default), an HTTP status with a body, or a network failure. */
  submit?: "accept" | { status: number; body?: unknown } | "network";
  /** How the job ends; default completed with usage.cost 0.42. */
  terminal?: Terminal;
  /** Polls answer `in_progress` until the test calls `release(model)`. */
  held?: boolean;
  /** `/generation` for this job: the API's 404 (default) or a found record. */
  generation?: "404" | { cost: number };
  /** The file: the kit's MP4 (default), a hang until `releaseContent(model)`, or a 410. */
  content?: "mp4" | "held" | "gone";
}

export interface FetchLog {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

interface Gate {
  open: boolean;
  waiters: (() => void)[];
}

function gate(open: boolean): Gate {
  return { open, waiters: [] };
}

function release(g: Gate): void {
  g.open = true;
  for (const wake of g.waiters.splice(0)) wake();
}

function whenOpen(g: Gate, signal: AbortSignal): Promise<void> {
  if (g.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    g.waiters.push(resolve);
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
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

let clipBytes: Promise<Uint8Array> | undefined;

/** A 720 x 1280, 5 s H.264 clip, as Kling std delivers one (made once per process). */
export function clipMp4(): Promise<Uint8Array> {
  clipBytes ??= (async () => {
    const folder = await mkdtemp(join(tmpdir(), "studio-clip-kit-"));
    try {
      const path = join(folder, "clip.mp4");
      await writeClip(path, { width: 720, height: 1280, seconds: 5 });
      return new Uint8Array(await readFile(path));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  })();
  return clipBytes;
}

const photos = new Map<string, Promise<Uint8Array>>();

/** A flat JPEG photo of the given size (made once per size). */
export function photoJpeg(width = 720, height = 1280): Promise<Uint8Array> {
  const key = `${width}x${height}`;
  let made = photos.get(key);
  if (made === undefined) {
    made = (async () => {
      const folder = await mkdtemp(join(tmpdir(), "studio-clip-photo-"));
      try {
        const path = join(folder, "photo.jpg");
        await runFfmpegForFixture(["-f", "lavfi", "-i", `color=c=0x996655:s=${width}x${height}:d=1`, "-frames:v", "1", "-pix_fmt", "yuvj420p", path]);
        return new Uint8Array(await readFile(path));
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    })();
    photos.set(key, made);
  }
  return made;
}

export interface ClipNetworkOptions {
  /** The video listing: a body, "offline" (the fetch fails: the dated table stands in), or "held" (answers when `releasePrices()` is called). */
  listing?: object | "offline" | "held" | (() => object);
  kling?: VideoScript;
  grok?: VideoScript;
  /** 5b.2 (S5.WB2): the script of the nth POST of a model (1-based), when one differs from `kling` / `grok`: a batch whose second clip is refused, or whose third is held. */
  klingBy?: (n: number) => VideoScript | undefined;
  grokBy?: (n: number) => VideoScript | undefined;
  /** `/credits` total_usage in dollars; default constant. */
  usage?: () => number;
}

export type ClipNetwork = ReturnType<typeof clipNetwork>;

/** The fake OpenRouter of a clip. Job ids are `job-kling-<n>` and `job-grok-<n>`, one per POST. */
export function clipNetwork(options: ClipNetworkOptions = {}) {
  const calls: FetchLog[] = [];
  const scripts = { kling: options.kling ?? {}, grok: options.grok ?? {} };
  const pollGates = { kling: gate(!(scripts.kling.held ?? false)), grok: gate(!(scripts.grok.held ?? false)) };
  const contentGates = { kling: gate(scripts.kling.content !== "held"), grok: gate(scripts.grok.content !== "held") };
  const priceGate = gate(options.listing !== "held");
  let posts = 0;
  const modelOfJob = new Map<string, "kling" | "grok">();
  // 5b.2: a POST may have a script and a poll gate of its own (the nth of its model); the rest read the model's.
  const perModel = { kling: 0, grok: 0 };
  const jobScripts = new Map<string, VideoScript>();
  const jobGates = new Map<string, Gate>();
  const jobByPost = new Map<string, string>();
  const scriptOf = (id: string): VideoScript => jobScripts.get(id) ?? scripts[modelOfJob.get(id) ?? "kling"];

  const fetch: OpenRouterFetch = async (url: string, init: OpenRouterRequestInit) => {
    calls.push({ method: init.method, url, body: init.body });
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    if (path === "/videos/models") {
      await whenOpen(priceGate, init.signal);
      if (options.listing === "offline") throw new TypeError("fetch failed");
      if (typeof options.listing === "function") return response(200, options.listing());
      return response(200, options.listing === undefined || options.listing === "held" ? listing() : options.listing);
    }
    if (path === "/models" || path.endsWith("/endpoints")) throw new TypeError("fetch failed");
    if (path === "/credits") return response(200, { data: { total_credits: 100, total_usage: options.usage?.() ?? 5 } });
    if (path === "/videos" && init.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { model?: string };
      const model = body.model === GROK ? "grok" : "kling";
      const nth = ++perModel[model];
      const own = (model === "kling" ? options.klingBy : options.grokBy)?.(nth);
      const script = own ?? scripts[model];
      if (script.submit === "network") throw new TypeError("fetch failed");
      if (typeof script.submit === "object") return response(script.submit.status, script.submit.body ?? { error: { message: "refused" } });
      const id = `job-${model}-${++posts}`;
      modelOfJob.set(id, model);
      jobByPost.set(`${model}#${nth}`, id);
      if (own !== undefined) {
        jobScripts.set(id, own);
        if (own.held === true) jobGates.set(id, gate(false));
      }
      return response(202, { id, polling_url: `https://openrouter.ai/api/v1/videos/${id}`, status: "pending" });
    }
    const content = /^\/videos\/([^/]+)\/content$/.exec(path);
    if (content !== null) {
      const model = modelOfJob.get(decodeURIComponent(content[1] ?? "")) ?? "kling";
      await whenOpen(contentGates[model], init.signal);
      if (scriptOf(decodeURIComponent(content[1] ?? "")).content === "gone") return response(410, { error: { code: 410, message: "gone" } });
      const bytes = await clipMp4();
      return response(200, bytes, { "content-length": String(bytes.length) });
    }
    const poll = /^\/videos\/([^/]+)$/.exec(path);
    if (poll !== null) {
      const id = decodeURIComponent(poll[1] ?? "");
      const model = modelOfJob.get(id) ?? "kling";
      if (!(jobGates.get(id) ?? pollGates[model]).open) return response(200, { id, generation_id: id, status: "in_progress" });
      const terminal = scriptOf(id).terminal ?? { status: "completed", cost: 0.42 };
      if (terminal.status === "completed") {
        const cost = terminal.cost === undefined ? 0.42 : terminal.cost;
        return response(200, { id, generation_id: id, status: "completed", ...(cost === null ? {} : { usage: { cost, is_byok: false } }) });
      }
      return response(200, { id, generation_id: id, status: "failed", error: terminal.error });
    }
    if (path === "/generation") {
      const id = new URL(url).searchParams.get("id") ?? "";
      const generation = scriptOf(id).generation ?? "404";
      if (generation === "404") return response(404, { error: { code: 404, message: `Generation ${id} not found` } });
      return response(200, { data: { id, total_cost: generation.cost, finish_reason: "stop" } });
    }
    throw new Error(`unexpected request ${init.method} ${url}`);
  };

  return {
    fetch,
    calls,
    posts: (model?: "kling" | "grok") => calls.filter((c) => c.method === "POST" && c.url.endsWith("/videos") && (model === undefined || (JSON.parse(c.body ?? "{}").model === GROK) === (model === "grok"))),
    release: (model: "kling" | "grok") => release(pollGates[model]),
    /** 5b.2: lets the nth POST of a model (1-based) turn terminal; a script with `held` waits for this. */
    releaseNth: (model: "kling" | "grok", n: number) => {
      const id = jobByPost.get(`${model}#${n}`);
      const own = id === undefined ? undefined : jobGates.get(id);
      if (own === undefined) throw new Error(`no held ${model} POST number ${n}`);
      release(own);
    },
    releaseContent: (model: "kling" | "grok") => release(contentGates[model]),
    releasePrices: () => release(priceGate),
  };
}

// ---------- the library ----------

let seeded = 0;

export interface SeedOptions {
  /** The photo's category; `nightwear` makes it a frame of «Смелая». Default `home`. */
  category?: string;
  /** 5a.4 (S5.BA6): the photo was drawn on the Seedream route (`source.route`), which makes a frame of any category a frame of «Смелая». */
  route?: "seedream";
  qa?: PhotoQa;
  /** The photo's bytes; default a 720 x 1280 JPEG. */
  photo?: Uint8Array;
  width?: number;
  height?: number;
}

/** An active avatar with a master photo and one gallery photo whose run plan is not in the library (a planless frame: its facts come from its sidecar). */
export async function seedClipAvatar(libraryDir: string, options: SeedOptions = {}): Promise<{ avatarId: string; photoId: string; masterId: string }> {
  const { library } = await openLibrary(libraryDir, { now: steppingClock(), newId: sequentialIds(`clip${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Nini", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const bytes = options.photo ?? (await photoJpeg(options.width, options.height));
  const photo = await library.addPhoto(avatar.id, bytes, {
    mediaType: "image/jpeg",
    width: options.width ?? 720,
    height: options.height ?? 1280,
    source: { ...SAMPLE_SOURCE, category: options.category ?? "home", attemptId: "run-00000099:slot-1#1", slot: "slot-1", ...(options.route === undefined ? {} : { route: options.route }) },
    qa: options.qa ?? { faceCos: 0.7 },
  });
  return { avatarId: avatar.id, photoId: photo.id, masterId: master.id };
}

// ---------- the engine ----------

export interface Clocks {
  /** Moves the wall clock and the monotonic clock ahead by `ms` (a reconcile's quiet wait). */
  skew(ms: number): void;
}

export async function startClipEngine(
  dir: string,
  options: { net?: ClipNetwork; key?: string | null; init?: Partial<EngineInit>; deps?: Partial<EngineDeps>; timings?: ClipTimings | null; monthlyBudgetMicros?: number } = {},
) {
  const net = options.net ?? clipNetwork();
  const posted: unknown[] = [];
  let n = 0;
  const started = Date.now();
  let skewMs = 0;
  const clocks: Clocks = { skew: (ms) => void (skewMs += ms) };
  const settings = { ...engineInit(dir).settings, imageAgeCheck: "off" as const, ...(options.monthlyBudgetMicros === undefined ? {} : { monthlyBudgetMicros: options.monthlyBudgetMicros }) };
  const deps: EngineDeps = {
    bootId: "boot-0000-clip",
    clock: () => NOW + (Date.now() - started) + skewMs,
    monotonic: () => Date.now() - started + skewMs,
    newId: () => `id-${String(++n).padStart(8, "0")}`,
    post: (message) => posted.push(message),
    fetch: net.fetch,
    ...(options.timings === null ? {} : { clipTimings: options.timings ?? SHORT_CLIP_TIMINGS }),
    ...options.deps,
  };
  await mkdir(join(dir, "export"), { recursive: true });
  const engine = await Engine.start(engineInit(dir, { settings, ...options.init }), deps);
  const key = options.key === undefined ? KEY : options.key;
  if (key !== null) await engine.applyControl({ kind: "control", type: "apiKey.set", key });
  const events = (): EventMessage[] => posted.filter((m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "event").map((m) => EventMessage.parse(m));
  return { engine, net, posted, events, clocks };
}

export type ClipEngine = Awaited<ReturnType<typeof startClipEngine>>;

let seq = 0;
export function command(type: string, payload: unknown = {}): unknown {
  return { v: PROTOCOL_VERSION, id: `cmd-clip-${String(++seq).padStart(8, "0")}`, kind: "command", type, payload };
}

export interface CreatePayload {
  avatarId: string;
  photoId: string;
  motionId?: string;
  model?: "kling" | "grok";
  quality?: "std" | "pro";
  seconds?: 5 | 10;
  fallback?: "auto" | "none";
  acceptedWorstMicros?: number;
}

export function createCommand(payload: CreatePayload): unknown {
  return command("clips.create", {
    motionId: "g-blink",
    model: "kling",
    quality: "std",
    seconds: 5,
    fallback: "auto",
    acceptedWorstMicros: 850_000,
    ...payload,
  });
}

export async function create(started: ClipEngine, payload: CreatePayload): Promise<ResponseMessage> {
  return started.engine.handle(createCommand(payload));
}

export async function options(started: ClipEngine, avatarId: string, photoId: string): Promise<ResponseMessage> {
  return started.engine.handle(command("clips.options", { avatarId, photoId }));
}

export function optionsOf(response: ResponseMessage): ClipOptions {
  if (!response.ok || response.type !== "clips.options") throw new Error(`expected clips.options, got ${JSON.stringify(response)}`);
  return response.result;
}

export function jobIdOf(response: ResponseMessage): string {
  if (!response.ok || response.type !== "clips.create") throw new Error(`expected a clips.create answer, got ${JSON.stringify(response)}`);
  return response.result.jobId;
}

/** Polls `condition` every 5 ms for up to `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/** The terminal event of a job. */
export async function jobEnd(started: ClipEngine, jobId: string): Promise<EventMessage> {
  const terminal = new Set(["job.done", "job.failed", "job.cancelled"]);
  const find = () => started.events().find((e) => terminal.has(e.type) && "jobId" in e.payload && e.payload.jobId === jobId);
  await until(() => find() !== undefined, `the end of job ${jobId}`);
  const end = find();
  if (end === undefined) throw new Error("unreachable");
  return end;
}

/** The phases of a clip job, in the order its progress events carried them. */
export function phasesOf(started: ClipEngine, jobId: string): string[] {
  return started.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId ? [e.payload.phase] : []));
}

/** The clips folder of an avatar. */
export function clipsDir(libraryDir: string, avatarId: string): string {
  return join(libraryDir, "avatars", avatarId, "clips");
}
