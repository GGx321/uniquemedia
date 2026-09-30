import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMessage, PROTOCOL_VERSION, ResponseMessage } from "../shared/engine";
import type { EngineInit, HostControl } from "../engine/control";
import { FakeSafeStorage } from "../testing/fakeSafeStorage";
import { captureConsole, expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { EngineHost, RESTART_DELAY_MS, type EngineChild, type HostPort, type HostTimers } from "./engineHost";
import { KeyStore, SECRETS_FILE } from "./keyFlow";
import { handleMusicKeyCommand, musicKeyStatusOf, MUSIC_SECRETS_FILE, openMusicKeyStore, type MusicKeyCommand } from "./musicKeyFlow";
useNativeGlobals();

// Stage 3, task 3c.2: the RapidAPI (music) key at rest and on its way to the engine. Only fake keys here.

const MUSIC = "test-rapidapi-key-0000";
const ROTATED = "test-rapidapi-key-9999";

let userData = "";
let safe: FakeSafeStorage;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "studio-music-keys-"));
  safe = new FakeSafeStorage();
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const musicPath = () => join(userData, MUSIC_SECRETS_FILE);
const open = () => openMusicKeyStore(safe, userData);

function setMusicKey(key: string): MusicKeyCommand {
  return { v: PROTOCOL_VERSION, id: "cmd-set-0001", kind: "command", type: "settings.setMusicKey", payload: { key } };
}
const clearMusicKey: MusicKeyCommand = { v: PROTOCOL_VERSION, id: "cmd-clear-001", kind: "command", type: "settings.clearMusicKey", payload: {} };

function engineSpy() {
  const sent: HostControl[] = [];
  return { sent, send: (control: HostControl) => sent.push(control) };
}

describe("the file", () => {
  test("is secrets-rapidapi.bin, a different file from the OpenRouter key's", () => {
    expect(MUSIC_SECRETS_FILE).toBe("secrets-rapidapi.bin");
    expect(MUSIC_SECRETS_FILE).not.toBe(SECRETS_FILE);
  });
});

describe("settings.setMusicKey", () => {
  test("encryption unavailable: ENCRYPTION_UNAVAILABLE, nothing stored, the engine is not told", async () => {
    safe.available = false;
    const keys = await open();
    const engine = engineSpy();

    const response = await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: false, id: "cmd-set-0001", type: "settings.setMusicKey", error: { code: "ENCRYPTION_UNAVAILABLE" } });
    expect(await readdir(userData)).toEqual([]);
    expect(engine.sent).toEqual([]);
    expect(musicKeyStatusOf(keys.status())).toEqual({ stored: false, last4: null, rejected: false });
    expect(JSON.stringify(response)).not.toContain(MUSIC);
  });

  test("an encryptString that throws (Keychain denied) answers ENCRYPTION_UNAVAILABLE and stores nothing", async () => {
    safe.denyEncrypt = true;
    const keys = await open();
    const engine = engineSpy();

    const response = await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });

    expect(response).toMatchObject({ ok: false, error: { code: "ENCRYPTION_UNAVAILABLE" } });
    expect(JSON.stringify(response)).not.toContain(MUSIC);
    expect(await readdir(userData)).toEqual([]);
    expect(engine.sent).toEqual([]);
  });

  test("stores only ciphertext in secrets-rapidapi.bin, answers with the last four chars and hands the key to the engine", async () => {
    const keys = await open();
    const engine = engineSpy();

    const response = await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toEqual({
      v: PROTOCOL_VERSION,
      id: "cmd-set-0001",
      kind: "response",
      type: "settings.setMusicKey",
      ok: true,
      result: { stored: true, last4: "0000", rejected: false },
    });
    expect(JSON.stringify(response)).not.toContain(MUSIC);
    expect(engine.sent).toEqual([{ kind: "control", type: "musicKey.set", key: MUSIC }]);

    const onDisk = await readFile(musicPath());
    expect(onDisk.toString()).not.toContain(MUSIC);
    expect(safe.decryptString(onDisk)).toBe(MUSIC);
    expect(await readdir(userData)).toEqual([MUSIC_SECRETS_FILE]);
  });

  test("a key pasted with whitespace around it is stored and handed over trimmed", async () => {
    const parsed = parseMessage({ ...setMusicKey(`  ${MUSIC}\n`) });
    if (!parsed.ok || parsed.message.kind !== "command" || parsed.message.type !== "settings.setMusicKey") throw new Error("the command must parse");
    const keys = await open();
    const engine = engineSpy();

    await handleMusicKeyCommand(parsed.message, { keys, engine });

    expect(engine.sent).toEqual([{ kind: "control", type: "musicKey.set", key: MUSIC }]);
    expect(await keys.read()).toBe(MUSIC);
  });

  test("a new key replaces the old one (rotation)", async () => {
    const keys = await open();
    const engine = engineSpy();
    await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });
    await handleMusicKeyCommand(setMusicKey(ROTATED), { keys, engine });

    expect(await keys.read()).toBe(ROTATED);
    expect(musicKeyStatusOf(keys.status()).last4).toBe("9999");
    expect(engine.sent.at(-1)).toEqual({ kind: "control", type: "musicKey.set", key: ROTATED });
  });

  test("main reports a stored key as not rejected: a set is a fresh start, the engine alone learns of a 401", async () => {
    const keys = await open();
    await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine: engineSpy() });
    expect(musicKeyStatusOf(keys.status()).rejected).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the file is readable by its owner only (0600)", async () => {
    const keys = await open();
    await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine: engineSpy() });
    expect((await stat(musicPath())).mode & 0o777).toBe(0o600);
  });
});

describe("settings.clearMusicKey", () => {
  test("deletes the blob, tells the engine and reports no key", async () => {
    const keys = await open();
    const engine = engineSpy();
    await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });

    const response = await handleMusicKeyCommand(clearMusicKey, { keys, engine });

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: true, type: "settings.clearMusicKey", result: { stored: false, last4: null, rejected: false } });
    expect(await readdir(userData)).toEqual([]);
    expect(engine.sent.at(-1)).toEqual({ kind: "control", type: "musicKey.clear" });
    expect(await keys.read()).toBeNull();
  });

  test("clearing when nothing is stored still succeeds", async () => {
    const keys = await open();
    const response = await handleMusicKeyCommand(clearMusicKey, { keys, engine: engineSpy() });
    expect(response).toMatchObject({ ok: true, result: { stored: false, last4: null, rejected: false } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
  });

  test("clearing with encryption unavailable still deletes the blob", async () => {
    const first = await open();
    await first.set(MUSIC, () => {});
    safe.available = false;
    const keys = await open();

    const response = await handleMusicKeyCommand(clearMusicKey, { keys, engine: engineSpy() });

    expect(response).toMatchObject({ ok: true, result: { stored: false } });
    expect(await readdir(userData)).toEqual([]);
  });
});

describe("the music key store across restarts", () => {
  test("a restarted main learns the last four chars from the blob and can decrypt the key for the engine", async () => {
    const first = await open();
    await first.set(MUSIC, () => {});

    const second = await open();
    expect(musicKeyStatusOf(second.status())).toEqual({ stored: true, last4: "0000", rejected: false });
    expect(await second.read()).toBe(MUSIC);
  });

  test("with encryption unavailable at start, a stored blob is not read", async () => {
    const first = await open();
    await first.set(MUSIC, () => {});
    safe.available = false;
    const second = await open();
    expect(musicKeyStatusOf(second.status())).toEqual({ stored: false, last4: null, rejected: false });
    expect(await second.read()).toBeNull();
  });

  test("a blob that no longer decrypts reads as no key and is left for a new key to replace", async () => {
    const first = await open();
    await first.set(MUSIC, () => {});
    safe.failDecrypt = true;
    const output = captureConsole();
    try {
      const second = await open();
      expect(musicKeyStatusOf(second.status()).stored).toBe(false);
      expect(await second.read()).toBeNull();
      expect(await readdir(userData)).toEqual([MUSIC_SECRETS_FILE]);
      expectNoKeyFragment(output.text(), MUSIC);
    } finally {
      output.restore();
    }
  });

  test.each([
    ["an empty file", Buffer.alloc(0)],
    ["a truncated header", Buffer.from("en")],
    ["random bytes", Buffer.from([0x00, 0xff, 0x13, 0x37, 0x80, 0x01, 0xfe])],
    ["a header with nothing after it", Buffer.from("enc:")],
  ])("%s reads as no key, without throwing", async (_label, bytes) => {
    await writeFile(musicPath(), bytes);
    const output = captureConsole();
    try {
      const keys = await open();
      expect(musicKeyStatusOf(keys.status())).toEqual({ stored: false, last4: null, rejected: false });
      expect(await keys.read()).toBeNull();
    } finally {
      output.restore();
    }
  });

  test("a corrupt file is replaced by the next key that is stored", async () => {
    await writeFile(musicPath(), Buffer.from("enc:"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const keys = await open();
      const engine = engineSpy();

      const response = await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });

      expect(response).toMatchObject({ ok: true, result: { stored: true, last4: "0000" } });
      expect(await (await open()).read()).toBe(MUSIC);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    ["holds a space", "test-rapidapi key-0000"],
    ["has whitespace around it", " test-rapidapi-key-0000 "],
    ["is shorter than eight chars", "abc1234"],
  ])("a blob whose key %s is ignored", async (_label, plain) => {
    await writeFile(musicPath(), safe.encryptString(plain));
    const output = captureConsole();
    try {
      const keys = await open();
      expect(musicKeyStatusOf(keys.status()).stored).toBe(false);
      expect(await keys.read()).toBeNull();
      // The decrypted text of a blob that fails the shape rule (a real key with padding, say) must not be logged either.
      expectNoKeyFragment(output.text(), plain.trim());
    } finally {
      output.restore();
    }
  });
});

describe("the two key stores are independent", () => {
  test("clearing the music key leaves the OpenRouter key's file alone, and the other way round", async () => {
    const openRouterPath = join(userData, SECRETS_FILE);
    const openRouter = await KeyStore.open(safe, openRouterPath);
    await openRouter.set("sk-or-v1-0123456789abcdef-wxyz", () => {});
    const music = await open();
    await music.set(MUSIC, () => {});

    await handleMusicKeyCommand(clearMusicKey, { keys: music, engine: engineSpy() });
    expect(await readdir(userData)).toEqual([SECRETS_FILE]);
    expect(await openRouter.read()).toBe("sk-or-v1-0123456789abcdef-wxyz");

    await music.set(MUSIC, () => {});
    await openRouter.clear(() => {});
    expect(await readdir(userData)).toEqual([MUSIC_SECRETS_FILE]);
    expect(await music.read()).toBe(MUSIC);
  });
});

// ---------- a file that cannot be read ----------

const OPENROUTER_KEY = "sk-or-v1-0123456789abcdef-wxyz";

describe("a secrets-rapidapi.bin that cannot be read", () => {
  /** A directory in the file's place: unreadable on every platform (EISDIR). */
  async function directoryInPlace(): Promise<void> {
    await mkdir(musicPath());
  }

  test("a directory in its place opens as no key, and logs only the error code", async () => {
    await directoryInPlace();
    const output = captureConsole();
    try {
      const keys = await open();
      expect(musicKeyStatusOf(keys.status())).toEqual({ stored: false, last4: null, rejected: false });
      expect(await keys.read()).toBeNull();
      expect(output.text()).toMatch(/the stored RapidAPI key could not be read \([A-Z]+\)/);
      expect(output.text()).not.toContain(userData);
    } finally {
      output.restore();
    }
  });

  test("the engine host starts anyway, and still delivers the OpenRouter key", async () => {
    await directoryInPlace();
    const output = captureConsole();
    try {
      const keys = await open();
      const { host, ports } = await hostOver(keys, OPENROUTER_KEY);
      expect(host.phase).toBe("running");
      expect(ports[0]?.posted).toEqual([{ kind: "control", type: "apiKey.set", key: OPENROUTER_KEY }]);
    } finally {
      output.restore();
    }
  });

  test("a read that starts failing after main opened the store still lets the engine start, without a music key", async () => {
    const keys = await open();
    await keys.set(MUSIC, () => {});
    await rm(musicPath());
    await directoryInPlace();
    const output = captureConsole();
    try {
      const { host, ports } = await hostOver(keys, OPENROUTER_KEY);
      expect(host.phase).toBe("running");
      expect(ports[0]?.posted).toEqual([{ kind: "control", type: "apiKey.set", key: OPENROUTER_KEY }]);
    } finally {
      output.restore();
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file with no read permission (EACCES) opens as no key", async () => {
    await writeFile(musicPath(), safe.encryptString(MUSIC));
    await chmod(musicPath(), 0o000);
    const output = captureConsole();
    try {
      const keys = await open();
      expect(musicKeyStatusOf(keys.status()).stored).toBe(false);
      expect(await keys.read()).toBeNull();
      expect(output.text()).toContain("EACCES");
      expectNoKeyFragment(output.text(), MUSIC);
    } finally {
      output.restore();
      await chmod(musicPath(), 0o600);
    }
  });

  test("setting a key over a directory answers a clean INTERNAL, tells the engine nothing and leaves no stray file", async () => {
    await directoryInPlace();
    const keys = await open();
    const engine = engineSpy();
    const output = captureConsole();
    try {
      const response = await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine });

      expect(response).toMatchObject({ ok: false, id: "cmd-set-0001", type: "settings.setMusicKey", error: { code: "INTERNAL" } });
      expect(ResponseMessage.safeParse(response).success).toBe(true);
      expectNoKeyFragment(JSON.stringify(response), MUSIC);
      expectNoKeyFragment(output.text(), MUSIC);
      expect(engine.sent).toEqual([]);
      expect(musicKeyStatusOf(keys.status()).stored).toBe(false);
      expect(await readdir(userData)).toEqual([MUSIC_SECRETS_FILE]);
      expect((await stat(musicPath())).isDirectory()).toBe(true);
    } finally {
      output.restore();
    }
  });

  test("clearing over a directory answers a clean INTERNAL instead of throwing, and does not delete the directory", async () => {
    await directoryInPlace();
    await writeFile(join(musicPath(), "keep.txt"), "not ours");
    const keys = await open();
    const engine = engineSpy();
    const output = captureConsole();
    try {
      const response = await handleMusicKeyCommand(clearMusicKey, { keys, engine });

      expect(response).toMatchObject({ ok: false, id: "cmd-clear-001", type: "settings.clearMusicKey", error: { code: "INTERNAL" } });
      expect(ResponseMessage.safeParse(response).success).toBe(true);
      expect(engine.sent).toEqual([]);
      expect(await readdir(musicPath())).toEqual(["keep.txt"]);
    } finally {
      output.restore();
    }
  });

  test("the OpenRouter key's store is unchanged: an unreadable file still throws", async () => {
    await mkdir(join(userData, SECRETS_FILE));
    await expect(KeyStore.open(safe, join(userData, SECRETS_FILE))).rejects.toThrow();
  });
});

describe("a key the store's shape rule would drop", () => {
  test("is refused by set, so it cannot vanish after a restart, and the error does not carry it", async () => {
    const keys = await open();
    const engine = engineSpy();
    const padded = ` ${MUSIC}`;

    const error = await keys.set(padded, () => engine.send({ kind: "control", type: "musicKey.set", key: padded })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expectNoKeyFragment(String((error as Error).message), MUSIC);
    expect(engine.sent).toEqual([]);
    expect(await readdir(userData)).toEqual([]);
    expect(musicKeyStatusOf(keys.status()).stored).toBe(false);
  });

  test("through the command it answers INTERNAL", async () => {
    const keys = await open();
    const response = await handleMusicKeyCommand(setMusicKey(` ${MUSIC}`), { keys, engine: engineSpy() });
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expectNoKeyFragment(JSON.stringify(response), MUSIC);
  });
});

// ---------- set while the engine is restarting ----------

class FakePort implements HostPort {
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  on(): void {}
  start(): void {}
  close(): void {}
}

class FakeChild implements EngineChild<string> {
  #onExit: ((code: number) => void) | null = null;
  postMessage(): void {}
  once(_event: "exit", listener: (code: number) => void): void {
    this.#onExit = listener;
  }
  kill(): boolean {
    return true;
  }
  crash(code: number): void {
    this.#onExit?.(code);
  }
}

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
  fire(ms: number): void {
    for (const [id, timer] of [...this.#pending]) {
      if (timer.ms !== ms) continue;
      this.#pending.delete(id);
      timer.fn();
    }
  }
}

/** Ends the restart backoff and waits for the relaunch, which reads the key store (real file I/O), to finish. */
async function relaunch(host: EngineHost<string>, timers: ManualTimers): Promise<void> {
  timers.fire(RESTART_DELAY_MS);
  for (let waited = 0; host.phase !== "running" && waited < 2000; waited += 5) await Bun.sleep(5);
  expect(host.phase).toBe("running");
}

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
    exportPath: "/tmp/userData/export",
    renderConcurrency: "auto",
  },
  encryptionAvailable: true,
  notices: [],
};

async function hostOver(keys: Awaited<ReturnType<typeof open>>, openRouterKey: string | null = null) {
  const children: FakeChild[] = [];
  const ports: FakePort[] = [];
  const timers = new ManualTimers();
  const host = new EngineHost<string>({
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    channel: () => {
      const port = new FakePort();
      ports.push(port);
      return { local: port, remote: `remote-port-${ports.length}` };
    },
    init: async () => INIT,
    apiKey: async () => openRouterKey,
    musicKey: () => keys.read(),
    onEvent: () => {},
    onExit: () => {},
    timers,
  });
  await host.start();
  return { host, children, ports, timers };
}

describe("a music key set while the engine is restarting", () => {
  test("reaches the new engine, which is started with the key from the store", async () => {
    const keys = await open();
    const { host, children, ports, timers } = await hostOver(keys);
    children[0]?.crash(9);

    const response = await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine: host });
    expect(response).toMatchObject({ ok: true, result: { stored: true, last4: "0000" } });
    await relaunch(host, timers);

    expect(ports[0]?.posted).toEqual([]);
    const received = ports[1]?.posted ?? [];
    expect(received).toContainEqual({ kind: "control", type: "musicKey.set", key: MUSIC });
    expect(received.at(-1)).toEqual({ kind: "control", type: "musicKey.set", key: MUSIC });
  });

  test("a rotation during the restart leaves the new engine on the newest key", async () => {
    const keys = await open();
    const { host, children, ports, timers } = await hostOver(keys);
    await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine: host });
    children[0]?.crash(9);

    await handleMusicKeyCommand(setMusicKey(ROTATED), { keys, engine: host });
    await relaunch(host, timers);

    const received = (ports[1]?.posted ?? []) as HostControl[];
    expect(received.at(-1)).toEqual({ kind: "control", type: "musicKey.set", key: ROTATED });
    expect(JSON.stringify(received)).not.toContain(MUSIC);
  });

  test("a clear during the restart leaves the new engine without a key", async () => {
    const keys = await open();
    const { host, children, ports, timers } = await hostOver(keys);
    await handleMusicKeyCommand(setMusicKey(MUSIC), { keys, engine: host });
    children[0]?.crash(9);

    await handleMusicKeyCommand(clearMusicKey, { keys, engine: host });
    await relaunch(host, timers);

    expect(ports[1]?.posted).toEqual([{ kind: "control", type: "musicKey.clear" }]);
  });

  test("a stored key is handed to an engine that starts later, with nothing sent from main's command", async () => {
    const first = await open();
    await first.set(MUSIC, () => {});
    const { ports } = await hostOver(await open());
    expect(ports[0]?.posted).toEqual([{ kind: "control", type: "musicKey.set", key: MUSIC }]);
  });
});
