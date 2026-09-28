import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanSlot } from "../scenes";
import { REQUEST_TIMEOUT_MS } from "../money/budget";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply } from "../openrouter/testing/fakes";
import type { ChatResult } from "../openrouter/types";
import type { QaInput } from "./qa";
import { AGE_GATE_NAME, ageGateAttemptId, createAgeGate } from "./ageGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a: the image age gate. Reuses studio/engine/avatars/ageCheck.ts's
// question, schema and verdict rules as-is (no second age-check
// implementation) around the real OpenRouter client (T3) over a fake fetch,
// a real ledger + Budget (T2), and a fake downscale (the real one is
// pdqPixels.test.ts's sibling downscale.test.ts's own territory).

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
  test("name is AGE_GATE_NAME ('age') and it is paid, with a timeout at least the client's own request bound", () => {
    const gate = createAgeGate({ chat: async () => {
      throw new Error("not used in this test");
    } });
    expect(gate.name).toBe(AGE_GATE_NAME);
    expect(gate.paid).toBe(true);
    expect(gate.timeoutMs ?? 0).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
  });
});

describe("createAgeGate: against the real client, a fake fetch and a real ledger", () => {
  test("passes a clear adult answer, with qa.age carrying the verdict, and settles the age attempt id derived from the image's own", async () => {
    const m = await money();
    const net = fakeFetch([ageAnswer(true, 0.95)]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m, { attemptId: "run-1:slot-3#2" }));

    expect(verdict).toEqual({ verdict: "pass", qa: { age: { adult: true, confidence: 0.95 } } });
    const ageId = ageGateAttemptId("run-1:slot-3#2");
    expect(m.ledger.reserveOf(ageId)).toBeDefined();
    expect(m.ledger.closeOf(ageId)?.type).toBe("settle");
    expect(net.calls).toHaveLength(1);
  });

  test("rejects (never retries) a clear no", async () => {
    const m = await money();
    const net = fakeFetch([ageAnswer(false, 0.95, "Facial proportions consistent with a minor.")]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m));

    expect(verdict.verdict).toBe("reject");
  });

  test("rejects low confidence, doubt in the reason, and an unreadable answer, all the same way ageCheck.ts already does", async () => {
    for (const reply of [ageAnswer(true, 0.5), ageAnswer(true, 0.95, "Hard to tell, could be a teenager."), { status: 200, body: chatBody("not json") }] as Reply[]) {
      const m = await money();
      const net = fakeFetch([reply]);
      const { client } = makeClient(net.fetch);
      const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

      const verdict = await gate.check(input(m));
      expect(verdict.verdict).toBe("reject");
    }
  });

  test("rejects a moderation refusal to judge the image", async () => {
    const m = await money();
    const net = fakeFetch([MODERATION]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m));

    expect(verdict.verdict).toBe("reject");
  });

  test("rejects an empty-content answer", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 200, body: chatBody(null) }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m));

    expect(verdict.verdict).toBe("reject");
  });

  test("rejects a persistent 429 (rate-limited) rather than retrying or throwing", async () => {
    const m = await money();
    const net = fakeFetch(Array.from({ length: 8 }, () => ({ status: 429, body: {} }) as Reply));
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m));

    expect(verdict.verdict).toBe("reject");
  });

  test("throws on an invalid key (401): the gate cannot run at all with it", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 401, body: { error: { message: "invalid API key" } } }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    await expect(gate.check(input(m))).rejects.toThrow();
  });

  test("throws when billed above the reserved worst case (the price table is wrong): systemic, not this photo's doubt", async () => {
    const m = await money();
    const net = fakeFetch([{ status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "Adult." }), { cost: 999 }) }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    await expect(gate.check(input(m))).rejects.toThrow();
  });

  test("rejects (never throws) when the run's own cap has no room left for this attempt: this attempt cannot be judged, but the run itself is not broken", async () => {
    const m = await money({ runCapMicros: 1 }); // far below even one age check's worst case
    const net = fakeFetch([]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });

    const verdict = await gate.check(input(m));

    expect(verdict.verdict).toBe("reject");
    expect(net.calls).toHaveLength(0); // the reserve was refused before anything was sent
  });

  test("settles promptly on an abort mid-request: aborts its own HTTP call and rejects, leaving the reserve open for reconcile", async () => {
    const m = await money();
    const net = fakeFetch([{ hang: true }]);
    const { client } = makeClient(net.fetch);
    const gate = createAgeGate({ chat: client.chat, downscale: async () => JPEG_OUT });
    const controller = new AbortController();

    const promise = gate.check(input(m, { signal: controller.signal }));
    for (let i = 0; i < 1000 && net.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    if (net.calls.length === 0) throw new Error("timed out waiting for the age check's request to actually be sent");
    controller.abort(new Error("run cancelled"));
    const verdict = await promise;

    expect(verdict.verdict).toBe("reject");
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
      chat: async () => {
        throw new Error("must not be called");
      },
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
      chat: async () => {
        throw new Error("must not be called");
      },
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
      chat: async () => {
        throw new Error("must not be called");
      },
      downscale: (_bytes, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });

    const promise = gate.check(input(m, { signal: controller.signal }));
    controller.abort(reason);

    expect(await rejectionOf(promise)).toBe(reason);
  });
});
