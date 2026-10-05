import { describe, expect, test } from "bun:test";
import { ManualScheduler } from "../../engine/scheduler";
import { DraftSession } from "./session";
import { draftSpec, manualSaves, montageOf, MONTAGE_ID, photoClip, settle, version } from "./testkit";

// The editor's draft session (3d.2): every edit is an undoable version (at most 100) and goes through the
// serialised autosave; `montage.changed` echoes of this window's own saves change nothing; a save from elsewhere is
// taken while nothing here is unsaved; a removed draft stops everything.

function rig(name: string | null = null) {
  const scheduler = new ManualScheduler();
  const saves = manualSaves();
  const session = new DraftSession({ montage: montageOf(version(0), name), send: saves.send, scheduler });
  return { scheduler, saves, session };
}

describe("edits, undo and redo", () => {
  test("an edit is the new version and is saved", () => {
    const { scheduler, saves, session } = rig();
    expect(session.edit(version(1))).toBe(true);
    expect(session.state.spec).toEqual(version(1));
    expect(session.state.canUndo).toBe(true);
    scheduler.runAll();
    expect(saves.sent()).toEqual([{ spec: version(1), name: null }]);
  });

  test("undo brings the previous version back and saves it; redo saves the undone one again", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    session.edit(version(2));
    scheduler.runAll();
    saves.ok();
    await settle();

    expect(session.undo()).toBe(true);
    expect(session.state.spec).toEqual(version(1));
    expect(session.state.canRedo).toBe(true);
    scheduler.runAll();
    saves.ok();
    await settle();

    expect(session.redo()).toBe(true);
    scheduler.runAll();
    expect(saves.sent().map((c) => c.spec)).toEqual([version(2), version(1), version(2)]);
  });

  test("two drags of the same handle are two undo steps once the first one ends", () => {
    const { session } = rig();
    session.edit(version(1), { mergeKey: "trim" });
    session.edit(version(2), { mergeKey: "trim" });
    session.endMerge();
    session.edit(version(3), { mergeKey: "trim" });
    session.undo();
    expect(session.state.spec).toEqual(version(2));
  });

  test("undo and redo with nothing to do answer false and send nothing", () => {
    const { scheduler, saves, session } = rig();
    expect(session.undo()).toBe(false);
    expect(session.redo()).toBe(false);
    scheduler.runAll();
    expect(saves.calls).toHaveLength(0);
  });

  test("an edit that breaks the draft contract is refused: no version, no save", () => {
    const { scheduler, saves, session } = rig();
    expect(session.edit(draftSpec([photoClip(0, "photo-mia-0001", 450)]))).toBe(false);
    expect(session.edit({ ...version(1), avatarId: "avatar-sofia-0002" })).toBe(false);
    scheduler.runAll();
    expect(session.state.canUndo).toBe(false);
    expect(saves.calls).toHaveLength(0);
  });

  test("the name is not an undo step: a rename is saved at once and survives an undo", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    session.rename("кафе и город");
    expect(saves.sent()).toEqual([{ spec: version(1), name: "кафе и город" }]);
    saves.ok();
    await settle();

    session.undo();
    expect(session.state.name).toBe("кафе и город");
    scheduler.runAll();
    expect(saves.sent().at(-1)).toEqual({ spec: version(0), name: "кафе и город" });
  });

  test("a blank or unchanged name is not saved; an empty name clears it back to «без названия»", async () => {
    const { saves, session } = rig("старое");
    session.rename("  старое  ");
    expect(saves.calls).toHaveLength(0);
    session.rename("   ");
    expect(saves.sent()).toEqual([{ spec: version(0), name: null }]);
  });

  test("flush before «Рендер» sends the newest edit at once", async () => {
    const { saves, session } = rig();
    session.edit(version(1));
    session.edit(version(2));
    const flushed = session.flush();
    expect(saves.sent()).toEqual([{ spec: version(2), name: null }]);
    const stored = saves.ok();
    expect(await flushed).toEqual({ ok: true, montage: stored });
  });
});

describe("montage.changed", () => {
  test("the echo of this window's own save changes nothing: no version, no save", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    scheduler.runAll();
    const echo = montageOf(version(1), null, "2026-09-30T10:00:09.000Z");
    expect(session.receive({ change: "upserted", montage: echo })).toBe("own");
    saves.ok();
    await settle();
    expect(session.state.spec).toEqual(version(1));
    session.undo();
    expect(session.state.spec).toEqual(version(0));
    expect(session.state.canUndo).toBe(false);
  });

  test("a save from elsewhere is taken while nothing here is unsaved, as a version this window can undo", async () => {
    const { scheduler, saves, session } = rig();
    const remote = montageOf(version(5), "из другого окна", "2026-09-30T11:00:00.000Z");
    expect(session.receive({ change: "upserted", montage: remote })).toBe("adopted");
    expect(session.state.spec).toEqual(version(5));
    expect(session.state.name).toBe("из другого окна");
    expect(session.state.saved).toEqual(remote);
    scheduler.runAll();
    expect(saves.calls).toHaveLength(0);

    session.undo();
    scheduler.runAll();
    expect(saves.sent()).toEqual([{ spec: version(0), name: "из другого окна" }]);
  });

  test("a save from elsewhere is left alone while an edit here is unsaved: this window's save follows and wins", () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    expect(session.receive({ change: "upserted", montage: montageOf(version(5), null, "2026-09-30T11:00:00.000Z") })).toBe("kept");
    expect(session.state.spec).toEqual(version(1));
    scheduler.runAll();
    expect(saves.sent()).toEqual([{ spec: version(1), name: null }]);
  });

  test("after a kept save from elsewhere, undo back to the loaded version still saves it: the engine holds the other one", () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    session.receive({ change: "upserted", montage: montageOf(version(5), null, "2026-09-30T11:00:00.000Z") });
    session.undo();
    scheduler.runAll();
    expect(saves.sent()).toEqual([{ spec: version(0), name: null }]);
  });

  test("a re-read answered after this window's save but read before it is stale: the screen keeps this window's version", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    scheduler.runAll();
    saves.ok();
    await settle();
    expect(session.receive({ change: "upserted", montage: montageOf(version(0), null, "2026-09-30T10:00:00.000Z") })).toBe("stale");
    expect(session.state.spec).toEqual(version(1));
    scheduler.runAll();
    expect(saves.calls).toHaveLength(1);
    // A newer save from elsewhere is still taken.
    expect(session.receive({ change: "upserted", montage: montageOf(version(5), null, "2026-09-30T11:00:00.000Z") })).toBe("adopted");
  });

  test("another draft's changes are not this session's business", () => {
    const { session } = rig();
    const other = { ...montageOf(version(5)), montageId: "montage-0000002" };
    expect(session.receive({ change: "upserted", montage: other })).toBe("other");
    expect(session.receive({ change: "removed", montageId: "montage-0000002", avatarId: other.spec.avatarId })).toBe("other");
    expect(session.state.save.kind).toBe("saved");
  });

  test("the draft removed elsewhere ends the session: nothing is saved any more", () => {
    const { scheduler, saves, session } = rig();
    session.edit(version(1));
    expect(session.receive({ change: "removed", montageId: MONTAGE_ID, avatarId: version(0).avatarId })).toBe("removed");
    expect(session.state.save.kind).toBe("gone");
    expect(session.edit(version(2))).toBe(false);
    scheduler.runAll();
    expect(saves.calls).toHaveLength(0);
  });
});

describe("the engine's clock (3d.2 re-review, HIGH)", () => {
  test("editing a draft stamped a day ahead of the engine's clock saves once, and the flush every way out waits for answers", async () => {
    let sends = 0;
    let clockMs = Date.UTC(2026, 8, 30, 10, 0, 0, 0);
    const session = new DraftSession({
      montage: montageOf(version(0), null, "2026-10-01T10:00:00.000Z"),
      scheduler: new ManualScheduler(),
      send: async (montageId, content) => {
        sends += 1;
        clockMs += 5;
        return { ok: true, result: { montage: { montageId, name: content.name, spec: content.spec, updatedAt: new Date(clockMs).toISOString() } } };
      },
    });
    session.edit(version(1));
    let settled = false;
    void session.flush().then(() => (settled = true));
    for (let i = 0; i < 20_000 && !settled; i++) await Promise.resolve();

    expect(settled).toBe(true);
    expect(sends).toBe(1);
    expect(session.state.save.kind).toBe("saved");
  });
});

describe("the focus found for a placed photo (3d.3a, K6)", () => {
  const FACE = { x: 0.5, y: 0.35 } as const;
  const one = draftSpec([photoClip(0, "photo-mia-0005")]);
  const two = draftSpec([photoClip(0, "photo-mia-0005"), photoClip(1, "photo-mia-0006")]);
  const focusOf = (spec: ReturnType<typeof draftSpec>, i: number) => {
    const clip = spec.clips[i];
    return clip?.kind === "photo" ? clip.cell.focus : undefined;
  };

  test("fills the photo's cell in the present and is saved, without an undo step of its own", () => {
    const { scheduler, saves, session } = rig();
    session.edit(one);
    expect(session.fillFocus("photo-mia-0005", FACE)).toBe(true);
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
    scheduler.runAll();
    expect(saves.sent().at(-1)?.spec.clips[0]).toMatchObject({ cell: { focus: FACE } });
    // One undo goes back past the placing itself: the focus is not a step of its own.
    session.undo();
    expect(session.state.spec).toEqual(version(0));
  });

  test("the placed photo's later versions get it too, and a redo brings the photo back resolved", () => {
    const { session } = rig();
    session.edit(one);
    session.edit(two);
    session.undo();
    session.undo();
    expect(session.fillFocus("photo-mia-0005", FACE)).toBe(false);
    session.redo();
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
    session.redo();
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
  });

  test("a photo no longer in the present sends no save", () => {
    const { scheduler, saves, session } = rig();
    session.edit(one);
    session.undo();
    scheduler.runAll();
    const sent = saves.calls.length;
    session.fillFocus("photo-mia-0005", FACE);
    scheduler.runAll();
    expect(saves.calls).toHaveLength(sent);
  });

  test("a focus outside the frame is refused before it reaches any version, an undone one included", () => {
    const { session } = rig();
    session.edit(one);
    session.undo();
    expect(session.fillFocus("photo-mia-0005", { x: 2, y: 0.5 })).toBe(false);
    session.redo();
    expect(focusOf(session.state.spec, 0)).toBeNull();
  });

  test("after the draft is gone, nothing changes", () => {
    const { session } = rig();
    session.edit(one);
    session.receive({ change: "removed", montageId: MONTAGE_ID, avatarId: one.avatarId });
    expect(session.fillFocus("photo-mia-0005", FACE)).toBe(false);
    expect(focusOf(session.state.spec, 0)).toBeNull();
  });

  // 3d.3a's known limit, settled in 3d.3b: the same draft open in two windows.
  const resolved = draftSpec([{ ...photoClip(0, "photo-mia-0005"), cell: { photo: { source: "scene", photoId: "photo-mia-0005" }, focus: FACE } }]);

  test("a focus another window filled in is written into this window's versions, never an undo step of its own", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(one);
    scheduler.runAll();
    saves.ok();
    await settle();
    expect(session.receive({ change: "upserted", montage: montageOf(resolved, null, "2026-09-30T11:00:00.000Z") })).toBe("adopted");
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
    // One undo goes back past the placing itself, and a redo brings the photo back resolved.
    session.undo();
    expect(session.state.spec).toEqual(version(0));
    session.redo();
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
  });

  test("a save from elsewhere that changes more than a focus is still a version of its own", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(one);
    scheduler.runAll();
    saves.ok();
    await settle();
    const longer = draftSpec([{ ...photoClip(0, "photo-mia-0005", 3_000), cell: { photo: { source: "scene", photoId: "photo-mia-0005" }, focus: FACE } }]);
    expect(session.receive({ change: "upserted", montage: montageOf(longer, null, "2026-09-30T11:00:00.000Z") })).toBe("adopted");
    session.undo();
    expect(session.state.spec).toEqual(one);
  });
});

describe("the state React reads", () => {
  test("the state object changes exactly when something changed, and listeners hear each change", async () => {
    const { scheduler, saves, session } = rig();
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.state.save.kind));
    const before = session.state;
    expect(session.state).toBe(before);

    session.edit(version(1));
    expect(session.state).not.toBe(before);
    scheduler.runAll();
    saves.ok();
    await settle();

    expect(seen).toContain("pending");
    expect(seen).toContain("saving");
    expect(seen.at(-1)).toBe("saved");
  });
});

describe("the focus found for a placed OWN photo (3f.6, K6 for «Мои»)", () => {
  const FACE = { x: 0.45, y: 0.3 } as const;
  const OWN = "media-photo-0001";
  const ownClip = (index: number, focus: { x: number; y: number } | null = null) => ({ ...photoClip(index, "photo-mia-0001"), cell: { photo: { source: "own" as const, mediaId: OWN }, focus } });
  const one = draftSpec([ownClip(0)]);
  const focusOf = (spec: ReturnType<typeof draftSpec>, i: number) => {
    const clip = spec.clips[i];
    return clip?.kind === "photo" ? clip.cell.focus : undefined;
  };

  test("fills the own photo's cells in every version, without an undo step of its own, and is saved", () => {
    const { scheduler, saves, session } = rig();
    session.edit(one);
    expect(session.fillOwnFocus(OWN, FACE)).toBe(true);
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
    scheduler.runAll();
    expect(saves.sent().at(-1)?.spec.clips[0]).toMatchObject({ cell: { focus: FACE } });
    session.undo();
    expect(session.state.spec).toEqual(version(0));
    session.redo();
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
  });

  test("a focus outside the frame, or a draft that is gone, changes nothing", () => {
    const { session } = rig();
    session.edit(one);
    expect(session.fillOwnFocus(OWN, { x: -1, y: 0.5 })).toBe(false);
    session.receive({ change: "removed", montageId: MONTAGE_ID, avatarId: one.avatarId });
    expect(session.fillOwnFocus(OWN, FACE)).toBe(false);
    expect(focusOf(session.state.spec, 0)).toBeNull();
  });

  test("an own photo's focus another window filled in is written into this window's versions, never an undo step", async () => {
    const { scheduler, saves, session } = rig();
    session.edit(one);
    scheduler.runAll();
    saves.ok();
    await settle();
    expect(session.receive({ change: "upserted", montage: montageOf(draftSpec([ownClip(0, FACE)]), null, "2026-09-30T11:00:00.000Z") })).toBe("adopted");
    expect(focusOf(session.state.spec, 0)).toEqual(FACE);
    session.undo();
    expect(session.state.spec).toEqual(version(0));
  });
});
