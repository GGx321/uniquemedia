import { describe, expect, test } from "bun:test";
import { perfTest } from "../../testing/bunTiers";
import { assertBudget } from "../../testing/tiers";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { useWorld, type World } from "../videos/testing/kit";
import { montageRig, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `montages.save` and `montages.delete` (K4, K5, serialised latest-wins saves): what is stored, what is refused, and what
// happens when several commands for one draft arrive together.

const world = useWorld();

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

function draft(avatarId: string, montageId: string, photoIds: string[] = [], over: Partial<Montage> = {}): Montage {
  return Montage.parse({ montageId, name: null, spec: defaultSpec(avatarId, photoIds, 3), updatedAt: "2026-09-30T09:00:00.000Z", ...over });
}

const ID = "montage-0000001";
const filesOf = (w: World): Promise<string[]> => readdir(join(w.libraryRoot, "avatars", w.avatar.id, "montages")).catch(() => []);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The spec of `stored` with a different seed: a change a save can be told apart by. */
const withSeed = (stored: Montage, seed: number): MontageDraft => ({ ...stored.spec, seed });

describe("montages.save", () => {
  test("replaces the spec and the name, stamps the clock's now, and answers what it stored", async () => {
    const w = world();
    const r = montageRig(w, { now: () => new Date("2026-09-30T15:00:00.000Z") });
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, ID, [a]));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [a, b], 9), name: "Кафе и город" });

    expect(montage).toMatchObject({ montageId: ID, name: "Кафе и город", updatedAt: "2026-09-30T15:00:00.000Z" });
    expect(montage.spec.clips[0]).toMatchObject({ kind: "collage" });
    expect(await r.store.read(w.library, w.avatar.id, ID)).toEqual({ kind: "ok", montage });
  });

  test("a clock behind the stored draft still moves updatedAt forward: 1 ms after the stored one (3d.2 re-review)", async () => {
    const w = world();
    // The draft was saved on a machine whose clock ran a day ahead; this one's clock is correct.
    const r = montageRig(w, { now: () => new Date("2026-09-30T15:00:00.000Z") });
    await r.store.write(w.library, draft(w.avatar.id, ID, [], { updatedAt: "2026-10-01T10:00:00.000Z" }));

    const first = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 5), name: null });
    const second = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 6), name: null });

    expect(first.montage.updatedAt).toBe("2026-10-01T10:00:00.001Z");
    expect(second.montage.updatedAt).toBe("2026-10-01T10:00:00.002Z");
  });

  test("the stored stamp is compared as a time, not as text: another precision does not fool it", async () => {
    const w = world();
    // «…:00Z» sorts after «…:00.000Z» as text although it is the same instant.
    const r = montageRig(w, { now: () => new Date("2026-09-30T14:59:59.500Z") });
    await r.store.write(w.library, draft(w.avatar.id, ID, [], { updatedAt: "2026-09-30T15:00:00Z" }));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 5), name: null });

    expect(montage.updatedAt).toBe("2026-09-30T15:00:00.001Z");
  });

  test("a clock ahead of the stored draft stamps its own now", async () => {
    const w = world();
    const r = montageRig(w, { now: () => new Date("2026-09-30T15:00:00.000Z") });
    await r.store.write(w.library, draft(w.avatar.id, ID, [], { updatedAt: "2026-09-30T14:00:00.000Z" }));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 5), name: null });

    expect(montage.updatedAt).toBe("2026-09-30T15:00:00.000Z");
  });

  test("a name of null clears the name", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID, [], { name: "old" }));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: null });

    expect(montage.name).toBeNull();
  });

  test("announces the draft once, as an upsert of exactly what it answered", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 5), name: null });

    expect(r.stamped().map((e) => [e.type, e.payload])).toEqual([["montage.changed", { change: "upserted", montage }]]);
  });

  test("a spec for another avatar than the draft's is VALIDATION, and the stored draft is untouched", async () => {
    const w = world();
    const r = montageRig(w);
    const other = await w.library.createAvatar({ name: "Lena", age: 25, traits: {}, descriptor: "a woman" });
    const stored = draft(w.avatar.id, ID, [], { name: "keep" });
    await r.store.write(w.library, stored);
    const before = await readFile(w.library.montageFilePath(w.avatar.id, ID), "utf8");

    const error = await failureOf(r.service.save({ montageId: ID, spec: defaultSpec(other.id, [], 1), name: "changed" }));

    expect(error.code).toBe("VALIDATION");
    expect(await readFile(w.library.montageFilePath(w.avatar.id, ID), "utf8")).toBe(before);
    expect(r.events).toEqual([]);
  });

  test("a draft that does not exist is NOT_FOUND, and nothing is created", async () => {
    const w = world();
    const r = montageRig(w);

    expect((await failureOf(r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: null }))).code).toBe("NOT_FOUND");
    expect(await filesOf(w)).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("nothing is checked against the library: a photo that was rejected, or is not there at all, is saved", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, ID));
    await w.library.setRejected(w.avatar.id, a, true);
    const spec = defaultSpec(w.avatar.id, [a, "photo-nobody-1"], 1);

    const { montage } = await r.service.save({ montageId: ID, spec, name: null });

    expect(montage.spec).toEqual(spec);
  });

  test("a draft may be saved with no clips at all", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID, [worldPhotoIds(w)[0] ?? ""]));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: null });

    expect(montage.spec.clips).toEqual([]);
  });

  test("a damaged stored draft is not overwritten: INTERNAL, and the file is as it was", async () => {
    const w = world();
    const r = montageRig(w);
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    await writeFile(w.library.montageFilePath(w.avatar.id, ID), "{ torn");

    const error = await failureOf(r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: null }));

    expect(error.code).toBe("INTERNAL");
    expect(await readFile(w.library.montageFilePath(w.avatar.id, ID), "utf8")).toBe("{ torn");
  });

  test("a draft written by a newer Studio is not overwritten either", async () => {
    const w = world();
    const r = montageRig(w);
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    const newer = JSON.stringify({ ...draft(w.avatar.id, ID), schemaVersion: 2 });
    await writeFile(w.library.montageFilePath(w.avatar.id, ID), newer);

    const error = await failureOf(r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: null }));

    expect(error.detail).toMatch(/newer/);
    expect(await readFile(w.library.montageFilePath(w.avatar.id, ID), "utf8")).toBe(newer);
  });

  test("a failing disk is INTERNAL by code alone, the old draft stays whole and nothing is announced", async () => {
    const w = world();
    const r = montageRig(w, {
      store: {
        beforeRename: () => {
          throw Object.assign(new Error(`ENOSPC: no space left on device, write '${w.libraryRoot}/x'`), { code: "ENOSPC" });
        },
      },
    });
    const stored = draft(w.avatar.id, ID, [], { name: "old" });
    const good = montageRig(w);
    await good.store.write(w.library, stored);

    const error = await failureOf(r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: "new" }));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").toContain("ENOSPC");
    expect(error.detail ?? "").not.toContain(w.libraryRoot);
    expect(await good.store.read(w.library, w.avatar.id, ID)).toEqual({ kind: "ok", montage: stored });
    expect(r.events).toEqual([]);
  });

  test("with no library open it says so", async () => {
    const w = world();
    const r = montageRig(w, { library: null });

    expect((await failureOf(r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: null }))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a listener that throws does not fail the save", async () => {
    const w = world();
    const r = montageRig(w, {
      deps: {
        emit: () => {
          throw new Error("the window is closed");
        },
      },
    });
    await r.store.write(w.library, draft(w.avatar.id, ID));

    const { montage } = await r.service.save({ montageId: ID, spec: defaultSpec(w.avatar.id, [], 1), name: "kept" });

    expect(montage.name).toBe("kept");
  });
});

describe("montages.save: several saves of one draft at once", () => {
  test("the last save asked is the one that stays, even when an earlier one is the slowest", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    // The earlier a save was asked, the longer its disk work takes: a rig without a queue would let the LAST one finish first.
    let writes = 0;
    const r = montageRig(w, { store: { beforeRename: () => sleep(Math.max(0, 40 - 3 * writes++)) } });
    await r.store.write(w.library, stored);
    writes = 0;

    const saves = Array.from({ length: 12 }, (_, n) => r.service.save({ montageId: ID, spec: withSeed(stored, n + 100), name: `save-${n}` }));
    const answers = await Promise.all(saves);

    const final = await r.store.read(w.library, w.avatar.id, ID);
    expect(final.kind === "ok" ? [final.montage.name, final.montage.spec.seed] : null).toEqual(["save-11", 111]);
    expect(answers.map((a) => a.montage.name)).toEqual(Array.from({ length: 12 }, (_, n) => `save-${n}`));
  });

  test("the announcements come in the order the saves were asked, and updatedAt never goes back", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    let n = 0;
    const r = montageRig(w, { store: { beforeRename: () => sleep(Math.max(0, 30 - 2 * n++)) } });
    await r.store.write(w.library, stored);

    await Promise.all(Array.from({ length: 10 }, (_, k) => r.service.save({ montageId: ID, spec: withSeed(stored, k), name: `save-${k}` })));

    const upserts = r.stamped().flatMap((e) => (e.type === "montage.changed" && e.payload.change === "upserted" ? [e.payload.montage] : []));
    expect(upserts.map((m) => m.name)).toEqual(Array.from({ length: 10 }, (_, k) => `save-${k}`));
    const times = upserts.map((m) => m.updatedAt);
    expect(times).toEqual([...times].sort());
  });

  test("the order holds when the library lookup before each save takes a different time", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    let calls = 0;
    const r = montageRig(w, {
      deps: {
        // the first call's lookup is the slowest, as an identity check on a slow disk would be
        withLibrary: async (work) => {
          await sleep(Math.max(0, 30 - 3 * calls++));
          return work(w.library);
        },
      },
    });
    await r.store.write(w.library, stored);

    await Promise.all(Array.from({ length: 8 }, (_, k) => r.service.save({ montageId: ID, spec: withSeed(stored, k), name: `save-${k}` })));

    const final = await r.store.read(w.library, w.avatar.id, ID);
    expect(final.kind === "ok" ? final.montage.name : null).toBe("save-7");
  });

  test("the file is a whole draft at every moment: a reader never meets a torn or empty one", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    const r = montageRig(w);
    await r.store.write(w.library, stored);
    const reads: string[] = [];
    let saving = true;
    const reader = (async () => {
      while (saving) {
        const read = await r.store.read(w.library, w.avatar.id, ID);
        reads.push(read.kind);
        await sleep(0);
      }
    })();

    await Promise.all(Array.from({ length: 30 }, (_, k) => r.service.save({ montageId: ID, spec: withSeed(stored, k), name: `save-${k}` })));
    saving = false;
    await reader;

    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(["ok"]));
    expect((await filesOf(w)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("saves of different drafts do not wait for each other", async () => {
    const w = world();
    // The slow draft's save is HELD at its rename until the fast one has finished: if the two waited for each other the fast
    // save could never finish, and the test says so. No stopwatch: a 90 ms bound on wall time failed on a loaded Windows runner (227 ms).
    let reachedSlow: () => void = () => undefined;
    const slowIsHeld = new Promise<void>((resolve) => {
      reachedSlow = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = montageRig(w, {
      store: {
        beforeRename: (path) => {
          if (!path.includes("montage-0000001")) return undefined;
          reachedSlow();
          return gate;
        },
      },
    });
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000002"));
    await w.library.createAvatar({ name: "unused", age: 25, traits: {}, descriptor: "a woman" });
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    await writeFile(w.library.montageFilePath(w.avatar.id, "montage-0000001"), JSON.stringify({ schemaVersion: 1, ...draft(w.avatar.id, "montage-0000001") }));

    const slowSave = r.service.save({ montageId: "montage-0000001", spec: defaultSpec(w.avatar.id, [], 1), name: "slow" });
    try {
      await slowIsHeld;
      let waitedFor: ReturnType<typeof setTimeout> | undefined;
      const tooLong = new Promise<never>((_resolve, reject) => {
        waitedFor = setTimeout(() => reject(new Error("the save of another draft did not finish while the first was held: saves of different drafts wait for each other")), 10_000);
      });
      try {
        await Promise.race([r.service.save({ montageId: "montage-0000002", spec: defaultSpec(w.avatar.id, [], 1), name: "fast" }), tooLong]);
      } finally {
        clearTimeout(waitedFor);
      }
    } finally {
      release();
      await slowSave;
    }
    const stored = await r.store.read(w.library, w.avatar.id, "montage-0000002");
    expect(stored.kind === "ok" ? stored.montage.name : null).toBe("fast");
  });
});

describe("montages.delete", () => {
  test("removes the draft, announces its removal with its avatar, and answers its id", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID));

    const answer = await r.service.delete(ID);

    expect(answer).toEqual({ montageId: ID });
    expect(await filesOf(w)).toEqual([]);
    expect(r.stamped().map((e): [string, unknown] => [e.type, e.payload])).toEqual([["montage.changed", { change: "removed", montageId: ID, avatarId: w.avatar.id }]]);
  });

  test("a draft that does not exist, or is already deleted, is NOT_FOUND and announces nothing", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID));
    await r.service.delete(ID);
    r.events.length = 0;

    expect((await failureOf(r.service.delete(ID))).code).toBe("NOT_FOUND");
    expect((await failureOf(r.service.delete("montage-0000009"))).code).toBe("NOT_FOUND");
    expect(r.events).toEqual([]);
  });

  test("a damaged draft can still be deleted: the owner can always clear it", async () => {
    const w = world();
    const r = montageRig(w);
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    await writeFile(w.library.montageFilePath(w.avatar.id, ID), "{ torn");

    expect(await r.service.delete(ID)).toEqual({ montageId: ID });
    expect(await filesOf(w)).toEqual([]);
    expect(r.stamped().map((e) => e.payload)).toEqual([{ change: "removed", montageId: ID, avatarId: w.avatar.id }]);
  });

  test("the store remembers the draft as removed, for a render that is still holding its id", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID));

    await r.service.delete(ID);

    expect(r.store.wasRemoved(ID)).toBe(true);
  });

  test("two deletes at once: one removes it, the other finds it gone", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, ID));

    const outcomes = await Promise.allSettled([r.service.delete(ID), r.service.delete(ID)]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.flatMap((o) => (o.status === "rejected" && o.reason instanceof EngineFailure ? [o.reason.error.code] : []));
    expect(rejected).toEqual(["NOT_FOUND"]);
    expect(r.events).toHaveLength(1);
  });

  test("the videos rendered from the draft stay: their records are the owner's videos, not the draft's", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, ID, [a]));
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]), { montageId: ID });
    await w.library.reloadVideoRecords(w.avatar.id);

    await r.service.delete(ID);

    expect(w.library.videoCount(w.avatar.id)).toBe(1);
  });

  perfTest("a disk that will not delete is INTERNAL by code alone, and nothing is announced", async () => {
    const w = world();
    const r = montageRig(w);
    // a folder named like the draft, with something in it: a plain unlink cannot remove it
    const asFolder = w.library.montageFilePath(w.avatar.id, ID);
    await mkdir(join(asFolder, "inside"), { recursive: true });

    const started = performance.now();

    const error = await failureOf(r.service.delete(ID));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").toMatch(/not a file/);
    expect(error.detail ?? "").not.toContain(w.libraryRoot);
    // No lock-retry on a folder: on Windows a retried unlink spends 1575 ms (unlinkRetry.ts's delays), so the blocking bound is 1 s; the perf run holds 500 ms.
    assertBudget(performance.now() - started, 500, "deleting a draft that is a folder", { blockingMs: 1_000 });
    expect(r.events).toEqual([]);
  });

  test("with no library open it says so", async () => {
    const w = world();
    const r = montageRig(w, { library: null });

    expect((await failureOf(r.service.delete(ID))).code).toBe("LIBRARY_UNAVAILABLE");
  });
});

describe("montages.save racing montages.delete", () => {
  test("a save asked before a delete is applied, then the delete removes it", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    const r = montageRig(w, { store: { beforeRename: () => sleep(30) } });
    await r.store.write(w.library, stored);

    const [saved, deleted] = await Promise.all([r.service.save({ montageId: ID, spec: withSeed(stored, 5), name: "late" }), r.service.delete(ID)]);

    expect(saved.montage.name).toBe("late");
    expect(deleted).toEqual({ montageId: ID });
    expect(await filesOf(w)).toEqual([]);
    expect(r.stamped().map((e) => (e.type === "montage.changed" ? e.payload.change : e.type))).toEqual(["upserted", "removed"]);
  });

  test("a save asked after a delete is NOT_FOUND and never brings the draft back", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    const r = montageRig(w);
    await r.store.write(w.library, stored);

    const outcomes = await Promise.allSettled([r.service.delete(ID), r.service.save({ montageId: ID, spec: withSeed(stored, 5), name: "ghost" }), r.service.save({ montageId: ID, spec: withSeed(stored, 6), name: "ghost 2" })]);

    expect(outcomes[0]?.status).toBe("fulfilled");
    const refusals = outcomes.slice(1).map((o) => (o.status === "rejected" && o.reason instanceof EngineFailure ? o.reason.error.code : "not refused"));
    expect(refusals).toEqual(["NOT_FOUND", "NOT_FOUND"]);
    expect(await filesOf(w)).toEqual([]);
    expect(r.stamped().map((e) => (e.type === "montage.changed" ? e.payload.change : e.type))).toEqual(["removed"]);
  });

  test("a delete between two saves leaves the draft gone: the second save does not resurrect it", async () => {
    const w = world();
    const stored = draft(w.avatar.id, ID);
    const r = montageRig(w, { store: { beforeRename: () => sleep(15) } });
    await r.store.write(w.library, stored);

    const outcomes = await Promise.allSettled([r.service.save({ montageId: ID, spec: withSeed(stored, 1), name: "one" }), r.service.delete(ID), r.service.save({ montageId: ID, spec: withSeed(stored, 2), name: "two" })]);

    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect(await filesOf(w)).toEqual([]);
  });
});
