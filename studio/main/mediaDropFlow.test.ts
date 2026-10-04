import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandMessage, MAX_PICKED_FILES, MAX_REFUSED_FILES, mediaByteCap, MediaPickResult, PROTOCOL_VERSION, type PickedFileIdentity } from "../shared/engine";
import { pickedIdentityOf } from "../engine/media/identity";
import { handleDroppedMedia, handleMediaPickCommand, isMediaPickCommand, type MediaImportFlowDeps, type MediaImportReply } from "./mediaImportFlow";
import type { SenderFrame, TrustedRenderer } from "./requests";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3f.6 round 2 (M13, the owner's decision of 2026-10-04): files dropped onto «Мои» from Finder or Explorer. The preload sends main the paths
// Electron gave the dropped `File`s (never a path the page wrote); main answers only its app window's own top frame, and treats the paths
// EXACTLY as its own dialog's picks (the same code): at most 20 taken (the rest `too-many`, beyond the listed ones `skipped`), each opened
// without following a link and as a regular file (a folder or a link is `not-a-file`), its size from the open handle within the `any` cap,
// its identity pinned, then the engine's `media.import`, one file after another. The answer is a pick's `MediaPickResult`.

const TRUSTED: TrustedRenderer = { fileUrl: "file:///Applications/Studio.app/Contents/Resources/app.asar/out-studio/renderer/index.html" };
const APP_FRAME: SenderFrame = { url: TRUSTED.fileUrl, isTopFrame: true, isAppWindow: true };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-media-drop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
async function put(name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JPEG);
  return path;
}
async function identityOf(path: string): Promise<PickedFileIdentity> {
  return pickedIdentityOf(await lstat(path, { bigint: true }));
}

type DropDeps = Omit<MediaImportFlowDeps, "pickFiles">;

function harness(reply?: (path: string) => MediaImportReply) {
  const imported: { pick: string; path: string; name: string; expected: PickedFileIdentity }[] = [];
  let n = 0;
  const deps: DropDeps = {
    engine: {
      importMedia: async (call) => {
        imported.push(call);
        return reply?.(call.path) ?? { error: null, mediaJobId: `job-${String(++n).padStart(8, "0")}` };
      },
    },
    platform: process.platform,
  };
  return { deps, imported };
}

async function drop(payload: unknown, deps: DropDeps, frame: SenderFrame = APP_FRAME) {
  return handleDroppedMedia(payload, frame, TRUSTED, deps);
}

async function dropped(payload: unknown, deps: DropDeps): Promise<MediaPickResult> {
  const reply = await drop(payload, deps);
  if (!reply.ok) throw new Error(`expected an ok answer, got ${JSON.stringify(reply)}`);
  return MediaPickResult.parse(reply.result);
}

describe("who may drop", () => {
  test("only the app window's own top frame showing the app's page: anything else is refused and nothing is looked at", async () => {
    const path = await put("beach.jpg");
    for (const frame of [
      { ...APP_FRAME, isTopFrame: false },
      { ...APP_FRAME, isAppWindow: false },
      { ...APP_FRAME, url: "https://evil.example/index.html" },
      { ...APP_FRAME, url: null },
    ]) {
      const h = harness();
      const reply = await drop({ paths: [path], more: 0 }, h.deps, frame);
      expect(reply).toEqual({ ok: false, error: { code: "VALIDATION", detail: "the drop did not come from the app's own window" } });
      expect(h.imported).toEqual([]);
    }
  });

  test("a payload that is not the preload's is refused: no paths, a path that is not a string, a negative or odd count, extra fields", async () => {
    const path = await put("beach.jpg");
    for (const payload of [null, [path], { paths: path, more: 0 }, { paths: [7], more: 0 }, { paths: [path], more: -1 }, { paths: [path], more: 1.5 }, { paths: [path] }, { paths: [path], more: 0, kind: "photo" }, { paths: Array.from({ length: MAX_REFUSED_FILES + 1 }, () => path), more: 0 }]) {
      const h = harness();
      const reply = await drop(payload, h.deps);
      expect(reply.ok ? "ok" : reply.error.code).toBe("VALIDATION");
      expect(h.imported).toEqual([]);
    }
  });
});

describe("what main does with the dropped paths: a pick's own checks", () => {
  test("a good file goes to the engine as an `any` pick, with its path, its base name and the identity main saw; the answer names the job", async () => {
    const path = await put("beach.jpg");
    const h = harness();
    expect(await dropped({ paths: [path], more: 0 }, h.deps)).toEqual({ picked: true, jobIds: ["job-00000001"], refused: [], skipped: 0 });
    expect(h.imported).toEqual([{ pick: "any", path, name: "beach.jpg", expected: await identityOf(path) }]);
  });

  test("nothing with a path is nothing picked", async () => {
    expect(await dropped({ paths: [], more: 0 }, harness().deps)).toEqual({ picked: false });
  });

  test("a folder is not a file: refused by name, and the engine never hears of it", async () => {
    const folder = join(dir, "Holiday");
    await mkdir(folder);
    const h = harness();
    expect(await dropped({ paths: [folder], more: 0 }, h.deps)).toEqual({ picked: true, jobIds: [], refused: [{ name: "Holiday", reason: "not-a-file" }], skipped: 0 });
    expect(h.imported).toEqual([]);
  });

  test("a link is not followed: refused as not-a-file", async () => {
    const target = await put("real.jpg");
    const link = join(dir, "link.jpg");
    try {
      await symlink(target, link);
    } catch (error) {
      // Windows without the right to make links: the platform cannot hold one here.
      if (process.platform === "win32" && error instanceof Error && Reflect.get(error, "code") === "EPERM") return;
      throw error;
    }
    const h = harness();
    expect(await dropped({ paths: [link], more: 0 }, h.deps)).toEqual({ picked: true, jobIds: [], refused: [{ name: "link.jpg", reason: "not-a-file" }], skipped: 0 });
    expect(h.imported).toEqual([]);
  });

  test("a file over the `any` cap is too-large before a byte is copied", async () => {
    const big = await put("huge.mov");
    await truncate(big, mediaByteCap("any") + 1);
    const h = harness();
    expect(await dropped({ paths: [big], more: 0 }, h.deps)).toEqual({ picked: true, jobIds: [], refused: [{ name: "huge.mov", reason: "too-large" }], skipped: 0 });
    expect(h.imported).toEqual([]);
  });

  test("a relative path, or one with `..`, is never opened", async () => {
    const h = harness();
    expect(await dropped({ paths: ["beach.jpg", `${dir}/../x.jpg`], more: 0 }, h.deps)).toEqual({
      picked: true,
      jobIds: [],
      refused: [
        { name: "beach.jpg", reason: "not-a-file" },
        { name: "x.jpg", reason: "not-a-file" },
      ],
      skipped: 0,
    });
  });

  test("the 21st file is refused as too-many (20 are taken); files beyond what the answer lists, and the ones the preload never looked at, are skipped", async () => {
    const paths: string[] = [];
    for (let i = 0; i < MAX_PICKED_FILES + 1; i++) paths.push(await put(`p${String(i).padStart(2, "0")}.jpg`));
    const h = harness();
    const result = await dropped({ paths, more: 0 }, h.deps);
    expect(h.imported).toHaveLength(MAX_PICKED_FILES);
    expect(result.picked && result.refused).toEqual([{ name: "p20.jpg", reason: "too-many" }]);
    const many = await dropped({ paths: Array.from({ length: MAX_REFUSED_FILES }, (_, i) => paths[i % paths.length] ?? ""), more: 7 }, harness().deps);
    expect(many.picked && many.skipped).toBe(7);
    expect(await dropped({ paths: [], more: 4 }, harness().deps)).toEqual({ picked: true, jobIds: [], refused: [], skipped: 4 });
  });

  test("one at a time with main's dialog: a drop while a pick is running is refused IN_FLIGHT", async () => {
    const path = await put("beach.jpg");
    let release: () => void = () => undefined;
    const held = new Promise<readonly string[] | null>((resolve) => {
      release = () => resolve([]);
    });
    const command = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "media.pickImport", payload: { kind: "any" } });
    if (!isMediaPickCommand(command)) throw new Error("not a pick");
    const h = harness();
    const pick = handleMediaPickCommand(command, { ...h.deps, pickFiles: () => held });
    const reply = await drop({ paths: [path], more: 0 }, h.deps);
    expect(reply.ok ? "ok" : reply.error.code).toBe("IN_FLIGHT");
    release();
    await pick;
    expect((await drop({ paths: [path], more: 0 }, h.deps)).ok).toBe(true);
  });

  test("the answer carries no path", async () => {
    const path = await put("beach.jpg");
    const text = JSON.stringify(await drop({ paths: [path, join(dir, "gone.jpg")], more: 0 }, harness().deps));
    expect(text.includes(dir)).toBe(false);
  });
});
