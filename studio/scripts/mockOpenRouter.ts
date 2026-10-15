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
 *   "scene_sentences"; a custom category's pool, schema "scene_pool"; S5.0c's
 *   descriptor-vs-master check, schema "descriptor_check"; with the `motions`
 *   option, 5b.2's vision motion writer, schema "motion_suggestions", and
 *   idea translator, schema "motion_idea")
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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { VIDEO_TIERS } from "../engine/money/prices";
import { FALLBACK_IMAGE_MODEL } from "../engine/runs/plan";
import { WRITER_JSON_SCHEMA } from "../engine/scenes";
import { ideaNamesMirror } from "../shared/engine";
import { DESCRIPTOR_CHECK_JSON_SCHEMA } from "../engine/avatars/descriptorCheck";
import { TRANSLATOR_JSON_SCHEMA } from "../engine/clips/ideaTranslator";
import { WRITER_JSON_SCHEMA as MOTION_WRITER_JSON_SCHEMA } from "../engine/clips/motionWriter";
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
 * A deliberate "no face detected" image is not part of the pool: `armFaceMismatch` serves one by prompt, so it lands on a chosen slot.
 */
function buildFacePool(size: number): Uint8Array[] {
  return Array.from({ length: size }, (_, i) => facePoolImagePng(i, FACE_FIXTURE_PATH, "jpeg"));
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
  locations: ["a sunny bedroom", "a living room rug", "a sofa by the window", "a quiet balcony mat", "a bedroom corner"].map((name, i) => ({
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "lying on her stomach, texting", twoHanded: false },
      { text: "lying on her stomach, writing", twoHanded: true },
      { text: "lying on her stomach, sipping tea", twoHanded: false },
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

/** A vision check's user message: plain text or a list of parts, of which the text ones are read. */
const CheckChatBody = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose())]) }).loose()),
});

/**
 * S5.0c: the check's answer when every aspect agrees: "ok" for hair, eyes and marks (and for the body when a body phrase was sent, S5.2b), and the quoted description (`descriptorCheck.ts`'s user message line
 * `Description: "<JSON text>"`) back character for character. The engine's reader then finds a match and no proposal.
 */
function descriptorCheckAnswerFor(body: unknown): { aspects: Record<"hair" | "eyes" | "marks" | "body", { state: string; descriptor: string; photo: string }>; descriptor: string } {
  const verdict = { state: "ok", descriptor: "", photo: "" };
  const parsed = CheckChatBody.safeParse(body);
  const user = parsed.success ? parsed.data.messages.find((m) => m.role === "user")?.content : undefined;
  const text = typeof user === "string" ? user : (user ?? []).map((part) => part.text ?? "").join("\n");
  const line = text.split("\n").find((l) => l.startsWith("Description: "));
  let descriptor = "";
  try {
    const quoted: unknown = line === undefined ? "" : JSON.parse(line.slice("Description: ".length));
    descriptor = typeof quoted === "string" ? quoted : "";
  } catch {
    descriptor = "";
  }
  // S5.2b: her body is judged only when the request carries her body phrase; otherwise the photo "does not show" it.
  const bodyVerdict = text.split("\n").some((l) => l.startsWith("Body phrase: ")) ? verdict : { ...verdict, state: "not-visible" };
  return { aspects: { hair: verdict, eyes: verdict, marks: verdict, body: bodyVerdict }, descriptor };
}

const SchemaProperties = z.object({ response_format: z.object({ json_schema: z.object({ schema: z.object({ properties: z.record(z.string(), z.unknown()) }).loose() }).loose() }).loose() }).loose();

/**
 * S5.2b review M1: whether the describe request's schema asks for the body. The attempt after an unusable answer sends the schema without the eight body keys (no `bodyMarks`); a schema
 * with no property list at all (a bare probe) is answered as a full one.
 */
function schemaAsksBody(body: unknown): boolean {
  const parsed = SchemaProperties.safeParse(body);
  return !parsed.success || "bodyMarks" in parsed.data.response_format.json_schema.schema.properties;
}

/** The describe answer for a request: the whole one, or without the body keys when the request's schema has none. */
function importDescribeAnswerFor(answer: MockImportDescribeAnswer, body: unknown): Record<string, unknown> {
  if (schemaAsksBody(body)) return { ...answer };
  const { height: _h, bust: _b, figure: _f, legLength: _ll, legShape: _ls, bottomSize: _bs, bottomShape: _bh, bodyMarks: _m, ...withoutBody } = answer;
  return withoutBody;
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
  /** 5a.3 (S5.9f): the `model` the body names, or null when it names none. */
  model: string | null;
  /** 5a.3 (S5.9f): the `resolution` the body names ("1K" or "2K" for an image request), or null when it names none. */
  resolution: string | null;
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
  /** Stage 5, S5.2b: the eight body keys, each a choice or "unknown" (the photo does not clearly show it); `bodyMarks` a list, empty when none show. */
  height: string;
  bust: string;
  figure: string;
  legLength: string;
  legShape: string;
  bottomSize: string;
  bottomShape: string;
  bodyMarks: string[];
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
  // A face-only photo shows no body: every key unknown, so the import stores no proposal. A scenario scripts a body by spreading over these.
  height: "unknown",
  bust: "unknown",
  figure: "unknown",
  legLength: "unknown",
  legShape: "unknown",
  bottomSize: "unknown",
  bottomShape: "unknown",
  bodyMarks: [],
  descriptor: "27-year-old Latina woman, tan skin, brown eyes, long wavy black hair, athletic build.",
};

/** 5b.2 (S5.WC4): the three small motions the mock's vision writer suggests, and the English text its translator answers (each passes the engine's motion check on an ordinary frame). */
export const DEFAULT_MOTION_SUGGESTIONS: readonly string[] = [
  "she slowly tucks a strand of hair behind her ear",
  "she tilts her head a little to one side and smiles",
  "she slowly takes a breath and relaxes her shoulders",
];
export const DEFAULT_MOTION_TRANSLATION = "she tilts her head a little to one side and smiles";

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
  costsUsd?: { descriptor?: number; image?: number; age?: number; importDescribe?: number; descriptorCheck?: number; writer?: number; pool?: number; boldImage?: number; motionSuggest?: number; motionIdea?: number };
  /** CS.2: fields that replace those of the default pool the mock answers for the "scene_pool" schema (a category's pool call), e.g. `{ label: "Seine bakeries" }`. */
  poolAnswer?: Record<string, unknown>;
  /**
   * Stage 5 (5b.2, S5.WC4): serves the chat route of part C «свои движения»: the vision writer ("motion_suggestions": `suggestions`, labelled «Движение n», and a frame reading of nothing special) and the idea
   * translator ("motion_idea": `translation`), each billed once at `costsUsd.motionSuggest` / `motionIdea`. Without this option both are unexpected requests.
   */
  motions?: boolean | { suggestions?: readonly string[]; translation?: string };
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
   * Stage 5 (5b.1, S5.V7): serves the video routes a clip uses (`GET /videos/models`, `POST /videos`, `GET /videos/<id>`, `GET /videos/<id>/content`, `GET /generation`), by the way the provider answered
   * the probes: one job per POST; a job completes on its first poll after `completeAfterMs` (default 0) and books its bill once, then; a job armed to be refused (`armVideoRefusal`) fails with
   * Kling's risk-control text, books nothing and never gets a `/generation` record (the API's exact 404, probe P0); a completed job's record appears `generationAfterMs` after it completed (default
   * 15 s, probe P-V). The poll carries `usage.cost` unless `usageOnPoll` is false, which makes the engine read `/generation` for the bill. The file is one real 720 x 1280 H.264 clip of 5 s made once
   * by the bundled ffmpeg, whatever length was asked: the smoke asks for 5 s. Without this option every video route is an unexpected request.
   */
  clips?: boolean | {
    completeAfterMs?: number;
    generationAfterMs?: number;
    usageOnPoll?: boolean;
    /** The clock the jobs' timers read (default `Date.now`): a test moves it by hand, so a pause on a busy runner cannot flip a state it asserts. */
    clock?: () => number;
  };
}

/** A `POST /videos` the mock answered: the job it made and what the request asked for. */
export interface MockVideoRequest {
  id: string;
  model: string | null;
  seconds: number | null;
  resolution: string | null;
}

/** Every call of the video routes, in order: which route, which job (null for the listing), and the status the mock answered. */
export interface MockVideoCall {
  kind: "listing" | "submit" | "poll" | "content" | "generation";
  jobId: string | null;
  status: number;
}

export interface ImageHold {
  /** How many image requests came while this hold was set. */
  arrived(): number;
  /** Answers every request held and lets later ones through. */
  release(): void;
}

/** How many different pictures the distinct pool holds before the first one is served again. */
const DEFAULT_POOL_SIZE = 48;

// ---------- video clips (5b.1, S5.V7) ----------

/** How long after a video completes its `/generation` record appears (probe P-V: about 15 s; a 404 sooner is a billed job whose record is not there yet). */
const CLIP_RECORD_DELAY_MS = 15_000;

/** Kling's own wording for a refusal at the poll (probe P0). */
const KLING_RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";

/** One job the mock made for a `POST /videos`. */
interface MockVideoJob {
  id: string;
  model: string | null;
  seconds: number;
  createdAt: number;
  /** Armed to be refused by the provider's risk control when polled. */
  refused: boolean;
  /** When the first poll reported it completed; null until then. */
  completedAt: number | null;
}

/** What a completed job bills, in USD: the listing's figures (Kling 0.084 and 0.112 $/s, Grok 0.14 $/s and 0.01 per input image). */
function videoBillUsd(job: Pick<MockVideoJob, "model" | "seconds">): number {
  const perSecond = job.model === VIDEO_TIERS.pro.model ? 0.112 : job.model === VIDEO_TIERS.grok.model ? 0.14 : 0.084;
  const image = job.model === VIDEO_TIERS.grok.model ? 0.01 : 0;
  // Whole micro-dollars, as the engine's prices are.
  return Math.round((job.seconds * perSecond + image) * 1_000_000) / 1_000_000;
}

let clipMp4Cache: Uint8Array<ArrayBuffer> | null = null;

/** One real clip, made once by the bundled ffmpeg: 720 x 1280 H.264, 5 s, the layout providers' files have. Never a committed binary. */
function clipMp4(): Uint8Array<ArrayBuffer> {
  if (clipMp4Cache !== null) return clipMp4Cache;
  const folder = mkdtempSync(join(tmpdir(), "studio-mock-clip-"));
  try {
    const out = join(folder, "clip.mp4");
    const r = spawnSync(
      ffmpegPath(),
      [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=720x1280:r=24:d=5,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,0.25)'",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
      ],
      { timeout: 60_000 },
    );
    if (r.status !== 0) throw new Error(`the mock OpenRouter could not make a clip with ffmpeg: ${r.stderr.toString()}`);
    clipMp4Cache = new Uint8Array(readFileSync(out));
    return clipMp4Cache;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export interface MockOpenRouter {
  /** Pass as --studio-openrouter-base-url. */
  url: string;
  /** Every request this mock answered, in arrival order. */
  requests: MockRequest[];
  /** Any request outside the six routes above — a run with one of these must fail. */
  unexpected: MockRequest[];
  imageRequests(): MockRequest[];
  /** 5a.3 (S5.9f): the image requests whose body names `model`. */
  imageRequestsFor(model: string): MockRequest[];
  /**
   * 5a.3 (S5.9f): the next `times` (default 1) image requests that name `model` are refused with the model's moderation 400 — free, so nothing is booked against /credits. A request for any
   * other model is answered as before. The packaged smoke arms it for the Seedream model to end a «Смелая» slot `model-refused`.
   */
  armRefusal(model: string, times?: number): void;
  /**
   * 5a.3 (S5.9f): the next `times` (default 1) image requests that name `model` get a 2xx with no image and a bill (booked against /credits): the slot ends `model-empty`. An armed
   * refusal is met first.
   */
  armEmptyAnswer(model: string, times?: number): void;
  ageCheckRequests(): MockRequest[];
  descriptorRequests(): MockRequest[];
  /** T6c: the vision describe call's own requests ("import_describe" schema), distinct from a plain new-avatar descriptor. */
  importDescribeRequests(): MockRequest[];
  /** S5.0c: the descriptor-vs-master check's own requests ("descriptor_check" schema). */
  descriptorCheckRequests(): MockRequest[];
  /** T6: the scene writer's own requests ("scene_sentences" schema). */
  sceneWriterRequests(): MockRequest[];
  /** CS.2: a custom category's pool calls ("scene_pool" schema). */
  poolRequests(): MockRequest[];
  /** 5b.2 (S5.WC4): the part C chat requests: the vision writer's ("motion_suggestions") and the idea translator's ("motion_idea"). */
  motionRequests(): MockRequest[];
  priceRequests(): MockRequest[];
  creditsRequests(): MockRequest[];
  /** The running total this mock has billed, in USD — what /credits reports. */
  totalUsageUsd(): number;
  /**
   * S4.E2E: from now on an image request is recorded when it arrives and left unanswered (so it is genuinely in flight, however slow the runner) until the returned hold
   * is released; a request that arrives after the release is answered at once. `arrived()` counts the requests that came while held. A new hold releases the old one.
   */
  holdImages(): ImageHold;
  /**
   * Only with `faceFixture` and `distinctImages`: the next image request whose `prompt` is exactly `prompt` is answered with a genuine "no face detected" image
   * (once; the slot's retry gets a matching face again). Chosen by prompt, not by arrival order, so a scenario can aim the mismatch at a slot whose face shows
   * (a faceless image on a face-hidden frame is only marked, never retried) once it has read the run's plan. The render is paid here, not inside a request.
   */
  armFaceMismatch(prompt: string): void;
  /** 5b.1: the `POST /videos` requests the mock answered (a job each), in order. Needs the `clips` option. */
  videoRequests(): MockVideoRequest[];
  /** 5b.1: every call of the video routes, in order, with the status the mock answered. */
  videoCalls(): MockVideoCall[];
  /**
   * 5b.1: the next `times` (default 1) jobs POSTed for `model` are refused by the provider's risk control when polled: `failed` with Kling's own text, nothing billed, no `/generation` record. A job
   * for any other model completes as before.
   */
  armVideoRefusal(model: string, times?: number): void;
  stop(): Promise<void>;
}

/** A request body as the mock read it: the text as sent, and its JSON when it parsed. */
interface SentBody {
  json: unknown;
  text: string;
}

const NO_BODY: SentBody = { json: null, text: "" };

/** A string field of a request body, or null when the body is not an object or the field is not a string. */
function stringField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value: unknown = Reflect.get(body, key);
  return typeof value === "string" ? value : null;
}

/** The `prompt` of an image request body, or null when it has none. */
function promptOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const prompt: unknown = Reflect.get(body, "prompt");
  return typeof prompt === "string" ? prompt : null;
}

/**
 * What each call bills, in USD, unless a scenario says otherwise. `boldImage` is what a 2K Seedream image bills: P-5a3 measured $0.045 against a list price of $0.09 (plan s5a3 §«P-5a3 results»).
 * The smoke's own bill sum (`boldSmoke.ts`) reads the two image figures from here.
 */
export const DEFAULT_COSTS_USD = { descriptor: 0.0021, image: 0.04, age: 0.0014, importDescribe: 0.0021, descriptorCheck: 0.0023, writer: 0.011, pool: 0.0051, boldImage: 0.045, motionSuggest: 0.0034, motionIdea: 0.001 };

export async function startMockOpenRouter(opts: MockOpenRouterOptions): Promise<MockOpenRouter> {
  const imageModel = opts.imageModel ?? DEFAULT_IMAGE_MODEL;
  const costs = { ...DEFAULT_COSTS_USD, ...opts.costsUsd };
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
  const distinctPool = opts.distinctImages ? (opts.faceFixture ? buildFacePool(poolSize) : buildDistinctPool(poolSize)) : [];
  // S4.E2E: while a hold is set, an image request is recorded on arrival and answered only when the hold is released.
  let armedMismatch: { prompt: string; bytes: Uint8Array } | null = null;
  let imageHold: { promise: Promise<void>; release: () => void; arrived: number } | null = null;
  // Stage 5 (5b.1, S5.V7): the video routes, when the scenario asks for them.
  const clipOptions = opts.clips === undefined || opts.clips === false ? null : opts.clips === true ? {} : opts.clips;
  const completeAfterMs = clipOptions?.completeAfterMs ?? 0;
  const generationAfterMs = clipOptions?.generationAfterMs ?? CLIP_RECORD_DELAY_MS;
  const clipNow = clipOptions?.clock ?? Date.now;
  const usageOnPoll = clipOptions?.usageOnPoll ?? true;
  const clipFile = clipOptions === null ? null : clipMp4();
  // Stage 5 (5b.2, S5.WC4): the chat route of part C, when the scenario asks for it.
  const motionOptions = opts.motions === undefined || opts.motions === false ? null : opts.motions === true ? {} : opts.motions;
  const motionSuggestions = motionOptions?.suggestions ?? DEFAULT_MOTION_SUGGESTIONS;
  const motionTranslation = motionOptions?.translation ?? DEFAULT_MOTION_TRANSLATION;
  const videoJobs = new Map<string, MockVideoJob>();
  const videoRequests: MockVideoRequest[] = [];
  const videoCalls: MockVideoCall[] = [];
  const videoRefusals = new Map<string, number>();

  // Reused verbatim: the exact bodies studio/engine/money/prices.test.ts
  // already proved the real client parses, so the mock's prices are exactly
  // the fallback table's (studio/engine/money/prices.ts's FALLBACK_IMAGE /
  // FALLBACK_CHAT), and every cost in this file matches it.
  const endpointsFixture = readFileSync(join(FIXTURES, "endpoints-grok-imagine-image-2.0.json"), "utf8");
  const modelsFixture = readFileSync(join(FIXTURES, "models-chat.json"), "utf8");
  // 5a.3 (S5.9f): the Seedream endpoint lists the 2K tier (`high_resolution`) and the reference image, which the «Смелая» route's price and acceptance read.
  const seedreamFixture = readFileSync(join(FIXTURES, "endpoints-seedream-5-0-pro.json"), "utf8");
  // 5b.1 (S5.V7): the 2026-10-10 video listing, the very fixture the engine's price parser is tested on.
  const videoListing = readFileSync(join(FIXTURES, "videos-models-2026-10-10.json"), "utf8");
  // 5a.3 (S5.9f): requests for a model that the scenario armed to refuse, or to answer with no image, and how many each still meets.
  const refusals = new Map<string, number>();
  const empties = new Map<string, number>();
  /** Spends one armed end of `model`, if it has any left. */
  function takeArmed(armed: Map<string, number>, model: string | null): boolean {
    const left = model === null ? 0 : (armed.get(model) ?? 0);
    if (model === null || left === 0) return false;
    armed.set(model, left - 1);
    return true;
  }

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
      model: stringField(sent.json, "model"),
      resolution: stringField(sent.json, "resolution"),
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
        // `runPriceModels`), so both endpoints must answer. The Seedream one
        // serves its own fixture since 5a.3 (S5.9f): the «Смелая» route is priced
        // at 2K and accepted only when the endpoint lists that tier and the
        // reference image; the owner's model keeps the Grok fixture.
        record(req, path, NO_BODY);
        const body = path === `/api/v1/images/models/${FALLBACK_IMAGE_MODEL}/endpoints` ? seedreamFixture : endpointsFixture;
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
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
          return json(chatCompletion(JSON.stringify(importDescribeAnswerFor(answer, entry.body)), costs.importDescribe));
        }
        if (entry.schemaName === DESCRIPTOR_CHECK_JSON_SCHEMA.name) {
          return json(chatCompletion(JSON.stringify(descriptorCheckAnswerFor(entry.body)), costs.descriptorCheck));
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
        // 5b.2 (S5.WC4): part C. The vision writer looks at one photo and suggests small motions (strict JSON: motions with a Russian label and an English text, and a frame reading); the translator says the owner's idea as one English motion.
        if (motionOptions !== null && entry.schemaName === MOTION_WRITER_JSON_SCHEMA.name) {
          const answer = {
            motions: motionSuggestions.map((text, i) => ({ label_ru: `Движение ${i + 1}`, text_en: text })),
            frame: { capture: "unknown", phoneVisible: false, faceVisible: true },
          };
          return json(chatCompletion(JSON.stringify(answer), costs.motionSuggest));
        }
        if (motionOptions !== null && entry.schemaName === TRANSLATOR_JSON_SCHEMA.name) {
          return json(chatCompletion(JSON.stringify({ text_en: motionTranslation }), costs.motionIdea));
        }
        if (entry.schemaName === POOL_JSON_SCHEMA.name) {
          const basePool = /сзади|back view|from behind/i.test(poolDescriptionOf(entry.body)) ? BACK_VIEW_POOL_ANSWER : DEFAULT_POOL_ANSWER;
          return json(chatCompletion(JSON.stringify({ ...basePool, ...opts.poolAnswer }), costs.pool));
        }
        return loudly404(entry);
      }
      if (method === "POST" && path === "/api/v1/images") {
        const imageEntry = record(req, path, await bodyOf(req));
        const held = imageHold;
        if (held !== null) {
          held.arrived++;
          await held.promise;
        }
        if (imageDelayMs > 0) await Bun.sleep(imageDelayMs);
        // 5a.3 (S5.9f): a scenario armed this model to refuse (the model's free, final 400) or to answer with no image (a 2xx, still billed).
        if (takeArmed(refusals, imageEntry.model)) {
          const label = imageEntry.model?.startsWith("bytedance-seed/") === true ? "Seedream" : "xAI";
          return json({ error: { message: `${label} blocked this request through content moderation.` } }, 400);
        }
        const cost = imageEntry.resolution === "2K" ? costs.boldImage : costs.image;
        if (takeArmed(empties, imageEntry.model)) {
          totalUsageUsd += cost;
          return json({ created: 1_790_000_000, data: [], usage: { cost } });
        }
        totalUsageUsd += cost;
        const fallback = opts.faceFixture ? faceFixtureBytes() : portraitPng();
        const armed = armedMismatch;
        const mismatched = armed !== null && promptOf(imageEntry.body) === armed.prompt;
        if (mismatched) armedMismatch = null;
        // The faceless image takes no pool slot: every other request is served exactly as it would be without it.
        const bytes = mismatched ? armed.bytes : distinctPool.length > 0 ? (distinctPool[imageCount++ % distinctPool.length] ?? fallback) : fallback;
        // L9: the media type must describe the actual bytes — faceFixture mode
        // serves real JPEG (faceFixtureBytes()/buildFacePool(), both JPEG-encoded
        // now), every other mode the rendered PNG it always was.
        const mediaType = opts.faceFixture ? "image/jpeg" : "image/png";
        return json({ created: 1_790_000_000, data: [{ b64_json: b64(bytes), media_type: mediaType }], usage: { cost } });
      }
      if (clipOptions !== null && clipFile !== null) {
        const answer = await videoRoute(req, path);
        if (answer !== null) return answer;
      }
      return loudly404(record(req, path, method === "POST" ? await bodyOf(req) : NO_BODY));
    },
  });

  // ---------- the video routes (5b.1, S5.V7) ----------

  /** The route's answer, or null when the request is not a video route. Every answer is logged. */
  async function videoRoute(req: Request, path: string): Promise<Response | null> {
    const { method } = req;
    const answered = (kind: MockVideoCall["kind"], jobId: string | null, response: Response): Response => {
      videoCalls.push({ kind, jobId, status: response.status });
      return response;
    };
    if (method === "GET" && path === "/api/v1/videos/models") {
      record(req, path, NO_BODY);
      return answered("listing", null, new Response(videoListing, { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (method === "POST" && path === "/api/v1/videos") {
      const sent = await bodyOf(req);
      const entry = record(req, path, sent);
      const id = `smoke-vid-${videoRequests.length + 1}`;
      const seconds = typeof sent.json === "object" && sent.json !== null && typeof Reflect.get(sent.json, "duration") === "number" ? Number(Reflect.get(sent.json, "duration")) : null;
      videoRequests.push({ id, model: entry.model, seconds, resolution: entry.resolution });
      const refused = takeArmed(videoRefusals, entry.model);
      videoJobs.set(id, { id, model: entry.model, seconds: seconds ?? 5, createdAt: clipNow(), refused, completedAt: null });
      return answered("submit", id, json({ id, polling_url: `${mockBase()}/videos/${id}`, status: "pending" }, 202));
    }
    const content = /^\/api\/v1\/videos\/([^/]+)\/content$/.exec(path);
    if (method === "GET" && content !== null) {
      record(req, path, NO_BODY);
      const id = decodeURIComponent(content[1] ?? "");
      const job = videoJobs.get(id);
      if (job === undefined || job.completedAt === null || job.refused) return answered("content", id, json({ error: { code: 404, message: `Video ${id} not found` } }, 404));
      if (clipFile === null) return null;
      return answered("content", id, new Response(clipFile, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(clipFile.length) } }));
    }
    const poll = /^\/api\/v1\/videos\/([^/]+)$/.exec(path);
    if (method === "GET" && poll !== null) {
      record(req, path, NO_BODY);
      const id = decodeURIComponent(poll[1] ?? "");
      const job = videoJobs.get(id);
      if (job === undefined) return answered("poll", id, json({ error: { code: 404, message: `Video ${id} not found` } }, 404));
      if (job.completedAt === null && clipNow() - job.createdAt < completeAfterMs) return answered("poll", id, json({ id, generation_id: id, status: "in_progress" }));
      if (job.refused) return answered("poll", id, json({ id, generation_id: id, status: "failed", error: KLING_RISK_CONTROL }));
      if (job.completedAt === null) {
        // The bill is booked once, when the job completes (a refused job's charge was refunded within seconds in probe P0: net nothing).
        job.completedAt = clipNow();
        totalUsageUsd += videoBillUsd(job);
      }
      return answered("poll", id, json({ id, generation_id: id, status: "completed", ...(usageOnPoll ? { usage: { cost: videoBillUsd(job), is_byok: false } } : {}) }));
    }
    if (method === "GET" && path === "/api/v1/generation") {
      record(req, path, NO_BODY);
      const id = new URL(req.url).searchParams.get("id") ?? "";
      const job = videoJobs.get(id);
      if (job !== undefined && !job.refused && job.completedAt !== null && clipNow() - job.completedAt >= generationAfterMs) {
        return answered("generation", id, json({ data: { id, total_cost: videoBillUsd(job), finish_reason: "stop" } }));
      }
      // The API's own 404, in its exact words (engine/openrouter/generation.ts): a refused job never got a record, and a completed one has none yet.
      return answered("generation", id, json({ error: { code: 404, message: `Generation ${id} not found` } }, 404));
    }
    return null;
  }

  /** The mock's base URL, as the engine was given it. */
  function mockBase(): string {
    return `http://127.0.0.1:${server.port}/api/v1`;
  }

  return {
    url: `http://127.0.0.1:${server.port}/api/v1`,
    requests,
    unexpected,
    imageRequests: () => requests.filter((r) => r.path === "/api/v1/images"),
    imageRequestsFor: (model) => requests.filter((r) => r.path === "/api/v1/images" && r.model === model),
    armRefusal: (model, times = 1) => {
      refusals.set(model, (refusals.get(model) ?? 0) + times);
    },
    armEmptyAnswer: (model, times = 1) => {
      empties.set(model, (empties.get(model) ?? 0) + times);
    },
    ageCheckRequests: () => requests.filter((r) => r.schemaName === "age_check"),
    descriptorRequests: () => requests.filter((r) => r.schemaName === "avatar_descriptor"),
    importDescribeRequests: () => requests.filter((r) => r.schemaName === "import_describe"),
    descriptorCheckRequests: () => requests.filter((r) => r.schemaName === DESCRIPTOR_CHECK_JSON_SCHEMA.name),
    sceneWriterRequests: () => requests.filter((r) => r.schemaName === WRITER_JSON_SCHEMA.name || r.schemaName === IDEA_JSON_SCHEMA.name),
    poolRequests: () => requests.filter((r) => r.schemaName === POOL_JSON_SCHEMA.name),
    motionRequests: () => requests.filter((r) => r.schemaName === MOTION_WRITER_JSON_SCHEMA.name || r.schemaName === TRANSLATOR_JSON_SCHEMA.name),
    priceRequests: () => requests.filter((r) => r.path.endsWith("/endpoints") || r.path === "/api/v1/models"),
    creditsRequests: () => requests.filter((r) => r.path === "/api/v1/credits"),
    totalUsageUsd: () => totalUsageUsd,
    armFaceMismatch: (prompt) => {
      if (!opts.faceFixture || !opts.distinctImages) throw new Error("armFaceMismatch needs faceFixture and distinctImages");
      // One index past the pool: PDQ-distinct from every pooled image, and the pool's own order is left untouched.
      armedMismatch = { prompt, bytes: facePoolNoFacePng(poolSize, "jpeg") };
    },
    videoRequests: () => [...videoRequests],
    videoCalls: () => [...videoCalls],
    armVideoRefusal: (model, times = 1) => {
      videoRefusals.set(model, (videoRefusals.get(model) ?? 0) + times);
    },
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
