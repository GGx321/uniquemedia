import { describe, expect, test } from "bun:test";
import { ManualScheduler } from "../../engine/scheduler";
import { DraftSession } from "./session";
import { DraftSessions, KEPT_DRAFTS, type KeptDraft } from "./sessions";
import { manualSaves, montageOf, settle, version } from "./testkit";

// Slice review 5-M2: the editor of a draft that closes leaves its session (the undo and redo history) and its place (the media tab, the selection,
// the playhead) with the window, so the same draft opened again in this window goes on where it was: from the editor to Settings and back loses
// nothing. Only a session with everything saved goes on; one with an edit that was not saved (refused, or left behind) opens as Studio holds it.

function rig(montageId = "montage-0000001") {
  const scheduler = new ManualScheduler();
  const saves = manualSaves();
  const session = new DraftSession({ montage: { ...montageOf(version(0)), montageId }, send: saves.send, scheduler });
  const kept: KeptDraft = { session, place: { tab: "music", selection: { kind: "music" }, placed: false, playheadMs: 1_200, zoom: 2 } };
  return { scheduler, saves, session, kept };
}

describe("the editors kept by the window", () => {
  test("a draft never opened here has nothing kept", () => {
    expect(new DraftSessions().resume("montage-0000001", montageOf(version(0)))).toBeNull();
  });

  test("a session whose edits are all saved goes on: its history and its place", async () => {
    const { scheduler, saves, session, kept } = rig();
    session.edit(version(1));
    scheduler.runAll();
    const stored = saves.ok();
    await settle();
    const sessions = new DraftSessions();
    sessions.keep("montage-0000001", kept);
    const resumed = sessions.resume("montage-0000001", stored);
    expect(resumed?.session).toBe(session);
    expect(resumed?.session.state.canUndo).toBe(true);
    expect(resumed?.place).toEqual({ tab: "music", selection: { kind: "music" }, placed: false, playheadMs: 1_200, zoom: 2 });
    expect(resumed?.changedElsewhere).toBe(false);
    // Resuming does not use it up: a second editor of the same draft (StrictMode's remount) finds it too.
    expect(sessions.resume("montage-0000001", stored)?.session).toBe(session);
  });

  test("review r1 LOW-1: a save made elsewhere while it was away is taken on top of the history, once, and said; asked again, the same answer", async () => {
    const { scheduler, saves, session, kept } = rig();
    session.edit(version(1));
    scheduler.runAll();
    const stored = saves.ok();
    await settle();
    const sessions = new DraftSessions();
    sessions.keep("montage-0000001", kept);
    const elsewhere = { ...stored, spec: version(2), updatedAt: "2026-09-30T11:00:00.000Z" };
    const first = sessions.resume("montage-0000001", elsewhere);
    expect(first?.changedElsewhere).toBe(true);
    expect(session.state.spec).toEqual(version(2));
    // StrictMode's second call: no second step in the history, and the same answer.
    expect(sessions.resume("montage-0000001", elsewhere)?.changedElsewhere).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.state.spec).toEqual(version(1));
  });

  test("a session with an edit not saved (on its way, refused, or the draft deleted) is not resumed, and is let go", async () => {
    const pending = rig();
    pending.session.edit(version(1));
    const refused = rig("montage-0000002");
    refused.session.edit(version(1));
    refused.scheduler.runAll();
    refused.saves.fail({ code: "LIBRARY_UNAVAILABLE" });
    await settle();
    const gone = rig("montage-0000003");
    gone.session.receive({ change: "removed", montageId: "montage-0000003", avatarId: version(0).avatarId });
    const sessions = new DraftSessions();
    for (const [id, r] of [["montage-0000001", pending], ["montage-0000002", refused], ["montage-0000003", gone]] as const) {
      sessions.keep(id, r.kept);
      expect(sessions.resume(id, { ...montageOf(version(0)), montageId: id })).toBeNull();
      expect(sessions.peek(id)).toBeNull();
    }
  });

  test("at most KEPT_DRAFTS are kept: the one left longest ago goes first; keeping one again makes it the newest", () => {
    const sessions = new DraftSessions();
    const ids = Array.from({ length: KEPT_DRAFTS + 1 }, (_, i) => `montage-${String(i + 1).padStart(7, "0")}`);
    for (const id of ids.slice(0, KEPT_DRAFTS)) sessions.keep(id, rig(id).kept);
    // The first one is kept again (opened and left once more): now the second is the oldest.
    const first = ids[0] ?? "";
    sessions.keep(first, rig(first).kept);
    const last = ids[KEPT_DRAFTS] ?? "";
    sessions.keep(last, rig(last).kept);
    expect(sessions.peek(first)).not.toBeNull();
    expect(sessions.peek(ids[1] ?? "")).toBeNull();
    expect(sessions.peek(last)).not.toBeNull();
  });

  test("review r1 LOW-7: a library switch forgets every kept editor", () => {
    const sessions = new DraftSessions();
    sessions.keep("montage-0000001", rig().kept);
    sessions.keep("montage-0000002", rig("montage-0000002").kept);
    sessions.clear();
    expect(sessions.peek("montage-0000001")).toBeNull();
    expect(sessions.peek("montage-0000002")).toBeNull();
  });

  test("forget drops it (the draft opens as Studio holds it, or is gone)", () => {
    const sessions = new DraftSessions();
    sessions.keep("montage-0000001", rig().kept);
    sessions.forget("montage-0000001");
    expect(sessions.resume("montage-0000001", montageOf(version(0)))).toBeNull();
  });
});
