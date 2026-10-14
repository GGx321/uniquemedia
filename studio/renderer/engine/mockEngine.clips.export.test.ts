import { describe, expect, test } from "bun:test";
import { expectedExportBytes, expectedExportFrames } from "../../engine/clips/exportProfile";
import { FREE_MARGIN_BYTES } from "../../engine/freeBytes";
import { AVATAR, create, endOf, listClips, makeClipMock, money, onlyClip, progressOf, refusal, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7 (plan §5.13, I5.55; owner Q-C): «Сохранить в папку» in the mock, as the engine's export job answers it (engine.clips.export.test.ts is the reference): a clip job in
// phase `exporting` whose done/total are frames, the claimed name `<date>_clip_<NNN>.mp4`, the record's export line with the profile the fps mode made, and the refusals in the engine's order.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function exportedPath(m: ClipMock, jobId: string): string {
  const end = endOf(m.events, jobId);
  if (end?.type !== "job.done" || end.payload.result.kind !== "clip" || end.payload.result.exported === undefined) throw new Error("the export did not end done with a copy");
  return end.payload.result.exported.relPath;
}

async function readyClip(m: ClipMock): Promise<string> {
  return runClip(m);
}

async function exportClip(m: ClipMock, clipId: string): Promise<string> {
  const { jobId } = await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
  m.scheduler.runAll();
  return jobId;
}

// engine/exportName.ts `formatExportDate`: the date in the name is the LOCAL calendar date, what the owner reads. Two zones 25 hours apart (UTC+14, UTC-11) cannot both read the UTC date at any instant.
describe("the date in the copy's name", () => {
  const localDate = (date: Date): string => `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  test("is the local calendar date of the export's instant, not the UTC one", async () => {
    const was = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const found: { zone: string; named: string; local: string; utc: string }[] = [];
    try {
      for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
        process.env.TZ = zone;
        const m = makeClipMock();
        const clipId = await readyClip(m);
        const jobId = await exportClip(m, clipId);
        const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId }));
        const at = clip.exports[0]?.at ?? "";
        found.push({ zone, named: exportedPath(m, jobId).split("/")[1]?.slice(0, 10) ?? "", local: localDate(new Date(at)), utc: at.slice(0, 10) });
      }
    } finally {
      // Always assign: in Bun, `delete process.env.TZ` leaves the process in the last zone set, and later files in the worker would read their dates in it.
      process.env.TZ = was;
    }
    // A leaked zone fails here, in this file, not as a date mismatch in some later screen test.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(was);
    expect(found.some((f) => f.local !== f.utc)).toBe(true);
    for (const f of found) expect(f.named).toBe(f.local);
  });
});

describe("clips.export", () => {
  test("starts a clip job in `exporting` that ends job.done with the copy's place; clips.get then shows it present", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const jobId = await exportClip(m, clipId);
    const relPath = exportedPath(m, jobId);
    expect(relPath).toMatch(/^Mia\/\d{4}-\d{2}-\d{2}_clip_001\.mp4$/);
    const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId }));
    expect(clip.exports).toEqual([expect.objectContaining({ relPath, profile: "1080p30-interp", fileState: "present", bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(clip.exports[0]?.relPath.split("/")[1]?.slice(0, 10)).toMatch(DATE);
    // The list shows the lines without a state: it never looks at the folder.
    expect((await onlyClip(m)).exports[0]).not.toHaveProperty("fileState");
  });

  test("a job in `exporting` whose done/total are frames: it starts at 0 of the clip's frames and ends at the total; no phase but `exporting`", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const { jobId } = await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
    const first = progressOf(m.events, jobId)[0];
    expect(first).toMatchObject({ kind: "clip", jobId, clipId, phase: "exporting", done: 0, total: expectedExportFrames(5_000, "interpolate") });
    m.scheduler.runAll();
    const progress = progressOf(m.events, jobId);
    expect(new Set(progress.map((p) => p.phase))).toEqual(new Set(["exporting"]));
    const dones = progress.map((p) => p.done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
    expect(new Set(dones).size).toBe(dones.length);
    expect(dones.at(-1)).toBeLessThanOrEqual(150);
    expect(dones.length).toBeGreaterThan(2);
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "clip", avatarId: AVATAR, clipId } } });
  });

  test("the three fps modes: the profile the record names and the frames the progress counts to", async () => {
    for (const [mode, profile, frames] of [
      ["interpolate", "1080p30-interp", 150],
      ["duplicate", "1080p30-dup", 150],
      ["native24", "1080p24", 120],
    ] as const) {
      const m = makeClipMock({ clips: { exportFps: mode } });
      const clipId = await readyClip(m);
      const { jobId } = await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
      expect(progressOf(m.events, jobId)[0]?.total).toBe(frames);
      m.scheduler.runAll();
      expect((await onlyClip(m)).exports.map((e) => e.profile)).toEqual([profile]);
    }
    expect(expectedExportFrames(10_000, "native24")).toBe(240);
  });

  test("each export is a new file with the next number; a number a record names is never reused, even when its file is gone", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) names.push(exportedPath(m, await exportClip(m, clipId)));
    expect(names.map((n) => n.slice(-13))).toEqual(["_clip_001.mp4", "_clip_002.mp4"]);
    m.engine.tamperClipExport(clipId, 1, "missing");
    const third = exportedPath(m, await exportClip(m, clipId));
    expect(third.slice(-13)).toBe("_clip_003.mp4");
    const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId }));
    expect(clip.exports.map((e) => e.fileState)).toEqual(["present", "missing", "present"]);
  });

  test("two clips of one avatar and one day share the numbering; the copy survives the clip's own delete", async () => {
    const m = makeClipMock();
    const a = await readyClip(m);
    const b = await readyClip(m);
    const first = exportedPath(m, await exportClip(m, a));
    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId: a }));
    const second = exportedPath(m, await exportClip(m, b));
    expect([first.slice(-13), second.slice(-13)]).toEqual(["_clip_001.mp4", "_clip_002.mp4"]);
  });
});

describe("clips.export refuses, free and in order", () => {
  test("NOT_FOUND for a clip or an avatar the library does not have; no job starts", async () => {
    const m = makeClipMock();
    expect((await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
    expect((await refusal(m.client.request("clips.export", { avatarId: "avatar-nope-0001", clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
    expect(m.events.some((e) => e.type === "job.progress" && e.payload.kind === "clip")).toBe(false);
  });

  test("VALIDATION `not-ready` for a clip that failed: it has no file to save", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("rate-limited");
    const clipId = await runClip(m);
    expect(await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "VALIDATION", clipReason: "not-ready" });
  });

  test("IN_FLIGHT `job-running` for a second export of a clip being saved", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
    expect(await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    m.scheduler.runAll();
    expect((await m.client.request("clips.export", { avatarId: AVATAR, clipId })).ok).toBe(true);
    m.scheduler.runAll();
  });

  test("the order: not found, then not ready, then a job running, then the folder", async () => {
    const m = makeClipMock();
    m.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    expect((await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
    m.engine.scriptNextClip("rate-limited");
    const failed = await runClip(m);
    expect(await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId: failed }))).toMatchObject({ clipReason: "not-ready" });
  });

  test("EXPORT_UNAVAILABLE with the render's reason when the folder cannot take the file", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    for (const reason of ["missing", "not-a-directory", "not-writable", "invalid-marker"] as const) {
      m.engine.setExportDisk({ status: "unavailable", reason });
      expect(await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: reason });
    }
    m.engine.setExportDisk({ status: "ok" });
    expect((await m.client.request("clips.export", { avatarId: AVATAR, clipId })).ok).toBe(true);
    m.scheduler.runAll();
  });

  test("`not-enough-space` when the volume has less than twice the expected size plus the margin", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const need = (expectedExportBytes(5_000) + FREE_MARGIN_BYTES) * 2;
    m.engine.setExportFreeBytes(need - 1);
    expect(await refusal(m.client.request("clips.export", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" });
    m.engine.setExportFreeBytes(need);
    expect((await m.client.request("clips.export", { avatarId: AVATAR, clipId })).ok).toBe(true);
    m.scheduler.runAll();
  });
});

describe("a running export", () => {
  async function running(m: ClipMock): Promise<{ clipId: string; jobId: string }> {
    const clipId = await readyClip(m);
    const { jobId } = await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
    return { clipId, jobId };
  }

  test("one export runs at a time; the next waits its turn at 0 and shows no progress until then", async () => {
    const m = makeClipMock();
    const a = await readyClip(m);
    const b = await readyClip(m);
    const first = (await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId: a }))).jobId;
    const second = (await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId: b }))).jobId;
    expect(progressOf(m.events, second)).toEqual([]);
    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.filter((j) => j.kind === "clip" && j.status === "running").map((j) => [j.jobId, j.done])).toEqual([
      [first, 0],
      [second, 0],
    ]);
    m.scheduler.runAll();
    const firstEnd = m.events.findIndex((e) => e.type === "job.done" && e.payload.jobId === first);
    const secondStart = m.events.findIndex((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === second);
    expect(firstEnd).toBeGreaterThan(-1);
    expect(secondStart).toBeGreaterThan(firstEnd);
    // One avatar, one day, one kind: the second clip's copy takes the next number.
    expect([exportedPath(m, first).slice(-13), exportedPath(m, second).slice(-13)]).toEqual(["_clip_001.mp4", "_clip_002.mp4"]);
  });

  test("is cancelled by avatars.cancel, and leaves no copy and no export line", async () => {
    const m = makeClipMock();
    const { jobId } = await running(m);
    expect(await unwrap(m.client.request("avatars.cancel", { jobId }))).toEqual({ jobId });
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)?.type).toBe("job.cancelled");
    expect((await onlyClip(m)).exports).toEqual([]);
    expect(m.engine.peekClips().exportedFiles).toEqual([]);
  });

  // engine/clips/export.ts: a cancel is honoured up to the claim of the name; from the claim on the export runs to its record («done wins», as a render's commit).
  test("a cancel after the name is claimed is answered, and changes nothing: the export ends done with its copy and its export line", async () => {
    const m = makeClipMock();
    const { jobId } = await running(m);
    for (let i = 0; i < 100 && m.engine.peekClips().exportedFiles.length === 0; i++) if (!m.scheduler.next()) break;
    expect(m.engine.peekClips().exportedFiles).toHaveLength(1);
    expect(endOf(m.events, jobId)).toBeUndefined();
    expect(await unwrap(m.client.request("avatars.cancel", { jobId }))).toEqual({ jobId });
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.done" });
    expect(m.events.some((e) => e.type === "job.cancelled" && e.payload.jobId === jobId)).toBe(false);
    const [relPath] = m.engine.peekClips().exportedFiles;
    expect((await onlyClip(m)).exports).toEqual([expect.objectContaining({ relPath })]);
  });

  test("refuses its avatar's delete and a library switch", async () => {
    const m = makeClipMock();
    await running(m);
    expect((await refusal(m.client.request("avatars.delete", { avatarId: AVATAR }))).code).toBe("IN_FLIGHT");
    expect((await refusal(m.client.request("settings.setLibraryPath", { path: "/Users/studio/Other" }))).code).toBe("IN_FLIGHT");
    m.scheduler.runAll();
  });

  test("refuses a pick of another export folder IN_FLIGHT, naming the clip", async () => {
    const m = makeClipMock();
    await running(m);
    m.engine.pickExportFolderNext({ path: "/Users/studio/Elsewhere" });
    const error = await refusal(m.client.request("settings.setExportPath", {}));
    expect(error).toMatchObject({ code: "IN_FLIGHT" });
    expect(error.detail).toContain("clip");
    m.scheduler.runAll();
  });

  test("a failed encode ends the job failed INTERNAL, free, and leaves the clip as it was", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const before = await onlyClip(m);
    m.engine.nextClipExport("fail");
    const { jobId } = await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.failed", payload: { kind: "clip", jobId, clipId, error: { code: "INTERNAL" } } });
    expect(await onlyClip(m)).toEqual(before);
    expect(m.engine.peekClips().exportedFiles).toEqual([]);
  });

  test("an export holds neither the paid slot nor the reconcile: a clip can be made meanwhile", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
    expect((await create(m)).ok).toBe(true);
    m.scheduler.runAll();
  });

  test("the clip's money is untouched by an export", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const figures = async () => {
      const { spentMicros, unsettledMicros, unsettledCount } = await money(m);
      return { spentMicros, unsettledMicros, unsettledCount };
    };
    const before = await figures();
    await exportClip(m, clipId);
    expect(await figures()).toEqual(before);
  });
});

describe("clips.reveal (main's, answered here the way main answers it)", () => {
  test("shows the newest copy that is present in the current folder", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const first = exportedPath(m, await exportClip(m, clipId));
    const second = exportedPath(m, await exportClip(m, clipId));
    expect(await unwrap(m.client.request("clips.reveal", { avatarId: AVATAR, clipId }))).toEqual({ clipId });
    expect(m.engine.revealedClips.at(-1)).toEqual({ avatarId: AVATAR, clipId, relPath: second });
    m.engine.tamperClipExport(clipId, 1, "missing");
    await unwrap(m.client.request("clips.reveal", { avatarId: AVATAR, clipId }));
    expect(m.engine.revealedClips.at(-1)?.relPath).toBe(first);
  });

  test("NOT_FOUND for an unknown clip; VALIDATION `not-exported` for a clip with no copy present", async () => {
    const m = makeClipMock();
    expect((await refusal(m.client.request("clips.reveal", { avatarId: AVATAR, clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
    const clipId = await readyClip(m);
    expect(await refusal(m.client.request("clips.reveal", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "VALIDATION", clipReason: "not-exported" });
    await exportClip(m, clipId);
    m.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    expect(await refusal(m.client.request("clips.reveal", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "VALIDATION", clipReason: "not-exported" });
  });

  test("a copy made in a folder the owner has since replaced reads `elsewhere`, and cannot be revealed", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    await exportClip(m, clipId);
    m.engine.pickExportFolderNext({ path: "/Users/studio/Elsewhere" });
    await unwrap(m.client.request("settings.setExportPath", {}));
    const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId }));
    expect(clip.exports.map((e) => e.fileState)).toEqual(["elsewhere"]);
    expect((await refusal(m.client.request("clips.reveal", { avatarId: AVATAR, clipId }))).code).toBe("VALIDATION");
    expect(await listClips(m)).toHaveLength(1);
  });
});
