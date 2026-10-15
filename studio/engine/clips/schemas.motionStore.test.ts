import { describe, expect, test } from "bun:test";
import { MotionStoreFile } from "./schemas";
import { MOTIONS_DIR, MOTION_STORE_SCHEMA_VERSION } from "../library/layout";
import { MOTION_STORE_MAX_ITEMS } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC1 (plan s5b2 §5.3 «The store», I5.67): `avatars/<id>/motions/<photoId>.json`. The file is READ from disk, so it is strict: a file that does not parse is not a store.
// It holds the checked English texts and the labels, never the owner's full idea text (I5.67), and the last frame reading.

const SHA = "a".repeat(64);
const item = (n: number, source: "vision" | "own" = "vision") => ({
  id: `${source === "vision" ? "v" : "o"}-${n}`,
  source,
  label: source === "vision" ? "Дует на чай" : "медленно поворачивает голову…",
  text: "she gently blows on her tea",
  model: "x-ai/grok-4.3",
  at: "2026-10-15T10:00:00.000Z",
});
const file = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, photoId: "photo-0001", photoSha256: SHA, next: { vision: 2, own: 3 }, items: [item(1), item(2, "own")], ...over });

describe("the motion store's place", () => {
  test("lives in `motions` beside `clips`, at schema version 1", () => {
    expect(MOTIONS_DIR).toBe("motions");
    expect(MOTION_STORE_SCHEMA_VERSION).toBe(1);
  });
});

describe("MotionStoreFile", () => {
  test("a store with vision and own items parses", () => {
    expect(MotionStoreFile.safeParse(file()).success).toBe(true);
  });

  test("an empty store parses (a changed photo sha empties it)", () => {
    expect(MotionStoreFile.safeParse(file({ items: [] })).success).toBe(true);
  });

  test("the schema version must be 1: an older or a newer file is not this build's", () => {
    expect(MotionStoreFile.safeParse(file({ schemaVersion: 0 })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ schemaVersion: 2 })).success).toBe(false);
    expect(MotionStoreFile.safeParse({ ...file(), schemaVersion: undefined }).success).toBe(false);
  });

  test("is strict: an unknown key is refused, at the top and on an item", () => {
    expect(MotionStoreFile.safeParse(file({ extra: 1 })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), idea: "the owner's full words" }] })).success).toBe(false);
  });

  test("the photo sha256 is 64 lowercase hex characters", () => {
    expect(MotionStoreFile.safeParse(file({ photoSha256: "A".repeat(64) })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ photoSha256: "a".repeat(63) })).success).toBe(false);
  });

  test("keeps at most twelve items", () => {
    expect(MOTION_STORE_MAX_ITEMS).toBe(12);
    const many = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1, i % 2 === 0 ? "vision" : "own")).map((it, i) => ({ ...it, id: `${it.source === "vision" ? "v" : "o"}-${i + 1}` }));
    const next = { vision: 100, own: 100 };
    expect(MotionStoreFile.safeParse(file({ items: many(12), next })).success).toBe(true);
    expect(MotionStoreFile.safeParse(file({ items: many(13), next })).success).toBe(false);
  });

  // L2 (review round 2): ids are never reused while the store lives. `next` is the next id number to issue per source: `max issued + 1`, kept even after FIFO trimming removed the item that held the
  // highest id, so a stale list's `o-1` can never resolve to a different text. It resets only when the photo sha changes (the whole store is emptied then). At MOTION_ID_MAX + 1 a source is exhausted.
  test("`next` is required: the next vision and the next own id number", () => {
    const { next: _next, ...noNext } = file();
    expect(MotionStoreFile.safeParse(noNext).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ next: { vision: 1 } })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ next: { vision: 1, own: 1, code: 1 } })).success).toBe(false);
  });

  test("`next` is from 1 to 1000: 1000 means every id of the source was issued", () => {
    expect(MotionStoreFile.safeParse(file({ items: [], next: { vision: 1, own: 1 } })).success).toBe(true);
    expect(MotionStoreFile.safeParse(file({ items: [], next: { vision: 1000, own: 1000 } })).success).toBe(true);
    expect(MotionStoreFile.safeParse(file({ items: [], next: { vision: 0, own: 1 } })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [], next: { vision: 1, own: 1001 } })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [], next: { vision: 1.5, own: 1 } })).success).toBe(false);
  });

  test("an item's id number is below `next` of its source: an id is never issued twice", () => {
    expect(MotionStoreFile.safeParse(file({ items: [item(2)], next: { vision: 3, own: 1 } })).success).toBe(true);
    expect(MotionStoreFile.safeParse(file({ items: [item(2)], next: { vision: 2, own: 1 } })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [item(1, "own")], next: { vision: 9, own: 1 } })).success).toBe(false);
  });

  test("`next` may be far above the items left: trimming removed the older ones, their ids stay spent", () => {
    expect(MotionStoreFile.safeParse(file({ items: [item(40), item(41)], next: { vision: 42, own: 17 } })).success).toBe(true);
  });

  test("an id up to 999 is storable", () => {
    expect(MotionStoreFile.safeParse(file({ items: [item(999)], next: { vision: 1000, own: 1 } })).success).toBe(true);
  });

  // L8: the model is an OpenRouter model id, like every other model field of the contract.
  test("`model` looks like vendor/model", () => {
    for (const model of ["grok", "x-ai", "X-AI/Grok", "x-ai/ grok", "a b/c"]) expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), model }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), model: "openai/gpt-5.1" }] })).success).toBe(true);
  });

  test("an item's id and source go together", () => {
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), id: "o-1" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1, "own"), id: "v-1" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), id: "g-blink" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), source: "code" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), source: "scene", id: "scene" }] })).success).toBe(false);
  });

  test("an id appears once", () => {
    expect(MotionStoreFile.safeParse(file({ items: [item(1), item(1)] })).success).toBe(false);
  });

  test("a label is 1 to 40 characters and a text is 1 to 60 characters of printable ASCII", () => {
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), label: "" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), label: "я".repeat(41) }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), text: "" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), text: "a".repeat(61) }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), text: "она улыбается" }] })).success).toBe(false);
  });

  test("an item names its model and its time", () => {
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), model: "" }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), model: "x".repeat(129) }] })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file({ items: [{ ...item(1), at: "yesterday" }] })).success).toBe(false);
    const { model: _model, ...noModel } = item(1);
    expect(MotionStoreFile.safeParse(file({ items: [noModel] })).success).toBe(false);
  });

  test("keeps the last frame reading, optional", () => {
    expect(MotionStoreFile.safeParse(file({ reading: { notes: ["capture-differs"] } })).success).toBe(true);
    expect(MotionStoreFile.safeParse(file({ reading: { notes: [] } })).success).toBe(true);
    expect(MotionStoreFile.safeParse(file({ reading: { notes: ["other"] } })).success).toBe(false);
    expect(MotionStoreFile.safeParse(file()).success).toBe(true);
  });
});
