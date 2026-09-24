import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponseMessage } from "../shared/engine";
import type { HostControl } from "../engine/control";
import { handleKeyCommand, KeyStore, SECRETS_FILE, type KeyCommand, type SafeStorageLike } from "./keyFlow";

const KEY = "sk-or-v1-0123456789abcdef-wxyz";

/** A stand-in for Electron's safeStorage: reversible, and never the plaintext on disk. */
class FakeSafeStorage implements SafeStorageLike {
  available = true;
  failDecrypt = false;
  /** Keychain access denied: available, but encrypting throws. */
  denyEncrypt = false;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plainText: string): Uint8Array {
    if (!this.available || this.denyEncrypt) throw new Error("encryption is not available");
    return Buffer.from(`enc:${Buffer.from(plainText).reverse().toString("base64")}`);
  }
  decryptString(encrypted: Buffer): string {
    if (this.failDecrypt) throw new Error("keychain entry changed");
    const text = encrypted.toString();
    if (!text.startsWith("enc:")) throw new Error("not ours");
    return Buffer.from(text.slice(4), "base64").reverse().toString();
  }
}

let userData = "";
let safe: FakeSafeStorage;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "studio-keys-"));
  safe = new FakeSafeStorage();
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const secretsPath = () => join(userData, SECRETS_FILE);

function setApiKey(key: string): KeyCommand {
  return { v: 1, id: "cmd-set-0001", kind: "command", type: "settings.setApiKey", payload: { key } };
}
const clearApiKey: KeyCommand = { v: 1, id: "cmd-clear-001", kind: "command", type: "settings.clearApiKey", payload: {} };

function engineSpy() {
  const sent: HostControl[] = [];
  return { sent, send: (control: HostControl) => sent.push(control) };
}

describe("settings.setApiKey", () => {
  test("encryption unavailable: ENCRYPTION_UNAVAILABLE, nothing stored, the engine is not told", async () => {
    safe.available = false;
    const keys = await KeyStore.open(safe, secretsPath());
    const engine = engineSpy();

    const response = await handleKeyCommand(setApiKey(KEY), { keys, engine });

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: false, id: "cmd-set-0001", type: "settings.setApiKey", error: { code: "ENCRYPTION_UNAVAILABLE" } });
    expect(await readdir(userData)).toEqual([]);
    expect(engine.sent).toEqual([]);
    expect(keys.status()).toEqual({ stored: false, last4: null, encryptionAvailable: false, rejected: false });
    expect(JSON.stringify(response)).not.toContain(KEY);
  });

  test("stores only ciphertext, answers with the last four chars, and hands the key to the engine", async () => {
    const keys = await KeyStore.open(safe, secretsPath());
    const engine = engineSpy();

    const response = await handleKeyCommand(setApiKey(KEY), { keys, engine });

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toEqual({
      v: 1,
      id: "cmd-set-0001",
      kind: "response",
      type: "settings.setApiKey",
      ok: true,
      result: { stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false },
    });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(engine.sent).toEqual([{ kind: "control", type: "apiKey.set", key: KEY }]);

    const onDisk = await readFile(secretsPath());
    expect(onDisk.toString()).not.toContain(KEY);
    expect(safe.decryptString(onDisk)).toBe(KEY);
    expect(await readdir(userData)).toEqual([SECRETS_FILE]);
  });

  test("a new key replaces the old one (rotation)", async () => {
    const keys = await KeyStore.open(safe, secretsPath());
    const engine = engineSpy();
    await handleKeyCommand(setApiKey(KEY), { keys, engine });
    await handleKeyCommand(setApiKey("sk-or-v1-rotated-key-9876"), { keys, engine });

    expect(await keys.read()).toBe("sk-or-v1-rotated-key-9876");
    expect(keys.status().last4).toBe("9876");
    expect(engine.sent.at(-1)).toEqual({ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-9876" });
  });
});

describe("settings.clearApiKey", () => {
  test("deletes the blob and tells the engine", async () => {
    const keys = await KeyStore.open(safe, secretsPath());
    const engine = engineSpy();
    await handleKeyCommand(setApiKey(KEY), { keys, engine });

    const response = await handleKeyCommand(clearApiKey, { keys, engine });

    expect(response).toMatchObject({ ok: true, type: "settings.clearApiKey", result: { stored: false, last4: null } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(await readdir(userData)).toEqual([]);
    expect(engine.sent.at(-1)).toEqual({ kind: "control", type: "apiKey.clear" });
    expect(await keys.read()).toBeNull();
  });

  test("clearing when nothing is stored still succeeds", async () => {
    const keys = await KeyStore.open(safe, secretsPath());
    const response = await handleKeyCommand(clearApiKey, { keys, engine: engineSpy() });
    expect(response).toMatchObject({ ok: true, result: { stored: false } });
  });
});

describe("KeyStore across restarts", () => {
  test("a restarted main learns the last four chars from the blob and can decrypt the key for the engine", async () => {
    const first = await KeyStore.open(safe, secretsPath());
    await first.set(KEY, () => {});

    const second = await KeyStore.open(safe, secretsPath());
    expect(second.status()).toEqual({ stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false });
    expect(await second.read()).toBe(KEY);
  });

  test("a blob that no longer decrypts reads as no key and is left for a new key to replace", async () => {
    const first = await KeyStore.open(safe, secretsPath());
    await first.set(KEY, () => {});
    safe.failDecrypt = true;

    const second = await KeyStore.open(safe, secretsPath());
    expect(second.status().stored).toBe(false);
    expect(await second.read()).toBeNull();
    expect(await readdir(userData)).toEqual([SECRETS_FILE]);
  });

  test("a blob that decrypts to something that is not a key is ignored", async () => {
    await writeFile(secretsPath(), safe.encryptString("has spaces in it"));
    const keys = await KeyStore.open(safe, secretsPath());
    expect(keys.status().stored).toBe(false);
    expect(await keys.read()).toBeNull();
  });

  test("with encryption unavailable at start, a stored blob is not read", async () => {
    const first = await KeyStore.open(safe, secretsPath());
    await first.set(KEY, () => {});
    safe.available = false;
    const second = await KeyStore.open(safe, secretsPath());
    expect(second.status()).toEqual({ stored: false, last4: null, encryptionAvailable: false, rejected: false });
    expect(await second.read()).toBeNull();
  });
});

describe("hardening", () => {
  test("an encryptString that throws (Keychain denied) answers ENCRYPTION_UNAVAILABLE and stores nothing", async () => {
    safe.denyEncrypt = true;
    const keys = await KeyStore.open(safe, secretsPath());
    const engine = engineSpy();
    const response = await handleKeyCommand(setApiKey(KEY), { keys, engine });
    expect(response).toMatchObject({ ok: false, error: { code: "ENCRYPTION_UNAVAILABLE" } });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(await readdir(userData)).toEqual([]);
    expect(engine.sent).toEqual([]);
    expect(keys.status().stored).toBe(false);
  });

  test.skipIf(process.platform === "win32")("secrets.bin is readable by its owner only (0600)", async () => {
    const keys = await KeyStore.open(safe, secretsPath());
    await handleKeyCommand(setApiKey(KEY), { keys, engine: engineSpy() });
    expect((await stat(secretsPath())).mode & 0o777).toBe(0o600);
  });

  test("concurrent key commands run one at a time, in call order, so the engine and the disk agree", async () => {
    let writes = 0;
    const keys = await KeyStore.open(safe, secretsPath(), {
      // The first write is slow: without serialization the second would land first.
      beforeWrite: async () => {
        if (++writes === 1) await Bun.sleep(30);
      },
    });
    const engine = engineSpy();
    const second = "sk-or-v1-second-key-5555";
    await Promise.all([
      handleKeyCommand(setApiKey(KEY), { keys, engine }),
      handleKeyCommand(setApiKey(second), { keys, engine }),
      handleKeyCommand(clearApiKey, { keys, engine }),
      handleKeyCommand(setApiKey(second), { keys, engine }),
    ]);
    expect(engine.sent).toEqual([
      { kind: "control", type: "apiKey.set", key: KEY },
      { kind: "control", type: "apiKey.set", key: second },
      { kind: "control", type: "apiKey.clear" },
      { kind: "control", type: "apiKey.set", key: second },
    ]);
    expect(await keys.read()).toBe(second);
    expect(keys.status().last4).toBe("5555");
  });
});
