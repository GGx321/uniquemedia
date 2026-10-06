import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CUSTOM_CATEGORIES, type CategoryPool } from "../../shared/engine";
import { CategoryError, CategoryStore, StoredCategory, type CategoryErrorCode, type NewCategory } from "./categories";
import { openLibrary } from "./library";
import { rejectionOf, steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.2: the category library on disk. One atomically rewritten record per category, library-wide; an unreadable record is
// counted and kept, a newer one is refused and kept, and nothing the store writes can be read half.

const root = useTempDir("studio-categories-");
const dirOf = () => join(root(), "categories");

function pool(over: Partial<CategoryPool> = {}): CategoryPool {
  const activities = [
    { text: "reading a menu", twoHanded: false },
    { text: "stirring a cappuccino", twoHanded: true },
  ];
  return {
    locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({ name, times: ["morning", "midday"], activities, mirror: i === 2 })),
    outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    ...over,
  };
}

let seq = 0;
function input(over: Partial<NewCategory> = {}): NewCategory {
  seq += 1;
  return {
    categoryId: `cat-test-${String(seq).padStart(6, "0")}`,
    name: `Category ${seq}`,
    description: "кофейни и булочные",
    label: "Paris cafes",
    style: "phone",
    pool: pool(),
    model: "x-ai/grok-4.3",
    spentMicros: 5_000,
    ...over,
  };
}

function store(over: ConstructorParameters<typeof CategoryStore>[1] = {}): CategoryStore {
  return new CategoryStore(root(), { now: steppingClock("2026-10-05T12:00:00.000Z"), ...over });
}

async function codeOf(promise: Promise<unknown>): Promise<CategoryErrorCode> {
  const error = await rejectionOf(promise);
  if (!(error instanceof CategoryError)) throw new Error(`expected a CategoryError, got ${String(error)}`);
  return error.code;
}

async function files(): Promise<string[]> {
  return (await readdir(dirOf())).sort();
}

async function readRecord(id: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dirOf(), `${id}.json`), "utf8"));
}

describe("create and list", () => {
  test("a created category is one record in <library>/categories, stamped with its schema version and times", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", name: "Кофейни Парижа" }));

    expect(await files()).toEqual(["cat-paris-cafes.json"]);
    const record = await readRecord("cat-paris-cafes");
    expect(record).toMatchObject({ schemaVersion: 1, categoryId: "cat-paris-cafes", name: "Кофейни Парижа", spentMicros: 5_000 });
    expect(StoredCategory.safeParse(record).success).toBe(true);
    expect(made.createdAt).toBe("2026-10-05T12:00:00.000Z");
    expect(made.updatedAt).toBe(made.createdAt);
    expect((await s.list()).categories).toEqual([made]);
  });

  test("leaves no temp file behind", async () => {
    await store().create(input());
    expect((await files()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("lists in creation order, equal times by id", async () => {
    const s = new CategoryStore(root(), { now: () => new Date("2026-10-05T12:00:00.000Z") });
    await s.create(input({ categoryId: "cat-bbbbbbbb", name: "B" }));
    await s.create(input({ categoryId: "cat-aaaaaaaa", name: "A" }));
    const later = new CategoryStore(root(), { now: () => new Date("2026-10-05T13:00:00.000Z") });
    await later.create(input({ categoryId: "cat-00000000", name: "Late" }));

    expect((await s.list()).categories.map((c) => c.categoryId)).toEqual(["cat-aaaaaaaa", "cat-bbbbbbbb", "cat-00000000"]);
  });

  test("a library with no categories folder lists nothing", async () => {
    expect(await store().list()).toEqual({ categories: [], unreadable: 0 });
  });

  test("get finds one category by id, and null for one that is not there", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    expect(await s.get("cat-paris-cafes")).toEqual(made);
    expect(await s.get("cat-nobody-here")).toBeNull();
  });

  test("an id that is already taken is refused and the record stays as it was", async () => {
    const s = store();
    const first = await s.create(input({ categoryId: "cat-paris-cafes", name: "First" }));
    expect(await codeOf(s.create(input({ categoryId: "cat-paris-cafes", name: "Second" })))).toBe("exists");
    expect(await s.get("cat-paris-cafes")).toEqual(first);
  });

  test("a write that dies before its rename leaves nothing listed and the old record intact", async () => {
    const s = store();
    const first = await s.create(input({ categoryId: "cat-paris-cafes", name: "First" }));
    const dying = store({
      beforeRename: () => {
        throw new Error("the power went");
      },
    });

    await rejectionOf(dying.create(input({ categoryId: "cat-night-market", name: "Second" })));
    await rejectionOf(dying.update("cat-paris-cafes", { name: "Renamed" }));

    expect((await s.list()).categories).toEqual([first]);
    expect(await s.get("cat-night-market")).toBeNull();
    // What a crash leaves is the temp file of the write (the library's survey sweeps it at the next open): never a half record.
    expect((await files()).filter((f) => !f.endsWith(".tmp"))).toEqual(["cat-paris-cafes.json"]);
  });
});

describe("unreadable and newer records", () => {
  async function put(name: string, text: string): Promise<void> {
    await mkdir(dirOf(), { recursive: true });
    await writeFile(join(dirOf(), name), text);
  }

  test("a file that is not JSON, or breaks the schema, is counted, kept, and does not stop the rest", async () => {
    const s = store();
    const good = await s.create(input({ categoryId: "cat-paris-cafes" }));
    await put("cat-broken-json.json", "{not json");
    await put("cat-wrong-shape.json", JSON.stringify({ schemaVersion: 1, categoryId: "cat-wrong-shape", name: 3 }));

    expect(await s.list()).toEqual({ categories: [good], unreadable: 2 });
    expect(await files()).toEqual(["cat-broken-json.json", "cat-paris-cafes.json", "cat-wrong-shape.json"]);
  });

  test("a record whose pool breaks the engine's own pool rules (a youth word in a place) is unreadable, not served", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    const tampered = { ...made, pool: { ...made.pool, locations: made.pool.locations.map((l, i) => (i === 0 ? { ...l, name: "a school courtyard" } : l)) } };
    await put("cat-paris-cafes.json", JSON.stringify(tampered));

    expect(await s.list()).toEqual({ categories: [], unreadable: 1 });
    expect(await s.get("cat-paris-cafes")).toBeNull();
  });

  test("a record whose id does not match its file name is unreadable", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    await put("cat-other-name.json", JSON.stringify(made));

    expect((await s.list()).unreadable).toBe(1);
  });

  test("a record from a newer Studio is counted and kept byte for byte, and nothing can change or remove it", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    const newer = `${JSON.stringify({ ...made, schemaVersion: 2, shiny: true })}\n`;
    await put("cat-paris-cafes.json", newer);

    expect(await s.list()).toEqual({ categories: [], unreadable: 1 });
    expect(await s.get("cat-paris-cafes")).toBeNull();
    expect(await codeOf(s.update("cat-paris-cafes", { name: "Renamed" }))).toBe("not-found");
    expect(await codeOf(s.remove("cat-paris-cafes"))).toBe("not-found");
    expect(await s.addSpend("cat-paris-cafes", 10)).toBeNull();
    expect(await readFile(join(dirOf(), "cat-paris-cafes.json"), "utf8")).toBe(newer);
  });

  test("files that are not category records (a pending record, a temp file, other names) are not counted as unreadable", async () => {
    const s = store();
    await put("pending-job-00000001.json", "{}");
    await put(".cat-x.json.0123456789ab.tmp", "half");
    await put("notes.txt", "hello");

    expect(await s.list()).toEqual({ categories: [], unreadable: 0 });
  });
});

describe("names are unique per library", () => {
  test.each([
    ["the same name", "Paris cafes", "Paris cafes"],
    ["another letter case", "Paris cafes", "PARIS CAFES"],
    ["edge spaces", "Paris cafes", "  Paris cafes "],
    ["a Cyrillic name in another case", "Кофейни Парижа", "кофейни парижа"],
  ])("a second category with %s is refused", async (_name, first, second) => {
    const s = store();
    await s.create(input({ name: first }));
    expect(await codeOf(s.create(input({ name: second })))).toBe("name-taken");
    expect((await s.list()).categories).toHaveLength(1);
  });

  test("the name is stored trimmed", async () => {
    const made = await store().create(input({ name: "  Paris cafes  " }));
    expect(made.name).toBe("Paris cafes");
  });

  test("a rename to another category's name is refused, to its own name in another case is allowed", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-aaaaaaaa", name: "Alpha" }));
    await s.create(input({ categoryId: "cat-bbbbbbbb", name: "Beta" }));

    expect(await codeOf(s.update("cat-bbbbbbbb", { name: " alpha" }))).toBe("name-taken");
    expect((await s.update("cat-bbbbbbbb", { name: "BETA" })).name).toBe("BETA");
  });

  test("two creates of one name that run together make exactly one category", async () => {
    const s = store();
    const results = await Promise.allSettled([s.create(input({ name: "Twin" })), s.create(input({ name: "twin" }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await s.list()).categories).toHaveLength(1);
  });
});

describe("the 50-category limit", () => {
  /** `count` records: one made by the store, the rest copies of it written straight to the folder (the store's own writes are what the other tests cover). */
  async function fill(s: CategoryStore, count: number): Promise<void> {
    const first = await s.create(input({ categoryId: "cat-fill-0000", name: "Fill 0" }));
    for (let i = 1; i < count; i++) {
      const id = `cat-fill-${String(i).padStart(4, "0")}`;
      await writeFile(join(dirOf(), `${id}.json`), JSON.stringify({ ...first, categoryId: id, name: `Fill ${i}` }));
    }
  }

  test("the 51st category is refused", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES);
    expect(await codeOf(s.create(input({ name: "One too many" })))).toBe("limit");
    expect((await s.list()).categories).toHaveLength(MAX_CUSTOM_CATEGORIES);
  });

  test("the 50th is allowed, and a deleted one makes room", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES - 1);
    await s.create(input({ categoryId: "cat-the-fiftieth", name: "Fiftieth" }));
    await s.remove("cat-the-fiftieth");
    await s.create(input({ categoryId: "cat-the-new-one1", name: "New one" }));
    expect((await s.list()).categories).toHaveLength(MAX_CUSTOM_CATEGORIES);
  });

  test("two creates that run together at 49 make exactly one more", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES - 1);
    const results = await Promise.allSettled([s.create(input({ name: "Race A" })), s.create(input({ name: "Race B" }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await s.list()).categories).toHaveLength(MAX_CUSTOM_CATEGORIES);
  });

  test("a file that cannot be read does not count towards the limit", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES - 1);
    await writeFile(join(dirOf(), "cat-broken-json.json"), "{nope");
    await s.create(input({ name: "Still fits" }));
    expect((await s.list()).categories).toHaveLength(MAX_CUSTOM_CATEGORIES);
  });
});

describe("update: rename and remove an item", () => {
  test("a rename changes only the name and the update time", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", name: "Old" }));
    const renamed = await s.update("cat-paris-cafes", { name: " New name " });

    expect(renamed).toEqual({ ...made, name: "New name", updatedAt: renamed.updatedAt });
    expect(renamed.updatedAt > made.updatedAt).toBe(true);
    expect(await readRecord("cat-paris-cafes")).toMatchObject({ name: "New name" });
  });

  test("a place removed by its text leaves the others in order", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ locations: [...pool().locations, { name: "a metro entrance", times: ["evening"], activities: [{ text: "waving", twoHanded: false }, { text: "smiling", twoHanded: false }], mirror: false }] }) }));

    const updated = await s.update("cat-paris-cafes", { removeLocations: ["A FLOWER STALL"] });

    expect(updated.pool.locations.map((l) => l.name)).toEqual(["a corner cafe", "a bookshop", "a riverside bench", "a bakery counter", "a metro entrance"]);
  });

  test("an outfit removed by its text leaves the others", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress", "a red scarf and a coat"] }) }));
    const updated = await s.update("cat-paris-cafes", { removeOutfits: ["a black midi dress"] });
    expect(updated.pool.outfits).toEqual(["a beige trench coat and jeans", "a striped tee and a beret", "a red scarf and a coat"]);
  });

  test("a pool at its minimum cannot lose a place or an outfit, and nothing is written", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));

    expect(await codeOf(s.update("cat-paris-cafes", { removeLocations: ["a flower stall"] }))).toBe("below-minimum");
    expect(await codeOf(s.update("cat-paris-cafes", { removeOutfits: ["a black midi dress"] }))).toBe("below-minimum");
    expect(await s.get("cat-paris-cafes")).toEqual(made);
  });

  test("one removal that would go below the minimum refuses the whole update, rename included", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", name: "Old" }));
    expect(await codeOf(s.update("cat-paris-cafes", { name: "New", removeOutfits: ["a black midi dress"] }))).toBe("below-minimum");
    expect((await s.get("cat-paris-cafes"))?.name).toBe("Old");
    expect(await s.get("cat-paris-cafes")).toEqual(made);
  });

  test("the last mirror place cannot be removed while the deck can draw a mirror shot", async () => {
    const s = store();
    const bigger = pool({ locations: [...pool().locations, { name: "a metro entrance", times: ["evening"], activities: [{ text: "waving", twoHanded: false }, { text: "smiling", twoHanded: false }], mirror: false }] });
    const made = await s.create(input({ categoryId: "cat-paris-cafes", pool: bigger }));

    expect(await codeOf(s.update("cat-paris-cafes", { removeLocations: ["a bookshop"] }))).toBe("mirror-needed");
    expect(await s.get("cat-paris-cafes")).toEqual(made);
  });

  test("a text that names no item is refused", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ outfits: ["a", "b", "c", "d"] }) }));
    expect(await codeOf(s.update("cat-paris-cafes", { removeOutfits: ["a hat nobody has"] }))).toBe("item-not-found");
  });

  test("an unknown category is refused", async () => {
    expect(await codeOf(store().update("cat-nobody-here", { name: "x" }))).toBe("not-found");
  });

  test("two updates that run together both land: nothing is lost", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ outfits: ["a", "b", "c", "d", "e", "f"] }) }));

    await Promise.all([s.update("cat-paris-cafes", { removeOutfits: ["a"] }), s.update("cat-paris-cafes", { removeOutfits: ["b"] }), s.update("cat-paris-cafes", { name: "Both" })]);

    const after = await s.get("cat-paris-cafes");
    expect(after?.pool.outfits).toEqual(["c", "d", "e", "f"]);
    expect(after?.name).toBe("Both");
  });
});

describe("replacePool (a regeneration) and addSpend", () => {
  test("a new pool, label, style and description replace the old; the name, id and creation time stay; the spend adds up", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", name: "Кофейни", spentMicros: 5_000 }));
    const next = pool({ outfits: ["a red coat", "a blue scarf", "a green dress"] });

    const replaced = await s.replacePool("cat-paris-cafes", { description: "новое описание", label: "Paris bakeries", style: "editorial", pool: next, model: "x-ai/grok-4.3", spentMicros: 6_000 });

    expect(replaced).toMatchObject({ categoryId: "cat-paris-cafes", name: "Кофейни", createdAt: made.createdAt, description: "новое описание", label: "Paris bakeries", style: "editorial", pool: next, spentMicros: 11_000 });
    expect(replaced.updatedAt > made.updatedAt).toBe(true);
    expect(await s.get("cat-paris-cafes")).toEqual(replaced);
  });

  test("a regeneration of an unknown category is refused", async () => {
    expect(await codeOf(store().replacePool("cat-nobody-here", { description: "d", label: "l", style: "phone", pool: pool(), model: "x-ai/grok-4.3", spentMicros: 1 }))).toBe("not-found");
  });

  test("spend alone adds to the total and touches nothing else", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    const after = await s.addSpend("cat-paris-cafes", 6_000);
    expect(after).toEqual({ ...made, spentMicros: 11_000, updatedAt: after?.updatedAt ?? "" });
  });

  test("spend for a category that is not there is nobody's: null, nothing written", async () => {
    expect(await store().addSpend("cat-nobody-here", 10)).toBeNull();
  });
});

describe("remove", () => {
  test("deletes the record, and a second delete says it is not there", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes" }));
    await s.remove("cat-paris-cafes");
    expect(await files()).toEqual([]);
    expect(await s.get("cat-paris-cafes")).toBeNull();
    expect(await codeOf(s.remove("cat-paris-cafes"))).toBe("not-found");
  });

  test("flushes the folder after the record is unlinked, so the deletion survives a crash", async () => {
    const synced: { dir: string; recordStillThere: boolean }[] = [];
    const s = store({ fsyncDir: async (dir) => void synced.push({ dir, recordStillThere: existsSync(join(dir, "cat-paris-cafes.json")) }) });
    await s.create(input({ categoryId: "cat-paris-cafes" }));

    await s.remove("cat-paris-cafes");

    expect(synced).toEqual([{ dir: dirOf(), recordStillThere: false }]);
  });

  test("a folder flush that fails does not undo or fail the removal: the record is gone", async () => {
    const s = store({ fsyncDir: async () => Promise.reject(new Error("EIO")) });
    await s.create(input({ categoryId: "cat-paris-cafes" }));

    await s.remove("cat-paris-cafes");

    expect(await files()).toEqual([]);
  });
});

describe("pending records of paid calls", () => {
  const call = { jobId: "job-00000001", kind: "create" as const, name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z" };

  test("a record is written before the call and listed until it is removed", async () => {
    const s = store();
    await s.writePending(call);
    await s.writePending({ ...call, jobId: "job-00000002", kind: "regenerate", categoryId: "cat-paris-cafes" });

    expect(await files()).toEqual(["pending-job-00000001.json", "pending-job-00000002.json"]);
    expect((await s.listPending()).map((p) => p.jobId)).toEqual(["job-00000001", "job-00000002"]);
    expect(await s.removePending("job-00000001")).toBe(true);
    expect((await s.listPending()).map((p) => p.jobId)).toEqual(["job-00000002"]);
  });

  test("flushes the folder after a pending record is unlinked, and not when there was none to remove", async () => {
    const synced: { dir: string; recordStillThere: boolean }[] = [];
    const s = store({ fsyncDir: async (dir) => void synced.push({ dir, recordStillThere: existsSync(join(dir, "pending-job-00000001.json")) }) });
    await s.writePending(call);

    expect(await s.removePending("job-00000001")).toBe(true);
    expect(await s.removePending("job-00000001")).toBe(false);

    expect(synced).toEqual([{ dir: dirOf(), recordStillThere: false }]);
  });

  test("a pending record is not a category and does not count as an unreadable one", async () => {
    const s = store();
    await s.writePending(call);
    expect(await s.list()).toEqual({ categories: [], unreadable: 0 });
  });

  test("removing a record that is not there says so and throws nothing", async () => {
    expect(await store().removePending("job-00000009")).toBe(false);
  });

  test("a record that cannot be read is skipped, not fatal", async () => {
    const s = store();
    await s.writePending(call);
    await writeFile(join(dirOf(), "pending-job-00000003.json"), "{nope");
    expect((await s.listPending()).map((p) => p.jobId)).toEqual(["job-00000001"]);
  });

  test("a regenerate record without a category id (or a create with one) is not read", async () => {
    const s = store();
    await mkdir(dirOf(), { recursive: true });
    await writeFile(join(dirOf(), "pending-job-00000004.json"), JSON.stringify({ schemaVersion: 1, ...call, jobId: "job-00000004", kind: "regenerate" }));
    expect(await s.listPending()).toEqual([]);
  });
});

describe("through the library", () => {
  test("library.categories is the store of the library's own folder", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    const made = await library.categories.create(input({ categoryId: "cat-paris-cafes" }));
    expect(await readdir(join(root(), "categories"))).toEqual(["cat-paris-cafes.json"]);
    expect((await library.categories.list()).categories).toEqual([made]);
  });

  test("opening a library moves a crash's temp file out of categories/ into the quarantine, and keeps the records", async () => {
    await mkdir(dirOf(), { recursive: true });
    await writeFile(join(root(), "library.json"), JSON.stringify({ schemaVersion: 1, createdAt: "2026-10-05T10:00:00.000Z" }));
    await writeFile(join(dirOf(), ".cat-paris-cafes.json.0123456789ab.tmp"), "half a record");
    await writeFile(join(dirOf(), "pending-job-00000001.json"), "{}");

    const { report } = await openLibrary(root(), { now: steppingClock("2026-10-05T12:00:00.000Z") });

    expect(report.quarantined.map((q) => q.reason)).toEqual(["temp-file"]);
    expect(await readdir(dirOf())).toEqual(["pending-job-00000001.json"]);
  });
});
