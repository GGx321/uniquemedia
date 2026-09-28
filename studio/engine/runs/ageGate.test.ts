import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhotoSidecar } from "../library";
import type { PlanSlot } from "../scenes";
import { MAX_ATTEMPT_MS } from "../openrouter/transport";
import { AGE_CHECK_CALL } from "../money/estimate";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { asLibraryReference, chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply } from "../openrouter/testing/fakes";
import { AGE_GATE_NAME, GateFailure, type QaInput } from "./qa";
import { ageGateAttemptId, createAgeGate } from "./ageGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a: the image age gate. Reuses studio/engine/avatars/ageCheck.ts's
// question, schema and verdict rules as-is (no second age-check
// implementation) around the real OpenRouter client (T3) over a fake fetch,
// a real ledger + Budget (T2).
//
// T7a whole-slice review: `reject` is a verdict for doubt about THIS photo
// only — a refusal to judge it, an unreadable or empty answer, or a clear
// "no" (findings 2 and 6). Everything else the age check's own request can
// fail with (a rate limit, a network error, an invalid key, its own reserve
// refused) is classified exactly like an image attempt's own failure
// (runs/failures.ts's classifyFailure) and thrown as a `GateFailure`, never
// silently turned into a rejected photo — runJob.ts (tested at the run
// level in runJob.test.ts) is what decides whether that stops only this
// slot (a budget/cap limit) or the whole run.

const SLOT: PlanSlot = {
  slotIndex: 1,
  attemptIdBase: "slot-1",
  location: "kitchen",
  timeOfDay: "morning",
  activity: "making coffee",
  outfit: "robe",
  category: "home",
  shot: "candid",
  pose: "front",
  repeatedPair: false,
};
const MODERATION: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
const JPEG_OUT = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);

let dir = "";
let PORTRAIT = new Uint8Array();
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-age-gate-test-"));
  const path = join(dir, "portrait.png");
  const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "mandelbrot=size=100x100", "-frames:v", "1", path]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render the portrait: ${r.stderr.toString()}`);
  PORTRAIT = new Uint8Array(readFileSync(path));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ageAnswer(adult: boolean, confidence: number, reason = "Mature features of a woman in her mid-20s."): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ adult, confidence, reason }), { cost: 0.0014 }) };
}

const opened: Money[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((m) => m.cleanup()));
});
async function money(overrides: Parameters<typeof setupMoney>[0] = {}): Promise<Money> {
  const m = await setupMoney(overrides);
  opened.push(m);
  return m;
}

function input(m: Money, overrides: Partial<QaInput> = {}): QaInput {
  return {
    runId: "run-1",
    jobId: "job-1",
    avatarId: "avatar-1",
    attemptId: "run-1:slot-1#1",
    scope: { runId: "run-1" },
    budget: m.budget,
    priceBook: m.priceBook,
    slot: SLOT,
    image: { bytes: PORTRAIT, mediaType: "image/png", width: 100, height: 100 },
    signal: new AbortController().signal,
    chat: () => {
      throw new Error("test forgot to override chat");
    },
    beforeSend: () => true,
    photosByAvatar: (): readonly PhotoSidecar[] => [],
    master: asLibraryReference(Uint8Array.of(0xff, 0xd8, 0xff)),
    decodeImage: () => {
      throw new Error("must not be called: the age gate never decodes for identity");
    },
    ...overrides,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("createAgeGate: identity", () => {
  test("name is AGE_GATE_NAME ('age') and it is paid, with a timeout at least the client's own worst-case attempt bound (T7a review, finding 5)", () => {
    const gate = createAgeGate();
    expect(gate.name).toBe(AGE_GATE_NAME);
    expect(gate.paid).toBe(true);
    expect(gate.timeoutMs ?? 0).toBeGreaterThanOrEqual(MAX_ATTEMPT_MS);
  });
});

describe("createAgeGate: against the real client, a fake fetch and a real ledger", () => {
  test("passes a clear adult answer, with qa.age carrying the verdict, and settles the age attempt id derived from the image's own", async () => {
    const m = await money();
    const net = fakeFetch([ageAnswer(true, 0.95)]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m, { attemptId: "run-1:slot-3#2", chat: client.chat }));

    expect(verdict).toEqual({ verdict: "pass", qa: { age: { adult: true, confidence: 0.95 } } });
    const ageId = ageGateAttemptId("run-1:slot-3#2");
    expect(m.ledger.reserveOf(ageId)).toBeDefined();
    expect(m.ledger.closeOf(ageId)?.type).toBe("settle");
    expect(net.calls).toHaveLength(1);
  });

  test("T7a re-review (finding L2): the age call's own actual reserve equals the ceiling the run's own estimate prices for it (AGE_CHECK_CALL, priceBook.chatWorstCase — the estimate's own formula, money/estimate.ts and runs/remaining.ts, not the client's own chatAttemptWorstMicros compared to itself)", async () => {
    const m = await money();
    const net = fakeFetch([ageAnswer(true, 0.95)]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    await gate.check(input(m, { chat: client.chat }));

    const reserve = m.ledger.reserveOf(ageGateAttemptId("run-1:slot-1#1"));
    if (reserve === undefined) throw new Error("expected a reserve for the age attempt");
    // The run's own estimate (money/estimate.ts:163, runs/remaining.ts:39) prices the age check
    // straight from AGE_CHECK_CALL's own ceilings, with no prompt-token floor computed from the
    // actual messages — unlike chatAttemptWorstMicros, which the client uses to size ITS OWN
    // reserve. Comparing against that same client formula would only prove it agrees with itself;
    // this instead proves the client's real reserve never exceeds what the run's cap already paid
    // for, independent of how the client happens to compute its own number.
    const expected = m.priceBook.chatWorstCase({
      model: AGE_CHECK_CALL.model,
      maxTokens: AGE_CHECK_CALL.maxTokens,
      inputTokens: AGE_CHECK_CALL.inputTokens,
      images: AGE_CHECK_CALL.images,
    });
    expect(reserve.worstMicros).toBe(expected);
  });

  test("forwards beforeSend into its own chat call (T6 review L1)", async () => {
    const m = await money();
    const net = fakeFetch([]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const verdict = await rejectionOf(gate.check(input(m, { chat: client.chat, beforeSend: () => false })));

    // beforeSend false: the client's own transport ends the attempt as "aborted" without sending — this
    // gate reads that (with input.signal itself never aborted) as "the run had already stopped sending".
    expect(verdict).toBeInstanceOf(Error);
    expect(net.calls).toHaveLength(0);
  });

  test("rejects (never retries, never throws) a clear no", async () => {
    const m = await money();
    const net = fakeFetch([ageAnswer(false, 0.95, "Facial proportions consistent with a minor.")]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m, { chat: client.chat }));

    expect(verdict.verdict).toBe("reject");
  });

  test("rejects low confidence, doubt in the reason, and an unreadable answer, all the same way ageCheck.ts already does", async () => {
    for (const reply of [ageAnswer(true, 0.5), ageAnswer(true, 0.95, "Hard to tell, could be a teenager."), { status: 200, body: chatBody("not json") }] as Reply[]) {
      const m = await money();
      const net = fakeFetch([reply]);
      const { client } = makeClient(net.fetch);
      const gate = createAgeGate({ downscale: async () => JPEG_OUT });

      const verdict = await gate.check(input(m, { chat: client.chat }));
      expect(verdict.verdict).toBe("reject");
    }
  });

  test("rejects a moderation refusal to judge the image", async () => {
    const m = await money();
    const net = fakeFetch([MODERATION]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m, { chat: client.chat }));

    expect(verdict.verdict).toBe("reject");
  });

  test("rejects an empty-content answer", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 200, body: chatBody(null) }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m, { chat: client.chat }));

    expect(verdict.verdict).toBe("reject");
  });

  test("T7a review (findings 2, 6): a persistent 429 THROWS a GateFailure carrying RATE_LIMITED — this deliberately replaces the old 'rejects a persistent 429' test, which pinned the wrong behaviour", async () => {
    const m = await money();
    const net = fakeFetch(Array.from({ length: 4 }, () => ({ status: 429, body: {} }) as Reply));
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const error = await rejectionOf(gate.check(input(m, { chat: client.chat })));

    expect(error).toBeInstanceOf(GateFailure);
    expect((error as GateFailure).error.code).toBe("RATE_LIMITED");
  });

  test("T7a review (finding 2): TIMEOUT also throws — the run stops and the slot stays open for a resume, consistent with T6 H1, never a silent per-photo reject", async () => {
    const m = await money();
    const net = fakeFetch([{ hangForever: true }]);
    const { client } = makeClient(net.fetch, { timeoutMs: 20 });
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const error = await rejectionOf(gate.check(input(m, { chat: client.chat })));

    expect(error).toBeInstanceOf(GateFailure);
    expect((error as GateFailure).error.code).toBe("TIMEOUT");
  });

  test("a network error throws a GateFailure carrying NETWORK", async () => {
    const m = await money();
    const net = fakeFetch([{ reject: new TypeError("fetch failed") }, { reject: new TypeError("fetch failed") }, { reject: new TypeError("fetch failed") }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const error = await rejectionOf(gate.check(input(m, { chat: client.chat })));

    expect(error).toBeInstanceOf(GateFailure);
    expect((error as GateFailure).error.code).toBe("NETWORK");
  });

  test("a systemic 4xx (e.g. a 404 at the age model) throws a GateFailure, never rejects the photo", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 404, body: { error: { message: "No endpoints found for x-ai/grok-4.3" } } }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const error = await rejectionOf(gate.check(input(m, { chat: client.chat })));

    expect(error).toBeInstanceOf(GateFailure);
    expect((error as GateFailure).error.code).toBe("INTERNAL");
  });

  test("throws a GateFailure carrying AUTH_INVALID on an invalid key (401): the gate cannot run at all with it", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 401, body: { error: { message: "invalid API key" } } }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const error = await rejectionOf(gate.check(input(m, { chat: client.chat })));

    expect(error).toBeInstanceOf(GateFailure);
    expect((error as GateFailure).error.code).toBe("AUTH_INVALID");
  });

  test("T7a review (finding 7): billed above the reserved worst case keeps the verdict — the image is paid for and passed — rather than throwing it away", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "Adult." }), { cost: 999 }) }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m, { chat: client.chat }));

    expect(verdict).toEqual({ verdict: "pass", qa: { age: { adult: true, confidence: 0.95 } } });
    // The ledger itself is now halted (SETTLE_ABOVE_WORST) — runJob.ts's own runGates notices this via
    // Budget.status() right after the gate returns and stops the run there; this gate does not do that.
    expect(m.budget.status().haltCause).toBe("SETTLE_ABOVE_WORST");
  });

  test("T7a review (finding 8): the run's own cap having no room throws a GateFailure carrying RUN_CAP_EXCEEDED — runJob.ts reads this as a limit (this slot only), never a rejected photo. This deliberately replaces the old 'rejects when the run's own cap has no room' test, which pinned the wrong verdict", async () => {
    const m = await money({ runCapMicros: 1 }); // far below even one age check's worst case
    const net = fakeFetch([]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });

    const error = await rejectionOf(gate.check(input(m, { chat: client.chat })));

    expect(error).toBeInstanceOf(GateFailure);
    expect((error as GateFailure).error.code).toBe("RUN_CAP_EXCEEDED");
    expect(net.calls).toHaveLength(0); // the reserve was refused before anything was sent
  });

  test("settles promptly on an abort mid-request: aborts its own HTTP call and propagates the signal's reason, leaving the reserve open for reconcile", async () => {
    const m = await money();
    const net = fakeFetch([{ hang: true }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ downscale: async () => JPEG_OUT });
    const controller = new AbortController();
    const reason = new Error("run cancelled");

    const promise = gate.check(input(m, { signal: controller.signal, chat: client.chat }));
    for (let i = 0; i < 1000 && net.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    if (net.calls.length === 0) throw new Error("timed out waiting for the age check's request to actually be sent");
    controller.abort(reason);

    expect(await rejectionOf(promise)).toBe(reason);
    const ageId = ageGateAttemptId("run-1:slot-1#1");
    expect(m.ledger.reserveOf(ageId)).toBeDefined();
    expect(m.ledger.closeOf(ageId)).toBeUndefined(); // left open: the request may have reached OpenRouter
    expect(m.ledger.openReserves().map((r) => r.attemptId)).toContain(ageId);
  });
});

describe("createAgeGate: preparing the image (downscale)", () => {
  test("an ordinary downscale failure rejects, and never reserves — the age check is never sent for an image that could not be prepared", async () => {
    const m = await money();
    const gate = createAgeGate({
      downscale: async () => {
        throw new Error("ffmpeg exited with code 1: garbled data");
      },
    });

    const verdict = await gate.check(input(m));

    expect(verdict.verdict).toBe("reject");
    expect(m.ledger.reserveOf(ageGateAttemptId("run-1:slot-1#1"))).toBeUndefined();
  });

  test("a spawn failure (ffmpeg missing) throws: the gate cannot run at all", async () => {
    const m = await money();
    const spawnError = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const gate = createAgeGate({
      downscale: async () => {
        throw spawnError;
      },
    });

    await expect(gate.check(input(m))).rejects.toThrow();
  });

  test("an abort while decoding the image propagates (runJob.ts's own wrapper decides dropped vs broken), unlike an abort mid-request", async () => {
    const m = await money();
    const controller = new AbortController();
    const reason = new Error("cancelled while preparing the image");
    const gate = createAgeGate({
      downscale: (_bytes, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });

    const promise = gate.check(input(m, { signal: controller.signal }));
    controller.abort(reason);

    expect(await rejectionOf(promise)).toBe(reason);
  });
});
