import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortraitsResult, type AvatarDescriptor, type EngineError } from "../../shared/engine";
import { downscaleToJpeg } from "../../node/downscale";
import { ffmpegPath } from "../../node/ffmpegBinary";
import type { FaceVerdict } from "../face/verdict";
import type { NewPhotoMeta } from "../library";
import type { Budget, HoldRequest } from "../money/budget";
import { PriceBook } from "../money/prices";
import { asLibraryReference, chatBody, fakeFetch, imageBody, JPEG, makeClient, setupMoney, type FetchCall, type Money, type Reply } from "../openrouter/testing/fakes";
import type { OpenRouterClientOptions } from "../openrouter/types";
import { AGE_CHECK_MAX_SIDE } from "./ageCheck";
import {
  candidateBatchSpec,
  candidateJobEnd,
  imageAttemptId,
  portraitBatchSpec,
  portraitJobEnd,
  runBatch,
  runPortraitJob,
  type CandidateJob,
  type PortraitBatch,
  type SlotOutcome,
} from "./candidateJob";
import { portraitsEstimate } from "./plan";
import { candidatePrompt, referencePortraitPrompt } from "./prompts";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, S5.3b: the candidate job run as a reference portrait batch. Five slots, each an image with the imported photo as its one reference, a free face
// ranking after the image, and the age check only for an image that ranked as hers. The regression gate for the candidates is candidateJob.test.ts, unchanged.

const JOB_ID = "job-00000001";
const SCOPE = { avatarJobId: JOB_ID };
const IMAGE_MODEL = "x-ai/grok-imagine-image-quality";
/** The fallback table: grok-imagine-image-quality 1K $0.05, plus $0.01 for the one reference. */
const IMAGE_WORST = 60_000;
const AGE_WORST = 5_250;
const MODELS = { imageModel: IMAGE_MODEL, textModel: "x-ai/grok-4.3" };
const FALLBACK = { book: PriceBook.fallback(), asOf: "2026-10-11" };
const BATCH_WORST_ON = portraitsEstimate(FALLBACK, MODELS, "on").worstMicros;
const GOOD = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: GOOD };
const PROMPT = referencePortraitPrompt(DESCRIPTOR);
const REFERENCE = asLibraryReference(JPEG);
const MODERATION: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };

let dir = "";
let PORTRAIT = new Uint8Array();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-portraits-"));
  const path = join(dir, "portrait.png");
  const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "mandelbrot=size=576x1024", "-frames:v", "1", path]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render the portrait: ${r.stderr.toString()}`);
  PORTRAIT = new Uint8Array(readFileSync(path));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function image(): Reply {
  return { status: 200, body: imageBody(PORTRAIT, { cost: 0.06 }) };
}

function ageAnswer(): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "An adult woman." }), { cost: 0.0014 }) };
}

type Handler = (call: FetchCall, n: number) => Reply | Promise<Reply>;

function network(opts: { image?: Handler; age?: Handler } = {}) {
  let images = 0;
  let ages = 0;
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/images")) return (opts.image ?? (() => image()))(call, ++images);
    if (call.url.endsWith("/chat/completions")) return (opts.age ?? (() => ageAnswer()))(call, ++ages);
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

function match(similarity: number, headRatio = 0.31): FaceVerdict {
  return { kind: "match", similarity, faces: 1, headRatio };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney({ runCapMicros: BATCH_WORST_ON });
});
afterEach(async () => {
  await money.cleanup();
});

interface Stored {
  bytes: Uint8Array;
  meta: NewPhotoMeta;
}

/** The budget with every `tryHold` request recorded, for the holds a slot admits. */
function recordingBudget(budget: Budget, holds: HoldRequest[][]): Budget {
  return new Proxy(budget, {
    get(target, prop) {
      if (prop === "tryHold") {
        return (requests: HoldRequest[]) => {
          holds.push(requests);
          return target.tryHold(requests);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function run(
  net: ReturnType<typeof network>,
  opts: { batch?: Partial<PortraitBatch>; job?: Partial<CandidateJob>; clientOverrides?: Partial<OpenRouterClientOptions> } = {},
) {
  const { client } = makeClient(net.fetch, opts.clientOverrides);
  const stored: Stored[] = [];
  const reported: SlotOutcome[] = [];
  const holds: HoldRequest[][] = [];
  const ranked: number[] = [];
  const batch: PortraitBatch = {
    references: [REFERENCE],
    rank: async (slot) => {
      ranked.push(slot);
      return match(0.7 + slot / 100);
    },
    ...opts.batch,
  };
  const outcomes = runPortraitJob(
    {
      generateImage: (params) => client.generateImage(params),
      chat: (params) => client.chat(params),
      budget: recordingBudget(money.budget, holds),
      priceBook: money.priceBook,
      downscale: (bytes, signal) => downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal }),
      store: async (bytes, meta) => {
        stored.push({ bytes, meta });
        return { id: `photo-${String(stored.length).padStart(8, "0")}` };
      },
      errorOf: (error): EngineError => ({ code: "INTERNAL", detail: String(error) }),
      onSlot: (outcome) => reported.push(outcome),
    },
    { jobId: JOB_ID, scope: SCOPE, imageModel: IMAGE_MODEL, descriptor: DESCRIPTOR, concurrency: 1, signal: new AbortController().signal, imageAgeCheck: "on", ...opts.job },
    batch,
  );
  return { outcomes, stored, reported, holds, ranked };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("timed out waiting for the condition");
}

describe("the candidate job's spec", () => {
  test("candidates build exactly today's spec: 4 slots, candidate-N ids, 3:4, no reference, no rank", () => {
    const job = { jobId: JOB_ID, imageModel: "x-ai/grok-imagine-image-2.0", descriptor: DESCRIPTOR };
    const spec = candidateBatchSpec({ ...job, scope: SCOPE, concurrency: 4, signal: new AbortController().signal, imageAgeCheck: "on" });

    expect(spec.slots).toEqual([1, 2, 3, 4]);
    expect(spec.slotName(2)).toBe("candidate-2");
    expect(imageAttemptId(JOB_ID, spec.slotName(2))).toBe(`${JOB_ID}:candidate-2#1`);
    expect(spec.aspectRatio).toBe("3:4");
    expect(spec.references).toEqual([]);
    expect(spec.image).toEqual({ model: "x-ai/grok-imagine-image-2.0", quality: "low", refs: 0 });
    expect(spec.prompt).toBe(candidatePrompt(DESCRIPTOR));
    expect(spec.rank).toBeUndefined();
  });

  test("portraits build 5 slots, portrait-N ids, 9:16, the one reference and a rank", () => {
    const spec = portraitBatchSpec({ jobId: JOB_ID, scope: SCOPE, imageModel: IMAGE_MODEL, descriptor: DESCRIPTOR, concurrency: 3, signal: new AbortController().signal, imageAgeCheck: "off" }, { references: [REFERENCE], rank: async () => match(0.7) });

    expect(spec.slots).toEqual([1, 2, 3, 4, 5]);
    expect(spec.slotName(5)).toBe("portrait-5");
    expect(imageAttemptId(JOB_ID, spec.slotName(5))).toBe(`${JOB_ID}:portrait-5#1`);
    expect(spec.aspectRatio).toBe("9:16");
    expect(spec.references).toEqual([REFERENCE]);
    expect(spec.image).toEqual({ model: IMAGE_MODEL, quality: "low", refs: 1 });
    expect(spec.prompt).toBe(PROMPT);
    expect(spec.rank).toBeDefined();
  });
});

describe("a batch of reference portraits: what is sent and what is held", () => {
  test("five image attempts: 1K, 9:16, the portrait prompt, the image model and exactly one reference each", async () => {
    const net = network();
    const { outcomes } = run(net);

    expect((await outcomes).map((o) => o.kind)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    const bodies = net.imageCalls().map((c) => c.json());
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      expect(body).toMatchObject({ model: IMAGE_MODEL, prompt: PROMPT, resolution: "1K", aspect_ratio: "9:16", quality: "low", input_references: [expect.objectContaining({ type: "image_url" })] });
    }
  });

  test("each slot holds exactly an image with one reference and its age check, and the reserves add up to the batch's worst case", async () => {
    const { outcomes, holds } = run(network());
    await outcomes;

    expect(holds).toHaveLength(5);
    expect(holds[0]).toEqual([
      { attemptId: `${JOB_ID}:portrait-1#1`, scope: SCOPE, worstMicros: IMAGE_WORST },
      { attemptId: `${JOB_ID}:portrait-1:age#1`, scope: SCOPE, worstMicros: AGE_WORST },
    ]);
    const reserves = money.lines().filter((l) => l.type === "reserve");
    expect(reserves.map((r) => r.attemptId).sort()).toEqual([1, 2, 3, 4, 5].flatMap((n) => [`${JOB_ID}:portrait-${n}#1`, `${JOB_ID}:portrait-${n}:age#1`]).sort());
    expect(reserves.reduce((sum, r) => sum + Number(r.worstMicros), 0)).toBe(BATCH_WORST_ON);
    expect(BATCH_WORST_ON).toBe(326_250);
  });

  test("with the age check off a slot holds the image alone, and no age check is sent", async () => {
    const net = network();
    const { outcomes, holds } = run(net, { job: { imageAgeCheck: "off" } });

    expect((await outcomes).map((o) => o.kind)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(holds.every((h) => h.length === 1 && h[0]?.worstMicros === IMAGE_WORST)).toBe(true);
    expect(net.ageCalls()).toHaveLength(0);
  });

  test("the hold's worst is the reserve's worst: refs come from the references, whatever the spec's image says", async () => {
    const net = network();
    const { client } = makeClient(net.fetch);
    const holds: HoldRequest[][] = [];
    const job: CandidateJob = { jobId: JOB_ID, scope: SCOPE, imageModel: IMAGE_MODEL, descriptor: DESCRIPTOR, concurrency: 1, signal: new AbortController().signal, imageAgeCheck: "off" };
    const spec = portraitBatchSpec(job, { references: [REFERENCE], rank: async () => match(0.7) });

    await runBatch(
      {
        generateImage: (params) => client.generateImage(params),
        chat: (params) => client.chat(params),
        budget: recordingBudget(money.budget, holds),
        priceBook: money.priceBook,
        downscale: async (bytes) => bytes,
        store: async () => ({ id: "photo-00000001" }),
        errorOf: (error): EngineError => ({ code: "INTERNAL", detail: String(error) }),
      },
      job,
      // A spec that says refs 0 while it carries one reference: the hold is still the one-reference price.
      { ...spec, image: { ...spec.image, refs: 0 } },
    );

    const reserve = money.lines().find((l) => l.type === "reserve" && l.attemptId === `${JOB_ID}:portrait-1#1`);
    expect(holds[0]?.[0]?.worstMicros).toBe(IMAGE_WORST);
    expect(reserve).toMatchObject({ worstMicros: IMAGE_WORST });
  });

  test("a descriptor that today's rules refuse fails every slot before anything is held or sent", async () => {
    const net = network();
    const { outcomes, holds } = run(net, { job: { descriptor: { age: 25, text: "25-year-old European woman who looks 17." } } });

    const results = await outcomes;
    expect(results.map((o) => [o.slot, o.kind])).toEqual([1, 2, 3, 4, 5].map((slot) => [slot, "failed"]));
    expect(results.every((o) => o.kind === "failed" && o.error.code === "DESCRIPTOR_INVALID" && o.fatal)).toBe(true);
    expect([holds.length, net.calls.length]).toEqual([0, 0]);
  });
});

describe("the free ranking after the image", () => {
  test("the rank sees the image's own bytes, and its slot", async () => {
    const seen: Array<{ slot: number; same: boolean }> = [];
    const { outcomes } = run(network(), {
      batch: {
        rank: async (slot, bytes) => {
          seen.push({ slot, same: bytes.length === PORTRAIT.length });
          return match(0.7);
        },
      },
    });
    await outcomes;

    expect(seen).toEqual([1, 2, 3, 4, 5].map((slot) => ({ slot, same: true })));
  });

  test("a match is stored with its likeness and head ratio as qa, the age verdict beside them, and the portrait-N slot", async () => {
    const { outcomes, stored } = run(network(), { batch: { rank: async () => match(0.76, 0.33) } });
    const results = await outcomes;

    expect(results[0]).toEqual({ slot: 1, kind: "passed", photoId: "photo-00000001", likeness: 0.76 });
    expect(stored[0]?.meta.qa).toEqual({ faceCos: 0.76, headRatio: 0.33, age: { adult: true, confidence: 0.95 } });
    expect(stored[0]?.meta.source).toMatchObject({ kind: "generated", slot: "portrait-1", attemptId: `${JOB_ID}:portrait-1#1`, prompt: PROMPT });
  });

  test("with the age check off the qa holds the likeness alone", async () => {
    const { outcomes, stored } = run(network(), { job: { imageAgeCheck: "off" }, batch: { rank: async () => match(0.76, 0.33) } });
    await outcomes;

    expect(stored[0]?.meta.qa).toEqual({ faceCos: 0.76, headRatio: 0.33 });
  });

  test("an unlike, no-face or multiple-faces image is never stored and pays no age check", async () => {
    const script: Record<number, FaceVerdict> = {
      1: match(0.76),
      2: { kind: "mismatch", similarity: 0.48, faces: 1, headRatio: 0.3 },
      3: { kind: "no-face", faces: 0 },
      4: { kind: "multiple-faces", faces: 2 },
      5: match(0.61),
    };
    const net = network();
    const { outcomes, stored } = run(net, { batch: { rank: async (slot) => script[slot] ?? { kind: "no-face", faces: 0 } } });

    expect(await outcomes).toEqual([
      { slot: 1, kind: "passed", photoId: "photo-00000001", likeness: 0.76 },
      { slot: 2, kind: "ranked-out", why: "unlike", likeness: 0.48 },
      { slot: 3, kind: "ranked-out", why: "no-face" },
      { slot: 4, kind: "ranked-out", why: "multiple-faces" },
      { slot: 5, kind: "passed", photoId: "photo-00000002", likeness: 0.61 },
    ]);
    expect(stored.map((s) => s.meta.source.kind === "generated" ? s.meta.source.slot : null)).toEqual(["portrait-1", "portrait-5"]);
    // The rank comes before the age check: only the two matches were checked, and the other three slots' age holds were released unspent.
    expect(net.ageCalls()).toHaveLength(2);
    const ageReserves = money.lines().filter((l) => l.type === "reserve" && String(l.attemptId).endsWith(":age#1"));
    expect(ageReserves.map((l) => l.attemptId).sort()).toEqual([`${JOB_ID}:portrait-1:age#1`, `${JOB_ID}:portrait-5:age#1`]);
    expect(money.budget.status().heldMicros).toBe(0);
  });

  test("a similarity a hair above 1 is stored as 1, and one below -1 is reported as -1", async () => {
    const script: Record<number, FaceVerdict> = { 1: match(1.0000001), 2: { kind: "mismatch", similarity: -1.2, faces: 1, headRatio: 0.3 } };
    const { outcomes, stored } = run(network(), { batch: { rank: async (slot) => script[slot] ?? match(0.7) } });
    const results = await outcomes;

    expect(results[0]).toMatchObject({ slot: 1, kind: "passed", likeness: 1 });
    expect(stored[0]?.meta.qa?.faceCos).toBe(1);
    expect(results[1]).toEqual({ slot: 2, kind: "ranked-out", why: "unlike", likeness: -1 });
  });

  test("the verdict is decided by the likeness against the contract's 0.55, whatever the gate's own threshold said", async () => {
    // A gate configured looser than 0.55 calls 0.5 a match; one configured stricter calls 0.6 a mismatch. The stored and reported values must fit the contract either way.
    const script: Record<number, FaceVerdict> = { 1: match(0.5), 2: { kind: "mismatch", similarity: 0.6, faces: 1, headRatio: 0.3 }, 3: match(0.55) };
    const { outcomes, stored } = run(network(), { batch: { rank: async (slot) => script[slot] ?? { kind: "no-face", faces: 0 } } });
    const results = await outcomes;

    expect(results[0]).toEqual({ slot: 1, kind: "ranked-out", why: "unlike", likeness: 0.5 });
    expect(results[1]).toEqual({ slot: 2, kind: "passed", photoId: "photo-00000001", likeness: 0.6 });
    expect(results[2]).toEqual({ slot: 3, kind: "passed", photoId: "photo-00000002", likeness: 0.55 });
    expect(stored.map((s) => s.meta.qa?.faceCos)).toEqual([0.6, 0.55]);
    const end = portraitJobEnd(results, false);
    expect(end.status === "done" && PortraitsResult.safeParse({ kind: "avatar.portraits", avatarId: "avatar-00000001", candidates: end.candidates.map((c) => ({ avatarId: "avatar-00000001", ...c })), failedSlots: end.failedSlots }).success).toBe(true);
  });

  test("a scripted gate is answered by slot, not by call order, at concurrency 3", async () => {
    const script: Record<number, FaceVerdict> = {
      1: match(0.76),
      2: { kind: "mismatch", similarity: 0.48, faces: 1, headRatio: 0.3 },
      3: { kind: "no-face", faces: 0 },
      4: match(0.61),
      5: { kind: "multiple-faces", faces: 2 },
    };
    // The later the slot, the sooner it answers: the call order and the slot order disagree.
    const { outcomes, stored } = run(network(), {
      job: { concurrency: 3 },
      batch: {
        rank: async (slot) => {
          await new Promise((resolve) => setTimeout(resolve, (6 - slot) * 12));
          return script[slot] ?? { kind: "no-face", faces: 0 };
        },
      },
    });
    const results = await outcomes;

    expect(results.map((o) => [o.slot, o.kind, o.kind === "ranked-out" ? o.why : null])).toEqual([
      [1, "passed", null],
      [2, "ranked-out", "unlike"],
      [3, "ranked-out", "no-face"],
      [4, "passed", null],
      [5, "ranked-out", "multiple-faces"],
    ]);
    const likenessBySlot = Object.fromEntries(stored.map((s) => [s.meta.source.kind === "generated" ? s.meta.source.slot : "", s.meta.qa?.faceCos]));
    expect(likenessBySlot).toEqual({ "portrait-1": 0.76, "portrait-4": 0.61 });
  });
});

describe("a rank that cannot answer", () => {
  test("a rank that throws is fatal: INTERNAL, the slots not started never start, no further hold is taken", async () => {
    const net = network();
    const { outcomes, holds, stored } = run(net, {
      batch: {
        rank: async () => {
          throw new Error("the face worker died");
        },
      },
    });

    const results = await outcomes;
    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", error: { code: "INTERNAL" }, fatal: true, reserveLeftOpen: false });
    expect(results.slice(1)).toEqual([2, 3, 4, 5].map((slot) => ({ slot, kind: "skipped" })));
    expect([holds.length, net.imageCalls().length, stored.length]).toEqual([1, 1, 0]);
    expect(money.budget.status().heldMicros).toBe(0);
  });

  test("a rank that hangs ends at its bound as a fatal INTERNAL, and frees the holds", async () => {
    const { outcomes } = run(network(), { job: { rankTimeoutMs: 30 }, batch: { rank: () => new Promise<FaceVerdict>(() => {}) } });

    const results = await outcomes;
    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", error: { code: "INTERNAL", detail: expect.stringContaining("timed out") }, fatal: true });
    expect(results.slice(1).every((o) => o.kind === "skipped")).toBe(true);
    expect(money.budget.status().heldMicros).toBe(0);
  });

  test("the default bound is the run gate's 60 s", async () => {
    const { QA_GATE_TIMEOUT_MS } = await import("../runs/qa");
    const { PORTRAIT_RANK_TIMEOUT_MS } = await import("./candidateJob");
    expect(PORTRAIT_RANK_TIMEOUT_MS).toBe(QA_GATE_TIMEOUT_MS);
    expect(PORTRAIT_RANK_TIMEOUT_MS).toBe(60_000);
  });

  test("a cancel during a rank is a cancel, not a failure: the slot is aborted, the rank's signal fires, and the job ends cancelled", async () => {
    const controller = new AbortController();
    let rankSignal: AbortSignal | undefined;
    const { outcomes } = run(network(), {
      job: { signal: controller.signal },
      batch: {
        rank: (_slot, _bytes, signal) => {
          rankSignal = signal;
          return new Promise<FaceVerdict>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
      },
    });
    await until(() => rankSignal !== undefined);
    controller.abort();

    const results = await outcomes;
    expect(rankSignal?.aborted).toBe(true);
    expect(results).toEqual([{ slot: 1, kind: "aborted" }, ...[2, 3, 4, 5].map((slot): SlotOutcome => ({ slot, kind: "skipped" }))]);
    expect(portraitJobEnd(results, true)).toEqual({ status: "cancelled" });
    expect(money.budget.status().heldMicros).toBe(0);
  });

  test("a cancel is not waited on when the rank ignores its signal", async () => {
    const controller = new AbortController();
    let started = false;
    const { outcomes } = run(network(), {
      job: { signal: controller.signal },
      batch: {
        rank: () => {
          started = true;
          return new Promise<FaceVerdict>(() => {});
        },
      },
    });
    await until(() => started);
    controller.abort();

    expect((await outcomes)[0]).toEqual({ slot: 1, kind: "aborted" });
  });
});

describe("money on a portrait slot", () => {
  test("a moderation refusal is free, never retried, and not ranked", async () => {
    const net = network({ image: (_call, n) => (n === 2 ? MODERATION : image()) });
    const { outcomes, ranked } = run(net);

    const results = await outcomes;
    expect(results[1]).toMatchObject({ slot: 2, kind: "failed", error: { code: "MODERATION_REFUSED" }, fatal: false, reserveLeftOpen: false });
    expect(money.lines().find((l) => l.type === "settle" && l.attemptId === `${JOB_ID}:portrait-2#1`)).toMatchObject({ costMicros: 0 });
    expect(net.imageCalls()).toHaveLength(5);
    expect(ranked).toEqual([1, 3, 4, 5]);
  });

  test("a timeout leaves the image's reserve open at its worst case", async () => {
    const net = network({ image: (_call, n) => (n === 1 ? { hang: true } : image()) });
    const { outcomes } = run(net, { clientOverrides: { timeoutMs: 20 } });

    expect((await outcomes)[0]).toMatchObject({ slot: 1, kind: "failed", error: { code: "TIMEOUT" }, fatal: false, reserveLeftOpen: true });
    expect(money.lines().filter((l) => l.attemptId === `${JOB_ID}:portrait-1#1`)).toMatchObject([{ type: "reserve", worstMicros: IMAGE_WORST }]);
  });

  test("a bill above the worst case fails its slot fatally, and no later slot is reserved", async () => {
    const net = network({ image: () => ({ status: 200, body: imageBody(PORTRAIT, { cost: 6 }) }) });
    const { outcomes, ranked } = run(net);

    const results = await outcomes;
    expect(results[0]).toMatchObject({ slot: 1, kind: "failed", error: { code: "SETTLE_ABOVE_WORST" }, fatal: true });
    expect(results.slice(1).every((o) => o.kind === "skipped")).toBe(true);
    expect([net.imageCalls().length, ranked.length]).toEqual([1, 0]);
  });
});

function failedSlot(slot: number, code: EngineError["code"], fatal = false): SlotOutcome {
  return { slot, kind: "failed", error: { code }, fatal, reserveLeftOpen: false };
}

describe("how a portrait batch ends", () => {
  test("done lists the candidates best first, ties by photo id, with every other slot and why", () => {
    const end = portraitJobEnd(
      [
        { slot: 1, kind: "passed", photoId: "photo-00000001", likeness: 0.61 },
        { slot: 2, kind: "passed", photoId: "photo-00000002", likeness: 0.76 },
        { slot: 3, kind: "passed", photoId: "photo-00000004", likeness: 0.72 },
        { slot: 4, kind: "passed", photoId: "photo-00000003", likeness: 0.72 },
        { slot: 5, kind: "ranked-out", why: "unlike", likeness: 0.48 },
      ],
      false,
    );

    expect(end).toEqual({
      status: "done",
      candidates: [
        { photoId: "photo-00000002", likeness: 0.76 },
        { photoId: "photo-00000003", likeness: 0.72 },
        { photoId: "photo-00000004", likeness: 0.72 },
        { photoId: "photo-00000001", likeness: 0.61 },
      ],
      failedSlots: [{ slot: 5, reason: "unlike", likeness: 0.48 }],
    });
  });

  test("done with no candidate when every image was ranked out: the paid attempts reached a verdict", () => {
    const end = portraitJobEnd(
      [
        { slot: 1, kind: "ranked-out", why: "unlike", likeness: 0.4 },
        { slot: 2, kind: "ranked-out", why: "no-face" },
        { slot: 3, kind: "ranked-out", why: "multiple-faces" },
        { slot: 4, kind: "ranked-out", why: "unlike", likeness: 0.52 },
        failedSlot(5, "MODERATION_REFUSED"),
      ],
      false,
    );

    expect(end).toEqual({
      status: "done",
      candidates: [],
      failedSlots: [
        { slot: 1, reason: "unlike", likeness: 0.4 },
        { slot: 2, reason: "no-face" },
        { slot: 3, reason: "multiple-faces" },
        { slot: 4, reason: "unlike", likeness: 0.52 },
        { slot: 5, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false },
      ],
    });
  });

  test("done when the age check judged an image, even with nothing else", () => {
    const end = portraitJobEnd([{ slot: 1, kind: "rejected", why: "not-adult" }, ...[2, 3, 4, 5].map((slot) => failedSlot(slot, "NETWORK"))], false);

    expect(end).toMatchObject({ status: "done", candidates: [] });
    expect(end.status === "done" && end.failedSlots[0]).toEqual({ slot: 1, reason: "age-rejected" });
  });

  test("failed with the first slot's error when every slot failed before any verdict", () => {
    const end = portraitJobEnd([1, 2, 3, 4, 5].map((slot) => failedSlot(slot, slot === 1 ? "MODERATION_REFUSED" : "NETWORK")), false);

    expect(end).toEqual({ status: "failed", error: { code: "MODERATION_REFUSED" } });
  });

  test("failed when a slot failed fatally, even with candidates already stored", () => {
    const end = portraitJobEnd([{ slot: 1, kind: "passed", photoId: "photo-00000001", likeness: 0.7 }, failedSlot(2, "AUTH_INVALID", true), ...[3, 4, 5].map((slot): SlotOutcome => ({ slot, kind: "skipped" }))], false);

    expect(end).toEqual({ status: "failed", error: { code: "AUTH_INVALID" } });
  });

  test("cancelled when a cancel stopped a slot", () => {
    const end = portraitJobEnd([{ slot: 1, kind: "passed", photoId: "photo-00000001", likeness: 0.7 }, { slot: 2, kind: "aborted" }, ...[3, 4, 5].map((slot): SlotOutcome => ({ slot, kind: "skipped" }))], true);

    expect(end).toEqual({ status: "cancelled" });
  });

  test("a cancel asked after every slot had finished does not turn a done batch into a cancelled one", () => {
    const end = portraitJobEnd([1, 2, 3, 4, 5].map((slot): SlotOutcome => ({ slot, kind: "passed", photoId: `photo-0000000${slot}`, likeness: 0.7 })), true);

    expect(end.status).toBe("done");
  });

  test("the candidates' own end ignores a ranked-out slot: it is no candidate and not a failed slot", () => {
    const end = candidateJobEnd([{ slot: 1, kind: "passed", photoId: "photo-00000001" }, { slot: 2, kind: "ranked-out", why: "no-face" }, ...[3, 4].map((slot): SlotOutcome => ({ slot, kind: "skipped" }))], false);

    expect(end).toEqual({ status: "done", photoIds: ["photo-00000001"], failedSlots: [] });
  });
});
