import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../shared/engine";
import type { HostControl } from "../engine/control";
import { command, ok, startEngine, useEngineDir } from "../engine/testing/engineHarness";
import { ENV_ALLOWLIST } from "../node/childEnv";
import { configuredFfmpegEnv, configureFfmpegEnv } from "../node/ffmpegEnv";
import { fakeSpawner } from "../node/fakeFfmpeg.testkit";
import { runFfmpegArgv } from "../node/runFfmpeg";
import { FakeSafeStorage } from "../testing/fakeSafeStorage";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { engineEnv } from "./engineEnv";
import { handleMusicKeyCommand, MUSIC_SECRETS_FILE, musicKeyStatusOf, openMusicKeyStore } from "./musicKeyFlow";
import { handleRendererRequest, type RequestRoutes, type SenderFrame, type TrustedRenderer } from "./requests";
useNativeGlobals();

// Invariant 29 (Stage 3 plan): the RapidAPI key lives only in its KeyStore (safeStorage, main) and the engine's memory:
// never in the renderer, logs, library, cache files or a child process's environment. Every key here is obviously fake.

const MUSIC = "test-rapidapi-key-0000";
/** Everything of the key but the last four chars, which the status may show. */
const MUSIC_HEAD = MUSIC.slice(0, -4);
const ROTATED = "test-rapidapi-key-9999";

const dir = useEngineDir("studio-music-invariant29-");

// ---------- a scan that is shown to find what it looks for ----------

/** The key as bytes a file or a stream could hold it in: UTF-8, UTF-16 (ID3v2 frames, Windows), base64 and hex. */
function forms(key: string): { name: string; bytes: Buffer }[] {
  return [
    { name: "utf8", bytes: Buffer.from(key, "utf8") },
    { name: "utf16le", bytes: Buffer.from(key, "utf16le") },
    { name: "utf16be", bytes: Buffer.from(key, "utf16le").swap16() },
    { name: "base64", bytes: Buffer.from(Buffer.from(key).toString("base64")) },
    { name: "hex", bytes: Buffer.from(Buffer.from(key).toString("hex")) },
  ];
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

/** Files under `root` that hold `key` in any form, as `path (form)`. */
async function filesHolding(root: string, key: string): Promise<string[]> {
  const hits: string[] = [];
  for (const path of await filesUnder(root)) {
    const bytes = await readFile(path);
    for (const form of forms(key)) if (bytes.includes(form.bytes)) hits.push(`${path} (${form.name})`);
  }
  return hits;
}

describe("the scan itself", () => {
  test("finds the key in a file in each form it looks for", async () => {
    for (const form of forms(MUSIC)) {
      await writeFile(join(dir(), `leak-${form.name}.bin`), Buffer.concat([Buffer.from("xx"), form.bytes, Buffer.from("yy")]));
    }
    const hits = await filesHolding(dir(), MUSIC);
    expect(hits.map((h) => h.slice(h.lastIndexOf("(")))).toEqual(
      expect.arrayContaining(["(utf8)", "(utf16le)", "(utf16be)", "(base64)", "(hex)"]),
    );
  });

  test("finds nothing in a folder without the key", async () => {
    await writeFile(join(dir(), "clean.bin"), "nothing to see");
    expect(await filesHolding(dir(), MUSIC)).toEqual([]);
  });
});

// ---------- the renderer's whole path, over a real engine ----------

const FILE_URL = "file:///C:/Program%20Files/Studio/resources/app.asar/out-studio/renderer/index.html";
const TRUSTED: TrustedRenderer = { fileUrl: FILE_URL };
const APP_FRAME: SenderFrame = { url: FILE_URL, isTopFrame: true, isAppWindow: true };

let seq = 0;
function rendererCommand(type: string, payload: unknown = {}): unknown {
  return { v: PROTOCOL_VERSION, id: `cmd-inv29-${String(++seq).padStart(4, "0")}`, kind: "command", type, payload };
}

/** What a console call would print, for every level. */
function captureConsole() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
  return {
    text: () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls)),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

let userData = "";
let output: ReturnType<typeof captureConsole>;
beforeEach(() => {
  userData = join(dir(), "userData");
  output = captureConsole();
});
afterEach(() => {
  output.restore();
  configureFfmpegEnv(undefined);
});

/** Main's routes over a real store and a real engine; `everything` collects each answer the renderer would get. */
async function wired() {
  await mkdir(userData, { recursive: true });
  const safe = new FakeSafeStorage();
  const keys = await openMusicKeyStore(safe, userData);
  const { engine, posted, events } = await startEngine(dir(), { key: null });
  const received: unknown[] = [];
  const sendToEngine = (control: HostControl): void => void engine.applyControl(control);
  const routes: RequestRoutes = {
    mainOnly: async () => {
      throw new Error("the OpenRouter key is not part of this test");
    },
    musicKey: (c) => handleMusicKeyCommand(c, { keys, engine: { send: sendToEngine } }),
    settings: async () => {
      throw new Error("not used");
    },
    importPhoto: async () => {
      throw new Error("not used");
    },
    engine: (c) => engine.handle(c),
  };
  const ask = async (type: string, payload: unknown = {}) => {
    const response = await handleRendererRequest(rendererCommand(type, payload), APP_FRAME, TRUSTED, routes);
    received.push(response);
    return response;
  };
  return { safe, keys, engine, posted, events, received, ask };
}

/** Everything a window could see: answers to its requests, and the engine's events and responses. */
function whatTheRendererSaw(w: Awaited<ReturnType<typeof wired>>): string {
  return JSON.stringify([w.received, w.posted]);
}

describe("the music key never reaches the renderer", () => {
  test("not in any answer or event through set, settings, snapshot, a 401, a rotation and a clear", async () => {
    const w = await wired();

    await w.ask("settings.setMusicKey", { key: MUSIC });
    await w.ask("settings.get");
    await w.ask("engine.snapshot");
    w.engine.markMusicKeyRejected(MUSIC);
    await w.ask("settings.get");
    await w.ask("settings.setMusicKey", { key: ROTATED });
    await w.ask("engine.events", { afterSeq: 0, bootId: w.engine.bootId });
    await w.ask("settings.clearMusicKey");
    await w.ask("settings.get");

    const seen = whatTheRendererSaw(w);
    for (const key of [MUSIC, ROTATED]) expect(seen).not.toContain(key);
    for (const key of [MUSIC_HEAD, ROTATED.slice(0, -4)]) expect(seen).not.toContain(key);
  });

  test("the answer to a set carries the last four chars and nothing else of the key", async () => {
    const w = await wired();
    const response = await w.ask("settings.setMusicKey", { key: MUSIC });
    expect(response).toMatchObject({ ok: true, result: { stored: true, last4: "0000", rejected: false } });
    expect(Object.keys((response as { result: object }).result).sort()).toEqual(["last4", "rejected", "stored"]);
  });

  test("the settings a window reads have exactly the three music key fields, and a 401 shows only as rejected", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    w.engine.markMusicKeyRejected(MUSIC);
    const settings = ok(await w.engine.handle(command("settings.get")));
    if (settings.type !== "settings.get") throw new Error("wrong type");
    expect(settings.result.musicKey).toEqual({ stored: true, last4: "0000", rejected: true });
    expect(Object.keys(settings.result.musicKey).sort()).toEqual(["last4", "rejected", "stored"]);
  });

  test("a refused key (a space in it) is refused without echoing any part of it", async () => {
    const w = await wired();
    const response = await w.ask("settings.setMusicKey", { key: "test-rapidapi key-0000" });
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(JSON.stringify(response)).not.toContain("rapidapi");
    expect(w.engine.musicKey).toBeNull();
  });

  test("a failed store (encryption unavailable) answers without the key", async () => {
    const w = await wired();
    w.safe.available = false;
    const response = await w.ask("settings.setMusicKey", { key: MUSIC });
    expect(response).toMatchObject({ ok: false, error: { code: "ENCRYPTION_UNAVAILABLE" } });
    expect(JSON.stringify(response)).not.toContain(MUSIC);
    expect(w.engine.musicKey).toBeNull();
  });

  test("there is no command that reads the key back: the command set has no getter", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    for (const type of ["settings.getMusicKey", "music.key", "settings.revealMusicKey", "settings.checkMusicKey"]) {
      expect(await w.ask(type)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
  });

  test("the engine's memory holds the key for 3c.3, and only there", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    expect(w.engine.musicKey).toBe(MUSIC);
    expect(musicKeyStatusOf(w.keys)).toEqual({ stored: true, last4: "0000", rejected: false });
  });
});

describe("the music key never reaches a log", () => {
  test("not through set, a corrupt blob, a blob that no longer decrypts, a 401, a rotation and a clear", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    w.engine.markMusicKeyRejected(MUSIC);
    await w.ask("settings.setMusicKey", { key: ROTATED });

    // A restarted main over a blob that cannot be decrypted, and over garbage.
    w.safe.failDecrypt = true;
    await openMusicKeyStore(w.safe, userData);
    w.safe.failDecrypt = false;
    await writeFile(join(userData, MUSIC_SECRETS_FILE), Buffer.from("en"));
    await openMusicKeyStore(w.safe, userData);
    await w.ask("settings.clearMusicKey");
    // An invalid control message straight to the engine, as a compromised main might send it.
    await w.engine.applyControl({ kind: "control", type: "musicKey.set", key: "bad key with spaces" });

    const printed = output.text();
    for (const key of [MUSIC, ROTATED, MUSIC_HEAD, "bad key with spaces"]) expect(printed).not.toContain(key);
  });
});

describe("the music key never reaches the library, the cache or any file but its own blob", () => {
  test("nothing under userData or the library holds it in any form, and the blob is ciphertext", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    await w.ask("settings.get");
    w.engine.markMusicKeyRejected(MUSIC);
    await w.ask("settings.setMusicKey", { key: ROTATED });
    await w.ask("engine.snapshot");

    expect(await filesHolding(dir(), MUSIC)).toEqual([]);
    expect(await filesHolding(dir(), ROTATED)).toEqual([]);
    expect(await readdir(userData)).toContain(MUSIC_SECRETS_FILE);
    expect(w.safe.decryptString(await readFile(join(userData, MUSIC_SECRETS_FILE)))).toBe(ROTATED);
  });

  test("the OpenRouter key's blob stays a different file from the music key's", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    expect((await readdir(userData)).filter((name) => name.endsWith(".bin"))).toEqual([MUSIC_SECRETS_FILE]);
  });

  test("a cleared key leaves no trace on disk", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    await w.ask("settings.clearMusicKey");
    expect(await readdir(userData)).not.toContain(MUSIC_SECRETS_FILE);
    expect(await filesHolding(dir(), MUSIC)).toEqual([]);
  });
});

// ---------- child processes ----------

/** A parent environment that has a RapidAPI key in it under every name a shell or a launcher might use. */
const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/me",
  RAPIDAPI_KEY: MUSIC,
  rapidapi_key: MUSIC,
  X_RAPIDAPI_KEY: MUSIC,
  "x-rapidapi-key": MUSIC,
  MUSIC_KEY: MUSIC,
  FLASHAPI_TOKEN: MUSIC,
};

function allowed(names: string[]): boolean {
  return names.every((name) => ENV_ALLOWLIST.has(name.toUpperCase()));
}

describe("the music key never reaches a child process's environment", () => {
  test("the engine's own environment from main drops it, under any name or letter case", () => {
    const env = engineEnv(PARENT_ENV);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(JSON.stringify(env)).not.toContain(MUSIC);
  });

  test("an engine started with the key in the environment it was given still configures ffmpeg children from the allowlist only", async () => {
    const { engine } = await startEngine(dir(), { key: null, init: { ffmpegEnv: PARENT_ENV } });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });

    const env = configuredFfmpegEnv();
    expect(env).toBeDefined();
    expect(allowed(Object.keys(env ?? {}))).toBe(true);
    expect(JSON.stringify(env)).not.toContain(MUSIC);
  });

  test("an ffmpeg child's env keys are a subset of the engine env allowlist, whatever the environment it is given", async () => {
    const { engine } = await startEngine(dir(), { key: null, init: { ffmpegEnv: PARENT_ENV } });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC });
    const { spawner, calls } = fakeSpawner((c) => {
      c.child.report(30, true);
      c.child.exit(0);
    });

    // Once with the environment the engine configured, once with the parent's environment handed straight in.
    await runFfmpegArgv({ argv: ["-hide_banner", "-y", "-i", "in.png", "/out/a.mkv"], output: "/out/a.mkv", spawner });
    await runFfmpegArgv({ argv: ["-hide_banner", "-y", "-i", "in.png", "/out/b.mkv"], output: "/out/b.mkv", spawner, env: PARENT_ENV });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const env = call.options.env ?? {};
      expect(allowed(Object.keys(env))).toBe(true);
      expect(JSON.stringify(env)).not.toContain(MUSIC);
    }
  });

  test("the key is never an argument of an ffmpeg child either", async () => {
    const w = await wired();
    await w.ask("settings.setMusicKey", { key: MUSIC });
    const { spawner, calls } = fakeSpawner((c) => {
      c.child.report(30, true);
      c.child.exit(0);
    });
    await runFfmpegArgv({ argv: ["-hide_banner", "-y", "-i", "in.png", "/out/a.mkv"], output: "/out/a.mkv", spawner });
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(MUSIC);
  });
});
