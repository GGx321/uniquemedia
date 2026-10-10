import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CUSTOM_CATEGORIES, type CategoryPool } from "../../shared/engine";
import { BOOKED_JOBS_CAP, CategoryError, CategoryStore, snapshotOf, StoredCategory, type CategoryErrorCode, type NewCategory } from "./categories";
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
    expect(await store().list()).toEqual({ categories: [], unreadable: 0, overLimit: 0 });
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

    expect(await s.list()).toEqual({ categories: [good], unreadable: 2, overLimit: 0 });
    expect(await files()).toEqual(["cat-broken-json.json", "cat-paris-cafes.json", "cat-wrong-shape.json"]);
  });

  test("a record whose pool breaks the engine's own pool rules (a youth word in a place) is unreadable, not served", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    const tampered = { ...made, pool: { ...made.pool, locations: made.pool.locations.map((l, i) => (i === 0 ? { ...l, name: "a school courtyard" } : l)) } };
    await put("cat-paris-cafes.json", JSON.stringify(tampered));

    expect(await s.list()).toEqual({ categories: [], unreadable: 1, overLimit: 0 });
    expect(await s.get("cat-paris-cafes")).toBeNull();
  });

  // S5.R1 M2: the label goes to the writer in every slot, so a stored label is held to the youth check like the pool texts.
  test("a record whose label suggests a young person is unreadable, not served", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    await put("cat-paris-cafes.json", JSON.stringify({ ...made, label: "Teen cafes" }));

    expect(await s.list()).toEqual({ categories: [], unreadable: 1, overLimit: 0 });
    expect(await s.get("cat-paris-cafes")).toBeNull();
  });

  test("a record whose label is an ordinary phrase is still served", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    await put("cat-paris-cafes.json", JSON.stringify({ ...made, label: "Paris cafes" }));

    expect((await s.list()).unreadable).toBe(0);
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

    expect(await s.list()).toEqual({ categories: [], unreadable: 1, overLimit: 0 });
    expect(await s.get("cat-paris-cafes")).toBeNull();
    expect(await codeOf(s.update("cat-paris-cafes", { name: "Renamed" }))).toBe("not-found");
    expect(await codeOf(s.remove("cat-paris-cafes"))).toBe("not-found");
    expect(await s.addSpend("cat-paris-cafes", 10, "job-00000001")).toBeNull();
    expect(await readFile(join(dirOf(), "cat-paris-cafes.json"), "utf8")).toBe(newer);
  });

  test("files that are not category records (a pending record, a temp file, other names) are not counted as unreadable", async () => {
    const s = store();
    await put("pending-job-00000001.json", "{}");
    await put(".cat-x.json.0123456789ab.tmp", "half");
    await put("notes.txt", "hello");

    expect(await s.list()).toEqual({ categories: [], unreadable: 0, overLimit: 0 });
  });
});

describe("a record or folder the OS will not read", () => {
  const unprivileged = process.platform === "win32" || process.getuid?.() === 0;

  test("a record that is a folder (EISDIR, portable) is counted unreadable and does not stop the list, the room check or a create", async () => {
    const s = store();
    const good = await s.create(input({ categoryId: "cat-paris-cafes" }));
    await mkdir(join(dirOf(), "cat-a-folder-record.json"));

    expect(await s.list()).toEqual({ categories: [good], unreadable: 1, overLimit: 0 });
    expect(await s.get("cat-a-folder-record")).toBeNull();
    await s.assertRoom("Another name", null);
    const made = await s.create(input({ categoryId: "cat-night-market", name: "Night market" }));
    expect((await s.list()).categories.map((c) => c.categoryId)).toEqual([good.categoryId, made.categoryId]);
  });

  test.skipIf(unprivileged)("a record with no read permission (EACCES) is counted unreadable, kept, and does not stop the list", async () => {
    const s = store();
    const good = await s.create(input({ categoryId: "cat-paris-cafes" }));
    const locked = join(dirOf(), "cat-locked-record.json");
    await writeFile(locked, "{}");
    await chmod(locked, 0o000);
    try {
      expect(await s.list()).toEqual({ categories: [good], unreadable: 1, overLimit: 0 });
      expect(await s.get("cat-locked-record")).toBeNull();
    } finally {
      await chmod(locked, 0o600);
    }
  });

  test("a pending record that cannot be read is skipped, not thrown", async () => {
    const s = store();
    await mkdir(dirOf(), { recursive: true });
    await mkdir(join(dirOf(), "pending-job-00000001.json"));
    expect(await s.listPending()).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a categories/ that is a file (its listing fails) lists as one unreadable record and nothing else", async () => {
    await mkdir(root(), { recursive: true });
    await writeFile(dirOf(), "not a folder");
    expect(await store().list()).toEqual({ categories: [], unreadable: 1, overLimit: 0 });
  });

  test.skipIf(unprivileged)("a categories/ folder with no read permission lists as one unreadable record, and the library still opens", async () => {
    await openLibrary(root(), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes" }));
    await chmod(dirOf(), 0o000);
    try {
      expect(await s.list()).toEqual({ categories: [], unreadable: 1, overLimit: 0 });
      const { library } = await openLibrary(root(), { now: steppingClock("2026-10-05T13:00:00.000Z") });
      expect(await library.categories.list()).toEqual({ categories: [], unreadable: 1, overLimit: 0 });
    } finally {
      await chmod(dirOf(), 0o700);
    }
  });

  test.skipIf(process.platform === "win32")("a library opens when categories/ is a file instead of a folder", async () => {
    await openLibrary(root(), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    await writeFile(dirOf(), "not a folder");
    const { library } = await openLibrary(root(), { now: steppingClock("2026-10-05T13:00:00.000Z") });
    expect((await library.categories.list()).unreadable).toBe(1);
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

  test("a rename to the name of a hidden (51st or later) category is refused: the listing cuts at 50, the name check does not", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES + 1);
    const listed = await s.list();
    expect(listed.overLimit).toBe(1);
    const shown = new Set(listed.categories.map((c) => c.name));
    const hidden = Array.from({ length: MAX_CUSTOM_CATEGORIES + 1 }, (_, i) => `Fill ${i}`).find((name) => !shown.has(name));
    expect(hidden).toBeDefined();
    const target = listed.categories[0];
    if (target === undefined || hidden === undefined) throw new Error("the fill left nothing to rename");

    expect(await codeOf(s.update(target.categoryId, { name: hidden }))).toBe("name-taken");
    expect(await codeOf(s.update(target.categoryId, { name: ` ${hidden.toUpperCase()} ` }))).toBe("name-taken");
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

  test("a file that cannot be read counts towards the limit: it is kept on disk, so it holds its place and the folder stays bounded", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES - 1);
    await writeFile(join(dirOf(), "cat-broken-json.json"), "{nope");

    expect(await codeOf(s.create(input({ name: "Does not fit" })))).toBe("limit");

    expect((await files()).filter((n) => n.startsWith("cat-"))).toHaveLength(MAX_CUSTOM_CATEGORIES);
    expect(await s.list()).toMatchObject({ unreadable: 1, overLimit: 0 });
  });

  test("a record from a newer Studio counts towards the limit too", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES - 1);
    const first = JSON.parse(await readFile(join(dirOf(), "cat-fill-0000.json"), "utf8"));
    await writeFile(join(dirOf(), "cat-from-newer.json"), JSON.stringify({ ...first, categoryId: "cat-from-newer", schemaVersion: 99 }));

    expect(await codeOf(s.create(input({ name: "Does not fit" })))).toBe("limit");
  });

  test("more than 50 readable records on disk: the list holds the 50 oldest, in order, and counts the rest as over the limit", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES + 3);

    const listed = await s.list();

    expect(listed.categories).toHaveLength(MAX_CUSTOM_CATEGORIES);
    expect(listed.overLimit).toBe(3);
    expect(listed.unreadable).toBe(0);
    expect(listed.categories[0]?.categoryId).toBe("cat-fill-0000");
    // The records written straight to the folder carry the first one's stamps: equal times, so the id decides the order.
    expect(listed.categories.at(-1)?.categoryId).toBe("cat-fill-0049");
    expect((await files()).filter((n) => n.startsWith("cat-"))).toHaveLength(MAX_CUSTOM_CATEGORIES + 3);
  });

  test("a library at or under the limit has nothing over it", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES);
    expect((await s.list()).overLimit).toBe(0);
  });

  test("with more than 50 on disk no create fits, and a name held by one the list leaves out is still taken", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES + 3);

    expect(await codeOf(s.create(input({ name: "Brand new" })))).toBe("limit");
    expect(await codeOf(s.assertRoom("Fill 52", null))).toBe("limit");
    expect(await codeOf(s.assertRoom("fill 52", "cat-fill-0001"))).toBe("name-taken");
  });

  test("assertRoom lets a fitting new name through, and a rename ignores the library's limit", async () => {
    const s = store();
    await fill(s, MAX_CUSTOM_CATEGORIES - 1);
    await s.assertRoom("Fits", null);
    await s.assertRoom("Fill 1", "cat-fill-0001");
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

describe("update: the category's angles (CS.8a)", () => {
  test("sets the poses and changes nothing else", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    const updated = await s.update("cat-paris-cafes", { poses: ["back", "profile"] });

    expect(updated.pool.poses).toEqual(["back", "profile"]);
    expect(updated).toEqual({ ...made, pool: { ...made.pool, poses: ["back", "profile"] }, updatedAt: updated.updatedAt });
    expect(updated.updatedAt > made.updatedAt).toBe(true);
    expect(await readRecord("cat-paris-cafes")).toMatchObject({ pool: { poses: ["back", "profile"] } });
  });

  test("replaces the poses the pool had", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ poses: ["back"] }) }));
    expect((await s.update("cat-paris-cafes", { poses: ["front"] })).pool.poses).toEqual(["front"]);
  });

  test("null clears them: the record goes back to a pool without the key", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ poses: ["back"] }) }));
    const cleared = await s.update("cat-paris-cafes", { poses: null });
    expect("poses" in cleared.pool).toBe(false);
    expect(JSON.stringify(await readRecord("cat-paris-cafes"))).not.toContain("poses");
  });

  test("goes together with a rename in one write", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", name: "Old" }));
    const updated = await s.update("cat-paris-cafes", { name: "New", poses: ["back"] });
    expect(updated.name).toBe("New");
    expect(updated.pool.poses).toEqual(["back"]);
  });

  test("a refused removal leaves the poses as they were", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes" }));
    expect(await codeOf(s.update("cat-paris-cafes", { poses: ["back"], removeOutfits: ["a black midi dress"] }))).toBe("below-minimum");
    expect(await s.get("cat-paris-cafes")).toEqual(made);
  });

  test.each([
    ["an empty list", []],
    ["a repeated pose", ["back", "back"]],
    ["five poses", ["front", "three-quarter", "profile", "back", "front"]],
    ["a value outside the vocabulary", ["upside-down"]],
  ])("a poses list the contract would refuse (%s) is never stored: the store checks what it writes", async (_name, poses) => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ poses: ["back"] }) }));
    await expect(s.update("cat-paris-cafes", { poses: poses as never })).rejects.toThrow();
    expect(await s.get("cat-paris-cafes")).toEqual(made);
    expect(await readRecord("cat-paris-cafes")).toMatchObject({ pool: { poses: ["back"] } });
  });

  test("a record written before CS.8a (no poses) is read as it is", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes" }));
    const read = await s.get("cat-paris-cafes");
    expect(read).not.toBeNull();
    expect(read !== null && "poses" in read.pool).toBe(false);
  });

  test("the snapshot of a plan carries the poses, and no key without them", async () => {
    const s = store();
    const plain = await s.create(input({ categoryId: "cat-plain-one" }));
    const angled = await s.create(input({ categoryId: "cat-angled-one", pool: pool({ poses: ["back"] }) }));
    expect(snapshotOf(angled).poses).toEqual(["back"]);
    expect("poses" in snapshotOf(plain)).toBe(false);
  });
});

describe("replacePool (a regeneration) and addSpend", () => {
  test("a new pool, label, style and description replace the old; the name, id and creation time stay; the spend adds up", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", name: "Кофейни", spentMicros: 5_000 }));
    const next = pool({ outfits: ["a red coat", "a blue scarf", "a green dress"] });

    const replaced = await s.replacePool("cat-paris-cafes", { description: "новое описание", label: "Paris bakeries", style: "editorial", pool: next, model: "x-ai/grok-4.3", spentMicros: 6_000, jobId: "job-00000001" });

    expect(replaced).toMatchObject({ categoryId: "cat-paris-cafes", name: "Кофейни", createdAt: made.createdAt, description: "новое описание", label: "Paris bakeries", style: "editorial", pool: next, spentMicros: 11_000 });
    expect(replaced.updatedAt > made.updatedAt).toBe(true);
    expect(await s.get("cat-paris-cafes")).toEqual(replaced);
  });

  test("a regeneration re-derives the poses: the new pool's replace the old, and a pool without them clears them", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", pool: pool({ poses: ["back"] }) }));
    const fresh = { description: "d", label: "l", style: "phone" as const, model: "x-ai/grok-4.3", spentMicros: 1 };

    const angled = await s.replacePool("cat-paris-cafes", { ...fresh, pool: pool({ poses: ["profile"] }), jobId: "job-00000001" });
    expect(angled.pool.poses).toEqual(["profile"]);

    const plain = await s.replacePool("cat-paris-cafes", { ...fresh, pool: pool(), jobId: "job-00000002" });
    expect("poses" in plain.pool).toBe(false);
  });

  test("a regeneration of an unknown category is refused", async () => {
    expect(await codeOf(store().replacePool("cat-nobody-here", { description: "d", label: "l", style: "phone", pool: pool(), model: "x-ai/grok-4.3", spentMicros: 1, jobId: "job-00000001" }))).toBe("not-found");
  });

  test("spend alone adds to the total and touches nothing else", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    const after = await s.addSpend("cat-paris-cafes", 6_000, "job-00000001");
    expect(after).toEqual({ ...made, spentMicros: 11_000, bookedJobs: ["job-00000001"], updatedAt: after?.updatedAt ?? "" });
  });

  test("spend for a category that is not there is nobody's: null, nothing written", async () => {
    expect(await store().addSpend("cat-nobody-here", 10, "job-00000001")).toBeNull();
  });
});

describe("a job's spend is booked once (the booked-jobs key)", () => {
  const next = () => ({ description: "новое описание", label: "Paris bakeries", style: "editorial" as const, pool: pool({ outfits: ["a red coat", "a blue scarf", "a green dress"] }), model: "x-ai/grok-4.3" });

  test("addSpend with a job id that is already booked changes nothing: the total and the record stay as they were", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    const first = await s.addSpend("cat-paris-cafes", 6_000, "job-00000001");
    const bytes = await readFile(join(dirOf(), "cat-paris-cafes.json"), "utf8");

    const again = await s.addSpend("cat-paris-cafes", 6_000, "job-00000001");

    expect(first?.spentMicros).toBe(11_000);
    expect(again).toEqual(first);
    expect(await readFile(join(dirOf(), "cat-paris-cafes.json"), "utf8")).toBe(bytes);
  });

  test("two different jobs both count", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    await s.addSpend("cat-paris-cafes", 6_000, "job-00000001");
    const after = await s.addSpend("cat-paris-cafes", 7_000, "job-00000002");
    expect(after?.spentMicros).toBe(18_000);
  });

  test("the job id is written in the same record write as the amount", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    await s.addSpend("cat-paris-cafes", 6_000, "job-00000001");
    expect(await readRecord("cat-paris-cafes")).toMatchObject({ spentMicros: 11_000, bookedJobs: ["job-00000001"] });
  });

  test("a create books its own job, so a later booking of the same job is a no-op", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }), "job-00000001");
    expect(made.bookedJobs).toEqual(["job-00000001"]);
    expect((await s.addSpend("cat-paris-cafes", 5_000, "job-00000001"))?.spentMicros).toBe(5_000);
  });

  test("replacePool with a job id that is already booked is a no-op: neither the pool nor the total changes", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    const first = await s.replacePool("cat-paris-cafes", { ...next(), spentMicros: 6_000, jobId: "job-00000001" });

    const again = await s.replacePool("cat-paris-cafes", { ...next(), description: "ещё одно", spentMicros: 6_000, jobId: "job-00000001" });

    expect(first.spentMicros).toBe(11_000);
    expect(again).toEqual(first);
    expect((await s.get("cat-paris-cafes"))?.description).toBe("новое описание");
  });

  test("a spend booked by addSpend is not counted again by the replacePool of the same job", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    await s.addSpend("cat-paris-cafes", 6_000, "job-00000001");
    const after = await s.replacePool("cat-paris-cafes", { ...next(), spentMicros: 6_000, jobId: "job-00000001" });
    expect(after.spentMicros).toBe(11_000);
  });

  test("a record written before the key existed (no bookedJobs) is read with an empty list and takes the first booking", async () => {
    const s = store();
    const made = await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    const { bookedJobs: _dropped, ...old } = made;
    await mkdir(dirOf(), { recursive: true });
    await writeFile(join(dirOf(), "cat-paris-cafes.json"), JSON.stringify(old));

    expect((await s.get("cat-paris-cafes"))?.bookedJobs).toEqual([]);
    expect((await s.addSpend("cat-paris-cafes", 1_000, "job-00000001"))?.spentMicros).toBe(6_000);
  });

  test("the list is capped at the last 200 jobs: the oldest is dropped, the newest is kept", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 0 }));
    const id = (n: number) => `job-${String(n).padStart(8, "0")}`;
    for (let n = 1; n <= 201; n += 1) await s.addSpend("cat-paris-cafes", 1, id(n));

    const kept = (await s.get("cat-paris-cafes"))?.bookedJobs ?? [];
    expect(kept).toHaveLength(BOOKED_JOBS_CAP);
    expect(BOOKED_JOBS_CAP).toBe(200);
    expect(kept[0]).toBe(id(2));
    expect(kept.at(-1)).toBe(id(201));
    expect((await s.get("cat-paris-cafes"))?.spentMicros).toBe(201);
  });

  test("the cap does not evict an id whose pending record is still in the folder: that call may yet be booked again", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 0 }));
    const id = (n: number) => `job-${String(n).padStart(8, "0")}`;
    await s.writePending({ jobId: id(1), kind: "regenerate", name: "Кофейни", description: "кофейни", categoryId: "cat-paris-cafes", startedAt: "2026-10-05T12:00:00.000Z" });
    for (let n = 1; n <= 201; n += 1) await s.addSpend("cat-paris-cafes", 1, id(n));

    const kept = (await s.get("cat-paris-cafes"))?.bookedJobs ?? [];
    expect(kept).toHaveLength(BOOKED_JOBS_CAP);
    expect(kept).toContain(id(1));
    expect(kept).not.toContain(id(2));
    expect(kept.at(-1)).toBe(id(201));
    // The retried booking of the pending call (a dismiss whose removal failed) still adds nothing.
    expect((await s.addSpend("cat-paris-cafes", 1, id(1)))?.spentMicros).toBe(201);
  });

  test("the list never grows past its cap, even when every id in it has a pending record", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 0 }));
    const id = (n: number) => `job-${String(n).padStart(8, "0")}`;
    for (let n = 1; n <= BOOKED_JOBS_CAP; n += 1) {
      await s.addSpend("cat-paris-cafes", 1, id(n));
      await s.writePending({ jobId: id(n), kind: "regenerate", name: "Кофейни", description: "кофейни", categoryId: "cat-paris-cafes", startedAt: "2026-10-05T12:00:00.000Z" });
    }
    await s.addSpend("cat-paris-cafes", 1, id(BOOKED_JOBS_CAP + 1));

    const kept = (await s.get("cat-paris-cafes"))?.bookedJobs ?? [];
    expect(kept).toHaveLength(BOOKED_JOBS_CAP);
    expect(kept.at(-1)).toBe(id(BOOKED_JOBS_CAP + 1));
  });

  test("a crash between the amount and the key cannot happen: both go in one record write, so a write that dies leaves neither and a retry books once", async () => {
    // The disk lets the first record write after arming through and refuses every later one: a booking made of TWO writes (the amount, then the
    // key) would die between them, leave the amount without its key, and a retry would add the amount again.
    let armed = false;
    let renames = 0;
    const s = store({
      beforeRename: () => {
        if (!armed) return;
        renames += 1;
        if (renames > 1) throw new Error("the process died here");
      },
    });
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000 }));
    armed = true;

    await s.addSpend("cat-paris-cafes", 1_000, "job-00000001").catch(() => null);
    armed = false;
    const retried = await s.addSpend("cat-paris-cafes", 1_000, "job-00000001");

    expect(retried?.spentMicros).toBe(6_000);
    expect(retried?.bookedJobs).toEqual(["job-00000001"]);
  });

  test("a regeneration's answer and its cost are one write too: a write that dies leaves the old pool and the old total", async () => {
    let fail = false;
    const s = store({
      beforeRename: () => {
        if (fail) throw new Error("the process died here");
      },
    });
    const made = await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 5_000, label: "Old label" }));
    fail = true;

    await s.replacePool("cat-paris-cafes", { description: "new", label: "New label", style: "phone", pool: made.pool, model: "x-ai/grok-4.3", spentMicros: 1_000, jobId: "job-00000002" }).catch(() => null);
    fail = false;

    const after = await s.get("cat-paris-cafes");
    expect(after?.label).toBe("Old label");
    expect(after?.spentMicros).toBe(5_000);
    expect(after?.bookedJobs).toEqual([]);
  });

  test("a job still inside the cap is not booked twice after 199 later jobs", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", spentMicros: 0 }));
    const id = (n: number) => `job-${String(n).padStart(8, "0")}`;
    for (let n = 1; n <= 200; n += 1) await s.addSpend("cat-paris-cafes", 1, id(n));
    expect((await s.addSpend("cat-paris-cafes", 1, id(1)))?.spentMicros).toBe(200);
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
    expect(await s.list()).toEqual({ categories: [], unreadable: 0, overLimit: 0 });
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

// A read the OS fails (EIO, EMFILE, EBUSY under an antivirus, EPERM) is injected through the store's `beforeRead`/`beforeList` seams, so these run on every
// platform. A listing counts the file as unreadable; a check that lets a NEW category in (the name, the 50 limit) refuses, because the file it could not read
// may be the one with the same name; a change of an existing record rethrows the OS error so its caller can retry, never «not found».
describe("a read the OS fails", () => {
  const osError = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
  const failing = (code: string, match: (path: string) => boolean, times = 1) => {
    const state = { left: times, failed: 0 };
    return {
      state,
      beforeRead: (path: string) => {
        if (state.left <= 0 || !match(path)) return;
        state.left -= 1;
        state.failed += 1;
        throw osError(code);
      },
    };
  };
  const thisRecord = (id: string) => (path: string) => path.endsWith(`${id}.json`);
  const anyRecord = (path: string) => /cat-[a-z0-9-]+\.json$/.test(path);
  const codeOfRaw = async (promise: Promise<unknown>): Promise<string | undefined> => ((await rejectionOf(promise)) as { code?: string }).code;

  test("list counts the file as unreadable and keeps the others, whatever the OS error", async () => {
    for (const code of ["EIO", "EMFILE", "EBUSY", "EPERM"]) {
      const s = store();
      const good = await s.create(input({ categoryId: `cat-good-record-${code.toLowerCase()}` }));
      await s.create(input({ categoryId: `cat-bad-record-${code.toLowerCase()}` }));
      const listed = await store({ beforeRead: failing(code, thisRecord(`cat-bad-record-${code.toLowerCase()}`)).beforeRead }).list();
      expect(listed.categories.map((c) => c.categoryId)).toContain(good.categoryId);
      expect(listed.unreadable).toBe(1);
      await rm(dirOf(), { recursive: true });
    }
  });

  test("create refuses with library-unreadable when one record hits an OS error, and writes nothing: the file may hold the same name", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", name: "Кофейни" }));
    const fail = failing("EIO", thisRecord("cat-paris-cafes"));

    expect(await codeOf(store({ beforeRead: fail.beforeRead }).create(input({ categoryId: "cat-night-market", name: "Кофейни" })))).toBe("library-unreadable");
    expect(await files()).toEqual(["cat-paris-cafes.json"]);
  });

  test("create refuses with library-unreadable on one EMFILE from the folder's listing, and writes nothing", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", name: "Кофейни" }));
    const beforeList = () => {
      throw osError("EMFILE");
    };

    expect(await codeOf(store({ beforeList }).create(input({ categoryId: "cat-night-market", name: "Кофейни" })))).toBe("library-unreadable");
    expect(await files()).toEqual(["cat-paris-cafes.json"]);
  });

  test("the room check (assertRoom) refuses with library-unreadable on an OS error from a record or from the listing", async () => {
    await store().create(input({ categoryId: "cat-paris-cafes" }));
    const beforeList = () => {
      throw osError("EMFILE");
    };

    expect(await codeOf(store({ beforeRead: failing("EIO", anyRecord).beforeRead }).assertRoom("Another name", null))).toBe("library-unreadable");
    expect(await codeOf(store({ beforeList }).assertRoom("Another name", null))).toBe("library-unreadable");
  });

  test("a rename's name check refuses with library-unreadable when a record hits an OS error", async () => {
    const s = store();
    await s.create(input({ categoryId: "cat-paris-cafes", name: "Кофейни" }));
    await s.create(input({ categoryId: "cat-night-market", name: "Ночной рынок" }));
    // The renamed record reads fine (its first read is let through); the sibling the name is compared with fails.
    const fail = failing("EIO", thisRecord("cat-night-market"));

    expect(await codeOf(store({ beforeRead: fail.beforeRead }).update("cat-paris-cafes", { name: "Кофейни 2" }))).toBe("library-unreadable");
    expect((await s.get("cat-paris-cafes"))?.name).toBe("Кофейни");
  });

  test("create, with the same record failing once and then reading, goes through on the retry", async () => {
    const s = store({ beforeRead: failing("EIO", anyRecord).beforeRead });
    await store().create(input({ categoryId: "cat-paris-cafes", name: "Кофейни" }));
    await rejectionOf(s.create(input({ categoryId: "cat-night-market", name: "Ночной рынок" })));

    const made = await s.create(input({ categoryId: "cat-night-market", name: "Ночной рынок" }));

    expect(made.categoryId).toBe("cat-night-market");
  });

  test("replacePool rethrows the raw OS error, not not-found, and the record keeps its pool and spend", async () => {
    const made = await store().create(input({ categoryId: "cat-paris-cafes" }));
    const fail = failing("EIO", thisRecord("cat-paris-cafes"));
    const change = { description: "new", label: "New label", style: "phone" as const, pool: pool(), model: "x-ai/grok-4.3", spentMicros: 1_000, jobId: "job-0001" };

    expect(await codeOfRaw(store({ beforeRead: fail.beforeRead }).replacePool("cat-paris-cafes", change))).toBe("EIO");
    expect(await store().get("cat-paris-cafes")).toEqual(made);
  });

  test("addSpend rethrows the raw OS error instead of answering null (which reads as «no such category»)", async () => {
    await store().create(input({ categoryId: "cat-paris-cafes" }));
    const fail = failing("EBUSY", thisRecord("cat-paris-cafes"));

    expect(await codeOfRaw(store({ beforeRead: fail.beforeRead }).addSpend("cat-paris-cafes", 500, "job-0001"))).toBe("EBUSY");
  });

  test("update and remove rethrow the raw OS error and leave the record", async () => {
    const made = await store().create(input({ categoryId: "cat-paris-cafes" }));

    expect(await codeOfRaw(store({ beforeRead: failing("EIO", thisRecord("cat-paris-cafes")).beforeRead }).update("cat-paris-cafes", { removeOutfits: ["a black midi dress"] }))).toBe("EIO");
    expect(await codeOfRaw(store({ beforeRead: failing("EPERM", thisRecord("cat-paris-cafes")).beforeRead }).remove("cat-paris-cafes"))).toBe("EPERM");
    expect(await store().get("cat-paris-cafes")).toEqual(made);
  });

  test("get answers null for a read the OS failed: a read-only caller never throws", async () => {
    await store().create(input({ categoryId: "cat-paris-cafes" }));

    expect(await store({ beforeRead: failing("EIO", thisRecord("cat-paris-cafes")).beforeRead }).get("cat-paris-cafes")).toBeNull();
  });
});
