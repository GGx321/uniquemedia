import { describe, expect, test } from "bun:test";
import type { RunRequest } from "../../shared/engine";
import { MIA, runUntil, runWorld, startRun, tick, toDone, unwrap, viewOf } from "./mockLaunchRun.testkit";

// S4.10 fix D: small places where the mock's launch differed from the engine's (the contract/mock/parity review's LOWs). Each is held here on the mock; the parity stories hold the rest.

const SLIDES_40 = { videosPerAvatar: 8, mix: { single: 0, collage: 0, slides: 100 } } as const;

describe("the row's draw counts (LOW-4)", () => {
  test("undrawnScenes are the scenes no slice has taken and resumableSlots the open slots of the slices begun: never the same photos twice", async () => {
    const mock = runWorld();
    const started = await startRun(mock, SLIDES_40);
    const view = await runUntil(mock, started.launchId, "the first slice drawing", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done > 0));
    const row = view.avatars[0];
    // 40 photos are two slices (25 and 15): the first one is begun, so 15 scenes wait for the second and the first has 25 minus what is in.
    expect(row).toMatchObject({ slice: { index: 1, total: 2 }, undrawnScenes: 15 });
    expect(row?.resumableSlots).toBe(25 - (row?.photos.done ?? 0));
  });

  test("a draw that has not begun its first slice has every scene undrawn and no slot to resume", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { ...SLIDES_40, sceneReview: true });
    await runUntil(mock, started.launchId, "the review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    const row = (await viewOf(mock, started.launchId)).avatars[0];
    // Waiting for the review the draw has taken nothing: the row shows neither (the engine's mirror counts a draw only once the owner approved it).
    expect(row).toMatchObject({ undrawnScenes: 0, resumableSlots: 0 });
  });

  test("a single slice drawn in one go ends with nothing undrawn and nothing to resume", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ undrawnScenes: 0, resumableSlots: 0 });
  });
});

describe("the wait of an automatic continue (LOW-5)", () => {
  test("ends when its time comes whatever the key says, and the step that follows finds the key and holds on it", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("network", 1);
    const started = await startRun(mock);
    const waiting = await runUntil(mock, started.launchId, "the wait", (v) => v.paidHold?.reason === "network");
    expect(typeof (waiting.paidHold?.reason === "network" ? waiting.paidHold.detail.nextAt : null)).toBe("string");
    mock.engine.rejectKey();
    const held = await runUntil(mock, started.launchId, "the key hold", (v) => v.paidHold?.reason === "key");
    // The wait is not left as a network hold with no retry: the click it asked for would not be the one that helps.
    expect(held.paidHold?.reason).toBe("key");
  });
});

describe("the month's room with live caps (LOW-6, A21)", () => {
  test("a run of the owner's own that is running holds the rest of its cap: the launch's room is the budget less that cap", async () => {
    const mock = runWorld();
    const request: RunRequest = { avatarId: MIA.avatarId, count: 6, categories: ["home"], poses: { profile: false, back: false } };
    const price = (await unwrap(mock.client.request("runs.estimate", request))).estimate;
    await unwrap(mock.client.request("runs.start", { ...request, acceptedWorstMicros: price.worstMicros }));
    // Two photos in, the reserves of their slots are free again and the money they settled is small: the engine still counts the whole cap as committed, since the job may reserve it.
    tick(mock, 3);
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs[0];
    expect(run?.running).toBe(true);
    const month = (await unwrap(mock.client.request("autopilot.estimate", { draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], poses: { profile: false, back: false }, library: false, generate: true, sceneReview: false, stickers: false } }))).preview.month;
    expect(month.committedMicros).toBe(run?.capMicros ?? -1);
  });
});

describe("the wait for the owner's open set (N-6)", () => {
  test("is told once, in the log, however long it lasts, and ends when the owner's set is gone", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    mock.engine.seedSceneSet({ avatarId: MIA.avatarId, sceneSetId: "set-own-0001", count: 3, written: 3 });
    tick(mock, 12);
    const waiting = await viewOf(mock, started.launchId);
    expect(waiting.avatars[0]?.waiting).toMatchObject({ reason: "open-set" });
    expect(waiting.logTail.filter((l) => l.kind === "open-set")).toHaveLength(1);
    expect(waiting.logTail.find((l) => l.kind === "open-set")).toMatchObject({ avatarId: MIA.avatarId });
    await unwrap(mock.client.request("scenes.discard", { sceneSetId: "set-own-0001" }));
    const done = await toDone(mock, started.launchId);
    expect(done.logTail.filter((l) => l.kind === "open-set")).toHaveLength(1);
  });
});
