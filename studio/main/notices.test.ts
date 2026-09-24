import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type EngineError, type EventMessage, type ResponseMessage } from "../shared/engine";
import type { EngineInit } from "../engine/control";
import { Engine } from "../engine/engine";
import { createEngineClient, type EngineBridge } from "../renderer/engine/client";
import { EngineStore } from "../renderer/engine/store";
import { HostNotices } from "./notices";
import { handleRendererRequest, type SenderFrame, type TrustedRenderer } from "./requests";

// A real engine and the renderer's real EngineStore, joined through main's
// request path (handleRendererRequest + HostNotices) with asynchronous event
// delivery like IPC. Counts the store's engine.snapshot requests: a notice
// must land in the store's engineError without ever making it resync in a loop.

const FILE_URL = "file:///app/out-studio/renderer/index.html";
const TRUSTED: TrustedRenderer = { fileUrl: FILE_URL };
const FRAME: SenderFrame = { url: FILE_URL, isTopFrame: true, isAppWindow: true };
const CORRUPT: EngineError = { code: "INTERNAL", detail: "settings.json was corrupt; defaults are in use" };
const CRASH: EngineError = { code: "INTERNAL", detail: "the engine exited unexpectedly (code 9); restarting it" };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-notices-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function init(): EngineInit {
  return {
    kind: "control",
    type: "init",
    ledgerPath: join(dir, "ledger.jsonl"),
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(dir, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
    },
    encryptionAvailable: true,
  };
}

const settle = (ms = 60) => Bun.sleep(ms);

async function harness() {
  const listeners = new Set<(event: unknown) => void>();
  /** Like IPC: an event reaches the window later, never inside the call that emitted it. */
  const deliver = (event: unknown) => setTimeout(() => listeners.forEach((l) => l(event)), 0);
  let n = 0;
  let engine: Engine;
  const startEngine = async (bootId: string) => {
    engine = await Engine.start(init(), {
      bootId,
      clock: Date.now,
      monotonic: () => performance.now(),
      newId: () => `id-${bootId}-${String(++n).padStart(6, "0")}`,
      post: (message) => {
        if (message.kind === "event") deliver(message);
      },
    });
  };
  await startEngine("boot-aaaa-0001");
  const notices = new HostNotices((control) => void engine.receive(control));
  let snapshots = 0;
  /** Main's hook after every response; the old design used it to replay host events. */
  let afterResponse = (response: ResponseMessage) => notices.seen(response);

  const bridge: EngineBridge = {
    request: async (command) => {
      if (command.type === "engine.snapshot") snapshots++;
      const response = await handleRendererRequest(command, FRAME, TRUSTED, {
        mainOnly: async () => {
          throw new Error("not used");
        },
        settings: async () => {
          throw new Error("not used");
        },
        engine: (c) => engine.handle(c),
      });
      afterResponse(response);
      return response;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const store = new EngineStore(createEngineClient(bridge, "window"));
  return {
    store,
    notices,
    snapshots: () => snapshots,
    restartEngine: startEngine,
    deliver,
    replaceAfterResponse: (hook: (response: ResponseMessage) => void) => {
      afterResponse = hook;
    },
  };
}

describe("main's notices reach the renderer store as ordinary engine events", () => {
  test("a notice held from startup (corrupt settings.json) lands in engineError after the first snapshot, with one snapshot", async () => {
    const h = await harness();
    h.notices.hold(CORRUPT);
    const stop = h.store.start();
    await settle();
    expect(h.store.getView()).toMatchObject({ phase: "ready", bootId: "boot-aaaa-0001", engineError: CORRUPT });
    expect(h.snapshots()).toBe(1);
    await settle(200);
    expect(h.snapshots()).toBe(1);
    stop();
  });

  test("after an engine restart the store resyncs once and ends with the crash notice", async () => {
    const h = await harness();
    const stop = h.store.start();
    await settle();
    expect(h.snapshots()).toBe(1);

    await h.restartEngine("boot-bbbb-0002");
    h.notices.restarted(CRASH);
    await settle();

    expect(h.store.getView()).toMatchObject({ phase: "ready", bootId: "boot-bbbb-0002", engineError: CRASH });
    expect(h.snapshots()).toBe(2);
    await settle(200);
    expect(h.snapshots()).toBe(2);
    stop();
  });

  test("a notice is delivered once: later snapshots do not bring it back", async () => {
    const h = await harness();
    h.notices.hold(CORRUPT);
    const stop = h.store.start();
    await settle();
    h.store.reload();
    await settle();
    expect(h.snapshots()).toBe(2);
    expect(h.store.getView().engineError).toBeNull();
    stop();
  });

  // Control: the old design (a host event under main's own bootId, replayed
  // after every snapshot) made the store resync for a foreign bootId and never
  // showed the notice; with the store of that time it resynced without end.
  // The harness must tell the two designs apart.
  test("control: under the old design the notice never lands and the store resyncs for a bootId that is not the engine's", async () => {
    const h = await harness();
    let seq = 0;
    h.replaceAfterResponse((response) => {
      if (!response.ok || response.type !== "engine.snapshot") return;
      const event: EventMessage = {
        v: PROTOCOL_VERSION,
        id: `host-evt-${String(++seq).padStart(6, "0")}`,
        kind: "event",
        seq,
        bootId: "host-boot-0001",
        type: "engine.error",
        payload: { error: CRASH },
      };
      h.deliver(event);
    });
    const stop = h.store.start();
    await settle(200);
    stop();
    expect(h.snapshots()).toBeGreaterThan(1);
    expect(h.store.getView()).toMatchObject({ bootId: "boot-aaaa-0001", engineError: null });
  });
});
