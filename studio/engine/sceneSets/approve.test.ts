import { describe, expect, test } from "bun:test";
import { EngineFailure } from "../engineFailure";
import { openLibrary, type Library } from "../library";
import { rejectionOf, steppingClock, useTempDir } from "../library/testing/helpers";
import { sampleSet } from "../library/testing/sceneSetSample";
import { buildSceneRunPlan } from "../runs/plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { commitApproval, loadApprovable } from "./approve";
import { runSnapshots, runSources } from "./toRun";
useNativeGlobals();

// CS.5: the approval of a scene set is made under the set's own lock. A change of the set that arrives while the run folder is being made must wait
// for it, and then meet a used set; without the lock its guard would run before the folder exists and the edit would land on a set that became a run.

const root = useTempDir("studio-approve-");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The library with `createRun` held at a gate: the approval is inside its critical section until `release`. */
function gated(library: Library) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const wrapped = new Proxy(library, {
    get(target, key) {
      if (key === "createRun") {
        return async (...args: Parameters<Library["createRun"]>) => {
          entered = true;
          await gate;
          return target.createRun(...args);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { library: wrapped, release, entered: () => entered };
}

/** The guard the scene sets service puts on every change: a used set is read-only. */
const usedGuard = (library: Library) => async (current: { runId: string; sceneSetId: string }) => {
  if (await library.runFolderExists(current.runId)) throw new EngineFailure({ code: "VALIDATION", detail: `scene set ${current.sceneSetId} is used by run ${current.runId} and is read-only` });
};

async function seeded() {
  const { library } = await openLibrary(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: "a 25-year-old woman with hazel eyes" });
  await library.sceneSets.create(sampleSet({ avatarId: avatar.id, count: 3, written: 3 }));
  return { library, avatarId: avatar.id };
}

describe("commitApproval", () => {
  test("holds a change of the set until the run folder exists, and that change then meets a used set", async () => {
    const { library, avatarId } = await seeded();
    const held = gated(library);
    const deps = { library: held.library, isLive: () => false };
    const approved = await loadApprovable(deps, "set-aaaa-0001", 1);

    const commit = commitApproval(deps, { ...approved, revision: 1 }, (current) => {
      const scenes = runSources(current);
      return buildSceneRunPlan({
        runId: current.runId,
        avatarId,
        createdAt: "2026-10-07T12:00:00.000Z",
        sceneSetId: current.sceneSetId,
        imageAgeCheck: "off",
        models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
        capMicros: 1_000_000,
        plannedWorstMicros: 1_000_000,
        scenes,
        categories: runSnapshots(current, scenes),
      });
    });
    while (!held.entered()) await sleep(5);

    let settled = false;
    const edit = library.sceneSets.update(avatarId, "set-aaaa-0001", (current) => current, { guard: usedGuard(library) });
    void edit.then(
      () => (settled = true),
      () => (settled = true),
    );
    await sleep(60);
    expect(settled).toBe(false);

    held.release();
    await commit;
    const refusal = await rejectionOf(edit);
    expect(refusal).toBeInstanceOf(EngineFailure);
    expect((refusal as EngineFailure).error.code).toBe("VALIDATION");
    expect(await library.runFolderExists("run-aaaa-0001")).toBe(true);
  });
});
