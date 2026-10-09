import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LaunchDraw, SceneSetFile, SceneSetStore } from "./sceneSets";
import { sampleSet } from "./testing/sceneSetSample";
import { steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.1 (plan §3.3, §3.4): a launch's scene set gains an optional `launchId` and a frozen `launchDraw` (the approved scene list and the slices drawn so far).
// The set file is a STRICT object with a literal `schemaVersion`, so a Stage 4 build that writes them makes the set unreadable to a build before Stage 4 (accepted:
// Studio is unreleased, no version bump, by the T6c precedent). What must hold: a set file as today's builds write it still reads, and the store writes no new key into
// a set that has no launch.

const root = useTempDir("studio-scene-sets-launch-");
const AVATAR = "avatar-aaaa-0001";
const LAUNCH = "launch-0a1b2c3d4e5f";
const store = () => new SceneSetStore(root(), { now: steppingClock("2026-10-08T12:00:00.000Z") });
const fileOf = async (id = "set-aaaa-0001"): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(root(), "avatars", AVATAR, "scenes", `${id}.json`), "utf8"));

/** A valid set file with `count` scenes (ids 1..count) as a store wrote it. */
async function stored(count = 4): Promise<Record<string, unknown> & { runId: string }> {
  await store().create(sampleSet({ count }));
  const raw = await fileOf();
  const runId = raw.runId;
  if (typeof runId !== "string") throw new Error("expected a run id");
  return { ...raw, runId };
}

describe("a set file as today's builds write it", () => {
  test("has no launch field, and still reads", async () => {
    const raw = await stored();
    expect("launchId" in raw).toBe(false);
    expect("launchDraw" in raw).toBe(false);
    expect(SceneSetFile.safeParse(raw).success).toBe(true);
  });

  test("a store update writes no launch key into a set that has none", async () => {
    await stored();
    await store().update(AVATAR, "set-aaaa-0001", (current) => ({ ...current, scenes: current.scenes.map((s, i) => (i === 0 ? { ...s, text: "A sentence." } : s)) }));
    const raw = await fileOf();
    expect("launchId" in raw).toBe(false);
    expect("launchDraw" in raw).toBe(false);
    expect(raw.revision).toBe(2);
  });

  test("an unknown key is still refused: the file stays strict", async () => {
    const raw = await stored();
    expect(SceneSetFile.safeParse(raw).success).toBe(true);
    expect(SceneSetFile.safeParse({ ...raw, schedule: "daily" }).success).toBe(false);
  });
});

describe("a launch's set", () => {
  test("may name its launch before anything is approved (composing, awaiting review)", async () => {
    const raw = await stored();
    expect(SceneSetFile.safeParse({ ...raw, launchId: LAUNCH }).success).toBe(true);
  });

  test("the store keeps the launch id through an update, and an unlink (clearing it) is an update too", async () => {
    await stored();
    await store().update(AVATAR, "set-aaaa-0001", (current) => ({ ...current, launchId: LAUNCH }));
    expect((await fileOf()).launchId).toBe(LAUNCH);
    await store().update(AVATAR, "set-aaaa-0001", (current) => {
      const { launchId: _unlinked, ...rest } = current;
      return rest;
    });
    expect("launchId" in (await fileOf())).toBe(false);
  });

  test("freezes the approved scenes and records the slices drawn, the first under the set's own run id", async () => {
    const raw = await stored();
    const launchDraw = { launchId: LAUNCH, sceneIds: [1, 2, 3], slices: [{ runId: raw.runId, sceneIds: [1, 2], capMicros: 420_000 }] };
    expect(SceneSetFile.safeParse({ ...raw, launchId: LAUNCH, launchDraw }).success).toBe(true);
    const second = { ...launchDraw, slices: [...launchDraw.slices, { runId: "run-aaaa-0002", sceneIds: [3], capMicros: 210_000 }] };
    expect(SceneSetFile.safeParse({ ...raw, launchId: LAUNCH, launchDraw: second }).success).toBe(true);
  });

  test("a draw approved and not yet sliced is valid", async () => {
    const raw = await stored();
    expect(SceneSetFile.safeParse({ ...raw, launchId: LAUNCH, launchDraw: { launchId: LAUNCH, sceneIds: [1, 2, 3, 4], slices: [] } }).success).toBe(true);
  });

  test("survives the store: written, read back, and rewritten by an update", async () => {
    const raw = await stored();
    const launchDraw = { launchId: LAUNCH, sceneIds: [1, 2], slices: [{ runId: raw.runId, sceneIds: [1], capMicros: 210_000 }] };
    await store().update(AVATAR, "set-aaaa-0001", (current) => ({ ...current, launchId: LAUNCH, launchDraw }));
    expect((await store().get(AVATAR, "set-aaaa-0001"))?.launchDraw).toEqual(launchDraw);
    expect((await fileOf()).launchDraw).toEqual(launchDraw);
  });

  describe("refuses a draw that cannot be right", () => {
    const base = async () => {
      const raw = await stored();
      const draw = { launchId: LAUNCH, sceneIds: [1, 2, 3], slices: [{ runId: raw.runId, sceneIds: [1, 2], capMicros: 420_000 }] };
      expect(SceneSetFile.safeParse({ ...raw, launchId: LAUNCH, launchDraw: draw }).success).toBe(true);
      return { raw, draw };
    };
    const refused = (raw: Record<string, unknown>, draw: unknown, launchId: unknown = LAUNCH) => SceneSetFile.safeParse({ ...raw, launchId, launchDraw: draw }).success;

    test("a draw with no launch id on the set, or another launch's", async () => {
      const { raw, draw } = await base();
      expect(SceneSetFile.safeParse({ ...raw, launchDraw: draw }).success).toBe(false);
      expect(refused(raw, { ...draw, launchId: "launch-ffffffffffff" })).toBe(false);
    });

    test("a launch id that is not one", async () => {
      const { raw, draw } = await base();
      expect(refused(raw, draw, "../launch")).toBe(false);
      expect(refused(raw, { ...draw, launchId: "../launch" }, "../launch")).toBe(false);
    });

    test("no scenes frozen, a scene twice, or a scene the set does not have", async () => {
      const { raw, draw } = await base();
      expect(refused(raw, { ...draw, sceneIds: [], slices: [] })).toBe(false);
      expect(refused(raw, { ...draw, sceneIds: [1, 1, 2], slices: [] })).toBe(false);
      expect(refused(raw, { ...draw, sceneIds: [1, 2, 99], slices: [] })).toBe(false);
    });

    test("a slice that draws a scene the draw did not freeze, or a scene another slice drew", async () => {
      const { raw, draw } = await base();
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [1, 4], capMicros: 1 }] })).toBe(false);
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [1, 2], capMicros: 1 }, { runId: "run-aaaa-0002", sceneIds: [2], capMicros: 1 }] })).toBe(false);
    });

    test("a slice that repeats a run id, or whose first slice is not the set's own run", async () => {
      const { raw, draw } = await base();
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [1], capMicros: 1 }, { runId: raw.runId, sceneIds: [2], capMicros: 1 }] })).toBe(false);
      expect(refused(raw, { ...draw, slices: [{ runId: "run-aaaa-0002", sceneIds: [1], capMicros: 1 }] })).toBe(false);
    });

    test("an empty slice, an amount that is not whole micro-dollars, a negative one", async () => {
      const { raw, draw } = await base();
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [], capMicros: 1 }] })).toBe(false);
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [1], capMicros: 1.5 }] })).toBe(false);
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [1], capMicros: -1 }] })).toBe(false);
    });

    test("an unknown key in the draw or in a slice", async () => {
      const { raw, draw } = await base();
      expect(refused(raw, { ...draw, note: "x" })).toBe(false);
      expect(refused(raw, { ...draw, slices: [{ runId: raw.runId, sceneIds: [1], capMicros: 1, note: "x" }] })).toBe(false);
    });
  });
});

describe("LaunchDraw's slices", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const draw = (sliceScenes: number, drawn = sliceScenes) => ({ launchId: LAUNCH, sceneIds: ids(Math.max(drawn, sliceScenes)), slices: [{ runId: "run-aaaa-0001", sceneIds: ids(sliceScenes), capMicros: 1 }] });

  test("a slice holds at most 25 photos: the limit the draw is sized to", () => {
    expect(LaunchDraw.safeParse(draw(25)).success).toBe(true);
    expect(LaunchDraw.safeParse(draw(26)).success).toBe(false);
  });

  test("a draw freezes at most 100 scenes: a compose plans no more", () => {
    expect(LaunchDraw.safeParse({ launchId: LAUNCH, sceneIds: ids(100), slices: [] }).success).toBe(true);
    expect(LaunchDraw.safeParse({ launchId: LAUNCH, sceneIds: ids(101), slices: [] }).success).toBe(false);
  });
});
