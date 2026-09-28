/**
 * A mock OpenRouter server for Studio's avatar and import end-to-end
 * scenarios (studio/scripts/smoke-engine.ts). Runs in the harness process
 * itself — `Bun.serve` on 127.0.0.1 with an ephemeral port — the only kind of
 * host an E2E build's `--studio-openrouter-base-url` override may point at
 * (invariant 13, studio/engine/openrouter/client.ts's `checkedBaseUrl`
 * refuses anything but a loopback http(s) base). No request this server
 * answers ever reaches the real network, and the only API key ever sent to
 * it is a fake one (studio/scripts/smoke-engine.ts's SMOKE_KEY).
 *
 * It serves exactly what the avatar, import and photo-run flows
 * (studio/engine/avatars/*, studio/engine/runs/*, studio/engine/money/prices.ts) call:
 * - GET  /images/models/<imageModel>/endpoints  (image price; the exact
 *   fixture studio/engine/money/prices.test.ts already parses)
 * - GET  /models                                 (chat price; ditto)
 * - POST /chat/completions                       (the descriptor, schema
 *   "avatar_descriptor"; the age check, schema "age_check"; T6c's vision
 *   describe call, schema "import_describe"; the scene writer, schema
 *   "scene_sentences")
 * - POST /images                                 (candidate and scene
 *   portraits — a real, valid, non-animated PNG rendered once by the bundled
 *   ffmpeg, never a committed binary blob)
 * - GET  /credits                                (reconcile)
 * Anything else is a bug — this mock or a leak past invariant 13 — and
 * answers 404, loudly (logged to stderr and kept in `unexpected`, which the
 * caller must assert is empty).
 *
 * `imageDelayMs`/`writerDelayMs` (T6's kill-and-resume E2E scenario,
 * smoke-engine.ts) hold a response after recording the request, so a caller
 * can poll `requests`/`imageRequests()` to know a request has genuinely
 * arrived (and is being held) before it decides to act — never a fixed
 * sleep. `distinctImages` serves a different rendered image per call instead
 * of the one cached portrait: T7a is adding an always-on PDQ near-duplicate
 * QA gate to photo runs (threshold 20 of 256 bits), so identical — or merely
 * different-hued but structurally uniform — fake images would be retried as
 * duplicates once it lands. Each pool image is a distinct pattern
 * (distinctPattern.ts, checkerboards and rotated stripes, encoded with
 * grayscalePng.ts): studio/scripts/distinctPattern.test.ts proves every pair
 * over 40 bits apart with PDQ itself (src/core/pdq), double the gate's own
 * threshold.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FALLBACK_IMAGE_MODEL } from "../engine/runs/plan";
import { WRITER_JSON_SCHEMA } from "../engine/scenes";
import { DEFAULT_IMAGE_MODEL } from "../main/settingsStore";
import { ffmpegPath } from "../node/ffmpegBinary";
import { patternFor, renderGray } from "./distinctPattern";
import { encodeGrayscalePng } from "./grayscalePng";

const FIXTURES = join(import.meta.dirname, "../engine/money/fixtures");

// ---------- a real portrait, rendered once ----------

let portraitCache: Uint8Array | null = null;

/** A real, valid, non-animated PNG (roughly 3:4), from the bundled ffmpeg — the same technique studio/engine/testing/engineHarness.ts uses for engine tests. */
function portraitPng(): Uint8Array {
  if (portraitCache !== null) return portraitCache;
  const r = spawnSync(ffmpegPath(), [
    "-f", "lavfi", "-i", "mandelbrot=size=200x268",
    "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ], { timeout: 30_000 });
  if (r.status !== 0) throw new Error(`the mock OpenRouter could not render a portrait with ffmpeg: ${r.stderr.toString()}`);
  portraitCache = new Uint8Array(r.stdout);
  return portraitCache;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ---------- distinct images (T6's kill-and-resume scenario) ----------

const DISTINCT_WIDTH = 200;
const DISTINCT_HEIGHT = 356;

/**
 * A real, valid, non-animated PNG, structurally distinct by `index`
 * (distinctPattern.ts's checkerboards and rotated stripes, encoded with
 * grayscalePng.ts — never a committed binary blob, never a round trip
 * through ffmpeg): PDQ compares luminance structure, not hue, so every image
 * a photo run's slots receive must differ in structure, not just colour —
 * see the module doc above and distinctPattern.test.ts's own proof.
 */
function distinctPortraitPng(index: number): Uint8Array {
  return encodeGrayscalePng(DISTINCT_WIDTH, DISTINCT_HEIGHT, renderGray(patternFor(index), DISTINCT_WIDTH, DISTINCT_HEIGHT));
}

/** Every distinct image up front (never mid-request), so nothing adds latency while a caller is timing a request's arrival. */
function buildDistinctPool(size: number): Uint8Array[] {
  return Array.from({ length: size }, (_, i) => distinctPortraitPng(i));
}

// ---------- the scene writer (schema "scene_sentences") ----------

const WriterRequestSlot = z.object({ slotIndex: z.number().int(), location: z.string(), timeOfDay: z.string(), outfit: z.string() }).loose();

const WriterChatBody = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) });

/**
 * The plan's slots this writer chunk asked for, read back out of
 * `scenes/writer.ts`'s own request shape (`writerMessages`): a user message
 * whose text is `"Slots:\n" + JSON.stringify(slots, null, 2)`, optionally
 * followed by a re-ask paragraph after a blank line. The JSON itself never
 * contains a blank line (`JSON.stringify(..., null, 2)`'s own indentation
 * only ever uses single newlines), so splitting on the first blank line
 * isolates it safely.
 */
function writerSlotsOf(body: unknown): z.infer<typeof WriterRequestSlot>[] {
  const parsed = WriterChatBody.parse(body);
  const user = parsed.messages.find((m) => m.role === "user");
  if (user === undefined) throw new Error("the scene writer request has no user message");
  const json = (user.content.split("\n\n")[0] ?? "").replace(/^Slots:\n/, "");
  return z.array(WriterRequestSlot).parse(JSON.parse(json));
}

/**
 * One compliant scene sentence per slot: no youth or revealing word, no
 * two-handed phrasing, and no mention of the camera at all (so it can never
 * contradict a back or profile pose's own rule) — `scenes/writer.ts`'s
 * `readWriterAnswer` accepts every one of these. `location`, `timeOfDay` and
 * `outfit` come straight from the plan's own slot (already vetted by the
 * planner's pools), so every slot's sentence differs with its scene.
 */
function writerSentenceFor(slot: z.infer<typeof WriterRequestSlot>): string {
  return `She spends a quiet moment at ${slot.location} in the ${slot.timeOfDay}, wearing ${slot.outfit}, calm and unhurried.`;
}

/** The JSON schema a chat completion asked for ("avatar_descriptor", "age_check"), or null — studio/engine/testing/engineHarness.ts's `schemaName`, read from the parsed body instead of a captured fetch call. */
function schemaNameOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("response_format" in body)) return null;
  const format = (body as Record<string, unknown>).response_format;
  if (typeof format !== "object" || format === null || !("json_schema" in format)) return null;
  const schema = (format as Record<string, unknown>).json_schema;
  return typeof schema === "object" && schema !== null && "name" in schema && typeof (schema as Record<string, unknown>).name === "string"
    ? String((schema as Record<string, unknown>).name)
    : null;
}

// ---------- the mock ----------

export interface MockRequest {
  method: string;
  path: string;
  /** Parsed JSON for a POST; null for a GET or a body that did not parse. */
  body: unknown;
  schemaName: string | null;
  /** The request's Authorization header, verbatim; null when it sent none (the price-fetch GETs send none — see openrouter/priceFetch.ts). */
  authorization: string | null;
}

/** T6c: the vision describe call's own strict JSON answer (the M5 subject check, traits, and descriptor in one). */
export interface MockImportDescribeAnswer {
  people: number;
  woman: boolean;
  age: number;
  ethnicity: string;
  skinTone: string;
  hairColor: string;
  hairLength: string;
  hairTexture: string;
  eyeColor: string;
  build: string;
  marks: string[];
  descriptor: string;
}

/** A plausible default answer: exactly one woman (M5), always adult, always passing today's descriptor rules. */
export const DEFAULT_IMPORT_DESCRIBE_ANSWER: MockImportDescribeAnswer = {
  people: 1,
  woman: true,
  age: 27,
  ethnicity: "latina",
  skinTone: "tan",
  hairColor: "black",
  hairLength: "long",
  hairTexture: "wavy",
  eyeColor: "brown",
  build: "athletic",
  marks: [],
  descriptor: "27-year-old Latina woman, tan skin, brown eyes, long wavy black hair, athletic build.",
};

export interface MockOpenRouterOptions {
  /** Must match the app's settings.imageModel (default: the same default the app itself uses). */
  imageModel?: string;
  /** What the mock answers for the "avatar_descriptor" schema. */
  descriptorText: string;
  /** T6c: what the mock answers for the "import_describe" schema (the vision job's traits + descriptor); unused unless an import scenario runs. */
  importDescribeAnswer?: MockImportDescribeAnswer;
  /** Which age-check call, counted across the whole run (1-based), answers "not an adult"; 0 rejects none. */
  rejectAgeCheckNumber?: number;
  /** USD per call; /credits' total_usage is the running sum of exactly these. */
  costsUsd?: { descriptor?: number; image?: number; age?: number; importDescribe?: number; writer?: number };
  /**
   * T6's kill-and-resume scenario: held after the request is recorded (so a
   * caller can see it arrive) and before the response is built, so a run
   * stays genuinely mid-flight until the caller acts. 0 (the default) answers
   * at once, as every other scenario needs.
   */
  imageDelayMs?: number;
  /** Same as `imageDelayMs`, for the scene writer's "scene_sentences" calls. */
  writerDelayMs?: number;
  /**
   * Serves a different rendered image per `/images` call instead of the one
   * cached portrait (T6's kill-and-resume scenario: T7a's PDQ near-duplicate
   * gate would retry identical images as duplicates once it lands). Off by
   * default: the avatar and import scenarios do not need it.
   */
  distinctImages?: boolean;
}

export interface MockOpenRouter {
  /** Pass as --studio-openrouter-base-url. */
  url: string;
  /** Every request this mock answered, in arrival order. */
  requests: MockRequest[];
  /** Any request outside the six routes above — a run with one of these must fail. */
  unexpected: MockRequest[];
  imageRequests(): MockRequest[];
  ageCheckRequests(): MockRequest[];
  descriptorRequests(): MockRequest[];
  /** T6c: the vision describe call's own requests ("import_describe" schema), distinct from a plain new-avatar descriptor. */
  importDescribeRequests(): MockRequest[];
  /** T6: the scene writer's own requests ("scene_sentences" schema). */
  sceneWriterRequests(): MockRequest[];
  priceRequests(): MockRequest[];
  creditsRequests(): MockRequest[];
  /** The running total this mock has billed, in USD — what /credits reports. */
  totalUsageUsd(): number;
  stop(): Promise<void>;
}

export async function startMockOpenRouter(opts: MockOpenRouterOptions): Promise<MockOpenRouter> {
  const imageModel = opts.imageModel ?? DEFAULT_IMAGE_MODEL;
  const costs = { descriptor: 0.0021, image: 0.04, age: 0.0014, importDescribe: 0.0021, writer: 0.011, ...opts.costsUsd };
  const rejectAt = opts.rejectAgeCheckNumber ?? 1;
  const imageDelayMs = opts.imageDelayMs ?? 0;
  const writerDelayMs = opts.writerDelayMs ?? 0;
  const requests: MockRequest[] = [];
  const unexpected: MockRequest[] = [];
  let totalUsageUsd = 0;
  let ageCheckCount = 0;
  let imageCount = 0;
  // Built once, up front: rendering must never add latency inside a request a
  // caller is timing the arrival of (see the module doc above).
  const distinctPool = opts.distinctImages ? buildDistinctPool(48) : [];

  // Reused verbatim: the exact bodies studio/engine/money/prices.test.ts
  // already proved the real client parses, so the mock's prices are exactly
  // the fallback table's (studio/engine/money/prices.ts's FALLBACK_IMAGE /
  // FALLBACK_CHAT), and every cost in this file matches it.
  const endpointsFixture = readFileSync(join(FIXTURES, "endpoints-grok-imagine-image-2.0.json"), "utf8");
  const modelsFixture = readFileSync(join(FIXTURES, "models-chat.json"), "utf8");

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function record(req: Request, path: string, body: unknown): MockRequest {
    const entry: MockRequest = { method: req.method, path, body, schemaName: schemaNameOf(body), authorization: req.headers.get("authorization") };
    requests.push(entry);
    return entry;
  }

  function loudly404(entry: MockRequest): Response {
    unexpected.push(entry);
    console.error(`mock OpenRouter: unexpected ${entry.method} ${entry.path} (schema ${String(entry.schemaName)}) — the run must not do this`);
    return json({ error: { message: `unexpected request: ${entry.method} ${entry.path}` } }, 404);
  }

  /** A chat completion's body; also books the call's cost against the running total /credits reports. */
  function chatCompletion(content: string, cost: number): unknown {
    totalUsageUsd += cost;
    return {
      id: "mock-gen",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 900, completion_tokens: 200, cost },
    };
  }

  async function jsonBody(req: Request): Promise<unknown> {
    return req.json().catch(() => null);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const { pathname: path } = new URL(req.url);
      const { method } = req;

      if (
        method === "GET" &&
        (path === `/api/v1/images/models/${imageModel}/endpoints` || path === `/api/v1/images/models/${FALLBACK_IMAGE_MODEL}/endpoints`)
      ) {
        // T6's photo runs price both the settings' image model and the
        // one-attempt Seedream fallback up front (runs/plan.ts's
        // `runPriceModels`), so both endpoints must answer; the same fixture
        // stands in for either model — a run's own estimate/cap checks never
        // depend on the two carrying different numbers.
        record(req, path, null);
        return new Response(endpointsFixture, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && path === "/api/v1/models") {
        record(req, path, null);
        return new Response(modelsFixture, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && path === "/api/v1/credits") {
        record(req, path, null);
        return json({ data: { total_usage: totalUsageUsd } });
      }
      if (method === "POST" && path === "/api/v1/chat/completions") {
        const entry = record(req, path, await jsonBody(req));
        if (entry.schemaName === "avatar_descriptor") {
          return json(chatCompletion(JSON.stringify({ descriptor: opts.descriptorText }), costs.descriptor));
        }
        if (entry.schemaName === "age_check") {
          ageCheckCount++;
          const reject = rejectAt > 0 && ageCheckCount === rejectAt;
          const answer = {
            adult: !reject,
            confidence: 0.95,
            reason: reject ? "Appears younger than 21." : "Mature features of a woman in her mid-20s.",
          };
          return json(chatCompletion(JSON.stringify(answer), costs.age));
        }
        if (entry.schemaName === "import_describe") {
          const answer = opts.importDescribeAnswer ?? DEFAULT_IMPORT_DESCRIBE_ANSWER;
          return json(chatCompletion(JSON.stringify(answer), costs.importDescribe));
        }
        if (entry.schemaName === WRITER_JSON_SCHEMA.name) {
          if (writerDelayMs > 0) await Bun.sleep(writerDelayMs);
          const slots = writerSlotsOf(entry.body);
          const answer = { scenes: slots.map((s) => ({ slotIndex: s.slotIndex, sentence: writerSentenceFor(s) })) };
          return json(chatCompletion(JSON.stringify(answer), costs.writer));
        }
        return loudly404(entry);
      }
      if (method === "POST" && path === "/api/v1/images") {
        record(req, path, await jsonBody(req));
        if (imageDelayMs > 0) await Bun.sleep(imageDelayMs);
        totalUsageUsd += costs.image;
        const bytes = distinctPool.length > 0 ? (distinctPool[imageCount++ % distinctPool.length] ?? portraitPng()) : portraitPng();
        return json({ created: 1_790_000_000, data: [{ b64_json: b64(bytes), media_type: "image/png" }], usage: { cost: costs.image } });
      }
      return loudly404(record(req, path, method === "POST" ? await jsonBody(req) : null));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/api/v1`,
    requests,
    unexpected,
    imageRequests: () => requests.filter((r) => r.path === "/api/v1/images"),
    ageCheckRequests: () => requests.filter((r) => r.schemaName === "age_check"),
    descriptorRequests: () => requests.filter((r) => r.schemaName === "avatar_descriptor"),
    importDescribeRequests: () => requests.filter((r) => r.schemaName === "import_describe"),
    sceneWriterRequests: () => requests.filter((r) => r.schemaName === WRITER_JSON_SCHEMA.name),
    priceRequests: () => requests.filter((r) => r.path.endsWith("/endpoints") || r.path === "/api/v1/models"),
    creditsRequests: () => requests.filter((r) => r.path === "/api/v1/credits"),
    totalUsageUsd: () => totalUsageUsd,
    stop: async () => {
      server.stop(true);
    },
  };
}
