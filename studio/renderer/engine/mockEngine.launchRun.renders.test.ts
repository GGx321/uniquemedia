import { describe, expect, test } from "bun:test";
import { type LaunchDraftInput } from "../../shared/engine";
import { runWorld, SOFIA, startRun, toDone, unwrap } from "./mockLaunchRun.testkit";

// Stage 4, S4.6r (plan §4.6, §32): the mock mirrors the engine's three mid-launch behaviours: a render that fails gets ONE free retry and then the video is dropped; an export folder that
// vanishes while a render runs is a hold on the folder, not a failed render; a paid job that ends in a way the table has no row for holds the launch as `internal { job-failed }` and
// «Продолжить» runs it again.

/** Two slides videos from the library of Sofia (12 free photos): no paid work at all. */
const LIBRARY: Partial<LaunchDraftInput> = { avatarIds: [SOFIA.avatarId], library: true, generate: false, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 };

async function logKinds(mock: ReturnType<typeof runWorld>, launchId: string): Promise<string[]> {
  return (await unwrap(mock.client.request("autopilot.get", { launchId }))).log.map((l) => l.kind);
}

describe("a render that fails gets one free retry", () => {
  test("one failure is retried: one retry line, no drop, and every video finishes", async () => {
    const mock = runWorld();
    mock.engine.failLaunchRender(1);
    const started = await startRun(mock, LIBRARY);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ videos: { done: 2, total: 2 }, dropped: null });
    const kinds = await logKinds(mock, started.launchId);
    expect(kinds.filter((k) => k === "render-retry")).toHaveLength(1);
    expect(kinds).not.toContain("render-dropped");
  });

});

