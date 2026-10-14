import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, rm, symlink, writeFile } from "node:fs/promises";
import { EngineError, type MediaSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { pickedIdentityOf } from "../media/identity";
import type { MediaImportCall, MediaImportResult } from "../media/imports";
import { ClipImports, copyNameOf, type ClipImportsDeps, type ClipMediaPort } from "./importClip";
import type { ClipRecord } from "./schemas";
import { AVATAR, CLIP, clipFilePath, createRecordsRig, failedRecord, readyRecord, type RecordsRig } from "./testing/recordsRig";
useNativeGlobals();

// 5b.2, S5.WA2: the clip import's own rules with the media service faked: the order of its refusals, the clip lock it takes and gives back, the call it builds, how a refusal of the importer is told, and
// the last look before the record. The real encode, the real library and the engine's dispatch are pinned by engine.importClip.test.ts.

const rigs: RecordsRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.cleanup()));
});

const BYTES = Buffer.from("this stands for the provider's mp4");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/** Local time, so the expected name reads the same in every time zone. */
const CREATED = new Date(2026, 9, 14, 22, 17, 31);

function readyWith(bytes: Buffer, overrides: Partial<ClipRecord> = {}): ClipRecord {
  const base = readyRecord({ createdAt: CREATED.toISOString(), ...overrides });
  if (base.outcome.status !== "ready") throw new Error("expected a ready record");
  return { ...base, outcome: { ...base.outcome, bytes: bytes.length, sha256: sha(bytes) } };
}

interface World {
  rig: RecordsRig;
  imports: ClipImports;
  deps: ClipImportsDeps;
  calls: MediaImportCall[];
  state: { copy: MediaSummary | undefined; result: MediaImportResult; importThrows: Error | null };
  file: string;
}

async function world(record: ClipRecord | null = readyWith(BYTES), bytes: Buffer | null = BYTES): Promise<World> {
  const rig = await createRecordsRig();
  rigs.push(rig);
  const file = clipFilePath(rig.clipsDir, CLIP);
  if (bytes !== null) await writeFile(file, bytes);
  if (record !== null) await rig.put(record);
  const calls: MediaImportCall[] = [];
  const state: World["state"] = { copy: undefined, result: { ok: true, jobId: "job-import-0001" }, importThrows: null };
  const media: ClipMediaPort = {
    import: async (call) => {
      calls.push(call);
      if (state.importThrows !== null) throw state.importThrows;
      return state.result;
    },
    copyOfClip: async () => state.copy,
  };
  const deps: ClipImportsDeps = {
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
  };
  return { rig, imports: new ClipImports(deps), deps, calls, state, file };
}

const start = (w: World, clipId = CLIP, avatarId = AVATAR) => w.imports.start({ avatarId, clipId });

async function refusal(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected a refusal, but the call answered");
}

const COPY: MediaSummary = {
  mediaId: "media-00000001",
  kind: "video",
  name: "Клип 2026-10-14 22-17.mp4",
  bytes: 1_000,
  createdAt: "2026-10-14T20:30:00.000Z",
  width: 720,
  height: 1280,
  durationMs: 5_000,
  sourceFps: 24,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
  origin: { kind: "clip", avatarId: AVATAR, clipId: CLIP, photoId: "photo-0001" },
};

describe("the refusals, in the contract's order", () => {
  test("no library is open: LIBRARY_UNAVAILABLE", async () => {
    const w = await world();
    w.rig.state.open = false;
    expect((await refusal(start(w))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a clip the avatar does not have: NOT_FOUND", async () => {
    const w = await world();
    expect((await refusal(start(w, "clip-0000099"))).code).toBe("NOT_FOUND");
  });

  test("an avatar that is not in the library: NOT_FOUND", async () => {
    const w = await world();
    w.rig.state.avatars.delete(AVATAR);
    expect((await refusal(start(w))).code).toBe("NOT_FOUND");
  });

  test("an avatar whose delete is pending: NOT_FOUND", async () => {
    const w = await world();
    w.rig.state.pendingDelete.add(AVATAR);
    expect((await refusal(start(w))).code).toBe("NOT_FOUND");
  });

  test("a clip that is not ready: VALIDATION not-ready", async () => {
    const w = await world(failedRecord("refused-free", undefined));
    expect(await refusal(start(w))).toMatchObject({ code: "VALIDATION", clipReason: "not-ready" });
  });

  test("not-ready comes before job-running, and before the file is looked at", async () => {
    const w = await world(failedRecord("refused-free", undefined), Buffer.from("damaged"));
    w.rig.state.busy.add(CLIP);
    expect((await refusal(start(w))).clipReason).toBe("not-ready");
  });

  test("a clip another job works on (an export, a delete, another import): IN_FLIGHT job-running", async () => {
    const w = await world();
    w.rig.state.busy.add(CLIP);
    expect(await refusal(start(w))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    expect(w.calls).toEqual([]);
  });

  test("job-running comes before file-damaged: a busy clip's file is not even read", async () => {
    const w = await world(readyWith(BYTES), Buffer.from("damaged"));
    w.rig.state.busy.add(CLIP);
    expect((await refusal(start(w))).clipReason).toBe("job-running");
  });

  test("a file whose sha256 is not the record's: VALIDATION file-damaged, no job and the clip is free again", async () => {
    const w = await world(readyWith(BYTES), Buffer.from("this is another file"));
    expect(await refusal(start(w))).toMatchObject({ code: "VALIDATION", clipReason: "file-damaged" });
    expect(w.calls).toEqual([]);
    expect(w.rig.state.busy.size).toBe(0);
    expect(w.imports.importingFor(AVATAR)).toBe(false);
  });

  test("a file that is gone: VALIDATION file-damaged", async () => {
    const w = await world(readyWith(BYTES), null);
    expect((await refusal(start(w))).clipReason).toBe("file-damaged");
    expect(w.calls).toEqual([]);
  });

  test("a link where the file should be is not followed: VALIDATION file-damaged", async () => {
    const w = await world(readyWith(BYTES), null);
    const target = `${w.file}.target`;
    await writeFile(target, BYTES);
    await symlink(target, w.file);
    expect((await refusal(start(w))).clipReason).toBe("file-damaged");
    expect(w.calls).toEqual([]);
  });

  test("a file that cannot be read because the avatar's folder went to the Trash meanwhile is NOT_FOUND, not file-damaged", async () => {
    const w = await world(readyWith(BYTES), null);
    let looks = 0;
    const imports = new ClipImports({
      ...w.deps,
      locate: async (avatarId, clipId) => {
        if (++looks > 1) throw new EngineFailure({ code: "NOT_FOUND", detail: "no avatar in the open library" });
        return w.rig.records.locate(avatarId, clipId);
      },
    });
    expect((await refusal(imports.start({ avatarId: AVATAR, clipId: CLIP }))).code).toBe("NOT_FOUND");
    expect(looks).toBe(2);
    expect(w.rig.state.busy.size).toBe(0);
  });

  test("the same for a file that is a link (the hash fails) while the avatar is gone", async () => {
    const w = await world(readyWith(BYTES), null);
    await writeFile(`${w.file}.target`, BYTES);
    await symlink(`${w.file}.target`, w.file);
    let looks = 0;
    const imports = new ClipImports({
      ...w.deps,
      locate: async (avatarId, clipId) => {
        if (++looks > 1) throw new EngineFailure({ code: "NOT_FOUND", detail: "no avatar in the open library" });
        return w.rig.records.locate(avatarId, clipId);
      },
    });
    expect((await refusal(imports.start({ avatarId: AVATAR, clipId: CLIP }))).code).toBe("NOT_FOUND");
  });

  test("an unreadable file with the avatar still there stays file-damaged", async () => {
    const w = await world(readyWith(BYTES), null);
    expect((await refusal(start(w))).clipReason).toBe("file-damaged");
  });

  test("a live copy answers its media id at once, even while another job holds the clip", async () => {
    const w = await world();
    w.state.copy = COPY;
    w.rig.state.busy.add(CLIP);
    expect(await start(w)).toEqual({ mediaId: COPY.mediaId });
    expect(w.calls).toEqual([]);
  });

  test("asks the media service for the copy of THIS avatar's clip", async () => {
    const w = await world();
    const asked: string[] = [];
    w.imports = new ClipImports({ ...w.deps, media: { ...w.deps.media, copyOfClip: async (avatarId, clipId) => (asked.push(`${avatarId} ${clipId}`), undefined) } });
    await start(w);
    expect(asked).toEqual([`${AVATAR} ${CLIP}`]);
  });
});

describe("the import call", () => {
  test("hands the clip's file, an lstat identity, the display name and the origin to the media service", async () => {
    const w = await world();
    expect(await start(w)).toEqual({ jobId: "job-import-0001" });

    expect(w.calls).toHaveLength(1);
    const [call] = w.calls;
    expect(call).toMatchObject({
      pick: "video",
      path: w.file,
      name: "Клип 2026-10-14 22-17.mp4",
      origin: { kind: "clip", avatarId: AVATAR, clipId: CLIP, photoId: "photo-0001" },
    });
    expect(call?.expected).toEqual(pickedIdentityOf(await lstat(w.file, { bigint: true })));
  });

  test("does not touch the library's file", async () => {
    const w = await world();
    await start(w);
    expect(await Bun.file(w.file).bytes()).toEqual(new Uint8Array(BYTES));
  });
});

describe("the clip lock", () => {
  test("is held from the start to the end of the import job, so a delete or an export of the clip is job-running", async () => {
    const w = await world();
    await start(w);
    expect(w.rig.state.busy.has(CLIP)).toBe(true);
    expect(w.imports.importingFor(AVATAR)).toBe(true);
    expect(await refusal(w.rig.records.delete({ avatarId: AVATAR, clipId: CLIP }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });

    w.calls[0]?.onEnd?.();
    expect(w.rig.state.busy.has(CLIP)).toBe(false);
    expect(w.imports.importingFor(AVATAR)).toBe(false);
  });

  test("a second import of the clip while the first runs is job-running, and one after it ended starts a new job", async () => {
    const w = await world();
    await start(w);
    expect((await refusal(start(w))).clipReason).toBe("job-running");
    w.calls[0]?.onEnd?.();
    w.state.result = { ok: true, jobId: "job-import-0002" };
    expect(await start(w)).toEqual({ jobId: "job-import-0002" });
  });

  test("two imports asked together make one job", async () => {
    const w = await world();
    const settled = await Promise.allSettled([start(w), start(w)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason instanceof EngineFailure && rejected[0].reason.error.clipReason).toBe("job-running");
    expect(w.calls).toHaveLength(1);
  });

  test("is given back once even if the end hook runs twice", async () => {
    const w = await world();
    await start(w);
    const onEnd = w.calls[0]?.onEnd;
    onEnd?.();
    w.rig.state.busy.add(CLIP); // another job took the clip meanwhile
    onEnd?.();
    expect(w.rig.state.busy.has(CLIP)).toBe(true);
  });

  test("is given back when the media service throws", async () => {
    const w = await world();
    w.state.importThrows = new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library" });
    expect((await refusal(start(w))).code).toBe("LIBRARY_UNAVAILABLE");
    expect(w.rig.state.busy.size).toBe(0);
    expect(w.imports.importingFor(AVATAR)).toBe(false);
  });
});

describe("a refusal of the importer (the contract left the pin to this task)", () => {
  test("a full disk is MEDIA_UNSUPPORTED with mediaReason no-space, and the clip is free again", async () => {
    const w = await world();
    w.state.result = { ok: false, reason: "no-space", detail: "the disk is full" };
    expect(await refusal(start(w))).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
    expect(w.rig.state.busy.size).toBe(0);
    expect(w.imports.importingFor(AVATAR)).toBe(false);
  });

  for (const reason of ["failed", "structure", "codec", "too-short", "changed", "unreadable", "cancelled", "too-many", "not-a-file", "empty", "too-large", "format", "not-yet-supported"] as const) {
    test(`${reason} is INTERNAL and names no media reason`, async () => {
      const w = await world();
      w.state.result = { ok: false, reason, detail: "refused" };
      const error = await refusal(start(w));
      expect(w.calls).toHaveLength(1);
      expect(error.code).toBe("INTERNAL");
      expect(error.detail).toBe("refused");
      expect(error.mediaReason).toBeUndefined();
      expect(w.rig.state.busy.size).toBe(0);
    });
  }
});

describe("the last look before the record", () => {
  async function look(w: World): Promise<boolean> {
    await start(w);
    const wanted = w.calls[0]?.stillWanted;
    if (wanted === undefined) throw new Error("the call carries no last look");
    return wanted();
  }

  test("a clip and an avatar that are still there are wanted", async () => {
    expect(await look(await world())).toBe(true);
  });

  test("an avatar whose delete became pending meanwhile is not", async () => {
    const w = await world();
    await start(w);
    w.rig.state.pendingDelete.add(AVATAR);
    expect(await w.calls[0]?.stillWanted?.()).toBe(false);
  });

  test("an avatar that left the library is not", async () => {
    const w = await world();
    await start(w);
    w.rig.state.avatars.delete(AVATAR);
    expect(await w.calls[0]?.stillWanted?.()).toBe(false);
  });

  test("a clip whose record is gone is not", async () => {
    const w = await world();
    await start(w);
    await rm(w.rig.file(`${CLIP}.json`));
    expect(await w.calls[0]?.stillWanted?.()).toBe(false);
  });

  test("no library open is not (and does not throw)", async () => {
    const w = await world();
    await start(w);
    w.rig.state.open = false;
    expect(await w.calls[0]?.stillWanted?.()).toBe(false);
  });
});

describe("the display name", () => {
  test("is «Клип <YYYY-MM-DD> <HH-MM>.mp4» in the owner's local time", () => {
    expect(copyNameOf(new Date(2026, 9, 14, 22, 17, 31).toISOString())).toBe("Клип 2026-10-14 22-17.mp4");
  });

  test("pads month, day, hour and minute to two digits", () => {
    expect(copyNameOf(new Date(2026, 0, 5, 3, 4).toISOString())).toBe("Клип 2026-01-05 03-04.mp4");
  });

  test("is a name the contract takes", () => {
    expect(copyNameOf(CREATED.toISOString()).length).toBeLessThanOrEqual(120);
  });
});
