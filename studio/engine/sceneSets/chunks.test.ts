import { describe, expect, test } from "bun:test";
import type { PlannedSceneRecord, SceneRecord, StoredSceneSet } from "../library/sceneSets";
import { sceneSetOnTheBanks } from "../library/testing/bankScenes";
import { sampleSet } from "../library/testing/sceneSetSample";
import { chunkState, pendingChunks, requestSceneIds } from "./chunks";
import { fakeLedger } from "./testing/fakeLedger";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: what a writer chunk may still do. THE ATTEMPT INVARIANT: answered attempts per chunk are at most 2 across ALL jobs of the set, an open
// reserve and a reconcile's estimated settle count as answered (runs/journal.ts's attemptPaid), and a chunk is never given a fresh pair.

const SET = "set-aaaa-0001";
const id = (chunk: number, n: number) => `${SET}:writer-${chunk}#${n}`;

/** 35 scenes: chunk 1 holds 25 of them, chunk 2 the other 10. */
function stored(over: Partial<StoredSceneSet> = {}): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count: 35 }), ...over };
}

function withScenes(set: StoredSceneSet, change: (sceneId: number) => Partial<PlannedSceneRecord>): StoredSceneSet {
  return { ...set, scenes: set.scenes.map((s) => ({ ...s, ...change(s.sceneId) }) as SceneRecord) };
}

const chunkOf = (set: StoredSceneSet, n: number) => {
  const chunk = set.chunks.find((c) => c.chunk === n);
  if (chunk === undefined) throw new Error(`no chunk ${n}`);
  return chunk;
};

describe("chunkState: attempts left", () => {
  test("a chunk nothing was sent for has both its attempts and every id", () => {
    const set = stored();
    expect(chunkState(set, chunkOf(set, 1), fakeLedger({}))).toMatchObject({ answered: 0, unused: 4, attemptsLeft: 2, gaveUpBy: null });
  });

  test("a settled paid answer is one attempt used", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 1, unused: 3, attemptsLeft: 1 });
  });

  test("an open reserve counts as answered: an interrupted request may have been billed", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: {} });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 1, attemptsLeft: 1 });
  });

  test("a reconcile's estimated settle counts as answered", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 0, estimated: true } } });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 1, attemptsLeft: 1 });
  });

  test("a final 429 or 5xx settles at nothing and is not an attempt used, though its id is spent", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 0 } } });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 0, unused: 3, attemptsLeft: 2 });
  });

  test("a request released before it left is not an attempt used", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "release" } } });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 0, attemptsLeft: 2 });
  });

  test("two answered attempts leave none, and the chunk is out of attempts while a scene still lacks its sentence", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 11_000 } }, [id(1, 2)]: {} });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 2, attemptsLeft: 0, gaveUpBy: "no-attempts" });
  });

  test("a chunk whose scenes all have their sentences is not given up for having used its attempts", () => {
    const set = withScenes(stored(), () => ({ text: "A sentence." }));
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 11_000 } }, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ attemptsLeft: 0, gaveUpBy: null });
  });

  test("the ids left bound the attempts left: three free failures and one id remain", () => {
    const set = stored();
    const free = { close: { type: "settle", costMicros: 0 } } as const;
    const ledger = fakeLedger({ [id(1, 1)]: free, [id(1, 2)]: free, [id(1, 3)]: free });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 0, unused: 1, attemptsLeft: 1 });
  });

  test("a chunk with every id spent and no answer is out of attempts: no-attempts, never a fresh pair", () => {
    const set = stored();
    const free = { close: { type: "settle", costMicros: 0 } } as const;
    const ledger = fakeLedger({ [id(1, 1)]: free, [id(1, 2)]: free, [id(1, 3)]: free, [id(1, 4)]: free });
    expect(chunkState(set, chunkOf(set, 1), ledger)).toMatchObject({ answered: 0, unused: 0, attemptsLeft: 0, gaveUpBy: "no-attempts" });
  });

  test("a chunk a job gave up on stays given up, with the reason it was given, and has no attempts left", () => {
    const set = stored({ chunks: stored().chunks.map((c) => (c.chunk === 1 ? { ...c, gaveUp: "refused" as const } : c)) });
    expect(chunkState(set, chunkOf(set, 1), fakeLedger({}))).toMatchObject({ answered: 0, attemptsLeft: 0, gaveUpBy: "refused" });
  });

  test("with no ledger to read, every chunk looks untouched", () => {
    const set = stored();
    expect(chunkState(set, chunkOf(set, 2), null)).toMatchObject({ answered: 0, unused: 4, attemptsLeft: 2 });
  });
});

describe("requestSceneIds", () => {
  test("is the scenes of the chunk that are not removed and have no sentence", () => {
    const set = withScenes(stored(), (n) => (n === 1 ? { text: "Typed by the owner." } : n === 2 ? { removed: true } : {}));
    const ids = requestSceneIds(set, chunkOf(set, 1));
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).toHaveLength(23);
    expect(ids[0]).toBe(3);
  });

  test("a chunk whose scenes are all written or removed asks for nothing", () => {
    const set = withScenes(stored(), (n) => (n <= 25 ? (n % 2 === 0 ? { text: "A sentence." } : { removed: true }) : {}));
    expect(requestSceneIds(set, chunkOf(set, 1))).toEqual([]);
  });
});

describe("pendingChunks", () => {
  test("a fresh set has every chunk pending, in order", () => {
    const set = stored();
    expect(pendingChunks(set, fakeLedger({})).map((p) => p.chunk.chunk)).toEqual([1, 2]);
  });

  test("a chunk with every scene written is not pending", () => {
    const set = withScenes(stored(), (n) => (n <= 25 ? { text: "A sentence." } : {}));
    expect(pendingChunks(set, fakeLedger({})).map((p) => p.chunk.chunk)).toEqual([2]);
  });

  test("removed scenes are never sent: a chunk with only removed scenes left is not pending", () => {
    const set = withScenes(stored(), (n) => (n > 25 ? { removed: true } : {}));
    expect(pendingChunks(set, fakeLedger({})).map((p) => p.chunk.chunk)).toEqual([1]);
  });

  test("a chunk out of attempts is skipped and the next one still pends", () => {
    const set = stored();
    const ledger = fakeLedger({ [id(1, 1)]: {}, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(pendingChunks(set, ledger).map((p) => p.chunk.chunk)).toEqual([2]);
  });

  test("a chunk a job gave up on is skipped and the next one still pends", () => {
    const set = stored({ chunks: stored().chunks.map((c) => (c.chunk === 1 ? { ...c, gaveUp: "rejected" as const } : c)) });
    expect(pendingChunks(set, fakeLedger({})).map((p) => p.chunk.chunk)).toEqual([2]);
  });

  test("a pending chunk carries the scenes its request covers and its state", () => {
    const set = withScenes(stored(), (n) => (n === 26 ? { text: "Typed." } : {}));
    const second = pendingChunks(set, fakeLedger({})).find((p) => p.chunk.chunk === 2);
    expect(second?.sceneIds).toEqual([27, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(second?.state.attemptsLeft).toBe(2);
  });
});

// 5a.2 (S5.6c1, plan s5a2 r1.5 §5.5): a chunk whose every scene the code template can write is offered again, whatever its attempts and verdict, and it
// is free; a chunk counts for money only when it holds a scene the template cannot write.
describe("pendingChunks: the code template", () => {
  const onBanks = (set: StoredSceneSet, from: number, to: number): StoredSceneSet => sceneSetOnTheBanks(set, Array.from({ length: to - from + 1 }, (_, i) => from + i));
  const gaveUp = (set: StoredSceneSet, chunk: number): StoredSceneSet => ({ ...set, chunks: set.chunks.map((c) => (c.chunk === chunk ? { ...c, gaveUp: "rejected" as const } : c)) });

  test("a chunk given up on whose scenes the banks now render is offered again, free", () => {
    const set = gaveUp(onBanks(stored(), 1, 25), 1);
    const first = pendingChunks(set, fakeLedger({})).find((p) => p.chunk.chunk === 1);
    expect(first).toMatchObject({ free: true, sceneIds: Array.from({ length: 25 }, (_, i) => i + 1) });
  });

  test("a chunk out of attempts whose scenes the banks render is offered again", () => {
    const set = onBanks(stored(), 1, 25);
    const ledger = fakeLedger({ [id(1, 1)]: {}, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(pendingChunks(set, ledger).map((p) => [p.chunk.chunk, p.free])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  test("a chunk given up on with one scene the banks cannot name stays given up", () => {
    const set = gaveUp(onBanks(stored(), 1, 24), 1);
    expect(pendingChunks(set, fakeLedger({})).map((p) => p.chunk.chunk)).toEqual([2]);
  });

  test("a chunk with a scene the banks cannot name is not free, even with attempts left", () => {
    const set = onBanks(stored(), 1, 24);
    expect(pendingChunks(set, fakeLedger({})).map((p) => [p.chunk.chunk, p.free])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  test("a scene that already has its sentence is not asked about: the rest of the chunk may be free", () => {
    const set = withScenes(onBanks(stored(), 2, 25), (n) => (n === 1 ? { text: "Typed." } : {}));
    expect(pendingChunks(set, fakeLedger({})).find((p) => p.chunk.chunk === 1)?.free).toBe(true);
  });

  test("a chunk of old-pool scenes is never free", () => {
    expect(pendingChunks(stored(), fakeLedger({})).map((p) => p.free)).toEqual([false, false]);
  });
});
