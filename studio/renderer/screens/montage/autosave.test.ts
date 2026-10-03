import { describe, expect, test } from "bun:test";
import { ManualScheduler } from "../../engine/scheduler";
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, DraftAutosave, type DraftContent, type SendSave } from "./autosave";
import { manualSaves, montageOf, settle, version } from "./testkit";

// The editor's autosave (3d.2): serialised in the renderer, one `montages.save` in flight, the latest content wins,
// the echoes of this window's own saves are told apart by content, and a flush comes before «Рендер».

const content = (n: number, name: string | null = null): DraftContent => ({ spec: version(n), name });

function rig(options: { debounceMs?: number; maxWaitMs?: number } = {}) {
  const scheduler = new ManualScheduler();
  const saves = manualSaves();
  const autosave = new DraftAutosave({ montage: montageOf(version(0)), send: saves.send, scheduler, ...options });
  return { scheduler, saves, autosave };
}

describe("when a save is sent", () => {
  test("a burst of edits is saved once, after a quiet spell, with the latest content", () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    autosave.set(content(2));
    autosave.set(content(3));
    expect(saves.calls).toHaveLength(0);
    expect(autosave.state.kind).toBe("pending");

    scheduler.next();

    expect(saves.sent()).toEqual([content(3)]);
    expect(autosave.state.kind).toBe("saving");
  });

  test("the quiet spell is the debounce, and the defaults are sane", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(200);
    expect(AUTOSAVE_DEBOUNCE_MS).toBeLessThanOrEqual(1_000);
    expect(AUTOSAVE_MAX_WAIT_MS).toBeGreaterThan(AUTOSAVE_DEBOUNCE_MS);
  });

  test("edits that never go quiet are still saved once the longest wait is over", () => {
    const { scheduler, saves, autosave } = rig({ debounceMs: 500, maxWaitMs: 2_000 });
    // An edit every 200 ms for 5 s: shorter than the debounce, so only the longest wait can send one.
    let edits = 0;
    for (let i = 1; i <= 25; i++) scheduler.schedule(i * 200, () => {
      edits += 1;
      autosave.set(content(i));
    });
    let editsAtFirstSave: number | null = null;
    while (scheduler.next()) if (editsAtFirstSave === null && saves.calls.length > 0) editsAtFirstSave = edits;

    expect(editsAtFirstSave).not.toBeNull();
    expect(editsAtFirstSave ?? Infinity).toBeLessThanOrEqual(11);
  });

  test("an edit back to what the engine already has sends nothing", () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    autosave.set(content(0));
    scheduler.runAll();
    expect(saves.calls).toHaveLength(0);
    expect(autosave.state.kind).toBe("saved");
  });

  test("an edit is compared by content, not by reference", () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set({ spec: JSON.parse(JSON.stringify(version(0))), name: null });
    scheduler.runAll();
    expect(saves.calls).toHaveLength(0);
  });
});

describe("one save in flight, the latest wins", () => {
  test("edits made while a save is out wait for its answer, and only the newest of them is sent", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    autosave.set(content(2));
    autosave.set(content(3));
    scheduler.runAll();
    expect(saves.calls).toHaveLength(1);

    saves.ok();
    await settle();

    expect(saves.sent()).toEqual([content(1), content(3)]);
    expect(saves.open()).toBe(1);
  });

  test("the answer of an overtaken save does not make the draft look saved", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    autosave.set(content(2));
    scheduler.runAll();
    saves.ok();
    await settle();
    expect(autosave.state.kind).toBe("saving");

    const last = saves.ok();
    await settle();
    expect(autosave.state.kind).toBe("saved");
    expect(autosave.saved).toEqual(last);
  });

  test("an edit that returns to the stored content while another save is out is still sent after it", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    autosave.set(content(0));
    scheduler.runAll();
    saves.ok();
    await settle();
    expect(saves.sent()).toEqual([content(1), content(0)]);
  });

  test("an edit made while a save is out still waits for its own quiet spell", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    autosave.set(content(2));
    saves.ok();
    await settle();
    expect(saves.calls).toHaveLength(1);
    expect(autosave.state.kind).toBe("pending");
    scheduler.runAll();
    expect(saves.sent()).toEqual([content(1), content(2)]);
  });
});

describe("flush: before «Рендер» and before leaving", () => {
  test("flush sends at once, without the quiet spell, and answers with the stored draft", async () => {
    const { saves, autosave } = rig();
    autosave.set(content(1));
    const flushed = autosave.flush();
    expect(saves.sent()).toEqual([content(1)]);

    const stored = saves.ok();
    expect(await flushed).toEqual({ ok: true, montage: stored });
  });

  test("flush waits for the save in flight and for the edit behind it", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    autosave.set(content(2));
    let done = false;
    const flushed = autosave.flush().then((r) => {
      done = true;
      return r;
    });

    saves.ok();
    await settle();
    expect(done).toBe(false);
    expect(saves.sent()).toEqual([content(1), content(2)]);

    const stored = saves.ok();
    expect(await flushed).toEqual({ ok: true, montage: stored });
  });

  test("flush with nothing unsaved answers at once, without a save", async () => {
    const { saves, autosave } = rig();
    expect(await autosave.flush()).toEqual({ ok: true, montage: montageOf(version(0)) });
    expect(saves.calls).toHaveLength(0);
  });

  test("a flush that ends in a refusal answers with it", async () => {
    const { saves, autosave } = rig();
    autosave.set(content(1));
    const flushed = autosave.flush();
    saves.fail({ code: "LIBRARY_UNAVAILABLE" });
    expect(await flushed).toEqual({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("close flushes what is unsaved, then ignores later edits", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    const closed = autosave.close();
    autosave.set(content(2));
    scheduler.runAll();
    saves.ok();
    await closed;
    await settle();
    expect(saves.sent()).toEqual([content(1)]);
  });
});

describe("failures", () => {
  test("a failed save keeps the edit and says why; a retry sends the latest content", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    saves.fail({ code: "INTERNAL", detail: "the draft could not be saved (EIO)" });
    await settle();
    expect(autosave.state).toEqual({ kind: "failed", error: { code: "INTERNAL", detail: "the draft could not be saved (EIO)" } });
    expect(autosave.content).toEqual(content(1));
    scheduler.runAll();
    expect(saves.calls).toHaveLength(1);

    autosave.retry();
    expect(saves.sent()).toEqual([content(1), content(1)]);
    saves.ok();
    await settle();
    expect(autosave.state.kind).toBe("saved");
  });

  test("an edit after a failure is saved on its own, after the quiet spell", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    saves.fail({ code: "INTERNAL" });
    await settle();
    autosave.set(content(2));
    scheduler.runAll();
    expect(saves.sent()).toEqual([content(1), content(2)]);
  });

  test("NOT_FOUND means the draft is gone: nothing more is sent, and a flush says so", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    saves.fail({ code: "NOT_FOUND", detail: "no montage draft montage-0000001" });
    await settle();
    expect(autosave.state.kind).toBe("gone");

    autosave.set(content(2));
    scheduler.runAll();
    autosave.retry();
    expect(saves.calls).toHaveLength(1);
    expect(await autosave.flush()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a draft removed elsewhere stops the saves the same way, and answers a waiting flush", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    autosave.set(content(2));
    const flushed = autosave.flush();
    autosave.markGone();
    expect(await flushed).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    saves.fail({ code: "NOT_FOUND" });
    await settle();
    expect(saves.calls).toHaveLength(1);
    expect(autosave.state.kind).toBe("gone");
  });
});

describe("the engine's clock is not this window's business (3d.2 re-review, HIGH)", () => {
  /** A `montages.save` stamped by a wall clock that starts at `startMs` and moves 5 ms per save. */
  function clockedSaves(startMs: number) {
    let clockMs = startMs;
    let sends = 0;
    const send: SendSave = async (montageId, sent) => {
      sends += 1;
      clockMs += 5;
      return { ok: true, result: { montage: { montageId, name: sent.name, spec: sent.spec, updatedAt: new Date(clockMs).toISOString() } } };
    };
    return { send, sends: () => sends };
  }

  async function settleUpTo(done: () => boolean, rounds: number): Promise<void> {
    for (let i = 0; i < rounds && !done(); i++) await Promise.resolve();
  }

  test("an answer stamped before the draft it saves (the clock stepped back 1 s) is taken: one save, and the flush answers", async () => {
    const clock = clockedSaves(Date.UTC(2026, 8, 30, 9, 59, 59, 0));
    const autosave = new DraftAutosave({ montage: montageOf(version(0)), scheduler: new ManualScheduler(), send: clock.send });
    autosave.set(content(1));
    let flushed: unknown = null;
    void autosave.flush().then((r) => (flushed = r));
    await settleUpTo(() => flushed !== null, 2_000);

    expect(clock.sends()).toBe(1);
    expect(flushed).toMatchObject({ ok: true });
    expect(autosave.state.kind).toBe("saved");
  });

  test("a draft stamped a day ahead (saved on a machine whose clock ran ahead) saves once, not forever", async () => {
    const clock = clockedSaves(Date.UTC(2026, 8, 30, 10, 0, 0, 0));
    const autosave = new DraftAutosave({ montage: montageOf(version(0), null, "2026-10-01T10:00:00.000Z"), scheduler: new ManualScheduler(), send: clock.send });
    autosave.set(content(1));
    let flushed: unknown = null;
    void autosave.flush().then((r) => (flushed = r));
    await settleUpTo(() => flushed !== null, 20_000);

    expect(clock.sends()).toBe(1);
    expect(flushed).toMatchObject({ ok: true });
  });

  test("a re-read sent before this window's save and answered after its ack is stale: not adopted, not kept, no save", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    saves.ok(); // stamped 10:00:01
    await settle();
    // The draft as it was read BEFORE the save (10:00:00): older than what the engine answered since.
    const stale = montageOf(version(0), null, "2026-09-30T10:00:00.000Z");
    expect(autosave.isStale(stale)).toBe(true);
    expect(autosave.adoptRemote(stale)).toBe(false);
    autosave.noteKept(stale);
    scheduler.runAll();
    expect(autosave.content).toEqual(content(1));
    expect(autosave.saved.spec).toEqual(version(1));
    expect(saves.calls).toHaveLength(1);
  });

  test("stamps are compared as instants (another precision is not newer), and one that cannot be read is never stale", async () => {
    const { autosave } = rig();
    expect(autosave.isStale(montageOf(version(5), null, "2026-09-30T10:00:00Z"))).toBe(false);
    expect(autosave.isStale(montageOf(version(5), null, "2026-09-30T09:59:59.999Z"))).toBe(true);
    expect(autosave.isStale({ ...montageOf(version(5)), updatedAt: "not a stamp" })).toBe(false);
  });

  test("a save from elsewhere noted while this window's save is out is re-sent over ONCE, whatever the stamps say", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    // Stamped after the open draft (engine stamps move forward per draft) but EARLIER than this window's answer will
    // be (10:00:01): still, which of the two the engine applied last is not read from the stamps.
    autosave.noteKept(montageOf(version(7), null, "2026-09-30T10:00:00.500Z"));
    saves.ok();
    await settle();
    expect(saves.sent()).toEqual([content(1), content(1)]);
    saves.ok();
    await settle();
    expect(saves.sent()).toHaveLength(2);
    expect(autosave.state.kind).toBe("saved");
  });
});

describe("echoes of this window's own saves", () => {
  test("the echo of a save is recognised by its content, even before the save's own answer", () => {
    const { scheduler, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    expect(autosave.isOwnEcho(montageOf(version(1), null, "2026-09-30T10:00:07.000Z"))).toBe(true);
  });

  test("echoes are recognised whatever order they arrive in against the answers", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    const first = saves.ok();
    await settle();
    autosave.set(content(2));
    scheduler.runAll();
    const second = saves.ok();
    await settle();
    // The first save's echo arrives late, after the second's answer.
    expect(autosave.isOwnEcho(first)).toBe(true);
    expect(autosave.isOwnEcho(second)).toBe(true);
  });

  test("a save from elsewhere is not an echo: other content, another name, or another draft", () => {
    const { scheduler, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    expect(autosave.isOwnEcho(montageOf(version(5)))).toBe(false);
    expect(autosave.isOwnEcho(montageOf(version(1), "другое имя"))).toBe(false);
    expect(autosave.isOwnEcho({ ...montageOf(version(1)), montageId: "montage-0000002" })).toBe(false);
  });

  test("a change from elsewhere is adopted while nothing is unsaved: no save follows", () => {
    const { scheduler, saves, autosave } = rig();
    const remote = montageOf(version(7), "из другого окна", "2026-09-30T11:00:00.000Z");
    expect(autosave.adoptRemote(remote)).toBe(true);
    scheduler.runAll();
    expect(autosave.saved).toEqual(remote);
    expect(autosave.content).toEqual({ spec: version(7), name: "из другого окна" });
    expect(saves.calls).toHaveLength(0);
    expect(autosave.state.kind).toBe("saved");
  });

  test("a save from elsewhere that is kept is still what the engine holds: an edit back to the old content is sent", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    const foreign = montageOf(version(7), null, "2026-09-30T11:00:00.000Z");
    expect(autosave.adoptRemote(foreign)).toBe(false);
    autosave.noteKept(foreign);
    // Undo back to what this window loaded: the engine holds version 7 now, so this is an edit, not a no-op.
    autosave.set(content(0));
    scheduler.runAll();
    expect(saves.sent()).toEqual([content(0)]);
    expect(autosave.state.kind).toBe("saving");
  });

  test("an answer older than a save from elsewhere it overtook is not taken as the engine's state: this window saves again", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    scheduler.next();
    // Another window saved after this window's save was applied: its event is newer than this answer.
    autosave.noteKept(montageOf(version(7), null, "2026-09-30T11:00:00.000Z"));
    saves.ok();
    await settle();
    expect(autosave.saved.spec).toEqual(version(7));
    expect(saves.sent()).toEqual([content(1), content(1)]);
  });

  test("a change from elsewhere is left alone while an edit is pending or in flight: this window's save wins", async () => {
    const { scheduler, saves, autosave } = rig();
    autosave.set(content(1));
    expect(autosave.adoptRemote(montageOf(version(7)))).toBe(false);
    scheduler.next();
    expect(autosave.adoptRemote(montageOf(version(7)))).toBe(false);
    saves.ok();
    await settle();
    expect(autosave.content).toEqual(content(1));
  });
});
