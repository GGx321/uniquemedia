import {
  ENGINE_GONE_DETAIL,
  errorResponseFor,
  EventMessage,
  PROTOCOL_VERSION,
  ResponseMessage,
  type EngineCommandMessage,
  type EngineError,
} from "../shared/engine";
import { randomUUID } from "node:crypto";
import { COMMAND_DEADLINE_MS, EngineReply, type EngineInit, type HostCall, type HostControl } from "../engine/control";

/** An unexpected exit is followed by one restart, after this delay; a second one is final. */
export const RESTART_DELAY_MS = 1000;
const MAX_RESTARTS = 1;
/** Running this long without a crash gives the restart back. */
export const HEALTHY_RESET_MS = 5 * 60_000;
/**
 * A command without an answer by then gets INTERNAL; a later answer is
 * dropped. Commands with their own deadline (control.ts COMMAND_DEADLINE_MS,
 * e.g. a paid createDraft) wait that long instead.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** `setTimeout`/`clearTimeout`, injected so tests control time. */
export interface HostTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Real timers behind numeric handles, so `clear` needs no cast from `unknown`. */
function realTimers(): HostTimers {
  const live = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 0;
  return {
    set: (fn, ms) => {
      const id = ++next;
      live.set(id, setTimeout(() => {
        live.delete(id);
        fn();
      }, ms));
      return id;
    },
    clear: (handle) => {
      if (typeof handle !== "number") return;
      const timer = live.get(handle);
      if (timer !== undefined) clearTimeout(timer);
      live.delete(handle);
    },
  };
}

/** Main's end of the MessageChannelMain (Electron `MessagePortMain`). */
export interface HostPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

/** The forked engine (Electron `UtilityProcess`); `Transfer` is the port type handed over with init. */
export interface EngineChild<Transfer> {
  postMessage(message: unknown, transfer: Transfer[]): void;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface EngineHostDeps<Transfer> {
  /** `utilityProcess.fork` with the engine's asar path and its minimal env. */
  fork(): EngineChild<Transfer>;
  channel(): { local: HostPort; remote: Transfer };
  /** Built afresh for every (re)start, so it carries the current settings. */
  init(): Promise<EngineInit>;
  /** The decrypted key, handed over after every (re)start; null when none is stored. */
  apiKey(): Promise<string | null>;
  onEvent(event: EventMessage): void;
  /** Surfaces an unexpected exit; `restarting` is false once the host gave up. */
  onExit(error: EngineError, restarting: boolean): void;
  timers?: HostTimers;
  /** Ids for calls to the engine. */
  newId?: () => string;
  restartDelayMs?: number;
  requestTimeoutMs?: number;
  healthyResetMs?: number;
}

export type EnginePhase = "idle" | "starting" | "running" | "restarting" | "failed" | "stopped";

interface Pending {
  command: EngineCommandMessage;
  resolve: (response: ResponseMessage) => void;
  deadline: unknown;
}

interface PendingCall {
  callId: string;
  resolve: (error: EngineError | null) => void;
  deadline: unknown;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindOf(data: unknown): unknown {
  return typeof data === "object" && data !== null && "kind" in data ? data.kind : undefined;
}

function idOf(data: unknown): string | null {
  return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : null;
}

/**
 * Told to already-open windows via `onEvent` (main.ts forwards it exactly
 * like a real engine event) the moment the engine fails for good. Main never
 * has the dead engine's own bootId or seq to continue, and there is no next
 * engine to carry a notice in its `init` — but EventStore's contract already
 * treats an event under a bootId no window has as "something changed,
 * requery" (an engine restart, normally): a fresh `bootId` here drives the
 * exact same resync, and the resulting `engine.snapshot` call meets the same
 * ENGINE_GONE_DETAIL answer `request()` gives below, so the store goes
 * offline with a true reason. The payload is honest either way: `engine.error`
 * is defined as "a failure that belongs to no command", which this is.
 */
function goneEvent(newId: () => string): EventMessage {
  return EventMessage.parse({
    v: PROTOCOL_VERSION,
    id: newId(),
    kind: "event",
    seq: 1,
    bootId: newId(),
    type: "engine.error",
    payload: { error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } },
  });
}

/**
 * Runs the engine utilityProcess and carries T0 commands, responses and
 * events over a MessagePort. Commands sent while the engine starts or
 * restarts wait for it; responses are matched to commands by id and checked
 * against the contract. Every command has a deadline (30 s), also while it
 * waits for the engine to start, so a hung engine cannot hang the renderer.
 * If the engine exits unexpectedly, every waiting command gets an INTERNAL
 * error, the exit is surfaced, and the engine is restarted once after a
 * delay; a second unexpected exit within 5 minutes of healthy running is final.
 */
export class EngineHost<Transfer> {
  readonly #deps: EngineHostDeps<Transfer>;
  readonly #timers: HostTimers;
  #phase: EnginePhase = "idle";
  #healthyTimer: unknown = null;
  #child: EngineChild<Transfer> | null = null;
  #port: HostPort | null = null;
  #restarts = 0;
  /** Key changes made while no port is up; flushed after the startup messages. */
  #queuedControls: HostControl[] = [];
  #waiters: ((port: HostPort | null) => void)[] = [];
  readonly #pending = new Map<string, Pending>();
  readonly #calls = new Map<string, PendingCall>();

  constructor(deps: EngineHostDeps<Transfer>) {
    this.#deps = deps;
    this.#timers = deps.timers ?? realTimers();
  }

  get phase(): EnginePhase {
    return this.#phase;
  }


  async start(): Promise<void> {
    if (this.#phase === "idle") await this.#launch();
  }

  /** Forwards one validated command and resolves with the engine's response, or an INTERNAL error by its deadline. */
  request(command: EngineCommandMessage): Promise<ResponseMessage> {
    if (this.#pending.has(command.id)) {
      return Promise.resolve(
        errorResponseFor(command, { code: "VALIDATION", detail: "a command with this id is already waiting for an answer" }),
      );
    }
    return new Promise((resolve) => {
      const timeoutMs = COMMAND_DEADLINE_MS[command.type] ?? this.#deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
      const entry: Pending = { command, resolve, deadline: null };
      entry.deadline = this.#timers.set(
        () => this.#settle(entry, errorResponseFor(command, { code: "INTERNAL", detail: `the engine did not answer within ${timeoutMs / 1000} s` })),
        timeoutMs,
      );
      this.#pending.set(command.id, entry);
      void this.#runningPort().then((port) => {
        if (this.#pending.get(command.id) !== entry) return; // timed out or failed meanwhile
        if (port === null) this.#settle(entry, errorResponseFor(command, { code: "INTERNAL", detail: this.#notRunningDetail() }));
        else port.postMessage(command);
      });
    });
  }

  /**
   * Asks the engine to open (creating on first use) the library at `path`.
   * Null when it did; otherwise its error, or INTERNAL when it did not answer
   * in time or is not running. Only the engine touches the library.
   */
  openLibrary(path: string): Promise<EngineError | null> {
    const callId = (this.#deps.newId ?? randomUUID)();
    return this.#call(callId, { kind: "control", type: "library.open", callId, path });
  }

  /**
   * Asks the engine to commit the switch to the library at `path`, staged
   * earlier by `openLibrary`. Null when it did; otherwise its error (e.g.
   * IN_FLIGHT while paid work or a pick/archive holds the live library) or
   * INTERNAL when it did not answer in time or is not running. Only after a
   * null reply may main persist the new path.
   */
  confirmLibrary(path: string): Promise<EngineError | null> {
    const callId = (this.#deps.newId ?? randomUUID)();
    return this.#call(callId, { kind: "control", type: "library.confirm", callId, path });
  }

  #call(callId: string, call: HostCall): Promise<EngineError | null> {
    return new Promise((resolve) => {
      const timeoutMs = this.#deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
      const entry: PendingCall = { callId, resolve, deadline: null };
      entry.deadline = this.#timers.set(
        () => this.#settleCall(entry, { code: "INTERNAL", detail: `the engine did not answer within ${timeoutMs / 1000} s` }),
        timeoutMs,
      );
      this.#calls.set(callId, entry);
      void this.#runningPort().then((port) => {
        if (this.#calls.get(callId) !== entry) return;
        if (port === null) this.#settleCall(entry, { code: "INTERNAL", detail: this.#notRunningDetail() });
        else port.postMessage(call);
      });
    });
  }

  #settleCall(entry: PendingCall, error: EngineError | null): void {
    if (this.#calls.get(entry.callId) !== entry) return;
    this.#calls.delete(entry.callId);
    this.#timers.clear(entry.deadline);
    entry.resolve(error);
  }

  /** Sends a control message (the key, settings) now, or right after the engine's next start. */
  send(control: HostControl): void {
    if (this.#phase === "running" && this.#port !== null) this.#port.postMessage(control);
    else if (this.#phase !== "failed" && this.#phase !== "stopped") this.#queuedControls.push(control);
  }

  /** An intentional stop (app quit): no restart, waiting commands get INTERNAL. */
  stop(): void {
    const child = this.#child;
    this.#phase = "stopped";
    this.#detach("the engine was stopped");
    child?.kill();
  }

  async #launch(): Promise<void> {
    this.#phase = "starting";
    let child: EngineChild<Transfer> | null = null;
    let port: HostPort;
    try {
      const init = await this.#deps.init();
      const key = await this.#deps.apiKey();
      if (this.#phase !== "starting") return; // stopped meanwhile
      const started = this.#deps.fork();
      child = started;
      const { local, remote } = this.#deps.channel();
      started.once("exit", (code) => this.#exited(started, code));
      local.on("message", ({ data }) => this.#fromEngine(data));
      local.start();
      started.postMessage(init, [remote]);
      if (key !== null) local.postMessage({ kind: "control", type: "apiKey.set", key } satisfies HostControl);
      port = local;
    } catch (error) {
      child?.kill();
      this.#crashed(`the engine could not be started: ${describe(error)}`);
      return;
    }
    this.#child = child;
    this.#port = port;
    this.#phase = "running";
    this.#healthyTimer = this.#timers.set(() => {
      this.#healthyTimer = null;
      this.#restarts = 0;
    }, this.#deps.healthyResetMs ?? HEALTHY_RESET_MS);
    for (const control of this.#queuedControls.splice(0)) port.postMessage(control);
    for (const wake of this.#waiters.splice(0)) wake(port);
  }

  /** "the engine is not running" is ambiguous (still starting? stopped on purpose? dead for good?); `failed` is the one case a request can never recover from on its own. */
  #notRunningDetail(): string {
    return this.#phase === "failed" ? ENGINE_GONE_DETAIL : "the engine is not running";
  }

  #runningPort(): Promise<HostPort | null> {
    if (this.#phase === "running" && this.#port !== null) return Promise.resolve(this.#port);
    if (this.#phase === "failed" || this.#phase === "stopped") return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #exited(child: EngineChild<Transfer>, code: number): void {
    if (child !== this.#child) return; // an old child, or one stopped on purpose
    this.#cancelHealthyTimer();
    this.#child = null;
    this.#port?.close();
    this.#port = null;
    this.#failPending("the engine exited before answering");
    this.#crashed(`the engine exited unexpectedly (code ${code})`);
  }

  #crashed(detail: string): void {
    if (this.#restarts < MAX_RESTARTS) {
      this.#restarts++;
      this.#phase = "restarting";
      this.#deps.onExit({ code: "INTERNAL", detail: `${detail}; restarting it` }, true);
      this.#timers.set(() => {
        if (this.#phase === "restarting") void this.#launch();
      }, this.#deps.restartDelayMs ?? RESTART_DELAY_MS);
      return;
    }
    this.#phase = "failed";
    this.#detach(ENGINE_GONE_DETAIL);
    // Any window still open and synced has no other way to learn this: it
    // gets no more events from the (nonexistent) next engine, and nothing
    // it does on its own ever asks again while it believes it is `ready`.
    this.#deps.onEvent(goneEvent(this.#deps.newId ?? randomUUID));
    this.#deps.onExit({ code: "INTERNAL", detail: `${detail}; not restarted again` }, false);
  }

  #cancelHealthyTimer(): void {
    if (this.#healthyTimer !== null) this.#timers.clear(this.#healthyTimer);
    this.#healthyTimer = null;
  }

  #settle(entry: Pending, response: ResponseMessage): void {
    if (this.#pending.get(entry.command.id) !== entry) return;
    this.#pending.delete(entry.command.id);
    this.#timers.clear(entry.deadline);
    entry.resolve(response);
  }

  /** Drops the port, answers every waiting command and wakes every waiter with nothing. */
  #detach(detail: string): void {
    this.#cancelHealthyTimer();
    this.#child = null;
    this.#port?.close();
    this.#port = null;
    this.#queuedControls = [];
    this.#failPending(detail);
    for (const wake of this.#waiters.splice(0)) wake(null);
  }

  /** Answers every command and call that is waiting for the engine. */
  #failPending(detail: string): void {
    for (const entry of [...this.#pending.values()]) this.#settle(entry, errorResponseFor(entry.command, { code: "INTERNAL", detail }));
    for (const entry of [...this.#calls.values()]) this.#settleCall(entry, { code: "INTERNAL", detail });
  }

  #fromEngine(data: unknown): void {
    const kind = kindOf(data);
    if (kind === "control") {
      const reply = EngineReply.safeParse(data);
      const entry = reply.success ? this.#calls.get(reply.data.callId) : undefined;
      if (reply.success && entry !== undefined) this.#settleCall(entry, reply.data.error ?? null);
      else console.warn("studio: dropped an engine reply no call is waiting for");
      return;
    }
    if (kind === "event") {
      const event = EventMessage.safeParse(data);
      if (event.success) this.#deps.onEvent(event.data);
      else console.warn("studio: dropped an engine event that breaks the contract");
      return;
    }
    if (kind !== "response") {
      console.warn("studio: dropped an unknown message from the engine");
      return;
    }
    const id = idOf(data);
    const pending = id === null ? undefined : this.#pending.get(id);
    if (id === null || pending === undefined) {
      console.warn("studio: dropped an engine response no command is waiting for");
      return;
    }
    const response = ResponseMessage.safeParse(data);
    if (!response.success) {
      this.#settle(pending, errorResponseFor(pending.command, { code: "INTERNAL", detail: "the engine sent a response that breaks the contract" }));
    } else if (response.data.type !== null && response.data.type !== pending.command.type) {
      this.#settle(pending, errorResponseFor(pending.command, { code: "INTERNAL", detail: "the engine answered with another command's type" }));
    } else {
      this.#settle(pending, response.data);
    }
  }
}
