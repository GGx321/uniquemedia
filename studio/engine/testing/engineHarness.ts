import { afterEach, beforeEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventMessage, ResponseMessage, type AvatarTraits, type Estimate } from "../../shared/engine";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { manifestTraits } from "../avatars/records";
import type { EngineInit } from "../control";
import { Engine, type EngineDeps } from "../engine";
import { openLibrary } from "../library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../library/testing/helpers";
import { Ledger, type LedgerLine } from "../money/ledger";
import { chatBody, fakeFetch, imageBody, readLedgerLines, type FetchCall, type Reply, type Step } from "../openrouter/testing/fakes";

// Test-only: an engine over a real ledger and library in a temp dir, and a
// fake OpenRouter routed by URL and by the JSON schema a chat asks for.
// Nothing here can reach the network or spend money.

export const NOW = Date.parse("2026-09-24T12:00:00.000Z");
export const KEY = "sk-or-v1-0123456789abcdef-wxyz";
export const BASE = "https://openrouter.ai/api/v1";

export const TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "girl next door, coffee, travel, books",
};
export const GOOD = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";

/** The dated fallback table's prices (grok-imagine-image-2.0 low 1K, grok-4.3), as plan.test.ts pins them. */
export const NEW_AVATAR: Estimate = { expectedMicros: 169_265, worstMicros: 208_500, prices: "fallback", pricesAsOf: "2026-09-24" };
export const NEXT_BATCH: Estimate = { expectedMicros: 166_640, worstMicros: 181_000, prices: "fallback", pricesAsOf: "2026-09-24" };
export const IMAGE_WORST = 40_000;
export const AGE_WORST = 5_250;

/** A fresh temp dir per test with an empty `library` folder; a getter, since it exists only once `beforeEach` ran. */
export function useEngineDir(prefix: string): () => string {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix));
    await mkdir(join(dir, "library"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

export function engineInit(dir: string, overrides: Partial<EngineInit> = {}): EngineInit {
  return {
    kind: "control",
    type: "init",
    ledgerPath: join(dir, "userData", "ledger.jsonl"),
    defaultLibraryPath: join(dir, "userData", "library"),
    rawDir: join(dir, "userData", "raw"),
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(dir, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
    },
    encryptionAvailable: true,
    notices: [],
    ...overrides,
  };
}

export function engineSettings(dir: string, patch: Partial<EngineInit["settings"]>): EngineInit["settings"] {
  return { ...engineInit(dir).settings, ...patch };
}

// ---------- images ----------

const portraits = new Map<number, Uint8Array>();

/** A real PNG portrait (60×80, 3:4), different for each variant, made by the bundled ffmpeg. */
export function portraitPng(variant = 1): Uint8Array {
  const known = portraits.get(variant);
  if (known !== undefined) return known;
  const r = spawnSync(ffmpegPath(), [
    "-f", "lavfi", "-i", `mandelbrot=size=60x80:start_x=${(-0.75 + variant / 10).toFixed(2)}`,
    "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render a portrait: ${r.stderr.toString()}`);
  const bytes = new Uint8Array(r.stdout);
  portraits.set(variant, bytes);
  return bytes;
}

// ---------- the fake OpenRouter ----------

export const OFFLINE: Reply = { reject: new TypeError("fetch failed") };
export const MODERATION: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };

export function descriptorReply(descriptor: string, cost = 0.0021): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ descriptor }), { cost }) };
}

export function portraitReply(variant = 1): Reply {
  return { status: 200, body: imageBody(portraitPng(variant), { cost: 0.04 }) };
}

export function ageReply(adult: boolean, confidence = 0.95): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ adult, confidence, reason: "Mature features of a woman in her mid-20s." }), { cost: 0.0014 }) };
}

/** The JSON schema a chat completion asks for: "avatar_descriptor", "age_check", or null. */
export function schemaName(call: FetchCall): string | null {
  const body: unknown = call.body === undefined ? null : JSON.parse(call.body);
  if (typeof body !== "object" || body === null || !("response_format" in body)) return null;
  const format = body.response_format;
  if (typeof format !== "object" || format === null || !("json_schema" in format)) return null;
  const schema = format.json_schema;
  return typeof schema === "object" && schema !== null && "name" in schema && typeof schema.name === "string" ? schema.name : null;
}

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

/**
 * Price GETs answer `prices` (offline by default: the fallback table),
 * descriptor chats take `descriptors` in turn, images and age checks their
 * handler with its own call count (by default: portrait n, a confident adult).
 */
export function network(opts: { prices?: (call: FetchCall) => Reply | Promise<Reply>; descriptors?: Step[]; image?: Handler; age?: Handler } = {}) {
  const descriptors = [...(opts.descriptors ?? [])];
  let images = 0;
  let ages = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) {
      const n = ++images;
      return (opts.image ?? ((_call, i) => portraitReply(((i - 1) % 4) + 1)))(call, n);
    }
    if (call.url.endsWith("/chat/completions")) {
      if (schemaName(call) === "age_check") return (opts.age ?? (() => ageReply(true)))(call, ++ages);
      const step = descriptors.shift();
      if (step === undefined) throw new Error("unexpected descriptor request");
      return typeof step === "function" ? step(call) : step;
    }
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return (await opts.prices?.(call)) ?? OFFLINE;
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 256 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    ageCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions") && schemaName(c) === "age_check"),
    descriptorCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions") && schemaName(c) === "avatar_descriptor"),
    paidCalls: () => net.calls.filter((c) => c.method === "POST"),
  };
}

export type Network = ReturnType<typeof network>;

// ---------- the engine ----------

export async function startEngine(dir: string, opts: { init?: Partial<EngineInit>; net?: Network; key?: string | null; bootId?: string } = {}) {
  const net = opts.net ?? network();
  const posted: unknown[] = [];
  let n = 0;
  const deps: EngineDeps = {
    bootId: opts.bootId ?? "boot-0000-aaaa",
    clock: () => NOW,
    monotonic: () => 0,
    newId: () => `id-${String(++n).padStart(8, "0")}`,
    post: (message) => posted.push(message),
    fetch: net.fetch,
  };
  const engine = await Engine.start(engineInit(dir, opts.init), deps);
  const key = opts.key === undefined ? KEY : opts.key;
  if (key !== null) await engine.applyControl({ kind: "control", type: "apiKey.set", key });
  const events = () =>
    posted.filter((m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "event").map((m) => EventMessage.parse(m));
  return { engine, net, posted, events };
}

let commandSeq = 0;
export function command(type: string, payload: unknown = {}): unknown {
  return { v: 1, id: `cmd-${String(++commandSeq).padStart(8, "0")}`, kind: "command", type, payload };
}

export function ok(response: ResponseMessage): Extract<ResponseMessage, { ok: true }> {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (!response.ok) throw new Error(`expected ok, got ${response.error.code}: ${response.error.detail ?? ""}`);
  return response;
}

export function failed(response: ResponseMessage): Extract<ResponseMessage, { ok: false }> {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (response.ok) throw new Error(`expected an error, got ${JSON.stringify(response.result)}`);
  return response;
}

export function ledgerLines(dir: string): Record<string, unknown>[] {
  return readLedgerLines(join(dir, "userData", "ledger.jsonl"));
}

export async function writeLedger(dir: string, lines: LedgerLine[]): Promise<void> {
  const ledger = await Ledger.open(join(dir, "userData", "ledger.jsonl"));
  for (const line of lines) await ledger.append(line);
}

let seedRound = 0;

/** A saved avatar with a master photo, then a draft; both from TRAITS unless `traits` says otherwise. Ids differ on every call. */
export async function seedDraft(dir: string, opts: { traits?: AvatarTraits; descriptor?: string } = {}): Promise<{ draftId: string; avatarId: string; masterId: string }> {
  const traits = opts.traits ?? TRAITS;
  const { library } = await openLibrary(join(dir, "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seedRound}`) });
  const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
  const draft = await library.createAvatar({ name: "Draft", age: traits.age, traits: manifestTraits(traits), descriptor: opts.descriptor ?? GOOD });
  return { draftId: draft.id, avatarId: saved.id, masterId: master.id };
}

export function generate(avatarId: string, acceptedWorstMicros = NEXT_BATCH.worstMicros): unknown {
  return command("avatars.generateCandidates", { avatarId, acceptedWorstMicros });
}

/** The job id a generateCandidates response carries. */
export function jobIdOf(response: ResponseMessage): string {
  const answer = ok(response);
  if (answer.type !== "avatars.generateCandidates") throw new Error(`expected a generateCandidates answer, got ${answer.type}`);
  return answer.result.jobId;
}

export async function until(condition: () => boolean, what = "the condition"): Promise<void> {
  for (let i = 0; i < 600 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

type Events = () => EventMessage[];
const TERMINAL = new Set(["job.done", "job.failed", "job.cancelled"]);

/** The job's terminal event (job.done, job.failed or job.cancelled), once it came. */
export async function jobEnd(events: Events, jobId: string): Promise<EventMessage> {
  const find = () => events().find((e) => TERMINAL.has(e.type) && "jobId" in e.payload && e.payload.jobId === jobId);
  await until(() => find() !== undefined, `the end of job ${jobId}`);
  const end = find();
  if (end === undefined) throw new Error("unreachable");
  return end;
}

/** Every file under `dir`, relative, sorted. */
export async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

export async function fileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

/**
 * Runs `work` with the system temp folder (TMPDIR, TEMP, TMP) pointed at an
 * empty folder of its own under `parent`, watched: every name anything
 * created there, even for a moment, is returned.
 */
export async function tempWritesDuring(parent: string, work: () => Promise<unknown>): Promise<string[]> {
  const temp = await mkdtemp(join(parent, "tmp-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const seen: string[] = [];
  const watcher = watch(temp, { recursive: true }, (_event, name) => {
    if (name !== null) seen.push(String(name));
  });
  Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    watcher.close();
  }
  return [...new Set([...seen, ...(await readdir(temp))])];
}
