// A host (main or the engine) that misbehaves must never make the store spin.
// Scenarios from the T8a review probes.
import { expect, test } from "bun:test";
import { type CommandMessage, type MoneyStatus, type OpenMoneyStatus, PROTOCOL_VERSION, type Snapshot } from "../../shared/engine";
import { createEngineClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function openMoney(money: MoneyStatus): OpenMoneyStatus {
  if (money.ledger !== "open") throw new Error("expected the mock's ledger to be open");
  return money;
}

async function baseSnapshot(): Promise<Snapshot> {
  const reply = await mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })).request("engine.snapshot", {});
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.result;
}

interface FakeHost {
  /** Called after each snapshot reply has been sent (the host reacting to it). */
  onSnapshot?: (emit: (e: unknown) => void, n: number) => void;
  snapshotFails?: () => boolean;
  bootId?: () => string;
}

async function fakeHost(opts: FakeHost = {}) {
  const base = await baseSnapshot();
  const listeners = new Set<(e: unknown) => void>();
  const emit = (e: unknown): void => {
    for (const l of [...listeners]) l(e);
  };
  const counts = { snapshot: 0, events: 0 };
  const bridge = {
    async request(cmd: CommandMessage): Promise<unknown> {
      const head = { v: PROTOCOL_VERSION, id: cmd.id, kind: "response", type: cmd.type };
      if (cmd.type === "engine.snapshot") {
        counts.snapshot += 1;
        const n = counts.snapshot;
        if (opts.snapshotFails?.()) return { ...head, ok: false, error: { code: "INTERNAL" } };
        if (opts.onSnapshot) setTimeout(() => opts.onSnapshot?.(emit, n), 0);
        return { ...head, ok: true, result: { ...base, bootId: opts.bootId?.() ?? "boot-engine-0001", lastSeq: 0 } };
      }
      if (cmd.type === "engine.events") {
        counts.events += 1;
        return { ...head, ok: true, result: { gap: false, events: [] } };
      }
      return { ...head, ok: false, error: { code: "INTERNAL" } };
    },
    subscribe(l: (e: unknown) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { bridge, emit, counts, money: openMoney(base.money) };
}

function notice(seq: number, bootId: string): unknown {
  return {
    v: PROTOCOL_VERSION,
    id: `evt-host-${String(seq).padStart(4, "0")}`,
    kind: "event",
    seq,
    bootId,
    type: "engine.error",
    payload: { error: { code: "INTERNAL" } },
  };
}

test("a host that answers every snapshot with a foreign-bootId notice does not make the store spin", async () => {
  const host = await fakeHost({ onSnapshot: (emit, n) => emit(notice(n, "boot-main-00001")) });
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(150);
  expect(host.counts.snapshot).toBeLessThanOrEqual(2);
  expect(store.getView()).toMatchObject({ phase: "ready", bootId: "boot-engine-0001" });
  stop();
});

test("a steady stream of foreign-bootId events costs one extra snapshot, not one each", async () => {
  const host = await fakeHost();
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(10);
  for (let i = 1; i <= 50; i++) {
    host.emit(notice(i, "boot-main-00001"));
    await sleep(1);
  }
  await sleep(20);
  expect(host.counts.snapshot).toBeLessThanOrEqual(2);
  expect(store.getView().phase).toBe("ready");
  stop();
});

test("a host that invents a new bootId every time is cut off after a few automatic snapshots", async () => {
  let n = 0;
  const host = await fakeHost({
    bootId: () => `boot-flap-${String(++n).padStart(4, "0")}`,
    onSnapshot: (emit, k) => emit(notice(1, `boot-flap-${String(k + 1).padStart(4, "0")}`)),
  });
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(200);
  // One initial load plus at most three automatic resyncs in the window.
  expect(host.counts.snapshot).toBeLessThanOrEqual(4);
  expect(store.getView().phase).toBe("offline");
  expect(store.getView().failure?.code).toBe("INTERNAL");
  stop();
});

test("a real engine restart resyncs once, stays ready, and ignores the old engine's late events", async () => {
  let boot = "boot-engine-0001";
  const host = await fakeHost({ bootId: () => boot });
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(10);

  boot = "boot-engine-0002";
  host.emit(notice(1, "boot-engine-0002"));
  await sleep(10);
  expect(host.counts.snapshot).toBe(2);
  expect(store.getView()).toMatchObject({ phase: "ready", bootId: "boot-engine-0002" });

  // A straggler from the engine that is gone.
  host.emit(notice(7, "boot-engine-0001"));
  await sleep(10);
  expect(host.counts.snapshot).toBe(2);

  // The restart notice itself was newer than the snapshot and got applied; the new engine's next event applies too.
  expect(store.getView().lastSeq).toBe(1);
  host.emit({ ...Object(notice(2, "boot-engine-0002")), type: "money.changed", payload: { status: { ...host.money, spentMicros: 4242 } } });
  await sleep(10);
  expect(store.getView().money).toMatchObject({ spentMicros: 4242 });
  stop();
});

test("offline is not a dead end: reconnect reloads the snapshot and live events apply again", async () => {
  let fail = false;
  const host = await fakeHost({ snapshotFails: () => fail });
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(10);

  fail = true;
  host.emit(notice(1, "boot-engine-0002")); // the engine restarts while main cannot answer
  await sleep(10);
  expect(store.getView().phase).toBe("offline");

  fail = false;
  store.reconnect();
  await sleep(10);
  expect(store.getView().phase).toBe("ready");

  host.emit({ ...Object(notice(1, "boot-engine-0001")), type: "money.changed", payload: { status: { ...host.money, spentMicros: 777 } } });
  await sleep(10);
  expect(store.getView().money).toMatchObject({ spentMicros: 777 });
  stop();
});

test("offline after a failed reload also recovers through reconnect", async () => {
  let fail = false;
  const host = await fakeHost({ snapshotFails: () => fail });
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(10);
  fail = true;
  store.reload();
  await sleep(10);
  expect(store.getView().phase).toBe("offline");
  fail = false;
  store.reconnect();
  await sleep(10);
  expect(store.getView().phase).toBe("ready");
  stop();
});

test("a clock set backwards does not lock the automatic budget: the store still recovers on its own", async () => {
  let now = 50_000_000;
  let boot = 1;
  const bootId = (n: number): string => `boot-engine-${String(n).padStart(4, "0")}`;
  const host = await fakeHost({ bootId: () => bootId(boot) });
  const store = new EngineStore(createEngineClient(host.bridge, "window"), { now: () => now });
  const stop = store.start();
  await sleep(5);

  // Three real restarts fill the automatic budget.
  for (let i = 0; i < 3; i++) {
    boot += 1;
    host.emit(notice(1, bootId(boot)));
    await sleep(5);
  }
  expect(store.getView()).toMatchObject({ phase: "ready", bootId: bootId(4) });

  // Twenty seconds pass, then the clock is set back an hour.
  now += 20_000 - 3_600_000;
  boot += 1;
  host.emit(notice(1, bootId(boot)));
  await sleep(5);
  expect(host.counts.snapshot).toBe(5);
  expect(store.getView()).toMatchObject({ phase: "ready", bootId: bootId(5) });
  stop();
});

test("the store remembers at most 64 stale bootIds, oldest out first", async () => {
  const host = await fakeHost();
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  // 70 foreign bootIds arrive while the first snapshot is on its way: one snapshot refutes them all.
  const foreign = (n: number): string => `boot-ghost-${String(n).padStart(4, "0")}`;
  for (let n = 1; n <= 70; n++) host.emit(notice(1, foreign(n)));
  await sleep(10);
  expect(host.counts.snapshot).toBe(2);
  expect(store.getView().phase).toBe("ready");

  // Replaying the batch costs nothing: the last snapshot's refutations always hold.
  for (let n = 1; n <= 70; n++) host.emit(notice(2, foreign(n)));
  await sleep(5);
  expect(host.counts.snapshot).toBe(2);

  host.emit(notice(1, foreign(71))); // one more ghost: one more snapshot
  await sleep(5);
  expect(host.counts.snapshot).toBe(3);

  host.emit(notice(3, foreign(70))); // among the 64 kept
  await sleep(5);
  expect(host.counts.snapshot).toBe(3);

  host.emit(notice(3, foreign(1))); // the oldest, evicted by the cap: asked once more
  await sleep(5);
  expect(host.counts.snapshot).toBe(4);
  expect(store.getView().phase).toBe("ready");
  stop();
});

test("a retry forgets the stale bootIds", async () => {
  const host = await fakeHost();
  const store = new EngineStore(createEngineClient(host.bridge, "window"));
  const stop = store.start();
  await sleep(5);
  host.emit(notice(1, "boot-ghost-0001"));
  await sleep(5);
  expect(host.counts.snapshot).toBe(2);
  host.emit(notice(2, "boot-ghost-0001"));
  await sleep(5);
  expect(host.counts.snapshot).toBe(2);

  store.reload();
  await sleep(5);
  expect(host.counts.snapshot).toBe(3);
  host.emit(notice(3, "boot-ghost-0001"));
  await sleep(5);
  expect(host.counts.snapshot).toBe(4);
  stop();
});
