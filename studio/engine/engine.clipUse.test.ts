import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { ClipSummary, type ClipUse } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { useClipFixtures } from "./clips/testing/clipFixtures";
import { plantReadyClip, type PlantedClip } from "./clips/testing/copyKit";
import { command, jobEnd, type ClipEngine } from "./clips/testing/engineClipKit";
import { copyOfPlanted, montageOf, seedFramesAvatar, startRenderEngine, type FramesAvatar } from "./clips/testing/renderKit";
import { useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
setDefaultTimeout(120_000);

// 5b.2, S5.WA2 (Q-F = 1) through the real engine: `ClipSummary.use` on a ready clip. `inVideo` is `clip` when a finished video holds this clip's copy and `photo` when the frame is used through the photo
// itself or a sibling clip; `inDrafts` is how many saved drafts hold the clip's copy, with the draft's name and the clip's 1-based place only when there is exactly one.

const dir = useEngineDir("studio-engine-clip-use-");
const libraryDir = (): string => join(dir(), "library");
const sourceClip = useClipFixtures();
const SMALL = { width: 360, height: 640, seconds: 3, fps: 24, audio: false } as const;

interface World {
  started: ClipEngine;
  a: FramesAvatar;
  /** The clip whose copy the tests use, its sibling made from the same photo, and a clip of another photo. */
  clip: PlantedClip;
  sibling: PlantedClip;
  other: PlantedClip;
}

async function world(): Promise<World> {
  const a = await seedFramesAvatar(libraryDir(), 3);
  const started = await startRenderEngine(dir());
  const source = await sourceClip(SMALL);
  const plant = (photoIndex: number) => plantReadyClip(libraryDir(), a.avatarId, a.photoIds[photoIndex] ?? "", source, { width: 360, height: 640, durationMs: 3_000 });
  return { started, a, clip: await plant(1), sibling: await plant(1), other: await plant(2) };
}

async function useOf(w: World, planted: PlantedClip): Promise<ClipUse | undefined> {
  const listed = await w.started.engine.handle(command("clips.list", { avatarId: w.a.avatarId }));
  if (!listed.ok || listed.type !== "clips.list") throw new Error(`no list: ${JSON.stringify(listed)}`);
  expect(listed.result.clips.every((c) => ClipSummary.safeParse(c).success)).toBe(true);
  const summary = listed.result.clips.find((c) => c.clipId === planted.clipId);
  if (summary === undefined || summary.status !== "ready") throw new Error("the clip is not listed ready");
  const got = await w.started.engine.handle(command("clips.get", { avatarId: w.a.avatarId, clipId: planted.clipId }));
  if (!got.ok || got.type !== "clips.get" || got.result.clip.status !== "ready") throw new Error("no clip");
  expect(got.result.clip.use).toEqual(summary.use);
  return summary.use;
}

async function draftHolding(w: World, mediaId: string, name: string | null, parts: "photo-first" | "copy-first" = "photo-first"): Promise<void> {
  const created = await w.started.engine.handle(command("montages.create", { avatarId: w.a.avatarId, photoIds: [w.a.photoIds[0] ?? ""] }));
  if (!created.ok || created.type !== "montages.create") throw new Error(`no draft: ${JSON.stringify(created)}`);
  const clips = parts === "photo-first" ? [{ scene: w.a.photoIds[0] ?? "" }, { copy: mediaId }] : [{ copy: mediaId }, { scene: w.a.photoIds[0] ?? "" }];
  const saved = await w.started.engine.handle(command("montages.save", { montageId: created.result.montage.montageId, spec: montageOf(w.a.avatarId, clips), name }));
  expect(saved.ok ? "saved" : JSON.stringify(saved.error)).toBe("saved");
}

describe("ClipSummary.use through the engine", () => {
  test("a clip nothing uses has no use", async () => {
    const w = await world();
    expect(await useOf(w, w.clip)).toBeUndefined();
  });

  test("one saved draft that holds the copy: inDrafts is 1 with the draft's name and the clip's place in it", async () => {
    const w = await world();
    const mediaId = await copyOfPlanted(w.started, w.clip);
    await draftHolding(w, mediaId, "Лето");

    expect(await useOf(w, w.clip)).toEqual({ inDrafts: { count: 1, first: { name: "Лето", frame: 2 } } });
    expect(await useOf(w, w.sibling)).toBeUndefined();
    expect(await useOf(w, w.other)).toBeUndefined();
  });

  test("a draft with no name says null, and a second draft makes the count 2 with no first", async () => {
    const w = await world();
    const mediaId = await copyOfPlanted(w.started, w.clip);
    await draftHolding(w, mediaId, null, "copy-first");
    expect(await useOf(w, w.clip)).toEqual({ inDrafts: { count: 1, first: { name: null, frame: 1 } } });

    await draftHolding(w, mediaId, "Зима");

    expect(await useOf(w, w.clip)).toEqual({ inDrafts: { count: 2 } });
  });

  test("a finished video that holds the copy: inVideo is clip for it and photo for a sibling clip of the same photo; a clip of another photo has none", async () => {
    const w = await world();
    const mediaId = await copyOfPlanted(w.started, w.clip);
    const render = await w.started.engine.handle(command("videos.render", { spec: montageOf(w.a.avatarId, [{ scene: w.a.photoIds[0] ?? "" }, { copy: mediaId }]) }));
    if (!render.ok || render.type !== "videos.render") throw new Error(`the render was refused: ${JSON.stringify(render)}`);
    expect((await jobEnd(w.started, render.result.jobId)).type).toBe("job.done");

    expect(await useOf(w, w.clip)).toEqual({ inVideo: "clip" });
    expect(await useOf(w, w.sibling)).toEqual({ inVideo: "photo" });
    expect(await useOf(w, w.other)).toBeUndefined();
  });

  test("the video and the draft together: both keys", async () => {
    const w = await world();
    const mediaId = await copyOfPlanted(w.started, w.clip);
    await draftHolding(w, mediaId, "Лето");
    const render = await w.started.engine.handle(command("videos.render", { spec: montageOf(w.a.avatarId, [{ scene: w.a.photoIds[0] ?? "" }, { copy: mediaId }]) }));
    if (!render.ok || render.type !== "videos.render") throw new Error("the render was refused");
    await jobEnd(w.started, render.result.jobId);

    expect(await useOf(w, w.clip)).toEqual({ inVideo: "clip", inDrafts: { count: 1, first: { name: "Лето", frame: 2 } } });
  });

  test("a clip that is not ready has no use", async () => {
    const w = await world();
    const listed = await w.started.engine.handle(command("clips.list", { avatarId: w.a.avatarId }));
    if (!listed.ok || listed.type !== "clips.list") throw new Error("no list");
    expect(listed.result.clips.filter((c) => c.status !== "ready" && "use" in c)).toEqual([]);
  });
});
