import { describe, expect, test } from "bun:test";
import { LaunchView, type LaunchDraftInput } from "../../shared/engine";
import { MIA, runUntil, runWorld, SOFIA, startRun, tick, toDone, unwrap } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: what the WORLD does to a launch the mock runs, and the free half of the plan's §4.6 table: the export folder (a missing folder, a full disk), the tracks (a video that
// waits for one), the avatar that another job holds, an open scene set, a library that cannot say which photos are free. The paid holds are in mockEngine.launchRun.holds.test.ts.

/** Two slides videos from the library of Sofia (12 free photos): no paid work at all. */
const LIBRARY: Partial<LaunchDraftInput> = { avatarIds: [SOFIA.avatarId], library: true, generate: false, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 };

describe("the export folder (free hold: export)", () => {
  test("a folder that goes missing holds the renders, not the launch: the hold names the reason and is logged once; a folder that is back ends it", async () => {
    const mock = runWorld();
    const started = await startRun(mock, LIBRARY);
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    const held = await runUntil(mock, started.launchId, "the export hold", (v) => v.freeHold !== null);
    expect(held).toMatchObject({ status: "running", paidHold: null, freeHold: { reason: "export", detail: { exportReason: "missing", neededBytes: null, freeBytes: null } } });
    expect(held.avatars[0]).toMatchObject({ videos: { done: 0, total: 2 } });
    tick(mock, 12);
    const still = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(still.log.filter((l) => l.kind === "hold-export")).toHaveLength(1);
    expect(still.launch.freeHold?.reason).toBe("export");
    mock.engine.setExportDisk({ status: "ok" });
    const done = await toDone(mock, started.launchId);
    expect(done.freeHold).toBeNull();
    expect(done.avatars[0]).toMatchObject({ videos: { done: 2, total: 2 } });
  });

});

describe("the ledger and the key at «Продолжить»", () => {
  test("a ledger that cannot be read closes «Продолжить» as «ledger»", async () => {
    const mock = runWorld({ money: { unavailable: { cause: "LEDGER_UNREADABLE", detail: "the ledger cannot be read" } } });
    mock.engine.seedLaunch({
      createdAt: "2026-10-08T14:00:00.000Z",
      status: "paused",
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 2 },
      acceptedMicros: 1_000_000,
      plannedWorstMicros: 1_000_000,
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "waiting-music" }],
    });
    const active = (await unwrap(mock.client.request("engine.snapshot", {}))).autopilot;
    expect(active?.resumeBlockedBy).toBe("ledger");
    expect(LaunchView.safeParse(active).success).toBe(true);
  });

});
