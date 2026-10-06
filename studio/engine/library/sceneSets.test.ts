import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openLibrary } from "./library";
import { SceneSetError, SceneSetStore, SceneSetFile, type SceneSetErrorCode, type StoredSceneSet } from "./sceneSets";
import { sampleSet } from "./testing/sceneSetSample";
import { rejectionOf, steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: the scene sets on disk. One atomically rewritten record per set under its avatar, a revision on every write, one lock per set; an
// unreadable or newer record is counted and kept, and nothing the store writes can be read half.

const root = useTempDir("studio-scene-sets-");
const AVATAR = "avatar-aaaa-0001";
const dirOf = (avatarId = AVATAR) => join(root(), "avatars", avatarId, "scenes");

function store(over: ConstructorParameters<typeof SceneSetStore>[1] = {}): SceneSetStore {
  return new SceneSetStore(root(), { now: steppingClock("2026-10-07T12:00:00.000Z"), ...over });
}

async function codeOf(promise: Promise<unknown>): Promise<SceneSetErrorCode> {
  const error = await rejectionOf(promise);
  if (!(error instanceof SceneSetError)) throw new Error(`expected a SceneSetError, got ${String(error)}`);
  return error.code;
}

async function files(avatarId = AVATAR): Promise<string[]> {
  return (await readdir(dirOf(avatarId))).sort();
}

async function readRecord(id: string, avatarId = AVATAR): Promise<unknown> {
  return JSON.parse(await readFile(join(dirOf(avatarId), `${id}.json`), "utf8"));
}

/** The same set with its first scene given a sentence: one change a test can tell. */
function written(set: StoredSceneSet, text: string): StoredSceneSet {
  return { ...set, scenes: set.scenes.map((s, i) => (i === 0 ? { ...s, text } : s)) };
}

describe("create and get", () => {
  test("a created set is one record under its avatar, stamped with the schema version, revision 1 and the time", async () => {
    const s = store();
    const made = await s.create(sampleSet());

    expect(await files()).toEqual(["set-aaaa-0001.json"]);
    expect(await readRecord("set-aaaa-0001")).toMatchObject({ schemaVersion: 1, sceneSetId: "set-aaaa-0001", avatarId: AVATAR, revision: 1, runId: "run-aaaa-0001" });
    expect(SceneSetFile.safeParse(await readRecord("set-aaaa-0001")).success).toBe(true);
    expect(made.createdAt).toBe("2026-10-07T12:00:00.000Z");
    expect(made.updatedAt).toBe(made.createdAt);
    expect(await s.get(AVATAR, "set-aaaa-0001")).toEqual(made);
  });

  test("leaves no temp file behind", async () => {
    await store().create(sampleSet());
    expect((await files()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("refuses a set id already taken and leaves the record as it was", async () => {
    const s = store();
    const first = await s.create(sampleSet());
    expect(await codeOf(s.create(sampleSet({ count: 6 })))).toBe("exists");
    expect(await readRecord("set-aaaa-0001")).toEqual(first);
  });

  test("answers null for a set that is not there", async () => {
    expect(await store().get(AVATAR, "set-aaaa-0009")).toBeNull();
  });

  test("refuses an avatar or set id that is not a path segment of the library's own shape", async () => {
    const s = store();
    expect(await codeOf(s.get("../avatar-aaaa-0001", "set-aaaa-0001"))).toBe("invalid");
    expect(await codeOf(s.get(AVATAR, "../set-aaaa-0001"))).toBe("invalid");
  });

  test("refuses a set the schema does not accept and writes nothing", async () => {
    const s = store();
    const set = sampleSet();
    const broken = { ...set, scenes: [...set.scenes, set.scenes[0]!] };
    expect(await codeOf(s.create(broken))).toBe("invalid");
    expect(await readdir(join(root(), "avatars")).catch(() => [])).toEqual([]);
  });
});

describe("update", () => {
  test("rewrites the record with the next revision and a time that never goes back", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const updated = await s.update(AVATAR, made.sceneSetId, (current) => written(current, "She waves from the pier."));

    expect(updated.revision).toBe(2);
    expect(updated.scenes[0]?.text).toBe("She waves from the pier.");
    expect(updated.updatedAt > made.updatedAt).toBe(true);
    expect(await readRecord(made.sceneSetId)).toEqual(updated);
    expect((await files()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("with the revision the change was made on, it goes through", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const updated = await s.update(AVATAR, made.sceneSetId, (c) => written(c, "x"), { expectedRevision: 1 });
    expect(updated.revision).toBe(2);
  });

  test("a stale revision is refused, nothing is written and the mutation never runs", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    await s.update(AVATAR, made.sceneSetId, (c) => written(c, "first"));
    let ran = false;
    const stale = s.update(
      AVATAR,
      made.sceneSetId,
      (c) => {
        ran = true;
        return written(c, "second");
      },
      { expectedRevision: 1 },
    );
    expect(await codeOf(stale)).toBe("stale");
    expect(ran).toBe(false);
    expect((await readRecord(made.sceneSetId)) as StoredSceneSet).toMatchObject({ revision: 2 });
    expect(((await readRecord(made.sceneSetId)) as StoredSceneSet).scenes[0]?.text).toBe("first");
  });

  test("two edits made on the same revision: the first lands, the second is refused, nothing is lost", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const results = await Promise.allSettled([
      s.update(AVATAR, made.sceneSetId, (c) => written(c, "from window A"), { expectedRevision: 1 }),
      s.update(AVATAR, made.sceneSetId, (c) => ({ ...c, scenes: c.scenes.map((sc, i) => (i === 1 ? { ...sc, removed: true } : sc)) }), { expectedRevision: 1 }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const record = (await readRecord(made.sceneSetId)) as StoredSceneSet;
    expect(record.revision).toBe(2);
    expect(record.scenes[0]?.text).toBe("from window A");
    expect(record.scenes[1]?.removed).toBe(false);
  });

  test("updates without a revision run one after another, none lost", async () => {
    const s = store();
    const made = await s.create(sampleSet({ count: 4 }));
    await Promise.all(
      [0, 1, 2, 3].map((i) => s.update(AVATAR, made.sceneSetId, (c) => ({ ...c, scenes: c.scenes.map((sc, j) => (j === i ? { ...sc, text: `text ${i}` } : sc)) }))),
    );
    const record = (await readRecord(made.sceneSetId)) as StoredSceneSet;
    expect(record.revision).toBe(5);
    expect(record.scenes.map((sc) => sc.text)).toEqual(["text 0", "text 1", "text 2", "text 3"]);
  });

  test("a mutation that changes nothing (null) writes nothing and keeps the revision", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const same = await s.update(AVATAR, made.sceneSetId, () => null);
    expect(same).toEqual(made);
    expect((await readRecord(made.sceneSetId)) as StoredSceneSet).toMatchObject({ revision: 1 });
  });

  test("a result the schema refuses is not written", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const failure = s.update(AVATAR, made.sceneSetId, (c) => ({ ...c, scenes: [...c.scenes, c.scenes[0]!] }));
    expect(await codeOf(failure)).toBe("invalid");
    expect(await readRecord(made.sceneSetId)).toEqual(made);
  });

  test("a mutation cannot change what makes the set what it is: its id, avatar, run id or creation time", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    expect(await codeOf(s.update(AVATAR, made.sceneSetId, (c) => ({ ...c, runId: "run-bbbb-0002" })))).toBe("invalid");
    expect(await codeOf(s.update(AVATAR, made.sceneSetId, (c) => ({ ...c, sceneSetId: "set-bbbb-0002" })))).toBe("invalid");
    expect(await codeOf(s.update(AVATAR, made.sceneSetId, (c) => ({ ...c, createdAt: "2020-01-01T00:00:00.000Z" })))).toBe("invalid");
    expect(await readRecord(made.sceneSetId)).toEqual(made);
  });

  test("a set that is not there is not-found", async () => {
    expect(await codeOf(store().update(AVATAR, "set-aaaa-0009", (c) => c))).toBe("not-found");
  });

  test("a crash after the temp file is durable and before the rename leaves the old record whole and readable", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const crashing = store({
      beforeRename: () => {
        throw new Error("crash");
      },
    });
    await rejectionOf(crashing.update(AVATAR, made.sceneSetId, (c) => written(c, "lost")));

    expect(await readRecord(made.sceneSetId)).toEqual(made);
    expect(await s.get(AVATAR, made.sceneSetId)).toEqual(made);
  });

  test("a flush that fails after the rename leaves the new record in place", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    const flaky = store({
      afterRename: () => {
        throw new Error("flush failed");
      },
    });
    await rejectionOf(flaky.update(AVATAR, made.sceneSetId, (c) => written(c, "kept")));
    expect(((await readRecord(made.sceneSetId)) as StoredSceneSet).scenes[0]?.text).toBe("kept");
  });
});

describe("list", () => {
  test("answers the avatar's sets oldest first and none of another avatar's", async () => {
    const s = store();
    const a = await s.create(sampleSet({ sceneSetId: "set-aaaa-0001" }));
    const b = await s.create(sampleSet({ sceneSetId: "set-aaaa-0002", runId: "run-aaaa-0002" }));
    await s.create(sampleSet({ sceneSetId: "set-bbbb-0001", avatarId: "avatar-bbbb-0002", runId: "run-bbbb-0001" }));

    const listed = await s.list(AVATAR);
    expect(listed.sets.map((x) => x.sceneSetId)).toEqual([a.sceneSetId, b.sceneSetId]);
    expect(listed.unreadable).toBe(0);
  });

  test("an avatar with no scenes folder has no sets", async () => {
    expect(await store().list("avatar-zzzz-0009")).toEqual({ sets: [], unreadable: 0 });
  });

  test("a file that cannot be read is counted and left exactly where it is", async () => {
    const s = store();
    await s.create(sampleSet());
    await writeFile(join(dirOf(), "set-aaaa-0002.json"), "{ not json");
    await writeFile(join(dirOf(), "set-aaaa-0003.json"), JSON.stringify({ schemaVersion: 1, sceneSetId: "set-aaaa-0003" }));

    const listed = await s.list(AVATAR);

    expect(listed.sets.map((x) => x.sceneSetId)).toEqual(["set-aaaa-0001"]);
    expect(listed.unreadable).toBe(2);
    expect(await readFile(join(dirOf(), "set-aaaa-0002.json"), "utf8")).toBe("{ not json");
  });

  test("a set a newer Studio wrote is counted, kept, and neither read, rewritten nor removed", async () => {
    const s = store();
    const made = await s.create(sampleSet({ sceneSetId: "set-aaaa-0001" }));
    const newer = JSON.stringify({ ...made, sceneSetId: "set-aaaa-0002", schemaVersion: 2, somethingNew: true });
    await writeFile(join(dirOf(), "set-aaaa-0002.json"), newer);

    expect((await s.list(AVATAR)).unreadable).toBe(1);
    expect(await s.get(AVATAR, "set-aaaa-0002")).toBeNull();
    expect(await codeOf(s.update(AVATAR, "set-aaaa-0002", (c) => c))).toBe("not-found");
    expect(await codeOf(s.remove(AVATAR, "set-aaaa-0002"))).toBe("not-found");
    expect(await readFile(join(dirOf(), "set-aaaa-0002.json"), "utf8")).toBe(newer);
  });

  test("a record whose file name is another set's id is unreadable", async () => {
    const s = store();
    const made = await s.create(sampleSet({ sceneSetId: "set-aaaa-0001" }));
    await writeFile(join(dirOf(), "set-aaaa-0005.json"), JSON.stringify(made));
    expect((await s.list(AVATAR)).unreadable).toBe(1);
  });

  test("temp files and other names are not sets and not counted", async () => {
    const s = store();
    await s.create(sampleSet());
    await writeFile(join(dirOf(), ".set-aaaa-0001.json.0123456789ab.tmp"), "half a record");
    await writeFile(join(dirOf(), "notes.txt"), "hello");
    expect(await s.list(AVATAR)).toMatchObject({ unreadable: 0 });
  });
});

describe("remove", () => {
  test("deletes the record and the folder's entry", async () => {
    const s = store();
    const made = await s.create(sampleSet());
    await s.remove(AVATAR, made.sceneSetId);
    expect(await files()).toEqual([]);
    expect(await s.get(AVATAR, made.sceneSetId)).toBeNull();
  });

  test("a set that is not there is not-found", async () => {
    expect(await codeOf(store().remove(AVATAR, "set-aaaa-0009"))).toBe("not-found");
  });

  test("a disk that refuses the delete leaves the record readable", async () => {
    const made = await store().create(sampleSet());
    const refusing = store({
      beforeUnlink: () => {
        throw new Error("EBUSY");
      },
    });
    await rejectionOf(refusing.remove(AVATAR, made.sceneSetId));
    expect(await store().get(AVATAR, made.sceneSetId)).toEqual(made);
  });
});

describe("through the library", () => {
  test("library.sceneSets is the store of the library's own folder", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
    const made = await library.sceneSets.create(sampleSet());
    expect(await readdir(dirOf())).toEqual(["set-aaaa-0001.json"]);
    expect(await library.sceneSets.get(AVATAR, "set-aaaa-0001")).toEqual(made);
  });

  test("opening a library moves a crash's temp file out of an avatar's scenes/ into the quarantine, and keeps the records", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: "a 25-year-old woman with hazel eyes" });
    const dir = join(root(), "avatars", avatar.id, "scenes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "set-aaaa-0001.json"), "{}");
    await writeFile(join(dir, ".set-aaaa-0001.json.0123456789ab.tmp"), "half a record");

    const reopened = await openLibrary(root(), { now: steppingClock("2026-10-07T13:00:00.000Z") });

    expect(reopened.report.quarantined.map((q) => q.reason)).toEqual(["temp-file"]);
    expect(await readdir(dir)).toEqual(["set-aaaa-0001.json"]);
  });

  test("an avatar's folder holds its scene sets, so moving the folder to the Trash takes them along", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: "a 25-year-old woman with hazel eyes" });
    await library.sceneSets.create(sampleSet({ avatarId: avatar.id }));
    expect(library.sceneSets.dirOf(avatar.id).startsWith(library.avatarDirPath(avatar.id))).toBe(true);
  });

  test("runFolderExists tells whether a run's folder is there", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-07T12:00:00.000Z") });
    expect(await library.runFolderExists("run-aaaa-0001")).toBe(false);
    await library.createRun("run-aaaa-0001", { n: 1 }, z.object({ n: z.number() }));
    expect(await library.runFolderExists("run-aaaa-0001")).toBe(true);
  });
});
