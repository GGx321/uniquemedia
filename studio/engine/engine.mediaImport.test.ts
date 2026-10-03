import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { PickedFileIdentity } from "../shared/engine";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { pickedIdentityOf } from "./media/identity";
import type { MediaImporter } from "./media/imports";
import type { OpenRegularOps } from "./library/openRegular";
import { engineSettings, startEngine, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3f.1 in the engine: main's dialog picked a path; the engine opens it once, stages a copy in its own area and hands the COPY to the
// kind's importer. Nothing but main sends the call, and nothing in an answer carries a path.

const dir = useEngineDir("studio-media-import-");
const libraryDir = (): string => join(dir(), "library");
const stagingDir = (): string => join(libraryDir(), "media", ".staging");
const pickedDir = (): string => join(dir(), "picked");

const jpeg = (size = 200): Buffer<ArrayBuffer> => {
  const buffer = Buffer.alloc(size, 9);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
};

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
  function recording(): { importer: MediaImporter; seen: { path: string; bytes: number; sha256: string; kind: string; name: string; existedAtCall: boolean; content: Buffer }[] } {
    const seen: { path: string; bytes: number; sha256: string; kind: string; name: string; existedAtCall: boolean; content: Buffer }[] = [];
    const importer: MediaImporter = async ({ staged: handle, name }) => {
      seen.push({
        path: handle.path,
        bytes: handle.bytes,
        sha256: handle.sha256,
        kind: handle.kind,
        name,
        existedAtCall: (await lstat(handle.path).then(() => true, () => false)),
        content: await readFile(handle.path),
      });
      return { ok: true, jobId: "job-00000042" };
    };
    return { importer, seen };
  }

  test("it is handed the STAGED copy inside the library's staging folder, with the kind the bytes are and the display name", async () => {
    const { importer, seen } = recording();
    const started = await start({ mediaImporters: { photo: importer } });
    const bytes = jpeg(300);
    const file = await picked("holiday.jpg", bytes);
    const reply = await importCall(started, file, "any", "holiday.jpg");
    expect(reply.error).toBeUndefined();
    expect(reply.mediaJobId).toBe("job-00000042");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path.startsWith(stagingDir())).toBe(true);
    expect(seen[0]?.path).not.toBe(file.path);
    expect(seen[0]?.kind).toBe("photo");
    expect(seen[0]?.name).toBe("holiday.jpg");
    expect(seen[0]?.bytes).toBe(300);
    expect(seen[0]?.content).toEqual(bytes);
    expect(seen[0]?.existedAtCall).toBe(true);
  });

  test("an importer that takes the file owns the staged copy: the engine does not remove it", async () => {
    const { importer } = recording();
    const started = await start({ mediaImporters: { photo: importer } });
    await importCall(started, await picked("a.jpg", jpeg()));
    expect(await staged()).toHaveLength(1);
  });

  test("an importer that turns the file away has its reason told, and the staged copy is removed", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: false, reason: "too-large" }) } });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    expect(reply.error?.code).toBe("VALIDATION");
    expect(reply.mediaReason).toBe("too-large");
    expect(await staged()).toEqual([]);
  });

  test("an importer that throws is a failed refusal, the staged copy is removed, and the message carries no path", async () => {
    const file = await picked("a.jpg", jpeg());
    const started = await start({
      mediaImporters: {
        photo: async ({ staged: handle }) => {
          throw new Error(`could not decode ${handle.path} (from ${file.path})`);
        },
      },
    });
    const reply = await importCall(started, file);
    expect(reply.error?.code).toBe("INTERNAL");
    expect(reply.mediaReason).toBe("failed");
    expect(JSON.stringify(reply).includes(pickedDir())).toBe(false);
    expect(JSON.stringify(reply).includes(stagingDir())).toBe(false);
    expect(await staged()).toEqual([]);
  });

  test("an importer for another kind is not asked: a photo is refused when only video has one", async () => {
    const { importer, seen } = recording();
    const started = await start({ mediaImporters: { video: importer } });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    expect(reply.mediaReason).toBe("not-yet-supported");
    expect(seen).toEqual([]);
  });
});

describe("what the boundary refuses reaches the answer as a reason, never as a path", () => {
  async function refusedAs(started: Started, name: string, bytes: Buffer, pick = "photo"): Promise<EngineReply> {
    return importCall(started, await picked(name, bytes), pick, name);
  }

  test("a script named like a photo is a format refusal", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: true, jobId: "job-00000042" }) } });
    const reply = await refusedAs(started, "photo.jpg", Buffer.from("#!/bin/sh\nrm -rf ~\n"));
    expect(reply.mediaReason).toBe("format");
    expect(await staged()).toEqual([]);
  });

  test("an empty file is refused as empty", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: true, jobId: "job-00000042" }) } });
    expect((await refusedAs(started, "empty.jpg", Buffer.alloc(0))).mediaReason).toBe("empty");
  });

  test("a folder is refused as not-a-file", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: true, jobId: "job-00000042" }) } });
    await mkdir(join(pickedDir(), "album.jpg"), { recursive: true });
    const info = await lstat(join(pickedDir(), "album.jpg"), { bigint: true });
    const reply = await importCall(started, { path: join(pickedDir(), "album.jpg"), expected: pickedIdentityOf(info) });
    expect(reply.mediaReason).toBe("not-a-file");
  });

  test("a file replaced after main looked at it is refused as changed", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: true, jobId: "job-00000042" }) } });
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

describe("the live library", () => {
  test("a library switch is refused as in flight while a file is being staged, and goes through after", async () => {
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
    const started = await start({ mediaImporters: { photo: async () => ({ ok: true, jobId: "job-00000042" }) }, mediaStaging: { ops } });
    const file = await picked("a.jpg", jpeg());
    const pending = importCall(started, file);
    await entered;
    const other = join(dir(), "other-library");
    await mkdir(other);
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-70000001", path: other });
    const during = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === "call-70000001");
    expect(during?.success && during.data.error?.code).toBe("IN_FLIGHT");
    release();
    expect((await pending).mediaJobId).toBe("job-00000042");
    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-70000002", path: other });
    const after = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === "call-70000002");
    expect(after?.success && after.data.error).toBeUndefined();
  });

  test("staging happens under the live library, not under a library that was left", async () => {
    const started = await start({ mediaImporters: { photo: async () => ({ ok: true, jobId: "job-00000042" }) } });
    await importCall(started, await picked("a.jpg", jpeg()));
    expect(await staged()).toHaveLength(1);
  });
});

// ---------- round 2: what the 3f.1 security review found ----------

/** A source whose copy can be held after its first read, so a test can abort, time out or shut down while it is in flight. */
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

describe("an importer that fails is a refusal of that file", () => {
  test("a throw is answered with the reason failed, so the rest of a pick goes on", async () => {
    const started = await start({
      mediaImporters: {
        photo: async () => {
          throw new Error("boom");
        },
      },
    });
    const reply = await importCall(started, await picked("a.jpg", jpeg()));
    expect(reply.mediaReason).toBe("failed");
    expect(reply.error?.code).toBe("INTERNAL");
    expect(await staged()).toEqual([]);
  });
});

describe("a copy that main gives up on stops", () => {
  const importer: MediaImporter = async () => ({ ok: true, jobId: "job-00000042" });

  test("media.abortImport ends the copy as cancelled, removes what was copied and releases the library", async () => {
    const held = heldCopy();
    const started = await start({ mediaImporters: { photo: importer }, mediaStaging: { ops: held.ops, chunkBytes: 16 } });
    const file = await picked("a.jpg", jpeg(400));
    const pending = importCall(started, file, "photo", "a.jpg", "call-60000010");
    await held.reached;
    await started.engine.receive({ kind: "control", type: "media.abortImport", callId: "call-60000010" });
    held.release();
    const reply = await pending;
    expect(reply.mediaReason).toBe("cancelled");
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

  test("the engine gives up on its own a little before main does: the copy ends as cancelled with a TIMEOUT", async () => {
    const held = heldCopy();
    const started = await start({ mediaImporters: { photo: importer }, mediaImportDeadlineMs: 30, mediaStaging: { ops: held.ops, chunkBytes: 16 } });
    const pending = importCall(started, await picked("a.jpg", jpeg(400)));
    await held.reached;
    await new Promise((resolve) => setTimeout(resolve, 80));
    held.release();
    const reply = await pending;
    expect(reply.mediaReason).toBe("cancelled");
    expect(reply.error?.code).toBe("TIMEOUT");
    expect(await staged()).toEqual([]);
  });

  test("a shutdown aborts a copy in flight", async () => {
    const held = heldCopy();
    const started = await start({ mediaImporters: { photo: importer }, mediaStaging: { ops: held.ops, chunkBytes: 16 } });
    const pending = importCall(started, await picked("a.jpg", jpeg(400)));
    await held.reached;
    const stopping = started.engine.shutdown();
    held.release();
    expect((await pending).mediaReason).toBe("cancelled");
    await stopping;
    expect(await staged()).toEqual([]);
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
});
