import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { LaunchPreview, type LaunchDraftInput } from "../shared/engine";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { IDLE_STEPS } from "./autopilot/steps";
import { clipNetwork, clipsDir, command, create, jobEnd, jobIdOf, phasesOf, seedClipAvatar, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { GOOD, ledgerLines, useEngineDir } from "./testing/engineHarness";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 I5.50): what a live clip holds. A library switch waits for it (the detail names a clip) and an avatar delete waits for it (`hasLiveJobFor`
// counts clip jobs); a clip never claims its avatar, so an edit goes on and the autopilot does not skip the avatar. A delete prepared while a create waits for its prices wins:
// the create makes no job, no journal and no reserve.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clips-busy-");
const libraryDir = () => join(dir(), "library");

async function reply(engine: ClipEngine, call: unknown): Promise<EngineReply> {
  await engine.engine.receive(call);
  return EngineReply.parse(engine.posted.at(-1));
}

const deletePrepare = (avatarId: string) => ({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });
const deleteFinish = (avatarId: string) => ({ kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId, token: "token-00000001", outcome: "kept" });

/** A clip held in `rendering` (its polls answer «in progress» until released). */
async function liveClip(): Promise<{ engine: ClipEngine; avatarId: string; photoId: string; jobId: string }> {
  const { avatarId, photoId } = await seedClipAvatar(libraryDir());
  const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }), deps: { launchSteps: IDLE_STEPS } });
  const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
  await until(() => phasesOf(engine, jobId).includes("rendering"), "rendering");
  return { engine, avatarId, photoId, jobId };
}

describe("a live clip", () => {
  test("refuses a library switch, and the detail names a clip", async () => {
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    const { engine, jobId } = await liveClip();

    const answer = await reply(engine, { kind: "control", type: "library.open", callId: "call-00000009", path: other });
    expect(answer.error?.code).toBe("IN_FLIGHT");
    expect(answer.error?.detail).toContain("clip");
    expect(engine.engine.library?.root).toBe(libraryDir());
    engine.net.release("kling");
    await jobEnd(engine, jobId);
  });

  test("refuses a library switch while its file is still being fetched, after its money closed", async () => {
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { content: "held" } }) });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    await until(() => phasesOf(engine, jobId).includes("downloading"), "downloading");

    const answer = await reply(engine, { kind: "control", type: "library.open", callId: "call-00000009", path: other });
    expect(answer.error?.code).toBe("IN_FLIGHT");
    expect(answer.error?.detail).toContain("clip");
    engine.net.releaseContent("kling");
    await jobEnd(engine, jobId);
  });

  test("refuses an avatar delete (`hasLiveJobFor` counts it), and lets it through once the clip ends", async () => {
    const { engine, avatarId, jobId } = await liveClip();
    const refused = await reply(engine, deletePrepare(avatarId));
    expect(refused.error?.code).toBe("IN_FLIGHT");
    expect(refused.error?.detail).toContain("a clip of this avatar");
    engine.net.release("kling");
    await jobEnd(engine, jobId);
    expect((await reply(engine, deletePrepare(avatarId))).error).toBeUndefined();
    await reply(engine, deleteFinish(avatarId));
  });

  test("never claims its avatar: the descriptor can be edited meanwhile", async () => {
    const { engine, avatarId, jobId } = await liveClip();
    const answer = await engine.engine.handle(command("avatars.editDescriptor", { avatarId, text: `${GOOD} Small mole on the left cheek.`, expectedText: GOOD }));
    expect(answer.ok).toBe(true);
    engine.net.release("kling");
    await jobEnd(engine, jobId);
  });

  test("does not make the autopilot skip its avatar (`isBusy` leaves clips out)", async () => {
    const { engine, avatarId, jobId } = await liveClip();
    const draft: LaunchDraftInput = {
      avatarIds: [avatarId],
      videosPerAvatar: 4,
      mix: { single: 50, collage: 25, slides: 25 },
      categories: ["home"],
      poses: { profile: false, back: false },
      library: false,
      generate: true,
      sceneReview: false,
      stickers: false,
    };
    const answer = await engine.engine.handle(command("autopilot.estimate", { draft }));
    if (!answer.ok || answer.type !== "autopilot.estimate") throw new Error(`no estimate: ${JSON.stringify(answer)}`);
    expect(LaunchPreview.safeParse(answer.result.preview).success).toBe(true);
    expect(answer.result.preview.avatars[0]).toMatchObject({ avatarId, busy: false });
    engine.net.release("kling");
    await jobEnd(engine, jobId);
  });
});

describe("a delete prepared while a create waits for its prices", () => {
  test("wins: no job, no journal and no reserve on the detached avatar", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ listing: "held" });
    const engine = await startClipEngine(dir(), { net, deps: { launchSteps: IDLE_STEPS } });
    const pending = create(engine, { avatarId, photoId });
    await until(() => net.calls.some((c) => c.url.endsWith("/videos/models")), "the price load");

    expect((await reply(engine, deletePrepare(avatarId))).error).toBeUndefined();
    net.releasePrices();
    const answer = await pending;
    expect(answer).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip")).toBe(false);
    expect(ledgerLines(dir())).toEqual([]);
    const folder = clipsDir(libraryDir(), avatarId);
    expect(existsSync(folder) ? await readdir(folder) : []).toEqual([]);
    await reply(engine, deleteFinish(avatarId));
  });
});
