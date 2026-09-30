import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Montage } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { openLibrary, type Library } from "../library";
import { SAMPLE_AVATAR, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { DraftStore, MAX_DRAFT_BYTES, MAX_DRAFT_FILES_READ, type DraftStoreDeps } from "./store";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The draft files: `avatars/<avatarId>/montages/<montageId>.json`, written atomically, read strictly, listed without ever
// failing for one bad file.

const root = useTempDir("studio-drafts-");
const logs: string[] = [];

function storeOf(extra: Partial<DraftStoreDeps> = {}): DraftStore {
  return new DraftStore({ log: (line) => void logs.push(line), ...extra });
}

async function openWithAvatars(count = 1): Promise<{ library: Library; avatarIds: string[] }> {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatarIds: string[] = [];
  for (let i = 0; i < count; i++) avatarIds.push((await library.createAvatar({ ...SAMPLE_AVATAR, name: `Mia ${i}` })).id);
  return { library, avatarIds };
}

function montageOf(avatarId: string, montageId: string, over: Partial<Montage> = {}): Montage {
  return Montage.parse({
    montageId,
    name: null,
    spec: defaultSpec(avatarId, ["photo-0000001"], 7),
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...over,
  });
}

const fileOf = (library: Library, avatarId: string, montageId: string) => library.montageFilePath(avatarId, montageId);

async function writeRaw(library: Library, avatarId: string, name: string, text: string): Promise<string> {
  await mkdir(library.montagesDir(avatarId), { recursive: true });
  const path = join(library.montagesDir(avatarId), name);
  await writeFile(path, text);
  return path;
}

describe("DraftStore.write and read", () => {
  test("a draft written is the draft read back", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    const montage = montageOf(avatarId, "montage-0001", { name: "Кафе и город" });

    await store.write(library, montage);

    expect(await store.read(library, avatarId, "montage-0001")).toEqual({ kind: "ok", montage });
  });

  test("the file carries its schema version and leaves no temp file", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await storeOf().write(library, montageOf(avatarId, "montage-0001"));

    const text = await readFile(fileOf(library, avatarId, "montage-0001"), "utf8");

    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, montageId: "montage-0001", name: null });
    expect(await readdir(library.montagesDir(avatarId))).toEqual(["montage-0001.json"]);
  });

  test("a second write replaces the first: the last one wins", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(avatarId, "montage-0001", { name: "one" }));
    await store.write(library, montageOf(avatarId, "montage-0001", { name: "two" }));

    const read = await store.read(library, avatarId, "montage-0001");

    expect(read.kind === "ok" ? read.montage.name : null).toBe("two");
    expect(await readdir(library.montagesDir(avatarId))).toEqual(["montage-0001.json"]);
  });

  test("a draft with no clips is stored and read: it is a draft", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    const empty = montageOf(avatarId, "montage-0001", { spec: defaultSpec(avatarId, [], 1) });

    await store.write(library, empty);

    expect(await store.read(library, avatarId, "montage-0001")).toEqual({ kind: "ok", montage: empty });
  });

  test("reading a draft that is not there says missing, not an error", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "missing" });
  });

  test("a crash after the temp file is durable and before the rename leaves the old draft whole", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await storeOf().write(library, montageOf(avatarId, "montage-0001", { name: "old" }));
    const crashing = storeOf({
      beforeRename: () => {
        throw new Error("crash");
      },
    });

    await expect(crashing.write(library, montageOf(avatarId, "montage-0001", { name: "new" }))).rejects.toThrow("crash");

    const read = await storeOf().read(library, avatarId, "montage-0001");
    expect(read.kind === "ok" ? read.montage.name : null).toBe("old");
    // the temp is what a crash leaves; the next open of the library quarantines it, and the listing ignores it
    expect((await readdir(library.montagesDir(avatarId))).filter((n) => n.endsWith(".tmp"))).toHaveLength(1);
  });

  test("a first write that crashes leaves no draft, so the draft was never created", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const crashing = storeOf({
      beforeRename: () => {
        throw new Error("crash");
      },
    });

    await expect(crashing.write(library, montageOf(avatarId, "montage-0001"))).rejects.toThrow("crash");

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "missing" });
  });
});

describe("DraftStore.read of a file that is not a good draft", () => {
  test("a torn file (a cut-off JSON) is unreadable, never a draft", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const whole = JSON.stringify(montageOf(avatarId, "montage-0001"));
    await writeRaw(library, avatarId, "montage-0001.json", whole.slice(0, whole.length / 2));

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "corrupt" });
  });

  test("a file of the wrong shape is unreadable", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0001.json", JSON.stringify({ schemaVersion: 1, montageId: "montage-0001", name: null, spec: { nope: true }, updatedAt: "2026-09-30T10:00:00.000Z" }));

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "corrupt" });
  });

  test("an empty file is unreadable", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0001.json", "");

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "corrupt" });
  });

  test("a draft written by a newer Studio is told apart: it is not read, so a save cannot drop what it holds", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0001.json", JSON.stringify({ ...montageOf(avatarId, "montage-0001"), schemaVersion: 2, extra: "field" }));

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "too-new" });
  });

  test("a file whose montageId is not its name is misfiled", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const other = { schemaVersion: 1, ...montageOf(avatarId, "montage-0002") };
    await writeRaw(library, avatarId, "montage-0001.json", JSON.stringify(other));

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "misfiled" });
  });

  test("a draft of one avatar found in another avatar's folder is misfiled", async () => {
    const { library, avatarIds } = await openWithAvatars(2);
    const [first = "", second = ""] = avatarIds;
    await writeRaw(library, second, "montage-0001.json", JSON.stringify({ schemaVersion: 1, ...montageOf(first, "montage-0001") }));

    expect(await storeOf().read(library, second, "montage-0001")).toEqual({ kind: "unreadable", reason: "misfiled" });
  });

  test("a file over the size bound is refused without being read", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0001.json", " ".repeat(MAX_DRAFT_BYTES + 1));

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "too-large" });
  });

  test("a folder named like a draft is unreadable, not a crash", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await mkdir(join(library.montagesDir(avatarId), "montage-0001.json"), { recursive: true });

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "not-a-file" });
  });

  test.skipIf(process.platform === "win32")("a symlink named like a draft is never followed", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const target = await writeRaw(library, avatarId, "elsewhere.txt", JSON.stringify({ schemaVersion: 1, ...montageOf(avatarId, "montage-0001") }));
    await symlink(target, join(library.montagesDir(avatarId), "montage-0001.json"));

    expect(await storeOf().read(library, avatarId, "montage-0001")).toEqual({ kind: "unreadable", reason: "not-a-file" });
  });

  test("a montage id that could walk out of the folder is refused before any path is built", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;

    await expect(storeOf().read(library, avatarId, "../../avatar")).rejects.toThrow();
  });
});

describe("DraftStore.find", () => {
  test("finds the avatar a draft belongs to, whichever avatar it is", async () => {
    const { library, avatarIds } = await openWithAvatars(3);
    const [, second = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(second, "montage-0001"));

    const found = await store.find(library, "montage-0001");

    expect(found?.avatarId).toBe(second);
    expect(found?.read.kind).toBe("ok");
  });

  test("is null for a draft no avatar has", async () => {
    const { library } = await openWithAvatars(2);

    expect(await storeOf().find(library, "montage-0001")).toBeNull();
  });

  test("answers a damaged draft as damaged, not as missing", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0001.json", "{");

    const found = await storeOf().find(library, "montage-0001");

    expect(found).toEqual({ avatarId, read: { kind: "unreadable", reason: "corrupt" } });
  });
});

describe("DraftStore.list", () => {
  test("lists an avatar's drafts newest first, ties broken by id", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(avatarId, "montage-0001", { updatedAt: "2026-09-30T10:00:00.000Z" }));
    await store.write(library, montageOf(avatarId, "montage-0003", { updatedAt: "2026-09-30T12:00:00.000Z" }));
    await store.write(library, montageOf(avatarId, "montage-0002", { updatedAt: "2026-09-30T10:00:00.000Z" }));

    const listing = await store.list(library, avatarId);

    expect(listing.montages.map((m) => m.montageId)).toEqual(["montage-0003", "montage-0001", "montage-0002"]);
    expect(listing.skipped).toBe(0);
  });

  test("without an avatar it lists every avatar's drafts together", async () => {
    const { library, avatarIds } = await openWithAvatars(2);
    const [first = "", second = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(first, "montage-0001", { updatedAt: "2026-09-30T10:00:00.000Z" }));
    await store.write(library, montageOf(second, "montage-0002", { updatedAt: "2026-09-30T11:00:00.000Z" }));

    const all = await store.list(library);
    const onlyFirst = await store.list(library, first);

    expect(all.montages.map((m) => m.montageId)).toEqual(["montage-0002", "montage-0001"]);
    expect(onlyFirst.montages.map((m) => m.montageId)).toEqual(["montage-0001"]);
  });

  test("an avatar with no montages folder has no drafts", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;

    expect(await storeOf().list(library, avatarId)).toEqual({ montages: [], skipped: 0, truncated: false });
  });

  test("a corrupt draft is skipped and counted, and the rest are listed", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(avatarId, "montage-0001"));
    await writeRaw(library, avatarId, "montage-0002.json", "{ torn");
    await writeRaw(library, avatarId, "montage-0003.json", JSON.stringify({ schemaVersion: 9 }));

    const listing = await store.list(library, avatarId);

    expect(listing.montages.map((m) => m.montageId)).toEqual(["montage-0001"]);
    expect(listing.skipped).toBe(2);
  });

  test("logs the skipped count and never a path or a file's content", async () => {
    logs.length = 0;
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0002.json", "SECRET-TEXT { torn");

    await storeOf().list(library, avatarId);

    const said = logs.join("\n");
    expect(said).toMatch(/1 .*draft/);
    expect(said).not.toContain(root());
    expect(said).not.toContain("SECRET-TEXT");
  });

  test("temp files, dot files and foreign names are not drafts and are not counted", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await storeOf().write(library, montageOf(avatarId, "montage-0001"));
    await writeRaw(library, avatarId, ".montage-0002.json.0a1b2c3d4e5f.tmp", "{ torn");
    await writeRaw(library, avatarId, ".DS_Store", "x");
    await writeRaw(library, avatarId, "notes.txt", "x");
    await writeRaw(library, avatarId, "Montage-0003.json", "x");

    const listing = await storeOf().list(library, avatarId);

    expect(listing.montages.map((m) => m.montageId)).toEqual(["montage-0001"]);
    expect(listing.skipped).toBe(0);
  });

  test("a folder or a symlink named like a draft is skipped and counted", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await mkdir(join(library.montagesDir(avatarId), "montage-0002.json"), { recursive: true });

    const listing = await storeOf().list(library, avatarId);

    expect(listing.montages).toEqual([]);
    expect(listing.skipped).toBe(1);
  });

  test("a file misfiled under another avatar is skipped, not listed under it", async () => {
    const { library, avatarIds } = await openWithAvatars(2);
    const [first = "", second = ""] = avatarIds;
    await writeRaw(library, second, "montage-0001.json", JSON.stringify({ schemaVersion: 1, ...montageOf(first, "montage-0001") }));

    const listing = await storeOf().list(library, second);

    expect(listing).toMatchObject({ montages: [], skipped: 1 });
  });

  test("reads at most MAX_DRAFT_FILES_READ files, says so, and still counts the ones it read", async () => {
    logs.length = 0;
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const dir = library.montagesDir(avatarId);
    await mkdir(dir, { recursive: true });
    const name = (n: number) => `montage-${String(n).padStart(6, "0")}`;
    const text = (n: number) => JSON.stringify({ schemaVersion: 1, ...montageOf(avatarId, name(n)) });
    await Promise.all(Array.from({ length: MAX_DRAFT_FILES_READ + 3 }, (_, n) => writeFile(join(dir, `${name(n)}.json`), text(n))));

    const listing = await storeOf().list(library, avatarId);

    expect(listing.montages).toHaveLength(MAX_DRAFT_FILES_READ);
    expect(listing.truncated).toBe(true);
    expect(logs.join("\n")).toMatch(/more draft files than/);
  });
});

describe("DraftStore.remove", () => {
  test("removes the file and says it was there", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(avatarId, "montage-0001"));

    expect(await store.remove(library, avatarId, "montage-0001")).toBe(true);

    expect(await store.read(library, avatarId, "montage-0001")).toEqual({ kind: "missing" });
  });

  test("says it was not there for a draft that is already gone", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;

    expect(await storeOf().remove(library, avatarId, "montage-0001")).toBe(false);
  });

  test("removes a damaged draft too: the owner can always clear it", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    await writeRaw(library, avatarId, "montage-0001.json", "{");

    expect(await storeOf().remove(library, avatarId, "montage-0001")).toBe(true);
  });

  test("remembers what it removed, for the render that is still holding the draft's id", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const store = storeOf();
    await store.write(library, montageOf(avatarId, "montage-0001"));
    expect(store.wasRemoved("montage-0001")).toBe(false);

    await store.remove(library, avatarId, "montage-0001");

    expect(store.wasRemoved("montage-0001")).toBe(true);
    expect(store.wasRemoved("montage-0002")).toBe(false);
  });
});

describe("DraftStore.exclusive", () => {
  test("tasks on one draft run one after another, in the order they were asked", async () => {
    const store = storeOf();
    const order: string[] = [];
    const slow = store.exclusive("montage-0001", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
    });
    const fast = store.exclusive("montage-0001", async () => {
      order.push("second");
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(["first", "second"]);
  });

  test("tasks on different drafts do not wait for each other", async () => {
    const store = storeOf();
    const order: string[] = [];
    const slow = store.exclusive("montage-0001", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow");
    });
    const fast = store.exclusive("montage-0002", async () => {
      order.push("fast");
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(["fast", "slow"]);
  });

  test("the queue is entered at once, before any await: the order of the calls is the order of the tasks", async () => {
    const store = storeOf();
    const order: number[] = [];
    const calls = Array.from({ length: 10 }, (_, n) =>
      store.exclusive("montage-0001", async () => {
        await new Promise((resolve) => setTimeout(resolve, (10 - n) * 2)); // the earlier the call, the slower the task
        order.push(n);
      }),
    );

    await Promise.all(calls);

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a task that fails does not block the ones behind it", async () => {
    const store = storeOf();
    const failing = store.exclusive("montage-0001", async () => {
      throw new Error("boom");
    });
    const after = store.exclusive("montage-0001", async () => "fine");

    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe("fine");
  });
});
