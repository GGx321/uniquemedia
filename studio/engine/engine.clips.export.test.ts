import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { EXPORT_CHANGING_DETAIL, ResponseMessage, type ClipSummary } from "../shared/engine";
import type { ExportFpsMode } from "./clips/exportProfile";
import { command, create, jobEnd, jobIdOf, seedClipAvatar, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { engineInit, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.2, §5.13): `clips.export` through the engine's dispatch. It starts the export job of the clip service (a `clip` job in `exporting`) and answers
// its id; the job ends `job.done` with the copy's place, and `clips.get` then shows the copy present. While an export runs it holds the library (a switch waits) and its avatar (a
// delete waits); `avatars.cancel` of it ends it `cancelled` with nothing left in the export folder.

setDefaultTimeout(120_000);

const dir = useEngineDir("studio-engine-clips-export-");
const libraryDir = () => join(dir(), "library");
const exportDir = () => join(dir(), "export");

async function answer(engine: ClipEngine, type: string, payload: object): Promise<ResponseMessage> {
  const response = await engine.engine.handle(command(type, payload));
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  return response;
}

async function reply(engine: ClipEngine, call: unknown): Promise<EngineReply> {
  await engine.engine.receive(call);
  return EngineReply.parse(engine.posted.at(-1));
}

/** An engine with one ready clip made through it; the export runs in `fps` (the kit's clip is 5 s of 720p: duplicate is quick, interpolate takes seconds). */
async function madeClip(fps: ExportFpsMode): Promise<{ engine: ClipEngine; avatarId: string; clipId: string }> {
  const { avatarId, photoId } = await seedClipAvatar(libraryDir());
  const engine = await startClipEngine(dir(), { deps: { clipSwitches: { exportFps: fps } } });
  const clipId = jobIdOf(await create(engine, { avatarId, photoId }));
  await jobEnd(engine, clipId);
  return { engine, avatarId, clipId };
}

function exportJobOf(response: ResponseMessage): string {
  if (!response.ok || response.type !== "clips.export") throw new Error(`expected a clips.export answer, got ${JSON.stringify(response)}`);
  return response.result.jobId;
}

/** The avatar's export folder's names, nothing when it is not there. */
async function exported(): Promise<string[]> {
  return (await readdir(join(exportDir(), "Nini")).catch(() => [])).sort();
}

describe("clips.export through the engine", () => {
  test("starts a clip job in `exporting` that ends job.done with the copy's place; clips.get then shows it present", async () => {
    const { engine, avatarId, clipId } = await madeClip("duplicate");

    const jobId = exportJobOf(await answer(engine, "clips.export", { avatarId, clipId }));
    const end = await jobEnd(engine, jobId);

    expect(end.type).toBe("job.done");
    const relPath = end.type === "job.done" && end.payload.result.kind === "clip" ? end.payload.result.exported?.relPath : undefined;
    expect(relPath).toMatch(/^Nini\/\d{4}-\d{2}-\d{2}_clip_001\.mp4$/);
    const got = await answer(engine, "clips.get", { avatarId, clipId });
    const clip = got.ok && got.type === "clips.get" ? (got.result.clip as ClipSummary) : null;
    expect(clip?.exports.map((line) => [line.relPath, line.profile, line.fileState])).toEqual([[relPath, "1080p30-dup", "present"]]);
    expect(existsSync(join(exportDir(), relPath ?? "-"))).toBe(true);
  });

  test("an unknown clip is NOT_FOUND, and no job starts", async () => {
    const { engine, avatarId } = await madeClip("duplicate");

    const response = await answer(engine, "clips.export", { avatarId, clipId: "clip-0000404" });

    expect(response.ok ? null : response.error.code).toBe("NOT_FOUND");
    expect(engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "exporting")).toBe(false);
  });
});

describe("an export and a pick of another export folder", () => {
  test("after an ok pick clips.export is refused IN_FLIGHT until the settings arrive; then the copy goes into the new folder and reads present", async () => {
    const { engine, avatarId, clipId } = await madeClip("duplicate");
    const other = join(dir(), "other-export");
    await mkdir(other, { recursive: true });

    const picked = await reply(engine, { kind: "control", type: "export.choose", callId: "call-00000007", path: other });
    expect(picked.exportFolder).toBeDefined();
    const refused = await answer(engine, "clips.export", { avatarId, clipId });
    expect(refused.ok ? null : refused.error).toMatchObject({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });

    await engine.engine.receive({ kind: "control", type: "settings.update", settings: { ...engineInit(dir()).settings, imageAgeCheck: "off", exportPath: other } });
    const jobId = exportJobOf(await answer(engine, "clips.export", { avatarId, clipId }));
    const end = await jobEnd(engine, jobId);
    const relPath = end.type === "job.done" && end.payload.result.kind === "clip" ? end.payload.result.exported?.relPath : undefined;

    expect(existsSync(join(other, relPath ?? "-"))).toBe(true);
    expect(await exported()).toEqual([]);
    const got = await answer(engine, "clips.get", { avatarId, clipId });
    expect(got.ok && got.type === "clips.get" ? got.result.clip.exports.map((line) => line.fileState) : null).toEqual(["present"]);
  });
});

describe("a running export", () => {
  /** An export long enough to be looked at while it runs: 5 s of 720p, motion-interpolated. */
  async function running(): Promise<{ engine: ClipEngine; avatarId: string; clipId: string; jobId: string }> {
    const made = await madeClip("interpolate");
    const jobId = exportJobOf(await answer(made.engine, "clips.export", { avatarId: made.avatarId, clipId: made.clipId }));
    await until(() => made.engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId && e.payload.phase === "exporting"), "the export running");
    return { ...made, jobId };
  }

  test("is cancelled by avatars.cancel, and leaves nothing in the export folder", async () => {
    const { engine, jobId } = await running();

    const response = await answer(engine, "avatars.cancel", { jobId });
    const end = await jobEnd(engine, jobId);

    expect(response.ok).toBe(true);
    expect(end.type).toBe("job.cancelled");
    expect(await exported()).toEqual([]);
  });

  test("refuses a library switch, and the detail names a clip", async () => {
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    const { engine, jobId } = await running();

    const refused = await reply(engine, { kind: "control", type: "library.open", callId: "call-00000009", path: other });

    expect(refused.error?.code).toBe("IN_FLIGHT");
    expect(refused.error?.detail).toContain("clip");
    await answer(engine, "avatars.cancel", { jobId });
    await jobEnd(engine, jobId);
  });

  test("refuses its avatar's delete", async () => {
    const { engine, avatarId, jobId } = await running();

    const refused = await reply(engine, { kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token: "token-00000001" });

    expect(refused.error?.code).toBe("IN_FLIGHT");
    await answer(engine, "avatars.cancel", { jobId });
    await jobEnd(engine, jobId);
  });

  test("refuses a pick of another export folder (export.choose) IN_FLIGHT, naming the clip", async () => {
    const other = join(dir(), "other-export");
    await mkdir(other, { recursive: true });
    const { engine, jobId } = await running();

    const refused = await reply(engine, { kind: "control", type: "export.choose", callId: "call-00000007", path: other });

    expect(refused.error).toMatchObject({ code: "IN_FLIGHT" });
    expect(refused.error?.detail).toContain("clip");
    expect(refused.exportFolder).toBeUndefined();
    await answer(engine, "avatars.cancel", { jobId });
    await jobEnd(engine, jobId);
  });

  test("a second export of the same clip is IN_FLIGHT job-running", async () => {
    const { engine, avatarId, clipId, jobId } = await running();

    const second = await answer(engine, "clips.export", { avatarId, clipId });

    expect(second.ok ? null : second.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    await answer(engine, "avatars.cancel", { jobId });
    await jobEnd(engine, jobId);
  });
});
