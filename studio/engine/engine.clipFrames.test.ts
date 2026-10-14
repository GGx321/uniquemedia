import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { LaunchPreview, type LaunchDraftInput } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { useClipFixtures } from "./clips/testing/clipFixtures";
import { plantReadyClip, type PlantedClip } from "./clips/testing/copyKit";
import { command, jobEnd, type ClipEngine } from "./clips/testing/engineClipKit";
import { copyOfPlanted, montageOf, seedFramesAvatar, startRenderEngine, type FramesAvatar } from "./clips/testing/renderKit";
import { IDLE_STEPS } from "./autopilot/steps";
import { useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
setDefaultTimeout(120_000);

// 5b.2, S5.WA2 (I5.60, Q-F = 1) through the real engine: a photo and every clip made from it are one frame, for the autopilot's pool too. The preview of a launch (`fromLibrary`) counts the library photos
// the autopilot may pick: a photo whose clip is in a finished video or in a saved draft is not one of them, and stays out when the copy, the clip and a restart have come and gone.

const dir = useEngineDir("studio-engine-clip-frames-");
const libraryDir = (): string => join(dir(), "library");
const sourceClip = useClipFixtures();
const SMALL = { width: 360, height: 640, seconds: 3, fps: 24, audio: false } as const;

const DRAFT = (avatarId: string): LaunchDraftInput => ({
  avatarIds: [avatarId],
  videosPerAvatar: 3,
  mix: { single: 100, collage: 0, slides: 0 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: true,
  generate: false,
  sceneReview: false,
  stickers: false,
});

async function fromLibrary(started: ClipEngine, avatarId: string): Promise<number> {
  const answer = await started.engine.handle(command("autopilot.estimate", { draft: DRAFT(avatarId) }));
  if (!answer.ok || answer.type !== "autopilot.estimate") throw new Error(`no estimate: ${JSON.stringify(answer)}`);
  expect(LaunchPreview.safeParse(answer.result.preview).success).toBe(true);
  return answer.result.preview.avatars[0]?.fromLibrary ?? -1;
}

async function world(): Promise<{ started: ClipEngine; a: FramesAvatar; clip: PlantedClip }> {
  const a = await seedFramesAvatar(libraryDir(), 3);
  const started = await startRenderEngine(dir(), { deps: { launchSteps: IDLE_STEPS } });
  const clip = await plantReadyClip(libraryDir(), a.avatarId, a.photoIds[1] ?? "", await sourceClip(SMALL), { width: 360, height: 640, durationMs: 3_000 });
  return { started, a, clip };
}

describe("the autopilot's library photos and a clip's photo", () => {
  test("a saved draft that holds the clip's copy keeps the clip's photo out of a launch, and a deleted copy gives it back", async () => {
    const { started, a, clip } = await world();
    expect(await fromLibrary(started, a.avatarId)).toBe(3);
    const mediaId = await copyOfPlanted(started, clip);
    const created = await started.engine.handle(command("montages.create", { avatarId: a.avatarId, photoIds: [a.photoIds[0] ?? ""] }));
    if (!created.ok || created.type !== "montages.create") throw new Error(`no draft: ${JSON.stringify(created)}`);
    const saved = await started.engine.handle(command("montages.save", { montageId: created.result.montage.montageId, spec: montageOf(a.avatarId, [{ scene: a.photoIds[0] ?? "" }, { copy: mediaId }]), name: null }));
    expect(saved.ok ? "saved" : JSON.stringify(saved.error)).toBe("saved");

    expect(await fromLibrary(started, a.avatarId)).toBe(1);

    expect((await started.engine.handle(command("media.delete", { mediaId }))).ok).toBe(true);
    // The draft names a copy that is gone: it holds no frame for it (and the avatar is not unknown to the autopilot).
    expect(await fromLibrary(started, a.avatarId)).toBe(2);
  });

  test("a finished video that holds the copy keeps the clip's photo out, after the clip is deleted and the engine restarted", async () => {
    const { started, a, clip } = await world();
    const mediaId = await copyOfPlanted(started, clip);
    const render = await started.engine.handle(command("videos.render", { spec: montageOf(a.avatarId, [{ scene: a.photoIds[0] ?? "" }, { copy: mediaId }]) }));
    if (!render.ok || render.type !== "videos.render") throw new Error(`the render was refused: ${JSON.stringify(render)}`);
    expect((await jobEnd(started, render.result.jobId)).type).toBe("job.done");
    expect(await fromLibrary(started, a.avatarId)).toBe(1);

    expect((await started.engine.handle(command("clips.delete", { avatarId: a.avatarId, clipId: clip.clipId }))).ok).toBe(true);
    expect(await fromLibrary(started, a.avatarId)).toBe(1);

    await started.engine.shutdown();
    const second = await startRenderEngine(dir(), { deps: { launchSteps: IDLE_STEPS } });
    expect(await fromLibrary(second, a.avatarId)).toBe(1);
    const again = await second.engine.handle(command("videos.render", { spec: montageOf(a.avatarId, [{ scene: a.photoIds[1] ?? "" }, { scene: a.photoIds[2] ?? "" }]) }));
    expect(!again.ok && again.error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "in-video" });
  });
});
