import { afterEach, describe, expect, test } from "bun:test";
import { computePdqHash } from "../../../src/core/pdq/pdq";
import type { PlanSlot } from "../scenes";
import { PDQ_GRAY_FRAME_BYTES } from "../../node/pdqPixels";
import { setupMoney, type Money } from "../openrouter/testing/fakes";
import type { QaInput } from "./qa";
import { createPdqGate, PDQ_GATE_NAME } from "./pdqGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a: the pdq near-duplicate gate — always on, free. Wraps pdqPixels.ts's
// ffmpeg decode and src/core/pdq's own hash function around pdqClaims.ts's
// dedup bookkeeping (tested on its own, with hand-built hashes, in
// pdqClaims.test.ts); this file pins the gate's OWN wiring: what it does
// with a decode failure, an abort, a known duplicate, and its releaseClaim
// extension — not the threshold's exact boundary again. `budget`/`priceBook`
// are QaInput's own required fields; this free gate never touches either.

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

const opened: Money[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((m) => m.cleanup()));
});

async function money(): Promise<Money> {
  const m = await setupMoney();
  opened.push(m);
  return m;
}

function input(overrides: Partial<QaInput> = {}, money_: Money): QaInput {
  return {
    runId: "run-1",
    jobId: "job-1",
    avatarId: "avatar-1",
    attemptId: "run-1:slot-1#1",
    scope: { runId: "run-1" },
    budget: money_.budget,
    priceBook: money_.priceBook,
    slot: SLOT,
    image: { bytes: Uint8Array.of(1, 2, 3), mediaType: "image/png", width: 100, height: 100 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A 64x64 grayscale frame, every byte set to `fill`. A flat frame's DCT has no AC energy at all (every coefficient sits exactly at the median), so every flat frame — whatever its fill value — hashes identically; good enough for "is this the same image again", useless for "are these two images actually different". */
function gray64(fill: number): Uint8Array {
  return new Uint8Array(PDQ_GRAY_FRAME_BYTES).fill(fill);
}

/** A non-flat 64x64 grayscale frame whose hash genuinely differs by seed (checked against src/core/pdq's own hash: seed 1 vs 2 sit 158 of 256 bits apart). */
function patternGray64(seed: number): Uint8Array {
  const gray = new Uint8Array(PDQ_GRAY_FRAME_BYTES);
  for (let i = 0; i < gray.length; i++) gray[i] = (i * 37 + seed * 91) % 256;
  return gray;
}

function hexOf(gray: Uint8Array): string {
  return Buffer.from(computePdqHash(gray)).toString("hex");
}

describe("createPdqGate", () => {
  test("name is 'pdq' and it is free", () => {
    const gate = createPdqGate({ knownHashesFor: () => [] });
    expect(gate.name).toBe(PDQ_GATE_NAME);
    expect(gate.paid).toBe(false);
  });

  test("passes a first-ever image (empty library) with its own PDQ hash as hex in qa.pdq", async () => {
    const m = await money();
    const frame = gray64(10);
    const gate = createPdqGate({ knownHashesFor: () => [], decode: async () => frame });

    const verdict = await gate.check(input({}, m));

    expect(verdict).toEqual({ verdict: "pass", qa: { pdq: hexOf(frame) } });
  });

  test("retries a near-duplicate of an already-stored photo (knownHashesFor)", async () => {
    const m = await money();
    const frame = gray64(20);
    const knownHex = hexOf(frame); // the exact same hash: distance 0, always within any positive threshold
    const gate = createPdqGate({ knownHashesFor: () => [knownHex], decode: async () => frame });

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
    expect(verdict.verdict === "retry" ? verdict.reason : "").toContain("near-duplicate");
  });

  test("two concurrent near-identical images: exactly one passes, the other retries", async () => {
    const m = await money();
    const frame = gray64(30);
    let resolveA: (() => void) | undefined;
    const gate = createPdqGate({
      knownHashesFor: () => [],
      decode: async (bytes) => {
        // attempt#1's own decode pauses until attempt#2's has also started, so both compare at roughly the same time —
        // the atomicity pdqClaims.ts's own tests already pin (no await inside the compare-and-claim step) is what
        // actually prevents the race; this only proves the gate wires that guarantee through, not race it directly.
        if (bytes[0] === 1) {
          await new Promise<void>((resolve) => {
            resolveA = resolve;
          });
        }
        return frame;
      },
    });

    const a = gate.check(input({ attemptId: "run-1:slot-1#1", image: { bytes: Uint8Array.of(1), mediaType: "image/png", width: 1, height: 1 } }, m));
    const b = gate.check(input({ attemptId: "run-1:slot-2#1", image: { bytes: Uint8Array.of(2), mediaType: "image/png", width: 1, height: 1 } }, m));
    await Promise.resolve(); // let b's decode (which never awaits) run to completion and claim first
    resolveA?.();
    const [verdictA, verdictB] = await Promise.all([a, b]);

    const verdicts = [verdictA.verdict, verdictB.verdict].sort();
    expect(verdicts).toEqual(["pass", "retry"]);
  });

  test("a decoder that throws an ordinary error retries (an image the gate cannot judge)", async () => {
    const m = await money();
    const gate = createPdqGate({
      knownHashesFor: () => [],
      decode: async () => {
        throw new Error("ffmpeg exited with code 1: garbled data");
      },
    });

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
    expect(verdict.verdict === "retry" ? verdict.reason : "").toContain("could not be decoded");
  });

  test("a decoder that throws a spawn failure (ffmpeg missing) throws: the gate cannot run at all", async () => {
    const m = await money();
    const spawnError = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const gate = createPdqGate({
      knownHashesFor: () => [],
      decode: async () => {
        throw spawnError;
      },
    });

    await expect(gate.check(input({}, m))).rejects.toThrow(/ffmpeg is missing/);
  });

  test("an abort while decoding rejects (the run job's own wrapper decides whether that means dropped or broken), never resolving with a verdict", async () => {
    const m = await money();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const gate = createPdqGate({
      knownHashesFor: () => [],
      decode: (_bytes, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });

    const promise = gate.check(input({ signal: controller.signal }, m));
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
  });

  test("releaseClaim frees a claimed hash so a later, different attempt with the same hash is not blocked", async () => {
    const m = await money();
    const frame = gray64(40);
    const gate = createPdqGate({ knownHashesFor: () => [], decode: async () => frame });

    const first = await gate.check(input({ attemptId: "run-1:slot-1#1" }, m));
    expect(first.verdict).toBe("pass");

    // Without releasing, a second image with the same hash would be caught as a pending duplicate.
    const second = await gate.check(input({ attemptId: "run-1:slot-2#1" }, m));
    expect(second.verdict).toBe("retry");

    gate.releaseClaim("avatar-1", "run-1:slot-1#1");

    const third = await gate.check(input({ attemptId: "run-1:slot-3#1" }, m));
    expect(third.verdict).toBe("pass");
  });

  test("a configured maxHammingDistance is honoured: 0 means only an exact hash match blocks", async () => {
    const m = await money();
    const knownHex = hexOf(patternGray64(1));
    const different = patternGray64(2); // 158 of 256 bits apart from patternGray64(1) — nowhere near a duplicate at 0
    const gate = createPdqGate({ knownHashesFor: () => [knownHex], decode: async () => different, config: { pdq: { maxHammingDistance: 0 } } });

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("pass");
  });

  test("a configured maxHammingDistance is honoured: a wide config still catches a distant near-duplicate the default would not", async () => {
    const m = await money();
    const knownHex = hexOf(patternGray64(1));
    const different = patternGray64(2); // 158 of 256 bits apart
    const gate = createPdqGate({ knownHashesFor: () => [knownHex], decode: async () => different, config: { pdq: { maxHammingDistance: 200 } } });

    const verdict = await gate.check(input({}, m));

    expect(verdict.verdict).toBe("retry");
  });
});
