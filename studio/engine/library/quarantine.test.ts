import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Quarantine } from "./quarantine";
import { useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The quarantine never deletes, and what it sets aside must survive a crash right after: every directory it makes is a new
// entry in its parent, and a move is an entry gone from one folder and new in another. Each of those parents is flushed
// (3e.2 review). The flush is watched through the seam; on Windows the real one is a no-op (durableFs.fsyncDir).

const root = useTempDir("studio-quarantine-");

const NOW = () => new Date("2026-10-03T12:00:00.000Z");
const STAMP = "2026-10-03T12-00-00-000Z";

/** A quarantine whose directory flushes are written down, each with what the folder held at that moment. */
function watched() {
  const synced: { dir: string; held: string[] }[] = [];
  const quarantine = new Quarantine(root(), NOW, {
    fsyncDir: async (dir) => {
      synced.push({ dir, held: readdirSync(dir).sort() });
    },
  });
  return { quarantine, synced, dirs: () => synced.map((s) => s.dir) };
}

async function recordFile(): Promise<string> {
  const path = join(root(), "avatars", "avatar-0001", "videos", "video-00000002.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ not json");
  return path;
}

describe("Quarantine: what it sets aside is durable", () => {
  test("a move into a new quarantine flushes every parent of a new folder, then the target folder and the source folder", async () => {
    const path = await recordFile();
    const { quarantine, synced, dirs } = watched();

    await quarantine.move(path, "invalid-video-record");

    const stampDir = join(root(), "quarantine", STAMP);
    const targetDir = join(stampDir, "avatars", "avatar-0001", "videos");
    expect(await readFile(join(targetDir, "video-00000002.json"), "utf8")).toBe("{ not json");
    // Every new folder's parent: the library root (quarantine/), quarantine/ (the stamp), and down the path to the file's folder.
    for (const dir of [root(), join(root(), "quarantine"), stampDir, join(stampDir, "avatars"), join(stampDir, "avatars", "avatar-0001")]) expect(dirs()).toContain(dir);
    // The target folder is flushed once the file is in it, and the source folder once the file has left it.
    expect(synced.find((s) => s.dir === targetDir)?.held).toEqual(["video-00000002.json"]);
    expect(synced.find((s) => s.dir === dirname(path))?.held).toEqual([]);
  });

  test("a second move into the same quarantine flushes only what changed: no folder is new above the file's own", async () => {
    const first = await recordFile();
    const second = join(dirname(first), "video-00000003.json");
    await writeFile(second, "also broken");
    const { quarantine, dirs } = watched();
    await quarantine.move(first, "invalid-video-record");
    const before = dirs().length;

    await quarantine.move(second, "invalid-video-record");

    const targetDir = join(root(), "quarantine", STAMP, "avatars", "avatar-0001", "videos");
    expect(dirs().slice(before).sort()).toEqual([dirname(second), targetDir].sort());
  });

  test("a copy flushes every new folder's parent and the target folder once the copy is in it; the original stays", async () => {
    const path = join(root(), "avatars", "avatar-0001", "rejected.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not json\n");
    const { quarantine, synced, dirs } = watched();

    await quarantine.copy(path, "invalid-reject-log");

    const stampDir = join(root(), "quarantine", STAMP);
    const targetDir = join(stampDir, "avatars", "avatar-0001");
    expect(await readFile(path, "utf8")).toBe("not json\n");
    for (const dir of [root(), join(root(), "quarantine"), stampDir, join(stampDir, "avatars")]) expect(dirs()).toContain(dir);
    expect(synced.find((s) => s.dir === targetDir)?.held).toEqual([basename(path)]);
  });
});
