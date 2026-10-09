import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { Behaviour } from "../face/testing/behaviour";
import { EMBEDDING_LENGTH } from "../face/worker/protocol";
import { createWorkerFaceGate, type WorkerFaceGate } from "../face/worker/workerGate";
import { openLibrary } from "../library/library";
import { JPEG_HEADER_ONLY, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { createFocusResolver, type FocusLibrary } from "./focusResolver";
useNativeGlobals();

// S4.P3: the resolver in front of the REAL face lane (workerGate.ts) with a scripted worker (no models). Pins that a burst of
// placements (montages.create asks for up to 20 photos at once) is never turned away by the lane's cap on waiting detects, and
// that a manual placement is admitted before prefetches.

const SCRIPT = fileURLToPath(new URL("../face/testing/scriptedFaceWorker.ts", import.meta.url));
const root = useTempDir("studio-focus-lane-");
const MASTER = new Float32Array(EMBEDDING_LENGTH);
MASTER[0] = 1;
const gates: WorkerFaceGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

async function rig(photoCount: number) {
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
  const resolver = createFocusResolver({ library, faceGate: gate });
  return { resolver, avatarId: avatar.id, ids, gate };
}

describe("the resolver in front of the real face lane", () => {
  test("eight concurrent focusFor calls are all judged (a placement burst is never refused by the lane's cap)", async () => {
    const { resolver, avatarId, ids } = await rig(8);
    const results = await Promise.all(ids.map((id) => resolver.focusFor(avatarId, id)));
    await resolver.flush();
    expect(results.filter((r) => r.resolved)).toHaveLength(8);
  });

  test("eight concurrent focusFor calls are all judged while a run's check holds the lane (owner montages during a paid run)", async () => {
    const { resolver, avatarId, ids, gate } = await rig(8);
    const checking = gate.check({ pose: "front", bytes: Uint8Array.of(Behaviour.slow), masterEmbedding: MASTER }, new AbortController().signal);
    const results = await Promise.all(ids.map((id) => resolver.focusFor(avatarId, id)));
    await checking;
    await resolver.flush();
    expect(results.filter((r) => r.resolved)).toHaveLength(8);
  });

  test("twenty concurrent prefetches are all judged", async () => {
    const { resolver, avatarId, ids } = await rig(20);
    const results = await Promise.all(ids.map((id) => resolver.prefetchFocus(avatarId, id, { timeoutMs: 20_000 })));
    await resolver.flush();
    expect(results.filter((r) => r.resolved)).toHaveLength(20);
  });

  test("a manual focusFor that arrives behind queued prefetches is judged before the prefetches that were still waiting", async () => {
    const { resolver, avatarId, ids } = await rig(10);
    const done: string[] = [];
    const prefetches = ids.slice(0, 9).map((id, n) => resolver.prefetchFocus(avatarId, id, { timeoutMs: 20_000 }).then((r) => done.push(`p${n}:${r.resolved}`)));
    const manual = resolver.focusFor(avatarId, ids[9] ?? "").then((r) => done.push(`manual:${r.resolved}`));
    await Promise.all([...prefetches, manual]);
    await resolver.flush();
    expect(done).toContain("manual:true");
    // Two prefetches were already at the gate; the other six were queued in the resolver and the manual placement went before them.
    expect(done.indexOf("manual:true")).toBeLessThan(done.indexOf("p2:true"));
    expect(done.filter((entry) => entry.endsWith(":false"))).toEqual([]);
  });
});
