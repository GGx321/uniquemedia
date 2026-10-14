import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { JobRegistry } from "../jobs";
import type { MediaImporter } from "../media/imports";
import { MediaService } from "../media/service";
import { ClipImports } from "./importClip";
import { AVATAR, CLIP, clipFilePath, createRecordsRig, readyRecord, type RecordsRig } from "./testing/recordsRig";
useNativeGlobals();

// 5b.2, S5.WA2 (r2.1 N2): the import–delete race. An avatar delete cannot be PREPARED while a clip import runs (pinned in engine.clipCopies.test.ts), but a delete whose prepare began just before the
// import took its lock is pending while the import runs. The import looks again after its copy is made and before the record is written: a copy nobody wants is cancelled, its staged file is
// removed and no record is written, so nothing is left on Windows (an open file) or on macOS (an invisible copy). Here the real media service runs the job; only the importer is a fake that makes
// the delete pending at the worst moment, after the work and before the record.

const rigs: RecordsRig[] = [];
const services: MediaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(rigs.splice(0).map((rig) => rig.cleanup()));
});

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200)]);
const FACTS = { width: 720, height: 1280, durationMs: 5_000, sourceFps: 24, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

async function world(duringImport: (rig: RecordsRig) => Promise<void> | void) {
  const rig = await createRecordsRig();
  rigs.push(rig);
  await writeFile(clipFilePath(rig.clipsDir, CLIP), MP4);
  const base = readyRecord();
  if (base.outcome.status !== "ready") throw new Error("expected a ready record");
  await rig.put({ ...base, outcome: { ...base.outcome, bytes: MP4.length, sha256: createHash("sha256").update(MP4).digest("hex") } });

  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const importer: MediaImporter = async () => {
    await duringImport(rig);
    return { ok: true, facts: FACTS };
  };
  let n = 0;
  const media = new MediaService({
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: rig.dir }),
    newId: () => `id-${String(++n).padStart(8, "0")}`,
    now: () => new Date("2026-10-14T10:00:00.000Z"),
    importers: { video: importer },
    log: () => undefined,
  });
  services.push(media);
  const imports = new ClipImports({
    media,
    locate: (avatarId, clipId) => rig.records.locate(avatarId, clipId),
    withClipLock: (clipId, work) => rig.records.withClipLock(clipId, work),
    host: {
      busy: (clipId) => rig.state.busy.has(clipId),
      begin: (clipId) => {
        rig.state.busy.add(clipId);
        return () => void rig.state.busy.delete(clipId);
      },
      stop: new AbortController().signal,
    },
    log: () => undefined,
  });
  const run = async (): Promise<{ jobId: string; end: string | undefined }> => {
    const answer = await imports.start({ avatarId: AVATAR, clipId: CLIP });
    if (!("jobId" in answer)) throw new Error("expected an import job");
    await media.settled();
    return { jobId: answer.jobId, end: jobs.stateOf(answer.jobId)?.status };
  };
  const listing = async (folder: string): Promise<string[]> => (await readdir(join(rig.dir, "media", folder)).catch(() => [])).sort();
  const stored = async (): Promise<string[]> => (await readdir(join(rig.dir, "media")).catch(() => [])).filter((name) => name !== ".staging").sort();
  return { rig, media, events, run, stored, staged: () => listing(".staging") };
}

describe("an avatar delete that became pending while the copy was being made", () => {
  test("cancels the import, removes the staged file, writes no record and gives the clip back", async () => {
    const w = await world((rig) => void rig.state.pendingDelete.add(AVATAR));

    const { end } = await w.run();

    expect(end).toBe("cancelled");
    expect(await w.stored()).toEqual([]);
    expect(await w.staged()).toEqual([]);
    expect(w.events.some((e) => e.type === "media.changed")).toBe(false);
    expect(w.events.at(-1)?.type).toBe("job.cancelled");
    expect(w.rig.state.busy.size).toBe(0);
    expect(await w.media.copyOfClip(AVATAR, CLIP)).toBeUndefined();
  });

  test("an avatar that left the library meanwhile is the same", async () => {
    const w = await world((rig) => void rig.state.avatars.delete(AVATAR));
    expect((await w.run()).end).toBe("cancelled");
    expect(await w.stored()).toEqual([]);
    expect(await w.staged()).toEqual([]);
  });

  test("so is a clip whose record is gone", async () => {
    const w = await world((rig) => rm(join(rig.clipsDir, `${CLIP}.json`)));
    expect((await w.run()).end).toBe("cancelled");
    expect(await w.stored()).toEqual([]);
    expect(await w.staged()).toEqual([]);
  });

  test("with nothing changed the same import is done and the record is written", async () => {
    const w = await world(() => undefined);

    const { end } = await w.run();

    expect(end).toBe("done");
    expect((await w.stored()).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(await w.staged()).toEqual([]);
    expect((await w.media.copyOfClip(AVATAR, CLIP))?.origin).toMatchObject({ clipId: CLIP, avatarId: AVATAR });
  });
});
