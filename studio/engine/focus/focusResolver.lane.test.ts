import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { Behaviour } from "../face/testing/behaviour";
import { EMBEDDING_LENGTH } from "../face/worker/protocol";
import { createWorkerFaceGate, type WorkerFaceGate } from "../face/worker/workerGate";
import { openLibrary } from "../library/library";
import { JPEG_HEADER_ONLY, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { until } from "../testing/engineHarness";
import { within } from "../testing/within";
import type { FocusCacheEntry } from "./focusCache";
import { createFocusResolver, type FocusCacheStore, type FocusFaceGate, type FocusLibrary } from "./focusResolver";
useNativeGlobals();

// S4.P3: the resolver in front of the REAL face lane (workerGate.ts) with a scripted worker (no models). Pins that a burst of
// placements (montages.create asks for up to 20 photos at once) is never turned away by the lane's cap on waiting detects, and
// that a manual placement is admitted before prefetches.
//
// Nothing here may depend on how fast the runner is. The resolver reads its cache file before it asks for a place at the gate, so with the real cache the moment a call reaches the gate is
// a disk's, and a slow disk lets a queued prefetch be admitted before a later call arrives. The tests therefore use a cache that answers at once (microtasks only), and the ordering test
// steers every step itself: the cache reads are released by the test and the face worker is held until the test has seen who is queued.

const SCRIPT = fileURLToPath(new URL("../face/testing/scriptedFaceWorker.ts", import.meta.url));
const root = useTempDir("studio-focus-lane-");
const MASTER = new Float32Array(EMBEDDING_LENGTH);
MASTER[0] = 1;
const gates: WorkerFaceGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

/** The bound on every await of a promise the resolver or the lane owns: a stuck placement fails here, with its label, instead of hanging the shard. */
const BOUND_MS = 20_000;

/** Lets every chain of already-settled promises run to its end: a macrotask only starts once the microtask queue is empty. */
const quiet = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A cache that has nothing and answers at once: no disk, so a call reaches the admission queue after microtasks only. */
const emptyCache: FocusCacheStore = { read: async () => new Map(), remember: async () => undefined };

async function rig(photoCount: number, wrap: (gate: FocusFaceGate) => FocusFaceGate = (gate) => gate, cache: FocusCacheStore = emptyCache) {
  const probe = new SharedArrayBuffer(8);
  const gate = createWorkerFaceGate({ spawnWorker: () => new Worker(SCRIPT, { workerData: { startup: "ok", probe } }) });
  gates.push(gate);
  await gate.start();
  const { library: real } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await real.createAvatar(SAMPLE_AVATAR);
  const ids: string[] = [];
  for (let i = 0; i < photoCount; i++) {
    ids.push((await real.addPhoto(avatar.id, Uint8Array.from([...JPEG_HEADER_ONLY, i]), samplePhotoMeta({ mediaType: "image/jpeg", width: 100, height: 200 }))).id);
  }
  // The scripted worker is steered by the first byte: every photo's bytes are "answer after ~80 ms".
  const library: FocusLibrary = {
    getPhoto: (id) => real.getPhoto(id),
    photosByAvatar: (id) => real.photosByAvatar(id),
    focusCachePath: (id) => real.focusCachePath(id),
    readPhotoVerified: async () => Uint8Array.of(Behaviour.slow),
  };
  const resolver = createFocusResolver({ library, faceGate: wrap(gate), cache });
  return { resolver, avatarId: avatar.id, ids, gate };
}

describe("the resolver in front of the real face lane", () => {
  test("eight concurrent focusFor calls are all judged (a placement burst is never refused by the lane's cap)", async () => {
    const { resolver, avatarId, ids } = await rig(8);
    const results = await within(Promise.all(ids.map((id) => resolver.focusFor(avatarId, id))), BOUND_MS, "eight focusFor calls");
    await resolver.flush();
    expect(results.filter((r) => r.resolved)).toHaveLength(8);
  });

  test("eight concurrent focusFor calls are all judged while a run's check holds the lane (owner montages during a paid run)", async () => {
    const { resolver, avatarId, ids, gate } = await rig(8);
    const checking = gate.check({ pose: "front", bytes: Uint8Array.of(Behaviour.slow), masterEmbedding: MASTER }, new AbortController().signal);
    const results = await within(Promise.all(ids.map((id) => resolver.focusFor(avatarId, id))), BOUND_MS, "eight focusFor calls behind a run's check");
    await within(checking, BOUND_MS, "the run's check");
    await resolver.flush();
    expect(results.filter((r) => r.resolved)).toHaveLength(8);
  });

  test("twenty concurrent prefetches are all judged", async () => {
    const { resolver, avatarId, ids } = await rig(20);
    const results = await within(Promise.all(ids.map((id) => resolver.prefetchFocus(avatarId, id, { timeoutMs: 20_000 }))), BOUND_MS, "twenty prefetches");
    await resolver.flush();
    expect(results.filter((r) => r.resolved)).toHaveLength(20);
  });

  test("a manual focusFor that arrives behind queued prefetches is judged before the prefetches that were still waiting", async () => {
    // The face worker is held: no detect reaches it (so none completes) until the test has seen the prefetches queued and has made the manual call.
    const hold = deferred<void>();
    const atGate: string[] = [];
    const held = (gate: FocusFaceGate): FocusFaceGate => ({
      isBroken: () => gate.isBroken(),
      detect: async (bytes, signal) => {
        atGate.push("detect");
        await hold.promise;
        return gate.detect(bytes, signal);
      },
    });
    // The cache reads are released by the test too, a batch at a time.
    const reads: Array<() => void> = [];
    const cache: FocusCacheStore = {
      read: () => {
        const answer = deferred<ReadonlyMap<string, FocusCacheEntry>>();
        reads.push(() => answer.resolve(new Map<string, FocusCacheEntry>()));
        return answer.promise;
      },
      remember: async () => undefined,
    };
    const { resolver, avatarId, ids } = await rig(10, held, cache);
    const done: string[] = [];

    const prefetches = ids.slice(0, 9).map((id, n) => resolver.prefetchFocus(avatarId, id, { timeoutMs: 20_000 }).then((r) => done.push(`p${n}:${r.resolved}`)));
    expect(reads).toHaveLength(9);
    for (const release of reads.splice(0)) release();
    // Two prefetches are at the gate (held there); the other seven wait in the resolver's queue.
    await within(until(() => atGate.length === 2, "two detects at the gate"), BOUND_MS, "two prefetches to reach the gate");
    await quiet();
    expect(atGate).toHaveLength(2);
    expect(done).toEqual([]);

    // The manual call arrives now, behind the seven that are waiting.
    const manual = resolver.focusFor(avatarId, ids[9] ?? "").then((r) => done.push(`manual:${r.resolved}`));
    expect(reads).toHaveLength(1);
    for (const release of reads.splice(0)) release();
    await quiet();
    expect(atGate).toHaveLength(2);
    expect(done).toEqual([]);

    hold.resolve();
    await within(Promise.all([...prefetches, manual]), BOUND_MS, "every placement to be judged");
    await resolver.flush();
    expect(done).toContain("manual:true");
    // The manual placement went before every prefetch that was still waiting in the resolver (p2 to p8); p0 and p1 were already at the gate.
    const manualAt = done.indexOf("manual:true");
    for (let n = 2; n <= 8; n++) expect(manualAt).toBeLessThan(done.indexOf(`p${n}:true`));
    expect(done.filter((entry) => entry.endsWith(":false"))).toEqual([]);
  });
});
