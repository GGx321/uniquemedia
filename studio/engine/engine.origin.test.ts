import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import type { StoredSceneSet } from "./library/sceneSets";
import { SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { RunPlanSchema } from "./runs/plan";
import { planForAvatar, POOLS } from "./scenes";
import { planReviewWrite } from "./sceneSets/reviewPlan";
import { seedOfSet } from "./sceneSets/compose";
import type { QaGate } from "./runs/qa";
import { command, engineSettings, GOOD, jobEnd, network, ok, portraitPng, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// 5a.4 (S5.BA5, plan s5a4 I5.74, §5.6, BA brief «Origin»): every engine plan goes through `planForAvatar` with the avatar's origin, `studioCreated`. An avatar made in Studio (its master a
// wizard candidate) may be planned and redrawn an implied cover; an imported one, or one the engine cannot read as made in Studio, never is (fail-closed). «Дом» at «Смелая» holds
// implied covers (its companion's towel and sheet), so its plans differ by the flag: each path below is held to the plan the planner makes for the avatar's origin, not the other one.

const dir = useEngineDir("studio-engine-origin-");
const libraryDir = () => join(dir(), "library");
const ENOUGH = 10_000_000;

let seeded = 0;

/** An active avatar; its master a wizard candidate (`candidate-4`, made in Studio) or a generated photo with no wizard slot (the parity world's Mia, read as imported). */
async function seedAvatar(studio: boolean): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`origin${++seeded}`) });
  const avatar = await library.createAvatar({ name: studio ? "Ava" : "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const source = studio ? { ...SAMPLE_SOURCE, slot: "candidate-4" } : SAMPLE_SOURCE;
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, source, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });

async function boot() {
  const settings = engineSettings(dir(), { imageAgeCheck: "off" });
  return startEngine(dir(), { init: { settings }, net: network({ image: () => ({ hang: true }) }), deps: { qaGates: [faceGate()] } });
}

describe("a run plans for the avatar's origin", () => {
  for (const studio of [true, false]) {
    test(`an avatar ${studio ? "made in Studio" : "read as imported"}: plan.json is the planner's plan for impliedNudity ${String(studio)}`, async () => {
      const avatarId = await seedAvatar(studio);
      const { engine, events } = await boot();
      const answer = ok(await engine.handle(command("runs.start", { avatarId, count: 20, categories: ["home"], level: "bold", acceptedWorstMicros: ENOUGH })));
      if (answer.type !== "runs.start") throw new Error(`expected a start, got ${answer.type}`);
      const plan = RunPlanSchema.parse(JSON.parse(readFileSync(join(libraryDir(), "runs", answer.result.runId, "plan.json"), "utf8")));
      const input = { seed: plan.scenes.seed, count: 20, categories: ["home" as const], level: "bold" as const };
      const mine = planForAvatar(input, POOLS, studio).slots;
      const other = planForAvatar(input, POOLS, !studio).slots;
      expect(mine).not.toEqual(other);
      expect(plan.scenes.slots).toEqual(mine);
      ok(await engine.handle(command("runs.cancel", { runId: answer.result.runId })));
      await jobEnd(events, answer.result.jobId);
    });
  }
});

/** Composes «Дом» 20 at «Смелая» (the template writes every scene: no request) and answers the set once it is written. */
async function composed(engine: Awaited<ReturnType<typeof boot>>["engine"], events: Awaited<ReturnType<typeof boot>>["events"], avatarId: string): Promise<StoredSceneSet> {
  const answer = ok(await engine.handle(command("scenes.compose", { avatarId, count: 20, categories: ["home"], level: "bold", acceptedWorstMicros: ENOUGH })));
  if (answer.type !== "scenes.compose") throw new Error(`expected a compose, got ${answer.type}`);
  if (answer.result.jobId !== null) await jobEnd(events, answer.result.jobId);
  const set = await engine.library?.sceneSets.get(avatarId, answer.result.sceneSetId);
  if (set === null || set === undefined) throw new Error("no set");
  return set;
}

const slotsOf = (set: StoredSceneSet) => set.scenes.flatMap((scene) => (scene.origin === "planned" ? [scene.slot] : []));

describe("a compose plans for the avatar's origin", () => {
  for (const studio of [true, false]) {
    test(`an avatar ${studio ? "made in Studio" : "read as imported"}: the set's scenes are the planner's for impliedNudity ${String(studio)}`, async () => {
      const avatarId = await seedAvatar(studio);
      const { engine, events } = await boot();
      const set = await composed(engine, events, avatarId);
      const input = { seed: seedOfSet(set.sceneSetId), count: 20, categories: ["home" as const], level: "bold" as const, excludePairs: [] };
      const mine = planForAvatar(input, POOLS, studio).slots;
      expect(mine).not.toEqual(planForAvatar(input, POOLS, !studio).slots);
      expect(slotsOf(set)).toEqual(mine);
    });
  }
});

describe("«Другая сцена» redraws for the avatar's origin", () => {
  for (const studio of [true, false]) {
    test(`an avatar ${studio ? "made in Studio" : "read as imported"}: the redrawn scene is the one the redraw makes for impliedNudity ${String(studio)}`, async () => {
      const avatarId = await seedAvatar(studio);
      const { engine, events } = await boot();
      const set = await composed(engine, events, avatarId);
      // The first scene whose redraw differs by the flag: what the engine stores tells which flag it redrew with.
      const redrawn = async (sceneId: number, flag: boolean) => {
        const target = { kind: "rewrite" as const, sceneIds: [sceneId], redraw: true };
        const plan = await planReviewWrite({ set, target, ledger: null, customCategories: async () => [], impliedNudity: flag });
        // The redrawn slot is recorded with the write before its first call (`beginRewrite`); the write puts it in the scene when it lands.
        const record = plan.begin(set, "job-probe").reviewWrites?.at(-1);
        return record?.kind === "rewrite" ? (record.slots[0] ?? null) : null;
      };
      let chosen: { sceneId: number; mine: Awaited<ReturnType<typeof redrawn>> } | null = null;
      for (const scene of set.scenes) {
        const [mine, other] = [await redrawn(scene.sceneId, studio), await redrawn(scene.sceneId, !studio)];
        if (JSON.stringify(mine) !== JSON.stringify(other)) {
          chosen = { sceneId: scene.sceneId, mine };
          break;
        }
      }
      if (chosen === null) throw new Error("no scene of the set redraws differently by the flag");
      const write = ok(await engine.handle(command("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "rewrite", sceneIds: [chosen.sceneId], redraw: true }, acceptedWorstMicros: ENOUGH })));
      if (write.type !== "scenes.write") throw new Error(`expected a write, got ${write.type}`);
      await jobEnd(events, write.result.jobId);
      const stored = await engine.library?.sceneSets.get(avatarId, set.sceneSetId);
      const scene = stored?.scenes.find((s) => s.sceneId === chosen?.sceneId);
      expect(scene?.origin === "planned" ? scene.slot : null).toEqual(chosen.mine);
    });
  }
});
