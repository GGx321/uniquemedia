import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchRegistry } from "../sceneSets/launchRegistry";
import { LaunchStores } from "./lookup";
import { AUTOPILOT_DIR, LaunchStore } from "./launchStore";
import { newLaunchFile } from "./testing/launchFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §3.4, §19): the store-backed lookup. Library-bound (the question for a STAGED folder is answered from that folder), cached per library (a staged open
// never overwrites what the live library's `isUnfinished` reads), never throws, and fails closed (an unreadable folder or file counts as unfinished).

const X = "launch-fixture-0001";
const Y = "launch-fixture-0002";
let one = "";
let two = "";
beforeEach(async () => {
  one = await mkdtemp(join(tmpdir(), "studio-lookup-a-"));
  two = await mkdtemp(join(tmpdir(), "studio-lookup-b-"));
});
afterEach(async () => {
  await rm(one, { recursive: true, force: true });
  await rm(two, { recursive: true, force: true });
});

const lib = (root: string) => ({ root });
const AT = "2026-10-09T10:05:00.000Z";

describe("hasUnfinished(library)", () => {
  test("is false for a library with no autopilot folder", async () => {
    expect(await new LaunchStores().hasUnfinished(lib(one))).toBe(false);
  });

  test("is true when a launch is running, paused or stopping", async () => {
    const stores = new LaunchStores();
    await stores.storeOf(lib(one)).create(newLaunchFile({}, X));
    expect(await stores.hasUnfinished(lib(one))).toBe(true);
    await stores.storeOf(lib(one)).update(X, (c) => ({ ...c, status: "paused", activeSince: null, paused: { cause: "owner", at: AT } }));
    expect(await stores.hasUnfinished(lib(one))).toBe(true);
    await stores.storeOf(lib(one)).update(X, (c) => ({ ...c, status: "stopping", paused: null }));
    expect(await stores.hasUnfinished(lib(one))).toBe(true);
  });

  test("is false when every launch is done or stopped", async () => {
    const stores = new LaunchStores();
    await stores.storeOf(lib(one)).create(newLaunchFile({}, X));
    await stores.storeOf(lib(one)).update(X, (c) => ({ ...c, status: "stopped", activeSince: null, endedAt: AT }));
    expect(await stores.hasUnfinished(lib(one))).toBe(false);
  });

  test("is true for an unreadable launch file: it may describe an active launch", async () => {
    await mkdir(join(one, AUTOPILOT_DIR));
    await writeFile(join(one, AUTOPILOT_DIR, `${X}.json`), "{not json");
    expect(await new LaunchStores().hasUnfinished(lib(one))).toBe(true);
  });

  test("is true when the autopilot folder cannot be listed", async () => {
    await writeFile(join(one, AUTOPILOT_DIR), "I am a file");
    expect(await new LaunchStores().hasUnfinished(lib(one))).toBe(true);
  });

  test("never throws: a store that fails to scan answers true", async () => {
    class Broken extends LaunchStore {
      override scan(): never {
        throw new Error("the disk is gone");
      }
    }
    const stores = new LaunchStores({ makeStore: (root) => new Broken(root) });
    expect(await stores.hasUnfinished(lib(one))).toBe(true);
  });

  test("a staged library is read from its own folder and does not change what the live library answers", async () => {
    const stores = new LaunchStores();
    await stores.storeOf(lib(one)).create(newLaunchFile({}, X));
    stores.adopt(lib(one));
    await stores.storeOf(lib(two)).create(newLaunchFile({}, Y));
    expect(await stores.hasUnfinished(lib(two))).toBe(true);
    // The staged scan of two must not have replaced one's cache.
    expect(stores.isUnfinished(X)).toBe(true);
    expect(stores.isUnfinished(Y)).toBe(false);
  });
});

describe("isUnfinished(launchId)", () => {
  test("is false before any library is live", () => {
    expect(new LaunchStores().isUnfinished(X)).toBe(false);
  });

  test("answers from the live library only, and switches with adopt", async () => {
    const stores = new LaunchStores();
    await stores.storeOf(lib(one)).create(newLaunchFile({}, X));
    await stores.storeOf(lib(two)).create(newLaunchFile({}, Y));
    stores.adopt(lib(one));
    expect([stores.isUnfinished(X), stores.isUnfinished(Y)]).toEqual([true, false]);
    stores.adopt(lib(two));
    expect([stores.isUnfinished(X), stores.isUnfinished(Y)]).toEqual([false, true]);
    stores.adopt(null);
    expect([stores.isUnfinished(X), stores.isUnfinished(Y)]).toEqual([false, false]);
  });

  test("follows a write made through the live store with no rescan: a stopped launch stops being unfinished", async () => {
    const stores = new LaunchStores();
    await stores.storeOf(lib(one)).create(newLaunchFile({}, X));
    stores.adopt(lib(one));
    expect(stores.isUnfinished(X)).toBe(true);
    await stores.storeOf(lib(one)).update(X, (c) => ({ ...c, status: "stopped", activeSince: null, endedAt: AT }));
    expect(stores.isUnfinished(X)).toBe(false);
  });

  test("an unreadable file of the live library keeps its launch unfinished (fail closed)", async () => {
    await mkdir(join(one, AUTOPILOT_DIR));
    await writeFile(join(one, AUTOPILOT_DIR, `${X}.json`), "{not json");
    const stores = new LaunchStores();
    await stores.hasUnfinished(lib(one));
    stores.adopt(lib(one));
    expect(stores.isUnfinished(X)).toBe(true);
  });

  test("an unreadable folder of the live library makes every id unfinished", async () => {
    await writeFile(join(one, AUTOPILOT_DIR), "I am a file");
    const stores = new LaunchStores();
    await stores.hasUnfinished(lib(one));
    stores.adopt(lib(one));
    expect(stores.isUnfinished("launch-any-other-0001")).toBe(true);
  });

  test("never throws, whatever it is asked", () => {
    const stores = new LaunchStores();
    stores.adopt(lib(one));
    for (const id of ["", "../x", "a".repeat(10_000), "launch-\u0000"]) expect(() => stores.isUnfinished(id)).not.toThrow();
  });
});

describe("the same store per library", () => {
  test("storeOf answers one store for one folder, and another for another", () => {
    const stores = new LaunchStores();
    expect(stores.storeOf(lib(one))).toBe(stores.storeOf(lib(one)));
    expect(stores.storeOf(lib(one))).not.toBe(stores.storeOf(lib(two)));
  });
});

describe("under the scene registry (the unlinked rule)", () => {
  test("a link to a stopped launch is no link, and to an unfinished one is", async () => {
    const stores = new LaunchStores();
    await stores.storeOf(lib(one)).create(newLaunchFile({}, X));
    stores.adopt(lib(one));
    const registry = new LaunchRegistry(stores);
    expect(registry.activeLaunch(X)).toBe(X);
    await stores.storeOf(lib(one)).update(X, (c) => ({ ...c, status: "stopped", activeSince: null, endedAt: AT }));
    expect(registry.activeLaunch(X)).toBeUndefined();
  });
});
