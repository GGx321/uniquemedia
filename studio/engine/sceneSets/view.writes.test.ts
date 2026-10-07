import { describe, expect, test } from "bun:test";
import { SceneSetView } from "../../shared/engine";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { ideaRecord, ownScene, rewriteRecord, sampleSet, writeIdsOf } from "../library/testing/sceneSetSample";
import { fakeLedger, WRITER_ATTEMPT_WORST } from "./testing/fakeLedger";
import { buildSceneSetView, currentTally, type ViewContext } from "./view";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: what the window is shown of a set after review-time writes. Own scenes read as own (an idea, no place); a rewrite that did not finish marks ITS
// scenes, never the set (the set stays ready), an idea write that did not finish is listed on the set, markers are per scene and survive other writes, and
// every attempt of every write is in the spend.

const SET = "set-aaaa-0001";
const id = (k: number, n: number) => `${SET}:write-${k}#${n}`;

function stored(extra: Record<string, unknown> = {}, count = 4): StoredSceneSet {
  return { schemaVersion: 1, revision: 4, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:30:00.000Z", ...sampleSet({ count, written: count }), writes: 3, ...extra } as StoredSceneSet;
}
const rewrite = (over: Record<string, unknown> = {}) => rewriteRecord(over) as unknown as ReviewWriteRecord;
const idea = (over: Record<string, unknown> = {}) => ideaRecord(over) as unknown as ReviewWriteRecord;

function context(over: Partial<ViewContext> = {}): ViewContext {
  return { ledger: fakeLedger({}), inFlight: new Set(), live: null, used: false, ...over };
}
function viewOf(set: StoredSceneSet, over: Partial<ViewContext> = {}): SceneSetView {
  const view = buildSceneSetView(set, context(over));
  expect(SceneSetView.safeParse(view).success).toBe(true);
  return view;
}
const withOwn = (set: StoredSceneSet, ...scenes: Record<string, unknown>[]): StoredSceneSet => ({ ...set, scenes: [...set.scenes, ...scenes] }) as StoredSceneSet;

describe("own scenes", () => {
  test("read as own: category «own», their idea, no place, no chunk, written", () => {
    const view = viewOf(withOwn(stored(), ownScene(5, { idea: "кофе на балконе утром", shot: "selfie", pose: "three-quarter" })));
    expect(view.scenes[4]).toEqual({
      sceneId: 5,
      origin: "own",
      category: "own",
      categoryName: null,
      shot: "selfie",
      pose: "three-quarter",
      place: null,
      idea: "кофе на балконе утром",
      text: "She sips coffee on a balcony (5).",
      edited: false,
      removed: false,
      unwritten: null,
      gaveUpBy: null,
      chunk: null,
    });
  });

  test("a planned scene still reads planned, with no idea", () => {
    expect(viewOf(withOwn(stored(), ownScene(5))).scenes[0]).toMatchObject({ origin: "planned", idea: null, category: "home" });
  });

  test("a removed own scene is kept, greyed", () => {
    expect(viewOf(withOwn(stored(), ownScene(5, { removed: true }))).scenes[4]).toMatchObject({ removed: true });
  });

  test("the compose counters count the planned scenes only: «Готово 35 из 60» says nothing of own scenes", () => {
    const set = withOwn(stored(), ownScene(5), ownScene(6));
    expect(currentTally(set, fakeLedger({}))).toEqual({ total: 4, written: 4, gaveUp: 0 });
    expect(viewOf(set).lastCompose).toEqual({ total: 4, written: 4, gaveUp: 0 });
  });

  test("a set of own scenes only reads no compose outcome", () => {
    const set = { ...stored({}, 0), scenes: [ownScene(1)], chunks: [] } as unknown as StoredSceneSet;
    expect(viewOf(set).lastCompose).toEqual({ total: 0, written: 0, gaveUp: 0 });
  });
});

describe("the marker of an interrupted rewrite", () => {
  const interrupted = (over: Record<string, unknown> = {}) => stored({ reviewWrites: [rewrite({ k: 2, sceneIds: [2, 3], stoppedBy: "network", ...over })] });
  const SENT = fakeLedger({ [id(2, 1)]: {} });

  test("each target scene says which write was interrupted and why; the others say nothing", () => {
    const view = viewOf(interrupted(), { ledger: SENT });
    expect(view.scenes.map((s) => s.rewriteInterrupted)).toEqual([undefined, { write: 2, stoppedBy: "network" }, { write: 2, stoppedBy: "network" }, undefined]);
  });

  test("the set stays ready: an interrupted rewrite is not a stopped compose", () => {
    expect(viewOf(interrupted(), { ledger: SENT })).toMatchObject({ status: "ready", stoppedBy: null });
  });

  test("with no outcome recorded and no job, it reads closed, as a compose does", () => {
    const view = viewOf(stored({ reviewWrites: [rewrite({ k: 2, sceneIds: [2] })] }), { ledger: SENT });
    expect(view.scenes[1]?.rewriteInterrupted).toEqual({ write: 2, stoppedBy: "closed" });
  });

  test("the scene keeps its old text and place", () => {
    const set = interrupted();
    const view = viewOf(set, { ledger: SENT });
    expect(view.scenes[1]).toMatchObject({ text: set.scenes[1]?.text, place: { location: set.scenes[1]?.origin === "planned" ? set.scenes[1].slot.location : "" } });
  });

  test("a marker stays while another write runs on another scene, and the write that runs is not flagged", () => {
    const set = stored({ writes: 3, reviewWrites: [rewrite({ k: 2, sceneIds: [2], stoppedBy: "network" }), rewrite({ k: 3, sceneIds: [4] })] });
    const view = viewOf(set, { ledger: SENT, live: { kind: "rewrite", count: 1, sceneIds: [4] }, liveK: 3 });
    expect(view).toMatchObject({ status: "writing", write: { kind: "rewrite", count: 1, sceneIds: [4] } });
    expect(view.scenes.map((s) => s.rewriteInterrupted?.write)).toEqual([undefined, 2, undefined, undefined]);
  });

  test("a write with no attempt left is not flagged: nothing could be resumed", () => {
    const ledger = fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 1_000 } }, [id(2, 2)]: {} });
    expect(viewOf(interrupted(), { ledger }).scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
  });

  test("a resolved write leaves no marker", () => {
    expect(viewOf(interrupted({ closed: true }), { ledger: SENT }).scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
  });

  test("a failure carries no error on the scene: the reason is enough", () => {
    const view = viewOf(interrupted({ stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } }), { ledger: SENT });
    expect(view.scenes[1]?.rewriteInterrupted).toEqual({ write: 2, stoppedBy: "failed" });
  });

  test("the view omits the field for a scene with none, as a view built before CS.4b did", () => {
    expect(Object.keys(viewOf(stored()).scenes[0] ?? {})).not.toContain("rewriteInterrupted");
    expect(Object.keys(viewOf(stored())).includes("interruptedIdeas")).toBe(false);
  });
});

describe("the list of interrupted idea writes", () => {
  const SENT = fakeLedger({ [id(3, 1)]: {} });

  test("lists what was asked and why it stopped; the set stays ready and no scene was added", () => {
    const set = stored({ reviewWrites: [idea({ k: 3, idea: "кофе на балконе", count: 2, shot: "friend", stoppedBy: "timeout" })] });
    const view = viewOf(set, { ledger: SENT });
    expect(view.interruptedIdeas).toEqual([{ write: 3, idea: "кофе на балконе", count: 2, shot: "friend", stoppedBy: "timeout" }]);
    expect(view.status).toBe("ready");
    expect(view.scenes).toHaveLength(4);
  });

  test("an idea write that is running is not listed as interrupted", () => {
    const set = stored({ reviewWrites: [idea({ k: 3 })] });
    const view = viewOf(set, { ledger: SENT, live: { kind: "idea", count: 2 }, liveK: 3 });
    expect(view.interruptedIdeas).toBeUndefined();
    expect(view.write).toEqual({ kind: "idea", count: 2 });
  });

  test("a resolved idea write is not listed", () => {
    const set = withOwn(stored({ reviewWrites: [idea({ k: 3, closed: true })] }), ownScene(5), ownScene(6));
    expect(viewOf(set, { ledger: SENT }).interruptedIdeas).toBeUndefined();
  });

  test("several are listed in the order they began", () => {
    const set = stored({ writes: 4, reviewWrites: [idea({ k: 3 }), idea({ k: 4, firstId: 7, idea: "прогулка" })] });
    expect(viewOf(set, { ledger: fakeLedger({ [id(3, 1)]: {}, [id(4, 1)]: {} }) }).interruptedIdeas?.map((i) => i.write)).toEqual([3, 4]);
  });
});

describe("the spend of review writes", () => {
  test("a settled attempt of a write is in the set's spend at what it cost", () => {
    const set = stored({ reviewWrites: [rewrite({ k: 2, closed: true })] });
    const view = viewOf(set, { ledger: fakeLedger({ [id(2, 1)]: { close: { type: "settle", costMicros: 4_100 } } }) });
    expect(view).toMatchObject({ spentMicros: 4_100, openReserveMicros: 0 });
  });

  test("an interrupted write's open reserve is at its worst case, and an open reserve", () => {
    const set = stored({ reviewWrites: [idea({ k: 3 })] });
    expect(viewOf(set, { ledger: fakeLedger({ [id(3, 1)]: {} }) })).toMatchObject({ spentMicros: WRITER_ATTEMPT_WORST, openReserveMicros: WRITER_ATTEMPT_WORST });
  });

  test("the request at the model right now is not in the spend", () => {
    const set = stored({ reviewWrites: [rewrite({ k: 2 })] });
    expect(viewOf(set, { ledger: fakeLedger({ [id(2, 1)]: {} }), inFlight: new Set([id(2, 1)]), live: { kind: "rewrite", count: 1, sceneIds: [2] }, liveK: 2 })).toMatchObject({ spentMicros: 0, openReserveMicros: 0 });
  });

  test("a closed write's spend stays after its scenes are in: the money is not forgotten", () => {
    const set = withOwn(stored({ reviewWrites: [idea({ k: 3, closed: true })] }), ownScene(5), ownScene(6));
    expect(viewOf(set, { ledger: fakeLedger({ [id(3, 1)]: { close: { type: "settle", costMicros: 2_500 } } }) }).spentMicros).toBe(2_500);
  });

  test("compose chunks and writes add up", () => {
    const set = stored({ reviewWrites: [rewrite({ k: 2, closed: true })] });
    const ledger = fakeLedger({ [`${SET}:writer-1#1`]: { close: { type: "settle", costMicros: 1_000 } }, [id(2, 1)]: { close: { type: "settle", costMicros: 250 } } });
    expect(viewOf(set, { ledger }).spentMicros).toBe(1_250);
  });

  test("an unreadable ledger leaves the spend unknown, as before", () => {
    expect(viewOf(stored({ reviewWrites: [rewrite({ k: 2 })] }), { ledger: null })).toMatchObject({ spentMicros: null, openReserveMicros: null });
  });
});

describe("the view's ids", () => {
  test("a write's ids are the ones the spend reads: writeIdsOf is the oracle", () => {
    expect(writeIdsOf(SET, 2)).toEqual([id(2, 1), id(2, 2), id(2, 3), id(2, 4)]);
  });
});
