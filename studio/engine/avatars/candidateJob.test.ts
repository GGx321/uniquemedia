import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvatarDescriptor, EngineError } from "../../shared/engine";
import { downscaleToJpeg } from "../../node/downscale";
import { ffmpegPath } from "../../node/ffmpegBinary";
import type { NewPhotoMeta } from "../library";
import { imageSize } from "../library/media";
import type { LedgerDeps } from "../money/ledger";
import { PriceBook } from "../money/prices";
import { chatBody, fakeFetch, imageBody, JPEG, makeClient, setupMoney, type FetchCall, type Money, type Reply } from "../openrouter/testing/fakes";
import type { OpenRouterClientOptions } from "../openrouter/types";
import { AGE_CHECK_MAX_SIDE, AGE_QUESTION, AGE_SYSTEM, ageJsonSchema } from "./ageCheck";
import { candidateJobEnd, PREPARE_TIMEOUT_MS, runCandidateJob, type CandidateJob, type SlotOutcome } from "./candidateJob";
import { avatarJobEstimate } from "./plan";
import { candidatePrompt } from "./prompts";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The candidate job's slots against the real OpenRouter client (T3) over a
// fake fetch, a real ledger and Budget (T2) in a temp dir, and the bundled
// ffmpeg for the age check's downscale. The library is a recording fake here;
// the engine's tests store into a real one.

const JOB_ID = "job-00000001";
const SCOPE = { avatarJobId: JOB_ID };
const IMAGE_MODEL = "x-ai/grok-imagine-image-2.0";
const GOOD = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: GOOD };
const PROMPT = candidatePrompt(DESCRIPTOR);
/** Fallback prices: grok-imagine-image-2.0 low 1K; an age check on grok-4.3 at its ceilings (2.2K in with one image, 1K out). */
const IMAGE_WORST = 40_000;
const AGE_WORST = 5_250;
const BATCH_WORST = avatarJobEstimate({ book: PriceBook.fallback(), asOf: "2026-09-24" }, { imageModel: IMAGE_MODEL, textModel: "x-ai/grok-4.3" }, "next-batch", "on").worstMicros;
/** The batch's worst case with the image age check off (owner's decision, 2026-09-27): the 4 portraits alone, no age checks. */
const BATCH_WORST_OFF = avatarJobEstimate({ book: PriceBook.fallback(), asOf: "2026-09-24" }, { imageModel: IMAGE_MODEL, textModel: "x-ai/grok-4.3" }, "next-batch", "off").worstMicros;
const MODERATION: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };

let dir = "";
/** A real 1K 3:4 portrait-sized PNG. */
let PORTRAIT = new Uint8Array();
/** A real animated PNG of three frames. */
let ANIMATED = new Uint8Array();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-candidates-"));
  const path = join(dir, "portrait.png");
  const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "mandelbrot=size=864x1152", "-frames:v", "1", path]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render the portrait: ${r.stderr.toString()}`);
  PORTRAIT = new Uint8Array(readFileSync(path));
  const apng = join(dir, "animated.png");
  const a = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "mandelbrot=size=30x40:rate=5", "-frames:v", "3", "-plays", "0", "-f", "apng", apng]);
  if (a.status !== 0) throw new Error(`ffmpeg could not render the animation: ${a.stderr.toString()}`);
  ANIMATED = new Uint8Array(readFileSync(apng));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function portrait(bytes: Uint8Array = PORTRAIT): Reply {
  return { status: 200, body: imageBody(bytes, { cost: 0.04 }) };
}

function ageAnswer(adult: boolean, confidence: number): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ adult, confidence, reason: "Mature features of a woman in her mid-20s." }), { cost: 0.0014 }) };
}

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

/** A fake OpenRouter: image requests and age checks each take their handler, with their own call count. */
function network(opts: { image?: Handler; age?: Handler } = {}) {
  let images = 0;
  let ages = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return (opts.image ?? (() => portrait()))(call, ++images);
    if (call.url.endsWith("/chat/completions")) return (opts.age ?? (() => ageAnswer(true, 0.95)))(call, ++ages);
    throw new Error(`unexpected request to ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return {
    fetch: net.fetch,
    calls: net.calls,
    imageCalls: () => net.calls.filter((c) => c.url.endsWith("/images")),
    ageCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions")),
  };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney({ runCapMicros: BATCH_WORST });
});
afterEach(async () => {
  await money.cleanup();
});

interface Stored {
  bytes: Uint8Array;
  meta: NewPhotoMeta;
}

function run(
  net: ReturnType<typeof network>,
  job: Partial<CandidateJob> = {},
  seams: { downscale?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>; clientOverrides?: Partial<OpenRouterClientOptions> } = {},
) {
  const { client } = makeClient(net.fetch, seams.clientOverrides);
  const stored: Stored[] = [];
  const reported: SlotOutcome[] = [];
  const outcomes = runCandidateJob(
    {
      generateImage: (params) => client.generateImage(params),
      chat: (params) => client.chat(params),
      budget: money.budget,
      priceBook: money.priceBook,
      downscale: seams.downscale ?? ((bytes, signal) => downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal })),
      store: async (bytes, meta) => {
        stored.push({ bytes, meta });
        return { id: `photo-${String(stored.length).padStart(8, "0")}` };
      },
      errorOf: (error): EngineError => ({ code: "INTERNAL", detail: String(error) }),
      onSlot: (outcome) => reported.push(outcome),
    },
    { jobId: JOB_ID, scope: SCOPE, imageModel: IMAGE_MODEL, descriptor: DESCRIPTOR, concurrency: 4, signal: new AbortController().signal, imageAgeCheck: "on", ...job },
  );
  return { outcomes, stored, reported };
}

function passed(slot: number): SlotOutcome {
  return { slot, kind: "passed", photoId: `photo-${String(slot).padStart(8, "0")}` };
}

/** Slots in flight together finish, and are stored, in any order: every slot passed, each with a photo of its own. */
function expectAllPassed(outcomes: SlotOutcome[]): void {
  expect(outcomes.map((o) => [o.slot, o.kind])).toEqual([1, 2, 3, 4].map((slot) => [slot, "passed"]));
  expect(new Set(outcomes.map((o) => (o.kind === "passed" ? o.photoId : null))).size).toBe(4);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A disk whose every fsync takes `ms` longer, as on the Windows runners. */
function slowDisk(ms: number): LedgerDeps {
  return {
    openFile: async (path, flags) => {
      const handle = await open(path, flags);
      const sync = handle.sync.bind(handle);
      spyOn(handle, "sync").mockImplementation(async () => {
        await Bun.sleep(ms);
        return sync();
      });
      return handle;
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("timed out waiting for the condition");
}

describe("a batch of candidate portraits", () => {
  test("the image requests carry the job's own quality", async () => {
    const medium = network();
    await run(medium, { imageQuality: "medium" }).outcomes;
    // The test's cap is the batch's worst case at low, so the dearer medium slots may not all fit: what was sent is all medium.
    expect(medium.imageCalls().length).toBeGreaterThan(0);
    expect(new Set(medium.imageCalls().map((c) => c.json().quality))).toEqual(new Set(["medium"]));
  });

  test("the image requests carry no quality for a model with no quality knob", async () => {
    const none = network();
    await run(none, { imageQuality: null }).outcomes;
    expect(none.imageCalls().length).toBeGreaterThan(0);
    expect(new Set(none.imageCalls().map((c) => c.json().quality))).toEqual(new Set([undefined]));
  });

  test("four image attempts: 1K, 3:4, quality low, no reference, on the image model, with the candidate prompt", async () => {
    const net = network();

    expectAllPassed(await run(net).outcomes);
    expect(net.imageCalls().map((c) => c.json())).toEqual(
      Array.from({ length: 4 }, () => ({ model: IMAGE_MODEL, prompt: PROMPT, resolution: "1K", aspect_ratio: "3:4", quality: "low" })),
    );
  });

  test("every image and every age check is one attempt with its own id in the job's scope; their worst cases add up to the batch's", async () => {
    await run(network()).outcomes;

    const reserves = money.lines().filter((l) => l.type === "reserve");
    expect(reserves.map((r) => r.attemptId).sort()).toEqual(
      [1, 2, 3, 4].flatMap((n) => [`${JOB_ID}:candidate-${n}#1`, `${JOB_ID}:candidate-${n}:age#1`]).sort(),
    );
    for (const reserve of reserves) {
      const age = String(reserve.attemptId).endsWith(":age#1");
      expect(reserve).toMatchObject({ jobId: JOB_ID, scope: SCOPE, model: age ? "x-ai/grok-4.3" : IMAGE_MODEL, worstMicros: age ? AGE_WORST : IMAGE_WORST });
    }
    expect(reserves.reduce((sum, r) => sum + Number(r.worstMicros), 0)).toBe(BATCH_WORST);
    expect(BATCH_WORST).toBe(181_000);
    const settled = Object.fromEntries(money.lines().flatMap((l) => (l.type === "settle" ? [[l.attemptId, l.costMicros]] : [])));
    expect(settled).toEqual(Object.fromEntries([1, 2, 3, 4].flatMap((n) => [[`${JOB_ID}:candidate-${n}#1`, 40_000], [`${JOB_ID}:candidate-${n}:age#1`, 1_400]])));
  });

  test("an age check is held at exactly what its request then reserves", async () => {
    let held = -1;
    const net = network({
      image: (_call, n) => {
        // The image's own hold became its reserve before it was sent: what is held now is its age check.
        if (n === 1) held = money.budget.status().heldMicros;
        return portrait();
      },
    });
    await run(net, { concurrency: 1 }).outcomes;

    const reserve = money.lines().find((l) => l.type === "reserve" && l.attemptId === `${JOB_ID}:candidate-1:age#1`);
    expect(held).toBe(AGE_WORST);
    expect(reserve?.worstMicros).toBe(held);
  });

  test("the age check asks the question, after the line that says to ignore text in the image, about a JPEG of at most 768 px, on grok-4.3, as strict JSON", async () => {
    const net = network();
    await run(net).outcomes;

    // Every check, in whatever order the slots sent them.
    expect(net.ageCalls()).toHaveLength(4);
    for (const call of net.ageCalls()) {
      const body = call.json();
      expect(body).toMatchObject({
        model: "x-ai/grok-4.3",
        max_tokens: 1_000,
        reasoning: { effort: "low" },
        response_format: { type: "json_schema", json_schema: { name: "age_check", strict: true, schema: ageJsonSchema().schema } },
        messages: [
          { role: "system", content: AGE_SYSTEM },
          { role: "user", content: [{ type: "text", text: AGE_QUESTION }, { type: "image_url" }] },
        ],
      });
      const jpeg = /"url":"data:image\/jpeg;base64,([A-Za-z0-9+/=]+)"/.exec(JSON.stringify(body))?.[1] ?? "";
      expect(imageSize(new Uint8Array(Buffer.from(jpeg, "base64")))).toEqual({ width: 576, height: 768 });
    }
  });

  test("a candidate that passes is stored as received: its bytes, its size, where it came from and the verdict", async () => {
    const net = network({ age: () => ageAnswer(true, 0.9) });
    const { outcomes, stored } = run(net, { concurrency: 1 });

    expect(await outcomes).toEqual([1, 2, 3, 4].map(passed));
    expect(stored).toHaveLength(4);
    expect(stored[0]?.bytes).toEqual(PORTRAIT);
    expect(stored[0]?.meta).toEqual({
      mediaType: "image/png",
      width: 864,
      height: 1152,
      source: {
        kind: "generated",
        model: IMAGE_MODEL,
        provider: "openrouter",
        jobId: JOB_ID,
        attemptId: `${JOB_ID}:candidate-1#1`,
        promptSha: sha256(PROMPT),
        prompt: PROMPT,
        slot: "candidate-1",
        costMicros: 40_000,
      },
      qa: { age: { adult: true, confidence: 0.9 } },
    });
    expect(stored.map((s) => (s.meta.source.kind === "generated" ? s.meta.source.attemptId : null))).toEqual(
      [1, 2, 3, 4].map((n) => `${JOB_ID}:candidate-${n}#1`),
    );
  });

  test("reports each finished slot as it finishes", async () => {
    const { outcomes, reported } = run(network(), { concurrency: 1 });

    expect(reported).toEqual(await outcomes);
  });
});

// Owner's decision (2026-09-27): the paid image age check is optional, off by
// default. With the toggle off, candidateJob skips it entirely — no age-check
// holds, reserves or requests, and a candidate enters the library right after
// its image checks, with no qa.age verdict at all (ageCheck.test.ts's
// passesAgeThreshold and pick then treat it as pickable: the owner's own pick
// is the gate).
describe("the image age check off (owner's decision, 2026-09-27: off by default)", () => {
  beforeEach(async () => {
    await money.cleanup();
    money = await setupMoney({ runCapMicros: BATCH_WORST_OFF });
  });

  test("four image attempts, no age check requests at all", async () => {
    const net = network();

    expectAllPassed(await run(net, { imageAgeCheck: "off" }).outcomes);
    expect(net.imageCalls()).toHaveLength(4);
    expect(net.ageCalls()).toHaveLength(0);
  });

  test("only the image attempts are reserved: no :age#1 attempt id, and the worst cases add up to the batch's off-mode worst", async () => {
    await run(network(), { imageAgeCheck: "off" }).outcomes;

    const reserves = money.lines().filter((l) => l.type === "reserve");
    expect(reserves.map((r) => r.attemptId).sort()).toEqual([1, 2, 3, 4].map((n) => `${JOB_ID}:candidate-${n}#1`).sort());
    expect(reserves.every((r) => r.worstMicros === IMAGE_WORST)).toBe(true);
    expect(reserves.reduce((sum, r) => sum + Number(r.worstMicros), 0)).toBe(BATCH_WORST_OFF);
    expect(BATCH_WORST_OFF).toBe(160_000);
  });

  test("never downscales and never calls chat: nothing is prepared or asked for an age check that will not run", async () => {
    let downscaleCalls = 0;
    const net = network();
    await run(net, { imageAgeCheck: "off" }, { downscale: () => (downscaleCalls++, Promise.resolve(new Uint8Array())) }).outcomes;

    expect(downscaleCalls).toBe(0);
    expect(net.ageCalls()).toHaveLength(0);
  });

  test("a candidate is stored right after its image checks, as received, with no qa.age verdict", async () => {
    const net = network();
    const { outcomes, stored } = run(net, { concurrency: 1, imageAgeCheck: "off" });

    expect(await outcomes).toEqual([1, 2, 3, 4].map(passed));
    expect(stored).toHaveLength(4);
    expect(stored[0]?.bytes).toEqual(PORTRAIT);
    expect(stored[0]?.meta).toEqual({
      mediaType: "image/png",
      width: 864,
      height: 1152,
      source: {
        kind: "generated",
        model: IMAGE_MODEL,
        provider: "openrouter",
        jobId: JOB_ID,
        attemptId: `${JOB_ID}:candidate-1#1`,
        promptSha: sha256(PROMPT),
        prompt: PROMPT,
        slot: "candidate-1",
        costMicros: 40_000,
      },
    });
    expect(stored.every((s) => !("qa" in s.meta))).toBe(true);
  });

  test("a moderation refusal behaves exactly as with the check on: the age branch is simply never reached", async () => {
    const net = network({ image: (_call, n) => (n === 2 ? MODERATION : portrait()) });
    const { outcomes } = run(net, { concurrency: 1, imageAgeCheck: "off" });

    expect((await outcomes)[1]).toMatchObject({ slot: 2, kind: "failed", error: { code: "MODERATION_REFUSED" }, fatal: false, reserveLeftOpen: false });
    expect(net.ageCalls()).toHaveLength(0);
  });

  // LOW (review, M28): with the check off there is no age check to blame an
  // animated image on — the message must say why the image itself is
  // refused, not reference a check that never ran.
  test("an animated image is refused with a neutral message, never mentioning the age check", async () => {
    const net = network({ image: () => portrait(ANIMATED) });
    const { outcomes } = run(net, { imageAgeCheck: "off" });

    const results = await outcomes;
    // Read the plain detail strings before any matcher-based expect() below
    // touches `results`: bun's toMatchObject/toEqual with an asymmetric
    // matcher (expect.objectContaining, .stringContaining) writes into the
    // object it checks (see ageCheck.ts's own doc comment on ageJsonSchema),
    // so a later plain-string read off the same object would see the matcher
    // itself, not the original string.
    // "age" alone is not a safe substring check: "image" itself contains it.
    const details = results.map((r) => (r.kind === "failed" ? r.error.detail : undefined));
    expect(details.every((d) => d?.includes("animated"))).toBe(true);
    expect(details.every((d) => !d?.includes("age-check") && !d?.includes("age check"))).toBe(true);
    expect(results).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "failed", error: expect.objectContaining({ code: "INTERNAL" }), fatal: false, reserveLeftOpen: false, charge: "paid" })));
    expect(net.ageCalls()).toHaveLength(0);
  });

  test("a descriptor that fails today's rules still sends nothing, whatever the toggle", async () => {
    const net = network();
    const { outcomes } = run(net, { imageAgeCheck: "off", descriptor: { age: 25, text: "25-year-old European woman who looks 17." } });

    expect(await outcomes).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "failed", error: expect.objectContaining({ code: "DESCRIPTOR_INVALID" }), fatal: true, reserveLeftOpen: false, charge: "free" })));
    expect(net.calls).toHaveLength(0);
  });

  test("omitting imageAgeCheck defaults to on (this function's own historical behaviour); the engine always passes the setting explicitly", async () => {
    await money.cleanup();
    money = await setupMoney({ runCapMicros: BATCH_WORST });
    const net = network();

    await run(net).outcomes;

    expect(net.ageCalls()).toHaveLength(4);
  });
});

describe("the age gate: nothing is stored without a clear yes, and nothing is asked twice", () => {
  const rejections: [string, Reply, Extract<SlotOutcome, { kind: "rejected" }>["why"]][] = [
    ["adult: false", ageAnswer(false, 0.99), "not-adult"],
    ["a confidence below 0.75", ageAnswer(true, 0.74), "low-confidence"],
    ["an answer that is not the JSON asked for", { status: 200, body: chatBody("The person is an adult.", { cost: 0.0014 }) }, "unreadable"],
    ["an empty answer", { status: 200, body: chatBody(null, { cost: 0.0014 }) }, "empty-answer"],
    ["a moderation refusal of the age check", MODERATION, "age-check-refused"],
  ];
  test.each(rejections)("%s rejects the candidate", async (_label, reply, why) => {
    const net = network({ age: () => reply });
    const { outcomes, stored } = run(net);

    expect(await outcomes).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "rejected", why })));
    expect(stored).toEqual([]);
    expect([net.imageCalls().length, net.ageCalls().length]).toEqual([4, 4]);
  });

  test("an image and its age check are admitted as a pair before the image is sent: no image is paid for without its check", async () => {
    await money.cleanup();
    // Room in the month for three pairs (45,250 µ$ at their worst each), not four.
    money = await setupMoney({ runCapMicros: BATCH_WORST, monthlyBudgetMicros: 165_000 });
    const net = network();
    const { outcomes, stored } = run(net);

    const results = await outcomes;
    expect(results.filter((o) => o.kind === "failed")).toEqual([{ slot: 4, kind: "failed", error: expect.objectContaining({ code: "BUDGET_EXCEEDED" }), fatal: false, reserveLeftOpen: false, charge: "free" }]);
    expect([net.imageCalls().length, net.ageCalls().length, stored.length]).toEqual([3, 3, 3]);
    const attempts = money.lines().filter((l) => l.type === "reserve").map((l) => String(l.attemptId));
    for (const image of attempts.filter((id) => id.endsWith("#1") && !id.includes(":age#"))) expect(attempts).toContain(image.replace(/#1$/, ":age#1"));
    expect(money.budget.status().heldMicros).toBe(0);
  });

  test("the job's cap refuses a pair that does not fit: the fourth image is never sent", async () => {
    await money.cleanup();
    // Settled attempts count at their bill (1,400 µ$ per age check): room for three pairs and a fourth image, not its check.
    money = await setupMoney({ runCapMicros: 4 * IMAGE_WORST + 3 * 1_400 + AGE_WORST - 1 });
    const net = network();
    const { outcomes, stored } = run(net, { concurrency: 1 });

    expect((await outcomes)[3]).toMatchObject({ slot: 4, kind: "failed", error: { code: "RUN_CAP_EXCEEDED" }, fatal: false });
    expect([net.imageCalls().length, net.ageCalls().length, stored.length]).toEqual([3, 3, 3]);
  });

  test("the age check is still checked against the limits when it is sent (invariant 3): a budget lowered meanwhile refuses it, and the image is not stored", async () => {
    const net = network({
      image: async (_call, n) => {
        if (n === 1) await money.budget.setMonthlyBudget(IMAGE_WORST + AGE_WORST - 1);
        return portrait();
      },
    });
    const { outcomes, stored } = run(net, { concurrency: 1 });

    expect((await outcomes)[0]).toMatchObject({ slot: 1, kind: "failed", error: { code: "BUDGET_EXCEEDED" } });
    expect([net.ageCalls().length, stored.length]).toEqual([0, 0]);
    expect(money.budget.status().heldMicros).toBe(0);
  });
});

// M7: the age check's own request can fail exactly as the image attempt's
// can; each case is checked for the same four things: nothing is ever stored
// (a candidate is only stored after a clear "yes" — see the age gate above),
// the ledger's line for the age attempt matches the case's own money rule,
// the hold taken for the pair is fully released, and the job ends failed
// with that case's error code (whether the case is fatal for the slots not
// started yet, or every slot hits the very same failure independently).
describe("the age check's own failure paths (M7): nothing is stored, the ledger and the hold are right, and the job ends right", () => {
  interface AgeFailureCase {
    name: string;
    age: Handler;
    clientOverrides?: Partial<OpenRouterClientOptions>;
    code: EngineError["code"];
    fatal: boolean;
    /** Whether the age attempt's own reserve line was settled (a final response, even a bad one) or left open (no final response; may have been billed). */
    settled: boolean;
  }

  const cases: AgeFailureCase[] = [
    { name: "a network error before any response", age: () => ({ reject: new TypeError("fetch failed") }), code: "NETWORK", fatal: false, settled: false },
    { name: "a timeout with no response", age: () => ({ hang: true }), clientOverrides: { timeoutMs: 20 }, code: "TIMEOUT", fatal: false, settled: false },
    { name: "a persistent 5xx (transport retries exhausted)", age: () => ({ status: 503 }), code: "NETWORK", fatal: false, settled: true },
    { name: "a 401", age: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }), code: "AUTH_INVALID", fatal: true, settled: true },
    {
      name: "a charge above the worst case",
      age: () => ({ status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "An adult." }), { cost: 6 }) }),
      code: "SETTLE_ABOVE_WORST",
      fatal: true,
      settled: true,
    },
  ];

  test.each(cases.map((c): [string, AgeFailureCase] => [c.name, c]))("%s on the age check", async (_label, c) => {
    const net = network({ age: c.age });
    const { outcomes, stored } = run(net, { concurrency: 1 }, { clientOverrides: c.clientOverrides });

    const results = await outcomes;
    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", error: expect.objectContaining({ code: c.code }), fatal: c.fatal, reserveLeftOpen: !c.settled });
    if (c.fatal) {
      // Fatal: the slots not started yet never start.
      expect(results.slice(1)).toEqual([2, 3, 4].map((slot) => ({ slot, kind: "skipped" })));
    } else {
      // Non-fatal: every slot hits the very same failure on its own age check, independently.
      expect(results.slice(1)).toEqual([2, 3, 4].map((slot) => expect.objectContaining({ slot, kind: "failed", error: expect.objectContaining({ code: c.code }) })));
    }
    // Nothing is ever stored: the age check never said a clear yes.
    expect(stored).toEqual([]);

    const attemptLines = money.lines().filter((l) => l.attemptId === `${JOB_ID}:candidate-1:age#1`);
    if (c.settled) expect(attemptLines).toMatchObject([{ type: "reserve", worstMicros: AGE_WORST }, { type: "settle" }]);
    else expect(attemptLines).toEqual([expect.objectContaining({ type: "reserve", worstMicros: AGE_WORST })]);
    // The hold taken for the image+age pair is released either way: nothing is left in flight.
    expect(money.budget.inFlightCount()).toBe(0);
    expect(money.budget.status().heldMicros).toBe(0);

    expect(candidateJobEnd(results, false)).toMatchObject({ status: "failed", error: { code: c.code } });
  });

  test("a cancel while the age check is in flight ends the slot as aborted; the reserve stays open until reconcile, and the job ends cancelled", async () => {
    const controller = new AbortController();
    const net = network({ age: () => ({ hang: true }) });
    const { outcomes, stored } = run(net, { concurrency: 1, signal: controller.signal });
    await until(() => net.ageCalls().length === 1);
    controller.abort();

    const results = await outcomes;
    expect(results).toEqual([
      { slot: 1, kind: "aborted" },
      { slot: 2, kind: "skipped" },
      { slot: 3, kind: "skipped" },
      { slot: 4, kind: "skipped" },
    ]);
    expect(stored).toEqual([]);
    const attemptLines = money.lines().filter((l) => l.attemptId === `${JOB_ID}:candidate-1:age#1`);
    expect(attemptLines).toEqual([expect.objectContaining({ type: "reserve", worstMicros: AGE_WORST })]);
    expect(money.budget.inFlightCount()).toBe(0);
    expect(money.budget.status().heldMicros).toBe(0);
    expect(candidateJobEnd(results, true)).toEqual({ status: "cancelled" });
  });
});

describe("a slot that cannot finish", () => {
  test("a moderation refusal of the image fails its slot for free, with no age check and no retry", async () => {
    const net = network({ image: (_call, n) => (n === 2 ? MODERATION : portrait()) });
    const { outcomes } = run(net, { concurrency: 1 });

    expect((await outcomes)[1]).toMatchObject({ slot: 2, kind: "failed", error: { code: "MODERATION_REFUSED" }, fatal: false, reserveLeftOpen: false });
    expect(money.lines().find((l) => l.type === "settle" && l.attemptId === `${JOB_ID}:candidate-2#1`)).toMatchObject({ costMicros: 0 });
    expect([net.imageCalls().length, net.ageCalls().length]).toEqual([4, 3]);
  });

  test("a network error leaves the image's reserve open at its worst case, and the other slots go on", async () => {
    const net = network({ image: (_call, n) => (n === 1 ? { reject: new TypeError("fetch failed") } : portrait()) });
    const { outcomes, stored } = run(net, { concurrency: 1 });

    expect(await outcomes).toEqual([
      { slot: 1, kind: "failed", error: expect.objectContaining({ code: "NETWORK" }), fatal: false, reserveLeftOpen: true, charge: "worst-until-reconcile" },
      ...[2, 3, 4].map((n) => ({ ...passed(n), photoId: `photo-${String(n - 1).padStart(8, "0")}` })),
    ]);
    expect(stored).toHaveLength(3);
    const first = money.lines().filter((l) => l.attemptId === `${JOB_ID}:candidate-1#1`);
    expect(first).toMatchObject([{ type: "reserve", worstMicros: IMAGE_WORST }]);
  });

  test("a 401 is fatal: the slots not started yet never start", async () => {
    const net = network({ image: (_call, n) => (n === 2 ? { status: 401, body: { error: { message: "No auth credentials found" } } } : portrait()) });
    const { outcomes, reported } = run(net, { concurrency: 1 });

    expect(await outcomes).toEqual([
      passed(1),
      { slot: 2, kind: "failed", error: expect.objectContaining({ code: "AUTH_INVALID" }), fatal: true, reserveLeftOpen: false, charge: "free" },
      { slot: 3, kind: "skipped" },
      { slot: 4, kind: "skipped" },
    ]);
    expect(net.imageCalls()).toHaveLength(2);
    expect(reported.map((o) => o.kind)).toEqual(["passed", "failed"]);
  });

  test("an image whose size cannot be read fails its slot before any age check is paid", async () => {
    const net = network({ image: () => portrait(JPEG) });
    const { outcomes, stored } = run(net);

    expect(await outcomes).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "failed", error: expect.objectContaining({ code: "INTERNAL" }), fatal: false, reserveLeftOpen: false, charge: "paid" })));
    expect([net.ageCalls().length, stored.length]).toEqual([0, 0]);
  });

  test("an animated image fails its slot before any age check is paid: the check could see another frame than a viewer", async () => {
    const net = network({ image: () => portrait(ANIMATED) });
    const { outcomes, stored } = run(net);

    const results = await outcomes;
    expect(results).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "failed", error: expect.objectContaining({ code: "INTERNAL" }), fatal: false, reserveLeftOpen: false, charge: "paid" })));
    expect(results[0]).toMatchObject({ error: { detail: expect.stringContaining("animated") } });
    expect([net.ageCalls().length, stored.length]).toEqual([0, 0]);
  });

  test("an image ffmpeg cannot decode fails only its own slot before any age check is paid: not fatal, since ffmpeg ran and this one paid image was the problem (M8 review fix)", async () => {
    // A valid PNG signature and IHDR (864×1152), then garbage: ffmpeg spawns
    // fine, reads it, and exits non-zero — a decode failure, not a spawn one.
    const broken = Uint8Array.from([...PORTRAIT.subarray(0, 33), ...new Uint8Array(64).fill(7)]);
    const net = network({ image: (_call, n) => (n === 1 ? portrait(broken) : portrait()) });
    const { outcomes, stored } = run(net, { concurrency: 1 });

    const results = await outcomes;
    const first = results[0];
    if (first.kind !== "failed") throw new Error(`expected slot 1 to have failed, got ${first.kind}`);
    expect(first).toMatchObject({ slot: 1, kind: "failed", fatal: false, reserveLeftOpen: false });
    expect(first.error.code).toBe("INTERNAL");
    expect(first.error.detail).toContain("age check");
    // Review (A): the engine's own error detail carries ffmpeg's own stderr
    // tail too, not just its bare exit code, which explains nothing alone.
    expect(first.error.detail).toContain("ffmpeg exited with code");
    expect(first.error.detail).not.toMatch(/ffmpeg exited with code \d+$/);
    // The other slots are independent: their own images still have their own chance.
    // (Slot 1 never stores anything, so the store's own sequential ids start at slot 2.)
    expect(results.slice(1)).toEqual([2, 3, 4].map((n) => ({ ...passed(n), photoId: `photo-${String(n - 1).padStart(8, "0")}` })));
    expect([net.imageCalls().length, stored.length]).toEqual([4, 3]);
  });

  test("a spawn failure (ffmpeg missing or not executable) is fatal for the slots not started yet, unlike a decode failure (M8 review fix)", async () => {
    const net = network();
    const { outcomes, stored } = run(net, { concurrency: 1 }, {
      downscale: () => Promise.reject(Object.assign(new Error("spawn no-such-ffmpeg ENOENT"), { code: "ENOENT" })),
    });

    const results = await outcomes;
    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", error: expect.objectContaining({ code: "INTERNAL" }), fatal: true, reserveLeftOpen: false });
    expect(results.slice(1)).toEqual([2, 3, 4].map((slot) => ({ slot, kind: "skipped" })));
    expect([net.ageCalls().length, stored.length]).toEqual([0, 0]);
  });

  // Review (LOW 14): the worker loop only checks `fatal` before PICKING a
  // slot; a slot already past that check, mid-flight through its own hold,
  // did not re-check it before actually sending. Slot 2's own tryHold is
  // held back (a spy on the real Budget, not a fake) until slot 1's spawn
  // failure has already turned the job fatal, so this proves the window
  // between tryHold resolving and the image request being sent, not just
  // the ordinary top-of-loop check.
  test("does not send an image once the job has already turned fatal, even for a slot already past its own hold (LOW 14)", async () => {
    let releaseSlot2: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseSlot2 = r));
    const realTryHold = money.budget.tryHold.bind(money.budget);
    spyOn(money.budget, "tryHold").mockImplementation(async (requests: Parameters<typeof realTryHold>[0]) => {
      if (requests.some((r) => r.attemptId.includes("candidate-2"))) await gate;
      return realTryHold(requests);
    });
    const net = network();
    const { outcomes, reported } = run(net, { concurrency: 2 }, {
      downscale: () => Promise.reject(Object.assign(new Error("spawn no-such-ffmpeg ENOENT"), { code: "ENOENT" })),
    });

    await until(() => reported.some((o) => o.kind === "failed" && o.fatal));
    releaseSlot2();
    const results = await outcomes;

    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", fatal: true });
    expect(results[1]).toEqual({ slot: 2, kind: "skipped" });
    expect(net.imageCalls()).toHaveLength(1);
  });

  test("with concurrency high enough that every image is already bought, one slot's decode failure does not turn the others' passing candidates into a failed job (review MEDIUM)", async () => {
    const broken = Uint8Array.from([...PORTRAIT.subarray(0, 33), ...new Uint8Array(64).fill(7)]);
    const net = network({ image: (_call, n) => (n === 1 ? portrait(broken) : portrait()) });
    const { outcomes, stored } = run(net, { concurrency: 6 });

    const results = await outcomes;
    expect(results.find((o) => o.slot === 1)).toMatchObject({ kind: "failed", fatal: false });
    expect(results.filter((o) => o.kind === "passed")).toHaveLength(3);
    expect(stored).toHaveLength(3);
    expect(candidateJobEnd(results, false)).toMatchObject({ status: "done", photoIds: stored.map(() => expect.any(String)) });
  });

  test("a descriptor that fails today's rules sends nothing: every slot fails with DESCRIPTOR_INVALID", async () => {
    const net = network();
    const { outcomes } = run(net, { descriptor: { age: 25, text: "25-year-old European woman who looks 17." } });

    expect(await outcomes).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "failed", error: expect.objectContaining({ code: "DESCRIPTOR_INVALID" }), fatal: true, reserveLeftOpen: false, charge: "free" })));
    expect(net.calls).toHaveLength(0);
    expect(money.lines()).toEqual([]);
  });
});

describe("preparing the image for the age check cannot hold a slot", () => {
  test("a downscale that never ends fails its slot once the prepare timeout passes; its signal fired, so ffmpeg is killed, and it is fatal for the slots not started yet (M8)", async () => {
    const signals: AbortSignal[] = [];
    const net = network();
    const started = performance.now();
    const { outcomes, stored } = run(net, { prepareTimeoutMs: 50, concurrency: 1 }, {
      downscale: (_bytes, signal) => {
        signals.push(signal);
        return new Promise<Uint8Array>(() => {});
      },
    });

    const results = await outcomes;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", error: expect.objectContaining({ code: "INTERNAL", detail: expect.stringContaining("timed out") }), fatal: true, reserveLeftOpen: false });
    expect(results.slice(1)).toEqual([2, 3, 4].map((slot) => ({ slot, kind: "skipped" })));
    expect(signals).toHaveLength(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect([net.ageCalls().length, stored.length]).toEqual([0, 0]);
  }, 3_000);

  test("a cancel while the image is being prepared ends the slot as aborted, without waiting for the downscale", async () => {
    const controller = new AbortController();
    const net = network();
    let preparing = 0;
    const { outcomes } = run(net, { signal: controller.signal }, {
      downscale: () => {
        preparing++;
        return new Promise<Uint8Array>(() => {});
      },
    });
    await until(() => preparing === 4);
    controller.abort();

    expect(await outcomes).toEqual([1, 2, 3, 4].map((slot) => ({ slot, kind: "aborted" })));
    expect(net.ageCalls()).toHaveLength(0);
  }, 3_000);

  test("the default prepare timeout is 30 s: far above a 768 px downscale, far below a slot's request timeouts", () => {
    expect(PREPARE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("the network pool and cancel", () => {
  // Every image request waits at the fake server until the test lets it go,
  // and the test lets the oldest go only once every slot the pool has started
  // is waiting there: the server then sees exactly as many requests at once as
  // the pool runs slots, however long a reserve's fsync takes. Racing the wall
  // clock instead failed on the Windows runners, where a slot's reserve took
  // longer than another slot's whole 10 ms request.
  const disks: [string, LedgerDeps | undefined][] = [
    ["this machine's disk", undefined],
    ["a disk whose every fsync takes 30 ms more, as on the Windows runners", slowDisk(30)],
  ];
  for (const [disk, ledger] of disks) {
    test(`at most \`concurrency\` slots are in flight at once, and that many are (${disk})`, async () => {
      if (ledger !== undefined) {
        await money.cleanup();
        money = await setupMoney({ runCapMicros: BATCH_WORST, ledger });
      }
      /** A slot's first step, taken as the pool starts it: its image and age check are held as a pair. */
      const started = spyOn(money.budget, "tryHold");
      const waiting: (() => void)[] = [];
      let most = 0;
      let draining = false;
      const net = network({
        image: async () => {
          if (!draining) {
            await new Promise<void>((release) => {
              waiting.push(release);
              most = Math.max(most, waiting.length);
            });
          }
          return portrait();
        },
      });

      const { outcomes, reported } = run(net, { concurrency: 2 });
      try {
        for (let released = 0; released < 4; released++) {
          await until(() => waiting.length > 0 && waiting.length === started.mock.calls.length - reported.length);
          waiting.shift()?.();
        }
      } finally {
        draining = true;
        for (const release of waiting.splice(0)) release();
        // Even when `until` timed out: the pool must stop writing before afterEach deletes the ledger's dir.
        await outcomes.catch(() => {});
      }

      expectAllPassed(await outcomes);
      expect(most).toBe(2);
    });
  }

  test("cancel aborts the requests in flight, leaves their reserves open at the worst case, and starts no new slot", async () => {
    const controller = new AbortController();
    const net = network({ image: () => ({ hang: true }) });
    const { outcomes, stored } = run(net, { concurrency: 2, signal: controller.signal });

    await until(() => net.imageCalls().length === 2);
    controller.abort();

    expect(await outcomes).toEqual([
      { slot: 1, kind: "aborted" },
      { slot: 2, kind: "aborted" },
      { slot: 3, kind: "skipped" },
      { slot: 4, kind: "skipped" },
    ]);
    expect(stored).toEqual([]);
    expect(net.imageCalls()).toHaveLength(2);
    expect(money.lines().map((l) => l.type)).toEqual(["reserve", "reserve"]);
    expect(money.budget.inFlightCount()).toBe(0);
  });
});

describe("candidateJobEnd", () => {
  const failed = (slot: number, code: EngineError["code"], fatal = false, reserveLeftOpen = false): SlotOutcome => ({ slot, kind: "failed", error: { code }, fatal, reserveLeftOpen, charge: "free" });
  const rejected = (slot: number): SlotOutcome => ({ slot, kind: "rejected", why: "not-adult" });

  test("every candidate passed: done, in slot order", () => {
    expect(candidateJobEnd([1, 2, 3, 4].map(passed), false)).toEqual({
      status: "done",
      photoIds: ["photo-00000001", "photo-00000002", "photo-00000003", "photo-00000004"],
      failedSlots: [],
    });
  });

  test("passed, rejected and failed slots: done with the candidates that passed, and every other slot with why", () => {
    expect(candidateJobEnd([passed(1), rejected(2), failed(3, "NETWORK", false, true), rejected(4)], false)).toEqual({
      status: "done",
      photoIds: ["photo-00000001"],
      failedSlots: [
        { slot: 2, reason: "age-rejected" },
        { slot: 3, reason: "failed", error: { code: "NETWORK" }, reserveLeftOpen: true },
        { slot: 4, reason: "age-rejected" },
      ],
    });
  });

  test("nothing passed but the age check rejected some: done, with no candidates", () => {
    expect(candidateJobEnd([rejected(1), failed(2, "MODERATION_REFUSED"), rejected(3), rejected(4)], false)).toEqual({
      status: "done",
      photoIds: [],
      failedSlots: [
        { slot: 1, reason: "age-rejected" },
        { slot: 2, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false },
        { slot: 3, reason: "age-rejected" },
        { slot: 4, reason: "age-rejected" },
      ],
    });
  });

  test("nothing passed and nothing was judged: failed, with the first slot's error", () => {
    expect(candidateJobEnd([failed(1, "MODERATION_REFUSED"), failed(2, "NETWORK"), failed(3, "NETWORK"), failed(4, "TIMEOUT")], false)).toEqual({
      status: "failed",
      error: { code: "MODERATION_REFUSED" },
    });
  });

  test("a fatal error fails the job even when some candidates passed (they are already in the draft)", () => {
    expect(candidateJobEnd([passed(1), failed(2, "AUTH_INVALID", true), { slot: 3, kind: "skipped" }, { slot: 4, kind: "skipped" }], false)).toEqual({
      status: "failed",
      error: { code: "AUTH_INVALID" },
    });
  });

  test("a cancel that stopped a slot ends the job as cancelled, whatever else happened", () => {
    expect(candidateJobEnd([passed(1), { slot: 2, kind: "aborted" }, failed(3, "AUTH_INVALID", true), { slot: 4, kind: "skipped" }], true)).toEqual({ status: "cancelled" });
    expect(candidateJobEnd([passed(1), passed(2), passed(3), { slot: 4, kind: "skipped" }], true)).toEqual({ status: "cancelled" });
  });

  test("a cancel that came after every slot had finished changes nothing", () => {
    expect(candidateJobEnd([passed(1), passed(2), rejected(3), passed(4)], true)).toMatchObject({ status: "done", failedSlots: [{ slot: 3, reason: "age-rejected" }] });
  });

  test("no slot ran at all: failed, not an empty success", () => {
    expect(candidateJobEnd([], false)).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
  });
});
