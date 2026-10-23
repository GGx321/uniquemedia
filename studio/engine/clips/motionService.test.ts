import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirFor } from "../../testing/tempDir";
import { openLibrary, type Library } from "../library";
import { chatBody, fakeFetch, JPEG, makeClient, setupMoney, type Money, type Step } from "../openrouter/testing/fakes";
import { EngineFailure } from "../engineFailure";
import { scopeKey } from "../money/budget";
import { ClipMotions, type ClipMotionsDeps } from "./motionService";
import { suggestPrice, translatePrice } from "./motionPrice";
import { GOOD_MOTION, timerFrame } from "./testing/motionKit";
import { seedClipAvatar } from "./testing/engineClipKit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(30_000);

// Stage 5, 5b.2, S5.WC3 (plan s5b2 I5.68): what a part C call does after its last await. `#pendingDelete` and the library are looked at again then: an avatar that is being deleted, or a library that was
// switched away, gets NOT_FOUND and nothing stored, although the call was paid. A store that cannot be written after a paid call is `none` with the cost, never a lost bill.

const dir = tempDirFor({ beforeEach, afterEach }, "studio-motion-service-");

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

interface Rig {
  readonly motions: ClipMotions;
  readonly library: Library;
  readonly avatarId: string;
  readonly photoId: string;
  readonly state: { deleting: boolean; current: Library | null; paid: number; caps: ["set" | "clear", string, number][]; timeouts: number[]; onPrices: (() => void) | undefined };
  readonly logs: string[];
  readonly storeDir: string;
}

const reply = (content: object, cost = 0.0034): Step => ({ status: 200, body: chatBody(JSON.stringify(content), { cost }) });
const GOOD_ANSWER = { motions: [{ label_ru: "Поправляет прядь", text_en: GOOD_MOTION }], frame: { capture: "timer", phoneVisible: false, faceVisible: true } };

async function rig(steps: (state: Rig["state"]) => Step[], extra: Partial<ClipMotionsDeps> = {}): Promise<Rig> {
  const libraryDir = join(dir(), "library");
  await mkdir(libraryDir, { recursive: true });
  const seeded = await seedClipAvatar(libraryDir);
  const { library } = await openLibrary(libraryDir);
  const state: Rig["state"] = { deleting: false, current: library, paid: 0, caps: [], timeouts: [], onPrices: undefined };
  const net = fakeFetch(steps(state));
  const { client } = makeClient(net.fetch);
  const logs: string[] = [];
  const deps: ClipMotionsDeps = {
    newId: () => "job-00000007",
    now: () => "2026-10-15T10:00:00.000Z",
    unitHeld: () => false,
    currentLibrary: () => state.current,
    liveLibrary: async () => library,
    usableKey: () => "sk-test",
    paidBudget: () => money.budget,
    photoOf: (lib, avatarId, photoId) => {
      const photo = lib.getPhoto(photoId);
      if (photo === undefined || photo.avatarId !== avatarId) throw new EngineFailure({ code: "NOT_FOUND", detail: "no such photo" });
      return photo;
    },
    assertAvatarOnDisk: async () => undefined,
    facts: async () => ({ kind: "suitable", facts: timerFrame(), bytes: JPEG }),
    prices: async () => {
      state.onPrices?.();
      return { book: money.priceBook, asOf: "2026-09-24" };
    },
    textModel: () => "x-ai/grok-4.3",
    checkAccepted: () => undefined,
    checkMonthlyRoom: () => undefined,
    paidStart: () => void state.paid++,
    paidEnd: () => void state.paid--,
    setCap: (key, micros) => void state.caps.push(["set", key, micros]),
    clearCap: (key) => void state.caps.push(["clear", key, 0]),
    openRouter: (_key, timeoutMs) => {
      state.timeouts.push(timeoutMs ?? -1);
      return client;
    },
    callTimeoutMs: 60_000,
    downscaleTimeoutMs: 30_000,
    emitMoney: () => undefined,
    markKeyRejected: () => undefined,
    pendingDelete: () => state.deleting,
    downscale: async () => JPEG,
    log: (line) => logs.push(line),
    ...extra,
  };
  return { motions: new ClipMotions(deps), library, avatarId: seeded.avatarId, photoId: seeded.photoId, state, logs, storeDir: join(library.avatarDirPath(seeded.avatarId), "motions") };
}

describe("after the last await", () => {
  test("an avatar delete prepared while the writer's chat runs: NOT_FOUND, nothing stored, and the paid call is settled in the ledger", async () => {
    const r = await rig((state) => [
      () => {
        state.deleting = true;
        return { status: 200, body: chatBody(JSON.stringify(GOOD_ANSWER), { cost: 0.0034 }) };
      },
    ]);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(existsSync(r.storeDir)).toBe(false);
    expect(money.lines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([3_400]);
    expect(money.ledger.openReserves()).toEqual([]);
  });

  test("the same for the translator's call", async () => {
    const r = await rig((state) => [
      () => {
        state.deleting = true;
        return { status: 200, body: chatBody(JSON.stringify({ text_en: GOOD_MOTION, refusal: "none" }), { cost: 0.001 }) };
      },
    ]);
    await expect(r.motions.translateIdea({ avatarId: r.avatarId, photoId: r.photoId, text: "поворачивает голову", acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(existsSync(r.storeDir)).toBe(false);
  });

  test("a library switched away while the call runs: NOT_FOUND, nothing stored", async () => {
    const r = await rig((state) => [
      () => {
        state.current = null;
        return { status: 200, body: chatBody(JSON.stringify(GOOD_ANSWER), { cost: 0.0034 }) };
      },
    ]);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(existsSync(r.storeDir)).toBe(false);
  });

  test("a moderation refusal ends the same way for a deleted avatar: NOT_FOUND, never a `none` for a folder that is gone", async () => {
    const r = await rig((state) => [
      () => {
        state.deleting = true;
        return { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
      },
    ]);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("before the reserve: the avatar is looked at again after the price read (round 3, L2)", () => {
  test("a delete prepared while the translator's price is read: NOT_FOUND, no reserve, no ledger line, no chat, no cap", async () => {
    const r = await rig(() => []);
    r.state.onPrices = () => void (r.state.deleting = true);
    await expect(r.motions.translateIdea({ avatarId: r.avatarId, photoId: r.photoId, text: "поворачивает голову", acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(money.lines()).toEqual([]);
    expect(r.state.caps).toEqual([]);
    expect([r.motions.running(), r.state.paid]).toEqual([0, 0]);
  });

  test("the same for the writer's price read", async () => {
    const r = await rig(() => []);
    r.state.onPrices = () => void (r.state.deleting = true);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(money.lines()).toEqual([]);
    expect(r.state.caps).toEqual([]);
  });

  test("a library switched away while the price is read: NOT_FOUND before any reserve", async () => {
    const r = await rig(() => []);
    r.state.onPrices = () => void (r.state.current = null);
    await expect(r.motions.translateIdea({ avatarId: r.avatarId, photoId: r.photoId, text: "поворачивает голову", acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(money.lines()).toEqual([]);
  });
});

describe("the call's cap", () => {
  const SCOPE_KEY = scopeKey({ avatarJobId: "job-00000007" });
  const priced = () => ({ book: money.priceBook, asOf: "2026-09-24" });

  test("the writer's scope is capped at the price the owner accepts (two attempts), and the cap goes when the call ends", async () => {
    const r = await rig(() => [reply(GOOD_ANSWER)]);
    await r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 });
    expect(r.state.caps).toEqual([
      ["set", SCOPE_KEY, suggestPrice(priced(), "x-ai/grok-4.3").worstMicros],
      ["clear", SCOPE_KEY, 0],
    ]);
  });

  test("the translator's scope is capped the same way", async () => {
    const r = await rig(() => [{ status: 200, body: chatBody(JSON.stringify({ text_en: GOOD_MOTION, refusal: "none" }), { cost: 0.001 }) }]);
    await r.motions.translateIdea({ avatarId: r.avatarId, photoId: r.photoId, text: "поворачивает голову", acceptedWorstMicros: 1_000_000 });
    expect(r.state.caps).toEqual([
      ["set", SCOPE_KEY, translatePrice(priced(), "x-ai/grok-4.3").worstMicros],
      ["clear", SCOPE_KEY, 0],
    ]);
  });

  test("the cap goes in every ending: a failed call (a 401) too", async () => {
    const r = await rig(() => [{ status: 401, body: { error: { message: "no auth" } } }]);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).rejects.toBeDefined();
    expect(r.state.caps.map((c) => c[0])).toEqual(["set", "clear"]);
  });

  test("no cap is set by a call refused before its money (a price change, a missing photo)", async () => {
    const r = await rig(() => []);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: "photo-nope-0001", acceptedWorstMicros: 1_000_000 })).rejects.toBeDefined();
    expect(r.state.caps).toEqual([]);
  });
});

describe("the photo's downscale is bounded (M1)", () => {
  test("a hung downscale ends the call free, before any reserve or chat line, and the guard frees", async () => {
    let signalSeen: AbortSignal | undefined;
    const r = await rig(() => [], {
      downscaleTimeoutMs: 40,
      downscale: (_bytes, _side, signal) => {
        signalSeen = signal;
        return new Promise<Uint8Array>(() => undefined);
      },
    });
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "VALIDATION", clipReason: "photo-unreadable" } });
    expect(signalSeen?.aborted).toBe(true);
    expect(money.lines()).toEqual([]);
    expect([r.motions.running(), r.motions.runningFor(r.avatarId), r.state.paid]).toEqual([0, 0, 0]);
    expect(r.state.caps).toEqual([]);
  });

  test("the downscale gets a signal to kill ffmpeg by, and a fast one is not cut", async () => {
    let signalSeen: AbortSignal | undefined;
    const r = await rig(() => [reply(GOOD_ANSWER)], {
      downscale: async (_bytes, _side, signal) => {
        signalSeen = signal;
        return JPEG;
      },
    });
    expect(await r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 })).toMatchObject({ outcome: "ok" });
    expect(signalSeen).toBeDefined();
  });
});

describe("the chat client's timeout (L4)", () => {
  test("both calls open the client with the call timeout, 60 s like the descriptor check", async () => {
    const r = await rig(() => [reply(GOOD_ANSWER), { status: 200, body: chatBody(JSON.stringify({ text_en: GOOD_MOTION, refusal: "none" }), { cost: 0.001 }) }]);
    await r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 });
    await r.motions.translateIdea({ avatarId: r.avatarId, photoId: r.photoId, text: "поворачивает голову", acceptedWorstMicros: 1_000_000 });
    expect(r.state.timeouts).toEqual([60_000, 60_000]);
  });
});

describe("the counts", () => {
  test("running() and runningFor() count a call from its first step and go back to 0 and to the paid count's start, even when the call fails", async () => {
    const r = await rig(() => [{ status: 401, body: { error: { message: "no auth" } } }]);
    const call = r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 });
    expect(r.motions.running()).toBe(1);
    expect(r.motions.runningFor(r.avatarId)).toBe(1);
    expect(r.state.paid).toBe(1);
    await expect(call).rejects.toMatchObject({ error: { code: "AUTH_INVALID" } });
    expect([r.motions.running(), r.motions.runningFor(r.avatarId), r.state.paid]).toEqual([0, 0, 0]);
  });

  test("a call refused before its first step counted nothing", async () => {
    const r = await rig(() => []);
    await expect(r.motions.suggestMotions({ avatarId: r.avatarId, photoId: "photo-nope-0001", acceptedWorstMicros: 1_000_000 })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect([r.motions.running(), r.state.paid]).toEqual([0, 0]);
  });

  test("the guard is decided before the first await: a held unit refuses at once and counts nothing", async () => {
    const r = await rig(() => []);
    const held = new ClipMotions({ ...(await depsOf(r)), unitHeld: () => true });
    await expect(held.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1 })).rejects.toMatchObject({ error: { code: "IN_FLIGHT", clipReason: "clip-busy" } });
    expect(held.running()).toBe(0);
  });
});

describe("a store that cannot be written after a paid call", () => {
  test("is `none` with the cost the owner paid, logged by photo id and never with a text", async () => {
    const r = await rig(() => [reply(GOOD_ANSWER, 0.0034)]);
    // `motions` is a file, so its folder cannot be made.
    await mkdir(r.library.avatarDirPath(r.avatarId), { recursive: true });
    await writeFile(r.storeDir, "in the way");
    const result = await r.motions.suggestMotions({ avatarId: r.avatarId, photoId: r.photoId, acceptedWorstMicros: 1_000_000 });
    expect(result).toEqual({ outcome: "none", costMicros: 3_400 });
    const line = r.logs.find((l) => l.includes("could not be stored"));
    expect(line).toContain(r.photoId);
    expect(line).not.toContain(GOOD_MOTION);
  });
});

/** The deps a rig was built from, for a variant of it. */
async function depsOf(r: Rig): Promise<ClipMotionsDeps> {
  return {
    newId: () => "job-00000008",
    now: () => "2026-10-15T10:00:00.000Z",
    unitHeld: () => false,
    currentLibrary: () => r.library,
    liveLibrary: async () => r.library,
    usableKey: () => "sk-test",
    paidBudget: () => money.budget,
    photoOf: (lib, avatarId, photoId) => {
      const photo = lib.getPhoto(photoId);
      if (photo === undefined || photo.avatarId !== avatarId) throw new EngineFailure({ code: "NOT_FOUND", detail: "no such photo" });
      return photo;
    },
    assertAvatarOnDisk: async () => undefined,
    facts: async () => ({ kind: "suitable", facts: timerFrame(), bytes: JPEG }),
    prices: async () => ({ book: money.priceBook, asOf: "2026-09-24" }),
    textModel: () => "x-ai/grok-4.3",
    checkAccepted: () => undefined,
    checkMonthlyRoom: () => undefined,
    paidStart: () => undefined,
    paidEnd: () => undefined,
    setCap: () => undefined,
    clearCap: () => undefined,
    openRouter: () => makeClient(fakeFetch([]).fetch).client,
    callTimeoutMs: 60_000,
    downscaleTimeoutMs: 30_000,
    emitMoney: () => undefined,
    markKeyRejected: () => undefined,
    pendingDelete: () => false,
    downscale: async () => JPEG,
    log: () => undefined,
  };
}
