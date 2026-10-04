import { afterEach, expect, test } from "bun:test";
import { type CommandMessage, type MoneyStatus, PROTOCOL_VERSION } from "../../shared/engine";
import { onFlushRequest, quitWithoutSaving, readStudioVersion, readWindowBridge, windowStudioClient } from "./windowStudio";

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

const MONEY: MoneyStatus = {
  ledger: "open",
  month: "2026-09",
  spentMicros: 1_000,
  monthlyBudgetMicros: 10_000_000,
  unsettledMicros: 0,
  unsettledCount: 0,
  reconcileNeeded: false,
  reconcileReasons: [],
  halt: null,
};

function install(respond: (command: CommandMessage) => unknown): { sent: CommandMessage[]; emit: (e: unknown) => void } {
  const sent: CommandMessage[] = [];
  let listener: ((e: unknown) => void) | null = null;
  Reflect.set(window, "studio", {
    version: async () => "0.1.0",
    request: async (command: CommandMessage) => {
      sent.push(command);
      return respond(command);
    },
    subscribe: (l: (e: unknown) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  });
  return { sent, emit: (e) => listener?.(e) };
}

function okMoney(command: CommandMessage): unknown {
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: MONEY };
}

test("no bridge until the preload exposes request and subscribe", () => {
  expect(readWindowBridge()).toBeNull();
  Reflect.set(window, "studio", { version: async () => "0.1.0" });
  expect(readWindowBridge()).toBeNull();
  expect(windowStudioClient()).toBeNull();
});

test("a command goes out as a contract message and its typed result comes back", async () => {
  const { sent } = install(okMoney);
  const client = windowStudioClient();
  if (!client) throw new Error("expected a client");
  expect(client.kind).toBe("window");
  const reply = await client.request("money.status", {});
  expect(reply).toEqual({ ok: true, result: MONEY });
  expect(sent[0]).toMatchObject({ v: PROTOCOL_VERSION, kind: "command", type: "money.status", payload: {} });
});

test("an invalid payload never leaves the renderer", async () => {
  const { sent } = install(okMoney);
  const client = windowStudioClient();
  if (!client) throw new Error("expected a client");
  const reply = await client.request("settings.setBudget", { monthlyBudgetMicros: 1.5 });
  expect(reply.ok).toBe(false);
  if (!reply.ok) expect(reply.error.code).toBe("VALIDATION");
  expect(sent).toHaveLength(0);
});

test("a response that breaks the contract, belongs to another command or has another type is INTERNAL", async () => {
  const cases: ((c: CommandMessage) => unknown)[] = [
    (c) => ({ v: PROTOCOL_VERSION, id: c.id, kind: "response", type: c.type, ok: true, result: { ...MONEY, spentMicros: 0.5 } }),
    (c) => ({ v: PROTOCOL_VERSION, id: "someone-else-000", kind: "response", type: c.type, ok: true, result: MONEY }),
    (c) => ({ v: PROTOCOL_VERSION, id: c.id, kind: "response", type: "avatars.list", ok: true, result: { avatars: [] } }),
    () => "not a message",
  ];
  for (const respond of cases) {
    install(respond);
    const client = windowStudioClient();
    if (!client) throw new Error("expected a client");
    const reply = await client.request("money.status", {});
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("INTERNAL");
  }
});

test("an engine error comes back as the error, with the key redacted from its detail", async () => {
  install((c) => ({
    v: PROTOCOL_VERSION,
    id: c.id,
    kind: "response",
    type: c.type,
    ok: false,
    error: { code: "AUTH_INVALID", detail: "401 for sk-or-v1-abcdef0123456789" },
  }));
  const client = windowStudioClient();
  if (!client) throw new Error("expected a client");
  const reply = await client.request("money.status", {});
  expect(reply.ok).toBe(false);
  if (!reply.ok) {
    expect(reply.error.code).toBe("AUTH_INVALID");
    expect(reply.error.detail).not.toContain("sk-or");
  }
});

test("a bridge that throws is INTERNAL, not a crash", async () => {
  install(() => {
    throw new Error("ipc closed");
  });
  const client = windowStudioClient();
  if (!client) throw new Error("expected a client");
  const reply = await client.request("money.status", {});
  expect(reply).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
});

test("events are parsed; malformed ones are dropped; unsubscribe stops delivery", () => {
  const { emit } = install(okMoney);
  const client = windowStudioClient();
  if (!client) throw new Error("expected a client");
  const seen: number[] = [];
  const off = client.subscribe((e) => seen.push(e.seq));
  const event = { v: PROTOCOL_VERSION, id: "evt-0001", kind: "event", seq: 1, bootId: "boot-0001", type: "money.changed", payload: { status: MONEY } };
  emit(event);
  emit({ ...event, seq: 0 });
  emit({ ...event, seq: 2, type: "unknown.event" });
  off();
  emit({ ...event, seq: 3 });
  expect(seen).toEqual([1]);
});

test("the version is read through the bridge", async () => {
  await expect(readStudioVersion()).rejects.toThrow();
  install(okMoney);
  expect(await readStudioVersion()).toBe("0.1.0");
});

// 3d.2 review, HIGH 2: before quitting, main asks the window to save what the owner is editing.
test("a flush handler is handed to the bridge, and the function it returns removes it", () => {
  const handlers = new Set<() => Promise<boolean>>();
  Reflect.set(window, "studio", {
    onFlushRequest: (handler: () => Promise<boolean>) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });
  const handler = async (): Promise<boolean> => true;
  const off = onFlushRequest(handler);
  expect([...handlers]).toEqual([handler]);
  off();
  expect(handlers.size).toBe(0);
});

test("quitting without saving goes to the bridge, and is a no-op without one", () => {
  expect(() => quitWithoutSaving()).not.toThrow();
  let asked = 0;
  Reflect.set(window, "studio", { quitWithoutSaving: () => void (asked += 1) });
  quitWithoutSaving();
  expect(asked).toBe(1);
});

test("without a bridge (a browser, an older preload) asking for flushes is a no-op", () => {
  const off = onFlushRequest(async () => true);
  expect(() => off()).not.toThrow();
  Reflect.set(window, "studio", { version: async () => "0.1.0" });
  expect(() => onFlushRequest(async () => true)()).not.toThrow();
});

// 3f.6 round 2 (M13): files dropped onto «Мои». The window hands the preload's `importDropped` the dropped `File` objects themselves and
// nothing else; the answer crosses a trust boundary, so it is checked against a pick's result before the tab sees it.
function installDrop(answer: (files: unknown) => unknown): unknown[] {
  const given: unknown[] = [];
  install(okMoney);
  const studio: unknown = Reflect.get(window, "studio");
  if (typeof studio !== "object" || studio === null) throw new Error("no bridge");
  Reflect.set(studio, "importDropped", async (files: unknown) => {
    given.push(files);
    return answer(files);
  });
  return given;
}

test("a drop hands the preload the File objects themselves, and a pick's answer comes back checked", async () => {
  const given = installDrop(() => ({ ok: true, result: { picked: true, jobIds: ["job-00000001"], refused: [{ name: "track.wma", reason: "format" }], skipped: 0 } }));
  const client = windowStudioClient();
  const file = new File(["a"], "beach.jpg", { type: "image/jpeg" });
  const reply = await client?.importDropped?.([file]);
  expect(given).toEqual([[file]]);
  expect(reply).toEqual({ ok: true, result: { picked: true, jobIds: ["job-00000001"], refused: [{ name: "track.wma", reason: "format" }], skipped: 0 } });
});

test("a refusal comes back as the engine's error", async () => {
  installDrop(() => ({ ok: false, error: { code: "IN_FLIGHT", detail: "another import is being picked" } }));
  expect(await windowStudioClient()?.importDropped?.([new File(["a"], "a.jpg")])).toEqual({ ok: false, error: { code: "IN_FLIGHT", detail: "another import is being picked" } });
});

test("an answer that breaks the contract, or a bridge that throws, is INTERNAL (never shown as a result)", async () => {
  for (const bad of [null, "ok", { ok: true }, { ok: true, result: { picked: true, jobIds: [], refused: [{ name: "a", reason: "nope" }], skipped: 0 } }, { ok: true, result: { picked: false }, path: "/x" }]) {
    installDrop(() => bad);
    const reply = await windowStudioClient()?.importDropped?.([new File(["a"], "a.jpg")]);
    expect(reply?.ok === false ? reply.error.code : "ok").toBe("INTERNAL");
  }
  installDrop(() => {
    throw new Error("bridge gone");
  });
  const thrown = await windowStudioClient()?.importDropped?.([new File(["a"], "a.jpg")]);
  expect(thrown?.ok === false ? thrown.error.code : "ok").toBe("INTERNAL");
});

test("a preload without the drop door gives a client without one: the tab then offers the dialog only", () => {
  install(okMoney);
  expect(windowStudioClient()?.importDropped).toBeUndefined();
});
