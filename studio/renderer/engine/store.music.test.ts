import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type CommandMessage, type EngineError, type MusicStatus, type Snapshot } from "../../shared/engine";
import { createEngineClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

// 3c.6: the window keeps the music status (K24) for the Settings «Музыка» card: asked with `music.status`, then moved by
// `music.changed`. A status the window asked for, or a command answered, is older than an event that came after the ask,
// so it never overwrites one. The two commands that spend or close the quota are sent once, however often they are asked.

const BOOT = "boot-engine-0001";

const IDLE: MusicStatus = {
  listFetchedAt: "2026-09-21T11:02:00.000Z",
  trackCount: 30,
  bytesOnDisk: 94_000_000,
  sentLast31d: 12,
  limit: 30,
  serverRemaining: 18,
  nextFreeAt: "2026-10-03T10:00:00.000Z",
  refresh: { state: "idle" },
  quotaLog: "ok",
};
const RUNNING: MusicStatus = { ...IDLE, sentLast31d: 13, refresh: { state: "running", done: 0, total: 1 } };
const STEP: MusicStatus = { ...RUNNING, refresh: { state: "running", done: 31, total: 61 } };
const CLOSED: MusicStatus = { ...IDLE, sentLast31d: 30, serverRemaining: null, nextFreeAt: "2026-11-03T10:00:00.000Z" };

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function baseSnapshot(): Promise<Snapshot> {
  const reply = await mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })).request("engine.snapshot", {});
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.result;
}

type Answer = { ok: true; result: unknown } | { ok: false; error: EngineError };

/** A scripted engine: each command type answers what the test queues (held until released when `hold` is set), and events are emitted by hand. */
async function host() {
  const snapshot: Snapshot = { ...(await baseSnapshot()), bootId: BOOT, lastSeq: 0 };
  const listeners = new Set<(e: unknown) => void>();
  const calls: CommandMessage[] = [];
  const queued = new Map<string, { answer: Answer; held: Promise<void> | null }[]>();
  let seq = 0;
  let boot = BOOT;
  const bridge = {
    async request(cmd: CommandMessage): Promise<unknown> {
      calls.push(cmd);
      const head = { v: PROTOCOL_VERSION, id: cmd.id, kind: "response", type: cmd.type };
      if (cmd.type === "engine.snapshot") return { ...head, ok: true, result: { ...snapshot, bootId: boot, lastSeq: seq } };
      const next = queued.get(cmd.type)?.shift();
      if (next === undefined) return { ...head, ok: false, error: { code: "INTERNAL" } };
      if (next.held !== null) await next.held;
      return { ...head, ...next.answer };
    },
    subscribe(l: (e: unknown) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const store = new EngineStore(createEngineClient(bridge, "window"));
  const stop = store.start();
  await flush();
  return {
    store,
    calls: (type: string) => calls.filter((c) => c.type === type),
    /** The next `type` command answers `answer`; with `hold`, only once the returned function is called. */
    queue(type: string, answer: Answer, options: { hold?: boolean } = {}): () => Promise<void> {
      let release: () => void = () => undefined;
      const held = options.hold === true ? new Promise<void>((resolve) => (release = resolve)) : null;
      queued.set(type, [...(queued.get(type) ?? []), { answer, held }]);
      return async () => {
        release();
        await flush();
      };
    },
    async changed(status: MusicStatus): Promise<void> {
      seq += 1;
      for (const l of [...listeners]) l({ v: PROTOCOL_VERSION, id: `evt-${String(seq).padStart(8, "0")}`, kind: "event", seq, bootId: boot, type: "music.changed", payload: { status } });
      await flush();
    },
    restart(): void {
      boot = "boot-engine-0002";
      seq = 0;
    },
    stop,
  };
}

describe("the music status in the window", () => {
  test("is not known before it is asked: the snapshot does not carry it", async () => {
    const h = await host();
    expect(h.store.getView().music).toBeNull();
    h.stop();
  });

  test("refreshMusic asks music.status and shows it", async () => {
    const h = await host();
    h.queue("music.status", { ok: true, result: IDLE });
    await h.store.refreshMusic();
    expect(h.store.getView().music).toEqual(IDLE);
    h.stop();
  });

  test("music.changed moves it on, in order, and moves lastSeq", async () => {
    const h = await host();
    const before = h.store.getView().lastSeq;
    await h.changed(RUNNING);
    await h.changed(STEP);
    expect(h.store.getView().music).toEqual(STEP);
    expect(h.store.getView().lastSeq).toBe(before + 2);
    h.stop();
  });

  test("an answer to an ask that began before a music.changed is older than it, and is dropped", async () => {
    const h = await host();
    const release = h.queue("music.status", { ok: true, result: IDLE }, { hold: true });
    const asked = h.store.refreshMusic();
    await flush();
    await h.changed(STEP);
    await release();
    await asked;
    expect(h.store.getView().music).toEqual(STEP);
    h.stop();
  });

  test("a failed ask changes nothing and does not throw", async () => {
    const h = await host();
    await h.changed(IDLE);
    h.queue("music.status", { ok: false, error: { code: "INTERNAL" } });
    await h.store.refreshMusic();
    expect(h.store.getView().music).toEqual(IDLE);
    h.stop();
  });

  test("after a resync from an engine that restarted, a status that was known is asked again (no event says the old refresh ended)", async () => {
    const h = await host();
    await h.changed(RUNNING);
    h.restart();
    h.queue("music.status", { ok: true, result: IDLE });
    h.store.reload();
    await flush();
    expect(h.calls("music.status")).toHaveLength(1);
    expect(h.store.getView().music).toEqual(IDLE);
    h.stop();
  });

  test("a resync while nothing was known asks nothing", async () => {
    const h = await host();
    h.store.reload();
    await flush();
    expect(h.calls("music.status")).toEqual([]);
    h.stop();
  });
});

describe("the confirmed music commands", () => {
  test("confirmMusicRefresh sends music.refresh once, with confirm: true, and shows the status it answers", async () => {
    const h = await host();
    h.queue("music.refresh", { ok: true, result: { status: RUNNING } });
    const reply = await h.store.confirmMusicRefresh();
    expect(reply).toEqual({ ok: true });
    expect(h.calls("music.refresh").map((c) => c.payload)).toEqual([{ confirm: true }]);
    expect(h.store.getView().music).toEqual(RUNNING);
    h.stop();
  });

  test("asked twice while the first is on its way, it is sent ONCE: a double click cannot spend two requests", async () => {
    const h = await host();
    const release = h.queue("music.refresh", { ok: true, result: { status: RUNNING } }, { hold: true });
    h.queue("music.refresh", { ok: true, result: { status: RUNNING } });
    const first = h.store.confirmMusicRefresh();
    const second = h.store.confirmMusicRefresh();
    await release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(h.calls("music.refresh")).toHaveLength(1);
    h.stop();
  });

  test("its answer never overwrites a progress event that came first (the refresh outruns its own answer)", async () => {
    const h = await host();
    const release = h.queue("music.refresh", { ok: true, result: { status: RUNNING } }, { hold: true });
    const sent = h.store.confirmMusicRefresh();
    await flush();
    await h.changed(STEP);
    await release();
    await sent;
    expect(h.store.getView().music).toEqual(STEP);
    h.stop();
  });

  test("a refusal is handed back and changes nothing", async () => {
    const h = await host();
    await h.changed(IDLE);
    h.queue("music.refresh", { ok: false, error: { code: "MUSIC_QUOTA_EXHAUSTED", detail: "30 of 30" } });
    expect(await h.store.confirmMusicRefresh()).toEqual({ ok: false, error: { code: "MUSIC_QUOTA_EXHAUSTED", detail: "30 of 30" } });
    expect(h.store.getView().music).toEqual(IDLE);
    h.stop();
  });

  test("confirmQuotaLogRecovery sends music.recoverQuotaLog once, with confirm: true, and shows the closed quota", async () => {
    const h = await host();
    const release = h.queue("music.recoverQuotaLog", { ok: true, result: { status: CLOSED } }, { hold: true });
    const first = h.store.confirmQuotaLogRecovery();
    const second = h.store.confirmQuotaLogRecovery();
    await release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(h.calls("music.recoverQuotaLog").map((c) => c.payload)).toEqual([{ confirm: true }]);
    expect(h.store.getView().music).toEqual(CLOSED);
    h.stop();
  });
});
