import type { SafeStorageLike } from "../main/keyFlow";

/** A stand-in for Electron's safeStorage: reversible, and never the plaintext on disk. Tests only. */
export class FakeSafeStorage implements SafeStorageLike {
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
