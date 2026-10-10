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
 *   "scene_sentences"; a custom category's pool, schema "scene_pool")
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
import { ideaNamesMirror } from "../shared/engine";
import { IDEA_JSON_SCHEMA } from "../engine/scenes/ideaWriter";
import { SHOT_LABEL } from "../engine/scenes/writer";
import { POOL_JSON_SCHEMA } from "../engine/scenes/poolGen";
import { DEFAULT_IMAGE_MODEL } from "../main/settingsStore";
import { ffmpegPath } from "../node/ffmpegBinary";
import { servedPoolImagePng } from "./distinctPattern";
import { FACE_FIXTURE_PATH, facePoolImagePng, facePoolNoFacePng } from "./facePool";

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

// ---------- a real fixture face (T7b: proving the face gate in the packaged E2E smoke) ----------

let faceFixtureCache: Uint8Array | null = null;

/**
 * L9: fixed a stale name/comment — this was called `faceFixturePng` while
 * actually reading `FACE_FIXTURE_PATH` (fixtures/images/master.jpg), a real
 * JPEG file, and the response handler below labelled every image
 * `media_type: "image/png"` regardless. The same fixture parity.test.ts
 * pins to the OpenCV/nativeImage numbers, served as the mock avatar's
 * master/candidate portrait when `faceFixture` is on and the image is not
 * coming from the composited pool (`buildFacePool`, also real JPEG now).
 */
function faceFixtureBytes(): Uint8Array {
  faceFixtureCache ??= readFileSync(FACE_FIXTURE_PATH);
  return faceFixtureCache;
}

// ---------- distinct images (T6's kill-and-resume scenario; T7b's face-composited variant) ----------

/**
 * Every distinct image up front (never mid-request, so nothing adds latency
 * while a caller is timing a request's arrival): `distinctPattern.ts`'s
 * `servedPoolImagePng`, the one function that also produces
 * distinctPattern.test.ts's own proof bytes — never a second, drifting copy
 * of the render.
 */
function buildDistinctPool(size: number): Uint8Array[] {
  return Array.from({ length: size }, (_, i) => servedPoolImagePng(i));
}

/**
 * T7b: the same pool, but every image also carries the fixture face
 * (`facePool.ts`'s `facePoolImagePng`) composited onto its own PDQ-distinct
 * background — so a run with the face gate on gets a detectable, matching
 * face on every image instead of retrying every front/three-quarter slot
 * forever. distinctPattern.test.ts's own extension proves both properties
 * hold (PDQ-distinct, face-matching) for exactly this function's output.
 * Real JPEG now (L9), not PNG — production's own image model returns JPEG,
 * so this is what actually exercises the engine's WASM JPEG decode path.
 *
 * `mismatchAt`: pool index `mismatchAt` is `facePoolNoFacePng` instead
 * (L9) — a real, deterministic "no face detected" on exactly one served
 * image (never a composited different-person's face landed in the
 * gross-drift range by luck: measured, the fixture impostor composited here
 * scores 0.647, still a "match" under the hybrid policy). A run whose slots
 * are all front/three-quarter (RUN_POSES) sees exactly one attempt hit this
 * and retry — smoke-engine.ts's own run scenario proves the slot then still
 * passes on a later attempt.
 *
 * `mismatchAt` is an explicit index, not always 0: `imageCount` (below) is
 * ONE counter shared by every `/images` call this mock answers, including
 * an avatar's own candidate-portrait generation BEFORE any run starts (both
 * draw from the exact same `distinctPool`). A first version of this feature
 * hard-coded index 0 and broke a real E2E run: the smoke scenario's own
 * `avatars.pick` always picks `candidates[0]` — the FIRST generated
 * candidate — as the master, so a no-face image at index 0 became the RUN'S
 * OWN MASTER, not a run slot's attempt; `prepare()` (H1) correctly failed
 * the whole job as `MASTER_FACE_UNUSABLE` before a single slot ran, and the
 * scenario's own `waitFor` for run progress timed out with nothing to find.
 * The caller must pass an index past every image request it expects BEFORE
 * the run's own first slot attempt (smoke-engine.ts passes 4, the fixed
 * candidate count `avatars.generateCandidates` always produces).
 */
function buildFacePool(size: number, mismatchAt: number | null): Uint8Array[] {
  return Array.from({ length: size }, (_, i) => (i === mismatchAt ? facePoolNoFacePng(i, "jpeg") : facePoolImagePng(i, FACE_FIXTURE_PATH, "jpeg")));
}

// ---------- the scene writer (schema "scene_sentences") ----------

const WriterRequestSlot = z.object({ slotIndex: z.number().int(), location: z.string(), timeOfDay: z.string(), outfit: z.string() }).loose();

const WriterChatBody = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) });

/**
 * The plan's slots this writer chunk asked for, read back out of
 * `scenes/writer.ts`'s own request shape (`writerMessages`): a user message
 * whose text is `"Slots:\n" + JSON.stringify(slots)` (compact since S5.1b),
 * optionally followed by a re-ask paragraph after a blank line. The JSON
 * itself never contains a newline, so splitting on the first blank line
 * isolates it safely. The slot's `timeOfDay` is its light phrase
 * (`phoneLook.ts`'s `lightOf`), not the stored time.
 */
function writerSlotsOf(body: unknown): z.infer<typeof WriterRequestSlot>[] {
  const parsed = WriterChatBody.parse(body);
  const user = parsed.messages.find((m) => m.role === "user");
  if (user === undefined) throw new Error("the scene writer request has no user message");
  const json = (user.content.split("\n\n")[0] ?? "").replace(/^Slots:\n/, "");
  return z.array(WriterRequestSlot).parse(JSON.parse(json));
}

/** An own scene as the idea writer is asked about it (CS.4b): its number and the owner's idea, in any script. */
const IdeaRequestSlot = z.object({ slotIndex: z.number().int(), idea: z.string(), shot: z.string().optional(), pose: z.string().optional() }).loose();

/**
 * The own scenes an idea write asked for, read back out of `scenes/ideaWriter.ts`'s request shape (`ideaMessages`): a user message that begins `"Ideas:\n"`
 * and then the same indented JSON, optionally followed by a re-ask paragraph. Null for a request that is not an idea write's (a compose or a rewrite of a planned
 * scene sends `"Slots:\n"`).
 */
function ideaSlotsOf(body: unknown): z.infer<typeof IdeaRequestSlot>[] | null {
  const parsed = WriterChatBody.parse(body);
  const user = parsed.messages.find((m) => m.role === "user");
  if (user === undefined || !user.content.startsWith("Ideas:\n")) return null;
  const json = (user.content.split("\n\n")[0] ?? "").replace(/^Ideas:\n/, "");
  return z.array(IdeaRequestSlot).parse(JSON.parse(json));
}

/**
 * CS.8a: the angle the mock picks for a slot that left it to the model («choose»), read from the idea's own words: «сзади» / «back» / «from behind» is a view from
 * behind, «профил» / «profile» a side view, anything else a front view. Never the mirror, and never a selfie turned away: a shot the owner chose is kept (left out of the
 * answer: the schema has no key for it) and a selfie or a mirror shot takes the front view whatever the idea says.
 */
function ideaAngleFor(slot: z.infer<typeof IdeaRequestSlot>): { shot?: string; pose?: string } {
  const idea = slot.idea.toLowerCase();
  const wanted = /сзади|\bback\b|from behind/.test(idea) ? "back" : /профил|profile/.test(idea) ? "profile" : "front";
  const phoneInHand = slot.shot === SHOT_LABEL.selfie || slot.shot === SHOT_LABEL.mirror;
  // The mirror, only for an idea that names one (the engine offers it then and not otherwise), facing the camera.
  const mirror = slot.shot === "choose" && ideaNamesMirror(slot.idea);
  const shot = mirror ? "mirror" : wanted === "front" ? "friend" : "candid";
  const pose = phoneInHand || mirror ? "front" : wanted;
  // The engine's schema has a key only for what is asked, and no null: a key the slot gave is left out.
  return { ...(slot.shot === "choose" ? { shot } : {}), ...(slot.pose === "choose" ? { pose } : {}) };
}

/** One compliant sentence per own scene: it names no hand, no camera and nothing the writer's rules refuse, and differs with the scene's number. */
function ideaSentenceFor(slot: z.infer<typeof IdeaRequestSlot>): string {
  return `She spends a quiet moment by a sunny window in the afternoon light, wearing a long cardigan, calm and unhurried (scene ${slot.slotIndex}).`;
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
  return `She spends a quiet moment at ${slot.location}, lit by ${slot.timeOfDay}, wearing ${slot.outfit}, calm and unhurried.`;
}

/**
 * A category's pool as the mock answers the "scene_pool" call (CS.2): five places, three outfits and a deck, in the shape the engine's own reader
 * accepts whole (poolGen.ts's `readPoolAnswer`; the mock's own test pins it). Every text is plain, short and free of the words the pool rules refuse.
 */
const DEFAULT_POOL_ANSWER = {
  label: "Mock theme",
  locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror: i === 2,
  })),
  outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
  shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
  // The strict schema requires the key: an empty list is «the description says nothing about the angle».
  poses: [] as string[],
};

/**
 * CS.8a: the pool the mock answers for a description that names a view from behind («сзади», «back view», «from behind») with the body position the paid canary's
 * description gave: every activity opens with it (within the 35 characters) and the angles are `["back"]`. Any other description gets `DEFAULT_POOL_ANSWER`.
 */
const BACK_VIEW_POOL_ANSWER = {
  ...DEFAULT_POOL_ANSWER,
  label: "Lying at home",
  locations: ["a sunny bedroom", "a living room rug", "a sofa by the window", "a quiet balcony mat", "a bedroom with a mirror"].map((name, i) => ({
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "lying on her stomach, texting", twoHanded: false },
      { text: "lying on her stomach, writing", twoHanded: true },
    ],
    mirror: i === 4,
  })),
  outfits: ["home shorts and a tank top", "a soft hoodie and shorts", "a cotton tee and joggers"],
  poses: ["back"],
};

/** The owner's description out of a pool request's user message (`poolGen.ts`'s `userPrompt`: `…data only): "<JSON text>"`), or "" when it is not there. */
function poolDescriptionOf(body: unknown): string {
  const user = WriterChatBody.safeParse(body);
  const text = user.success ? (user.data.messages.find((m) => m.role === "user")?.content ?? "") : "";
  const start = text.indexOf(': "');
  if (start < 0) return "";
  try {
    const parsed: unknown = JSON.parse(text.slice(start + 2).split("\n")[0] ?? "");
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return "";
  }
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
  /** The full request URL as it arrived, query string included. */
  url: string;
  /** Every request header (names in lower case), as sent. */
  headers: Record<string, string>;
  /** The body exactly as it was sent ("" for a GET), whether or not it parsed as JSON. */
  bodyText: string;
}

/**
 * Whether any of `words` is anywhere in the request, in any letter case: its
 * URL (query included), its headers or its body as sent — the same scan
 * engine.canary.test.ts's `carriesMarker` makes over a fake fetch's call, so
 * the packaged smoke is no weaker than the unit test. Finds the words only as
 * plain text; a leak that transforms them first (base64, a hash, a
 * paraphrase) is not caught here, as in the unit test.
 */
export function requestCarries(request: MockRequest, words: readonly string[]): boolean {
  return markerMatch(request, words) !== null;
}

/** What a check may say about a request's Authorization header: none sent, exactly `Bearer <expectedKey>`, or something else. Never the value. */
export function authorizationLabel(request: MockRequest, expectedKey: string): "none" | "expected" | "other" {
  if (request.authorization === null) return "none";
  return request.authorization === `Bearer ${expectedKey}` ? "expected" : "other";
}

/** The first of `words` (lower-cased, like the request) found in the request, and where: its URL, its headers or its body. Null when none. */
export function markerMatch(request: MockRequest, words: readonly string[]): { word: string; in: "url" | "headers" | "body" } | null {
  const parts = [
    ["url", request.url.toLowerCase()],
    ["headers", JSON.stringify(request.headers).toLowerCase()],
    ["body", request.bodyText.toLowerCase()],
  ] as const;
  for (const word of words.map((w) => w.toLowerCase()).filter((w) => w.length > 0)) {
    for (const [where, text] of parts) if (text.includes(word)) return { word, in: where };
  }
  return null;
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
  costsUsd?: { descriptor?: number; image?: number; age?: number; importDescribe?: number; writer?: number; pool?: number };
  /** CS.2: fields that replace those of the default pool the mock answers for the "scene_pool" schema (a category's pool call), e.g. `{ label: "Seine bakeries" }`. */
  poolAnswer?: Record<string, unknown>;
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
  /**
   * S4.E2E: how many different pictures the distinct pool holds (default 48). The pool is served round-robin, so a mock that answers more image requests than this
   * repeats a picture, and the near-duplicate gate would retry the repeat. A launch scenario sizes it above everything it asks for.
   */
  poolSize?: number;
  /**
   * T7b: serves a real fixture face (studio/engine/face/fixtures) instead of
   * the faceless mandelbrot portrait — the only way a run with the face gate
   * on can pass a front/three-quarter slot at all. The avatar's master and
   * candidate portraits become the fixture face directly; with
   * `distinctImages` also on, the run's own pool composites that SAME face
   * onto each PDQ-distinct background (`facePool.ts`) instead of serving the
   * bare pattern. Real JPEG bytes (L9), correctly labelled `image/jpeg` —
   * not the PNG every other scenario serves. Off by default: every scenario
   * that never turns the face gate on (avatar creation, import, T6's own
   * kill-and-resume proof) has no need for it, and the bare
   * mandelbrot/pattern stays cheaper to render.
   */
  faceFixture?: boolean;
  /**
   * L9: only with `faceFixture` and `distinctImages` both on — pool index
   * `faceMismatchAt` serves a genuine "no face detected" image instead of
   * the matching face (`facePool.ts`'s `facePoolNoFacePng`), so exactly one
   * served image is a real, provable clear-failure: whichever slot's
   * attempt draws it must retry, and a later attempt (a different pool
   * index, the matching face again) must pass. The index is shared with
   * EVERY `/images` call this mock answers, including an avatar's own
   * candidate-portrait generation before any run starts (`buildFacePool`'s
   * own comment has the full "why" — a first version hard-coded index 0 and
   * broke a real E2E run by making the run's own MASTER faceless instead).
   * `undefined` (the default) — most scenarios want every attempt to pass
   * first try.
   */
  faceMismatchAt?: number;
}

export interface ImageHold {
  /** How many image requests came while this hold was set. */
  arrived(): number;
  /** Answers every request held and lets later ones through. */
  release(): void;
}

/** How many different pictures the distinct pool holds before the first one is served again. */
const DEFAULT_POOL_SIZE = 48;

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
  /** CS.2: a custom category's pool calls ("scene_pool" schema). */
  poolRequests(): MockRequest[];
  priceRequests(): MockRequest[];
  creditsRequests(): MockRequest[];
  /** The running total this mock has billed, in USD — what /credits reports. */
  totalUsageUsd(): number;
  /**
   * S4.E2E: from now on an image request is recorded when it arrives and left unanswered (so it is genuinely in flight, however slow the runner) until the returned hold
   * is released; a request that arrives after the release is answered at once. `arrived()` counts the requests that came while held. A new hold releases the old one.
   */
  holdImages(): ImageHold;
  stop(): Promise<void>;
}

/** A request body as the mock read it: the text as sent, and its JSON when it parsed. */
interface SentBody {
  json: unknown;
  text: string;
}

const NO_BODY: SentBody = { json: null, text: "" };

export async function startMockOpenRouter(opts: MockOpenRouterOptions): Promise<MockOpenRouter> {
  const imageModel = opts.imageModel ?? DEFAULT_IMAGE_MODEL;
  const costs = { descriptor: 0.0021, image: 0.04, age: 0.0014, importDescribe: 0.0021, writer: 0.011, pool: 0.0051, ...opts.costsUsd };
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
  const poolSize = opts.poolSize ?? DEFAULT_POOL_SIZE;
  const distinctPool = opts.distinctImages ? (opts.faceFixture ? buildFacePool(poolSize, opts.faceMismatchAt ?? null) : buildDistinctPool(poolSize)) : [];
  // S4.E2E: while a hold is set, an image request is recorded on arrival and answered only when the hold is released.
  let imageHold: { promise: Promise<void>; release: () => void; arrived: number } | null = null;

  // Reused verbatim: the exact bodies studio/engine/money/prices.test.ts
  // already proved the real client parses, so the mock's prices are exactly
  // the fallback table's (studio/engine/money/prices.ts's FALLBACK_IMAGE /
  // FALLBACK_CHAT), and every cost in this file matches it.
  const endpointsFixture = readFileSync(join(FIXTURES, "endpoints-grok-imagine-image-2.0.json"), "utf8");
  const modelsFixture = readFileSync(join(FIXTURES, "models-chat.json"), "utf8");

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function record(req: Request, path: string, sent: SentBody): MockRequest {
    const entry: MockRequest = {
      method: req.method,
      path,
      body: sent.json,
      schemaName: schemaNameOf(sent.json),
      authorization: req.headers.get("authorization"),
      url: req.url,
      headers: Object.fromEntries(req.headers.entries()),
      bodyText: sent.text,
    };
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

  /** The body as text, and parsed when it is JSON (null when it is not). */
  async function bodyOf(req: Request): Promise<SentBody> {
    const text = await req.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { json, text };
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
        record(req, path, NO_BODY);
        return new Response(endpointsFixture, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && path === "/api/v1/models") {
        record(req, path, NO_BODY);
        return new Response(modelsFixture, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && path === "/api/v1/credits") {
        record(req, path, NO_BODY);
        return json({ data: { total_usage: totalUsageUsd } });
      }
      if (method === "POST" && path === "/api/v1/chat/completions") {
        const entry = record(req, path, await bodyOf(req));
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
        if (entry.schemaName === WRITER_JSON_SCHEMA.name || entry.schemaName === IDEA_JSON_SCHEMA.name) {
          if (writerDelayMs > 0) await Bun.sleep(writerDelayMs);
          const ideas = ideaSlotsOf(entry.body);
          const answer =
            ideas !== null
              ? { scenes: ideas.map((s) => ({ slotIndex: s.slotIndex, sentence: ideaSentenceFor(s), ...ideaAngleFor(s) })) }
              : { scenes: writerSlotsOf(entry.body).map((s) => ({ slotIndex: s.slotIndex, sentence: writerSentenceFor(s) })) };
          return json(chatCompletion(JSON.stringify(answer), costs.writer));
        }
        if (entry.schemaName === POOL_JSON_SCHEMA.name) {
          const basePool = /сзади|back view|from behind/i.test(poolDescriptionOf(entry.body)) ? BACK_VIEW_POOL_ANSWER : DEFAULT_POOL_ANSWER;
          return json(chatCompletion(JSON.stringify({ ...basePool, ...opts.poolAnswer }), costs.pool));
        }
        return loudly404(entry);
      }
      if (method === "POST" && path === "/api/v1/images") {
        record(req, path, await bodyOf(req));
        const held = imageHold;
        if (held !== null) {
          held.arrived++;
          await held.promise;
        }
        if (imageDelayMs > 0) await Bun.sleep(imageDelayMs);
        totalUsageUsd += costs.image;
        const fallback = opts.faceFixture ? faceFixtureBytes() : portraitPng();
        const bytes = distinctPool.length > 0 ? (distinctPool[imageCount++ % distinctPool.length] ?? fallback) : fallback;
        // L9: the media type must describe the actual bytes — faceFixture mode
        // serves real JPEG (faceFixtureBytes()/buildFacePool(), both JPEG-encoded
        // now), every other mode the rendered PNG it always was.
        const mediaType = opts.faceFixture ? "image/jpeg" : "image/png";
        return json({ created: 1_790_000_000, data: [{ b64_json: b64(bytes), media_type: mediaType }], usage: { cost: costs.image } });
      }
      return loudly404(record(req, path, method === "POST" ? await bodyOf(req) : NO_BODY));
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
    sceneWriterRequests: () => requests.filter((r) => r.schemaName === WRITER_JSON_SCHEMA.name || r.schemaName === IDEA_JSON_SCHEMA.name),
    poolRequests: () => requests.filter((r) => r.schemaName === POOL_JSON_SCHEMA.name),
    priceRequests: () => requests.filter((r) => r.path.endsWith("/endpoints") || r.path === "/api/v1/models"),
    creditsRequests: () => requests.filter((r) => r.path === "/api/v1/credits"),
    totalUsageUsd: () => totalUsageUsd,
    holdImages: () => {
      imageHold?.release();
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hold = { promise, release, arrived: 0 };
      imageHold = hold;
      return {
        arrived: () => hold.arrived,
        release: () => {
          if (imageHold === hold) imageHold = null;
          hold.release();
        },
      };
    },
    stop: async () => {
      imageHold?.release();
      server.stop(true);
    },
  };
}
