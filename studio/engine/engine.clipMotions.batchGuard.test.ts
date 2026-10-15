import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { IDLE_STEPS } from "./autopilot/steps";
import { parseClipAttemptId } from "./clips/journal";
import { batchOf, cancelBatch, createBatch, mostOpenClipReserves, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { createCommand, jobEnd, phasesOf, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { gate, errorOf, motionNetwork, resultOf, send, type ChatRequest, type MotionNetwork } from "./clips/testing/motionNet";
import { GOOD_TEXTS, suggestionReply } from "./clips/testing/motionWorld";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(60_000);

// Stage 5, 5b.2, S5.WC3 on part B1 (rebase checklist): the clip money unit is ONE predicate for both directions of the guard. A batch holds it for its whole life (from the claim until its last member's
// money closes: queued members, the gaps between members, the rest of a member that finishes after `cancelBatch`), so a part C call is `clip-busy` through all of it; and while a part C call runs, every
// way to start clip money (a single clip, a Grok offer, a batch) answers `motion-busy` before it awaits anything. A part C call opens a chat reserve, never a clip one.

const dir = useEngineDir("studio-engine-clip-motions-batch-guard-");
const libraryDir = () => `${dir()}/library`;
const BUDGET = 10_000_000;

interface World {
  readonly started: ClipEngine;
  readonly net: MotionNetwork;
  readonly avatarId: string;
  readonly photoIds: string[];
}

/** An avatar with `photos` frames; the nth Kling POST is held when `held(n)` says so. The chat answers a suggestion, or waits for `chatGate`. */
async function world(photos: number, held: (n: number) => boolean, chatGate?: { promise: Promise<void> }, engine: Parameters<typeof startClipEngine>[1] = {}): Promise<World> {
  const seeded = await seedBatchAvatar(libraryDir(), plainPhotos(photos));
  const chat = async (_request: ChatRequest) => {
    await chatGate?.promise;
    return suggestionReply([GOOD_TEXTS[0] ?? ""]);
  };
  const net = motionNetwork({ chat, clip: { klingBy: (n) => (held(n) ? { held: true } : undefined) } });
  const started = await startClipEngine(dir(), { net, monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS }, ...engine });
  return { started, net, avatarId: seeded.avatarId, photoIds: seeded.photoIds };
}

const suggestOn = (w: World, photoId: string) => send(w.started, "clips.suggestMotions", { avatarId: w.avatarId, photoId, acceptedWorstMicros: 1_000_000 });

describe("a batch holds the clip money unit for its whole life: a part C call is `clip-busy` throughout", () => {
  test("with a member queued, after cancelBatch while the member in flight finishes, and not after the batch ends", async () => {
    const w = await world(2, (n) => n === 1);
    const made = batchOf(await createBatch(w.started, { avatarId: w.avatarId, photoIds: w.photoIds }));
    const [first = "", second = ""] = made.jobIds;
    await until(() => phasesOf(w.started, first).includes("rendering"), "the first member rendering");
    // member 2 is queued
    expect(errorOf(await suggestOn(w, w.photoIds[0] ?? "")).clipReason).toBe("clip-busy");
    expect(resultOf(await cancelBatch(w.started, w.avatarId, made.batchId))).toEqual({ cancelled: 1 });
    // member 2 is cancelled, member 1 still in flight
    expect(errorOf(await suggestOn(w, w.photoIds[0] ?? "")).clipReason).toBe("clip-busy");
    w.net.releaseNth("kling", 1);
    await jobEnd(w.started, first);
    await jobEnd(w.started, second);
    await until(() => w.started.engine.budget?.status().openReserveMicros === 0, "the money closed");
    expect(resultOf(await suggestOn(w, w.photoIds[0] ?? ""))).toMatchObject({ outcome: "ok" });
    expect(w.net.chats.length).toBe(1);
  });

  test("in the gap: member 1's money is closed and member 2 is held at its turn (before it starts), a part C call is still `clip-busy`", async () => {
    const w = await world(2, (n) => n === 1);
    const secondPhoto = w.photoIds[1] ?? "";
    const library = w.started.engine.library;
    if (library === null || library === undefined) throw new Error("no library");
    // Member 2's turn begins by looking at its photo again (`recheck`); that read is held until the test lets it go. Nothing else reads the second photo meanwhile.
    const door = gate();
    let held = false;
    let armed = false;
    const original = library.readPhotoVerified.bind(library);
    library.readPhotoVerified = async (photoId: string) => {
      if (armed && photoId === secondPhoto) {
        held = true;
        await door.promise;
      }
      return original(photoId);
    };
    const made = batchOf(await createBatch(w.started, { avatarId: w.avatarId, photoIds: w.photoIds }));
    const [first = "", second = ""] = made.jobIds;
    await until(() => phasesOf(w.started, first).includes("rendering"), "the first member rendering");
    armed = true;
    w.net.releaseNth("kling", 1);
    await until(() => held, "member 2 held at its turn");
    // Member 1's money has closed (the turn only starts after it); member 2 has not started.
    expect(phasesOf(w.started, second).includes("rendering")).toBe(false);
    expect(errorOf(await suggestOn(w, w.photoIds[0] ?? "")).clipReason).toBe("clip-busy");
    expect(errorOf(await w.started.engine.handle(createCommand({ avatarId: w.avatarId, photoId: secondPhoto }))).clipReason).toBe("batch-running");
    expect(w.net.chats).toHaveLength(0);
    door.open();
    await jobEnd(w.started, second);
    await until(() => w.started.engine.budget?.status().openReserveMicros === 0, "the money closed");
    expect(resultOf(await suggestOn(w, w.photoIds[0] ?? ""))).toMatchObject({ outcome: "ok" });
  });
});

describe("while a part C call runs, every way to start clip money answers `motion-busy`, synchronously", () => {
  async function running() {
    const door = gate();
    const w = await world(2, () => false, door, { deps: { launchSteps: IDLE_STEPS, clipSwitches: { mode: "offer" } } });
    const call = suggestOn(w, w.photoIds[0] ?? "");
    await until(() => w.net.chats.length === 1, "the chat request");
    return { w, door, call };
  }

  test("a single clip, a Grok offer and a batch", async () => {
    const { w, door, call } = await running();
    const photoId = w.photoIds[1] ?? "";
    const before = ledgerLines(dir()).length;
    const callsBefore = w.net.calls.length;
    expect(errorOf(await w.started.engine.handle(createCommand({ avatarId: w.avatarId, photoId }))).clipReason).toBe("motion-busy");
    expect(errorOf(await w.started.engine.handle(createCommand({ avatarId: w.avatarId, photoId, model: "grok", fallback: "none", acceptedWorstMicros: 850_000 }))).clipReason).toBe("motion-busy");
    expect(errorOf(await createBatch(w.started, { avatarId: w.avatarId, photoIds: w.photoIds })).clipReason).toBe("motion-busy");
    expect(ledgerLines(dir())).toHaveLength(before);
    expect(w.net.calls.slice(callsBefore)).toEqual([]);
    door.open();
    expect(resultOf(await call)).toMatchObject({ outcome: "ok" });
  });

  test("never together, in either order: the first call to reach the engine wins and the other is told the opposite busy", async () => {
    const w = await world(1, () => false);
    const photoId = w.photoIds[0] ?? "";
    const [suggestion, clip] = await Promise.all([suggestOn(w, photoId), w.started.engine.handle(createCommand({ avatarId: w.avatarId, photoId }))]);
    expect([suggestion.ok, clip.ok]).toEqual([true, false]);
    expect(errorOf(clip).clipReason).toBe("motion-busy");
    const w2 = await world(1, () => true);
    const [clip2, suggestion2] = await Promise.all([w2.started.engine.handle(createCommand({ avatarId: w2.avatarId, photoId: w2.photoIds[0] ?? "" })), suggestOn(w2, w2.photoIds[0] ?? "")]);
    expect([clip2.ok, suggestion2.ok]).toEqual([true, false]);
    expect(errorOf(suggestion2).clipReason).toBe("clip-busy");
    const jobId = resultOf(clip2) as { jobId: string };
    await until(() => phasesOf(w2.started, jobId.jobId).includes("rendering"), "rendering");
    w2.net.releaseNth("kling", 1);
    await jobEnd(w2.started, jobId.jobId);
  });
});

describe("a part C call opens a chat reserve, never a clip one", () => {
  test("its attempt ids are not clip attempt ids", () => {
    expect(parseClipAttemptId("job-00000001:motion#1")).toBeNull();
    expect(parseClipAttemptId("job-00000001:idea#2")).toBeNull();
  });

  test("while it runs the ledger holds no open clip reserve, and once it ended a batch is not refused RECONCILE_REQUIRED", async () => {
    const door = gate();
    const w = await world(2, () => false, door);
    const call = suggestOn(w, w.photoIds[0] ?? "");
    await until(() => w.net.chats.length === 1, "the chat request");
    expect(mostOpenClipReserves(ledgerLines(dir()).filter((line) => parseClipAttemptId(String(line.attemptId)) !== null))).toBe(0);
    expect(ledgerLines(dir()).filter((line) => line.type === "reserve").map((line) => String(line.attemptId))).toEqual([expect.stringMatching(/:motion#1$/)]);
    door.open();
    await call;
    const made = await createBatch(w.started, { avatarId: w.avatarId, photoIds: w.photoIds });
    expect(made.ok).toBe(true);
    for (const id of batchOf(made).jobIds) await jobEnd(w.started, id);
  });
});
