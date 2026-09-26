/**
 * A mock OpenRouter server for Studio's avatar end-to-end scenario
 * (studio/scripts/smoke-engine.ts). Runs in the harness process itself —
 * `Bun.serve` on 127.0.0.1 with an ephemeral port — the only kind of host an
 * E2E build's `--studio-openrouter-base-url` override may point at
 * (invariant 13, studio/engine/openrouter/client.ts's `checkedBaseUrl`
 * refuses anything but a loopback http(s) base). No request this server
 * answers ever reaches the real network, and the only API key ever sent to
 * it is a fake one (studio/scripts/smoke-engine.ts's SMOKE_KEY).
 *
 * It serves exactly what the avatar flow (studio/engine/avatars/*,
 * studio/engine/money/prices.ts) calls:
 * - GET  /images/models/<imageModel>/endpoints  (image price; the exact
 *   fixture studio/engine/money/prices.test.ts already parses)
 * - GET  /models                                 (chat price; ditto)
 * - POST /chat/completions                       (the descriptor, schema
 *   "avatar_descriptor"; the age check, schema "age_check")
 * - POST /images                                 (candidate portraits — a
 *   real, valid, non-animated PNG rendered once by the bundled ffmpeg, never
 *   a committed binary blob)
 * - GET  /credits                                (reconcile)
 * Anything else is a bug — this mock or a leak past invariant 13 — and
 * answers 404, loudly (logged to stderr and kept in `unexpected`, which the
 * caller must assert is empty).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IMAGE_MODEL } from "../main/settingsStore";
import { ffmpegPath } from "../node/ffmpegBinary";

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

export interface MockOpenRouterOptions {
  /** Must match the app's settings.imageModel (default: the same default the app itself uses). */
  imageModel?: string;
  /** What the mock answers for the "avatar_descriptor" schema. */
  descriptorText: string;
  /** Which age-check call, counted across the whole run (1-based), answers "not an adult"; 0 rejects none. */
  rejectAgeCheckNumber?: number;
  /** USD per call; /credits' total_usage is the running sum of exactly these. */
  costsUsd?: { descriptor?: number; image?: number; age?: number };
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
  priceRequests(): MockRequest[];
  creditsRequests(): MockRequest[];
  /** The running total this mock has billed, in USD — what /credits reports. */
  totalUsageUsd(): number;
  stop(): Promise<void>;
}

export async function startMockOpenRouter(opts: MockOpenRouterOptions): Promise<MockOpenRouter> {
  const imageModel = opts.imageModel ?? DEFAULT_IMAGE_MODEL;
  const costs = { descriptor: 0.0021, image: 0.04, age: 0.0014, ...opts.costsUsd };
  const rejectAt = opts.rejectAgeCheckNumber ?? 1;
  const requests: MockRequest[] = [];
  const unexpected: MockRequest[] = [];
  let totalUsageUsd = 0;
  let ageCheckCount = 0;

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

      if (method === "GET" && path === `/api/v1/images/models/${imageModel}/endpoints`) {
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
        return loudly404(entry);
      }
      if (method === "POST" && path === "/api/v1/images") {
        record(req, path, await jsonBody(req));
        totalUsageUsd += costs.image;
        return json({ created: 1_790_000_000, data: [{ b64_json: b64(portraitPng()), media_type: "image/png" }], usage: { cost: costs.image } });
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
    priceRequests: () => requests.filter((r) => r.path.endsWith("/endpoints") || r.path === "/api/v1/models"),
    creditsRequests: () => requests.filter((r) => r.path === "/api/v1/credits"),
    totalUsageUsd: () => totalUsageUsd,
    stop: async () => {
      server.stop(true);
    },
  };
}
