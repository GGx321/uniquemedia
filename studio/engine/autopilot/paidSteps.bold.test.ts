import { afterEach, describe, expect, test } from "bun:test";
import { EngineFailure } from "../engineFailure";
import type { DrawSliceResult } from "../sceneSets/launchDraw";
import { ALL, cleanupRigs, composes, LAUNCH, PHOTO, RUN1, rig, SET1, until, type Rig } from "./testing/paidRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §10.2, option B): the steps that price one photo for a launch (a slice's sizing, the month's room for a new step) tell the engine WHICH launch they
// price for, so a «Смелая» launch with a «Смелая» category is sized at the bold unit. A launch of the five is asked exactly as before.

afterEach(cleanupRigs);

type Look = { level?: string | undefined; categories: readonly string[] };

/** The rig's port records every look it was asked a photo's price for. */
function recordLooks(r: Rig): Look[] {
  const looks: Look[] = [];
  r.port.photoWorstMicros = async (look?: Look) => {
    if (look !== undefined) looks.push(look);
    return PHOTO;
  };
  return looks;
}

function drawnPath(r: Rig): void {
  r.port.compose = composes(r.port, LAUNCH);
  r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
  r.port.draw = async () => {
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(RUN1, { finished: false, openSlots: 10 });
    return { kind: "drawn", created: true, runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 } satisfies DrawSliceResult;
  };
}

describe("a slice's sizing", () => {
  test("asks for the photo's price of the launch's draft: «Смелая» with a «Смелая» category", async () => {
    const r = await rig();
    drawnPath(r);
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    const looks = recordLooks(r);
    await r.start({ sceneReview: false, level: "bold", categories: ["home", "nightwear"] });
    await until(() => looks.length > 0, "the sizing's price");
    expect(looks[0]).toEqual({ level: "bold", categories: ["home", "nightwear"] });
  });

  test("asks for the plain draft of a launch with no level", async () => {
    const r = await rig();
    drawnPath(r);
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    const looks = recordLooks(r);
    await r.start({ sceneReview: false });
    await until(() => looks.length > 0, "the sizing's price");
    expect(looks[0]).toEqual({ categories: ["home"] });
  });
});

describe("the month's room for a new step", () => {
  test("is priced for the launch's draft too", async () => {
    const r = await rig();
    drawnPath(r);
    r.port.draw = async () => {
      throw new EngineFailure({ code: "BUDGET_EXCEEDED", detail: "the month is spent" });
    };
    const looks = recordLooks(r);
    await r.start({ sceneReview: false, level: "bold", categories: ["nightwear"] });
    await until(() => looks.some((look) => look.level === "bold"), "the hold's price");
    expect(looks.at(-1)).toEqual({ level: "bold", categories: ["nightwear"] });
  });
});
