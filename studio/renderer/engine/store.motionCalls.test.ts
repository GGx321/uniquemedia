import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, type CommandMessage, type UnsequencedEvent } from "../../shared/engine";
import { createEngineClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore, motionCallRunning, motionCallsOf } from "./store";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3, I5.68; README §S5.WCD «Для WC1 / WC3 / WC5»): the window remembers the vision and translator calls it sent until they are answered, avatar → {photo, kind}. A sheet opened
// again while its photo's call runs says so, and «Оживить» of any sheet waits while any call runs (the engine's `motion-busy` is GLOBAL). It is NOT the avatar's paid lock: a photo run goes on meanwhile.

const RAW_BOOT = "boot-raw-motions";
const ZOE = "avatar-zoe-0001";
const MIA = "avatar-mia-0001";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A store on a scripted bridge, so a test can emit exactly the event it needs. */
async function rawHost() {
  const base = await mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })).request("engine.snapshot", {});
  if (!base.ok) throw new Error(`expected ok, got ${base.error.code}`);
  const snapshot = { ...base.result, bootId: RAW_BOOT, lastSeq: 0, jobs: [] };
  let seq = 0;
  const listeners = new Set<(e: unknown) => void>();
  const bridge = {
    async request(cmd: CommandMessage): Promise<unknown> {
      const head = { v: PROTOCOL_VERSION, id: cmd.id, kind: "response" as const, type: cmd.type };
      if (cmd.type === "engine.snapshot") return { ...head, ok: true, result: { ...snapshot, lastSeq: seq } };
      return { ...head, ok: false, error: { code: "INTERNAL" as const } };
    },
    subscribe(l: (e: unknown) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const store = new EngineStore(createEngineClient(bridge, "window"));
  store.start();
  await settle();
  return {
    store,
    emit: async (event: Omit<UnsequencedEvent, "v" | "id" | "kind">) => {
      seq += 1;
      const message = { v: PROTOCOL_VERSION, id: `evt-${String(seq).padStart(8, "0")}`, kind: "event" as const, seq, bootId: RAW_BOOT, ...event };
      for (const l of [...listeners]) l(message);
      await settle();
    },
  };
}

test("no call runs at first", async () => {
  const { store } = await rawHost();
  const view = store.getView();
  expect(view.motionCalls.size).toBe(0);
  expect(motionCallRunning(view)).toBe(false);
  expect(motionCallsOf(view, ZOE, "photo-1")).toEqual([]);
});

test("a call is kept by avatar with its photo and kind until it ends; another photo's and another kind's stay", async () => {
  const { store } = await rawHost();
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "suggest" }, true);
  store.setMotionCall(ZOE, { photoId: "photo-2", kind: "idea" }, true);
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "idea" }, true);
  let view = store.getView();
  expect(view.motionCalls.get(ZOE)).toEqual([
    { photoId: "photo-1", kind: "suggest" },
    { photoId: "photo-2", kind: "idea" },
    { photoId: "photo-1", kind: "idea" },
  ]);
  expect(motionCallsOf(view, ZOE, "photo-1")).toEqual(["suggest", "idea"]);
  expect(motionCallsOf(view, ZOE, "photo-2")).toEqual(["idea"]);
  expect(motionCallsOf(view, MIA, "photo-1")).toEqual([]);
  expect(motionCallRunning(view)).toBe(true);

  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "suggest" }, false);
  view = store.getView();
  expect(motionCallsOf(view, ZOE, "photo-1")).toEqual(["idea"]);
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "idea" }, false);
  store.setMotionCall(ZOE, { photoId: "photo-2", kind: "idea" }, false);
  view = store.getView();
  // The avatar's entry goes with its last call: nothing runs.
  expect(view.motionCalls.has(ZOE)).toBe(false);
  expect(motionCallRunning(view)).toBe(false);
});

test("any avatar's call counts as running (the engine's guard is global)", async () => {
  const { store } = await rawHost();
  store.setMotionCall(MIA, { photoId: "photo-9", kind: "suggest" }, true);
  expect(motionCallRunning(store.getView())).toBe(true);
  expect(motionCallsOf(store.getView(), ZOE, "photo-9")).toEqual([]);
});

test("the same call told twice is one call, and ending one that is not running changes nothing", async () => {
  const { store } = await rawHost();
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "suggest" }, true);
  const once = store.getView();
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "suggest" }, true);
  expect(store.getView()).toBe(once);
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "idea" }, false);
  store.setMotionCall(MIA, { photoId: "photo-1", kind: "suggest" }, false);
  expect(store.getView()).toBe(once);
  expect(store.getView().motionCalls.get(ZOE)).toEqual([{ photoId: "photo-1", kind: "suggest" }]);
});

test("it is not the avatar's paid lock: a photo run of the avatar is not held by it", async () => {
  const { store } = await rawHost();
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "suggest" }, true);
  expect(store.getView().paidInFlightAvatars.has(ZOE)).toBe(false);
  store.setPaidInFlight(ZOE, true);
  store.setPaidInFlight(ZOE, false);
  expect(store.getView().motionCalls.get(ZOE)).toEqual([{ photoId: "photo-1", kind: "suggest" }]);
});

test("an avatar deleted for good takes its calls with it; another avatar's stay", async () => {
  const { store, emit } = await rawHost();
  store.setMotionCall(ZOE, { photoId: "photo-1", kind: "suggest" }, true);
  store.setMotionCall(MIA, { photoId: "photo-9", kind: "idea" }, true);
  await emit({ type: "avatar.removed", payload: { avatarId: ZOE } });
  const view = store.getView();
  expect(view.motionCalls.has(ZOE)).toBe(false);
  expect(motionCallsOf(view, MIA, "photo-9")).toEqual(["idea"]);
});
