import { open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ApiKey,
  errorResponseFor,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type CommandMessage,
  type ResponseMessage,
} from "../shared/engine";
import type { HostControl } from "../engine/control";
import { fsyncDir, tempSiblingPath } from "../engine/library/durableFs";
import { renameWithRetry } from "../engine/library/renameRetry";

/** The encrypted key blob in userData; the only file the key ever reaches (invariant 10). */
export const SECRETS_FILE = "secrets.bin";

/** The part of Electron's `safeStorage` the key flow uses; injected so tests run without Electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Uint8Array;
  decryptString(encrypted: Buffer): string;
}

/** The commands main answers itself (T0 `MAIN_ONLY_COMMANDS`). */
export type KeyCommand = Extract<CommandMessage, { type: "settings.setApiKey" | "settings.clearApiKey" }>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Decrypts the stored blob; null when there is none or it cannot be read back as a key. */
async function decryptFile(safe: SafeStorageLike, path: string): Promise<string | null> {
  let blob: Buffer;
  try {
    blob = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!safe.isEncryptionAvailable()) return null;
  try {
    const key = safe.decryptString(blob);
    return ApiKey.safeParse(key).success ? key : null;
  } catch {
    // E.g. the keychain entry changed. The blob stays; storing a new key replaces it.
    console.warn("studio: the stored API key could not be decrypted");
    return null;
  }
}

/** Temp file created 0600 + fsync + rename + directory fsync: the blob is never readable by others, even mid-write. */
async function writeSecretAtomic(path: string, data: Uint8Array): Promise<void> {
  const temp = tempSiblingPath(path);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await renameWithRetry(temp, path);
  await fsyncDir(dirname(path));
}

export interface KeyStoreOptions {
  /** Test seam: runs inside the lock right before the blob is written. */
  beforeWrite?: () => Promise<void>;
}

/**
 * The API key at rest: encrypted with `safeStorage` in `userData/secrets.bin`
 * (atomic write, mode 0600). Main never keeps the plaintext: it remembers only
 * the last four chars, and decrypts on demand to hand the key to the engine.
 * Changes run one at a time, each with its follow-up (telling the engine)
 * inside the same turn, so the disk and the engine end in the same state.
 */
export class KeyStore {
  readonly #safe: SafeStorageLike;
  readonly #path: string;
  readonly #options: KeyStoreOptions;
  #last4: string | null;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(safe: SafeStorageLike, path: string, last4: string | null, options: KeyStoreOptions) {
    this.#safe = safe;
    this.#path = path;
    this.#last4 = last4;
    this.#options = options;
  }

  static async open(safe: SafeStorageLike, path: string, options: KeyStoreOptions = {}): Promise<KeyStore> {
    const key = await decryptFile(safe, path);
    return new KeyStore(safe, path, key === null ? null : key.slice(-4), options);
  }

  /** `rejected` is the engine's to know (a 401); a key main just stored or cleared is not rejected. */
  status(): ApiKeyStatus {
    return {
      stored: this.#last4 !== null,
      last4: this.#last4,
      encryptionAvailable: this.#safe.isEncryptionAvailable(),
      rejected: false,
    };
  }

  /**
   * Encrypts and stores `key`, replacing any previous one, then runs
   * `stored`. Null, with nothing written, when the OS cannot encrypt —
   * unavailable, or `encryptString` threw (e.g. Keychain access denied).
   */
  set(key: string, stored: () => void): Promise<ApiKeyStatus | null> {
    return this.#exclusive(async () => {
      if (!this.#safe.isEncryptionAvailable()) return null;
      let blob: Uint8Array;
      try {
        blob = this.#safe.encryptString(key);
      } catch {
        return null;
      }
      await this.#options.beforeWrite?.();
      await writeSecretAtomic(this.#path, blob);
      this.#last4 = key.slice(-4);
      stored();
      return this.status();
    });
  }

  clear(cleared: () => void): Promise<ApiKeyStatus> {
    return this.#exclusive(async () => {
      await rm(this.#path, { force: true });
      this.#last4 = null;
      cleared();
      return this.status();
    });
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /** The plaintext for the engine on every (re)start; null when none is stored or it cannot be decrypted. */
  read(): Promise<string | null> {
    return decryptFile(this.#safe, this.#path);
  }
}

export interface KeyFlowDeps {
  keys: KeyStore;
  /** The engine's MessagePort, through `EngineHost.send`. */
  engine: { send(control: HostControl): void };
}

/**
 * `settings.setApiKey` / `settings.clearApiKey`. With encryption unavailable
 * the key is not stored and the answer is ENCRYPTION_UNAVAILABLE; otherwise
 * the key is stored first and then handed to the engine over its MessagePort.
 * The answer carries only the key's status, never the key.
 */
export async function handleKeyCommand(command: KeyCommand, deps: KeyFlowDeps): Promise<ResponseMessage> {
  const v = PROTOCOL_VERSION;
  switch (command.type) {
    case "settings.setApiKey": {
      const { key } = command.payload;
      const status = await deps.keys.set(key, () => deps.engine.send({ kind: "control", type: "apiKey.set", key }));
      if (status === null) {
        return errorResponseFor(command, { code: "ENCRYPTION_UNAVAILABLE", detail: "the OS cannot encrypt the key, so it was not stored" });
      }
      return { v, id: command.id, kind: "response", type: command.type, ok: true, result: status };
    }
    case "settings.clearApiKey": {
      const status = await deps.keys.clear(() => deps.engine.send({ kind: "control", type: "apiKey.clear" }));
      return { v, id: command.id, kind: "response", type: command.type, ok: true, result: status };
    }
  }
}
