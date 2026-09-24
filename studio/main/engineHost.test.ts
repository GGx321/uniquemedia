import { describe, expect, test } from "bun:test";
import type { AvatarTraits, EngineCommandMessage, EngineError, EventMessage, ResponseMessage } from "../shared/engine";
import { DESCRIPTOR_MAX_ATTEMPTS } from "../engine/avatars/descriptor";
import { COMMAND_DEADLINE_MS, type EngineInit } from "../engine/control";
import { PRICE_FETCH_TIMEOUT_MS } from "../engine/money/prices";
import { MAX_ATTEMPT_MS } from "../engine/openrouter/transport";
import { EngineHost, REQUEST_TIMEOUT_MS, type EngineChild, type HostPort } from "./engineHost";

const KEY = "sk-or-v1-0123456789abcdef-wxyz";

const INIT: EngineInit = {
  kind: "control",
  type: "init",
  ledgerPath: "/tmp/userData/ledger.jsonl",
  defaultLibraryPath: "/tmp/userData/library",
  rawDir: "/tmp/userData/raw",
  settings: {
    monthlyBudgetMicros: 10_000_000,
    libraryPath: "/tmp/userData/library",
    imageModel: "x-ai/grok-imagine-image-2.0",
    textModel: "x-ai/grok-4.3",
    concurrency: { network: 6 },
  },
  encryptionAvailable: true,
  notices: [],
};

/** The engine's end of the channel: what main posted, and a way to answer. */
class FakePort implements HostPort {
  readonly posted: unknown[] = [];
  closed = false;
  started = false;
  #listener: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  on(_event: "message", listener: (event: { data: unknown }) => void): void {
    this.#listener = listener;
  }
  start(): void {
    this.started = true;
  }
  close(): void {
    this.closed = true;
  }
  /** Delivers a message from the engine to main. */
  fromEngine(data: unknown): void {
    this.#listener?.({ data });
  }
}

class FakeChild implements EngineChild<string> {
  readonly posted: { message: unknown; transfer: string[] }[] = [];
  killed = false;
  #onExit: ((code: number) => void) | null = null;

  postMessage(message: unknown, transfer: string[]): void {
    this.posted.push({ message, transfer });
  }
  once(_event: "exit", listener: (code: number) => void): void {
    this.#onExit = listener;
  }
  kill(): boolean {
    this.killed = true;
    this.#onExit?.(0);
    return true;
  }
  crash(code: number): void {
    this.#onExit?.(code);
  }
}

/** A manual clock for the host's timers: `advance` fires what falls due, in order. */
class FakeTimers {
  now = 0;
  #next = 0;
  #pending: { id: number; at: number; fn: () => void }[] = [];

  set(fn: () => void, ms: number): number {
    const id = ++this.#next;
    this.#pending.push({ id, at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.#pending = this.#pending.filter((t) => t.id !== handle);
  }
  get count(): number {
    return this.#pending.length;
  }
  /** Moves the clock and runs every timer that falls due, then lets promise continuations settle. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.#pending.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#pending = this.#pending.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
      await Bun.sleep(0);
    }
    this.now = until;
    await Bun.sleep(0);
  }
}

function setup(options: { key?: () => string | null; fork?: () => FakeChild; init?: () => Promise<EngineInit> } = {}) {
  const children: FakeChild[] = [];
  const ports: FakePort[] = [];
  const events: EventMessage[] = [];
  const exits: { error: EngineError; restarting: boolean }[] = [];
  const timers = new FakeTimers();
  const host = new EngineHost<string>({
    fork: options.fork ?? (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }),
    channel: () => {
      const port = new FakePort();
      ports.push(port);
      return { local: port, remote: `remote-port-${ports.length}` };
    },
    init: options.init ?? (async () => INIT),
    apiKey: async () => (options.key ? options.key() : null),
    onEvent: (event) => events.push(event),
    onExit: (error, restarting) => exits.push({ error, restarting }),
    timers,
  });
  /** Ends the restart backoff (1 s) and lets the relaunch finish. */
  const endBackoff = () => timers.advance(1000);
  return { host, children, ports, events, exits, timers, endBackoff };
}

let n = 0;
function command(type: "engine.snapshot" | "settings.get" = "settings.get"): EngineCommandMessage {
  return { v: 1, id: `cmd-${String(++n).padStart(8, "0")}`, kind: "command", type, payload: {} };
}

function settingsResponse(id: string, last4: string | null = null): ResponseMessage {
  return {
    v: 1,
    id,
    kind: "response",
    type: "settings.get",
    ok: true,
    result: {
      apiKey: { stored: last4 !== null, last4, encryptionAvailable: true, rejected: false },
      ...INIT.settings,
    },
  };
}

describe("startup", () => {
  test("forks, hands the remote port over with init, and sends the key over the port", async () => {
    const { host, children, ports } = setup({ key: () => KEY });
    await host.start();
    expect(host.phase).toBe("running");
    expect(children[0]?.posted).toEqual([{ message: INIT, transfer: ["remote-port-1"] }]);
    expect(ports[0]?.started).toBe(true);
    expect(ports[0]?.posted).toEqual([{ kind: "control", type: "apiKey.set", key: KEY }]);
  });

  test("without a stored key nothing but init is sent, and the key never travels with init", async () => {
    const { host, children, ports } = setup();
    await host.start();
    expect(ports[0]?.posted).toEqual([]);
    expect(JSON.stringify(children[0]?.posted)).not.toContain("sk-or-");
  });

  test("a fork that throws counts as a crash and is retried once", async () => {
    let attempts = 0;
    const child = new FakeChild();
    const { host, exits, endBackoff } = setup({
      fork: () => {
        attempts++;
        if (attempts === 1) throw new Error("spawn failed");
        return child;
      },
    });
    await host.start();
    expect(host.phase).toBe("restarting");
    expect(exits).toEqual([{ error: { code: "INTERNAL", detail: "the engine could not be started: spawn failed; restarting it" }, restarting: true }]);
    await endBackoff();
    expect(host.phase).toBe("running");
  });
});

describe("requests", () => {
  test("a command is posted on the port and resolved by the response with the same id", async () => {
    const { host, ports } = setup();
    await host.start();
    const cmd = command();
    const pending = host.request(cmd);
    await Bun.sleep(0);
    expect(ports[0]?.posted).toEqual([cmd]);
    ports[0]?.fromEngine(settingsResponse(cmd.id));
    expect(await pending).toEqual(settingsResponse(cmd.id));
  });

  test("a response that breaks the contract becomes INTERNAL for its command", async () => {
    const { host, ports } = setup();
    await host.start();
    const cmd = command();
    const pending = host.request(cmd);
    await Bun.sleep(0);
    ports[0]?.fromEngine({ v: 1, id: cmd.id, kind: "response", type: "settings.get", ok: true, result: { nope: 1 } });
    expect(await pending).toMatchObject({ ok: false, id: cmd.id, error: { code: "INTERNAL" } });
  });

  test("a response of another command's type becomes INTERNAL", async () => {
    const { host, ports } = setup();
    await host.start();
    const cmd = command("engine.snapshot");
    const pending = host.request(cmd);
    await Bun.sleep(0);
    ports[0]?.fromEngine(settingsResponse(cmd.id));
    expect(await pending).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "the engine answered with another command's type" } });
  });

  test("a second command with an id still in flight is refused", async () => {
    const { host } = setup();
    await host.start();
    const cmd = command();
    void host.request(cmd);
    await Bun.sleep(0);
    expect(await host.request(cmd)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  test("commands sent before start wait for the engine", async () => {
    const { host, ports } = setup();
    const cmd = command();
    const pending = host.request(cmd);
    await host.start();
    await Bun.sleep(0);
    expect(ports[0]?.posted).toEqual([cmd]);
    ports[0]?.fromEngine(settingsResponse(cmd.id));
    expect((await pending).ok).toBe(true);
  });

  test("valid events are passed on; invalid ones are dropped", async () => {
    const { host, ports, events } = setup();
    await host.start();
    const event: EventMessage = { v: 1, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "engine.error", payload: { error: { code: "INTERNAL" } } };
    ports[0]?.fromEngine(event);
    ports[0]?.fromEngine({ ...event, seq: 0 });
    expect(events).toEqual([event]);
  });
});

describe("restart policy", () => {
  test("an unexpected exit fails waiting commands, is surfaced, and restarts the engine once with the key re-sent", async () => {
    let key: string | null = KEY;
    const { host, children, ports, exits, timers, endBackoff } = setup({ key: () => key });
    await host.start();

    const cmd = command();
    const pending = host.request(cmd);
    await Bun.sleep(0);
    children[0]?.crash(9);

    expect(await pending).toMatchObject({ ok: false, id: cmd.id, error: { code: "INTERNAL", detail: "the engine exited before answering" } });
    expect(exits).toEqual([{ error: { code: "INTERNAL", detail: "the engine exited unexpectedly (code 9); restarting it" }, restarting: true }]);
    expect(host.phase).toBe("restarting");
    expect(ports[0]?.closed).toBe(true);
    await timers.advance(999);
    expect(children).toHaveLength(1);

    // The key rotated during the backoff: the new engine gets the current one.
    key = "sk-or-v1-rotated-key-9876";
    await endBackoff();
    expect(host.phase).toBe("running");
    expect(children).toHaveLength(2);
    expect(children[1]?.posted).toEqual([{ message: INIT, transfer: ["remote-port-2"] }]);
    expect(ports[1]?.posted).toEqual([{ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-9876" }]);
  });

  test("commands sent during the backoff go to the restarted engine", async () => {
    const { host, children, ports, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    const cmd = command();
    const pending = host.request(cmd);
    await endBackoff();
    await Bun.sleep(0);
    expect(ports[1]?.posted).toEqual([cmd]);
    ports[1]?.fromEngine(settingsResponse(cmd.id));
    expect((await pending).ok).toBe(true);
  });

  test("a second unexpected exit is final: surfaced, no restart, commands answer INTERNAL", async () => {
    const { host, children, exits, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    children[1]?.crash(2);

    expect(host.phase).toBe("failed");
    expect(children).toHaveLength(2);
    expect(exits[1]).toEqual({ error: { code: "INTERNAL", detail: "the engine exited unexpectedly (code 2); not restarted again" }, restarting: false });
    expect(await host.request(command())).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "the engine is not running" } });
  });

  test("stop kills the engine without a restart or an exit report", async () => {
    const { host, children, exits } = setup();
    await host.start();
    const pending = host.request(command());
    await Bun.sleep(0);
    host.stop();
    expect(children[0]?.killed).toBe(true);
    expect(host.phase).toBe("stopped");
    expect(exits).toEqual([]);
    expect(await pending).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});

describe("key control messages", () => {
  test("go straight to a running engine", async () => {
    const { host, ports } = setup();
    await host.start();
    host.send({ kind: "control", type: "apiKey.set", key: KEY });
    host.send({ kind: "control", type: "apiKey.clear" });
    expect(ports[0]?.posted).toEqual([
      { kind: "control", type: "apiKey.set", key: KEY },
      { kind: "control", type: "apiKey.clear" },
    ]);
  });

  test("sent during a restart, they follow the startup messages, so the last change wins", async () => {
    let key: string | null = KEY;
    const { host, children, ports, endBackoff } = setup({ key: () => key });
    await host.start();
    children[0]?.crash(1);
    key = null;
    host.send({ kind: "control", type: "apiKey.clear" });
    await endBackoff();
    expect(ports[1]?.posted).toEqual([{ kind: "control", type: "apiKey.clear" }]);
  });

  test("are dropped once the engine is gone for good", async () => {
    const { host, children, ports, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    children[1]?.crash(1);
    host.send({ kind: "control", type: "apiKey.set", key: KEY });
    expect(ports.flatMap((p) => p.posted)).toEqual([]);
  });
});

describe("request deadline", () => {
  test("an engine that never answers gets INTERNAL after 30 s, and its late answer is dropped", async () => {
    const { host, ports, timers } = setup();
    await host.start();
    const cmd = command();
    let settled: ResponseMessage | null = null;
    void host.request(cmd).then((r) => (settled = r));
    await timers.advance(29_999);
    expect(settled).toBeNull();
    await timers.advance(1);
    expect(settled).toMatchObject({ ok: false, id: cmd.id, error: { code: "INTERNAL", detail: "the engine did not answer within 30 s" } });

    ports[0]?.fromEngine(settingsResponse(cmd.id));
    expect(settled).toMatchObject({ ok: false });
    // The id is free again.
    const again = host.request(cmd);
    await Bun.sleep(0);
    ports[0]?.fromEngine(settingsResponse(cmd.id));
    expect((await again).ok).toBe(true);
  });

  function createDraft(): EngineCommandMessage {
    const traits: AvatarTraits = {
      age: 25, ethnicity: "european", skinTone: "light", hairColor: "black", hairLength: "long",
      hairTexture: "wavy", eyeColor: "blue", build: "slim", marks: [], vibe: "",
    };
    return { v: 1, id: `cmd-${String(++n).padStart(8, "0")}`, kind: "command", type: "avatars.createDraft", payload: { traits, acceptedWorstMicros: 207_500 } };
  }

  test("avatars.createDraft is not failed at 30 s: main waits out its own deadline, then answers INTERNAL", async () => {
    const deadline = COMMAND_DEADLINE_MS["avatars.createDraft"] ?? 0;
    const { host, timers } = setup();
    await host.start();
    const cmd = createDraft();
    let settled: ResponseMessage | null = null;
    void host.request(cmd).then((r) => (settled = r));

    await timers.advance(REQUEST_TIMEOUT_MS);
    expect(settled).toBeNull();
    await timers.advance(deadline - REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await timers.advance(1);
    expect(settled).toMatchObject({ ok: false, id: cmd.id, error: { code: "INTERNAL", detail: `the engine did not answer within ${deadline / 1000} s` } });
  });

  test("the createDraft deadline covers a price load and every descriptor attempt at its slowest, plus slack", () => {
    // One attempt: three HTTP tries to their 180 s timeout and two retry waits at the 60 s Retry-After cap plus 1 s jitter.
    expect(MAX_ATTEMPT_MS).toBe(3 * 180_000 + 2 * 61_000);
    expect(COMMAND_DEADLINE_MS["avatars.createDraft"]).toBe(PRICE_FETCH_TIMEOUT_MS + DESCRIPTOR_MAX_ATTEMPTS * MAX_ATTEMPT_MS + 30_000);
  });

  test("the estimates wait for a price load that times out, so the fallback estimate is not lost to main's deadline", () => {
    expect(COMMAND_DEADLINE_MS["avatars.estimate"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
    expect(COMMAND_DEADLINE_MS["avatars.estimateCandidates"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
  });

  test("an init that never finishes cannot hang a request", async () => {
    const { host, timers } = setup({ init: () => new Promise<EngineInit>(() => {}) });
    void host.start();
    const pending = host.request(command());
    await timers.advance(30_000);
    expect(await pending).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "the engine did not answer within 30 s" } });
  });

  test("an answered request leaves no timer behind", async () => {
    const { host, ports, timers } = setup();
    await host.start();
    const before = timers.count;
    const cmd = command();
    const pending = host.request(cmd);
    await Bun.sleep(0);
    ports[0]?.fromEngine(settingsResponse(cmd.id));
    await pending;
    expect(timers.count).toBe(before);
  });
});

describe("healthy running", () => {
  test("after 5 minutes of healthy running the restart allowance is back", async () => {
    const { host, children, exits, timers, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    await timers.advance(5 * 60_000);
    children[1]?.crash(2);
    expect(host.phase).toBe("restarting");
    expect(exits.at(-1)?.restarting).toBe(true);
    await endBackoff();
    expect(host.phase).toBe("running");
    expect(children).toHaveLength(3);
  });

  test("a crash before 5 healthy minutes after a restart is final", async () => {
    const { host, children, timers, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    await timers.advance(5 * 60_000 - 1);
    children[1]?.crash(2);
    expect(host.phase).toBe("failed");
  });
});

describe("calls to the engine (library.open)", () => {
  test("posts the call with an id and resolves with the engine's reply", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.openLibrary("/Users/me/Studio");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "library.open", path: "/Users/me/Studio" });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId });
    expect(await pending).toBeNull();
  });

  test("an error reply is passed on", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.openLibrary("/Users/me/Studio");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "VALIDATION", detail: "not a library" } });
    expect(await pending).toEqual({ code: "VALIDATION", detail: "not a library" });
  });

  test("no reply within 30 s is INTERNAL; a late reply is dropped", async () => {
    const { host, ports, timers } = setup();
    await host.start();
    const pending = host.openLibrary("/Users/me/Studio");
    await timers.advance(30_000);
    expect(await pending).toEqual({ code: "INTERNAL", detail: "the engine did not answer within 30 s" });
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId });
  });

  test("an engine that exits while the call waits answers INTERNAL, and so does a failed one", async () => {
    const { host, children, endBackoff } = setup();
    await host.start();
    const pending = host.openLibrary("/Users/me/Studio");
    await Bun.sleep(0);
    children[0]?.crash(1);
    expect(await pending).toMatchObject({ code: "INTERNAL" });
    await endBackoff();
    children[1]?.crash(1);
    expect(await host.openLibrary("/Users/me/Studio")).toEqual({ code: "INTERNAL", detail: "the engine is not running" });
  });
});
