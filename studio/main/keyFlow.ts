import { lstat, open, readFile, rm } from "node:fs/promises";
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
import { errorCode, renameWithRetry } from "../engine/library/renameRetry";

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

/** What a store treats as a key, and what it calls one in its log line; the OpenRouter key's are the defaults. */
interface KeyRules {
  accepts: (key: string) => boolean;
  label: string;
  unreadable: "throw" | "absent";
}

function rulesOf(options: KeyStoreOptions): KeyRules {
  return { accepts: options.accepts ?? ((key) => ApiKey.safeParse(key).success), label: options.label ?? "API key", unreadable: options.unreadable ?? "throw" };
}

/** Decrypts the stored blob; null when there is none or it cannot be read back as a key. */
async function decryptFile(safe: SafeStorageLike, path: string, rules: KeyRules): Promise<string | null> {
  let blob: Buffer;
  try {
    // Only a regular file is read: opening a FIFO for reading blocks until a writer shows up, which would hang main's
    // start or the engine's launch. A symlink counts as not regular (lstat), for the same reason.
    if (!(await lstat(path)).isFile()) throw Object.assign(new Error("the key file is not a regular file"), { code: "ENOTFILE" });
    blob = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    if (rules.unreadable === "throw") throw error;
    // An optional key's file must not stop the app: it reads as no key, and only the error's code is logged.
    console.warn(`studio: the stored ${rules.label} could not be read (${errorCode(error) ?? "unknown"})`);
    return null;
  }
  if (!safe.isEncryptionAvailable()) return null;
  try {
    const key = safe.decryptString(blob);
    return rules.accepts(key) ? key : null;
  } catch {
    // E.g. the keychain entry changed. The blob stays; storing a new key replaces it.
    console.warn(`studio: the stored ${rules.label} could not be decrypted`);
    return null;
  }
}

/** Temp file created 0600 + fsync + rename + directory fsync: the blob is never readable by others, even mid-write. */
async function writeSecretAtomic(path: string, data: Uint8Array, syncDir: (dir: string) => Promise<void>, label: string): Promise<void> {
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
  try {
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // The blob is in place now. A directory sync that fails only weakens durability (the rename may not survive a
  // power loss), so it is a warning, not a failed set: the disk, the status and the engine must end up agreeing.
  try {
    await syncDir(dirname(path));
  } catch (error) {
    console.warn(`studio: the folder of the stored ${label} could not be synced (${errorCode(error) ?? "unknown"}); it may not survive a power loss`);
  }
}

export interface KeyStoreOptions {
  /**
   * What counts as a stored key, for a store of another key than OpenRouter's (the RapidAPI key's). A blob that
   * decrypts to anything else reads as no key. Defaults to `ApiKey`.
   */
  accepts?: (key: string) => boolean;
  /** How the key is named in the log line for a blob that cannot be decrypted. Defaults to "API key". */
  label?: string;
  /**
   * What a file that exists but cannot be read (a directory in its place, no permission) does at open and on every
   * read: `"throw"` (the default, the OpenRouter key's) or `"absent"`, which logs the error's code and reads as no
   * key, for an optional key that must not take the app down. Note that `"absent"` also swallows a transient error
   * (EMFILE, EIO, EBUSY): the key reads as absent until the next set or restart, then comes back on its own.
   */
  unreadable?: "throw" | "absent";
  /** Test seam: syncs the key file's folder after the rename; `fsyncDir` by default. */
  syncDir?: (dir: string) => Promise<void>;
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
  readonly #rules: KeyRules;
  #last4: string | null;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(safe: SafeStorageLike, path: string, last4: string | null, options: KeyStoreOptions) {
    this.#safe = safe;
    this.#path = path;
    this.#last4 = last4;
    this.#options = options;
    this.#rules = rulesOf(options);
  }

  static async open(safe: SafeStorageLike, path: string, options: KeyStoreOptions = {}): Promise<KeyStore> {
    const key = await decryptFile(safe, path, rulesOf(options));
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
      // A key this store would drop on the next start is refused now (the error names no part of it).
      if (!this.#rules.accepts(key)) throw new Error(`the ${this.#rules.label} does not have the shape this store keeps`);
      if (!this.#safe.isEncryptionAvailable()) return null;
      let blob: Uint8Array;
      try {
        blob = this.#safe.encryptString(key);
      } catch {
        return null;
      }
      await this.#options.beforeWrite?.();
      await writeSecretAtomic(this.#path, blob, this.#options.syncDir ?? fsyncDir, this.#rules.label);
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
    return decryptFile(this.#safe, this.#path, this.#rules);
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
