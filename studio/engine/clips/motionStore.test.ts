import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MOTION_ID_MAX, MOTION_STORE_MAX_ITEMS } from "../../shared/engine";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MOTIONS_DIR } from "../library/layout";
import { MotionStoreFile } from "./schemas";
import { MotionStores, addItems, emptyStore, isFull, listedItems, type MotionDraft } from "./motionStore";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «The store», I5.67; review round 2 L2): the pure rules of a photo's motion store (ids, FIFO, the listing) and its file.

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const AT = "2026-10-15T10:00:00.000Z";
const draft = (n: number, text = `she slowly blinks ${n}`): MotionDraft => ({ label: `Движение ${n}`, text, model: "x-ai/grok-4.3", at: AT });
const dir = tempDirFor({ beforeEach, afterEach }, "studio-motion-store-");

describe("the pure rules", () => {
  test("an empty store has ids starting at 1 for both sources and parses under the strict schema", () => {
    const store = emptyStore("photo-0001", SHA);
    expect(store.next).toEqual({ vision: 1, own: 1 });
    expect(store.items).toEqual([]);
    expect(MotionStoreFile.safeParse(store).success).toBe(true);
  });

  test("addItems issues v-1, v-2 for vision and o-1 for own, from separate counters", () => {
    const vision = addItems(emptyStore("photo-0001", SHA), "vision", [draft(1), draft(2)]);
    expect(vision.items.map((i) => i.id)).toEqual(["v-1", "v-2"]);
    const own = addItems(vision.file, "own", [draft(3)]);
    expect(own.items.map((i) => i.id)).toEqual(["o-1"]);
    expect(own.file.next).toEqual({ vision: 3, own: 2 });
  });

  test("addItems trims the oldest items past twelve (FIFO) and the counter keeps counting", () => {
    let file = emptyStore("photo-0001", SHA);
    for (let n = 0; n < 5; n++) file = addItems(file, "vision", [draft(n), draft(n + 10), draft(n + 20)]).file;
    expect(file.items).toHaveLength(MOTION_STORE_MAX_ITEMS);
    expect(file.items[0]?.id).toBe("v-4");
    expect(file.items.at(-1)?.id).toBe("v-15");
    expect(file.next.vision).toBe(16);
  });

  test("an id is never reused after FIFO trimmed the item that held the highest one", () => {
    let file = emptyStore("photo-0001", SHA);
    file = addItems(file, "own", [draft(1)]).file;
    for (let n = 0; n < 4; n++) file = addItems(file, "vision", [draft(n), draft(n + 10), draft(n + 20)]).file;
    expect(file.items.some((i) => i.id === "o-1")).toBe(false);
    expect(addItems(file, "own", [draft(9)]).items[0]?.id).toBe("o-2");
  });

  test("a source that issued its last id issues no more: the rest of a draft list is dropped, and a full source is reported", () => {
    const base = emptyStore("photo-0001", SHA);
    const nearly = { ...base, next: { vision: MOTION_ID_MAX, own: MOTION_ID_MAX + 1 } };
    expect(addItems(nearly, "vision", [draft(1), draft(2)]).items.map((i) => i.id)).toEqual([`v-${MOTION_ID_MAX}`]);
    expect(addItems(nearly, "own", [draft(1)]).items).toEqual([]);
    expect(isFull(nearly, "own")).toBe(true);
    expect(isFull(nearly, "vision")).toBe(false);
  });

  test("listedItems keeps the newest three vision and the newest two own that pass, oldest of those first", () => {
    let file = emptyStore("photo-0001", SHA);
    file = addItems(file, "vision", [draft(1), draft(2), draft(3)]).file;
    file = addItems(file, "own", [draft(4), draft(5), draft(6)]).file;
    file = addItems(file, "vision", [draft(7), draft(8)]).file;
    const listed = listedItems(file, () => true);
    expect(listed.map((i) => i.id)).toEqual(["v-3", "v-4", "v-5", "o-2", "o-3"]);
  });

  test("listedItems re-checks: an item that no longer passes is skipped and an older one takes its place", () => {
    let file = emptyStore("photo-0001", SHA);
    file = addItems(file, "vision", [draft(1), draft(2), draft(3), draft(4)]).file;
    const listed = listedItems(file, (item) => item.id !== "v-4");
    expect(listed.map((i) => i.id)).toEqual(["v-1", "v-2", "v-3"]);
  });
});

describe("the file", () => {
  const avatarDir = () => join(dir(), "avatar");
  // The avatar's folder is the library's to make and to delete: the store only ever makes `motions/` inside it (S5.FU-DATA 4).
  beforeEach(async () => {
    await mkdir(avatarDir(), { recursive: true });
  });

  test("a missing store reads as empty", async () => {
    const stores = new MotionStores(() => undefined);
    const read = await stores.read(avatarDir(), "photo-0001", SHA);
    expect(read.file.items).toEqual([]);
    expect(read.writable).toBe(true);
  });

  test("update writes avatars/<id>/motions/<photoId>.json atomically and reads it back", async () => {
    const stores = new MotionStores(() => undefined);
    await stores.update(avatarDir(), "photo-0001", SHA, (file) => addItems(file, "vision", [draft(1)]).file);
    expect((await readdir(join(avatarDir(), MOTIONS_DIR))).sort()).toEqual(["photo-0001.json"]);
    const onDisk = MotionStoreFile.parse(JSON.parse(await readFile(join(avatarDir(), MOTIONS_DIR, "photo-0001.json"), "utf8")));
    expect(onDisk.items.map((i) => i.id)).toEqual(["v-1"]);
    expect((await new MotionStores(() => undefined).read(avatarDir(), "photo-0001", SHA)).file.items).toHaveLength(1);
  });

  test("a changed photo sha256 empties the store, and its counters start again", async () => {
    const stores = new MotionStores(() => undefined);
    await stores.update(avatarDir(), "photo-0001", SHA, (file) => addItems(file, "vision", [draft(1), draft(2)]).file);
    const read = await stores.read(avatarDir(), "photo-0001", OTHER_SHA);
    expect(read.file.items).toEqual([]);
    expect(read.file.next).toEqual({ vision: 1, own: 1 });
    const updated = await stores.update(avatarDir(), "photo-0001", OTHER_SHA, (file) => addItems(file, "vision", [draft(3)]).file);
    expect(updated.items.map((i) => i.id)).toEqual(["v-1"]);
    expect(updated.photoSha256).toBe(OTHER_SHA);
  });

  test("an avatar folder that is gone is not made again: the write fails and nothing is created (S5.FU-DATA 4)", async () => {
    await rm(avatarDir(), { recursive: true });
    const stores = new MotionStores(() => undefined);
    await expect(stores.update(avatarDir(), "photo-0001", SHA, (file) => addItems(file, "vision", [draft(1)]).file)).rejects.toThrow();
    expect(existsSync(avatarDir())).toBe(false);
  });

  test("a corrupt file reads as empty and is replaced by the next update", async () => {
    await mkdir(join(avatarDir(), MOTIONS_DIR), { recursive: true });
    await writeFile(join(avatarDir(), MOTIONS_DIR, "photo-0001.json"), "{ not json");
    const stores = new MotionStores(() => undefined);
    expect((await stores.read(avatarDir(), "photo-0001", SHA)).file.items).toEqual([]);
    await stores.update(avatarDir(), "photo-0001", SHA, (file) => addItems(file, "own", [draft(1)]).file);
    expect((await stores.read(avatarDir(), "photo-0001", SHA)).file.items.map((i) => i.id)).toEqual(["o-1"]);
  });

  test("a store from a newer build reads as empty, is not writable, and is left as it is", async () => {
    await mkdir(join(avatarDir(), MOTIONS_DIR), { recursive: true });
    const path = join(avatarDir(), MOTIONS_DIR, "photo-0001.json");
    const newer = JSON.stringify({ schemaVersion: 2, something: "from the future" });
    await writeFile(path, newer);
    const stores = new MotionStores(() => undefined);
    const read = await stores.read(avatarDir(), "photo-0001", SHA);
    expect(read.file.items).toEqual([]);
    expect(read.writable).toBe(false);
    await expect(stores.update(avatarDir(), "photo-0001", SHA, (file) => file)).rejects.toThrow("newer build");
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  test("two updates of one photo at once both land (serialised, no lost write)", async () => {
    const stores = new MotionStores(() => undefined);
    await Promise.all([
      stores.update(avatarDir(), "photo-0001", SHA, (file) => addItems(file, "vision", [draft(1)]).file),
      stores.update(avatarDir(), "photo-0001", SHA, (file) => addItems(file, "own", [draft(2)]).file),
    ]);
    const read = await stores.read(avatarDir(), "photo-0001", SHA);
    expect(read.file.items.map((i) => i.id).sort()).toEqual(["o-1", "v-1"]);
  });

  test("the reading is kept beside the items and replaced by a new one", async () => {
    const stores = new MotionStores(() => undefined);
    await stores.update(avatarDir(), "photo-0001", SHA, (file) => ({ ...file, reading: { notes: ["second-phone"] } }));
    await stores.update(avatarDir(), "photo-0001", SHA, (file) => ({ ...file, reading: { notes: [] } }));
    expect((await stores.read(avatarDir(), "photo-0001", SHA)).file.reading).toEqual({ notes: [] });
  });
});
