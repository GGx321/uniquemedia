import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLine } from "../../shared/engine/autopilot";
import { AUTOPILOT_DIR, entryIdOf, LaunchStore, LaunchStoreError } from "./launchStore";
import { newLaunchFile } from "./testing/launchFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §3.3, §3.6, §9, §19): the launch store. One file per launch under `<library>/autopilot/`, rewritten whole and atomically with a growing revision,
// strictly parsed; an entry that cannot be read gets an opaque id and is listed, never guessed at; the index it keeps for the lookup fails closed.

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-launch-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const dir = () => join(root, AUTOPILOT_DIR);
const pathOf = (launchId: string) => join(dir(), `${launchId}.json`);
const ID = "launch-fixture-0001";
const OTHER = "launch-fixture-0002";
const store = (deps = {}) => new LaunchStore(root, deps);
const AT = "2026-10-09T10:05:00.000Z";

async function put(name: string, text: string): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(join(dir(), name), text);
}

describe("create and read", () => {
  test("writes <launchId>.json at revision 1 with the schema version, and reads it back whole", async () => {
    const s = store();
    const made = await s.create(newLaunchFile());
    expect(made.revision).toBe(1);
    expect(made.schemaVersion).toBe(1);
    expect(made.updatedAt).toBe(made.createdAt);
    expect(JSON.parse(await readFile(pathOf(ID), "utf8"))).toEqual(made);
    expect(await s.read(ID)).toEqual({ ok: true, file: made });
  });

  test("making the autopilot folder flushes the library root, once: the new entry survives a crash (L9)", async () => {
    const flushed: string[] = [];
    const s = store({ fsyncDir: async (folder: string) => void flushed.push(folder) });
    await s.create(newLaunchFile());
    expect(flushed).toContain(root);
    const before = flushed.filter((f) => f === root).length;
    await s.create({ ...newLaunchFile(), launchId: OTHER });
    expect(flushed.filter((f) => f === root).length).toBe(before);
  });

  test("refuses a launch id that already has a file, and leaves that file as it was", async () => {
    const s = store();
    const made = await s.create(newLaunchFile());
    await expect(s.create({ ...newLaunchFile(), acceptedMicros: 19_000_000 })).rejects.toMatchObject({ code: "exists" });
    expect(await s.read(ID)).toEqual({ ok: true, file: made });
  });

  test("a launch id is a file name only: one with a path in it is refused before anything is touched", async () => {
    await expect(store().create({ ...newLaunchFile(), launchId: "launch-../../escape" })).rejects.toBeInstanceOf(LaunchStoreError);
    expect(existsSync(dir())).toBe(false);
  });

  test("reads a missing file as missing", async () => {
    expect(await store().read(ID)).toEqual({ ok: false, reason: "missing" });
  });

  test("reads a file that does not parse as unreadable, never as a launch", async () => {
    await put(`${ID}.json`, "{not json");
    expect(await store().read(ID)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("update", () => {
  test("rewrites the file whole with the next revision and a write time that never goes back", async () => {
    const s = store({ now: () => new Date("2026-10-09T09:00:00.000Z") });
    await s.create(newLaunchFile());
    const next = await s.update(ID, (current) => ({ ...current, activeMs: 5 }));
    expect(next.revision).toBe(2);
    expect(next.activeMs).toBe(5);
    expect(next.updatedAt).toBe(next.createdAt);
  });

  test("answers what it wrote, and the disk holds the same", async () => {
    const s = store({ now: () => new Date(AT) });
    await s.create(newLaunchFile());
    const next = await s.update(ID, (current) => ({ ...current, activeMs: 9 }));
    expect(next.updatedAt).toBe(AT);
    expect(JSON.parse(await readFile(pathOf(ID), "utf8"))).toEqual(next);
  });

  test("a change that returns null writes nothing and keeps the revision", async () => {
    const s = store();
    const made = await s.create(newLaunchFile());
    const before = await readFile(pathOf(ID), "utf8");
    expect(await s.update(ID, () => null)).toEqual(made);
    expect(await readFile(pathOf(ID), "utf8")).toBe(before);
  });

  test("updates of one launch run one after another: ten increments are ten, at revision 11", async () => {
    const s = store();
    await s.create(newLaunchFile());
    await Promise.all(Array.from({ length: 10 }, () => s.update(ID, (current) => ({ ...current, activeMs: current.activeMs + 1 }))));
    const read = await s.read(ID);
    expect(read.ok && read.file.activeMs).toBe(10);
    expect(read.ok && read.file.revision).toBe(11);
  });

  test("refuses a launch with no file, and one whose file cannot be read, and rewrites neither", async () => {
    const s = store();
    await expect(s.update(ID, (c) => c)).rejects.toMatchObject({ code: "missing" });
    await put(`${OTHER}.json`, "{not json");
    await expect(s.update(OTHER, (c) => c)).rejects.toMatchObject({ code: "unreadable" });
    expect(await readFile(pathOf(OTHER), "utf8")).toBe("{not json");
  });

  test("refuses a change whose result breaks the schema, and the file keeps what it had", async () => {
    const s = store();
    const made = await s.create(newLaunchFile());
    await expect(s.update(ID, (current) => ({ ...current, status: "paused" }))).rejects.toMatchObject({ code: "invalid" });
    expect(await s.read(ID)).toEqual({ ok: true, file: made });
  });

  test("a crash between the temp file and the rename leaves the old content whole, and the next scan sweeps the temp", async () => {
    const s = store({
      beforeRename: () => {
        throw new Error("killed before the rename");
      },
    });
    const made = await s.create(newLaunchFile()).catch(() => null);
    expect(made).toBeNull();
    // The create itself was cut: nothing is under the final name, only a temp sibling.
    expect(existsSync(pathOf(ID))).toBe(false);
    expect((await readdir(dir())).some((name) => name.startsWith(".") && name.endsWith(".tmp"))).toBe(true);
    const healthy = store();
    expect(await healthy.scan()).toMatchObject({ launches: [], unreadable: [], folderUnreadable: false });
    expect((await readdir(dir())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a rewrite cut before the rename keeps the previous revision readable", async () => {
    let cut = false;
    const s = store({
      beforeRename: () => {
        if (cut) throw new Error("killed before the rename");
      },
    });
    const made = await s.create(newLaunchFile());
    cut = true;
    await expect(s.update(ID, (current) => ({ ...current, activeMs: 99 }))).rejects.toThrow("killed");
    expect(await store().read(ID)).toEqual({ ok: true, file: made });
  });
});

describe("scan", () => {
  test("lists the readable launches newest first", async () => {
    const s = store();
    await s.create({ ...newLaunchFile(), launchId: ID, createdAt: "2026-10-09T10:00:00.000Z" });
    await s.create({ ...newLaunchFile(), launchId: OTHER, createdAt: "2026-10-09T11:00:00.000Z", activeSince: "2026-10-09T11:00:00.000Z" });
    const scan = await store().scan();
    expect(scan.launches.map((l) => l.launchId)).toEqual([OTHER, ID]);
    expect(scan.unreadable).toEqual([]);
    expect(scan.folderUnreadable).toBe(false);
  });

  test("a library with no autopilot folder has no launches and nothing unreadable", async () => {
    expect(await store().scan()).toEqual({ launches: [], unreadable: [], folderUnreadable: false });
  });

  test("lists what cannot be read by an opaque id of the file name, with why: invalid, too-new", async () => {
    const good = newLaunchFile();
    await put("launch-broken-0001.json", "{not json");
    await put("launch-extra-0001.json", JSON.stringify({ ...good, launchId: "launch-extra-0001", schemaVersion: 1, revision: 1, updatedAt: good.createdAt, extra: true }));
    await put("launch-newer-0001.json", JSON.stringify({ ...good, launchId: "launch-newer-0001", schemaVersion: 2, revision: 1, updatedAt: good.createdAt }));
    await put("launch-misnamed-0001.json", JSON.stringify({ ...good, schemaVersion: 1, revision: 1, updatedAt: good.createdAt }));
    const scan = await store().scan();
    expect(scan.launches).toEqual([]);
    expect(scan.unreadable.map((u) => [u.name, u.reason]).sort()).toEqual([
      ["launch-broken-0001.json", "invalid"],
      ["launch-extra-0001.json", "invalid"],
      ["launch-misnamed-0001.json", "invalid"],
      ["launch-newer-0001.json", "too-new"],
    ]);
    for (const entry of scan.unreadable) expect(entry.entryId).toBe(entryIdOf(entry.name));
    expect(entryIdOf("launch-broken-0001.json")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a .json file that is not named like a launch is an unreadable entry too", async () => {
    await put("notes.json", "{}");
    expect((await store().scan()).unreadable.map((u) => u.name)).toEqual(["notes.json"]);
  });

  test("log files, torn files, temp files and folders are not entries", async () => {
    await put(`${ID}.log.jsonl`, '{"at":"x"}\n');
    await put(`${ID}.log.jsonl.torn`, "{");
    await put(".somefile.abc.tmp", "{");
    await mkdir(join(dir(), "sub.json"));
    expect((await store().scan()).unreadable).toEqual([]);
  });

  test("a symlink named like a launch is never followed or listed", async () => {
    await mkdir(dir(), { recursive: true });
    await writeFile(join(root, "outside.json"), "{}");
    await symlink(join(root, "outside.json"), join(dir(), "launch-link-0001.json"));
    expect((await store().scan()).unreadable).toEqual([]);
  });

  test("an autopilot folder that cannot be listed is one unreadable entry and marks the folder, so it fails closed", async () => {
    await writeFile(dir(), "I am a file");
    const s = store();
    const scan = await s.scan();
    expect(scan.folderUnreadable).toBe(true);
    expect(scan.unreadable).toEqual([{ entryId: entryIdOf(AUTOPILOT_DIR), name: AUTOPILOT_DIR, reason: "io-error" }]);
    expect(s.hasUnfinishedOrUnreadable()).toBe(true);
    expect(s.isUnfinished("launch-anything-0001")).toBe(true);
  });

  test("never throws: an entry it cannot open is an io-error entry", async () => {
    const s = store();
    await s.create(newLaunchFile());
    await rm(pathOf(ID));
    await mkdir(pathOf(ID));
    // A folder in the place of a launch file: not a regular file, so it is not an entry at all (it cannot describe a launch).
    expect((await s.scan()).unreadable).toEqual([]);
  });
});

describe("removeUnreadable", () => {
  test("moves the matching plain entry into the library's quarantine and keeps its bytes", async () => {
    await put("launch-broken-0001.json", "{not json");
    const s = store();
    const [entry] = (await s.scan()).unreadable;
    expect(await s.removeUnreadable(entry?.entryId ?? "")).toBe(true);
    expect(existsSync(join(dir(), "launch-broken-0001.json"))).toBe(false);
    const stamps = await readdir(join(root, "quarantine"));
    expect(stamps).toHaveLength(1);
    expect(await readFile(join(root, "quarantine", stamps[0] ?? "", AUTOPILOT_DIR, "launch-broken-0001.json"), "utf8")).toBe("{not json");
    expect((await s.scan()).unreadable).toEqual([]);
  });

  test("an id that matches no entry moves nothing", async () => {
    await put("launch-broken-0001.json", "{not json");
    expect(await store().removeUnreadable("0123456789abcdef")).toBe(false);
    expect(existsSync(join(dir(), "launch-broken-0001.json"))).toBe(true);
    expect(existsSync(join(root, "quarantine"))).toBe(false);
  });

  test("never moves a file that reads fine, even when its id is asked for", async () => {
    const s = store();
    await s.create(newLaunchFile());
    expect(await s.removeUnreadable(entryIdOf(`${ID}.json`))).toBe(false);
    expect(await s.read(ID)).toMatchObject({ ok: true });
  });

  test("an entry that was repaired after it was listed is not moved", async () => {
    await put(`${ID}.json`, "{not json");
    const s = store();
    const [entry] = (await s.scan()).unreadable;
    const good = newLaunchFile();
    await writeFile(pathOf(ID), JSON.stringify({ ...good, schemaVersion: 1, revision: 1, updatedAt: good.createdAt }));
    expect(await s.removeUnreadable(entry?.entryId ?? "")).toBe(false);
    expect(existsSync(pathOf(ID))).toBe(true);
  });

  test("the folder's own entry cannot be removed", async () => {
    await writeFile(dir(), "I am a file");
    expect(await store().removeUnreadable(entryIdOf(AUTOPILOT_DIR))).toBe(false);
    expect(await readFile(dir(), "utf8")).toBe("I am a file");
  });

  test("removing the file of an unfinished launch frees the lookup: it no longer reads as unfinished", async () => {
    await put(`${ID}.json`, "{not json");
    const s = store();
    const [entry] = (await s.scan()).unreadable;
    expect(s.isUnfinished(ID)).toBe(true);
    await s.removeUnreadable(entry?.entryId ?? "");
    expect(s.isUnfinished(ID)).toBe(false);
  });
});

describe("the index the lookup reads (fail closed)", () => {
  test("a created launch is unfinished until it is done or stopped", async () => {
    const s = store();
    await s.create(newLaunchFile());
    expect(s.isUnfinished(ID)).toBe(true);
    expect(s.hasUnfinishedOrUnreadable()).toBe(true);
    await s.update(ID, (c) => ({ ...c, status: "stopped", endedAt: AT, activeSince: null }));
    expect(s.isUnfinished(ID)).toBe(false);
    expect(s.hasUnfinishedOrUnreadable()).toBe(false);
  });

  test("a paused launch is unfinished", async () => {
    const s = store();
    await s.create(newLaunchFile());
    await s.update(ID, (c) => ({ ...c, status: "paused", activeSince: null, paused: { cause: "owner", at: AT } }));
    expect(s.isUnfinished(ID)).toBe(true);
  });

  test("an unreadable file named for a launch counts as that launch being unfinished, and blocks the library", async () => {
    await put(`${ID}.json`, "{not json");
    const s = store();
    await s.scan();
    expect(s.isUnfinished(ID)).toBe(true);
    expect(s.isUnfinished(OTHER)).toBe(false);
    expect(s.hasUnfinishedOrUnreadable()).toBe(true);
  });

  test("an unknown launch id is not unfinished", async () => {
    const s = store();
    await s.scan();
    expect(s.isUnfinished("launch-nobody-0404")).toBe(false);
  });

  test("a scan replaces the index with what the disk says now", async () => {
    const s = store();
    await s.create(newLaunchFile());
    await rm(pathOf(ID));
    await s.scan();
    expect(s.isUnfinished(ID)).toBe(false);
  });
});

describe("the log", () => {
  const line = (n: number): LogLine => ({ at: AT, kind: "done", videosDone: n, videosPlanned: 99 });

  test("appends typed lines and reads the newest ones, oldest first", async () => {
    const s = store();
    await s.create(newLaunchFile());
    for (let n = 1; n <= 5; n++) await s.appendLog(ID, line(n));
    expect((await s.readLog(ID, 3)).map((l) => (l.kind === "done" ? l.videosDone : -1))).toEqual([3, 4, 5]);
  });

  test("a launch with no log reads as empty", async () => {
    expect(await store().readLog(ID, 20)).toEqual([]);
  });

  test("a line that does not fit the contract is left out of the read, the others stay", async () => {
    const s = store();
    await s.appendLog(ID, line(1));
    await writeFile(join(dir(), `${ID}.log.jsonl`), `${JSON.stringify(line(1))}\n{"kind":"nonsense"}\nnot json\n${JSON.stringify(line(2))}\n`);
    expect((await s.readLog(ID, 20)).map((l) => (l.kind === "done" ? l.videosDone : -1))).toEqual([1, 2]);
  });

  test("the log is bounded: past its limit the oldest lines go and the newest stay", async () => {
    const s = store({ logMaxLines: 10, logKeepLines: 6 });
    for (let n = 1; n <= 25; n++) await s.appendLog(ID, line(n));
    const all = await s.readLog(ID, 500);
    expect(all.length).toBeLessThanOrEqual(10);
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.at(-1)).toEqual(line(25));
    const numbers = all.map((l) => (l.kind === "done" ? l.videosDone : -1));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });
});
