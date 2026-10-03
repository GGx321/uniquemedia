import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PickedFileIdentity } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { pickedIdentityOf, sameIdentity } from "./identity";
useNativeGlobals();

// The identity of a picked file, as main saw it and as the engine sees it again: both ends build it with this one function, so the
// two spellings cannot drift. Node hands a bigint stat out of a BigInt64Array, so a 64-bit number with its top bit set arrives NEGATIVE.

const stats = { dev: 16777230n, ino: 12345n, size: 4096n, mtimeNs: 1_700_000_000_123_456_789n, birthtimeNs: 1_600_000_000_000_000_000n };

describe("pickedIdentityOf", () => {
  test("writes every field as an exact decimal string", () => {
    expect(pickedIdentityOf(stats)).toEqual({ dev: "16777230", ino: "12345", size: "4096", mtimeNs: "1700000000123456789", birthtimeNs: "1600000000000000000" });
  });

  test("reads an inode with the top bit set as the unsigned number it is, never as a negative one", () => {
    const signed = BigInt.asIntN(64, 2n ** 64n - 1n);
    expect(signed < 0n).toBe(true);
    expect(pickedIdentityOf({ ...stats, ino: signed }).ino).toBe("18446744073709551615");
    expect(pickedIdentityOf({ ...stats, ino: BigInt.asIntN(64, 0x8001_0000_0000_1234n) }).ino).toBe(String(0x8001_0000_0000_1234n));
  });

  test("an identity with such an inode is one the contract's schema takes", () => {
    const identity = pickedIdentityOf({ ...stats, ino: BigInt.asIntN(64, 2n ** 64n - 1n), dev: BigInt.asIntN(64, 2n ** 63n) });
    expect(PickedFileIdentity.safeParse(identity).success).toBe(true);
  });

  test("a time before 1970 is read as the unsigned number of the same bits, and still fits the schema", () => {
    const identity = pickedIdentityOf({ ...stats, mtimeNs: -1_000_000_000n });
    expect(PickedFileIdentity.safeParse(identity).success).toBe(true);
  });
});

describe("sameIdentity", () => {
  const base = pickedIdentityOf(stats);

  test("is true for the same identity", () => {
    expect(sameIdentity(base, { ...base })).toBe(true);
  });

  test.each(["dev", "ino", "size", "mtimeNs", "birthtimeNs"] as const)("is false when only %s differs", (field) => {
    expect(sameIdentity(base, { ...base, [field]: "1" })).toBe(false);
  });

  test("a degenerate inode (all ones, as exFAT reports) does not make two files the same while their size or times differ", () => {
    const a = pickedIdentityOf({ ...stats, ino: BigInt.asIntN(64, 2n ** 64n - 1n), size: 10n });
    const b = pickedIdentityOf({ ...stats, ino: BigInt.asIntN(64, 2n ** 64n - 1n), size: 11n });
    expect(sameIdentity(a, b)).toBe(false);
  });
});

describe("on a real file", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-identity-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  test("the lstat of a path and the fstat of its open handle give the same identity", async () => {
    const path = join(dir, "a.bin");
    await writeFile(path, "some bytes");
    const handle = await open(path, "r");
    try {
      expect(sameIdentity(pickedIdentityOf(await lstat(path, { bigint: true })), pickedIdentityOf(await handle.stat({ bigint: true })))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test("another file under the same name is not the same identity", async () => {
    const path = join(dir, "a.bin");
    await writeFile(path, "some bytes");
    const before = pickedIdentityOf(await lstat(path, { bigint: true }));
    await writeFile(join(dir, "b.bin"), "other bytes!");
    const { rename } = await import("node:fs/promises");
    await rename(join(dir, "b.bin"), path);
    expect(sameIdentity(before, pickedIdentityOf(await lstat(path, { bigint: true })))).toBe(false);
  });
});
