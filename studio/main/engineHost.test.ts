import { describe, expect, test } from "bun:test";
import { ENGINE_GONE_DETAIL, type AvatarTraits, type EngineCommandMessage, type EngineError, type EventMessage, type ResponseMessage } from "../shared/engine";
import { DESCRIPTOR_MAX_ATTEMPTS } from "../engine/avatars/descriptor";
import { COMMAND_DEADLINE_MS, MEDIA_IMPORT_DEADLINE_MS, type EngineInit } from "../engine/control";
import { AVATAR_DELETE_PREPARE_DEADLINE_MS, EXPORT_CHECK_TIMEOUT_MS } from "../engine/videos/timeouts";
import { PRICE_FETCH_TIMEOUT_MS } from "../engine/money/prices";
import { CASE_PROBE_TIMEOUT_MS, DELETE_TIMEOUT_MS, LIST_BUDGET_MS, LIVE_LIBRARY_IDENTITY_TIMEOUT_MS, RECORD_CHECK_TIMEOUT_MS } from "../engine/videos/timeouts";
import { REFERENCE_TIMEOUT_MS } from "../engine/runs/timeouts";
import { MAX_ATTEMPT_MS } from "../engine/openrouter/transport";
import { EngineHost, REQUEST_TIMEOUT_MS, type EngineChild, type HostPort } from "./engineHost";
import { expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { PROTOCOL_VERSION } from "../shared/engine";
useNativeGlobals();

const KEY = "sk-or-v1-0123456789abcdef-wxyz";
const MUSIC_KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

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
    imageAgeCheck: "off",
    imageQuality: "low",
    cameraRealism: false,
    exportPath: "/tmp/userData/export",
    renderConcurrency: "auto",
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

function setup(options: { key?: () => string | null; musicKey?: () => string | null; fork?: () => FakeChild; init?: () => Promise<EngineInit> } = {}) {
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
    musicKey: async () => (options.musicKey ? options.musicKey() : null),
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
  return { v: PROTOCOL_VERSION, id: `cmd-${String(++n).padStart(8, "0")}`, kind: "command", type, payload: {} };
}

function settingsResponse(id: string, last4: string | null = null): ResponseMessage {
  return {
    v: PROTOCOL_VERSION,
    id,
    kind: "response",
    type: "settings.get",
    ok: true,
    result: {
      apiKey: { stored: last4 !== null, last4, encryptionAvailable: true, rejected: false },
      musicKey: { stored: false, last4: null, rejected: false },
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

  test("sends the music key over the port after the OpenRouter key, and never with init", async () => {
    const { host, children, ports } = setup({ key: () => KEY, musicKey: () => MUSIC_KEY });
    await host.start();
    expect(ports[0]?.posted).toEqual([
      { kind: "control", type: "apiKey.set", key: KEY },
      { kind: "control", type: "musicKey.set", key: MUSIC_KEY, origin: "start" },
    ]);
    expectNoKeyFragment(JSON.stringify(children[0]?.posted), MUSIC_KEY);
  });

  test("a music key alone is sent without any OpenRouter key", async () => {
    const { host, ports } = setup({ musicKey: () => MUSIC_KEY });
    await host.start();
    expect(ports[0]?.posted).toEqual([{ kind: "control", type: "musicKey.set", key: MUSIC_KEY, origin: "start" }]);
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
    ports[0]?.fromEngine({ v: PROTOCOL_VERSION, id: cmd.id, kind: "response", type: "settings.get", ok: true, result: { nope: 1 } });
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
    const event: EventMessage = { v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "engine.error", payload: { error: { code: "INTERNAL" } } };
    ports[0]?.fromEngine(event);
    ports[0]?.fromEngine({ ...event, seq: 0 });
    expect(events).toEqual([event]);
  });

  test("a job.failed that carries the queue's raw `cause` is dropped, never forwarded to a window", async () => {
    const { host, ports, events } = setup();
    await host.start();
    const failedJob = { kind: "render", jobId: "job-00000004", videoId: "video-00000002", avatarId: "avatar-0001", montageId: null, error: { code: "RENDER_FAILED" } };
    const event = (payload: unknown) => ({ v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "job.failed", payload });

    ports[0]?.fromEngine(event(failedJob));
    ports[0]?.fromEngine(event({ ...failedJob, cause: { path: "/Users/owner/photo.jpg", spawnargs: ["-i", "/Users/owner/photo.jpg"] } }));

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("/Users/owner");
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

  test("the music key is re-sent to the restarted engine, and the current one, not the one it had", async () => {
    let musicKey: string | null = MUSIC_KEY;
    const { host, children, ports, endBackoff } = setup({ musicKey: () => musicKey });
    await host.start();
    children[0]?.crash(9);
    musicKey = "Hb5-nRw3-Yc8d-Qj6f-9999";
    await endBackoff();
    expect(ports[1]?.posted).toEqual([{ kind: "control", type: "musicKey.set", key: "Hb5-nRw3-Yc8d-Qj6f-9999", origin: "start" }]);
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

  test("a second unexpected exit is final: surfaced, no restart, commands answer a clear dead-engine error, and open windows are told to resync (M5)", async () => {
    const { host, children, exits, events, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    children[1]?.crash(2);

    expect(host.phase).toBe("failed");
    expect(children).toHaveLength(2);
    expect(exits[1]).toEqual({ error: { code: "INTERNAL", detail: "the engine exited unexpectedly (code 2); not restarted again" }, restarting: false });
    // A fresh request answers promptly with a detail distinct from "not
    // started yet" (REQUEST_TIMEOUT_MS's own wording), so the renderer can
    // tell "dead for good" apart from a transient gap.
    expect(await host.request(command())).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } });
    // A window that was already open and synced (no pending command to
    // answer) still has to learn the engine is gone: onEvent carries a
    // contract-valid notice under a bootId no window has, so its next
    // engine.snapshot (the reboot path already in EngineStore) lands on the
    // same clear error above and the store goes offline on its own.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "event", type: "engine.error", payload: { error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } } });
    expect(typeof events[0]?.bootId).toBe("string");
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

  test("a music key set during a restart is read from the store and queued after it, so the new engine gets it once at least", async () => {
    let musicKey: string | null = null;
    const { host, children, ports, endBackoff } = setup({ musicKey: () => musicKey });
    await host.start();
    children[0]?.crash(1);
    musicKey = MUSIC_KEY;
    host.send({ kind: "control", type: "musicKey.set", key: MUSIC_KEY });
    await endBackoff();
    expect(ports[1]?.posted.at(-1)).toEqual({ kind: "control", type: "musicKey.set", key: MUSIC_KEY });
  });

  test("a music key cleared during a restart is not brought back by the new engine", async () => {
    let musicKey: string | null = MUSIC_KEY;
    const { host, children, ports, endBackoff } = setup({ musicKey: () => musicKey });
    await host.start();
    children[0]?.crash(1);
    musicKey = null;
    host.send({ kind: "control", type: "musicKey.clear" });
    await endBackoff();
    expect(ports[1]?.posted).toEqual([{ kind: "control", type: "musicKey.clear" }]);
  });

  test("music key controls go straight to a running engine", async () => {
    const { host, ports } = setup();
    await host.start();
    host.send({ kind: "control", type: "musicKey.set", key: MUSIC_KEY });
    host.send({ kind: "control", type: "musicKey.clear" });
    expect(ports[0]?.posted).toEqual([
      { kind: "control", type: "musicKey.set", key: MUSIC_KEY },
      { kind: "control", type: "musicKey.clear" },
    ]);
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
    return { v: PROTOCOL_VERSION, id: `cmd-${String(++n).padStart(8, "0")}`, kind: "command", type: "avatars.createDraft", payload: { traits, acceptedWorstMicros: 207_500 } };
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

  test("videos.delete: main waits at least as long as the engine's own worst case, so the engine's timeout text reaches the window (stage 3 review 4-M1)", () => {
    const deadline = COMMAND_DEADLINE_MS["videos.delete"] ?? REQUEST_TIMEOUT_MS;
    // The live library's identity re-check, the export check, the case probe, then the bounded delete: the engine answers its own EXPORT_UNAVAILABLE only after all four.
    expect(deadline).toBeGreaterThan(LIVE_LIBRARY_IDENTITY_TIMEOUT_MS + EXPORT_CHECK_TIMEOUT_MS + CASE_PROBE_TIMEOUT_MS + DELETE_TIMEOUT_MS);
  });

  test("videos.list: the engine's own listing budget ends well before main's default deadline, so a slow export volume gets «Не проверен» and not NO_ANSWER (stage 3 review 4-M4)", () => {
    expect(COMMAND_DEADLINE_MS["videos.list"]).toBeUndefined();
    expect(LIST_BUDGET_MS + RECORD_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    // The look at the export root (its check, then the case probe) is part of the budget: a root that answers within its own bounds leaves room for the records.
    expect(EXPORT_CHECK_TIMEOUT_MS + CASE_PROBE_TIMEOUT_MS).toBeLessThan(LIST_BUDGET_MS);
  });

  test("the estimates wait for a price load that times out, so the fallback estimate is not lost to main's deadline", () => {
    expect(COMMAND_DEADLINE_MS["avatars.estimate"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
    expect(COMMAND_DEADLINE_MS["avatars.estimateCandidates"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
  });

  test("generateCandidates answers once its checks and a price load are done (the job runs on), so it waits as long as an estimate", () => {
    expect(COMMAND_DEADLINE_MS["avatars.generateCandidates"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
  });

  test("runs.start also waits for the master's preflight (a bounded load, then a bounded prepare of the gates) before it answers", () => {
    expect(COMMAND_DEADLINE_MS["runs.start"]).toBe(PRICE_FETCH_TIMEOUT_MS + 2 * REFERENCE_TIMEOUT_MS + 30_000);
  });

  test.each(["runs.estimate", "runs.estimateResume", "runs.resume", "runs.list"] as const)(
    "%s answers once its checks and a price load are done (a run's job runs on), so it waits as long as an estimate",
    (type) => {
      expect(COMMAND_DEADLINE_MS[type]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
    },
  );

  test("estimateRewriteDescriptor waits as long as an estimate", () => {
    expect(COMMAND_DEADLINE_MS["avatars.estimateRewriteDescriptor"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
  });

  test("rewriteDescriptor is sized like createDraft's descriptor part: the same job, the same attempt ceiling", () => {
    expect(COMMAND_DEADLINE_MS["avatars.rewriteDescriptor"]).toBe(PRICE_FETCH_TIMEOUT_MS + DESCRIPTOR_MAX_ATTEMPTS * MAX_ATTEMPT_MS + 30_000);
    expect(COMMAND_DEADLINE_MS["avatars.rewriteDescriptor"]).toBe(COMMAND_DEADLINE_MS["avatars.createDraft"]);
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
    expect(await host.openLibrary("/Users/me/Studio")).toEqual({ code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
  });
});

describe("shutdown (the app is quitting)", () => {
  const callIdOf = (message: unknown): unknown => (typeof message === "object" && message !== null && "callId" in message ? message.callId : null);

  test("asks the engine to stop its renders and waits for its answer; it does NOT kill it (the quit may still be cancelled)", async () => {
    const { host, ports, children } = setup();
    await host.start();

    const done = host.shutdown(8_000);
    await Bun.sleep(0);

    const call = ports[0]?.posted.at(-1);
    expect(call).toMatchObject({ kind: "control", type: "engine.shutdown" });
    let over = false;
    void done.then(() => void (over = true));
    await Bun.sleep(0);
    expect(over).toBe(false); // the engine is still finishing a commit
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId: callIdOf(call) });
    await done;
    expect(children[0]?.killed).toBe(false);
    expect(host.phase).toBe("running");
  });

  test("never waits longer than its bound: an engine that does not answer is given up on when the bound passes", async () => {
    const { host, children, timers } = setup();
    await host.start();

    const done = host.shutdown(8_000);
    await timers.advance(7_999);
    let over = false;
    void done.then(() => void (over = true));
    await Bun.sleep(0);
    expect(over).toBe(false);
    await timers.advance(1);
    await done;

    expect(children[0]?.killed).toBe(false); // stopping is `will-quit`'s business
  });

  test("an engine that is not running is not waited for: nothing is sent", async () => {
    const { host, children } = setup();

    await host.shutdown(8_000); // never started

    expect(children).toEqual([]);
  });

  test("an error reply ends the wait too", async () => {
    const { host, ports } = setup();
    await host.start();

    const done = host.shutdown(8_000);
    await Bun.sleep(0);
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId: callIdOf(ports[0]?.posted.at(-1)), error: { code: "INTERNAL", detail: "x" } });

    await done;
  });
});

describe("calls to the engine (library.confirm)", () => {
  test("posts the call with an id and resolves with the engine's reply", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.confirmLibrary("/Users/me/Studio");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "library.confirm", path: "/Users/me/Studio" });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId });
    expect(await pending).toBeNull();
  });

  test("an IN_FLIGHT reply (a job or a pick/archive is in flight) is passed on", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.confirmLibrary("/Users/me/Studio");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "IN_FLIGHT", detail: "paid work is in flight" } });
    expect(await pending).toEqual({ code: "IN_FLIGHT", detail: "paid work is in flight" });
  });
});

// T6c: import an existing avatar. main's own dialog reads the picked photo's
// raw bytes itself (design constraint 1) and hands them to the engine over
// this same call/reply channel — the one HostCall whose reply carries more
// than a bare ok (its staged photo's id and pixel size).
describe("calls to the engine (import.stagePhoto)", () => {
  test("posts the bytes with an id and resolves with the engine's staged photo", async () => {
    const { host, ports } = setup();
    await host.start();
    const bytes = Uint8Array.from([1, 2, 3]);
    const pending = host.stageImportPhoto(bytes);
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "import.stagePhoto", bytes });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, stage: { stagingId: "stage-00000001", width: 1024, height: 1365 } });

    expect(await pending).toEqual({ error: null, stage: { stagingId: "stage-00000001", width: 1024, height: 1365 } });
  });

  test("a VALIDATION reply (not an image, animated, or a downscale failure) is passed on, with no stage", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.stageImportPhoto(Uint8Array.from([1, 2, 3]));
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "VALIDATION", detail: "an animated image cannot be imported" } });

    expect(await pending).toEqual({ error: { code: "VALIDATION", detail: "an animated image cannot be imported" }, stage: undefined });
  });

  test("no reply within 30 s is INTERNAL, with no stage", async () => {
    const { host, timers } = setup();
    await host.start();
    const pending = host.stageImportPhoto(Uint8Array.from([1, 2, 3]));
    await timers.advance(30_000);
    expect(await pending).toEqual({ error: { code: "INTERNAL", detail: "the engine did not answer within 30 s" }, stage: undefined });
  });

  // Re-review N8: this used to be a second describe("…, continued") block —
  // a leftover split from removing the "calls FROM the engine (image.decode)"
  // block (T7b security review, section A) that used to sit between the two
  // halves. Merged back into one, main's own original shape.
  test("openLibrary and confirmLibrary are unaffected: they still resolve with a bare error or null", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.openLibrary("/Users/me/Studio");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId });
    expect(await pending).toBeNull();
  });
});

// 3e.3: the owner's pick of the export folder is put to the engine, which answers what the folder is (its identity and how
// many video records resolve in it) or why it cannot be the export folder.
describe("calls to the engine (export.choose)", () => {
  test("posts the picked path with an id and resolves with the engine's folder", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.chooseExport("/Volumes/Reels");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "export.choose", path: "/Volumes/Reels" });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, exportFolder: { rootId: "root-00000001", resolved: 3, elsewhere: 1, incomplete: false } });

    expect(await pending).toEqual({ error: null, exportFolder: { rootId: "root-00000001", resolved: 3, elsewhere: 1, incomplete: false } });
  });

  test("a refusal (EXPORT_UNAVAILABLE with its reason) is passed on, with no folder", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.chooseExport("/Volumes/Reels");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });

    expect(await pending).toEqual({ error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" }, exportFolder: undefined });
  });

  test("no reply within 30 s is INTERNAL, with no folder", async () => {
    const { host, timers } = setup();
    await host.start();
    const pending = host.chooseExport("/Volumes/Reels");
    await timers.advance(30_000);
    expect(await pending).toEqual({ error: { code: "INTERNAL", detail: "the engine did not answer within 30 s" }, exportFolder: undefined });
  });

  test("an engine that is gone answers INTERNAL", async () => {
    const { host, children, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    children[1]?.crash(1);
    expect(await host.chooseExport("/Volumes/Reels")).toMatchObject({ error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } });
  });
});

// «Удалить аватар»: main asks the engine what goes with an avatar (`avatar.deletePrepare`: the plan of paths, for main only) and tells it how the
// move to the Trash ended (`avatar.deleteFinish`).
describe("calls to the engine (avatar.deletePrepare and avatar.deleteFinish)", () => {
  const plan = { avatarId: "avatar-0001", libraryRoot: "/data/library", folder: "/data/library/avatars/avatar-0001", exportRoot: null, files: [], unlisted: 0 };

  test("a prepare posts the avatar id with a call id and resolves with the plan", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.prepareAvatarDelete("avatar-0001", "token-00000001");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "avatar.deletePrepare", avatarId: "avatar-0001" });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, deletePlan: plan });

    expect(await pending).toEqual({ error: null, deletePlan: plan });
  });

  test("a refusal is passed on, with no plan", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.prepareAvatarDelete("avatar-0001", "token-00000001");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "IN_FLIGHT", detail: "a render is running" } });

    expect(await pending).toMatchObject({ error: { code: "IN_FLIGHT" }, deletePlan: undefined });
  });

  test("a prepare waits as long as the engine's own bounded look takes, not the default 30 s", async () => {
    const { host, timers } = setup();
    await host.start();
    const pending = host.prepareAvatarDelete("avatar-0001", "token-00000001");
    await timers.advance(30_000);
    await timers.advance(AVATAR_DELETE_PREPARE_DEADLINE_MS - 30_000);

    expect(await pending).toMatchObject({ error: { code: "INTERNAL" } });
  });

  test("a finish posts the avatar id and the outcome", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.finishAvatarDelete("avatar-0001", "token-00000001", "trashed");
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "avatar.deleteFinish", avatarId: "avatar-0001", token: "token-00000001", outcome: "trashed" });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId });

    expect(await pending).toMatchObject({ error: null });
  });

  test("pruneMissingAvatars posts avatars.pruneMissing and resolves with the engine's answer", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.pruneMissingAvatars();
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "avatars.pruneMissing" });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId });

    expect(await pending).toMatchObject({ error: null });
  });

  test("an engine that is gone answers INTERNAL to both", async () => {
    const { host, children, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    children[1]?.crash(1);

    expect(await host.prepareAvatarDelete("avatar-0001", "token-00000001")).toMatchObject({ error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } });
    expect(await host.finishAvatarDelete("avatar-0001", "token-00000001", "kept")).toMatchObject({ error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } });
  });
});

// 3f.1: the file the owner picked in main's dialog is put to the engine, which stages a copy and hands it to the kind's importer.
describe("calls to the engine (media.import)", () => {
  const picked = { pick: "photo" as const, path: "/Users/me/summer.jpg", name: "summer.jpg", expected: { dev: "16777234", ino: "9876543210", size: "4096", mtimeNs: "1700000000123456789", birthtimeNs: "1600000000000000000" } };

  test("posts the path, the pick, the name and the identity with an id, and resolves with the job", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.importMedia(picked);
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    expect(call).toMatchObject({ kind: "control", type: "media.import", ...picked });
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, mediaJobId: "job-00000007" });

    expect(await pending).toEqual({ error: null, mediaJobId: "job-00000007" });
  });

  test("a refusal passes on its error and its reason, with no job", async () => {
    const { host, ports } = setup();
    await host.start();
    const pending = host.importMedia(picked);
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "VALIDATION", detail: "not a photo" }, mediaReason: "format" });

    expect(await pending).toEqual({ error: { code: "VALIDATION", detail: "not a photo" }, mediaReason: "format" });
  });

  test("a call that breaks the contract (an inode written negative, as Node's signed bigint stat can) is refused at once and is never posted", async () => {
    const { host, ports } = setup();
    await host.start();
    const result = await host.importMedia({ ...picked, expected: { ...picked.expected, ino: "-5" } });
    expect(result).toMatchObject({ error: { code: "VALIDATION" } });
    expect(ports[0]?.posted).toEqual([]);
  });

  test("main's deadline tells the engine to stop the copy before it answers INTERNAL itself", async () => {
    const { host, ports, timers } = setup();
    await host.start();
    const pending = host.importMedia(picked);
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    await timers.advance(MEDIA_IMPORT_DEADLINE_MS);
    expect(ports[0]?.posted[1]).toEqual({ kind: "control", type: "media.abortImport", callId });
    expect(await pending).toMatchObject({ error: { code: "INTERNAL" } });
  });

  test("a window that closed (the caller's signal) tells the engine to stop the copy, and the engine's own answer settles it", async () => {
    const { host, ports } = setup();
    await host.start();
    const controller = new AbortController();
    const pending = host.importMedia(picked, controller.signal);
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    controller.abort();
    expect(ports[0]?.posted[1]).toEqual({ kind: "control", type: "media.abortImport", callId });
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, error: { code: "INTERNAL", detail: "the import was cancelled" }, mediaReason: "cancelled" });
    expect(await pending).toEqual({ error: { code: "INTERNAL", detail: "the import was cancelled" }, mediaReason: "cancelled" });
  });

  test("a signal that is already aborted asks the engine for nothing", async () => {
    const { host, ports } = setup();
    await host.start();
    const result = await host.importMedia(picked, AbortSignal.abort());
    expect(result).toMatchObject({ mediaReason: "cancelled" });
    expect(ports[0]?.posted).toEqual([]);
  });

  test("a call that was answered is not aborted afterwards by a signal that fires later", async () => {
    const { host, ports } = setup();
    await host.start();
    const controller = new AbortController();
    const pending = host.importMedia(picked, controller.signal);
    await Bun.sleep(0);
    const call = ports[0]?.posted[0];
    const callId = typeof call === "object" && call !== null && "callId" in call ? call.callId : null;
    ports[0]?.fromEngine({ kind: "control", type: "reply", callId, mediaJobId: "job-00000007" });
    await pending;
    controller.abort();
    expect(ports[0]?.posted).toHaveLength(1);
  });

  test("a copy is not given up on at 30 s (a 2 GB video takes longer), but is after ten minutes", async () => {
    const { host, timers } = setup();
    await host.start();
    const pending = host.importMedia(picked);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await timers.advance(30_000);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    await timers.advance(MEDIA_IMPORT_DEADLINE_MS - 30_000);
    expect(await pending).toEqual({ error: { code: "INTERNAL", detail: `the engine did not answer within ${MEDIA_IMPORT_DEADLINE_MS / 1000} s` } });
  });

  test("an engine that is gone answers INTERNAL", async () => {
    const { host, children, endBackoff } = setup();
    await host.start();
    children[0]?.crash(1);
    await endBackoff();
    children[1]?.crash(1);
    expect(await host.importMedia(picked)).toMatchObject({ error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } });
  });
});
