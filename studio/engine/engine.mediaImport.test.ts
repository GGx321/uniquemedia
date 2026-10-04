import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MediaSummary, type PickedFileIdentity } from "../shared/engine";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { pickedIdentityOf } from "./media/identity";
import type { MediaImporter } from "./media/imports";
import type { OpenRegularOps } from "./library/openRegular";
import { command, engineSettings, failed, jobEnd, ok, startEngine, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Own media in the engine (3f.1, 3f.1b): main's dialog picked a path; `media.import` opens it once and starts a JOB that copies it into the
// engine's own area, hands the COPY to the kind's importer, and stores the file and its record. Nothing but main sends the call, and
// nothing in an answer, an event or a state carries a path.

const dir = useEngineDir("studio-media-import-");
const libraryDir = (): string => join(dir(), "library");
const mediaFolder = (): string => join(libraryDir(), "media");
const stagingDir = (): string => join(libraryDir(), "media", ".staging");
const pickedDir = (): string => join(dir(), "picked");

const jpeg = (size = 200): Buffer<ArrayBuffer> => {
  const buffer = Buffer.alloc(size, 9);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
};
const PHOTO_FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const asIs: MediaImporter = async () => ({ ok: true, facts: PHOTO_FACTS });

async function picked(name: string, bytes: Buffer): Promise<{ path: string; expected: PickedFileIdentity }> {
  await mkdir(pickedDir(), { recursive: true });
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  return { path, expected: pickedIdentityOf(await lstat(path, { bigint: true })) };
}

type Started = Awaited<ReturnType<typeof startEngine>>;
let calls = 0;

async function importCall(started: Started, file: { path: string; expected: PickedFileIdentity }, pick = "photo", name = "summer.jpg", id?: string): Promise<EngineReply> {
  const callId = id ?? `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick, path: file.path, name, expected: file.expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success) throw new Error("the engine did not answer media.import with a reply the contract takes");
  return reply.data;
}

async function start(deps: Parameters<typeof startEngine>[1] extends infer O ? (O extends { deps?: infer D } ? D : never) : never = {}): Promise<Started> {
  const started = await startEngine(dir(), { init: { settings: engineSettings(dir(), { renderConcurrency: 1 }) }, deps });
  await started.engine.settled();
  return started;
}

const staged = async (): Promise<string[]> => (await readdir(stagingDir()).catch(() => [])).sort();
const stored = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();

/** Imports one photo and waits for its job to end. */
async function imported(started: Started, name = "summer.jpg", bytes = jpeg()): Promise<{ reply: EngineReply; jobId: string }> {
  const reply = await importCall(started, await picked(name, bytes), "photo", name);
  const jobId = reply.mediaJobId;
  if (jobId === undefined) throw new Error(`the import was refused: ${reply.mediaReason ?? "no reason"}`);
  await started.engine.mediaSettled();
  return { reply, jobId };
}

describe("with no importer for the kind", () => {
  test("a good photo is refused as not-yet-supported, and nothing stays staged", async () => {
    const started = await start();
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    expect(reply.error?.code).toBe("VALIDATION");
    expect(reply.mediaReason).toBe("not-yet-supported");
    expect(reply.mediaJobId).toBeUndefined();
    expect(await staged()).toEqual([]);
  });
});

describe("with an importer", () => {
  test("the answer is a job id, and the job stores the file and its record: the picked bytes, a record the contract takes", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    const bytes = jpeg(300);
    const { reply, jobId } = await imported(started, "holiday.jpg", bytes);
    expect(reply.error).toBeUndefined();

    const end = await jobEnd(started.events, jobId);
    expect(end.type).toBe("job.done");
    const listed = ok(await started.engine.handle(command("media.list", {})));
    const list = listed.result as { media: unknown[]; total: number };
    expect(list.total).toBe(1);
    const media = MediaSummary.parse(list.media[0]);
    expect(media).toMatchObject({ kind: "photo", name: "holiday.jpg", bytes: 300, width: 100, height: 200 });
    expect(await readFile(join(mediaFolder(), `${media.mediaId}.jpg`))).toEqual(bytes);
    expect(await staged()).toEqual([]);
  });

  test("the importer is handed the STAGED copy inside the library's staging folder, never the picked path", async () => {
    const seen: { path: string; existed: boolean; content: Buffer; name: string }[] = [];
    const importer: MediaImporter = async ({ staged: handle, name }) => {
      seen.push({ path: handle.path, existed: await lstat(handle.path).then(() => true, () => false), content: await readFile(handle.path), name });
      return { ok: true, facts: PHOTO_FACTS };
    };
    const started = await start({ mediaImporters: { photo: importer } });
    const file = await picked("holiday.jpg", jpeg(300));
    const reply = await importCall(started, file, "any", "holiday.jpg");
    await started.engine.mediaSettled();
    expect(reply.mediaJobId).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path.startsWith(stagingDir())).toBe(true);
    expect(seen[0]?.path).not.toBe(file.path);
    expect(seen[0]).toMatchObject({ existed: true, name: "holiday.jpg" });
    expect(seen[0]?.content).toEqual(jpeg(300));
  });

  test("an importer that turns the file away fails the job with MEDIA_UNSUPPORTED and its reason; nothing is stored or staged", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: false, reason: "too-large" }) } });
    const { jobId } = await imported(started);
    const end = await jobEnd(started.events, jobId);
    expect(end.type === "job.failed" && end.payload.error).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "too-large" });
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  test("an importer that throws fails the job with the reason failed, and no event carries a path", async () => {
    const file = await picked("a.jpg", jpeg());
    const started = await start({
      mediaImporters: {
        photo: async ({ staged: handle }) => {
          throw new Error(`could not decode ${handle.path} (from ${file.path})`);
        },
      },
    });
    const reply = await importCall(started, file);
    await started.engine.mediaSettled();
    const jobId = reply.mediaJobId ?? "";
    const end = await jobEnd(started.events, jobId);
    expect(end.type === "job.failed" && end.payload.error.mediaReason).toBe("failed");
    expect(JSON.stringify(started.posted).includes(pickedDir())).toBe(false);
    expect(JSON.stringify(started.posted).includes(stagingDir())).toBe(false);
    expect(await staged()).toEqual([]);
  });

  test("an importer for another kind is not asked: a photo is refused when only video has one", async () => {
    const seen: string[] = [];
    const started = await start({
      mediaImporters: {
        video: async () => {
          seen.push("video");
          return { ok: false, reason: "failed" };
        },
      },
    });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    expect(reply.mediaReason).toBe("not-yet-supported");
    expect(seen).toEqual([]);
  });

  test("the import job is in the snapshot with its end, and the events came in order: progress, media.changed, done", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    const { jobId } = await imported(started);
    const types = started.events().map((e) => e.type);
    expect(types.indexOf("job.progress")).toBeLessThan(types.indexOf("media.changed"));
    expect(types.indexOf("media.changed")).toBeLessThan(types.indexOf("job.done"));
    const snapshot = ok(await started.engine.handle(command("engine.snapshot"))).result as { jobs: { jobId: string; kind: string; status: string; mediaId: string | null }[] };
    const job = snapshot.jobs.find((j) => j.jobId === jobId);
    expect(job).toMatchObject({ kind: "import", status: "done" });
    expect(job?.mediaId).not.toBeNull();
  });
});

describe("what the boundary refuses reaches the answer as a reason, never as a path", () => {
  async function refusedAs(started: Started, name: string, bytes: Buffer, pick = "photo"): Promise<EngineReply> {
    return importCall(started, await picked(name, bytes), pick, name);
  }

  test("a script named like a photo is a format refusal", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    const reply = await refusedAs(started, "photo.jpg", Buffer.from("#!/bin/sh\nrm -rf ~\n"));
    expect(reply.mediaReason).toBe("format");
    expect(await staged()).toEqual([]);
  });

  test("an empty file is refused as empty", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    expect((await refusedAs(started, "empty.jpg", Buffer.alloc(0))).mediaReason).toBe("empty");
  });

  test("a folder is refused as not-a-file", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    await mkdir(join(pickedDir(), "album.jpg"), { recursive: true });
    const info = await lstat(join(pickedDir(), "album.jpg"), { bigint: true });
    const reply = await importCall(started, { path: join(pickedDir(), "album.jpg"), expected: pickedIdentityOf(info) });
    expect(reply.mediaReason).toBe("not-a-file");
  });

  test("a file replaced after main looked at it is refused as changed", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    const file = await picked("a.jpg", jpeg());
    const other = await picked("b.jpg", jpeg());
    const reply = await importCall(started, { path: file.path, expected: other.expected });
    expect(reply.mediaReason).toBe("changed");
  });

  test("no refusal's text holds the picked path or its folder", async () => {
    const started = await start();
    const replies = [
      await refusedAs(started, "x.jpg", Buffer.from("not an image")),
      await refusedAs(started, "y.jpg", Buffer.alloc(0)),
      await refusedAs(started, "z.jpg", jpeg()),
      await importCall(started, { path: join(pickedDir(), "gone.jpg"), expected: { dev: "1", ino: "1", size: "1", mtimeNs: "1", birthtimeNs: "1" } }),
    ];
    for (const reply of replies) {
      expect(JSON.stringify(reply).includes(pickedDir())).toBe(false);
      expect(JSON.stringify(reply).includes(dir())).toBe(false);
    }
  });
});

/** An importer that waits for `release`, and says when it was entered. */
function heldImporter(): { importer: MediaImporter; entered: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    entered,
    release,
    importer: async ({ signal }) => {
      enter();
      await Promise.race([gate, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      return { ok: true, facts: PHOTO_FACTS };
    },
  };
}

describe("the live library is held for the whole job", () => {
  test("a library switch is refused as in flight while the import runs, and goes through after it ends", async () => {
    const held = heldImporter();
    const started = await start({ mediaImporters: { photo: held.importer } });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    await held.entered;
    const other = join(dir(), "other-library");
    await mkdir(other);
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-70000001", path: other });
    const during = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === "call-70000001");
    expect(during?.success && during.data.error?.code).toBe("IN_FLIGHT");
    held.release();
    await started.engine.mediaSettled();
    expect((await jobEnd(started.events, reply.mediaJobId ?? "")).type).toBe("job.done");
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-70000002", path: other });
    const after = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === "call-70000002");
    expect(after?.success && after.data.error).toBeUndefined();
  });

  test("a library switch is refused while the open file is being looked at too", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opening: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      opening = resolve;
    });
    const ops: OpenRegularOps = {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        opening();
        await gate;
        return open(p, flags);
      },
    };
    const started = await start({ mediaImporters: { photo: asIs }, mediaStaging: { ops } });
    const pending = importCall(started, await picked("a.jpg", jpeg()));
    await entered;
    const other = join(dir(), "other-library");
    await mkdir(other);
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-70000003", path: other });
    const during = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === "call-70000003");
    expect(during?.success && during.data.error?.code).toBe("IN_FLIGHT");
    release();
    await pending;
    await started.engine.mediaSettled();
  });

  test("staging happens under the live library, not under a library that was left", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    await imported(started);
    expect((await stored()).length).toBe(2);
  });
});

describe("media.cancelImport", () => {
  test("stops an import that is in its importer: the job is cancelled, nothing is stored or staged, the library is free", async () => {
    const held = heldImporter();
    const started = await start({ mediaImporters: { photo: held.importer } });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    const jobId = reply.mediaJobId ?? "";
    await held.entered;
    const answer = ok(await started.engine.handle(command("media.cancelImport", { jobId })));
    expect(answer.result).toEqual({ jobId });
    await started.engine.mediaSettled();
    expect((await jobEnd(started.events, jobId)).type).toBe("job.cancelled");
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
    const other = join(dir(), "other-library");
    await mkdir(other);
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-70000010", path: other });
    const after = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === "call-70000010");
    expect(after?.success && after.data.error).toBeUndefined();
  });

  test("a job that is not an import, or unknown, is NOT_FOUND", async () => {
    const started = await start();
    expect(failed(await started.engine.handle(command("media.cancelImport", { jobId: "job-00000404" }))).error.code).toBe("NOT_FOUND");
  });

  test("avatars.cancel does not stop an import: it is no avatar's job", async () => {
    const held = heldImporter();
    const started = await start({ mediaImporters: { photo: held.importer } });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    await held.entered;
    expect(failed(await started.engine.handle(command("avatars.cancel", { jobId: reply.mediaJobId }))).error.code).toBe("NOT_FOUND");
    held.release();
    await started.engine.mediaSettled();
  });
});

describe("media.list and media.delete", () => {
  test("list answers newest first with a kind filter, and delete removes the file and the record and tells the windows", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    await imported(started, "a.jpg", jpeg(300));
    await imported(started, "b.jpg", jpeg(310));
    const all = ok(await started.engine.handle(command("media.list", {}))).result as { media: { name: string; mediaId: string }[]; total: number };
    expect(all.media.map((m) => m.name)).toEqual(["b.jpg", "a.jpg"]);
    const none = ok(await started.engine.handle(command("media.list", { kind: "video" }))).result as { total: number };
    expect(none.total).toBe(0);

    const target = all.media[0];
    if (target === undefined) throw new Error("nothing listed");
    const answer = ok(await started.engine.handle(command("media.delete", { mediaId: target.mediaId })));
    expect(answer.result).toEqual({ mediaId: target.mediaId });
    const after = ok(await started.engine.handle(command("media.list", {}))).result as { media: { name: string }[] };
    expect(after.media.map((m) => m.name)).toEqual(["a.jpg"]);
    expect(await stored()).toHaveLength(2);
    const removed = started.events().filter((e) => e.type === "media.changed" && e.payload.change === "removed");
    expect(removed).toHaveLength(1);
  });

  test("deleting an unknown id is NOT_FOUND, and a known one is deleted", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    expect(failed(await started.engine.handle(command("media.delete", { mediaId: "media-00000404" }))).error.code).toBe("NOT_FOUND");
    await imported(started);
    const listed = ok(await started.engine.handle(command("media.list", {}))).result as { media: { mediaId: string }[] };
    const id = listed.media[0]?.mediaId ?? "";
    expect(ok(await started.engine.handle(command("media.delete", { mediaId: id }))).result).toEqual({ mediaId: id });
  });

  test("a media that a queued or running render uses is refused with IN_FLIGHT, and deleted once the render is over", async () => {
    const reserved = new Set<string>();
    const started = await start({ mediaImporters: { photo: asIs }, reservedMedia: (id) => reserved.has(id) });
    await imported(started);
    const listed = ok(await started.engine.handle(command("media.list", {}))).result as { media: { mediaId: string }[] };
    const id = listed.media[0]?.mediaId ?? "";
    reserved.add(id);
    expect(failed(await started.engine.handle(command("media.delete", { mediaId: id }))).error.code).toBe("IN_FLIGHT");
    expect(((ok(await started.engine.handle(command("media.list", {}))).result) as { total: number }).total).toBe(1);
    reserved.delete(id);
    expect(ok(await started.engine.handle(command("media.delete", { mediaId: id }))).result).toEqual({ mediaId: id });
  });

  test("the records of an earlier life are listed after a restart", async () => {
    const first = await start({ mediaImporters: { photo: asIs } });
    await imported(first, "kept.jpg", jpeg(300));
    const second = await start({ mediaImporters: { photo: asIs } });
    await second.engine.mediaSettled();
    const listed = ok(await second.engine.handle(command("media.list", {}))).result as { media: { name: string }[] };
    expect(listed.media.map((m) => m.name)).toEqual(["kept.jpg"]);
  });
});

// ---------- round 2: what the 3f.1 security review found ----------

const replyTo = (started: Started, callId: string): EngineReply | undefined => {
  const found = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  return found?.success === true ? found.data : undefined;
};

describe("a call that breaks the contract is answered, never ignored", () => {
  test("an identity with a negative inode, as Node's signed bigint stat can write it, gets a VALIDATION reply with its own callId", async () => {
    const started = await start();
    const file = await picked("a.jpg", jpeg());
    await started.engine.receive({ kind: "control", type: "media.import", callId: "call-60000001", pick: "photo", path: file.path, name: "a.jpg", expected: { ...file.expected, ino: "-5" } });
    expect(replyTo(started, "call-60000001")?.error?.code).toBe("VALIDATION");
  });

  test("a call with a relative path is answered the same way, and nothing is staged", async () => {
    const started = await start();
    const file = await picked("a.jpg", jpeg());
    await started.engine.receive({ kind: "control", type: "media.import", callId: "call-60000002", pick: "photo", path: "a.jpg", name: "a.jpg", expected: file.expected });
    expect(replyTo(started, "call-60000002")?.error?.code).toBe("VALIDATION");
    expect(await staged()).toEqual([]);
  });

  test("a control message with no readable callId is still only logged", async () => {
    const started = await start();
    const before = started.posted.length;
    await started.engine.receive({ kind: "control", type: "media.import", callId: 5 });
    expect(started.posted.length).toBe(before);
  });
});

/** A source whose open can be held, so a test can abort, time out or shut down while the file is being looked at. */
function heldOpen(): { ops: OpenRegularOps; release: () => void; reached: Promise<void> } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const ops: OpenRegularOps = {
    lstat: (p) => lstat(p, { bigint: true }),
    open: async (p, flags) => {
      reach();
      await gate;
      return open(p, flags);
    },
  };
  return { ops, release, reached };
}

/** A source whose copy can be held after its first read: the JOB's copy, so a test can cancel or shut down in it. */
function heldCopy(): { ops: OpenRegularOps; release: () => void; reached: Promise<void> } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const ops: OpenRegularOps = {
    lstat: (p) => lstat(p, { bigint: true }),
    open: async (p, flags) => {
      const handle = await open(p, flags);
      let reads = 0;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "read") {
            return async (buffer: Buffer, offset: number, length: number, position: number | null) => {
              // The first read is the look at the start; the copy's first read is let through; the second waits.
              if (++reads === 3) {
                reach();
                await gate;
              }
              return target.read(buffer, offset, length, position);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as FileHandle;
    },
  };
  return { ops, release, reached };
}

describe("the call that opens the file stops when main gives up on it", () => {
  test("media.abortImport ends the open as cancelled, starts no job and releases the library", async () => {
    const held = heldOpen();
    const started = await start({ mediaImporters: { photo: asIs }, mediaStaging: { ops: held.ops } });
    const file = await picked("a.jpg", jpeg(400));
    const pending = importCall(started, file, "photo", "a.jpg", "call-60000010");
    await held.reached;
    await started.engine.receive({ kind: "control", type: "media.abortImport", callId: "call-60000010" });
    held.release();
    const reply = await pending;
    expect(reply.mediaReason).toBe("cancelled");
    expect(reply.mediaJobId).toBeUndefined();
    expect(await staged()).toEqual([]);
    const other = join(dir(), "other-library");
    await mkdir(other);
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-60000011", path: other });
    expect(replyTo(started, "call-60000011")?.error).toBeUndefined();
  });

  test("an abort for a call that is not running is harmless", async () => {
    const started = await start();
    await started.engine.receive({ kind: "control", type: "media.abortImport", callId: "call-60000099" });
  });

  test("the engine gives up on its own a little before main does: the open ends as cancelled with a TIMEOUT", async () => {
    const held = heldOpen();
    const started = await start({ mediaImporters: { photo: asIs }, mediaImportDeadlineMs: 30, mediaStaging: { ops: held.ops } });
    const pending = importCall(started, await picked("a.jpg", jpeg(400)));
    await held.reached;
    await new Promise((resolve) => setTimeout(resolve, 80));
    held.release();
    const reply = await pending;
    expect(reply.mediaReason).toBe("cancelled");
    expect(reply.error?.code).toBe("TIMEOUT");
    expect(await staged()).toEqual([]);
  });

  test("a job that has started is not bound by the call's deadline: the copy runs on after it", async () => {
    const held = heldCopy();
    const started = await start({ mediaImporters: { photo: asIs }, mediaImportDeadlineMs: 30, mediaStaging: { ops: held.ops, chunkBytes: 16 } });
    const reply = await importCall(started, await picked("a.jpg", jpeg(400)));
    expect(reply.mediaJobId).toBeDefined();
    await held.reached;
    await new Promise((resolve) => setTimeout(resolve, 80));
    held.release();
    await started.engine.mediaSettled();
    expect((await jobEnd(started.events, reply.mediaJobId ?? "")).type).toBe("job.done");
  });

  test("a shutdown cancels a job in its copy: the engine says so, and nothing is left", async () => {
    const held = heldCopy();
    const started = await start({ mediaImporters: { photo: asIs }, mediaStaging: { ops: held.ops, chunkBytes: 16 } });
    const reply = await importCall(started, await picked("a.jpg", jpeg(400)));
    await held.reached;
    const stopping = started.engine.shutdown();
    held.release();
    await stopping;
    expect((await jobEnd(started.events, reply.mediaJobId ?? "")).type).toBe("job.cancelled");
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  test("after a shutdown no import is taken", async () => {
    const started = await start({ mediaImporters: { photo: asIs } });
    await started.engine.shutdown();
    expect((await importCall(started, await picked("a.jpg", jpeg()))).mediaReason).toBe("cancelled");
  });
});

describe("what a crash left in the staging folder", () => {
  const orphan = ".old-00000001.part";

  test("is removed when the library opens at the engine's start, with no import asked for", async () => {
    await openLibrary(libraryDir());
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), orphan), "an orphaned copy");
    await writeFile(join(stagingDir(), "notes.txt"), "the owner's");
    await start();
    await until(() => !existsSync(join(stagingDir(), orphan)), "the orphan to be swept");
    expect(await staged()).toEqual(["notes.txt"]);
  });

  test("is removed when another library becomes the live one", async () => {
    const started = await start();
    const other = join(dir(), "other-library");
    await mkdir(other);
    await openLibrary(other);
    await mkdir(join(other, "media", ".staging"), { recursive: true });
    await writeFile(join(other, "media", ".staging", orphan), "an orphaned copy");
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-60000020", path: other });
    await started.engine.receive({ kind: "control", type: "library.confirm", callId: "call-60000021", path: other });
    expect(replyTo(started, "call-60000021")?.error).toBeUndefined();
    await until(() => !existsSync(join(other, "media", ".staging", orphan)), "the orphan to be swept");
  });

  test("an import a crash interrupted is cleaned up, never resumed: an orphan stored file and its leftovers go, and the same ids are used again safely", async () => {
    await openLibrary(libraryDir());
    await mkdir(stagingDir(), { recursive: true });
    // What a life before this one left, under the very ids this engine will make (the test engine counts from the same start).
    for (let n = 1; n <= 20; n++) {
      const id = `id-${String(n).padStart(8, "0")}`;
      await writeFile(join(stagingDir(), `.${id}.part`), "half a copy of an earlier life");
      await writeFile(join(stagingDir(), `${id}.media`), "a whole copy of an earlier life");
      await writeFile(join(mediaFolder(), `${id}.jpg`), "an orphan stored file of an earlier life");
    }
    const started = await start({ mediaImporters: { photo: asIs } });
    const bytes = jpeg(333);
    await imported(started, "fresh.jpg", bytes);
    const listed = ok(await started.engine.handle(command("media.list", {}))).result as { media: { mediaId: string; bytes: number }[]; total: number };
    expect(listed.total).toBe(1);
    expect(listed.media[0]?.bytes).toBe(333);
    expect(await staged()).toEqual([]);
    expect((await stored()).filter((n) => n.endsWith(".jpg"))).toEqual([`${listed.media[0]?.mediaId}.jpg`]);
    expect(await readFile(join(mediaFolder(), `${listed.media[0]?.mediaId}.jpg`))).toEqual(bytes);
  });
});
