import { describe, expect, test } from "bun:test";
import type { LaunchDraftInput, LaunchView, SceneSetView } from "../../shared/engine";
import { errorOf, MIA, ON_THE_WRITER, runUntil, runWorld, startRun, unwrap, type Mock } from "./mockLaunchRun.testkit";

// 5a.2 (S5.6e, m11): the tests about the compose's WRITER (its live job, its progress and done) plan from `cat-llm-only-fixture`; a launch on «Дом» is composed by the code template at once.
// S4.10 fix D: the mock's launch makes a real scene set, real slice runs and their job events, and refuses the owner's commands on them as the engine does (plan §4.7, A16). The
// parity stories (scenarios.autopilotRun.ts) hold the refusals line for line; these hold the rest of what the window reads.

const LAUNCH_SET = { code: "VALIDATION", sceneReason: "launch-set" } as const;

const REVIEW = { sceneReview: true } as const;

const setOf = async (mock: Mock): Promise<SceneSetView | null> => (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;

const awaiting = (v: LaunchView): boolean => v.avatars.some((a) => a.phase === "awaiting-review");

async function reviewed(mock: Mock, over: Partial<LaunchDraftInput> = {}): Promise<{ started: LaunchView; view: LaunchView; set: SceneSetView }> {
  const started = await startRun(mock, { ...REVIEW, ...over });
  const view = await runUntil(mock, started.launchId, "the review", awaiting);
  const set = await setOf(mock);
  if (set === null) throw new Error("the launch's set is not there");
  return { started, view, set };
}

describe("the scene set of a launch that runs", () => {
  test("exists from the compose's first request, held by the launch, and is the avatar's set to read", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { ...REVIEW, ...ON_THE_WRITER });
    await runUntil(mock, started.launchId, "composing", (v) => v.avatars.some((a) => a.phase === "composing"));
    expect(await setOf(mock)).toMatchObject({ launchId: started.launchId, status: "writing", write: { kind: "compose", count: 10 } });
  });

  test("is frozen when the launch starts to draw: the owner's edit and rewrite are refused as launch-set", async () => {
    const mock = runWorld();
    const { started, set } = await reviewed(mock);
    await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: MIA.avatarId, sceneSetId: set.sceneSetId, revision: set.revision }));
    const edit = await errorOf(mock.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op: { op: "remove", sceneIds: [1] } }));
    const rewrite = await errorOf(mock.client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "rewrite", sceneIds: [1], redraw: false }, acceptedWorstMicros: 10_000_000 }));
    expect(edit).toMatchObject(LAUNCH_SET);
    expect(rewrite).toMatchObject(LAUNCH_SET);
  });

});

