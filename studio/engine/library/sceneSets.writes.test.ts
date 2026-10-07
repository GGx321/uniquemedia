import { describe, expect, test } from "bun:test";
import { SceneSetFile, type StoredSceneSet } from "./sceneSets";
import { ideaRecord, ownScene, rewriteRecord, sampleSet, writeIdsOf } from "./testing/sceneSetSample";
import { plan } from "../scenes";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: what a set's file may hold for the review-time writes: own scenes (written from an idea) and the records of rewrite and idea writes, each with the
// ids it may ever use and the draw it made, written BEFORE its first call. Anything the file holds the engine can rely on without looking again.

const stamp = { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z" };

/** A valid set of four planned scenes, with these extras and `writes` counting the writes the records stand for. */
function setWith(extra: Record<string, unknown> = {}, writes = 3): Record<string, unknown> {
  return { ...stamp, ...sampleSet({ count: 4, written: 4 }), writes, ...extra };
}
const parses = (value: unknown) => SceneSetFile.safeParse(value).success;

function redrawnSlot(sceneId: number): unknown {
  const slot = plan({ seed: 11, count: 4, categories: ["travel"] }).slots[sceneId - 1];
  return { ...slot, slotIndex: sceneId, attemptIdBase: `slot-${sceneId}`, category: "home" };
}

describe("own scenes", () => {
  test("a set holds an own scene next to its planned ones", () => {
    expect(parses(setWith({ scenes: [...(sampleSet({ count: 4, written: 4 }).scenes), ownScene(5)] }))).toBe(true);
  });

  test("an own scene has an idea and a text, and no place", () => {
    const base = sampleSet({ count: 4, written: 4 }).scenes;
    expect(parses(setWith({ scenes: [...base, ownScene(5, { idea: "" })] }))).toBe(false);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { text: null })] }))).toBe(false);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { slot: base[0] })] }))).toBe(false);
  });

  test("an own selfie or mirror scene faces the camera: profile and back are refused", () => {
    const base = sampleSet({ count: 4, written: 4 }).scenes;
    expect(parses(setWith({ scenes: [...base, ownScene(5, { shot: "selfie", pose: "three-quarter" })] }))).toBe(true);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { shot: "mirror", pose: "profile" })] }))).toBe(false);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { shot: "selfie", pose: "back" })] }))).toBe(false);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { shot: "friend", pose: "back" })] }))).toBe(true);
  });

  test("an own scene's idea is held to the weight the writer's price allows", () => {
    const base = sampleSet({ count: 4, written: 4 }).scenes;
    expect(parses(setWith({ scenes: [...base, ownScene(5, { idea: "中".repeat(500) })] }))).toBe(true);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { idea: "\u0001".repeat(500) })] }))).toBe(false);
    expect(parses(setWith({ scenes: [...base, ownScene(5, { idea: "я".repeat(501) })] }))).toBe(false);
  });

  test("a sentence of any length is stored (SceneText has no upper bound)", () => {
    const base = sampleSet({ count: 4, written: 4 }).scenes;
    expect(parses(setWith({ scenes: [...base, ownScene(5, { text: "x".repeat(5_000) })] }))).toBe(true);
  });

  test("a scene id never repeats across planned and own scenes", () => {
    const base = sampleSet({ count: 4, written: 4 }).scenes;
    expect(parses(setWith({ scenes: [...base, ownScene(4)] }))).toBe(false);
  });

  test("a planned scene's slot is still numbered like the scene, an own scene needs no slot number", () => {
    const base = sampleSet({ count: 4, written: 4 }).scenes;
    const moved = base.map((s, i) => (i === 0 && s.origin === "planned" ? { ...s, slot: { ...s.slot, slotIndex: 9 } } : s));
    expect(parses(setWith({ scenes: [...moved, ownScene(5)] }))).toBe(false);
  });
});

describe("the records of review writes", () => {
  test("a set holds an unresolved rewrite and an unresolved idea write, each under its own write number", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord(), ideaRecord()] }))).toBe(true);
  });

  test("a set written before CS.4b has none and parses unchanged", () => {
    expect(parses(setWith())).toBe(true);
  });

  test("a rewrite with a redraw holds one new slot per scene, and one without holds none", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ redraw: true, slots: [redrawnSlot(2)] })] }))).toBe(true);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ redraw: true, slots: [] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ redraw: false, slots: [redrawnSlot(2)] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ redraw: true, sceneIds: [2, 3], slots: [redrawnSlot(2)] })] }))).toBe(false);
  });

  test("a redrawn slot is the very scene it redraws", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ redraw: true, sceneIds: [2], slots: [redrawnSlot(3)] })] }))).toBe(false);
  });

  test("a rewrite names one to five scenes of the set, and a scene once", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ sceneIds: [1, 2, 3, 4] })] }))).toBe(true);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ sceneIds: [] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ sceneIds: [2, 2] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ sceneIds: [9] })] }))).toBe(false);
  });

  test("an idea write reserves one scene id per scene it will add, and says what it was asked", () => {
    expect(parses(setWith({ reviewWrites: [ideaRecord({ count: 3, scenes: [5, 6, 7].map((sceneId) => ({ sceneId, shot: "friend", pose: "front" })) })] }))).toBe(true);
    expect(parses(setWith({ reviewWrites: [ideaRecord({ count: 3 })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [ideaRecord({ idea: "" })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [ideaRecord({ shot: "drone" })] }))).toBe(false);
  });

  test("an idea write's drawn own scenes obey the phone rule too", () => {
    const scenes = [{ sceneId: 5, shot: "mirror", pose: "profile" }];
    expect(parses(setWith({ reviewWrites: [ideaRecord({ count: 1, scenes })] }))).toBe(false);
  });

  test("an unresolved idea write's reserved ids are not the ids of scenes the set already has", () => {
    expect(parses(setWith({ reviewWrites: [ideaRecord({ firstId: 4 })] }))).toBe(false);
  });

  test("two idea writes never reserve the same scene id", () => {
    expect(parses(setWith({ reviewWrites: [ideaRecord({ k: 2 }), ideaRecord({ k: 3, firstId: 6 })] }, 3))).toBe(false);
    expect(parses(setWith({ reviewWrites: [ideaRecord({ k: 2 }), ideaRecord({ k: 3, firstId: 7 })] }, 3))).toBe(true);
  });

  test("a resolved idea write keeps its ids: they are the ids of the scenes it added", () => {
    const added = [ownScene(5), ownScene(6)];
    expect(parses(setWith({ scenes: [...sampleSet({ count: 4, written: 4 }).scenes, ...added], reviewWrites: [ideaRecord({ closed: true })] }))).toBe(true);
  });

  test("write numbers are never above the writes started and never repeat, among the records and the compose or «Дописать» record", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ k: 4 })] }, 3))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ k: 2 }), ideaRecord({ k: 2, firstId: 5 })] }, 3))).toBe(false);
    expect(parses(setWith({ write: { k: 2, kind: "unwritten", jobId: "job-aaaa-0001" }, reviewWrites: [rewriteRecord({ k: 2 })] }, 3))).toBe(false);
    expect(parses(setWith({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001" }, reviewWrites: [rewriteRecord({ k: 2 })] }, 3))).toBe(true);
  });

  test("a write's ids are exactly its own `${set}:write-${k}#n`: one to four, none another write's, none a chunk's", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: writeIdsOf("set-aaaa-0001", 2).slice(0, 2) })] }))).toBe(true);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: [] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: [...writeIdsOf("set-aaaa-0001", 2), "set-aaaa-0001:write-2#5"] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: writeIdsOf("set-aaaa-0001", 3) })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: ["set-aaaa-0001:writer-1#1"] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: ["another-set:write-2#1"] })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ attemptIds: ["set-aaaa-0001:write-2#1", "set-aaaa-0001:write-2#1"] })] }))).toBe(false);
  });

  test("why a write stopped is kept with it, and the error only for a failure", () => {
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ stoppedBy: "network" })] }))).toBe(true);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ stoppedBy: "failed", stoppedError: { code: "INTERNAL" } })] }))).toBe(true);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ stoppedBy: "failed" })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ stoppedBy: "network", stoppedError: { code: "INTERNAL" } })] }))).toBe(false);
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ stoppedBy: "closed" })] }))).toBe(false);
  });

  test("the category snapshots a redraw refreshes are of categories the set already has", () => {
    const fresh = { ref: "cat-paris-cafes", name: "Paris", label: "Paris cafes", style: "phone" };
    expect(parses(setWith({ reviewWrites: [rewriteRecord({ snapshots: [fresh] })] }))).toBe(false);
    const custom = sampleSet({ count: 4, written: 4, categories: ["home"] });
    const withCategory: Record<string, unknown> = {
      ...setWith({ categories: [fresh], request: { ...custom.request, categories: ["home", "cat-paris-cafes"] } }),
    };
    expect(parses({ ...withCategory, reviewWrites: [rewriteRecord({ snapshots: [{ ...fresh, label: "Parisian cafes" }] })] })).toBe(true);
  });

  test("a set holds at most 500 writes' records, so no set grows without end", () => {
    const many = Array.from({ length: 501 }, (_, i) => rewriteRecord({ k: i + 2, closed: true, attemptIds: writeIdsOf("set-aaaa-0001", i + 2) }));
    expect(parses(setWith({ reviewWrites: many.slice(0, 500) }, 501))).toBe(true);
    expect(parses(setWith({ reviewWrites: many }, 502))).toBe(false);
  });
});

describe("the type of a stored set", () => {
  test("is still the one SceneSetFile parses", () => {
    const parsed: StoredSceneSet = SceneSetFile.parse(setWith({ reviewWrites: [rewriteRecord()] }));
    expect(parsed.reviewWrites?.length).toBe(1);
  });
});
