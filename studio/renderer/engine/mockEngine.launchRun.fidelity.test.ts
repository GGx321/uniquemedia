import { describe, expect, test } from "bun:test";
import type { RunRequest } from "../../shared/engine";
import { MIA, runWorld, tick, unwrap } from "./mockLaunchRun.testkit";

// S4.10 fix D: small places where the mock's launch differed from the engine's (the contract/mock/parity review's LOWs). Each is held here on the mock; the parity stories hold the rest.


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

