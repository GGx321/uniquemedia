import { describe, expect, test } from "bun:test";
import { SceneSetView } from "../../shared/engine";
import type { PlannedSceneSet, StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { fakeLedger, WRITER_ATTEMPT_WORST } from "./testing/fakeLedger";
import { buildSceneSetView, type ViewContext } from "./view";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: what the window is shown of a set. Status and `stoppedBy` are DERIVED (never stored): no outcome and no live job reads `closed`. The spend is the
// set's closed attempts plus its open reserves that are NOT in flight; per-chunk attempts left come from the ledger, so the UI never guesses.

const SET = "set-aaaa-0001";
const id = (chunk: number, n: number) => `${SET}:writer-${chunk}#${n}`;
const CUSTOM = "cat-paris-cafes" as const;

function stored(over: Partial<StoredSceneSet> = {}, options: Parameters<typeof sampleSet>[0] = { count: 35 }): PlannedSceneSet {
  return { schemaVersion: 1, revision: 4, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:30:00.000Z", ...sampleSet(options), ...over } as PlannedSceneSet;
}

function context(over: Partial<ViewContext> = {}): ViewContext {
  return { ledger: fakeLedger({}), inFlight: new Set(), live: null, used: false, ...over };
}

function viewOf(set: StoredSceneSet, over: Partial<ViewContext> = {}): SceneSetView {
  const view = buildSceneSetView(set, context(over));
  // Every view the engine builds is one the contract accepts.
  expect(SceneSetView.safeParse(view).success).toBe(true);
  return view;
}

const withWrite = (set: StoredSceneSet, write: StoredSceneSet["write"]): StoredSceneSet => ({ ...set, write, writes: Math.max(set.writes, write?.k ?? 0) });
const COMPOSE = { k: 1, kind: "compose" as const, jobId: "job-aaaa-0001" };
const allWritten = (set: StoredSceneSet): StoredSceneSet => ({ ...set, scenes: set.scenes.map((s) => ({ ...s, text: s.text ?? "A sentence." })) });

describe("status", () => {
  test("a set with a recorded write, no live job and scenes still waiting is stopped, and says `closed`: no outcome, no job", () => {
    const view = viewOf(withWrite(stored(), COMPOSE));
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "closed", stoppedError: null, write: null });
  });

  test("a set whose job runs is writing, and the view says what it writes", () => {
    const view = viewOf(withWrite(stored(), COMPOSE), { live: { kind: "compose", count: 35 } });
    expect(view).toMatchObject({ status: "writing", stoppedBy: null, write: { kind: "compose", count: 35 } });
  });

  test.each(["cancelled", "rate-limited", "provider-error", "network", "timeout"] as const)("a write that stopped by %s says so", (stoppedBy) => {
    const view = viewOf(withWrite(stored(), { ...COMPOSE, stoppedBy }));
    expect(view).toMatchObject({ status: "stopped", stoppedBy });
  });

  test("a write that stopped by a failure carries its error", () => {
    const view = viewOf(withWrite(stored(), { ...COMPOSE, stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID", detail: "401" } }));
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } });
  });

  test("a set no write is recorded for, with every scene written, is ready", () => {
    expect(viewOf(allWritten(withWrite(stored(), null)))).toMatchObject({ status: "ready", stoppedBy: null });
  });

  test("a crash right before the write was cleared leaves nothing to write: the set reads ready, not stopped", () => {
    expect(viewOf(allWritten(withWrite(stored(), COMPOSE)))).toMatchObject({ status: "ready", stoppedBy: null });
  });

  test("a stopped set whose waiting scenes were all removed is ready: the button is «Отрисовать»", () => {
    const set = withWrite(stored(), { ...COMPOSE, stoppedBy: "network" });
    const removed = { ...set, scenes: set.scenes.map((s) => ({ ...s, removed: true })) };
    expect(viewOf(removed)).toMatchObject({ status: "ready", stoppedBy: null });
  });

  test("a stopped set whose waiting chunks are all out of attempts has nothing to write: ready, with scenes «не составлена»", () => {
    const set = withWrite(stored(), { ...COMPOSE, stoppedBy: "network" });
    const spent = { close: { type: "settle", costMicros: 11_000 } } as const;
    const ledger = fakeLedger({ [id(1, 1)]: spent, [id(1, 2)]: spent, [id(2, 1)]: spent, [id(2, 2)]: spent });
    expect(viewOf(set, { ledger })).toMatchObject({ status: "ready" });
  });

  test("a set whose run's folder exists is used, names that run, and keeps its scenes", () => {
    const view = viewOf(allWritten(stored()), { used: true });
    expect(view).toMatchObject({ status: "used", runId: "run-aaaa-0001", stoppedBy: null });
    expect(view.scenes).toHaveLength(35);
  });

  test("a set that is not used does not name its run", () => {
    expect(viewOf(allWritten(stored())).runId).toBeNull();
  });
});

describe("spend", () => {
  test("is the closed attempts at what they cost", () => {
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: 11_000 } }, [id(2, 1)]: { close: { type: "settle", costMicros: 4_000 } } });
    expect(viewOf(stored(), { ledger })).toMatchObject({ spentMicros: 15_000, openReserveMicros: 0 });
  });

  test("an open reserve that is not in flight counts at its worst case, and is the open reserve", () => {
    const ledger = fakeLedger({ [id(1, 1)]: {}, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(viewOf(stored(), { ledger })).toMatchObject({ spentMicros: WRITER_ATTEMPT_WORST + 11_000, openReserveMicros: WRITER_ATTEMPT_WORST });
  });

  test("a request at the model right now is not in the spend: the task line shows it", () => {
    const ledger = fakeLedger({ [id(1, 1)]: {}, [id(1, 2)]: { close: { type: "settle", costMicros: 11_000 } } });
    expect(viewOf(stored(), { ledger, inFlight: new Set([id(1, 1)]) })).toMatchObject({ spentMicros: 11_000, openReserveMicros: 0 });
  });

  test("a reconcile's estimated settle is a closed attempt at that cost, no longer an open reserve", () => {
    const ledger = fakeLedger({ [id(1, 1)]: { close: { type: "settle", costMicros: WRITER_ATTEMPT_WORST, estimated: true } } });
    expect(viewOf(stored(), { ledger })).toMatchObject({ spentMicros: WRITER_ATTEMPT_WORST, openReserveMicros: 0 });
  });

  test("a released request cost nothing", () => {
    expect(viewOf(stored(), { ledger: fakeLedger({ [id(1, 1)]: { close: { type: "release" } } }) })).toMatchObject({ spentMicros: 0, openReserveMicros: 0 });
  });

  test("counts only the set's own attempts", () => {
    const ledger = fakeLedger({ "set-bbbb-0002:writer-1#1": { close: { type: "settle", costMicros: 99_000 } } });
    expect(viewOf(stored(), { ledger })).toMatchObject({ spentMicros: 0 });
  });

  test("with the ledger unreadable the spend and its reserve are both unknown", () => {
    expect(viewOf(stored(), { ledger: null })).toMatchObject({ spentMicros: null, openReserveMicros: null });
  });
});

describe("chunks", () => {
  test("each chunk carries its scenes and the attempts it has left across all jobs", () => {
    const ledger = fakeLedger({ [id(1, 1)]: {} });
    const view = viewOf(stored(), { ledger });
    expect(view.chunks.map((c) => ({ chunk: c.chunk, n: c.sceneIds.length, attemptsLeft: c.attemptsLeft, gaveUpBy: c.gaveUpBy }))).toEqual([
      { chunk: 1, n: 25, attemptsLeft: 1, gaveUpBy: null },
      { chunk: 2, n: 10, attemptsLeft: 2, gaveUpBy: null },
    ]);
  });

  test("a chunk out of attempts reads no-attempts and a chunk a job gave up on reads what the job decided", () => {
    const set = stored();
    const gaveUp = { ...set, chunks: set.chunks.map((c) => (c.chunk === 2 ? { ...c, gaveUp: "refused" as const } : c)) };
    const spent = { close: { type: "settle", costMicros: 11_000 } } as const;
    const view = viewOf(gaveUp, { ledger: fakeLedger({ [id(1, 1)]: spent, [id(1, 2)]: spent }) });
    expect(view.chunks.map((c) => [c.attemptsLeft, c.gaveUpBy])).toEqual([
      [0, "no-attempts"],
      [0, "refused"],
    ]);
  });
});

describe("scenes", () => {
  test("a scene still waiting for its sentence is pending, and one with a sentence is neither", () => {
    const view = viewOf(stored({}, { count: 4, written: 2 }));
    expect(view.scenes.map((s) => [s.unwritten, s.text === null])).toEqual([
      [null, false],
      [null, false],
      ["pending", true],
      ["pending", true],
    ]);
  });

  test("a scene of a chunk a job gave up on is gave-up, with the reason; the owner's typed text makes it written", () => {
    const set = stored({}, { count: 3 });
    const gaveUp: StoredSceneSet = {
      ...set,
      chunks: set.chunks.map((c) => ({ ...c, gaveUp: "rejected" as const })),
      scenes: set.scenes.map((s) => (s.sceneId === 1 ? { ...s, text: "Typed by the owner.", edited: true } : s)),
    };
    const view = viewOf(gaveUp);
    expect(view.scenes.map((s) => [s.unwritten, s.gaveUpBy])).toEqual([
      [null, null],
      ["gave-up", "rejected"],
      ["gave-up", "rejected"],
    ]);
    expect(view.scenes[0]).toMatchObject({ text: "Typed by the owner.", edited: true });
  });

  test("a scene of a chunk out of attempts is gave-up by no-attempts, though no job ever said so", () => {
    const spent = { close: { type: "settle", costMicros: 11_000 } } as const;
    const view = viewOf(stored({}, { count: 3 }), { ledger: fakeLedger({ [id(1, 1)]: spent, [id(1, 2)]: {} }) });
    expect(view.scenes.every((s) => s.unwritten === "gave-up" && s.gaveUpBy === "no-attempts")).toBe(true);
  });

  test("a removed scene is kept in the view, marked removed", () => {
    const set = stored({}, { count: 3, written: 3 });
    const removed = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 2 ? { ...s, removed: true } : s)) };
    const view = viewOf(removed);
    expect(view.scenes.map((s) => s.removed)).toEqual([false, true, false]);
    expect(view.scenes[1]?.text).not.toBeNull();
  });

  test("a built-in scene names its category as the contract does, with no name; the planner's own names are not shown", () => {
    const view = viewOf(stored({}, { count: 5, categories: ["shoot", "glam", "fit"] }));
    expect(new Set(view.scenes.map((s) => s.category))).toEqual(new Set(["shoot", "glam", "fit"]));
    expect(view.scenes.every((s) => s.categoryName === null && s.origin === "planned" && s.idea === null)).toBe(true);
  });

  test("a scene carries what the planner drew for it", () => {
    const set = stored({}, { count: 3 });
    const first = set.scenes[0];
    const view = viewOf(set);
    expect(view.scenes[0]?.place).toEqual({ location: first?.slot.location, timeOfDay: first?.slot.timeOfDay, activity: first?.slot.activity, outfit: first?.slot.outfit });
    expect(view.scenes[0]).toMatchObject({ sceneId: 1, shot: first?.slot.shot, pose: first?.slot.pose, chunk: 1 });
  });

  test("a custom category's scenes carry the snapshot's name, whatever the library says now", () => {
    const set = stored({}, { count: 3 });
    const custom: StoredSceneSet = {
      ...set,
      request: { ...set.request, categories: [CUSTOM] },
      categories: [{ ref: CUSTOM, name: "Кофейни Парижа", label: "Paris cafes", style: "phone" }],
      scenes: set.scenes.map((s) => ({ ...s, slot: { ...s.slot, category: CUSTOM, location: "a corner cafe", timeOfDay: "morning", activity: "reading a menu", outfit: "a black midi dress" } })),
    };
    const view = viewOf(custom);
    expect(view.scenes.every((s) => s.category === CUSTOM && s.categoryName === "Кофейни Парижа")).toBe(true);
    expect(view.categories).toEqual([{ ref: CUSTOM, name: "Кофейни Парижа" }]);
  });

  test("the set's categories are listed as it was planned, built-ins with no name", () => {
    expect(viewOf(stored({}, { count: 4, categories: ["home", "travel"] })).categories).toEqual([
      { ref: "home", name: null },
      { ref: "travel", name: null },
    ]);
  });
});

describe("lastCompose", () => {
  test("counts the scenes that are not removed, how many have a sentence and how many are given up", () => {
    const set = stored({}, { count: 6, written: 3 });
    const gaveUp = { ...set, chunks: set.chunks.map((c) => ({ ...c, gaveUp: "rejected" as const })), scenes: set.scenes.map((s) => (s.sceneId === 6 ? { ...s, removed: true } : s)) };
    expect(viewOf(gaveUp).lastCompose).toEqual({ total: 5, written: 3, gaveUp: 2 });
  });

  test("reports the outcome stored when the job ended, not the scenes as they are now", () => {
    const set = stored({ lastOutcome: { total: 5, written: 3, gaveUp: 2 } }, { count: 6, written: 3 });
    const edited = { ...set, scenes: set.scenes.map((s) => ({ ...s, removed: true })) };
    expect(viewOf(edited).lastCompose).toEqual({ total: 5, written: 3, gaveUp: 2 });
  });

  test("an empty set has none", () => {
    expect(viewOf(stored({}, { count: 0, categories: [] })).lastCompose).toBeNull();
  });
});

describe("the set's own fields", () => {
  test("carries its identity, revision, time, poses and text model", () => {
    expect(viewOf(stored())).toMatchObject({
      sceneSetId: SET,
      avatarId: "avatar-aaaa-0001",
      revision: 4,
      createdAt: "2026-10-07T10:00:00.000Z",
      poses: { profile: false, back: false },
      textModel: "x-ai/grok-4.3",
    });
  });
});
