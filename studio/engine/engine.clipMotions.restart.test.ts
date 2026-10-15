import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ownIdeaLabel } from "../shared/engine";
import { OWN_IDEA_FALLBACK_LABEL } from "../shared/engine";
import { SHORT_CLIP_TIMINGS, type ClipTimings } from "./clips/timings";
import { clipsDir, create, jobEnd, jobIdOf, options, optionsOf, phasesOf, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { motionNetwork } from "./clips/testing/motionNet";
import { GOOD_TEXTS, IDEA, ideaReply, motionWorld } from "./clips/testing/motionWorld";
import { readClipRecord } from "./clips/store";
import { useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();
setDefaultTimeout(60_000);

// Stage 5, 5b.2, S5.WC3 (plan s5b2 I5.67): the journal's `requested` line for an own idea has no label, so a clip that was in flight at a quit comes back with the label from the photo's motion store,
// else «Своя идея». The recovery stays free (it writes no ledger line) and the idea's words are not brought back from anywhere.

const dir = useEngineDir("studio-engine-clip-motions-restart-");
const MIN = 60_000;
const TIMINGS: ClipTimings = { ...SHORT_CLIP_TIMINGS, lateGiveUpMs: 10 * MIN, holdTerminalMs: 30_000, holdUncertainMs: 30_000, holdSubmittedMs: 10 * MIN };

/** An own-idea clip in `rendering` when the process stops. */
async function quitMidOwnClip(): Promise<{ avatarId: string; clipId: string; libraryDir: string; storePath: string }> {
  const net = motionNetwork({ chat: () => ideaReply(GOOD_TEXTS[0] ?? ""), clip: { kling: { held: true } } });
  const w = await motionWorld(dir(), { net, engine: { timings: TIMINGS } });
  await w.translate();
  const clipId = jobIdOf(await create(w.started, { avatarId: w.avatarId, photoId: w.photoId, motionId: "o-1" }));
  await until(() => phasesOf(w.started, clipId).includes("rendering"), "rendering");
  await w.started.engine.shutdown();
  await jobEnd(w.started, clipId);
  return { avatarId: w.avatarId, clipId, libraryDir: w.libraryDir, storePath: w.storePath() };
}

async function recovered(engine: ClipEngine, avatarId: string, clipId: string, libraryDir: string) {
  await until(() => engine.events().some((e) => e.type === "job.done" && e.payload.result.kind === "clip"), "the recovery job's end");
  const read = await readClipRecord(clipsDir(libraryDir, avatarId), clipId);
  if (read.kind !== "record") throw new Error(`expected a record, got ${read.kind}`);
  return read.record;
}

describe("a quit while an own-idea clip renders, then a new engine on the same folders", () => {
  test("the recovered clip keeps the label the photo's motion store holds for the idea's English text", async () => {
    const { avatarId, clipId, libraryDir } = await quitMidOwnClip();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    const record = await recovered(second, avatarId, clipId, libraryDir);
    expect(record).toMatchObject({ recovered: true, motion: { source: "own", label: ownIdeaLabel(IDEA), text: GOOD_TEXTS[0] } });
  });

  test("with the store gone the label is «Своя идея», and the recovery is not hindered", async () => {
    const { avatarId, clipId, libraryDir, storePath } = await quitMidOwnClip();
    await rm(storePath);
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    const record = await recovered(second, avatarId, clipId, libraryDir);
    expect(record).toMatchObject({ recovered: true, motion: { source: "own", label: OWN_IDEA_FALLBACK_LABEL, text: GOOD_TEXTS[0] }, outcome: { status: "ready" } });
  });

  test("the recovery job announces the restored label in its facts", async () => {
    const { avatarId, clipId, libraryDir } = await quitMidOwnClip();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    await recovered(second, avatarId, clipId, libraryDir);
    const progress = second.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload] : []));
    expect(progress.length).toBeGreaterThan(0);
    for (const event of progress) expect(event.motion).toEqual({ source: "own", label: ownIdeaLabel(IDEA) });
  });
});

describe("the survey ignores the `motions` folder", () => {
  test("a library reopened with a photo's motion store in its avatar folder quarantines nothing, keeps the photo, and still lists the stored motions", async () => {
    const w = await motionWorld(dir(), { chat: () => ideaReply(GOOD_TEXTS[0] ?? "") });
    await w.translate();
    await w.started.engine.shutdown();
    const second = await startClipEngine(dir(), { timings: TIMINGS });
    const library = second.engine.library;
    expect(library?.getPhoto(w.photoId)).toBeDefined();
    const listed = optionsOf(await options(second, w.avatarId, w.photoId));
    expect(listed.suitable && listed.motions.map((m) => m.id)).toContain("o-1");
    expect(existsSync(join(w.libraryDir, "quarantine"))).toBe(false);
    expect((await readdir(join(w.libraryDir, "avatars", w.avatarId, "motions"))).sort()).toEqual([`${w.photoId}.json`]);
  });
});
