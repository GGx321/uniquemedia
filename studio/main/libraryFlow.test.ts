import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandMessage, type ApiKeyStatus, type EngineCommandMessage, type ResponseMessage } from "../shared/engine";
import { isControlMessage } from "../engine/control";
import { Engine } from "../engine/engine";
import { openLibrary } from "../engine/library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../engine/library/testing/helpers";
import { EngineHost, REQUEST_TIMEOUT_MS, type EngineChild, type HostPort, type HostTimers } from "./engineHost";
import { handleSettingsCommand, isSettingsCommand, type SettingsCommand, type SettingsFlowDeps } from "./settingsFlow";
import { SettingsStore } from "./settingsStore";

// The divergence the T1 review found, end to end: main asks the engine to
// open a library folder, its 30 s deadline passes first, so main saves
// nothing — and the engine, finishing later, must not switch to that folder.
// Real EngineHost, settings flow and Engine; only the MessagePort, the child
// process and the host's timers are fakes. The port can hold a call, so the
// engine answers only after main gave up.

const KEY_STATUS: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: true, rejected: false };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-library-flow-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A library with one saved avatar; returns its id. */
async function seedLibrary(path: string, prefix: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const { library } = await openLibrary(path, { now: steppingClock(), newId: sequentialIds(prefix) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: {}, descriptor: "25-year-old woman with chestnut hair." });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

/** Main's end of the channel, wired straight to a real engine; `library.open` calls can be held back. */
class WirePort implements HostPort {
  engine: Engine | null = null;
  holdCalls = false;
  readonly held: unknown[] = [];
  #listener: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: unknown): void {
    const isCall = isControlMessage(message) && typeof message === "object" && message !== null && "callId" in message;
    if (this.holdCalls && isCall) {
      this.held.push(message);
      return;
    }
    void this.engine?.receive(message);
  }
  on(_event: "message", listener: (event: { data: unknown }) => void): void {
    this.#listener = listener;
  }
  start(): void {}
  close(): void {}
  fromEngine(data: unknown): void {
    this.#listener?.({ data });
  }
}

class Child implements EngineChild<string> {
  postMessage(): void {}
  once(): void {}
  kill(): boolean {
    return true;
  }
}

/** Timers the test fires by hand; nothing runs on its own. */
class ManualTimers implements HostTimers {
  #next = 0;
  readonly #pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): number {
    const id = ++this.#next;
    this.#pending.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    if (typeof handle === "number") this.#pending.delete(handle);
  }
  /** Runs every pending timer of exactly `ms`: the request deadlines. */
  fire(ms: number): void {
    for (const [id, timer] of [...this.#pending]) {
      if (timer.ms !== ms) continue;
      this.#pending.delete(id);
      timer.fn();
    }
  }
}

function settingsCommand(type: SettingsCommand["type"], payload: unknown, id: string): SettingsCommand {
  const parsed = CommandMessage.parse({ v: 1, id, kind: "command", type, payload });
  if (!isSettingsCommand(parsed)) throw new Error(`${type} is not a settings command`);
  return parsed;
}

async function snapshotAvatars(host: EngineHost<string>): Promise<string[]> {
  const command: EngineCommandMessage = { v: 1, id: "cmd-snapshot-0001", kind: "command", type: "engine.snapshot", payload: {} };
  const response: ResponseMessage = await host.request(command);
  if (!response.ok || response.type !== "engine.snapshot") throw new Error("expected a snapshot");
  return response.result.avatars.map((a) => a.avatarId);
}

test("a library.open main gave up on after its deadline leaves both main and the engine on the saved library", async () => {
  const userData = join(dir, "userData");
  await mkdir(userData);
  const savedAvatar = await seedLibrary(join(dir, "library"), "saved");
  await seedLibrary(join(dir, "picked"), "picked");
  const { store: settings } = await SettingsStore.open(userData);
  await settings.save({ ...settings.current, libraryPath: join(dir, "library") });

  const port = new WirePort();
  const timers = new ManualTimers();
  let n = 0;
  port.engine = await Engine.start(
    { kind: "control", type: "init", ledgerPath: join(userData, "ledger.jsonl"), settings: settings.current, encryptionAvailable: true, notices: [] },
    {
      bootId: "boot-flow-0001",
      clock: Date.now,
      monotonic: () => performance.now(),
      newId: () => `id-flow-${String(++n).padStart(6, "0")}`,
      post: (message) => port.fromEngine(message),
      fetch: async (url) => {
        throw new Error(`unexpected network call to ${url}`);
      },
    },
  );
  const host = new EngineHost<string>({
    fork: () => new Child(),
    channel: () => ({ local: port, remote: "remote-port" }),
    init: async () => ({ kind: "control", type: "init", ledgerPath: join(userData, "ledger.jsonl"), settings: settings.current, encryptionAvailable: true, notices: [] }),
    apiKey: async () => null,
    onEvent: () => {},
    onExit: () => {},
    timers,
  });
  await host.start();
  const deps: SettingsFlowDeps = {
    settings,
    engine: host,
    pickFolder: async () => join(dir, "picked"),
    keyStatus: () => KEY_STATUS,
    newId: () => `internal-${String(++n).padStart(6, "0")}`,
  };

  // The user picks another folder; the engine is slow to answer, and main's deadline passes.
  port.holdCalls = true;
  const answering = handleSettingsCommand(settingsCommand("settings.setLibraryPath", { path: join(dir, "picked") }, "cmd-pick-0001"), deps);
  await Bun.sleep(10);
  timers.fire(REQUEST_TIMEOUT_MS);
  const answer = await answering;
  expect(answer).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  expect(settings.current.libraryPath).toBe(join(dir, "library"));

  // Only now does the engine open the folder and answer; main drops the late reply.
  port.holdCalls = false;
  for (const call of port.held.splice(0)) await port.engine.receive(call);

  expect(port.engine.library?.root).toBe(join(dir, "library"));
  expect(await snapshotAvatars(host)).toEqual([savedAvatar]);

  // Main's next settings change still names the saved folder; the engine stays on it.
  const budget = await handleSettingsCommand(settingsCommand("settings.setBudget", { monthlyBudgetMicros: 20_000_000 }, "cmd-budget-0001"), deps);
  expect(budget).toMatchObject({ ok: true, result: { libraryPath: join(dir, "library"), monthlyBudgetMicros: 20_000_000 } });
  expect(port.engine.library?.root).toBe(join(dir, "library"));
  expect(await snapshotAvatars(host)).toEqual([savedAvatar]);
  host.stop();
});
