import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolutePath, join, relative as relativePath } from "node:path";
import {
  CommandMessage,
  MAX_PICKED_FILES,
  MEDIA_BYTE_CAPS,
  MediaFileName,
  MediaPickResult,
  PROTOCOL_VERSION,
  ResponseMessage,
  type MediaPickKind,
  type PickedFileIdentity,
} from "../shared/engine";
import type { OpenRegularOps } from "../engine/library/openRegular";
import { pickedIdentityOf } from "../engine/media/identity";
import { displayNameOf, handleMediaPickCommand, isMediaPickCommand, preflightPickedFile, type MediaImportFlowDeps, type MediaImportReply } from "./mediaImportFlow";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3f.1 in main (invariant 34): the window sends a kind. Main opens its own dialog, looks at each picked file (a plain file, not a link, within
// the kind's cap, judged from the OPEN handle) and only then hands the engine its path and the identity it saw.

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-media-flow-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
async function put(name: string, bytes: Buffer = JPEG): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}
async function identityOf(path: string): Promise<PickedFileIdentity> {
  return pickedIdentityOf(await lstat(path, { bigint: true }));
}
async function tryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error && Reflect.get(error, "code") === "EPERM") return false;
    throw error;
  }
}

interface Harness {
  deps: MediaImportFlowDeps;
  asked: MediaPickKind[];
  imported: { pick: MediaPickKind; path: string; name: string; expected: PickedFileIdentity }[];
}

function harness(options: { picks?: readonly string[] | null; reply?: (path: string) => MediaImportReply; deps?: Partial<MediaImportFlowDeps> } = {}): Harness {
  const asked: MediaPickKind[] = [];
  const imported: Harness["imported"] = [];
  let n = 0;
  const deps: MediaImportFlowDeps = {
    pickFiles: async (kind) => {
      asked.push(kind);
      return options.picks === undefined ? [] : options.picks;
    },
    engine: {
      importMedia: async (call) => {
        imported.push(call);
        return options.reply?.(call.path) ?? { error: null, mediaJobId: `job-${String(++n).padStart(8, "0")}` };
      },
    },
    platform: process.platform,
    ...options.deps,
  };
  return { deps, asked, imported };
}

function pickCommand(kind: MediaPickKind = "photo"): Extract<CommandMessage, { type: "media.pickImport" }> {
  const parsed = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "media.pickImport", payload: { kind } });
  if (!isMediaPickCommand(parsed)) throw new Error("not a media.pickImport");
  return parsed;
}

async function run(h: Harness, kind: MediaPickKind = "photo"): Promise<MediaPickResult> {
  const response = ResponseMessage.parse(await handleMediaPickCommand(pickCommand(kind), h.deps));
  if (!response.ok || response.type !== "media.pickImport") throw new Error(`expected an ok answer, got ${JSON.stringify(response)}`);
  return MediaPickResult.parse(response.result);
}

describe("the dialog", () => {
  test("a cancelled dialog answers picked: false and the engine is never asked", async () => {
    const h = harness({ picks: null });
    expect(await run(h)).toEqual({ picked: false });
    expect(h.imported).toEqual([]);
  });

  test("a dialog that returns no file is a cancel too", async () => {
    const h = harness({ picks: [] });
    expect(await run(h)).toEqual({ picked: false });
    expect(h.imported).toEqual([]);
  });

  test("main's dialog is asked once, for the kind the window named", async () => {
    const h = harness({ picks: [] });
    await run(h, "audio");
    expect(h.asked).toEqual(["audio"]);
  });
});

describe("a good file", () => {
  test("goes to the engine with the kind, its absolute path, its base name and the identity main saw, and the answer names the job", async () => {
    const path = await put("summer.jpg");
    const h = harness({ picks: [path] });
    const result = await run(h);
    expect(h.imported).toEqual([{ pick: "photo", path, name: "summer.jpg", expected: await identityOf(path) }]);
    expect(result).toEqual({ picked: true, jobIds: ["job-00000001"], refused: [], skipped: 0 });
  });

  test("the answer carries no path, whatever the dialog returned", async () => {
    const path = await put("summer.jpg");
    const text = JSON.stringify(await run(harness({ picks: [path] })));
    expect(text.includes(dir)).toBe(false);
  });

  test("several files are imported one after another, each with its own job", async () => {
    const paths = [await put("a.jpg"), await put("b.jpg"), await put("c.jpg")];
    const h = harness({ picks: paths });
    const result = await run(h);
    expect(h.imported.map((c) => c.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(result.picked && result.jobIds).toEqual(["job-00000001", "job-00000002", "job-00000003"]);
  });

  test("a file the engine turns away is listed by name and reason, and the others still go through", async () => {
    const paths = [await put("a.jpg"), await put("notes.jpg"), await put("c.jpg")];
    const h = harness({
      picks: paths,
      reply: (path) => (path.endsWith("notes.jpg") ? { error: { code: "VALIDATION", detail: "not a photo" }, mediaReason: "format" } : { error: null, mediaJobId: `job-${path.endsWith("a.jpg") ? "00000001" : "00000002"}` }),
    });
    const result = await run(h);
    expect(result).toEqual({ picked: true, jobIds: ["job-00000001", "job-00000002"], refused: [{ name: "notes.jpg", reason: "format" }], skipped: 0 });
  });

  test("at most MAX_PICKED_FILES files are imported; the rest are refused as too-many and never reach the engine", async () => {
    const paths: string[] = [];
    for (let i = 0; i < MAX_PICKED_FILES + 2; i++) paths.push(await put(`p${String(i).padStart(2, "0")}.jpg`));
    const h = harness({ picks: paths });
    const result = await run(h);
    expect(h.imported).toHaveLength(MAX_PICKED_FILES);
    expect(result.picked && result.refused).toEqual([
      { name: "p20.jpg", reason: "too-many" },
      { name: "p21.jpg", reason: "too-many" },
    ]);
  });
});

describe("what main refuses before the engine hears of it", () => {
  async function refusedOnly(path: string, kind: MediaPickKind = "photo", extra: Partial<MediaImportFlowDeps> = {}): Promise<{ result: MediaPickResult; h: Harness }> {
    const h = harness({ picks: [path], deps: extra });
    return { result: await run(h, kind), h };
  }

  test("a symlink to a real photo is not-a-file", async () => {
    const real = await put("real.jpg");
    const link = join(dir, "link.jpg");
    if (!(await tryLink(real, link))) return;
    const { result, h } = await refusedOnly(link);
    expect(result).toEqual({ picked: true, jobIds: [], refused: [{ name: "link.jpg", reason: "not-a-file" }], skipped: 0 });
    expect(h.imported).toEqual([]);
  });

  test("a symlink is refused on a platform with no O_NOFOLLOW too (the Windows case)", async () => {
    const real = await put("real.jpg");
    const link = join(dir, "link.jpg");
    if (!(await tryLink(real, link))) return;
    const { result, h } = await refusedOnly(link, "photo", { noFollow: 0 });
    expect(result.picked && result.refused[0]?.reason).toBe("not-a-file");
    expect(h.imported).toEqual([]);
  });

  test("a folder is not-a-file", async () => {
    await mkdir(join(dir, "album.jpg"));
    const { result, h } = await refusedOnly(join(dir, "album.jpg"));
    expect(result.picked && result.refused).toEqual([{ name: "album.jpg", reason: "not-a-file" }]);
    expect(h.imported).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a FIFO is not-a-file, and main does not hang on it", async () => {
    const path = join(dir, "pipe.jpg");
    execFileSync("mkfifo", [path]);
    const { result, h } = await refusedOnly(path);
    expect(result.picked && result.refused).toEqual([{ name: "pipe.jpg", reason: "not-a-file" }]);
    expect(h.imported).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a FIFO that takes the path's place after the lstat is refused by the stat of the open handle", async () => {
    const path = await put("photo.jpg");
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const { open } = await import("node:fs/promises");
    const ops: OpenRegularOps = { lstat: (p) => lstat(p, { bigint: true }), open: (_p, flags) => open(fifo, flags) };
    const { result, h } = await refusedOnly(path, "photo", { ops });
    expect(result.picked && result.refused[0]?.reason).toBe("not-a-file");
    expect(h.imported).toEqual([]);
  });

  test("a path that is not there is not-a-file", async () => {
    const { result } = await refusedOnly(join(dir, "gone.jpg"));
    expect(result.picked && result.refused).toEqual([{ name: "gone.jpg", reason: "not-a-file" }]);
  });

  test("a relative path is not-a-file: the dialog only ever returns absolute ones", async () => {
    const { result, h } = await refusedOnly("photos/summer.jpg");
    expect(result.picked && result.refused).toEqual([{ name: "summer.jpg", reason: "not-a-file" }]);
    expect(h.imported).toEqual([]);
  });

  test("a relative path to a file that exists is still not-a-file: only an absolute path is taken from the dialog", async () => {
    const path = await put("summer.jpg");
    const relative = relativePath(process.cwd(), path);
    // On Windows a file on another drive has no relative spelling.
    if (isAbsolutePath(relative)) return;
    const { result, h } = await refusedOnly(relative);
    expect(result.picked && result.refused).toEqual([{ name: "summer.jpg", reason: "not-a-file" }]);
    expect(h.imported).toEqual([]);
  });

  test("a zero-byte file is empty", async () => {
    const path = await put("empty.jpg", Buffer.alloc(0));
    const { result, h } = await refusedOnly(path);
    expect(result.picked && result.refused).toEqual([{ name: "empty.jpg", reason: "empty" }]);
    expect(h.imported).toEqual([]);
  });

  test("a file one byte over the kind's cap is too-large, and one of exactly the cap goes on", async () => {
    const over = join(dir, "over.gif");
    await writeFile(over, JPEG);
    await truncate(over, MEDIA_BYTE_CAPS.sticker + 1);
    const edge = join(dir, "edge.gif");
    await writeFile(edge, JPEG);
    await truncate(edge, MEDIA_BYTE_CAPS.sticker);
    const h = harness({ picks: [over, edge] });
    const result = await run(h, "sticker");
    expect(result.picked && result.refused).toEqual([{ name: "over.gif", reason: "too-large" }]);
    expect(h.imported.map((c) => c.name)).toEqual(["edge.gif"]);
  });

  test("the cap is the kind's own: a file over the sticker cap is fine as a photo", async () => {
    const path = join(dir, "big.png");
    await writeFile(path, JPEG);
    await truncate(path, MEDIA_BYTE_CAPS.sticker + 1);
    const h = harness({ picks: [path] });
    await run(h, "photo");
    expect(h.imported).toHaveLength(1);
  });

  test("the identity main saw is that of the OPEN file, not of what the name points at a moment after the open", async () => {
    const path = await put("a.jpg");
    const before = await identityOf(path);
    const other = join(dir, "other.jpg");
    await writeFile(other, Buffer.concat([JPEG, JPEG, JPEG]));
    const { open, rename } = await import("node:fs/promises");
    // The name is re-pointed at another file right after the open: a stat of the PATH would now describe that file, the handle still the first.
    const ops: OpenRegularOps = {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        const handle = await open(p, flags);
        await rename(other, path).catch(() => undefined);
        return handle;
      },
    };
    const h = harness({ picks: [path], deps: { ops } });
    await run(h);
    if (process.platform !== "win32") expect(h.imported[0]?.expected).toEqual(before);
    else expect(h.imported[0]?.expected.size === before.size || h.imported[0] === undefined).toBe(true);
  });

  test("the identity carries the size and the times as well as the inode", async () => {
    const path = await put("a.jpg");
    const h = harness({ picks: [path] });
    await run(h);
    expect(Object.keys(h.imported[0]?.expected ?? {}).sort()).toEqual(["birthtimeNs", "dev", "ino", "mtimeNs", "size"]);
    expect(h.imported[0]?.expected.size).toBe(String(JPEG.length));
  });
});

describe("one failing file does not lose the others", () => {
  async function many(n: number, prefix = "p"): Promise<string[]> {
    const paths: string[] = [];
    for (let i = 0; i < n; i++) paths.push(await put(`${prefix}${String(i).padStart(3, "0")}.jpg`));
    return paths;
  }

  test("an engine error in the middle of a pick keeps the jobs already started and lists the failing file and the rest as failed", async () => {
    const paths = await many(4);
    let n = 0;
    const h = harness({ picks: paths, reply: () => (++n === 3 ? { error: { code: "INTERNAL", detail: "x" } } : { error: null, mediaJobId: `job-${String(n).padStart(8, "0")}` }) });
    const result = await run(h);
    expect(result).toEqual({
      picked: true,
      jobIds: ["job-00000001", "job-00000002"],
      refused: [
        { name: "p002.jpg", reason: "failed" },
        { name: "p003.jpg", reason: "failed" },
      ],
      skipped: 0,
    });
    expect(h.imported).toHaveLength(3);
  });

  test("an importer that failed, or a copy that was cancelled, is a refusal of that file and the pick goes on", async () => {
    const paths = await many(3);
    const reasons = ["failed", "cancelled"] as const;
    let n = 0;
    const h = harness({
      picks: paths,
      reply: () => {
        const reason = reasons[n++];
        return reason === undefined ? { error: null, mediaJobId: "job-00000009" } : { error: { code: "INTERNAL", detail: "x" }, mediaReason: reason };
      },
    });
    expect(await run(h)).toEqual({
      picked: true,
      jobIds: ["job-00000009"],
      refused: [
        { name: "p000.jpg", reason: "failed" },
        { name: "p001.jpg", reason: "cancelled" },
      ],
      skipped: 0,
    });
  });

  test("a window that closed stops the pick: the file in flight is told to stop, and the rest are refused as cancelled without being asked for", async () => {
    const paths = await many(3);
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const h = harness({ picks: paths, deps: { signal: controller.signal } });
    h.deps.engine.importMedia = async (_call, signal) => {
      signals.push(signal);
      controller.abort();
      return { error: { code: "INTERNAL", detail: "cancelled" }, mediaReason: "cancelled" };
    };
    expect(await run(h)).toEqual({
      picked: true,
      jobIds: [],
      refused: [
        { name: "p000.jpg", reason: "cancelled" },
        { name: "p001.jpg", reason: "cancelled" },
        { name: "p002.jpg", reason: "cancelled" },
      ],
      skipped: 0,
    });
    expect(signals).toEqual([controller.signal]);
  });

  test("more than a hundred picked files: the first twenty become jobs, the next eighty are too-many, and the rest are counted, never dropped", async () => {
    const paths = await many(150);
    const h = harness({ picks: paths });
    const result = await run(h);
    expect(result.picked && result.jobIds).toHaveLength(MAX_PICKED_FILES);
    expect(result.picked && result.refused).toHaveLength(80);
    expect(result.picked && result.refused.every((r) => r.reason === "too-many")).toBe(true);
    expect(result.picked && result.skipped).toBe(50);
    expect(h.imported).toHaveLength(MAX_PICKED_FILES);
  });

  test("a second pick while one is being made is refused as in flight, and the next one after it works", async () => {
    const path = await put("a.jpg");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = harness({ picks: [path] });
    first.deps.pickFiles = async () => {
      await gate;
      return [path];
    };
    const running = handleMediaPickCommand(pickCommand(), first.deps);
    const second = ResponseMessage.parse(await handleMediaPickCommand(pickCommand(), harness({ picks: [path] }).deps));
    expect(!second.ok && second.error.code).toBe("IN_FLIGHT");
    release();
    expect(ResponseMessage.parse(await running).ok).toBe(true);
    expect(ResponseMessage.parse(await handleMediaPickCommand(pickCommand(), harness({ picks: [path] }).deps)).ok).toBe(true);
  });
});

describe("the engine's answer", () => {
  test("an error with no file reason (the engine is busy) on the first file fails the command with that error: nothing was lost", async () => {
    const path = await put("a.jpg");
    const h = harness({ picks: [path], reply: () => ({ error: { code: "IN_FLIGHT", detail: "busy" } }) });
    const response = ResponseMessage.parse(await handleMediaPickCommand(pickCommand(), h.deps));
    expect(response.ok).toBe(false);
    expect(!response.ok && response.error.code).toBe("IN_FLIGHT");
  });

  test("an answer with neither a job nor a reason is an INTERNAL error", async () => {
    const path = await put("a.jpg");
    const h = harness({ picks: [path], reply: () => ({ error: null }) });
    const response = ResponseMessage.parse(await handleMediaPickCommand(pickCommand(), h.deps));
    expect(!response.ok && response.error.code).toBe("INTERNAL");
  });
});

describe("display names", () => {
  test("are the base name only, on either platform's separators", () => {
    expect(displayNameOf("/Users/me/Pictures/summer.jpg", "darwin")).toBe("summer.jpg");
    expect(displayNameOf("C:\\Users\\me\\Pictures\\summer.jpg", "win32")).toBe("summer.jpg");
    expect(displayNameOf("\\\\server\\share\\dir\\a.mp4", "win32")).toBe("a.mp4");
    expect(displayNameOf("D:/Reels/a.mp4", "win32")).toBe("a.mp4");
  });

  test("a backslash in a POSIX file name is part of the name", () => {
    expect(displayNameOf("/Users/me/a\\b.jpg", "linux")).toBe("a\\b.jpg");
  });

  test("control characters are replaced, so a name cannot break a line of text", () => {
    const name = displayNameOf("/Users/me/a\nb\u0000c\u007fd.jpg", "linux");
    expect(MediaFileName.safeParse(name).success).toBe(true);
    expect(name).toBe("a b c d.jpg");
  });

  test("bidi marks and overrides are replaced, so «photo\u202Egpj.exe» cannot read as a picture", () => {
    for (const bad of ["\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u0085", "\u009f"]) {
      const name = displayNameOf(`/Users/me/photo${bad}gpj.exe`, "linux");
      expect(MediaFileName.safeParse(name).success).toBe(true);
      expect(name).toBe("photo gpj.exe");
    }
  });

  test("a long name is cut to the contract's 120 characters", () => {
    const name = displayNameOf(`/x/${"a".repeat(300)}.jpg`, "linux");
    expect(name.length).toBe(120);
    expect(MediaFileName.safeParse(name).success).toBe(true);
  });

  test("a path with no name falls back to `file`", () => {
    expect(displayNameOf("/", "linux")).toBe("file");
    expect(displayNameOf("C:\\", "win32")).toBe("file");
  });
});

describe("preflightPickedFile", () => {
  test("answers the identity of a plain file", async () => {
    const path = await put("a.jpg");
    expect(await preflightPickedFile(path, "photo", { platform: process.platform })).toEqual({ ok: true, identity: await identityOf(path) });
  });

  test("refuses a Windows device path before it touches the disk", async () => {
    let touched = false;
    const ops: OpenRegularOps = {
      lstat: async () => {
        touched = true;
        throw new Error("no");
      },
      open: async () => {
        touched = true;
        throw new Error("no");
      },
    };
    expect(await preflightPickedFile("\\\\.\\COM1", "photo", { platform: "win32", ops })).toEqual({ ok: false, reason: "not-a-file" });
    expect(touched).toBe(false);
  });

  test("a disk that refuses to read is unreadable, not not-a-file", async () => {
    const path = await put("a.jpg");
    const ops: OpenRegularOps = {
      lstat: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      open: async () => {
        throw new Error("no");
      },
    };
    expect(await preflightPickedFile(path, "photo", { platform: process.platform, ops })).toEqual({ ok: false, reason: "unreadable" });
  });
});
