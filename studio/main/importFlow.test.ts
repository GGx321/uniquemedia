import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandMessage } from "../shared/engine";
import { handleImportPhotoCommand, MAX_IMPORT_FILE_BYTES, type ImportFlowDeps, type ImportPhotoCommand } from "./importFlow";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T6c, design constraint 1: the renderer never sends a path or raw bytes.
// avatars.pickImportPhoto is answered entirely by main: it opens its own
// dialog, reads the picked file with a size cap, and hands the bytes to the
// engine (never the renderer) to validate and stage.

function command(): ImportPhotoCommand {
  const parsed = CommandMessage.parse({ v: 1, id: "cmd-pick-00001", kind: "command", type: "avatars.pickImportPhoto", payload: {} });
  if (parsed.type !== "avatars.pickImportPhoto") throw new Error("wrong type");
  return parsed;
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-import-flow-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Harness {
  deps: ImportFlowDeps;
  staged: Uint8Array[];
}

function harness(options: { pick?: string | null; stageResult?: Awaited<ReturnType<ImportFlowDeps["engine"]["stageImportPhoto"]>> } = {}): Harness {
  const staged: Uint8Array[] = [];
  const deps: ImportFlowDeps = {
    pickImportFile: async () => (options.pick === undefined ? null : options.pick),
    engine: {
      stageImportPhoto: async (bytes) => {
        staged.push(bytes);
        return options.stageResult ?? { error: null, stage: { stagingId: "stage-00000001", width: 10, height: 10 } };
      },
    },
  };
  return { deps, staged };
}

describe("avatars.pickImportPhoto", () => {
  test("a cancelled dialog answers picked: false, and the engine is never asked to stage anything", async () => {
    const { deps, staged } = harness({ pick: null });
    const response = await handleImportPhotoCommand(command(), deps);

    expect(response).toEqual({ v: 1, id: "cmd-pick-00001", kind: "response", type: "avatars.pickImportPhoto", ok: true, result: { picked: false } });
    expect(staged).toHaveLength(0);
  });

  test("a picked file's bytes are read and handed to the engine, which answers the staged photo", async () => {
    const path = join(dir, "photo.png");
    await writeFile(path, Buffer.from([1, 2, 3, 4]));
    const { deps, staged } = harness({ pick: path });

    const response = await handleImportPhotoCommand(command(), deps);

    expect(response).toMatchObject({ ok: true, result: { picked: true, stagingId: "stage-00000001", width: 10, height: 10 } });
    expect(staged).toHaveLength(1);
    expect([...(staged[0] ?? [])]).toEqual([1, 2, 3, 4]);
  });

  test("a file over the size cap is refused with VALIDATION, and the engine never sees its bytes", async () => {
    const path = join(dir, "huge.png");
    await writeFile(path, Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1));
    const { deps, staged } = harness({ pick: path });

    const response = await handleImportPhotoCommand(command(), deps);

    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(staged).toHaveLength(0);
  });

  test("a picked path that cannot be read answers INTERNAL", async () => {
    const { deps } = harness({ pick: join(dir, "does-not-exist.png") });
    const response = await handleImportPhotoCommand(command(), deps);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  // L3: stat-the-bare-path-then-readFile-it-whole was a TOCTOU that could
  // hang forever on a FIFO with no writer (a FIFO's own stat reports a
  // trustworthy-looking size, so the old code would reach an unbounded
  // readFile and block there). Opening the handle first and checking
  // isFile() on ITS OWN stat rejects it before a single byte is read.
  test.skipIf(process.platform === "win32")("a FIFO (not a regular file) is refused with VALIDATION, never read", async () => {
    const path = join(dir, "fifo");
    execFileSync("mkfifo", [path]);
    const { deps, staged } = harness({ pick: path });

    const response = await handleImportPhotoCommand(command(), deps);

    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(staged).toHaveLength(0);
  });

  test("a file exactly at the size cap is accepted; one byte over is refused (boundary)", async () => {
    const atCap = join(dir, "at-cap.png");
    await writeFile(atCap, Buffer.alloc(MAX_IMPORT_FILE_BYTES, 7));
    const { deps: atCapDeps, staged: atCapStaged } = harness({ pick: atCap });
    expect((await handleImportPhotoCommand(command(), atCapDeps)).ok).toBe(true);
    expect(atCapStaged).toHaveLength(1);
    expect(atCapStaged[0]).toHaveLength(MAX_IMPORT_FILE_BYTES);

    const overCap = join(dir, "over-cap.png");
    await writeFile(overCap, Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1, 7));
    const { deps: overCapDeps, staged: overCapStaged } = harness({ pick: overCap });
    expect(await handleImportPhotoCommand(command(), overCapDeps)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(overCapStaged).toHaveLength(0);
  });

  test("the engine's refusal (e.g. VALIDATION for an animated image) is passed on unchanged", async () => {
    const path = join(dir, "photo.webp");
    await writeFile(path, Buffer.from([1, 2, 3, 4]));
    const { deps } = harness({ pick: path, stageResult: { error: { code: "VALIDATION", detail: "an animated image cannot be imported" } } });

    const response = await handleImportPhotoCommand(command(), deps);

    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION", detail: "an animated image cannot be imported" } });
  });
});
