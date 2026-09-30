import { join } from "node:path";
import {
  errorResponseFor,
  MusicKey,
  PROTOCOL_VERSION,
  type CommandMessage,
  type MusicKeyStatus,
  type ResponseMessage,
} from "../shared/engine";
import { KeyStore, type KeyFlowDeps, type SafeStorageLike } from "./keyFlow";

/** The encrypted RapidAPI key blob in userData; a second file, never the OpenRouter key's `secrets.bin` (S20). */
export const MUSIC_SECRETS_FILE = "secrets-rapidapi.bin";

/** The music key commands main answers itself (K27); there is no check command (Q4). */
export type MusicKeyCommand = Extract<CommandMessage, { type: "settings.setMusicKey" | "settings.clearMusicKey" }>;

/**
 * The RapidAPI key's store: the very `KeyStore` of the OpenRouter key (the same encryption, atomic write, mode 0600
 * and one-at-a-time changes), over its own file and with the music key's shape rule. A blob that decrypts to
 * anything but a key `MusicKey` would have stored untouched (trimmed, printable ASCII, 8 to 256 chars) reads as no key.
 */
export function openMusicKeyStore(safe: SafeStorageLike, userDataDir: string): Promise<KeyStore> {
  return KeyStore.open(safe, join(userDataDir, MUSIC_SECRETS_FILE), {
    accepts: (key) => {
      const parsed = MusicKey.safeParse(key);
      return parsed.success && parsed.data === key;
    },
    label: "RapidAPI key",
  });
}

/**
 * What main knows of the music key (K24): whether one is stored and its last four chars. `rejected` is the engine's
 * to know (a 401 from flashapi), so main's own view is never rejected; the engine's `settings.get` carries the flag.
 */
export function musicKeyStatusOf(keys: KeyStore): MusicKeyStatus {
  const { stored, last4 } = keys.status();
  return { stored, last4, rejected: false };
}

/**
 * `settings.setMusicKey` / `settings.clearMusicKey`, mirroring the OpenRouter key's flow. With encryption
 * unavailable the key is not stored and the answer is ENCRYPTION_UNAVAILABLE; otherwise the key is stored first and
 * then handed to the engine over its MessagePort (`musicKey.set`). The answer carries only the key's status, never
 * the key; the renderer can set and clear it and never read it back.
 */
export async function handleMusicKeyCommand(command: MusicKeyCommand, deps: KeyFlowDeps): Promise<ResponseMessage> {
  const v = PROTOCOL_VERSION;
  switch (command.type) {
    case "settings.setMusicKey": {
      const { key } = command.payload;
      const stored = await deps.keys.set(key, () => deps.engine.send({ kind: "control", type: "musicKey.set", key }));
      if (stored === null) {
        return errorResponseFor(command, { code: "ENCRYPTION_UNAVAILABLE", detail: "the OS cannot encrypt the key, so it was not stored" });
      }
      return { v, id: command.id, kind: "response", type: command.type, ok: true, result: musicKeyStatusOf(deps.keys) };
    }
    case "settings.clearMusicKey": {
      await deps.keys.clear(() => deps.engine.send({ kind: "control", type: "musicKey.clear" }));
      return { v, id: command.id, kind: "response", type: command.type, ok: true, result: musicKeyStatusOf(deps.keys) };
    }
  }
}
