import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { SceneLevel } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import type { QaGate } from "./runs/qa";
import { command, engineSettings, GOOD, network, ok, portraitPng, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(30_000);

// 5a.4 (S5.BA9, plan s5a4 §8 BA9, I5.77): an own scene of a «Смелая» set is drawn on the Seedream route, so every figure that prices a run from the set counts it at the 2K unit: the strip's
// `runs.estimateImages` with the set (the figure the owner accepts) is the very figure of `runs.estimateFromScenes` and of the start. Below «Смелая» the own scene stays on the owner's model.
// The settings' model is Grok quality (60 000 µ$ an attempt with the master as its reference); the 2K attempt is 93 000 µ$ (the dated table).

const dir = useEngineDir("studio-engine-own-bold-");
const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });

let seeded = 0;
async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

async function boot() {
  const settings = engineSettings(dir(), { imageAgeCheck: "off", imageModel: "x-ai/grok-imagine-image-quality", imageQuality: null });
  return startEngine(dir(), { init: { settings }, net: network({}), deps: { qaGates: [faceGate()] } });
}

/** A set at `level` of three written «Дом» scenes off the route and one own scene in lingerie (id 4), for `avatarId`. */
async function seedSet(avatarId: string, sceneSetId: string, level: SceneLevel | undefined): Promise<void> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seedset${++seeded}`) });
  const set = sampleSet({ sceneSetId, avatarId, runId: `run-${sceneSetId}`, count: 3, written: 3 });
  const text = level === "bold" ? "She lies across her bed in a black lace bra and panties, smiling at the viewer." : "She sips coffee on a sunny balcony.";
  await library.sceneSets.create({ ...set, request: { ...set.request, ...(level === undefined ? {} : { level }) }, scenes: [...set.scenes, { sceneId: 4, origin: "own" as const, idea: "в белье на кровати", shot: "friend" as const, pose: "front" as const, text, edited: false, removed: false }] });
}

type Engine = Awaited<ReturnType<typeof boot>>["engine"];

async function figures(engine: Engine, avatarId: string, sceneSetId: string) {
  const images = ok(await engine.handle(command("runs.estimateImages", { avatarId, count: 4, sceneSetId })));
  if (images.type !== "runs.estimateImages") throw new Error(`expected an images estimate, got ${images.type}`);
  const set = await engine.library?.sceneSets.get(avatarId, sceneSetId);
  const drawn = ok(await engine.handle(command("runs.estimateFromScenes", { sceneSetId, revision: set?.revision })));
  if (drawn.type !== "runs.estimateFromScenes") throw new Error(`expected an estimate, got ${drawn.type}`);
  return { images: images.result.estimate, drawn: drawn.result.estimate };
}

describe("a run from a set with an own scene is priced by the own scene's route (S5.BA9)", () => {
  test("«Смелая»: the own scene is at the 2K unit in the strip's figure and in «Отрисовать»'s, and the two are one", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, "set-own-bold-0001", "bold");
    const { engine } = await boot();
    const { images, drawn } = await figures(engine, avatarId, "set-own-bold-0001");
    expect(drawn.worstMicros).toBe(3 * 93_000 + 3 * 3 * 60_000);
    expect(drawn.boldAttemptMicros).toBe(93_000);
    expect(images).toEqual(drawn);
  });

  test("«Кокетливая»: the own scene stays at the owner's model, in both figures", async () => {
    const avatarId = await seedAvatar();
    await seedSet(avatarId, "set-own-bold-0002", "flirty");
    const { engine } = await boot();
    const { images, drawn } = await figures(engine, avatarId, "set-own-bold-0002");
    expect(drawn.worstMicros).toBe(4 * 3 * 60_000);
    expect(drawn.boldAttemptMicros).toBeUndefined();
    expect(images).toEqual(drawn);
  });
});
