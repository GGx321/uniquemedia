import { afterEach, expect, test } from "bun:test";
import { type CommandMessage, type MoneyStatus, PROTOCOL_VERSION } from "../../shared/engine";
import { readStudioVersion, readWindowBridge, windowStudioClient } from "./windowStudio";

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
