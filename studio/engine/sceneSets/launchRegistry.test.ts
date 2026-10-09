import { describe, expect, test } from "bun:test";
import { openLibrary, type Library } from "../library";
import { steppingClock, useTempDir } from "../library/testing/helpers";
import { sampleSet } from "../library/testing/sceneSetSample";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { LaunchRegistry } from "./launchRegistry";
import { MemoryLaunches } from "./testing/memoryLaunches";
useNativeGlobals();

// S4.5a (plan §3.4): the launch registry says which sets and runs belong to an UNFINISHED launch. A launch id that does not name a readable, unfinished
// launch counts as no launch at all, for every refusal and every mark (the unlinked rule), so a finished or removed launch can never lock an avatar.

const root = useTempDir("studio-launch-registry-");
const LAUNCH = "launch-0a1b2c3d4e5f";
const OTHER = "launch-9z8y7x6w5v4u";

describe("LaunchRegistry", () => {
  test("names the launch of a linked set and of a linked run while the launch is unfinished", () => {
    const launches = new MemoryLaunches().add(LAUNCH);
    const registry = new LaunchRegistry(launches);
    registry.linkSet("set-aaaa-0001", LAUNCH);
    registry.linkRun("run-aaaa-0001", LAUNCH);

    expect(registry.launchOfSet("set-aaaa-0001")).toBe(LAUNCH);
    expect(registry.launchOfRun("run-aaaa-0001")).toBe(LAUNCH);
  });

  test("names no launch for a set or run nothing was linked to", () => {
    const registry = new LaunchRegistry(new MemoryLaunches().add(LAUNCH));

    expect(registry.launchOfSet("set-aaaa-0001")).toBeUndefined();
    expect(registry.launchOfRun("run-aaaa-0001")).toBeUndefined();
  });

  test("treats a set and a run as unlinked once their launch is finished", () => {
    const launches = new MemoryLaunches().add(LAUNCH);
    const registry = new LaunchRegistry(launches);
    registry.linkSet("set-aaaa-0001", LAUNCH);
    registry.linkRun("run-aaaa-0001", LAUNCH);

    launches.finish(LAUNCH);

    expect(registry.launchOfSet("set-aaaa-0001")).toBeUndefined();
    expect(registry.launchOfRun("run-aaaa-0001")).toBeUndefined();
  });

  test("treats a launch that was never readable (its file removed or unreadable) as unlinked", () => {
    const registry = new LaunchRegistry(new MemoryLaunches());
    registry.linkSet("set-aaaa-0001", LAUNCH);

    expect(registry.launchOfSet("set-aaaa-0001")).toBeUndefined();
  });

  test("activeLaunch passes a launch id through only while that launch is unfinished", () => {
    const launches = new MemoryLaunches().add(LAUNCH);
    const registry = new LaunchRegistry(launches);

    expect(registry.activeLaunch(LAUNCH)).toBe(LAUNCH);
    expect(registry.activeLaunch(OTHER)).toBeUndefined();
    expect(registry.activeLaunch(undefined)).toBeUndefined();
  });

  test("forgets a set and a run once they are unlinked", () => {
    const registry = new LaunchRegistry(new MemoryLaunches().add(LAUNCH));
    registry.linkSet("set-aaaa-0001", LAUNCH);
    registry.linkRun("run-aaaa-0001", LAUNCH);

    registry.unlinkSet("set-aaaa-0001");
    registry.unlinkRun("run-aaaa-0001");

    expect(registry.launchOfSet("set-aaaa-0001")).toBeUndefined();
    expect(registry.launchOfRun("run-aaaa-0001")).toBeUndefined();
  });

  test("reads no set file when no launch is unfinished: there is nothing to link, and opening a library costs no extra read", async () => {
    const registry = new LaunchRegistry(new MemoryLaunches());
    const untouched = new Proxy({} as Library, {
      get() {
        throw new Error("the library must not be read");
      },
    });

    const links = await registry.scan(untouched);

    expect(links.sets.size + links.runs.size).toBe(0);
  });

  test("is rebuilt from the sets' launch ids and their slices' run ids when a library opens", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: "a 25-year-old woman with hazel eyes" });
    const base = sampleSet({ avatarId: avatar.id, count: 3, written: 3, sceneSetId: "set-aaaa-0001", runId: "run-aaaa-0001" });
    await library.sceneSets.create({
      ...base,
      launchId: LAUNCH,
      launchDraw: { launchId: LAUNCH, sceneIds: [1, 2, 3], slices: [{ runId: "run-aaaa-0001", sceneIds: [1, 2], capMicros: 100 }] },
    });
    await library.sceneSets.create({ ...sampleSet({ avatarId: avatar.id, count: 2, sceneSetId: "set-aaaa-0002", runId: "run-aaaa-0002" }), launchId: LAUNCH });
    await library.sceneSets.create(sampleSet({ avatarId: avatar.id, count: 2, sceneSetId: "set-aaaa-0003", runId: "run-aaaa-0003" }));
    const registry = new LaunchRegistry(new MemoryLaunches().add(LAUNCH));

    await registry.rebuild(library);

    expect(registry.launchOfSet("set-aaaa-0001")).toBe(LAUNCH);
    expect(registry.launchOfRun("run-aaaa-0001")).toBe(LAUNCH);
    expect(registry.launchOfSet("set-aaaa-0002")).toBe(LAUNCH);
    expect(registry.launchOfSet("set-aaaa-0003")).toBeUndefined();
    expect(registry.launchOfRun("run-aaaa-0003")).toBeUndefined();
  });
});
