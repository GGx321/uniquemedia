import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchView } from "../shared/engine";
import { launchGroupKey } from "./autopilot/groups";
import { ok, useEngineDir } from "./testing/engineHarness";
import { draftOf, LAUNCH_MS, network, wiringKit } from "./testing/wiringKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6w fix round 1 (H1, M1): a slice that ends on a CAP keeps slots open, yet nothing will ever draw them again: the paid side moves on, so the free side must read the slice as
// ended and the draw as over, or the launch never ends. Here the LAUNCH group's cap (W′) is brought down after the compose, so the slice's first attempts are funded and the rest are refused
// with RUN_CAP_EXCEEDED. The photos the slice did get are rendered; the video they cannot fill is dropped.

setDefaultTimeout(LAUNCH_MS + 40_000);

const dir = useEngineDir("studio-engine-autopilot-cap-");
const kit = wiringKit(dir);
/** What one image attempt reserves and, at this fake's prices, settles at. */
const IMAGE_MICROS = 40_000;

/** A review-on launch of one avatar: 10 scenes, one slice. The group cap is cut to the compose plus `images` image attempts before the owner continues. */
async function launchCutAfter(images: number, afterCompose: (avatarId: string) => Promise<void> = async () => undefined) {
  const net = network();
  const avatarId = await kit.seedAvatar(0);
  const started = await kit.boot(net);
  const launch = await kit.startLaunch(started, draftOf([avatarId], { sceneReview: true }));
  const waiting = await kit.waitFor(started, launch.launchId, "the avatar to wait for the review", (v) => v.avatars[0]?.phase === "awaiting-review");
  const row = waiting.avatars[0];
  if (row?.sceneSetId == null || row.setRevision == null) throw new Error("the waiting avatar names no set");
  await afterCompose(avatarId);
  const budget = started.engine.budget;
  if (budget === null) throw new Error("no ledger");
  const spent = budget.committedOfGroup(launchGroupKey(launch.launchId));
  started.engine.launchGroups.register({ launchId: launch.launchId, capMicros: spent + images * IMAGE_MICROS + IMAGE_MICROS / 2, setIds: [row.sceneSetId], runIds: [] });
  ok(await kit.call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision }));
  return { net, avatarId, started, launch, sceneSetId: row.sceneSetId };
}

const done = (v: LaunchView): boolean => v.status === "done";

describe("a slice that ends on a cap does not hang the launch (H1)", () => {
  test("the photos the slice did get are rendered, the video they cannot fill is dropped, and the launch is done", async () => {
    const { net, avatarId, started, launch } = await launchCutAfter(5);
    await kit.waitFor(started, launch.launchId, "the launch to be done", done);
    expect(net.imageCalls().length).toBeLessThan(10);
    const listed = await kit.getLaunch(started, launch.launchId);
    expect(listed.videos.map((v) => [v.state, v.dropReason])).toEqual([
      ["done", null],
      ["dropped", "not-enough-photos"],
    ]);
    kit.expectVideosOnDisk(await kit.videosOf(started, avatarId), 1);
    expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
  });

  test("the engine reports the capped slice as finished, so the paid side does not start the same run again on its next pass", async () => {
    const { avatarId, started, launch, sceneSetId } = await launchCutAfter(5);
    // While the video renders (the set is unlinked, and its draw gone, when the launch is done).
    await kit.waitFor(started, launch.launchId, "the draw to be over", (v) => v.avatars[0]?.phase === "montage");
    const set = await started.engine.library?.sceneSets.get(avatarId, sceneSetId);
    if (set === null || set === undefined) throw new Error("the set cannot be read");
    const statuses = await started.engine.sliceStatuses(set);
    expect([...statuses.values()].map((s) => s.finished)).toEqual([true]);
    await kit.waitFor(started, launch.launchId, "the launch to be done", done);
  });
});

describe("one broken set file of the avatar does not keep the draw open (M1)", () => {
  test("a set file of the avatar breaks while the launch runs (an old manual set), and the launch's own set still decides: the launch ends", async () => {
    const { avatarId, started, launch } = await launchCutAfter(5, async (id) => {
      const scenes = join(kit.libraryDir(), "avatars", id, "scenes");
      await mkdir(scenes, { recursive: true });
      await writeFile(join(scenes, "set-broken-manual-0001.json"), "{ this is not a scene set");
    });
    const view = await kit.waitFor(started, launch.launchId, "the launch to be done", done);
    expect(view.status).toBe("done");
    kit.expectVideosOnDisk(await kit.videosOf(started, avatarId), 1);
  });
});
